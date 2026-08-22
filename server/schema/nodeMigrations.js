'use strict';

// The node store's schema, as one ordered migration list — see ./migrator.js for what runs it and
// why it exists (docs/design/global-identity-and-central-db.md §2.5). Everything here used to sit
// inline in server/store.js as a `CREATE TABLE IF NOT EXISTS` block followed by a dozen hand-rolled
// `PRAGMA table_info` / `if (!cols.includes(…)) ALTER TABLE` guards, re-evaluated on every process
// start. The statements are unchanged; what is new is that each one has a version, runs once, and
// is recorded.
//
// **Version 1 is the schema in its current full shape**, not its historical first shape. Versions
// 2+ are the column additions and table rebuilds that came after it, kept because databases in the
// field predate them — on a fresh database version 1 already produced those columns and each later
// migration finds its work done and no-ops. That is why `ctx.addColumn` is guarded rather than a
// bare ALTER: the guard is the one thing that lets an existing un-ledgered database be baselined by
// simply running the list from the top, with nothing rewritten and nothing dropped.
//
// ## Adding a migration
//
// Append an entry with the next version. Put the new column in **both** places: in version 1's SQL
// (so a fresh database gets it at creation, with the right type and default) and in a new migration
// (so every database already in the field gets it). Never edit a migration that has shipped — a
// node that already ran it will not run it again, so an edit only ever applies to some of the fleet.

const BASELINE_SQL = `
  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    kind TEXT,
    name TEXT NOT NULL,
    owner TEXT,
    riskTier TEXT NOT NULL,
    description TEXT,
    source TEXT,
    discoveredAt TEXT,
    lastSeenAt TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    realUsage TEXT,
    -- Per-capability replacement for the old AUTO_GRANT_OWNERS owner-string bypass: a
    -- capability with autoGrant=1 is treated
    -- as always-granted by findActiveGrant (app.js) without a real grant row. Never true for a
    -- 'destructive' row — enforced at every write site (app.js's POST/PATCH handlers), not just here.
    autoGrant INTEGER NOT NULL DEFAULT 0
  );


  -- status: a role principal minted by first
  -- sighting (server/principals/registry.js's upsertRole, run from the hook path on every
  -- unrecognized agentType) used to be granted every read_only capability in the same breath it
  -- was created — no human ever looked at it. 'pending' principals hold zero grants (direct or,
  -- since a pending role has none to fall back to, inherited) until an admin approves them via
  -- POST /api/principals/:id/approve, which is the only place the read-only baseline is applied
  -- now. Principals created through the admin-only POST /api/principals route, and every instance
  -- (which never held direct grants of its own anyway), still default to 'active'.
  -- subjectId (docs/design/global-identity-and-central-db.md §1.4, want-mszgwij4-17): the stable
  -- key. 'name' is NOT one — it holds a loom id on an 'instance' row and an agentType on a 'role'
  -- row, both of which are reused, renamed and respawned, while the grants and audit rows keyed to
  -- them are meant to outlive exactly that. So 'name' is demoted here to a mutable display label
  -- and the identity a row is *keyed* on, where it has one, lives in 'subjectId': an opaque OS
  -- identifier prefixed by the authority that issued it, so heterogeneous sources cannot collide —
  -- 'win-sid:S-1-5-…-1001', 'posix:1000@host', 'env-user:name@host' (tier 1 only), 'federated:…'
  -- reserved. See server/principals/subject.js for how each is read and what it is worth.
  --
  -- Only a 'user' principal carries one, and that is the point of the kind: it is the *subject* of
  -- a call (who is accountable) rather than the *actor* (what made it). Every loom on a machine
  -- shares one OS account, so putting subjectId on 'instance' rows would make the UNIQUE index
  -- below unsatisfiable — which is the schema stating the model correctly, not an obstacle to work
  -- around. 'role'/'instance' rows leave it NULL and keep being keyed on 'name' for now: this is
  -- phase 1 ("observe — record real OS identity, change no decision"), so nothing authorizes off a
  -- user row yet. Phase 5 is where the grant subject flips.
  --
  -- assuranceLevel: how the subject key was obtained, since "OS-read identity" and "a username off
  -- the environment" are not the same claim — 3 server-verified, 2 OS-read same machine, 1
  -- env-derived. NULL on rows with no subject. Making the tier explicit is what lets this ship
  -- incrementally without pretending tier 1 is tier 3.
  CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    -- Mutable display label. Never a key — see subjectId above.
    name TEXT NOT NULL,
    subjectId TEXT,
    assuranceLevel INTEGER,
    parentRole TEXT,
    humanName TEXT,
    backend TEXT,
    agentType TEXT,
    field TEXT,
    standalone INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  );

  -- Soft-delete: a revoked grant stays in this
  -- table — revokedAt/revokedBy set instead of the row being removed — so "who had this and who
  -- took it away" survives the revoke. That means the old table-level UNIQUE(principalId,
  -- capabilityId) constraint would wrongly block re-granting a pair after it's been revoked (the
  -- revoked row still occupies the slot), so the uniqueness guarantee that actually closes the
  -- self-grant/lost-write race (two concurrent POST /api/grants for the same pair can't both
  -- succeed off a stale read — the loser gets a real SQLITE_CONSTRAINT error, mapped to 409) is a
  -- *partial* unique index scoped to active rows only, created further down this file (it needs
  -- the revokedAt column to exist first, which an on-disk db predating this change only gains via
  -- the migration block below).
  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    principalId TEXT NOT NULL,
    capabilityId TEXT NOT NULL,
    constraints TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT,
    revokedAt TEXT,
    revokedBy TEXT
  );

  -- Append-only control-plane audit trail: every grant issue/revoke writes one row here.
  -- 'before'/'after' are JSON snapshots of the affected grant (null on the side that doesn't
  -- apply — no 'before' for an issue, no 'after' for a revoke) so "what changed" survives even
  -- though the grants row itself only ever shows current state. No UPDATE/DELETE statement is
  -- prepared against this table anywhere in this file — that's what "append-only" means here.
  CREATE TABLE IF NOT EXISTS windrow_audit (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actorScope TEXT NOT NULL,
    osUser TEXT,
    hostname TEXT,
    principalId TEXT,
    capabilityId TEXT,
    grantId TEXT,
    before TEXT,
    after TEXT,
    reason TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_windrow_audit_createdAt ON windrow_audit(createdAt);
  CREATE INDEX IF NOT EXISTS idx_windrow_audit_grantId ON windrow_audit(grantId);

  -- NOTHING BELOW 'id' IS NOT NULL, and that is §2.6's first rule in schema form: "an unknown
  -- field on an event is stored, never rejected; a missing field is null, never fatal. An old node
  -- must keep reporting to a new central." principalId/capabilityId/ts/outcome/latencyMs were NOT
  -- NULL until migration 15 relaxed them. A NOT NULL column forces an ingest that meets a build it
  -- does not recognise into one of two bad answers — reject the event, or invent a value for it —
  -- and inventing is the worse one, because 'unknown' and 0 are indistinguishable at read time
  -- from a real outcome and a real latency. Null says "not recorded", which is what happened.
  -- server/ingest/usageEvent.js is the normalizer that relies on this; every read site already
  -- tolerates nulls here (server/rollup/index.js normalizes a sibling db the same way).
  --
  -- 'id' stays NOT NULL because it is not a field, it is the key: it is what a correcting PATCH
  -- and an at-least-once redelivery both arrive holding, and an event without one cannot be
  -- deduplicated at all. The normalizer refuses such an event rather than minting an id for it.
  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    principalId TEXT,
    capabilityId TEXT,
    ts TEXT,
    outcome TEXT,
    latencyMs INTEGER,
    correlationId TEXT,
    reason TEXT,
    -- Latency breakdown (docs/design/latency-breakdown.md): all nullable, since events logged
    -- before this migration and any call that fails-open before reaching a given phase won't
    -- have it. See server/hooks/lib.js and app.js's POST /invoke for who fills in what.
    capabilityLookupMs INTEGER,
    principalResolveMs INTEGER,
    brokerMs INTEGER,
    grantCheckMs INTEGER,
    -- Real OS identity of the machine account that issued this call (server/principals/fromEnv.js's
    -- identityFromEnv — live os.userInfo()/os.hostname(), not a cached or derived value), independent
    -- of principalId (which identifies the *agent*, not the human/computer account it's running
    -- as). Nullable: a hook that failed before resolving identity, or an event predating this column.
    osUser TEXT,
    hostname TEXT,
    -- The calling agent itself, recorded as a dimension *of this call* rather than looked up
    -- through principalId at read time. A principal row is mutable and shared across every call
    -- an agent ever makes: its agentType/backend/field can be back-filled or corrected later, and
    -- an instance row can be renamed or repointed at a different role, which silently rewrites
    -- what every historical event appears to have been issued by. These four are a snapshot of
    -- what the hook actually observed at call time (server/principals/fromEnv.js's
    -- identityFromEnv, forwarded through /api/invoke), so grouping usage by agent type, backend
    -- or field reads the same tomorrow as it does today. They are also part of the hash chain
    -- below, so a later edit to them is detectable. Nullable: an event predating this column, or
    -- a caller that didn't forward the identity.
    actorLoomId TEXT,
    actorAgentType TEXT,
    actorBackend TEXT,
    actorField TEXT,
    -- The *subject* this call was accountable to, and how strongly it was established, snapshotted
    -- per call for the same reason the actor* columns above are (docs/design/global-identity-and-
    -- central-db.md §1.4). principals.assuranceLevel deliberately only ratchets *up* — a subject
    -- whose SID reads once is an OS-read identity thereafter — so the principal row cannot answer
    -- "how was identity established for *this* call". A run where the SID read failed and the key
    -- degraded to env-user: produces env-derived (1) events under a principal that says 2, and
    -- that difference is exactly what an audit of "which calls rest on a guessed username" needs.
    --   3 server-verified over an authenticated channel   (no producer yet — §1.5)
    --   2 OS-read identity, same machine                  (win-sid:, posix:)
    --   1 env-derived username, display only              (env-user:)
    -- Both nullable and hashed with the rest of the row: an event predating the columns, or a
    -- caller that forwarded no subject, reads honestly as "not recorded" rather than as tier 1.
    subjectId TEXT,
    assuranceLevel INTEGER,
    -- Shadow evaluation (docs/design/global-identity-and-central-db.md §1.6, phase 3,
    -- want-mszgwlsi-20). outcome above is the decision that was actually ENFORCED — the
    -- loom-keyed one, resolved instance -> parentRole. These three record what the *user-keyed*
    -- decision would have been for the same call, had the subject principal (§1.4) been
    -- authoritative, and nothing reads them to authorize anything. They exist so the flip at
    -- phase 5 is made against measured divergence rather than a guess about it.
    --
    --   shadowOutcome    'allow' | 'deny' | 'unevaluated' | 'error'. Deliberately NOT outcome's
    --                    vocabulary (ok/denied/error/approved): this is a *decision*, where
    --                    outcome is a decision that was then overwritten by what the tool did.
    --                    Reusing the words would invite comparing the two columns as strings,
    --                    which is wrong — a call enforced as allow reads 'error' if the tool
    --                    failed, and one enforced as deny reads 'approved' if the human said yes.
    --                    See enforcedDecision() in server/app.js for the mapping that is correct.
    --   shadowReason     why, in words — which leg of the user x role intersection failed, or why
    --                    the call could not be evaluated at all
    --   shadowPrincipalId  the user principal the shadow decision resolved to, or NULL when the
    --                      call reached no subject row at all. Deliberately the row id and not the
    --                      subject key: the key is already on this event (subjectId), and a
    --                      divergence is only actionable if it names the principal whose grants
    --                      would have to change
    --
    -- Divergence is derived (shadowOutcome vs outcome), not stored: a stored flag would be a
    -- second copy of a fact these columns already carry, free to disagree with them after a PATCH.
    shadowOutcome TEXT,
    shadowReason TEXT,
    shadowPrincipalId TEXT,
    -- Set once, the first (and only) time PATCH /api/usage/:id successfully corrects this row
    -- (server/app.js) — a non-null value both marks the one-shot correction as spent (a second
    -- PATCH is rejected) and is part of what gets hashed below, so flipping it back to NULL to
    -- unlock a second correction changes the row's hash and breaks the chain.
    correctedAt TEXT,
    -- Which node wrote this row, and where it sits in that node's own sequence
    -- (docs/design/global-identity-and-central-db.md §2.7 phase 1). A "node" is one windrow.db
    -- and the server process that owns it; its id is minted once into kv (see nodeId() below)
    -- and stamped on by the writer, never by the caller — an event's node is a fact about who
    -- recorded it, not a claim the poster gets to make.
    --
    -- These two exist because the chain below used to be keyed on rowid, i.e. on one db's
    -- insertion order. That is a total order only while there is exactly one writer, and
    -- server/rollup/index.js already merges usage_events out of every sibling workspace's db —
    -- so the merged log was being presented as one ordered audit trail that no single chain
    -- covered, and two nodes' rowid-1 rows are not comparable in any way. seq is per-node and
    -- gapless, so a merge can order within a node, dedupe on (nodeId, seq), and say honestly
    -- that it has no cross-node order rather than implying one.
    nodeId TEXT,
    seq INTEGER,
    -- When the *node* stamped the row, as against ts above, which is when the *caller* said the
    -- call happened (the hook's own clock, forwarded through /invoke). Two clocks, recorded
    -- separately so observedAt - ts is a measurable skew instead of an assumption: a hook on a
    -- machine minutes off, or an event replayed long after the fact, is otherwise invisible and
    -- silently reorders any ts-sorted view. Nullable for rows written before this column existed;
    -- deliberately NOT back-filled, since no honest value for "when we saw it" exists after the
    -- fact.
    observedAt TEXT,
    -- Hash-chain, so that an agent token able to PATCH cannot silently rewrite the audit log:
    -- hash is sha256(prevHash + canonical(row)), prevHash is the
    -- hash of the preceding row *of the same node* (seq - 1), NULL at seq 1. Any edit made
    -- outside this module — a direct DB write, or a restored backup with rows spliced out —
    -- changes a row's canonical form without recomputing the chain, so it desyncs hash from
    -- prevHash on that row and every row after it in that node's chain; verifyChain() below walks
    -- each node's chain and reports exactly where. This doesn't stop a write with database file
    -- access (no cryptographic scheme run by the same process that holds the signing key can),
    -- but it turns silent, undetectable tampering into a detectable break.
    prevHash TEXT,
    hash TEXT,
    -- Every field the writing build had no column for, as one canonical JSON object (§2.6, and
    -- see server/ingest/usageEvent.js). This is the other half of the rule above: a NEW node
    -- shipping to an OLD central sends fields that central cannot place, and an explicit INSERT
    -- column list drops them silently — so the data is gone by the time central upgrades and grows
    -- the column that would have held it. Kept here instead, verbatim, recoverable.
    --
    -- In the hash chain like every other column (canonicalizeUsageEvent in server/store.js), which
    -- is why it is one column of sorted-key JSON rather than a side table: an unrecognised field is
    -- evidence, and evidence outside the chain is evidence that can be edited without breaking
    -- anything. NULL, not '{}', when the event held nothing unknown — the overwhelmingly common
    -- case, and the one that must cost a row nothing.
    extra TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_principal ON usage_events(principalId);
  CREATE INDEX IF NOT EXISTS idx_usage_events_capability ON usage_events(capabilityId);

  -- One head per node: the tip of each node's chain, maintained in the same transaction as the
  -- write that moved it. It is derivable from usage_events (MAX(seq) per nodeId) and stored
  -- anyway, because the one attack a derived-only chain cannot see is truncation — lop the last
  -- N rows off and what remains verifies perfectly. A head recorded independently is the record
  -- that says how far the chain got, so a table that stops short of its own head is a detected
  -- break rather than a shorter but valid log. It is also exactly what a node publishes upward
  -- once there is a central to publish to (§2.2): one row, not a log.
  CREATE TABLE IF NOT EXISTS usage_chain_heads (
    nodeId TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- The node's shipping queue for the central sink (docs/design/global-identity-and-central-db.md
  -- §2.3). Change capture as an explicit table rather than a trigger or a WAL tail, for the reason
  -- §2.5 gives: this node already owns its write path, so an outbox row written *in the same
  -- transaction as the event* is the one arrangement where an event that committed locally cannot
  -- fail to be queued. A crash between the two is impossible because there is no "between".
  --
  -- Three columns decide the whole design:
  --
  --   seq IS THE SHIPMENT NUMBER, NOT THE EVENT'S CHAIN SEQ. §2.3 asks for idempotent ingest
  --   keyed (nodeId, seq) with ON CONFLICT DO NOTHING, and at-least-once delivery means the only
  --   thing that key has to make idempotent is a *redelivery* — the same bytes arriving twice
  --   because an ack was lost. A correcting PATCH (patchUsageEvent) is not a redelivery: it is a
  --   second, later statement about the same event, and keying it on the event's chain seq would
  --   make central silently drop every correction as a duplicate of the original. So the outbox
  --   carries its own gapless per-node counter, the envelope carries the event's chain seq inside
  --   it as event.seq, and central applies corrections by event id while still deduping
  --   redeliveries by (nodeId, seq). Gapless also means central can see a hole and ask for it.
  --
  --   payload IS A RENDERED SNAPSHOT, not a pointer back into usage_events. A pointer would mean
  --   the bytes shipped are whatever the row says at flush time, so a correction landing in the
  --   5-second window between enqueue and ship would overwrite the original shipment instead of
  --   following it — central would receive the corrected value under the original's shipment
  --   number and never learn a correction happened. It also decouples retention: the local events
  --   table can be pruned on its own schedule without stranding unshipped queue rows.
  --
  --   urgent IS THE TWO-LANE SPLIT. §2.3: everything rides a 5-second timer except the events an
  --   alert exists to catch — a denied outcome, a destructive-tier call, a consent correction —
  --   which flush immediately. Stored on the row rather than recomputed by the shipper because the
  --   capability's risk tier is knowable at write time and may have been edited by flush time; the
  --   lane an event belongs in is a fact about the call, not about the capability's current state.
  --
  -- Rows are deleted on ack. A row that is still here has not been confirmed durable centrally,
  -- which is exactly the at-least-once contract: the cost of a lost ack is a duplicate delivery
  -- that the ingest key throws away, and the cost of deleting early is an event that exists
  -- nowhere.
  CREATE TABLE IF NOT EXISTS usage_outbox (
    nodeId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    eventId TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    enqueuedAt TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastAttemptAt TEXT,
    lastError TEXT,
    PRIMARY KEY (nodeId, seq)
  );
  -- The shipper's only read: oldest first, so the stream central receives is in the order this
  -- node produced it. Urgency decides *when* a flush happens, not what goes in it — a flush ships
  -- the head of the queue regardless of which row triggered it, because sending a later urgent row
  -- ahead of an earlier ordinary one would put a gap in a gapless sequence for no gain.
  CREATE INDEX IF NOT EXISTS idx_usage_outbox_seq ON usage_outbox(nodeId, seq);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Manually configurable discovery sources — replaces the SKILL_DIRS-env-var-only configuration
  -- with something an admin can add/disable/remove from the front end. Two kinds share this table:
  --   - 'skill_dir' (default): a filesystem root scan.js walks for SKILL.md files.
  --   - 'mcp_manifest': a JSON file, same shape as server/discovery/known-mcp-tools.json, that
  --     mcpManifest.js also loads and merges in — lets an admin register MCP tools this checked-in
  --     manifest doesn't know about (e.g. a team's own MCP servers) without editing repo files.
  -- Seeded once from server/config.js's defaults (see the seed block below); rows added after that
  -- are pure user configuration.
  -- Pending-approval queue: the write side of
  -- a destructive grant/revoke a non-admin caller (the governance MCP server's proposer token) can
  -- only *request*, never execute directly. 'payload' carries whatever the eventual insertGrant/
  -- revokeGrant call needs (principalId/capabilityId/constraints/expiresAt for a grant, grantId for
  -- a revoke) as JSON, since the two actions don't share a row shape. 'resultGrantId' records the
  -- grant an approved 'grant' action created, so the approvals list can link straight to it.
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    principalId TEXT,
    capabilityId TEXT,
    payload TEXT NOT NULL,
    requestedByScope TEXT NOT NULL,
    requestedAt TEXT NOT NULL,
    decidedAt TEXT,
    decidedByScope TEXT,
    reason TEXT,
    resultGrantId TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

  CREATE TABLE IF NOT EXISTS discovery_sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    label TEXT,
    kind TEXT NOT NULL DEFAULT 'skill_dir',
    enabled INTEGER NOT NULL DEFAULT 1,
    builtIn INTEGER NOT NULL DEFAULT 0,
    -- Whether server/skills.js may write a new SKILL.md under this row's path. True for every
    -- ordinary skill directory; false for agy's installed-plugins dir (discovery still scans it,
    -- but it holds whole marketplace plugin bundles, not single hand-authored skills) — see
    -- server/config.js's discoverySourceDefaults(). This is the *only* place that distinction is
    -- recorded, so server/skills.js's write-target list (formerly its own hardcoded, hand-kept-in-
    -- sync copy of a subset of these paths) can just filter on this column instead.
    writable INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL
  );

  -- Native harness tool calls — Read, Edit, Bash, Grep, ... — observed, never governed
  -- (docs/design/native-tool-observability.md). Deliberately NOT rows in usage_events, and the
  -- separation is the whole design rather than a filing preference:
  --
  --   usage_events is hash-chained per node and verified by GET /api/usage/verify, and every row
  --   in it is the record of a DECISION THIS SYSTEM MADE — a capability resolved, a grant checked,
  --   an outcome produced synchronously while the caller waited. A native observation is none of
  --   those. It is unenforced, best-effort, arrives late and out of order after a spool drain, and
  --   is droppable at the spool cap. Chaining rows with those properties into the audit log would
  --   weaken the single claim that log exists to make.
  --
  --   It would also swamp it. Native calls outnumber governed ones by one to two orders of
  --   magnitude (measured on this field: 97 Bash + 25 Edit against a handful of MCP calls in ten
  --   minutes), so every drift number, denial rate and usage summary computed off usage_events
  --   would silently change meaning the day this shipped. Two tables keep "what was governed" and
  --   "what happened" as two honest answers instead of one blurred one.
  --
  -- No prevHash/hash columns for the same reason, and no principalId foreign key beyond the
  -- convention every other table here follows. 'id' is derived from the spool line's content
  -- (server/nativeObservations.js) rather than randomly, which is what makes re-draining a batch
  -- left behind by a crash an INSERT OR IGNORE no-op instead of a duplicate.
  CREATE TABLE IF NOT EXISTS native_tool_events (
    id TEXT PRIMARY KEY,
    principalId TEXT NOT NULL,
    toolName TEXT NOT NULL,
    -- The one argument kept, chosen per-tool rather than by stringifying the whole tool input: a
    -- path for file tools, a pattern for Glob/Grep, and for Bash THE PROGRAM NAME ONLY. See
    -- nativeCallDetail in server/hooks/lib.js — a full shell command line routinely carries
    -- tokens and heredoc'd file content, and the rollup replicates this table across workspaces.
    detail TEXT,
    ts TEXT NOT NULL,
    -- 'ok' | 'error' | 'denied'. 'denied' has exactly one producer today: the
    -- isGovernanceSelfCallAttempt block, which is the only native-tool decision this system
    -- enforces and which until now left no audit row anywhere.
    outcome TEXT NOT NULL,
    reason TEXT,
    sessionId TEXT,
    -- The calling agent as a dimension of this call, copied on rather than resolved through
    -- principalId later — same reasoning as the actor* columns on usage_events.
    actorLoomId TEXT,
    -- The loom's display name at call time — "Finn", "Hana" — carried on the event rather than
    -- resolved through principalId later, and for a sharper reason than the other actor* columns.
    -- An instance principal's name column IS its loom id, and humanName is write-once metadata that
    -- is simply NULL on every row registered before it was captured. Joining for the name therefore
    -- produces a list of raw loom ids on exactly the card whose question is "who has been busy".
    -- The hook knows the name for free, off the environment, on every single call.
    actorHumanName TEXT,
    actorAgentType TEXT,
    actorBackend TEXT,
    actorField TEXT,
    osUser TEXT,
    hostname TEXT
  );
  -- ts DESC is the only ordering any reader wants (newest first, windowed), and it is also what
  -- the retention prune scans — so one index serves both the hot read and the recurring delete.
  CREATE INDEX IF NOT EXISTS idx_native_tool_events_ts ON native_tool_events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_native_tool_events_principal ON native_tool_events(principalId, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_native_tool_events_tool ON native_tool_events(toolName, ts DESC);

  -- Node enrollment (docs/design/global-identity-and-central-db.md §2.5). These two tables back
  -- the replacement of the three fleet-wide shared bearer tokens with per-node, enrollment-issued
  -- mTLS client certificates: with one token shared by the whole fleet, any node can forge any
  -- other node's usage events and any user's attribution, and no amount of care in the hot path
  -- fixes that. Everything that mints, signs or presents a certificate lives in
  -- server/enrollment/**; this file only stores what those decisions produced.

  -- The one-time secret that authorises a node to enrol, and nothing else. It is spent by exactly
  -- one enrolment (see consumeEnrollmentToken) and is useless afterwards.
  CREATE TABLE IF NOT EXISTS enrollment_tokens (
    id TEXT PRIMARY KEY,
    -- SHA-256 of the token, NEVER the token. server/data/windrow.db is readable by anything
    -- running as this user, so a plaintext enrolment token sitting in here would hand a
    -- certificate — and with it the ability to sign as any node — to whoever read the file. The
    -- server sees the plaintext once, in the enrolling request, hashes it, and looks the hash up;
    -- there is deliberately no path back from this column to a usable token, which is also why a
    -- lost token can only be reissued, never recovered.
    tokenHash TEXT UNIQUE NOT NULL,
    label TEXT,
    -- What the certificate issued against this token will be allowed to do. Stored on the token
    -- rather than chosen at enrolment time so the authority is fixed by whoever *issued* the
    -- token, not by whoever redeems it.
    scope TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    createdByScope TEXT,
    -- NULL means no expiry. Compared as an ISO-8601 string, which orders correctly because every
    -- timestamp written by this module is UTC from toISOString().
    expiresAt TEXT,
    -- Set together, once, by the enrolment that won the token — see consumeEnrollmentToken, which
    -- is the only writer. usedAt IS NULL is therefore the single-use gate, and usedByNodeId says
    -- which node spent it, so an unexpected enrolment can be traced to the token that allowed it.
    usedAt TEXT,
    usedByNodeId TEXT,
    revokedAt TEXT
  );
  -- "Which tokens are still outstanding" is the list an operator acts on, and the one query that
  -- would otherwise scan. (tokenHash already has a UNIQUE index from its column constraint, which
  -- is what findEnrollmentTokenByHash rides.)
  CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_open ON enrollment_tokens(createdAt DESC)
    WHERE usedAt IS NULL AND revokedAt IS NULL;

  -- The enrolled-node registry: which nodes exist, and which certificate each one presents.
  --
  -- The certificate identity is here for one reason: mTLS has no revocation story short of CRL or
  -- OCSP infrastructure, which is far more machinery than a single-operator fleet warrants. So
  -- revocation is a row in this table instead — every request looks the presented certificate's
  -- serial up here and a revoked node is refused on the spot. That buys §2.4's sub-second
  -- revocation window with no CRL at all, at the cost of putting findNodeByCertSerial on the
  -- request path for every dashboard, MCP and CLI call: hence the index below, and hence its being
  -- a prepared statement rather than an ad-hoc query.
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    -- The same identifier usage_events.nodeId carries and the hash chain is keyed on. That is not
    -- a coincidence to be maintained by hand: the certificate CN and the chain key must be one
    -- value, or a node's audit log and its credential describe two different nodes. See
    -- adoptNodeId() below for the seam that makes an enrolment-minted id become this node's own.
    nodeId TEXT UNIQUE NOT NULL,
    label TEXT,
    scope TEXT,
    enrolledAt TEXT NOT NULL,
    -- Revocation is a state of the node, not a deletion of it: the row stays so that certificates
    -- already in the wild keep resolving to a *refusal* rather than to nothing. A lookup that
    -- found no row and a lookup that found a revoked one must not be the same answer.
    revokedAt TEXT,
    revokedReason TEXT,
    publicKey TEXT,
    -- UNIQUE, not merely indexed: two live nodes sharing a serial means the CA issued a duplicate,
    -- and since the serial is what every request authorises against, that must fail loudly at
    -- registration rather than silently authorise one node as the other. Multiple NULLs are still
    -- allowed (SQLite treats NULLs as distinct), so a node registered before its certificate is
    -- issued is fine.
    certSerial TEXT,
    certFingerprint TEXT,
    certNotAfter TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_certSerial ON nodes(certSerial);
  CREATE INDEX IF NOT EXISTS idx_nodes_active ON nodes(nodeId) WHERE revokedAt IS NULL;

  -- The policy change log — the "monotonic policy_version" of
  -- docs/design/global-identity-and-central-db.md §2.4, and the thing GET /api/policy?since=<v>
  -- serves deltas out of.
  --
  -- INTEGER PRIMARY KEY AUTOINCREMENT, not a plain rowid: AUTOINCREMENT is what promises a version
  -- number is never *reused*. A plain rowid reassigns the highest deleted id, so compacting this
  -- table (see trimPolicyChanges) would rewind the sequence, and a node holding since=900 would
  -- be handed a change numbered 850 that it had already applied — a silent divergence rather than
  -- a visible gap. The whole channel rests on this column only ever going up.
  --
  -- One row per *mutation*, not per row: a grant issued and then revoked leaves two rows, so a node
  -- replaying from any point reaches the same state as one replaying from zero. 'row' is the JSON
  -- snapshot AFTER the change (null only for a hard delete, which policy rows never take — a
  -- revoke is a soft-delete and still carries its row).
  CREATE TABLE IF NOT EXISTS policy_changes (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,   -- 'capability' | 'principal' | 'grant'
    entityId TEXT NOT NULL,
    op TEXT NOT NULL,       -- 'upsert' | 'revoke' | 'delete'
    row TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_policy_changes_entity ON policy_changes(entity, entityId);
`;

const nodeMigrations = [
  {
    version: 1,
    name: 'rename-governance-audit',
    // Tier 2, second half of docs/design/governance-to-windrow-rename.md: `governance_audit` →
    // `windrow_audit`.
    //
    // This runs *before* the baseline below, not after it. The baseline's
    // `CREATE TABLE IF NOT EXISTS windrow_audit` would otherwise win the race on an un-migrated
    // db: it would create an empty table under the new name, and the rename would then find the
    // destination occupied and leave every existing audit row stranded in the old one.
    //
    // `ALTER TABLE … RENAME TO` is schema-only in SQLite — rowids and content are untouched, so
    // the rows survive byte-identical and the append-only trail keeps its history rather than
    // restarting. SQLite carries a table's indexes across a rename but keeps their old *names*, so
    // the two `idx_governance_audit_*` indexes are dropped and recreated against the new name;
    // that is a rebuild of two indexes over one table, not a data migration.
    //
    // Guarded both ways, so it is a no-op on a fresh db that never had the old table. The
    // migrator wraps this in a transaction, so a crash mid-rename leaves the old table with its
    // old indexes and the next boot tries again.
    up: (ctx) => {
      if (!ctx.hasTable('governance_audit') || ctx.hasTable('windrow_audit')) return;
      ctx.exec('ALTER TABLE governance_audit RENAME TO windrow_audit');
      ctx.exec('DROP INDEX IF EXISTS idx_governance_audit_createdAt');
      ctx.exec('DROP INDEX IF EXISTS idx_governance_audit_grantId');
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_windrow_audit_createdAt ON windrow_audit(createdAt)');
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_windrow_audit_grantId ON windrow_audit(grantId)');
    },
  },
  {
    version: 2,
    name: 'baseline',
    // Every table and index in its current shape. `IF NOT EXISTS` throughout, so on a database
    // that predates the ledger this creates only what is genuinely missing and leaves the rest —
    // including any table whose *columns* are behind — for the migrations that follow.
    up: (ctx) => ctx.exec(BASELINE_SQL),
  },
  {
    version: 3,
    name: 'principals-standalone-status-subject-owner',
    // Columns added to `principals` after windrow.db files already existed on disk:
    //   - standalone — docs/design/cross-field-and-standalone.md
    //   - status — an on-disk db predating it gets every existing principal marked 'active'
    //     by the column default, which is correct: they were already provisioned under the old
    //     auto-grant policy, and retroactively pending-ing them out from under running agents
    //     isn't this fix's job.
    //   - subjectId/assuranceLevel (§1.4) — nullable and deliberately *not* back-filled. Every
    //     existing row is a role or an instance, neither of which has a subject: inventing one
    //     from the modal `osUser` of its events would assert an identity nobody verified, on rows
    //     that then look indistinguishable from ones a real OS read produced. A subject row
    //     appears the first time a hook resolves with one.
    //   - owner* — the owner is never inferred at write time, only proposed at read time, so a row
    //     that has never been decided lands 'unassigned' with nulls.
    up: (ctx) => {
      ctx.addColumn('principals', 'standalone', 'INTEGER NOT NULL DEFAULT 0');
      ctx.addColumn('principals', 'status', "TEXT NOT NULL DEFAULT 'active'");
      ctx.addColumn('principals', 'subjectId', 'TEXT');
      ctx.addColumn('principals', 'assuranceLevel', 'INTEGER');
      ctx.addColumn('principals', 'ownerStatus', "TEXT NOT NULL DEFAULT 'unassigned'");
      ctx.addColumn('principals', 'ownerOsUser', 'TEXT');
      ctx.addColumn('principals', 'ownerPrincipalId', 'TEXT');
      ctx.addColumn('principals', 'ownerConfirmedAt', 'TEXT');
      ctx.addColumn('principals', 'ownerConfirmedBy', 'TEXT');
      // One principal per subject. Partial (subjectId IS NOT NULL) so the role/instance rows that
      // have no subject don't contend for the index at all — SQLite treats NULLs as distinct in a
      // UNIQUE index anyway, but saying so is what keeps that from reading as an accident. Created
      // here rather than in the baseline because an old db only gains the column directly above.
      ctx.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_subjectId ON principals(subjectId) WHERE subjectId IS NOT NULL'
      );
    },
  },
  {
    version: 4,
    name: 'capabilities-autoGrant',
    // Default 0 means every pre-existing row starts *not* auto-granted, i.e. the
    // AUTO_GRANT_OWNERS bypass this replaces simply goes away for it until something explicitly
    // opts it back in via PATCH /api/capabilities/:id/auto-grant (destructive rows can never opt
    // in).
    up: (ctx) => ctx.addColumn('capabilities', 'autoGrant', 'INTEGER NOT NULL DEFAULT 0'),
  },
  {
    version: 5,
    name: 'grants-soft-delete',
    // Soft-delete support for grants — an on-disk db created before this change has the old
    // inline UNIQUE(principalId, capabilityId) constraint baked into its schema (see the baseline's
    // CREATE TABLE comment); ALTER TABLE can add columns but can't drop a table-level constraint,
    // so an old grants table is rebuilt from scratch. A db whose grants table came from the
    // baseline never had the inline constraint, so the rebuild is skipped for it.
    up: (ctx) => {
      if (!ctx.hasColumn('grants', 'revokedAt')) {
        ctx.exec(`
          CREATE TABLE grants_new (
            id TEXT PRIMARY KEY,
            principalId TEXT NOT NULL,
            capabilityId TEXT NOT NULL,
            constraints TEXT,
            createdAt TEXT NOT NULL,
            expiresAt TEXT,
            revokedAt TEXT,
            revokedBy TEXT
          );
          INSERT INTO grants_new (id, principalId, capabilityId, constraints, createdAt, expiresAt)
            SELECT id, principalId, capabilityId, constraints, createdAt, expiresAt FROM grants;
          DROP TABLE grants;
          ALTER TABLE grants_new RENAME TO grants;
        `);
      }
      // Partial unique index — active (revokedAt IS NULL) grants only, so a principal+capability
      // pair stays race-safe for concurrent issues while a revoked-then-re-granted pair can hold
      // multiple historical rows. Here rather than in the baseline because it references
      // revokedAt, which an old db only gains via the rebuild directly above.
      ctx.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active_principal_capability ON grants(principalId, capabilityId) WHERE revokedAt IS NULL'
      );
    },
  },
  {
    version: 6,
    name: 'usage-events-latency-columns',
    // docs/design/latency-breakdown.md — added to usage_events after some windrow.db files already
    // existed on disk. Not part of the canonical form, so no re-chain.
    up: (ctx) => {
      for (const col of ['capabilityLookupMs', 'principalResolveMs', 'brokerMs', 'grantCheckMs']) {
        ctx.addColumn('usage_events', col, 'INTEGER');
      }
    },
  },
  {
    version: 7,
    name: 'usage-events-actor-and-subject',
    // osUser/hostname, and the actor* columns (the calling agent as a dimension of the call, rather
    // than a join through the mutable principals row). Deliberately *not* back-filled: the whole
    // point of these columns is that they record what was observed at call time, and a value
    // reconstructed later from a row that has since changed is not that.
    //
    // Every column here is part of `canonicalizeUsageEvent`, so adding one to a db whose chain was
    // already built changes what its rows hash to — hence the `needsRechain` signal, consumed by
    // server/store.js once the hashing helpers exist.
    up: (ctx) => {
      let added = false;
      for (const col of ['osUser', 'hostname', 'actorLoomId', 'actorAgentType', 'actorBackend', 'actorField', 'subjectId']) {
        if (ctx.addColumn('usage_events', col, 'TEXT')) added = true;
      }
      if (ctx.addColumn('usage_events', 'assuranceLevel', 'INTEGER')) added = true;
      if (added) ctx.signal('usageEventsNeedsRechain');
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_actorLoom ON usage_events(actorLoomId)');
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_subject ON usage_events(subjectId)');
    },
  },
  {
    version: 8,
    name: 'usage-events-shadow-evaluation',
    // Phase 3-4 of §1.8: what the decision *would* have been under the subject-keyed model, written
    // beside the decision that was actually applied. Also canonical-form columns → re-chain.
    up: (ctx) => {
      let added = false;
      for (const col of ['shadowOutcome', 'shadowReason', 'shadowPrincipalId']) {
        if (ctx.addColumn('usage_events', col, 'TEXT')) added = true;
      }
      if (added) ctx.signal('usageEventsNeedsRechain');
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_shadowOutcome ON usage_events(shadowOutcome)');
    },
  },
  {
    version: 9,
    name: 'native-tool-events-actorHumanName',
    // docs/design/native-tool-observability.md. Guarded on the table existing at all only in the
    // sense that the baseline creates it first; by this point it always does.
    up: (ctx) => ctx.addColumn('native_tool_events', 'actorHumanName', 'TEXT'),
  },
  {
    version: 10,
    name: 'usage-events-hash-chain',
    // The append-only hash chain. A db that just gained these columns has every existing row's
    // prevHash/hash still NULL, so the chain has to be *built* rather than re-chained — a different
    // signal from the one above, and store.js consumes them differently.
    up: (ctx) => {
      let added = false;
      for (const col of ['correctedAt', 'prevHash', 'hash']) {
        if (ctx.addColumn('usage_events', col, 'TEXT')) added = true;
      }
      if (added) ctx.signal('usageEventsNeedsHashBackfill');
    },
  },
  {
    version: 11,
    name: 'usage-events-node-coordinates',
    // Phase 1 of §2.7: the chain is keyed `(nodeId, seq)` rather than on rowid, and `observedAt`
    // records when the row was seen locally so central can measure clock skew against `ts`.
    up: (ctx) => {
      let added = false;
      for (const [col, type] of [['nodeId', 'TEXT'], ['seq', 'INTEGER'], ['observedAt', 'TEXT']]) {
        if (ctx.addColumn('usage_events', col, type)) added = true;
      }
      if (added) ctx.signal('usageEventsNeedsRechain');
      // Unique, not just indexed: (nodeId, seq) is the merge key server/rollup/index.js dedupes on
      // and the coordinate the chain is walked in, so two rows claiming the same slot is a corrupt
      // chain, not a query that returns one of them.
      ctx.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_node_seq ON usage_events(nodeId, seq)');
    },
  },
  {
    version: 12,
    name: 'discovery-sources-kind-writable',
    // `kind` (custom MCP discovery sources) — the column default ('skill_dir') makes every
    // pre-existing row (all filesystem roots) come out correctly typed with no data migration.
    // `writable` — default 1 makes every pre-existing row (including a human-added agy-plugins row
    // from before this column existed) come out writable, since nothing recorded the distinction
    // before now; the boot-time backfill in server/store.js corrects the one built-in row that
    // should actually be non-writable.
    up: (ctx) => {
      ctx.addColumn('discovery_sources', 'kind', "TEXT NOT NULL DEFAULT 'skill_dir'");
      ctx.addColumn('discovery_sources', 'writable', 'INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    version: 13,
    name: 'capabilities-unique-kind-name',
    // Resolution used to be
    // "whichever row SELECT * happens to return first" for a duplicate (kind, name) pair, so a
    // registration race decided which capability a hook call actually resolved to. Dedupe any
    // pre-existing duplicates first (keep the oldest row by rowid, drop the rest — grants/usage
    // events reference capability *id*, so this can strand a grant issued against a since-dropped
    // duplicate, but that's the same "orphaned by an id that no longer resolves" case
    // findCapabilityById already returns null for) before adding the constraint, since CREATE
    // UNIQUE INDEX fails outright on an existing db that already has a duplicate pair. kind can be
    // NULL — SQLite treats each NULL as distinct in a UNIQUE index, so multiple NULL-kind rows
    // sharing a name still aren't caught by this; that gap is pre-existing and out of scope here
    // (kind is required for hook lookup anyway).
    up: (ctx) =>
      ctx.exec(`
        DELETE FROM capabilities WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM capabilities GROUP BY kind, name
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_kind_name ON capabilities(kind, name);
      `),
  },
  {
    version: 14,
    name: 'capabilities-owner-governance-to-windrow',
    // Tier 3 of docs/design/governance-to-windrow-rename.md: the MCP server key moved
    // `governance` → `windrow` in .mcp.json, and server/discovery/known-mcp-tools.json moved with
    // it. Package membership in packages.js is matched by *owner string*, so the eleven lookup
    // tools have to carry the new owner or they silently drop out of the 'windrow' integration
    // package and stop being granted. This is an UPDATE, never a re-discovery: grants key on the
    // opaque `cap_…` id and the usage_events hash chain covers capabilityId, so renaming the owner
    // in place leaves both intact — re-seeding under the new owner would mint fresh ids and orphan
    // every grant.
    //
    // Capability *names* need no migration here: normalizeToolCall (hooks/lib.js) strips the
    // `mcp__<server>__` prefix before lookup, so these rows are stored under bare tool names
    // (`list_capabilities`, …) and are already independent of which server key exposes them. The
    // design doc's `mcp__governance__%` name rewrite describes rows that were never created.
    up: (ctx) => ctx.exec("UPDATE capabilities SET owner = 'windrow' WHERE owner = 'governance'"),
  },
  {
    version: 15,
    name: 'usage-events-skew-tolerant-ingest',
    // §2.6's first rule, adopted while there are still zero nodes: "an unknown field on an event is
    // stored, never rejected; a missing field is null, never fatal." Two changes, one per half.
    //
    //   `extra`      where a field this build has no column for is kept (server/ingest/usageEvent.js).
    //   NOT NULL off principalId/capabilityId/ts/outcome/latencyMs, so "the sending build did not
    //                have this" has an honest representation. With them NOT NULL, an ingest meeting
    //                an unfamiliar build has to either reject the event or invent a value, and the
    //                invented one is worse: 'unknown' and 0 read at query time exactly like a real
    //                outcome and a real latency, so a fleet-wide skew shows up as healthy traffic.
    //
    // The relax is a table rebuild, since SQLite has no DROP NOT NULL. It is written off
    // PRAGMA table_info rather than off a copied-out CREATE TABLE so it cannot drift from the
    // baseline as columns are added: it reproduces whatever columns are actually there, in order,
    // with their types and defaults, and only the NOT NULL flags gone. A fresh database created
    // from BASELINE_SQL already has none, so `needsRelax` is false there and this is a no-op —
    // which is the property that keeps `npm run smoke:schema` (legacy db must reach a shape
    // identical to a fresh one) meaningful rather than trivially satisfied.
    up: (ctx) => {
      const added = ctx.addColumn('usage_events', 'extra', 'TEXT');
      // `extra` joins canonicalizeUsageEvent, so every existing row's canonical form changes and
      // the whole chain has to be recomputed — the same signal migration 11 raises, handled by the
      // re-chain in server/store.js that first checks the chain was intact under the OLD form.
      if (added) ctx.signal('usageEventsNeedsRechain');

      const cols = ctx.all('PRAGMA table_info(usage_events)');
      // `id TEXT PRIMARY KEY` reports notnull=0 in SQLite (a rowid table's TEXT primary key is
      // nullable by a documented legacy quirk), so this asks about exactly the five real NOT NULLs
      // and nothing else — and a fresh database answers no.
      if (!cols.some((c) => c.notnull)) return;

      const names = cols.map((c) => c.name);
      const defs = cols.map((c) => {
        const pk = c.pk ? ' PRIMARY KEY' : '';
        const dflt = c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : '';
        return `${c.name} ${c.type}${pk}${dflt}`;
      });
      const list = names.join(', ');
      ctx.exec(`CREATE TABLE usage_events_relaxed (${defs.join(', ')})`);
      // Column names on both sides, never `INSERT INTO … SELECT *`: the two tables agree here by
      // construction, but a positional copy of an audit table is the kind of statement that keeps
      // working after someone changes one side of it.
      ctx.exec(`INSERT INTO usage_events_relaxed (${list}) SELECT ${list} FROM usage_events`);
      ctx.exec('DROP TABLE usage_events');
      ctx.exec('ALTER TABLE usage_events_relaxed RENAME TO usage_events');
      // DROP TABLE took the indexes with it. All seven are restated here rather than left to the
      // earlier migrations that created them, because those have already run and will not run
      // again — the ledger is what makes a migration once-only, and it does not know this one
      // undid their work.
      ctx.exec(`
        CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_events_principal ON usage_events(principalId);
        CREATE INDEX IF NOT EXISTS idx_usage_events_capability ON usage_events(capabilityId);
        CREATE INDEX IF NOT EXISTS idx_usage_events_actorLoom ON usage_events(actorLoomId);
        CREATE INDEX IF NOT EXISTS idx_usage_events_subject ON usage_events(subjectId);
        CREATE INDEX IF NOT EXISTS idx_usage_events_shadowOutcome ON usage_events(shadowOutcome);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_node_seq ON usage_events(nodeId, seq);
      `);
    },
  },
  {
    version: 16,
    name: 'principals-unique-kind-name',
    // §2.1 of docs/design/global-identity-and-central-db.md: "the only natural-key collisions are
    // capabilities(kind, name) and principals(kind, name), both of which need a real UNIQUE
    // constraint". Migration 13 did the capabilities half; this is the principals half. Without it
    // `findPrincipalByKindName` is a bare `SELECT * ... WHERE kind = ? AND name = ?` with no ORDER
    // BY, so which row a hook resolves through — and therefore which row's grants govern the call
    // — is whichever one the scan reaches first. Two hook processes racing the same first tool
    // call can both miss in `upsertPrincipalIdentityTx` and both insert.
    //
    // **Partial: `kind <> 'user'`, and that is not a hedge.** A `user` row's key is `subjectId`
    // (already UNIQUE, migration 3); its `name` is explicitly a mutable display label (§1.4), the
    // one kind `PATCH /api/principals/:id/name` will rename. Two *distinct* subjects sharing a
    // label is normal rather than exceptional: a run that fails to read the SID falls back to
    // `env-user:<osUser>` and lands on its own row beside the `win-sid:` one, both seeded with the
    // same OS username as their label. A full UNIQUE(kind, name) would reject that second row —
    // failing the resolve that the fallback exists to keep working — and would 500 an admin
    // renaming two people to the same label. `role` and `instance` are the kinds whose `name` *is*
    // the lookup key (agentType, loomId), which is exactly the pair this constraint is for.
    //
    // Dedupe first, since CREATE UNIQUE INDEX fails outright on a db that already holds a
    // duplicate pair. Keep MIN(rowid) — the oldest row, which is the one an unordered scan already
    // returns today, so this preserves whatever the database currently resolves to rather than
    // picking a new winner. Grants and usage_events reference principal *id*, so dropping the
    // losers can strand a grant issued against one; that is the same fail-closed outcome
    // findPrincipalById already returns null for, and it is the safe direction — re-pointing those
    // grants onto the survivor would hand it the *union* of two rows' access, which is a widening
    // no admin authorized.
    up: (ctx) =>
      ctx.exec(`
        DELETE FROM principals WHERE kind <> 'user' AND rowid NOT IN (
          SELECT MIN(rowid) FROM principals WHERE kind <> 'user' GROUP BY kind, name
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_principals_kind_name
          ON principals(kind, name) WHERE kind <> 'user';
      `),
  },
  {
    version: 17,
    name: 'alerts — node-local rule fires, deduped on the §2.3 key',
    // docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both ends": the node
    // half. `server/alerts/nodeEngine.js` evaluates rules here so that "this user just ran 40
    // destructive calls" is caught on a PC that cannot reach central at all — which is the case
    // that makes a node-local engine necessary rather than merely faster, because while the WAN is
    // down central has not received one of the events the rule counts.
    //
    // `key` IS THE PRIMARY KEY, AND IT IS THE SAME STRING CENTRAL USES. §2.3: "dedupe on a stable
    // alert key (ruleId, subjectId, window) so a breach seen from both sides fires once." The
    // components are stored as their own columns too — they are what every query filters on, and
    // re-splitting the key string to answer "what has fired for this subject today" would be
    // parsing a value that a UNIQUE constraint already promised was well-formed. The key is built
    // by `alertKey()` in server/alerts/rules.js, on both ends, and nowhere else.
    //
    // The dedup is a PRIMARY KEY rather than a check-then-insert because both writers are
    // concurrent with each other in the ways that matter: on this side, the event-triggered
    // evaluation and the sweep timer can overlap, and an INSERT OR IGNORE is the only form where
    // "did this already fire" and "record that it fired" cannot interleave.
    //
    // WHY A NODE STORES ALERTS AT ALL, RATHER THAN JUST POSTING THEM. Two reasons, and the first
    // is the whole point of the local engine: a partitioned node has nowhere to post to, so the
    // table IS the queue — `syncedAt` null means central has not confirmed it, and the shipper
    // retries from here. The second is that the retry is free to be sloppy: central's copy has the
    // same primary key, so a redelivery is an ON CONFLICT DO NOTHING and at-least-once costs
    // nothing. Rows are kept after sync (unlike usage_outbox, which deletes on ack) because an
    // alert is evidence, not a shipment — `GET /api/alerts` on the node answers from it, and a
    // node that discarded its own alerts on ack could not tell an operator what it had caught.
    //
    // `firedBy` is always 'node' in rows this node writes. It exists so the column means the same
    // thing here as it does centrally, where rows arrive from both ends and the question "did the
    // node catch this, or did we only learn of it when the events arrived" has two answers.
    up: (ctx) =>
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          key TEXT PRIMARY KEY,
          ruleId TEXT NOT NULL,
          scope TEXT NOT NULL,
          -- The nodeId for a node-scoped rule, the literal 'fleet' for a fleet-scoped one. See the
          -- header of server/alerts/rules.js for why §2.3's three-part key grows this fourth part:
          -- the same subject bursting on two PCs is two incidents, and keyed on the three columns
          -- alone the second would be swallowed as a duplicate of the first.
          scopeId TEXT NOT NULL,
          subjectId TEXT NOT NULL,
          -- Both ends of the window, as ISO instants. windowStart is the key component; windowEnd
          -- is stored rather than derived because the rule's windowMs is code and will be edited,
          -- and an alert whose window can no longer be reconstructed is an alert nobody can check.
          windowStart TEXT NOT NULL,
          windowEnd TEXT NOT NULL,
          windowMs INTEGER NOT NULL,
          metric TEXT NOT NULL,
          threshold REAL NOT NULL,
          value REAL NOT NULL,
          severity TEXT NOT NULL,
          title TEXT,
          firedBy TEXT NOT NULL,
          nodeId TEXT,
          firedAt TEXT NOT NULL,
          -- When central acknowledged it. NULL means this alert exists only on this machine, which
          -- on a partitioned node is the normal state and is exactly what the shipper looks for.
          syncedAt TEXT,
          syncAttempts INTEGER NOT NULL DEFAULT 0,
          syncError TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_firedAt ON alerts(firedAt DESC);
        -- The cooldown lookup: "has (rule, scope, subject) fired recently". Overlapping hopping
        -- windows mean one continuing breach satisfies several consecutive window keys, all of
        -- them distinct, so this index is read once per candidate breach and is the difference
        -- between one alert and one per stride.
        CREATE INDEX IF NOT EXISTS idx_alerts_cooldown ON alerts(ruleId, scopeId, subjectId, firedAt DESC);
        -- The shipper's only read: unsynced, oldest first.
        CREATE INDEX IF NOT EXISTS idx_alerts_unsynced ON alerts(firedAt) WHERE syncedAt IS NULL;
      `),
  },
];

module.exports = { nodeMigrations, BASELINE_SQL };
