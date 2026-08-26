'use strict';

// The central store's schema, as an ordered migration list for ../schema/migrator.js — the same
// ledger, the same refusal-to-downgrade, the same "the version is a number" as the node's
// ../schema/nodeMigrations.js, driven through ./pgDriver.js instead of ../schema/sqliteDriver.js.
// docs/design/global-identity-and-central-db.md §2.5, "Schema migration": *one versioned migrator
// for both stores*.
//
// Migrations 1-2 are phase 3 (§2.7): the **usage** half. Central receives what nodes ship, stores
// it, and answers fleet questions about it.
//
// Migration 3 is phase 4, and it is where central stops being an observer. `capabilities`,
// `principals`, `grants`, `approvals` and the `policy_changes` log arrive together because they are
// one authority, not five tables — a fleet where grants moved but the capabilities they point at
// did not would have every grant referencing an id only one machine had minted. Migration 3 is also
// why 1 and 2 are worth reading as a pair with it: everything in them is a claim a node made about
// itself, and everything in 3 is a fact central decides and the nodes replicate.
//
// ============================================================================================
// WHY `observedAt` IS THE PARTITION KEY AND `ts` IS NOT
// ============================================================================================
//
// §2.5 says `usage_events` is "range-partitioned by month". Which month is the interesting part,
// because there are two candidate clocks on every event and one of them belongs to the attacker:
//
//   ts          when the NODE says the call happened. A string the node wrote, on a user's own PC,
//               with a clock they can set. Also nullable — §2.6 relaxed every usage column below
//               `id` so that a field an unfamiliar build did not send reads as "not recorded".
//   observedAt  when CENTRAL received it. Assigned here, inside the ingest transaction.
//
// Postgres requires the partition key to be NOT NULL, which rules `ts` out on the nullability
// alone. But the clock is the better reason: partitioning on a node-supplied timestamp means any
// node can create a partition-shaped hole in the fleet's storage by shipping events dated 2031, or
// bury a month of its own denials in a partition nobody queries by dating them 1999. The
// partitioning key has to be a fact central controls. §2.3's note says it outright — "trust node
// clocks for nothing. Record the node-assigned `ts` *and* a central `observedAt`, and keep the
// delta."
//
// The delta is kept, in `clockSkewMs`, computed at ingest. `server/rollup/index.js` already
// reports measured `clockSkew` from the same two fields on the node side; this is the fleet-wide
// version of that number, and the column exists so a query for "which nodes have lying clocks" is
// an index scan rather than a string parse over every row.
//
// A DEFAULT PARTITION EXISTS, and it is a diagnostic rather than a fallback. Range partitioning
// fails the INSERT outright when no partition covers the key — for an append-only ingest fed by N
// nodes that would mean a missed maintenance run turns into a fleet-wide outage of the usage
// stream, which is precisely the "central becomes a fleet-wide single point of failure" risk §2.8
// says must never be on the path. So rows always have somewhere to land, and ./partitions.js
// reports a non-empty default loudly, because a row in it means maintenance did not run.
//
// ============================================================================================
// WHY IDEMPOTENCY LIVES IN `usage_shipments` AND NOT IN A UNIQUE INDEX ON THE EVENTS TABLE
// ============================================================================================
//
// §2.3: "idempotent ingest keyed on `(nodeId, seq)` with `ON CONFLICT DO NOTHING`". On a
// *partitioned* table that phrasing cannot be taken literally, because Postgres requires every
// unique index on a partitioned table to contain the partition key — so the only enforceable key
// would be `(nodeId, seq, observedAt)`, and `observedAt` is assigned at arrival. A redelivery is
// by definition a second arrival, so it gets a second `observedAt`, so it does not conflict, so
// the duplicate lands. The constraint would look right and do nothing.
//
// `usage_shipments` is therefore the idempotency ledger: one narrow, unpartitioned row per
// shipment, `PRIMARY KEY (nodeId, seq)`, inserted first in the same transaction as the event. If
// that insert reports no row, the shipment is a redelivery and the event is skipped. It is also
// what makes the *other* half of at-least-once observable — the sequence is gapless by
// construction on the node, so a gap between shipment numbers at central is a lost stream segment,
// which is exactly what the shipper warns about when it trims an over-long outbox ("central's copy
// of this node's stream now has a gap"). A `MAX(seq)` alone could never see that.

const EVENT_COLUMNS = [
  // Everything the node's usage_events holds, in the node's own spelling, quoted so Postgres does
  // not fold the camelCase away. A row read out of central and a row read out of a node's SQLite
  // are then the same object, and no layer in between translates names.
  ['id', 'TEXT NOT NULL'],
  ['principalId', 'TEXT'],
  ['capabilityId', 'TEXT'],
  ['ts', 'TEXT'],
  ['outcome', 'TEXT'],
  ['latencyMs', 'INTEGER'],
  ['correlationId', 'TEXT'],
  ['reason', 'TEXT'],
  ['capabilityLookupMs', 'INTEGER'],
  ['principalResolveMs', 'INTEGER'],
  ['brokerMs', 'INTEGER'],
  ['grantCheckMs', 'INTEGER'],
  ['osUser', 'TEXT'],
  ['hostname', 'TEXT'],
  ['actorLoomId', 'TEXT'],
  ['actorAgentType', 'TEXT'],
  ['actorBackend', 'TEXT'],
  ['actorField', 'TEXT'],
  ['subjectId', 'TEXT'],
  ['assuranceLevel', 'INTEGER'],
  ['shadowOutcome', 'TEXT'],
  ['shadowReason', 'TEXT'],
  ['shadowPrincipalId', 'TEXT'],
  ['correctedAt', 'TEXT'],
  // A fingerprint of the exact call the row is about (server/hooks/lib.js's toolInputDigest), inside
  // the node's canonical form and therefore its hash — so, like the chain coordinates, it is stored
  // verbatim as the node sent it. Nullable: a node predating the column ships none, and §2.6 reads a
  // missing field as "not recorded" rather than a value.
  ['toolInputDigest', 'TEXT'],
  // The per-node chain (§2.7 phase 1). Shipped as the node wrote them and stored verbatim: the
  // envelope carries the event's own seq/prevHash/hash so central can verify a node's chain from
  // the shipped stream alone, rather than trusting the order shipments happened to arrive in.
  ['nodeId', 'TEXT NOT NULL'],
  ['seq', 'BIGINT'],
  ['prevHash', 'TEXT'],
  ['hash', 'TEXT'],
  // Which LIFETIME of that node wrote it — migration 7, docs/design/dashboard-placement.md item 5.
  // In the node's canonical form and therefore inside the hash, so it is stored verbatim like the
  // rest of the chain's coordinates. Nullable: a node predating incarnations ships none, and §2.6
  // says an unfamiliar build's missing field reads as "not recorded" rather than as a value.
  ['incarnation', 'TEXT'],
  // The node's own observedAt — NOT central's. Kept because it is inside the node's hash chain,
  // so overwriting it with central's arrival time would make every shipped row fail verification.
  ['nodeObservedAt', 'TEXT'],
  // §2.6's forward-compatibility column, stored as the exact canonical JSON string the node
  // hashed. Deliberately TEXT and not JSONB: jsonb normalises whitespace and key order, so the
  // bytes that come back out would not be the bytes that were hashed, and every re-verification of
  // a shipped chain would fail for a reason that has nothing to do with tampering.
  ['extra', 'TEXT'],
];

/** Central-assigned columns, which no node may supply. Split out from EVENT_COLUMNS so the two
 *  lists read as what they are: what a node reports, and what central knows about the report. */
const CENTRAL_COLUMNS = [
  // The partition key. See the header.
  ['observedAt', 'TIMESTAMPTZ NOT NULL'],
  // ts - observedAt in milliseconds, or NULL when the node sent no ts (or an unparseable one).
  // §2.3: "Skew is what turns an audit log into plausible-looking fiction."
  ['clockSkewMs', 'BIGINT'],
  // Which shipment carried this event, so a row can be traced back to the batch it arrived in.
  ['shipmentSeq', 'BIGINT'],
  // 'usage_event' or 'usage_event_correction' — the node's outbox `kind`, kept so a corrected row
  // says how it got that way.
  ['ingestKind', 'TEXT'],
];

const ALL_COLUMNS = [...EVENT_COLUMNS, ...CENTRAL_COLUMNS];

/** Column names in insert order — the shared list ./store.js builds its INSERT from, so a column
 *  added here reaches the insert without a second edit somewhere else. */
const EVENT_COLUMN_NAMES = ALL_COLUMNS.map(([name]) => name);

function columnDdl() {
  return ALL_COLUMNS.map(([name, type]) => `  "${name}" ${type}`).join(',\n');
}

const migrations = [
  {
    version: 1,
    name: 'usage_events partitioned by month, shipment ledger, node registry',
    up: async (ctx) => {
      // ---- the nodes central has ever heard from -------------------------------------------
      // Not a `principals` table and not policy: this is the fleet's roster, filled entirely by
      // what arrives at ingest, so "which machines are reporting, and are any of them quiet"
      // is answerable without scanning the event log.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          "nodeId" TEXT PRIMARY KEY,
          "firstSeenAt" TIMESTAMPTZ NOT NULL,
          "lastSeenAt" TIMESTAMPTZ NOT NULL,
          -- The highest shipment number central has accepted from this node. Gapless on the node
          -- by construction, so lastSeq minus the count of shipments is the size of the hole.
          "lastSeq" BIGINT NOT NULL DEFAULT 0,
          "eventCount" BIGINT NOT NULL DEFAULT 0,
          -- Last seen values, for a roster row that says something without a join.
          hostname TEXT,
          "osUser" TEXT,
          -- The certificate CN the node presented, recorded separately from the nodeId it claims
          -- in the envelope. §2.5: a fleet-wide bearer token would let any node forge any other
          -- node's stream; keeping both means a mismatch is a row central can be queried for
          -- rather than a line in a log file.
          "certSubject" TEXT,
          -- Rolling measures, so a lying clock or a stalled node is visible on the roster itself.
          "lastClockSkewMs" BIGINT,
          "lastEventTs" TEXT
        )
      `);

      // ---- the idempotency ledger ------------------------------------------------------------
      // See the header for why this is not a unique index on usage_events.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS usage_shipments (
          "nodeId" TEXT NOT NULL,
          seq BIGINT NOT NULL,
          -- In the key, and this is 2.6's tolerance rule showing up as a schema decision rather
          -- than a code branch. A current node stamps the SHIPMENT number into the envelope, and
          -- that alone is unique -- an insert and the correction of the same event are two
          -- shipments with two numbers, so kind in the key changes nothing. A node predating
          -- that field ships no shipment number at all, and central falls back to the event's
          -- CHAIN seq (see ./store.js shipmentKeyFor), where an insert and its correction share
          -- one number. Without kind here the correction would be discarded as a redelivery of
          -- the row it corrects -- losing, silently, the consent decisions 2.3 flushes
          -- immediately precisely because they are the most security-relevant writes there are.
          kind TEXT NOT NULL,
          "eventId" TEXT,
          "receivedAt" TIMESTAMPTZ NOT NULL,
          PRIMARY KEY ("nodeId", seq, kind)
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_shipments_received_idx ON usage_shipments ("receivedAt")');

      // ---- the log itself --------------------------------------------------------------------
      // PARTITION BY RANGE ("observedAt"). The primary key must contain the partition key —
      // that is the Postgres rule the header explains around — so it is (observedAt, nodeId, id).
      // It is a physical row identity, NOT the idempotency key: usage_shipments is that.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS usage_events (
${columnDdl()},
          PRIMARY KEY ("observedAt", "nodeId", "id")
        ) PARTITION BY RANGE ("observedAt")
      `);

      // The catch-all. A row landing here means ./partitions.js did not run in time; ingest keeps
      // working, and the fact that maintenance lapsed is a query rather than an outage.
      await ctx.exec('CREATE TABLE IF NOT EXISTS usage_events_default PARTITION OF usage_events DEFAULT');

      // Indexes are declared on the parent, so every partition — including ones created years from
      // now — inherits them without a second place to remember.
      //
      // `id` is indexed but NOT unique: a correction (PATCH on the node, shipped as
      // `usage_event_correction`) arrives after the original, possibly in a later month, and has
      // to find and update the row wherever it already lives. Uniqueness across partitions is not
      // expressible here, and would not be the right guard anyway — the node's (nodeId, seq) is.
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_id_idx ON usage_events ("id")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_node_seq_idx ON usage_events ("nodeId", "seq")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_principal_idx ON usage_events ("principalId", "observedAt")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_capability_idx ON usage_events ("capabilityId", "observedAt")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_subject_idx ON usage_events ("subjectId", "observedAt")');
      // The alert query of §2.3 — "this user just ran 40 destructive calls", "denials in the last
      // five minutes across the fleet" — reads outcome over a recent window, so it gets its own.
      await ctx.exec('CREATE INDEX IF NOT EXISTS usage_events_outcome_idx ON usage_events ("outcome", "observedAt")');
    },
  },
  {
    version: 2,
    name: 'shadow reconciliation ledger',
    up: async (ctx) => {
      // Phase 3 is shadow mode, and shadow mode's whole deliverable is a comparison. Storing each
      // comparison rather than only printing it is what makes "central agreed with every node for
      // the last six weeks" a statement someone can check before phase 4 flips authority — which
      // is the decision this phase exists to inform. §2.7: "run shadow mode — node stays
      // authoritative, ships everything up, compare".
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS shadow_reconciliations (
          id BIGSERIAL PRIMARY KEY,
          "nodeId" TEXT NOT NULL,
          "checkedAt" TIMESTAMPTZ NOT NULL,
          -- What the node says it holds, as the node reported it.
          "nodeEventCount" BIGINT,
          "nodeChainSeq" BIGINT,
          "nodeChainHash" TEXT,
          "nodeOutboxPending" BIGINT,
          -- What central holds for that node at the same moment.
          "centralEventCount" BIGINT,
          "centralMaxSeq" BIGINT,
          "centralChainHash" TEXT,
          "centralShipmentCount" BIGINT,
          -- The verdict, derived at check time and stored so a run of them can be queried without
          -- re-deriving: 'match' | 'lagging' | 'gap' | 'divergent'.
          verdict TEXT NOT NULL,
          detail TEXT
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS shadow_reconciliations_node_idx ON shadow_reconciliations ("nodeId", "checkedAt" DESC)');
    },
  },
  {
    version: 3,
    name: 'policy authority — capabilities, principals, grants, approvals, change log',
    up: async (ctx) => {
      // ====================================================================================
      // PHASE 4 (§2.7). The tables this file's header said would "arrive in phase 4, by a
      // migration that will be numbered after these".
      //
      // Their presence is the whole of the change: from here on central is the SINGLE WRITER for
      // policy (§2.2's control plane), it mints the ids, and every node holds a read replica plus
      // the deny-list. The node's own SQLite keeps the same tables — that is what keeps the hot
      // path a local prepared statement — but it stops being allowed to write them
      // (server/store.js's PolicyReadOnlyError) and its rows arrive only through the delta stream.
      //
      // The column lists are the node's, spelling for spelling, for the reason ./pgDriver.js gives
      // about identifier case: a row read out of central and a row read out of a node's SQLite have
      // to be the same object, because the delta ships the row verbatim and the node writes it
      // straight into its mirror. A translation here is a translation that has to be undone there,
      // and the two halves eventually disagree about which direction it went.
      //
      // Node-local columns are deliberately ABSENT from `capabilities`: `source`, `discoveredAt`,
      // `lastSeenAt`, `stale` and `realUsage` describe what a *particular machine* found on its own
      // filesystem and how recently. That is §2.2's discovery row — the node proposes, central owns
      // the canonical identity and its id, and the machine-local sighting stays on the machine.
      // Shipping them centrally would make the last node to report overwrite every other node's
      // record of when it last saw its own copy.
      // ====================================================================================

      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS capabilities (
          "id" TEXT PRIMARY KEY,
          "kind" TEXT,
          "name" TEXT NOT NULL,
          "owner" TEXT,
          "riskTier" TEXT NOT NULL,
          "description" TEXT,
          "autoGrant" BOOLEAN NOT NULL DEFAULT FALSE,
          "createdAt" TEXT NOT NULL
        )
      `);
      // §2.2: "needs UNIQUE(kind,name); ids minted centrally". Over COALESCE rather than the bare
      // columns because Postgres treats NULLs as distinct in a unique index, so two rows with
      // kind IS NULL and the same name would both be accepted — and a null kind is the ordinary
      // shape of a capability registered without one. The node's SQLite has the same hazard and the
      // same fix; keeping the two expressions identical is what makes "central and the node agree
      // on what a duplicate is" a property rather than a coincidence.
      await ctx.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS capabilities_kind_name_uniq
          ON capabilities (COALESCE("kind", ''), "name")
      `);

      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS principals (
          "id" TEXT PRIMARY KEY,
          "kind" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "subjectId" TEXT,
          "assuranceLevel" INTEGER,
          "parentRole" TEXT,
          "humanName" TEXT,
          "backend" TEXT,
          "agentType" TEXT,
          "field" TEXT,
          "standalone" BOOLEAN NOT NULL DEFAULT FALSE,
          "status" TEXT NOT NULL DEFAULT 'active',
          "owner" TEXT,
          "createdAt" TEXT NOT NULL
        )
      `);
      // (kind, name) is the lookup the hook path resolves through — an agentType on a role row, a
      // loom id on an instance row. Unique *fleet-wide* is a real change from the node's world,
      // where two machines each held their own `role/claude`: they are now one row, which is the
      // point of a fleet registry and is what makes a grant issued once apply everywhere.
      await ctx.exec('CREATE UNIQUE INDEX IF NOT EXISTS principals_kind_name_uniq ON principals ("kind", "name")');
      // §1.4's subject key, unique where present. Partial, because only `user` rows carry one.
      await ctx.exec('CREATE UNIQUE INDEX IF NOT EXISTS principals_subject_uniq ON principals ("subjectId") WHERE "subjectId" IS NOT NULL');

      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS grants (
          "id" TEXT PRIMARY KEY,
          "principalId" TEXT NOT NULL,
          "capabilityId" TEXT NOT NULL,
          "constraints" TEXT,
          "createdAt" TEXT NOT NULL,
          "expiresAt" TEXT,
          "revokedAt" TEXT,
          "revokedBy" TEXT
        )
      `);
      // The node's partial unique index, moved to where the single writer now is. Scoped to live
      // rows so a soft-deleted grant does not occupy the slot its replacement needs — same reason
      // as ../schema/nodeMigrations.js, and now the *only* place it is enforced, since the node no
      // longer accepts a write that could violate it.
      await ctx.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS grants_active_uniq
          ON grants ("principalId", "capabilityId") WHERE "revokedAt" IS NULL
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS grants_principal_idx ON grants ("principalId")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS grants_revoked_idx ON grants ("revokedAt")');

      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          "id" TEXT PRIMARY KEY,
          "action" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'pending',
          "principalId" TEXT,
          "capabilityId" TEXT,
          "payload" TEXT NOT NULL,
          "requestedByScope" TEXT NOT NULL,
          "requestedAt" TEXT NOT NULL,
          "decidedAt" TEXT,
          "decidedByScope" TEXT,
          "reason" TEXT,
          "resultGrantId" TEXT
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals ("status")');

      // The control-plane audit. §2.2 puts it centrally with "none" on the node, and that is not a
      // storage preference: a control-plane change can only *happen* centrally now, so a node-side
      // audit table would be one that can only ever be empty or wrong.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS windrow_audit (
          "id" TEXT PRIMARY KEY,
          "action" TEXT NOT NULL,
          "actorScope" TEXT NOT NULL,
          "osUser" TEXT,
          "hostname" TEXT,
          "nodeId" TEXT,
          "principalId" TEXT,
          "capabilityId" TEXT,
          "grantId" TEXT,
          "before" JSONB,
          "after" JSONB,
          "reason" TEXT,
          "createdAt" TEXT NOT NULL
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS windrow_audit_created_idx ON windrow_audit ("createdAt")');

      // ------------------------------------------------------------------ the change log
      //
      // The node's `policy_changes` (server/store.js), moved to the authority. BIGSERIAL for the
      // same reason the node used AUTOINCREMENT: `version` is a promise to every replica that a
      // number, once handed out, is never handed out again. A rowid-style counter that reuses
      // values after a delete would let a node hold version N meaning one thing while central meant
      // another, and every delta after it would be applied to the wrong base.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS policy_changes (
          "version" BIGSERIAL PRIMARY KEY,
          "entity" TEXT NOT NULL,
          "entityId" TEXT NOT NULL,
          "op" TEXT NOT NULL,
          "row" JSONB,
          "ts" TEXT NOT NULL
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS policy_changes_entity_idx ON policy_changes ("entity", "entityId")');

      // Which node holds which replica version — the fleet-wide answer to "who is behind", and the
      // number §2.4's revocation window is actually measured by rather than assumed to be. A node
      // stamps this on every pull; central never guesses it. Deliberately distinct from
      // `usage_shipments`, which only says a node is *shipping*: a node can ship perfectly while
      // its policy replica is frozen, and telling those two apart is the §2.6 skew question.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS node_policy_state (
          "nodeId" TEXT PRIMARY KEY,
          "replicaVersion" BIGINT NOT NULL DEFAULT 0,
          "schemaVersion" INTEGER,
          "lastPulledAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "lastResetAt" TIMESTAMPTZ
        )
      `);
    },
  },
  {
    version: 4,
    name: 'alerts — the shared dedup key both ends write through',
    up: async (ctx) => {
      // docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both ends":
      // "Dedupe on a stable alert key (ruleId, subjectId, window) so a breach seen from both sides
      // fires once."
      //
      // THIS TABLE IS THE DEDUP. It has two writers, and unlike every other table in this schema
      // that is not a design smell — it is the design. ./alertEngine.js writes what central derives
      // from the aggregate; POST /api/ingest/alerts writes what a node fired locally
      // (../alerts/nodeShipper.js). §2.2's "neither direction ever has two writers for the same
      // row" still holds, because they are not writing the same row twice: they are racing to
      // create it once, and the primary key decides. Whichever arrives second is an ON CONFLICT DO
      // NOTHING and the row keeps the FIRST observation — which is the one worth keeping, since
      // being told about a burst is only useful at the earliest moment somebody knew.
      //
      // `key` is built by `alertKey()` in ../alerts/rules.js and by nothing else, on both ends. It
      // is stored as the primary key AND decomposed into columns: the columns are what every query
      // filters on, and re-splitting the key string to answer "what has fired for this subject
      // today" would be parsing a value a constraint already promised was well-formed.
      //
      // WHY THIS TABLE IS NOT PARTITIONED, unlike usage_events. Alerts are the summary, not the
      // stream — a fleet producing a hundred thousand usage events an hour produces alerts in the
      // tens per day, because that is what a threshold is for. Partitioning would also make the
      // primary key impossible: Postgres requires the partition key inside every unique index, and
      // adding a time column to the key is exactly the mistake ./store.js's header describes for
      // `usage_shipments` — the dedup would look right and dedupe nothing, since two evaluations
      // of one breach necessarily arrive at two different times.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          key TEXT PRIMARY KEY,
          "ruleId" TEXT NOT NULL,
          scope TEXT NOT NULL,
          -- The nodeId for a node-scoped rule, the literal 'fleet' for a fleet-scoped one. See the
          -- header of ../alerts/rules.js: the same subject bursting on two PCs is two incidents,
          -- and on §2.3's three columns alone the second would be swallowed as a duplicate.
          "scopeId" TEXT NOT NULL,
          "subjectId" TEXT NOT NULL,
          "windowStart" TIMESTAMPTZ NOT NULL,
          "windowEnd" TIMESTAMPTZ NOT NULL,
          "windowMs" BIGINT NOT NULL,
          metric TEXT NOT NULL,
          threshold DOUBLE PRECISION NOT NULL,
          -- What the winning writer counted. NOT reconciled against the loser: see "value" and
          -- "peerValue" below.
          value DOUBLE PRECISION NOT NULL,
          severity TEXT NOT NULL,
          title TEXT,
          -- 'node' or 'central' — which end got here first. The single most operationally useful
          -- column in the table, and the only one that cannot be reconstructed afterwards: a row
          -- that says 'node' means a machine caught this itself, possibly while unreachable, and a
          -- row that says 'central' means nobody knew until the events landed here.
          "firedBy" TEXT NOT NULL,
          -- The machine the breach happened on, for a node-scoped rule. NULL for fleet rules, where
          -- the whole point is that no single machine owns it.
          "nodeId" TEXT,
          -- When the WINNER decided it had a breach, on the winner's clock. For a node-fired alert
          -- that clock is a user's PC (§2.3: "trust node clocks for nothing"), which is why
          -- "recordedAt" exists beside it and is assigned here, inside the insert.
          "firedAt" TIMESTAMPTZ NOT NULL,
          "recordedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          detail JSONB,
          -- The loser's observation, kept rather than discarded. When both ends fire the same key
          -- the second write cannot change "value" — the row is already there — but the two counts
          -- disagreeing is a real signal: it means the node and central were looking at different
          -- sets of rows for the same window, which is either shipping lag (expected, and the size
          -- of the gap is the interesting number) or a node whose stream has a hole in it. Throwing
          -- the second number away would make that permanently undetectable, so it is recorded on
          -- the existing row and nothing else about that row is touched.
          "peerFiredBy" TEXT,
          "peerValue" DOUBLE PRECISION,
          "peerSeenAt" TIMESTAMPTZ
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS alerts_fired_idx ON alerts ("firedAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS alerts_subject_idx ON alerts ("subjectId", "firedAt" DESC)');
      // The cooldown lookup central makes before firing: "has (rule, scope, subject) fired
      // recently". Overlapping hopping windows mean one continuing breach satisfies several
      // consecutive window keys, all distinct, so this read is what stands between one alert and
      // one per stride.
      await ctx.exec('CREATE INDEX IF NOT EXISTS alerts_cooldown_idx ON alerts ("ruleId", "scopeId", "subjectId", "firedAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS alerts_node_idx ON alerts ("nodeId", "firedAt" DESC)');
    },
  },
  {
    version: 5,
    name: 'enrollment — per-node credentials issued by central',
    up: async (ctx) => {
      // docs/design/setup-after-central.md §2: the ONE gap that stops a two-host fleet being
      // assembled. A node enrolls against its own server (:4443), which has its own CA; central
      // verifies client certificates against ITS OWN ca-cert.pem (../enrollment/ca.js,
      // WINDROW_CA_DIR). On one machine those are the same directory, which is why phase 3's
      // end-to-end run passed. On two they are two different roots, and every batch a remote node
      // ships is rejected at the TLS layer with UNABLE_TO_VERIFY_LEAF_SIGNATURE before it reaches
      // any route.
      //
      // The fix picked by §2's table is the left-hand column: THE CA LIVES ON CENTRAL AND CENTRAL
      // ISSUES. The alternative — copying server/data/ca/ to the central host — copies the CA
      // PRIVATE KEY onto a second machine, and that key can mint an admin certificate for any node
      // id in the fleet. One key, one place, and the place is the control plane that already
      // decides policy.
      //
      // Central therefore needs the two tables ../enrollment/routes.js reads, which until now
      // existed only in the node's SQLite (../store.js). This migration is that schema, and it is
      // a MIRROR rather than a redesign on purpose: the same router file drives both stores, so a
      // column that exists on one end and not the other is a route that works on a node and 500s
      // on central.
      //
      // TIMESTAMPS ARE TEXT, not TIMESTAMPTZ, unlike every other table in this schema. That is
      // deliberate and it is the mirror rule again: ../enrollment/routes.js does
      // `Date.parse(row.expiresAt)` and hands these rows straight to `res.json`, so a `pg` driver
      // returning Date objects here would make the same route answer with two different wire
      // formats depending on which store it was mounted against. ISO-8601 UTC strings also
      // compare lexicographically, which is what makes the conditional UPDATE below work on TEXT.
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS enrollment_tokens (
          id TEXT PRIMARY KEY,
          -- SHA-256 of the token, never the token. An operator who can read this table still
          -- cannot enroll with what they find — the plaintext exists exactly once, in the response
          -- that minted it. UNIQUE because the hash is what an enrolling request is looked up by,
          -- and two rows sharing one would make "which token is this" ambiguous at the one moment
          -- it must not be.
          "tokenHash" TEXT NOT NULL UNIQUE,
          label TEXT,
          -- 'admin' | 'proposer' | 'node' — ../enrollment/ca.js SCOPES. The scope the CERTIFICATE
          -- gets, fixed by whoever minted the token rather than chosen by whoever spends it: a
          -- caller that could name its own scope could enroll itself as admin.
          scope TEXT NOT NULL,
          "expiresAt" TEXT,
          "createdAt" TEXT NOT NULL,
          "createdByScope" TEXT,
          -- The single-use gate's two halves. Set together, by one conditional UPDATE, and never
          -- cleared: a spent token stays spent even when issuing subsequently failed, or a caller
          -- with one token would get unlimited attempts at the step that creates authority.
          "usedAt" TEXT,
          "usedByNodeId" TEXT,
          "revokedAt" TEXT
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS enrollment_tokens_created_idx ON enrollment_tokens ("createdAt" DESC)');

      // ---- the enrollment half of `nodes` -----------------------------------------------------
      //
      // NOT A SECOND TABLE, and this is the subtle part of the migration. Central's `nodes` is an
      // INGEST ROSTER (migration 1): its rows are created by ../store.js's per-batch upsert the
      // first time a node ships anything, keyed on the same "nodeId" an enrollment would mint. Two
      // tables would mean the roster and the credential register disagreeing about which nodes
      // exist, and every fleet query having to decide which one it believed.
      //
      // So the two sets of columns share one row, with two writers that never write each other's
      // columns: ingest owns firstSeenAt/lastSeenAt/lastSeq/eventCount/hostname/osUser/certSubject
      // and the rolling measures; enrollment owns everything added below. ../store.js's upsert
      // names its columns explicitly in both the INSERT and the ON CONFLICT DO UPDATE SET, so a
      // batch arriving from an enrolled node updates its ingest counters and leaves its
      // certificate identity untouched — and ./enrollmentStore.js's registerNode is an UPSERT for
      // the mirror-image reason: a node that shipped before it enrolled (or on the insecure
      // loopback path) already has a roster row, and an INSERT would fail on the primary key.
      //
      // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` rather than the migrator's `ctx.addColumn`
      // helper: that helper compares the name it is given against information_schema, which stores
      // the UNQUOTED name, and every camelCase column here has to be quoted to survive Postgres's
      // identifier folding. Passing the quoted form would make the guard never match and the ALTER
      // always run; passing the bare form would make the ALTER create "enrolledat". Postgres's own
      // IF NOT EXISTS has neither problem.
      for (const [column, definition] of [
        ['label', 'TEXT'],
        ['scope', 'TEXT'],
        ['"enrolledAt"', 'TEXT'],
        // The SPKI the node generated and sent. The private half never left that machine — that is
        // the whole difference between this and the shared bearer token it replaces.
        ['"publicKey"', 'TEXT'],
        // On the request path for every authenticated call: ../auth.js and ./routes.js look a
        // presented certificate up by serial to answer "is this node still allowed". Indexed
        // below for that reason and no other.
        ['"certSerial"', 'TEXT'],
        ['"certFingerprint"', 'TEXT'],
        ['"certNotAfter"', 'TEXT'],
        // Revocation, in place of a CRL or an OCSP responder. Every caller already reaches this
        // process on every request, so a column here IS the revocation channel and it takes effect
        // on the very next request rather than at the next CRL publication.
        ['"revokedAt"', 'TEXT'],
        ['"revokedReason"', 'TEXT'],
      ]) {
        await ctx.exec(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }
      await ctx.exec('CREATE INDEX IF NOT EXISTS nodes_certSerial_idx ON nodes ("certSerial")');
    },
  },
  {
    version: 6,
    name: 'native tool observations, and hook integrity on the node roster',
    up: async (ctx) => {
      // ==================================================================================
      // docs/design/dashboard-placement.md, items 1 and 2. Two signals that never left the
      // node, arriving on their own terms.
      //
      // ---------------------------------------------------------------------------------
      // WHY `native_tool_events` IS A SECOND TABLE AND NOT MORE ROWS IN `usage_events`
      // ---------------------------------------------------------------------------------
      //
      // The node's own reason (../nativeObservations.js) is the reason here, and the design
      // note is explicit that it "must survive" the move: it argues for a separate ingest
      // path and a separate table at central, NOT for folding native calls into the audit
      // stream. Restated once, because this end is where the mistake would be irreversible:
      //
      //   `usage_events` is the record of DECISIONS THIS SYSTEM MADE. Every row is a grant
      //   that was checked, an outcome that was produced, a principal resolved at call time,
      //   and the whole table is hash-chained so that a row removed or edited is detectable.
      //   A native observation is none of those. It is unenforced, best-effort, arrives late
      //   and out of order after a drain, and can be dropped outright when the node's spool
      //   hits its cap. And there are one to two orders of magnitude more of them — so
      //   merging them would not merely blur the audit log, it would DROWN it: every drift
      //   number, usage summary and denial rate central computes would silently change
      //   meaning, while the chain that made the log worth trusting would be full of rows
      //   that were never in any chain.
      //
      // So: own table, own ingest route, own idempotency key, and no seq/prevHash/hash
      // columns at all. There is nothing here to verify because nothing here was ever
      // claimed to be complete.
      //
      // IDEMPOTENCY IS THE ROW'S OWN ID, and that is why this table needs no shipment ledger
      // beside it. `usage_shipments` exists because a usage event's identity is the shipment
      // that carried it; a native observation's id is a SHA-256 of the spool line that
      // produced it (../nativeObservations.js `observationId`), so the same observation is
      // the same id no matter how many times it is shipped, from which batch, or after which
      // crash. A redelivery is an ON CONFLICT DO NOTHING against the primary key. The one
      // cost is the one the node already accepted and documented: two genuinely distinct
      // calls identical in every recorded dimension including the millisecond collapse into
      // one row.
      //
      // PARTITIONED BY MONTH, LIKE `usage_events`, ON CENTRAL'S OWN CLOCK. Same reasoning as
      // migration 1's header, and it applies harder here because the volume is higher: the
      // key has to be a fact central controls, or a node can bury a month of its own activity
      // in a partition nobody queries by dating it 1999. `observedAt` is assigned at ingest;
      // `ts` is what the node said and is kept beside it, unjudged.
      //
      // WHY THE PRIMARY KEY IS (observedAt, nodeId, id) AND NOT (nodeId, id). Postgres
      // requires the partition key inside every unique index on a partitioned table — the
      // same constraint migration 1 works around for `usage_events`. So the physical key
      // carries `observedAt`, and cross-partition idempotency is bought instead by the id
      // being content-derived AND by ingest resolving a redelivery against the id index
      // before it inserts. See ./store.js `ingestNativeBatch`.
      // ==================================================================================
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS native_tool_events (
          -- SHA-256 of the spool line, minted on the node. See above: this IS the dedup.
          "id" TEXT NOT NULL,
          "nodeId" TEXT NOT NULL,
          -- Which lifetime of that node produced it (migration 7). Nullable: an observation
          -- shipped by a node predating incarnations has none, and reads as "not recorded"
          -- rather than being assigned one central invented.
          "incarnation" TEXT,
          -- The principal the node resolved it to. Deliberately NOT a foreign key onto
          -- principals, exactly as on the node: an observation is not policy, and the node
          -- may legitimately have parked it under an unresolved:<loomId> placeholder when
          -- its replica had no row yet. A constraint here would reject precisely the rows
          -- that the node's placeholder mechanism exists to preserve.
          "principalId" TEXT,
          "toolName" TEXT NOT NULL,
          -- One argument, chosen per tool on the node — a path, a pattern, or for Bash the
          -- program name ONLY. Never a full shell command line: see nativeCallDetail in
          -- ../hooks/lib.js for why, and note that the reason (tokens and heredoc'd file
          -- content in argv) gets stronger, not weaker, once the value crosses a network.
          "detail" TEXT,
          "ts" TEXT,
          "outcome" TEXT,
          "reason" TEXT,
          "sessionId" TEXT,
          "actorLoomId" TEXT,
          "actorHumanName" TEXT,
          "actorAgentType" TEXT,
          "actorBackend" TEXT,
          "actorField" TEXT,
          "osUser" TEXT,
          "hostname" TEXT,
          -- Central's own clock, and the partition key.
          "observedAt" TIMESTAMPTZ NOT NULL,
          -- ts - observedAt, the same skew measure migration 1 keeps on usage_events. Worth
          -- having twice: the two streams leave the node by different paths and at different
          -- rates, so a skew visible in one and not the other is a shipping fault rather than
          -- a clock fault.
          "clockSkewMs" BIGINT,
          PRIMARY KEY ("observedAt", "nodeId", "id")
        ) PARTITION BY RANGE ("observedAt")
      `);
      await ctx.exec('CREATE TABLE IF NOT EXISTS native_tool_events_default PARTITION OF native_tool_events DEFAULT');
      // The dedup read, and the reason it can be one index rather than a scan of every
      // partition: ingest looks an incoming id up here before inserting.
      await ctx.exec('CREATE INDEX IF NOT EXISTS native_tool_events_id_idx ON native_tool_events ("id")');
      await ctx.exec('CREATE INDEX IF NOT EXISTS native_tool_events_node_idx ON native_tool_events ("nodeId", "observedAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS native_tool_events_tool_idx ON native_tool_events ("toolName", "observedAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS native_tool_events_principal_idx ON native_tool_events ("principalId", "observedAt" DESC)');

      // ---------------------------------------------------------------------------------
      // HOOK INTEGRITY AS NODE HEALTH — item 2, and the smallest change here with the
      // largest reach.
      //
      // Columns on `nodes` rather than a table of their own, for migration 5's reason: the
      // roster and the credential register already share one row because two tables would
      // disagree about which nodes exist. Health is a third set of columns with a third
      // writer (../nodeHealth.js posting to /api/ingest/node-health), and it writes only its
      // own — ingest keeps owning lastSeenAt/lastSeq/eventCount, enrollment keeps owning the
      // certificate identity.
      //
      // "is governance actually wired on that box" stops being a per-machine visit and
      // becomes SELECT "nodeId" FROM nodes WHERE "hookStatus" <> 'installed'.
      //
      // LAST-WRITE-WINS, WITH NO HISTORY. This is current state, not an event: a report that
      // never arrived costs nothing because the next one carries the same answer, and the
      // node keeps its own capped tamper journal for the case where the history matters.
      // `hookReportedAt` beside `hookCheckedAt` is what stops a stale row reading as a
      // healthy one — the first is central's clock, the second is the node's own claim.
      // ---------------------------------------------------------------------------------
      for (const [column, definition] of [
        // 'installed' | 'tampered' | 'missing' | 'unknown'. See ../nodeHealth.js hookHealth()
        // for why 'unknown' is not folded into healthy: a node with nothing installable
        // governs nothing, and a green row would say the opposite.
        ['"hookStatus"', 'TEXT'],
        ['"hookInstalledCount"', 'INTEGER'],
        ['"hookInstallableCount"', 'INTEGER'],
        ['"hookBrokenCount"', 'INTEGER'],
        ['"hookTamperCount"', 'INTEGER'],
        ['"hookLastTamperAt"', 'TEXT'],
        // The whole report, so a fleet view can name the provider and the config path without
        // a second round trip. JSONB here rather than TEXT — unlike `extra` on usage_events,
        // nothing hashes this, so normalising whitespace and key order costs nothing and buys
        // a queryable column.
        ['"hookDetail"', 'JSONB'],
        // When the NODE says it checked. A node's own clock, and §2.3 trusts those for
        // nothing — which is why the next column exists.
        ['"hookCheckedAt"', 'TEXT'],
        // When CENTRAL received the report. The column a "which nodes have gone quiet about
        // their hooks" query actually filters on.
        ['"hookReportedAt"', 'TIMESTAMPTZ'],
        // When this node last shipped native observations. Kept apart from `lastSeenAt` — which
        // ingest of the audit stream owns — because the two streams leave the node by different
        // paths: a node whose usage is arriving and whose observations are not has a stuck native
        // shipper, and folding both into one column would make that state invisible.
        ['"nativeLastSeenAt"', 'TIMESTAMPTZ'],
      ]) {
        await ctx.exec(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }
      await ctx.exec('CREATE INDEX IF NOT EXISTS nodes_hookStatus_idx ON nodes ("hookStatus")');
    },
  },
  {
    version: 7,
    name: 'incarnation — a dense chain per node lifetime',
    up: async (ctx) => {
      // ==================================================================================
      // docs/design/dashboard-placement.md item 5, central's half. Without this migration
      // the node's half makes things WORSE rather than better, so the two belong read
      // together.
      //
      // THE PROBLEM. Node identity moved out of the database and into configuration, so a
      // rebuilt node is the same node — which is what ends the ghost roster this fleet was
      // measured showing (5 nodes, 1 seen in the last 24 hours). But `seq` is assigned from
      // MAX(seq) over the node's OWN table, so a rebuilt node with a stable id and an empty
      // database starts again at 1. And central does not shrug at that: ./queries.js checks
      // the shipped stream is DENSE with LAG(seq), and checks each row's prevHash against
      // the previous row's hash. A rebuild presents duplicate seqs with a null prevHash,
      // which is the signature of a spliced log.
      //
      // The tamper detector would therefore fire on every rebuild, and every one of those
      // firings would be false. That is worse than no detector at all: an alarm that always
      // rings gets switched off, and then the real one is missed too.
      //
      // THE FIX, and why it is this one. Three options were on the table. Recovering `seq`
      // from central at node startup makes cold start depend on central being reachable,
      // which §2.8 exists to avoid. A fresh node id per rebuild gives correct chains and
      // restores the ghost roster. So the chain gains a third coordinate:
      //
      //   (nodeId, incarnation, seq)
      //
      // Stable logical identity for the roster, a fresh dense chain per lifetime, no
      // dependency on central at boot. The density check then runs WITHIN an incarnation,
      // which is the only scope in which density was ever a meaningful claim — it was always
      // "this writer emitted 1..N with no holes", and a writer is a lifetime, not a machine.
      //
      // NULLABLE, AND EVERY EXISTING ROW STAYS NULL. A node predating incarnations ships no
      // incarnation, and central must keep accepting it (§2.6's tolerance rule). NULL reads
      // as "not recorded", which is honest — and ./queries.js coalesces it to a single
      // legacy bucket so those rows still form one chain rather than N chains of one.
      // ==================================================================================
      await ctx.exec('ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS "incarnation" TEXT');
      await ctx.exec(
        'CREATE INDEX IF NOT EXISTS usage_events_node_incarnation_seq_idx '
        + 'ON usage_events ("nodeId", "incarnation", "seq")'
      );

      // ---- the shipment ledger's key has to widen too -----------------------------------
      //
      // THIS IS THE PART THAT WOULD LOSE DATA IF IT WERE SKIPPED. `usage_shipments` is keyed
      // (nodeId, seq, kind), and the shipment counter restarts with the node's lifetime. So
      // a rebuilt node's very first shipment collides with one the previous incarnation
      // already sent, ON CONFLICT DO NOTHING fires, and the event is discarded as a
      // redelivery — silently, and for every shipment that node ever makes again.
      //
      // Rebuilding the primary key rather than adding a column beside it, because a primary
      // key is what does the deduplication and a wider index next to a narrower one changes
      // nothing. Existing rows take NULL, and NULL is folded to a sentinel in the key:
      // Postgres treats NULLs as distinct in a unique constraint, so leaving them NULL would
      // mean the pre-incarnation ledger silently stopped deduplicating anything — the exact
      // failure this key exists to prevent, arrived at from the other direction.
      await ctx.exec('ALTER TABLE usage_shipments ADD COLUMN IF NOT EXISTS "incarnation" TEXT');
      await ctx.exec(`UPDATE usage_shipments SET "incarnation" = 'inc_0' WHERE "incarnation" IS NULL`);
      await ctx.exec(`ALTER TABLE usage_shipments ALTER COLUMN "incarnation" SET DEFAULT 'inc_0'`);
      await ctx.exec('ALTER TABLE usage_shipments ALTER COLUMN "incarnation" SET NOT NULL');
      await ctx.exec('ALTER TABLE usage_shipments DROP CONSTRAINT IF EXISTS usage_shipments_pkey');
      await ctx.exec(
        'ALTER TABLE usage_shipments ADD PRIMARY KEY ("nodeId", "incarnation", seq, kind)'
      );

      // ---- the roster learns how many lifetimes a node has had ---------------------------
      //
      // On a long-lived node this is 1 forever and says nothing. On a disposable one it is
      // the most operationally interesting number about that machine: "this node has been
      // rebuilt eleven times this week" is a question nobody could ask before, because every
      // rebuild used to arrive as a different node.
      for (const [column, definition] of [
        ['"lastIncarnation"', 'TEXT'],
        ['"incarnationCount"', 'INTEGER NOT NULL DEFAULT 0'],
        ['"lastIncarnationAt"', 'TIMESTAMPTZ'],
      ]) {
        await ctx.exec(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }
    },
  },
  {
    version: 8,
    name: 'join credentials — bounded-use enrollment tokens',
    up: async (ctx) => {
      // docs/design/dashboard-placement.md item 7, and the MIRROR of the node's migration 20 —
      // ../enrollment/routes.js is one router driven against both stores, so a column on one end
      // and not the other is a route that works on a node and 500s on central.
      //
      // Re-creating a node needs an admin to mint a token through central. That is right for a
      // machine somebody installs once and wrong for a fleet member expected to be replaced, which
      // is what every other item in that note is making routine.
      //
      // maxUses DEFAULTS TO 1, so nothing already in this table becomes more permissive and a
      // token minted without asking stays single-use. Unlimited is not expressible on purpose: a
      // token with no ceiling is a shared bearer secret, which is what §2.5 replaced per-node
      // credentials to get rid of.
      await ctx.exec('ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS "maxUses" INTEGER NOT NULL DEFAULT 1');
      await ctx.exec('ALTER TABLE enrollment_tokens ADD COLUMN IF NOT EXISTS "uses" INTEGER NOT NULL DEFAULT 0');
      // A token already spent starts at its ceiling. Without this the migration would hand every
      // used single-use token one more use, which is a free re-enrollment for anyone still holding
      // an old one.
      await ctx.exec('UPDATE enrollment_tokens SET "uses" = 1 WHERE "usedAt" IS NOT NULL AND "uses" = 0');
    },
  },
  {
    version: 9,
    name: 'local divergence — the pause, the lease, the credential and the fault journal',
    up: async (ctx) => {
      // ==================================================================================
      // docs/design/disposable-nodes.md §5, and the number that motivates the whole thing:
      //
      //   Node columns on a grant row:                0
      //   Ways a node can widen its effective grants: 2
      //   Of those, visible at central:               0
      //
      // §5 settles the design question — a node's grants stay fleet-wide, and node variation
      // is expressed as a NARROWING profile (migration 10), never as a node dimension on a
      // grant row. But it also states the rule that follows from that answer: "narrowing is
      // free, widening is REPORTED". These columns are the reported half.
      //
      // A node can overturn a healthy central deny for thirty minutes at a time, on its own
      // signature, using an enforcement pause it mints against a local admin certificate
      // central can neither issue nor revoke. That bypass is real, it is bounded, and closing
      // it is not what §5 asks for. What §5 asks for is that central be able to SEE it — so
      // "which of my nodes is not enforcing right now" stops being a question you answer by
      // walking to the machine.
      //
      // WHY ON `nodes` RATHER THAN A HISTORY TABLE. A pause is current state with an expiry
      // on it. Last-write-wins is correct and the roster is where every other current fact
      // about a node already lives, so a fleet query is one scan of one table rather than a
      // lateral join per row. The HISTORY of what a pause did lives in node_fault_journal
      // below, which is a different kind of thing and gets a different kind of table.
      // ==================================================================================
      for (const [column, definition] of [
        // The pause: node-minted, up to 30 minutes, and the one that overrides a real decision.
        ['"pauseId"', 'TEXT'],
        ['"pauseUntil"', 'TIMESTAMPTZ'],
        ['"pauseTiers"', 'TEXT'],
        ['"pauseReason"', 'TEXT'],
        ['"pauseIssuedBy"', 'TEXT'],
        // The grace lease: node-minted, up to 60 minutes, softens FAULTS only. Kept apart from
        // the pause rather than folded into one "degraded" flag, because they answer different
        // questions and an operator who cannot tell them apart will treat an ordinary upgrade
        // window as a bypass — or, far worse, the other way round.
        ['"leaseUntil"', 'TIMESTAMPTZ'],
        ['"leaseTiers"', 'TEXT'],
        // The headline. False EXACTLY when a pause is in force; a lease leaves it true.
        ['"enforcing"', 'BOOLEAN'],
        // §2.2's year fuse, reported before it blows rather than discovered after. `state` is
        // one of valid | expiring | expired | absent | unreadable | not-applicable.
        ['"credentialState"', 'TEXT'],
        ['"credentialNotAfter"', 'TIMESTAMPTZ'],
        // How much of this node's fault journal central has actually taken. A number that stops
        // climbing is a node whose evidence is not arriving, which is its own kind of alarm.
        ['"journalBytes"', 'BIGINT NOT NULL DEFAULT 0'],
        ['"journalEntries"', 'BIGINT NOT NULL DEFAULT 0'],
        ['"journalLastAt"', 'TIMESTAMPTZ'],
        // §6's machine-fact tier, and §3's two recoverable-only-by-hand leaks: discovery_sources,
        // kv.hook_integrity.everInstalled, kv.packages_enabled, WINDROW_USER_HOME. Central RECORDS
        // them and never pushes them back — the node is authoritative for this tier by design — so
        // one JSON column is the right shape: it is read as a page about one node, never queried by
        // field, and a column apiece would be schema churn for that.
        ['"facts"', 'JSONB'],
        ['"factsReportedAt"', 'TIMESTAMPTZ'],
      ]) {
        await ctx.exec(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }

      // ---------------------------------------------------------------------------------
      // THE FAULT JOURNAL AT CENTRAL — §3's first leak, and the one it calls the important
      // one.
      //
      // "Every degraded decision AND EVERY DENIAL AN ENFORCEMENT PAUSE SUPPRESSED, with the
      // pause id. The only record that a node stopped enforcing." 84 kB, append-only, and
      // until now the only copy — so a node destroyed while a pause was open took with it the
      // entire account of what that pause let through.
      //
      // NOT PARTITIONED, unlike usage_events and native_tool_events, and that is a decision
      // rather than an omission. Those two are unbounded per-node streams measured in
      // millions of rows; this one is written only when governance DEGRADED — a fault, or a
      // suppressed denial — so on a healthy fleet it is close to empty and on an unhealthy one
      // it is the thing you most want to query across every month at once. Partitioning would
      // buy a drop-partition retention story for a table whose whole value is that it is kept.
      //
      // THE PRIMARY KEY IS THE LINE'S CONTENT HASH, minted on the node (../nodeHealth.js
      // readJournalSlice). That is what makes the node's byte cursor safe to lose: a rebuilt
      // node re-ships from zero and every line it re-sends collides with the row already here.
      // The cost is the same one native observations already accept — two byte-identical
      // journal lines, including the timestamp, collapse into one row.
      // ---------------------------------------------------------------------------------
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS node_fault_journal (
          "id" TEXT PRIMARY KEY,
          "nodeId" TEXT NOT NULL,
          -- When the node says it happened, and when central actually took it. Both, because
          -- the gap between them IS the partition: a batch of entries whose ts is hours before
          -- their receivedAt is the record of a node that was unreachable and kept deciding.
          "ts" TIMESTAMPTZ,
          "receivedAt" TIMESTAMPTZ NOT NULL,
          -- The fault classification the hook assigned (server/hooks/lib.js FAULT), or null for
          -- an entry that was not a fault at all — a suppressed denial is the leading example.
          "fault" TEXT,
          "denialKind" TEXT,
          "tier" TEXT,
          "capability" TEXT,
          "principalId" TEXT,
          "outcome" TEXT,
          "why" TEXT,
          -- THE FIELD THIS TABLE EXISTS FOR. Set on every denial an enforcement pause
          -- suppressed, and it is what turns "this node was paused for 30 minutes" into "and
          -- here are the eleven calls it allowed that would otherwise have been denied".
          "pauseId" TEXT,
          "policyAgeMs" BIGINT,
          "policyVersion" BIGINT,
          -- The whole line as it was written, unjudged. The columns above are the ones worth
          -- querying; this is the one worth reading when a column turns out not to have been.
          "raw" JSONB NOT NULL
        )
      `);
      // The two questions this table gets asked: "what happened on that node, newest first"
      // and "what did that pause let through".
      await ctx.exec('CREATE INDEX IF NOT EXISTS node_fault_journal_node_idx ON node_fault_journal ("nodeId", "ts" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS node_fault_journal_pause_idx ON node_fault_journal ("pauseId") WHERE "pauseId" IS NOT NULL');
    },
  },
  {
    version: 10,
    name: 'node profiles — a class label that can only narrow',
    up: async (ctx) => {
      // ==================================================================================
      // docs/design/disposable-nodes.md §5, THE DESIGN CALL THIS TABLE ANSWERS.
      //
      // The question was "how granular should a node's grants be", and the answer has four
      // parts. Three of them are about what NOT to build, and they are why this table looks
      // the way it does:
      //
      //   1. NEVER PUT A NODE DIMENSION ON THE GRANT ROW. Three independent reasons, any one
      //      sufficient. SEMANTICS: under most-restrictive intersection a node-scoped grant is
      //      a WIDENING — the union model docs/design/grant-resolution-semantics.md rejected
      //      because it stops the role being a ceiling. AMBIGUITY: a nullable nodeId needs a
      //      precedence rule against the fleet-wide row, which is the "whichever it finds
      //      first" defect that document exists to kill. ENFORCEMENT: the replica ships
      //      wholesale, so the scope would be enforced by each node choosing to respect its
      //      own id — the one field a compromised node controls.
      //
      //      So: `grants` is untouched by this migration, and must stay untouched.
      //
      //   2. EXPRESS NODE VARIATION AS A CEILING, in the constraint vocabulary already
      //      specified. Intersection has two legs, user ∩ role. A node profile is a third that
      //      CAN ONLY NARROW. AND commutes, so it needs no precedence rule — which is the
      //      whole reason a narrowing-only leg is safe where a node-scoped grant was not.
      //
      //   3. KEY IT ON A CLASS LABEL, NEVER ON A nodeId. `laptop`, `ci`, `workstation`. Per-
      //      machine policy is per-machine state, which is the thing disposability deletes; a
      //      rebuilt node re-enrols INTO a profile rather than carrying one. That is why the
      //      key here is a name and why `nodes.profile` below is a foreign-key-shaped label
      //      rather than a policy blob on the node row.
      //
      // WHY `config` IS ONE JSONB COLUMN rather than a column per dial. The set of dials is
      // ../policy/nodeConfig.js's PARAMETERS table, which is where the merge rule for each one
      // is written down — a column here would be a second declaration of the same thing, and
      // the two would drift. Profiles are few and always read whole, so nothing is lost. What
      // IS enforced is the key set: ../central/policyStore.js refuses a config naming a
      // parameter nodeConfig.js does not know, so a typo cannot become a setting nobody reads.
      // ==================================================================================
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS node_profiles (
          -- The class label. Lowercase, short, and the thing an operator types when enrolling.
          "name" TEXT PRIMARY KEY,
          "description" TEXT,
          -- The policy-parameter ceiling, keyed by ../policy/nodeConfig.js PARAMETER_KEYS. Every
          -- value in here can only narrow what the node would otherwise do; there is no key in
          -- that table whose effect is to widen, and adding one would break the AND.
          "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
          -- The profile's constraint leg, merged field-by-field with the user and role legs per
          -- docs/design/grant-resolution-semantics.md §2.1. Stored now and evaluated by
          -- ../policy/constraints.js; see that file on why an unrecognised key denies.
          "constraints" JSONB,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        )
      `);

      // WHICH PROFILE THIS MACHINE IS IN. Central already had `nodes.label`, and §5 notes it is
      // display-only with no policy effect — this is the column that has one. Nullable, and a
      // null profile means no ceiling: a fleet that never creates a profile behaves exactly as
      // it does today, which is the property every migration in this file tries to keep.
      await ctx.exec('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS "profile" TEXT');
      await ctx.exec('CREATE INDEX IF NOT EXISTS nodes_profile_idx ON nodes ("profile") WHERE "profile" IS NOT NULL');
    },
  },
  {
    version: 11,
    name: 'package_state — which capability packages the fleet has enabled, centrally',
    up: async (ctx) => {
      // ==================================================================================
      // Centrally enable/disable integrations and providers, replicating to nodes.
      //
      // A capability PACKAGE (server/packageDefs.js, docs/design/capability-packages.md) binds a
      // capability owner to a default-grant policy. WHICH packages are on was node-local state — the
      // node's `kv.packages_enabled` row, which migration 9 lists as one of §3's node-authoritative
      // "facts" central only records. That is right for a standalone install and wrong for a fleet:
      // under central authority the node's grant tables are a read-only mirror (server/store.js's
      // PolicyReadOnlyError), so a node cannot act on a package toggle at all — enabling one has to
      // happen where the grants are written.
      //
      // THE TRICKLE-DOWN NEEDS NO NEW CHANNEL. Enabling a package on central runs its sync against
      // the policy tables in this database (server/central/packages.js → policyStore.insertGrant),
      // and every grant that writes appends to `policy_changes` in the same transaction — so it
      // rides the delta stream every node already pulls (server/central/policyRoutes.js GET
      // /api/policy). Disable + revoke soft-deletes those grants, which rides the always-full
      // deny-list. This table only records the on/off DECISION; the grants are the mechanism.
      //
      // Deliberately NOT in `policy_changes`. Like node_profiles (see policyStore.upsertNodeProfile),
      // the enabled flag is not a replicated policy row — the node never reads it. Replicating it
      // would advance every node's replica version for a change none of them can apply. What the node
      // sees is the grants the flag produced, nothing more.
      // ==================================================================================
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS package_state (
          -- The package id from server/packageDefs.js — 'windrow', 'gmail', 'claude', … The row
          -- exists only for a package whose enabled state was set explicitly; a package with no row
          -- falls back to its enabledByDefault in code, so a new package added to the defs is on (or
          -- off) by its own default until someone decides otherwise, exactly as on the node.
          "id" TEXT PRIMARY KEY,
          "enabled" BOOLEAN NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- Which admin scope flipped it, for the audit trail. Nullable for a row written by a
          -- migration or a test rather than a request.
          "updatedByScope" TEXT
        )
      `);
    },
  },
  {
    version: 12,
    name: 'ingest_dead_letter — the receive-side quarantine, so a packet central cannot store is not lost',
    up: async (ctx) => {
      // ==================================================================================
      // docs/design/ingest-data-resilience.md. The node→central transport is already
      // resilient — a durable usage_outbox, retry with backoff, at-least-once delivery, and
      // the usage_shipments idempotency ledger. What was NOT resilient is the RECEIVE side.
      //
      // THE HOLE THIS CLOSES. `ingestBatch` (../store.js) returns HTTP 200 for a batch even
      // when some of its shipments could not be stored — a malformed NDJSON line, an envelope
      // carrying no event, an event with no `id`, a shipment with no `seq`. The node's shipper
      // treats any 2xx as a full-batch ack and deletes every row in the batch, reading only
      // `duplicates`. So an unstorable packet is deleted from the node's outbox AND was never
      // written at central, its only trace the first 20 rejections in one response body that
      // nobody persists. That is exactly the "we don't lose data packets and maintain
      // traceability" property this table exists to restore.
      //
      // WHY A DEAD-LETTER QUEUE AND NOT AN INFINITE RETRY. An event with no id is rejected on
      // every retry forever; leaving it on the node's outbox would block every good packet
      // behind it (head-of-line). The standard answer is to move the poison packet aside —
      // preserved verbatim, with its reason — so good traffic flows, and let an operator
      // inspect it (GET /api/fleet/dead-letters) or replay it once the cause is fixed
      // (POST /api/fleet/dead-letters/replay). Acking on the node plus quarantining here IS
      // the no-loss path.
      //
      // WRITTEN IN THE SAME TRANSACTION AS THE BATCH. ../store.js inserts these rows inside
      // the `withTransaction` that stores the good events, so a batch that rolls back
      // dead-letters nothing (the node retries the whole thing under at-least-once) and a
      // batch that commits loses nothing. The one refusal that is NOT dead-lettered is
      // NODE_IDENTITY_MISMATCH — a 403 that rejects the whole batch and keeps the rows on the
      // node, because a forgery signal must stay loud, not be quietly quarantined.
      //
      // NOT PARTITIONED, like `alerts` and `shadow_reconciliations`. This is the exception
      // stream, not the log: a fleet producing a hundred thousand events an hour produces
      // dead-letters in the handful, because that is what "central could not store it" means.
      // ==================================================================================
      await ctx.exec(`
        CREATE TABLE IF NOT EXISTS ingest_dead_letter (
          -- The dedupe key: sha256 of "nodeId|kind|payload", minted in ../store.js. A redelivery
          -- of the same unstorable packet (a lost ack, a node draining a backlog twice) is an
          -- ON CONFLICT that bumps occurrences rather than a second row — the same at-least-
          -- once tolerance the usage_shipments ledger gives the happy path, applied to the
          -- failure path.
          "id" TEXT PRIMARY KEY,
          -- Who shipped it: the certificate CN when the connection was authenticated, else the
          -- envelope's own claim, else NULL (a malformed line on the insecure loopback path may
          -- name no node at all). Kept so "which node keeps sending garbage" is a query.
          "nodeId" TEXT,
          "certSubject" TEXT,
          -- The batch trace id that quarantined it — the x-windrow-trace-id header the node
          -- sent, or one central generated for the request. This is the traceability half:
          -- it is returned in the ack, logged at both ends, and stamped here, so a row in this
          -- table ties back to the exact request and log line that dropped the packet. First
          -- sighting wins on conflict, since that is the one worth tracing back to.
          "traceId" TEXT NOT NULL,
          -- 'malformed_line' (parseNdjson could not read it) or 'rejected_event' (it parsed but
          -- ingest refused it — no id, no seq, no event, or no node).
          "kind" TEXT NOT NULL,
          "reason" TEXT NOT NULL,
          -- Known only for a rejected_event that got far enough to have them.
          "eventId" TEXT,
          "seq" BIGINT,
          -- The packet itself, verbatim: the raw NDJSON line for a malformed one, the
          -- re-serialized envelope for a rejected one. This is what a replay feeds back through
          -- ingest, and what makes the quarantine lossless rather than a count of losses.
          "payload" TEXT NOT NULL,
          "firstSeenAt" TIMESTAMPTZ NOT NULL,
          "lastSeenAt" TIMESTAMPTZ NOT NULL,
          "occurrences" INTEGER NOT NULL DEFAULT 1,
          -- 'quarantined' | 'replayed' | 'discarded'. Only the operator moves it off
          -- 'quarantined'; ingest never does, so a packet stays inspectable until someone acts.
          "status" TEXT NOT NULL DEFAULT 'quarantined',
          "replayedAt" TIMESTAMPTZ,
          "replayResult" TEXT
        )
      `);
      await ctx.exec('CREATE INDEX IF NOT EXISTS ingest_dead_letter_node_idx ON ingest_dead_letter ("nodeId", "lastSeenAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS ingest_dead_letter_status_idx ON ingest_dead_letter ("status", "lastSeenAt" DESC)');
      await ctx.exec('CREATE INDEX IF NOT EXISTS ingest_dead_letter_trace_idx ON ingest_dead_letter ("traceId")');
    },
  },
  {
    version: 13,
    name: 'usage_events toolInputDigest — the per-call payload fingerprint',
    // The node now stamps a fingerprint of the exact call onto each governed event
    // (server/hooks/lib.js's toolInputDigest, inside the node's hash chain) so the audit binds to
    // what was sent. Central stores it verbatim like every other chain-covered column. Added to the
    // partitioned parent, which cascades to every partition; nullable, so events shipped by a node
    // that predates the column read as "not recorded" rather than forcing a value (§2.6).
    up: async (ctx) => {
      await ctx.exec('ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS "toolInputDigest" TEXT');
    },
  },
  {
    version: 14,
    name: 'skill distribution — mark a skill for fleet-wide install',
    up: async (ctx) => {
      // Fleet skill distribution. Skills are catalog-only for ENFORCEMENT — no grant gates a skill
      // (docs/design/skill-mcp-governance.md §0) — but the point of a central skill catalog is
      // PROVISIONING: an admin marks a skill here and every node installs its SKILL.md so users get
      // it without hunting. `distribute` is that mark.
      //
      // DELIBERATELY NOT REPLICATED THROUGH THE POLICY DELTA. The delta ships capability rows into
      // each node's mirror (server/policy/policyClient.js materialiseReplica), whose upsert names a
      // fixed column set — an extra field there is a binding error waiting to happen. So this flag is
      // read only through the dedicated GET /api/policy/skills channel the node installer polls
      // (server/skillDistribution.js), and central's capOut strips it before it can reach the delta.
      // Distribution is a provisioning axis, separate from the policy-version replication.
      await ctx.exec('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS "distribute" BOOLEAN NOT NULL DEFAULT FALSE');
    },
  },
];

module.exports = { migrations, EVENT_COLUMNS, CENTRAL_COLUMNS, EVENT_COLUMN_NAMES };
