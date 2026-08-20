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
  // The per-node chain (§2.7 phase 1). Shipped as the node wrote them and stored verbatim: the
  // envelope carries the event's own seq/prevHash/hash so central can verify a node's chain from
  // the shipped stream alone, rather than trusting the order shipments happened to arrive in.
  ['nodeId', 'TEXT NOT NULL'],
  ['seq', 'BIGINT'],
  ['prevHash', 'TEXT'],
  ['hash', 'TEXT'],
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
];

module.exports = { migrations, EVENT_COLUMNS, CENTRAL_COLUMNS, EVENT_COLUMN_NAMES };
