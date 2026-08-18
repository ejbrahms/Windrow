'use strict';
// SQLite-backed store — replaces the old load-whole-file/mutate/save-whole-file JSON store
// (server/data/db.json), which had no real atomicity: two concurrent requests could both read a
// stale snapshot, both decide it was safe to write, and the second `fs.writeFileSync` would
// silently clobber the first (lost grants) or, worse, two writers racing on the same file could
// interleave and corrupt it. See docs/design/api-contract.md.
//
// Two APIs are exposed:
//   - Atomic per-row operations (listCapabilities/insertGrant/revokeGrant/...) — used by the
//     Express hot path in app.js. Each one is a single SQL statement, so it's atomic on its own;
//     `grants` additionally has a partial UNIQUE index on (principalId, capabilityId) scoped to
//     active (non-revoked) rows, which is what actually closes the self-grant race (see
//     insertGrant below) while still letting a revoked pair be re-granted.
//   - A coarse `load()`/`save(snapshot)` pair, kept for the batch/offline call sites (seed.js,
//     discovery's merge pass, principal registry upsert) whose logic mutates a whole in-memory
//     snapshot at once. `save()` replaces every table's contents inside one SQLite transaction,
//     so even this coarse path is all-or-nothing — a crash or a concurrent reader can never
//     observe a half-written table, unlike the old `fs.writeFileSync`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { genId } = require('./id');
const { discoverySourceDefaults } = require('./config');

const DB_PATH = process.env.GOVERNANCE_DB_PATH || path.join(__dirname, 'data', 'governance.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// synchronous=NORMAL is the pairing SQLite's own docs recommend with WAL: a commit no longer
// fsyncs the WAL file before returning, only before a checkpoint. WAL still makes the db
// crash-safe (a mid-write app crash rolls back cleanly on reopen); the only thing this trades
// away is that the last handful of commits could be lost on an actual OS-level power loss —
// an acceptable cost for an audit log, and the fsync-per-write was the dominant cost on the
// /api/invoke hot path (every hook call blocks on a usage-event insert before it gets its
// allow/deny decision back — see docs/design/latency-breakdown.md).
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    -- Per-capability replacement for the old AUTO_GRANT_OWNERS owner-string bypass
    -- (docs/design/governance-review-2026-08-16.md, F5): a capability with autoGrant=1 is treated
    -- as always-granted by findActiveGrant (app.js) without a real grant row. Never true for a
    -- 'destructive' row — enforced at every write site (app.js's POST/PATCH handlers), not just here.
    autoGrant INTEGER NOT NULL DEFAULT 0
  );


  -- status (docs/design/governance-review-2026-08-16.md, F7): a role principal minted by first
  -- sighting (server/principals/registry.js's upsertRole, run from the hook path on every
  -- unrecognized agentType) used to be granted every read_only capability in the same breath it
  -- was created — no human ever looked at it. 'pending' principals hold zero grants (direct or,
  -- since a pending role has none to fall back to, inherited) until an admin approves them via
  -- POST /api/principals/:id/approve, which is the only place the read-only baseline is applied
  -- now. Principals created through the admin-only POST /api/principals route, and every instance
  -- (which never held direct grants of its own anyway), still default to 'active'.
  CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    parentRole TEXT,
    humanName TEXT,
    backend TEXT,
    agentType TEXT,
    field TEXT,
    standalone INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  );

  -- Soft-delete (docs/design/governance-review-2026-08-16.md, F4): a revoked grant stays in this
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

  -- Append-only control-plane audit trail (F4): every grant issue/revoke writes one row here.
  -- 'before'/'after' are JSON snapshots of the affected grant (null on the side that doesn't
  -- apply — no 'before' for an issue, no 'after' for a revoke) so "what changed" survives even
  -- though the grants row itself only ever shows current state. No UPDATE/DELETE statement is
  -- prepared against this table anywhere in this file — that's what "append-only" means here.
  CREATE TABLE IF NOT EXISTS governance_audit (
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
  CREATE INDEX IF NOT EXISTS idx_governance_audit_createdAt ON governance_audit(createdAt);
  CREATE INDEX IF NOT EXISTS idx_governance_audit_grantId ON governance_audit(grantId);

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    principalId TEXT NOT NULL,
    capabilityId TEXT NOT NULL,
    ts TEXT NOT NULL,
    outcome TEXT NOT NULL,
    latencyMs INTEGER NOT NULL,
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
    -- Set once, the first (and only) time PATCH /api/usage/:id successfully corrects this row
    -- (server/app.js) — a non-null value both marks the one-shot correction as spent (a second
    -- PATCH is rejected) and is part of what gets hashed below, so flipping it back to NULL to
    -- unlock a second correction changes the row's hash and breaks the chain.
    correctedAt TEXT,
    -- Hash-chain (docs/design/governance-vulnerability-review.md follow-up "agent token can
    -- rewrite audit log via PATCH"): hash is sha256(prevHash + canonical(row)), prevHash is the
    -- immediately-preceding row's hash in rowid order. Any edit made outside this module — a
    -- direct DB write, or a restored backup with rows spliced out — changes a row's canonical
    -- form without recomputing the chain, so it desyncs hash from prevHash on that row and every
    -- row after it; verifyChain() below walks the table and reports exactly where. This doesn't
    -- stop a write with database file access (no cryptographic scheme run by the same process
    -- that holds the signing key can), but it turns silent, undetectable tampering into a
    -- detectable break.
    prevHash TEXT,
    hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
  CREATE INDEX IF NOT EXISTS idx_usage_events_principal ON usage_events(principalId);
  CREATE INDEX IF NOT EXISTS idx_usage_events_capability ON usage_events(capabilityId);

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
  -- Pending-approval queue (docs/design/governance-review-2026-08-16.md, F1/F3): the write side of
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
`);

// Migration for governance.db files created before the cross-field/standalone-tracking work
// (docs/design/cross-field-and-standalone.md) — CREATE TABLE IF NOT EXISTS above doesn't add a
// column to a table that already exists, so an existing on-disk db needs an explicit ALTER TABLE.
// Guarded so it's a no-op (and safe to re-run) once the column is present.
{
  const principalCols = db.prepare('PRAGMA table_info(principals)').all().map((c) => c.name);
  if (!principalCols.includes('standalone')) {
    db.exec('ALTER TABLE principals ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0');
  }
  // status (F7) — an on-disk db predating it gets every existing principal marked 'active' by the
  // column default, which is correct: they were already provisioned under the old auto-grant
  // policy, and retroactively pending-ing them out from under running agents isn't this fix's job.
  if (!principalCols.includes('status')) {
    db.exec("ALTER TABLE principals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
}

// Same idea for `capabilities.autoGrant` (F5) — an existing db predates the column, so a fresh
// ALTER is needed; default 0 means every pre-existing row starts *not* auto-granted, i.e. the
// AUTO_GRANT_OWNERS bypass this replaces simply goes away for it until something explicitly opts
// it back in via PATCH /api/capabilities/:id/auto-grant (destructive rows can never opt in).
{
  const capabilityCols = db.prepare('PRAGMA table_info(capabilities)').all().map((c) => c.name);
  if (!capabilityCols.includes('autoGrant')) {
    db.exec('ALTER TABLE capabilities ADD COLUMN autoGrant INTEGER NOT NULL DEFAULT 0');
  }
}

// Soft-delete support for grants (F4) — an on-disk db created before this change has the old
// inline UNIQUE(principalId, capabilityId) constraint baked into its schema (see the CREATE TABLE
// comment above); ALTER TABLE can add columns but can't drop a table-level constraint, so an old
// grants table is rebuilt from scratch here. A fresh db created after this change never had the
// inline constraint, so this block is a no-op for it (CREATE TABLE above already has the column).
{
  const grantCols = db.prepare('PRAGMA table_info(grants)').all().map((c) => c.name);
  if (!grantCols.includes('revokedAt')) {
    db.exec(`
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
}
// Partial unique index — active (revokedAt IS NULL) grants only, so a principal+capability pair
// stays race-safe for concurrent issues while a revoked-then-re-granted pair can hold multiple
// historical rows. Created here rather than in the top exec block because it references
// revokedAt, which an old db only gains via the rebuild directly above.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_active_principal_capability ON grants(principalId, capabilityId) WHERE revokedAt IS NULL;'
);

// Set inside the migration block below if this run just added the hash-chain columns to a
// pre-existing db; consumed once, after the hashing helpers are defined further down this file,
// to backfill every pre-existing row so the chain starts unbroken instead of reading as tampered.
let usageEventsNeedsHashBackfill = false;

// Same idea for the latency-breakdown columns (docs/design/latency-breakdown.md) added to
// usage_events after some governance.db files already existed on disk.
{
  const usageEventCols = db.prepare('PRAGMA table_info(usage_events)').all().map((c) => c.name);
  for (const col of ['capabilityLookupMs', 'principalResolveMs', 'brokerMs', 'grantCheckMs']) {
    if (!usageEventCols.includes(col)) {
      db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} INTEGER`);
    }
  }
  // osUser/hostname (this change) — same guarded-ALTER pattern, TEXT rather than INTEGER.
  for (const col of ['osUser', 'hostname']) {
    if (!usageEventCols.includes(col)) {
      db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} TEXT`);
    }
  }
  // correctedAt/prevHash/hash (this change) — same guarded-ALTER pattern. A db that predates the
  // hash chain has every existing row backfilled with a hash below (once, after the table exists)
  // so the chain starts unbroken instead of every pre-existing row reading as "tampered".
  for (const col of ['correctedAt', 'prevHash', 'hash']) {
    if (!usageEventCols.includes(col)) {
      db.exec(`ALTER TABLE usage_events ADD COLUMN ${col} TEXT`);
      usageEventsNeedsHashBackfill = true;
    }
  }
}

// Same idea for `discovery_sources.kind` (custom MCP discovery sources) added after some
// governance.db files already existed — the column default ('skill_dir') makes every pre-existing
// row (all filesystem roots) come out correctly typed with no data migration needed.
{
  const discoverySourceCols = db.prepare('PRAGMA table_info(discovery_sources)').all().map((c) => c.name);
  if (!discoverySourceCols.includes('kind')) {
    db.exec("ALTER TABLE discovery_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill_dir'");
  }
  // Same idea for `writable` (this change) — default 1 makes every pre-existing row (including a
  // human-added agy-plugins row from before this column existed) come out writable, since nothing
  // recorded the distinction before now; the backfill block below corrects the one built-in row
  // that should actually be non-writable.
  if (!discoverySourceCols.includes('writable')) {
    db.exec('ALTER TABLE discovery_sources ADD COLUMN writable INTEGER NOT NULL DEFAULT 1');
  }
}

// Finding #10 (docs/design/governance-vulnerability-review.md): resolution used to be "whichever
// row SELECT * happens to return first" for a duplicate (kind, name) pair, so a registration race
// decided which capability a hook call actually resolved to. Dedupe any pre-existing duplicates
// first (keep the oldest row by rowid, drop the rest — grants/usage events reference capability
// *id*, so this can strand a grant issued against a since-dropped duplicate, but that's the same
// "orphaned by an id that no longer resolves" case findCapabilityById already returns null for)
// before adding the constraint, since CREATE UNIQUE INDEX fails outright on an existing db that
// already has a duplicate pair. kind can be NULL — SQLite treats each NULL as distinct in a
// UNIQUE index, so multiple NULL-kind rows sharing a name still aren't caught by this; that gap is
// pre-existing and out of scope here (kind is required for hook lookup anyway).
db.exec(`
  DELETE FROM capabilities WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM capabilities GROUP BY kind, name
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_capabilities_kind_name ON capabilities(kind, name);
`);

// Seed discovery_sources once, from server/config.js's discoverySourceDefaults() (which itself
// honors SKILL_DIRS), so an unconfigured server scans exactly what it always has. Guarded on the
// table being empty — after this first run, the table is the source of truth and config.js's
// defaults are never consulted again, so a row a human deletes here stays deleted across restarts.
{
  const existingSourceCount = db.prepare('SELECT COUNT(*) AS n FROM discovery_sources').get().n;
  if (existingSourceCount === 0) {
    const seedStmt = db.prepare(`INSERT INTO discovery_sources (id, path, label, enabled, builtIn, writable, createdAt)
      VALUES (@id, @path, @label, 1, 1, @writable, @createdAt)`);
    const now = new Date().toISOString();
    const seedTx = db.transaction((defaults) => {
      for (const d of defaults) {
        seedStmt.run({ id: genId('src'), path: d.path, label: d.label, writable: d.writable ? 1 : 0, createdAt: now });
      }
    });
    seedTx(discoverySourceDefaults());
  }
}

// Backfill the agy (Antigravity) default directories added to discoverySourceDefaults() after the
// seed above may already have run on this db — the "seed once, table's the source of truth after"
// guard means an existing db never picks up a *new* default entry on its own. Scoped to just the
// three agy entries (not "any default missing from the table") so it can't ever resurrect a path a
// human deliberately removed; INSERT OR IGNORE makes it a no-op on a db that's already seen them,
// including one where a human has since deleted or re-added one by hand.
{
  const agyDefaults = discoverySourceDefaults().filter((d) => d.label && d.label.startsWith('Antigravity'));
  const insertIfMissing = db.prepare(`INSERT OR IGNORE INTO discovery_sources (id, path, label, enabled, builtIn, writable, createdAt)
    VALUES (@id, @path, @label, 1, 1, @writable, @createdAt)`);
  const now = new Date().toISOString();
  const backfillTx = db.transaction((defaults) => {
    for (const d of defaults) {
      insertIfMissing.run({ id: genId('src'), path: d.path, label: d.label, writable: d.writable ? 1 : 0, createdAt: now });
    }
  });
  backfillTx(agyDefaults);
}

// Backfill `writable` for a pre-existing row that predates the column (default 1 above made it
// writable) but matches a default entry that's actually non-writable — currently just agy's
// installed-plugins dir. Path-matched, not id-matched, since the row's id was generated at seed
// time and carries no reference back to which default it came from.
{
  const nonWritableDefaults = discoverySourceDefaults().filter((d) => d.writable === false);
  if (nonWritableDefaults.length > 0) {
    const markNonWritable = db.prepare('UPDATE discovery_sources SET writable = 0 WHERE path = ? AND writable = 1');
    for (const d of nonWritableDefaults) markNonWritable.run(d.path);
  }
}

// Backfill friendly labels for pre-existing rows seeded before discoverySourceDefaults() carried
// labels at all (this db predates that field, so every row it seeded has label = NULL) — matched
// by exact path against a known default, not restricted to builtIn=1, since a row can legitimately
// hold a default path with builtIn=0 (e.g. re-added by hand through the Sources page after the
// original built-in row was deleted) and still be the same provider directory. Scoped to
// label IS NULL only, so it never overwrites a label a human actually set.
{
  const labeledDefaults = discoverySourceDefaults().filter((d) => d.label);
  if (labeledDefaults.length > 0) {
    const fillLabel = db.prepare('UPDATE discovery_sources SET label = ? WHERE path = ? AND label IS NULL');
    for (const d of labeledDefaults) fillLabel.run(d.label, d.path);
  }
}

// ---------------------------------------------------------------------------
// Row <-> JS object mapping (SQLite has no boolean or nested-object column type)
// ---------------------------------------------------------------------------

function capOut(row) {
  if (!row) return null;
  return { ...row, stale: !!row.stale, autoGrant: !!row.autoGrant, realUsage: row.realUsage ? JSON.parse(row.realUsage) : null };
}
function capIn(c) {
  return {
    id: c.id,
    kind: c.kind ?? null,
    name: c.name,
    owner: c.owner ?? null,
    riskTier: c.riskTier,
    description: c.description ?? null,
    source: c.source ?? null,
    discoveredAt: c.discoveredAt ?? null,
    lastSeenAt: c.lastSeenAt ?? null,
    stale: c.stale ? 1 : 0,
    autoGrant: c.autoGrant ? 1 : 0,
    realUsage: c.realUsage != null ? JSON.stringify(c.realUsage) : null,
  };
}
function principalIn(p) {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    parentRole: p.parentRole ?? null,
    humanName: p.humanName ?? null,
    backend: p.backend ?? null,
    agentType: p.agentType ?? null,
    field: p.field ?? null,
    standalone: p.standalone ? 1 : 0,
    status: p.status || 'active',
  };
}
function principalOut(row) {
  if (!row) return null;
  return { ...row, standalone: !!row.standalone };
}
function discoverySourceOut(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, builtIn: !!row.builtIn, writable: !!row.writable };
}
function approvalOut(row) {
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}
function auditOut(row) {
  if (!row) return null;
  return { ...row, before: row.before ? JSON.parse(row.before) : null, after: row.after ? JSON.parse(row.after) : null };
}

// ---------------------------------------------------------------------------
// usage_events hash chain
// ---------------------------------------------------------------------------

// Every field that's actually part of the audit record — deliberately excludes prevHash/hash
// themselves (a row can't hash itself) so this is stable to call before either is known.
function canonicalizeUsageEvent(e) {
  return JSON.stringify({
    id: e.id,
    principalId: e.principalId,
    capabilityId: e.capabilityId,
    ts: e.ts,
    outcome: e.outcome,
    latencyMs: e.latencyMs,
    correlationId: e.correlationId ?? null,
    reason: e.reason ?? null,
    capabilityLookupMs: e.capabilityLookupMs ?? null,
    principalResolveMs: e.principalResolveMs ?? null,
    brokerMs: e.brokerMs ?? null,
    grantCheckMs: e.grantCheckMs ?? null,
    osUser: e.osUser ?? null,
    hostname: e.hostname ?? null,
    correctedAt: e.correctedAt ?? null,
  });
}
function hashUsageEvent(prevHash, e) {
  return crypto.createHash('sha256').update(`${prevHash || ''}|${canonicalizeUsageEvent(e)}`).digest('hex');
}

/**
 * Recomputes hash/prevHash for row `fromRowid` and every row after it, in rowid (insertion)
 * order. Needed both for a fresh insert (chain of one new tail row) and for a correcting PATCH
 * (the corrected row's content changed, so its own hash — and every hash chained after it —
 * has to be redone; a PATCH lands inside the correction window, which keeps how many rows that
 * touches small in practice). Run inside the caller's transaction where one already wraps the
 * write, so a crash mid-chain can't leave hash/prevHash desynced from the row it describes.
 */
function rechainFrom(fromRowid) {
  const prevRow = db.prepare('SELECT hash FROM usage_events WHERE rowid = ?').get(fromRowid - 1);
  let prevHash = prevRow ? prevRow.hash : null;
  const rows = db.prepare('SELECT rowid, * FROM usage_events WHERE rowid >= ? ORDER BY rowid ASC').all(fromRowid);
  const setHash = db.prepare('UPDATE usage_events SET prevHash = ?, hash = ? WHERE rowid = ?');
  for (const row of rows) {
    const hash = hashUsageEvent(prevHash, row);
    setHash.run(prevHash, hash, row.rowid);
    prevHash = hash;
  }
}

/**
 * Walks the whole chain and reports the first row (if any) whose stored hash doesn't match what
 * its content + prevHash actually hash to — that's either a direct edit that bypassed
 * insertUsageEvent/patchUsageEvent, or rows deleted/reordered out from under the chain. Not on
 * any hot path; for admin diagnostics (GET /api/usage/verify).
 */
function verifyUsageEventChain() {
  const rows = db.prepare('SELECT rowid, * FROM usage_events ORDER BY rowid ASC').all();
  let prevHash = null;
  for (const row of rows) {
    const expected = hashUsageEvent(prevHash, row);
    if (row.hash !== expected || (row.prevHash || null) !== (prevHash || null)) {
      return { ok: false, brokenAt: row.id, rowid: row.rowid };
    }
    prevHash = row.hash;
  }
  return { ok: true, checked: rows.length };
}

// A db that just had the hash-chain columns added (usageEventsNeedsHashBackfill, set by the
// migration block above) has every existing row's prevHash/hash still NULL — chain the whole
// table once now so it starts unbroken instead of every pre-existing row reading as tampered on
// the first verifyUsageEventChain() call.
if (usageEventsNeedsHashBackfill) {
  const first = db.prepare('SELECT MIN(rowid) AS rowid FROM usage_events').get();
  if (first && first.rowid != null) rechainFrom(first.rowid);
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmts = {
  listCapabilities: db.prepare('SELECT * FROM capabilities'),
  insertCapability: db.prepare(`INSERT INTO capabilities
    (id, kind, name, owner, riskTier, description, source, discoveredAt, lastSeenAt, stale, autoGrant, realUsage)
    VALUES (@id, @kind, @name, @owner, @riskTier, @description, @source, @discoveredAt, @lastSeenAt, @stale, @autoGrant, @realUsage)`),
  findCapabilityById: db.prepare('SELECT * FROM capabilities WHERE id = ?'),
  updateCapabilityAutoGrant: db.prepare('UPDATE capabilities SET autoGrant = @autoGrant WHERE id = @id'),

  listPrincipals: db.prepare('SELECT * FROM principals'),
  insertPrincipal: db.prepare(`INSERT INTO principals (id, kind, name, parentRole, humanName, backend, agentType, field, standalone, status)
    VALUES (@id, @kind, @name, @parentRole, @humanName, @backend, @agentType, @field, @standalone, @status)`),
  findPrincipalById: db.prepare('SELECT * FROM principals WHERE id = ?'),
  findPrincipalByKindName: db.prepare('SELECT * FROM principals WHERE kind = ? AND name = ?'),
  updatePrincipalStatus: db.prepare('UPDATE principals SET status = @status WHERE id = @id'),

  // Active-only (revokedAt IS NULL) — a revoked grant stays in the table for history but shouldn't
  // show up as a currently-held grant. listAllGrants below is the includeRevoked escape hatch.
  listGrants: db.prepare('SELECT * FROM grants WHERE revokedAt IS NULL ORDER BY createdAt DESC'),
  listGrantsByPrincipal: db.prepare('SELECT * FROM grants WHERE principalId = ? AND revokedAt IS NULL ORDER BY createdAt DESC'),
  listGrantsByCapability: db.prepare('SELECT * FROM grants WHERE capabilityId = ? AND revokedAt IS NULL ORDER BY createdAt DESC'),
  listGrantsByBoth: db.prepare('SELECT * FROM grants WHERE principalId = ? AND capabilityId = ? AND revokedAt IS NULL ORDER BY createdAt DESC'),
  listAllGrants: db.prepare('SELECT * FROM grants ORDER BY createdAt DESC'),
  findGrant: db.prepare('SELECT * FROM grants WHERE principalId = ? AND capabilityId = ? AND revokedAt IS NULL'),
  findGrantById: db.prepare('SELECT * FROM grants WHERE id = ?'),
  insertGrant: db.prepare(`INSERT INTO grants (id, principalId, capabilityId, constraints, createdAt, expiresAt, revokedAt, revokedBy)
    VALUES (@id, @principalId, @capabilityId, @constraints, @createdAt, @expiresAt, @revokedAt, @revokedBy)`),
  revokeGrant: db.prepare('UPDATE grants SET revokedAt = @revokedAt, revokedBy = @revokedBy WHERE id = @id AND revokedAt IS NULL'),

  insertAuditEntry: db.prepare(`INSERT INTO governance_audit
    (id, action, actorScope, osUser, hostname, principalId, capabilityId, grantId, before, after, reason, createdAt)
    VALUES (@id, @action, @actorScope, @osUser, @hostname, @principalId, @capabilityId, @grantId, @before, @after, @reason, @createdAt)`),
  listAuditEntries: db.prepare('SELECT * FROM governance_audit ORDER BY createdAt DESC'),
  listAuditEntriesByGrant: db.prepare('SELECT * FROM governance_audit WHERE grantId = ? ORDER BY createdAt DESC'),

  listUsageEvents: db.prepare('SELECT * FROM usage_events ORDER BY ts DESC'),
  insertUsageEvent: db.prepare(`INSERT INTO usage_events
    (id, principalId, capabilityId, ts, outcome, latencyMs, correlationId, reason,
     capabilityLookupMs, principalResolveMs, brokerMs, grantCheckMs, osUser, hostname)
    VALUES (@id, @principalId, @capabilityId, @ts, @outcome, @latencyMs, @correlationId, @reason,
     @capabilityLookupMs, @principalResolveMs, @brokerMs, @grantCheckMs, @osUser, @hostname)`),
  findUsageEvent: db.prepare('SELECT * FROM usage_events WHERE id = ?'),
  findUsageEventRowid: db.prepare('SELECT rowid FROM usage_events WHERE id = ?'),
  lastUsageEventRowid: db.prepare('SELECT MAX(rowid) AS rowid FROM usage_events'),
  updateUsageEvent: db.prepare(
    `UPDATE usage_events SET outcome = @outcome, latencyMs = @latencyMs, reason = @reason,
     capabilityLookupMs = @capabilityLookupMs, principalResolveMs = @principalResolveMs,
     brokerMs = @brokerMs, grantCheckMs = @grantCheckMs, correctedAt = @correctedAt WHERE id = @id`
  ),

  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  listApprovals: db.prepare('SELECT * FROM approvals ORDER BY requestedAt DESC'),
  listApprovalsByStatus: db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requestedAt DESC'),
  findApprovalById: db.prepare('SELECT * FROM approvals WHERE id = ?'),
  insertApproval: db.prepare(`INSERT INTO approvals
    (id, action, status, principalId, capabilityId, payload, requestedByScope, requestedAt)
    VALUES (@id, @action, 'pending', @principalId, @capabilityId, @payload, @requestedByScope, @requestedAt)`),
  decideApproval: db.prepare(`UPDATE approvals SET
    status = @status, decidedAt = @decidedAt, decidedByScope = @decidedByScope, reason = @reason, resultGrantId = @resultGrantId
    WHERE id = @id`),

  listDiscoverySources: db.prepare('SELECT * FROM discovery_sources ORDER BY createdAt ASC'),
  listEnabledDiscoverySourcesByKind: db.prepare('SELECT * FROM discovery_sources WHERE enabled = 1 AND kind = ? ORDER BY createdAt ASC'),
  listSkillWriteTargets: db.prepare(
    "SELECT * FROM discovery_sources WHERE enabled = 1 AND kind = 'skill_dir' AND writable = 1 AND label IS NOT NULL AND label != '' ORDER BY createdAt ASC",
  ),
  findDiscoverySourceById: db.prepare('SELECT * FROM discovery_sources WHERE id = ?'),
  insertDiscoverySource: db.prepare(`INSERT INTO discovery_sources (id, path, label, kind, enabled, builtIn, writable, createdAt)
    VALUES (@id, @path, @label, @kind, @enabled, @builtIn, @writable, @createdAt)`),
  updateDiscoverySource: db.prepare('UPDATE discovery_sources SET path = @path, label = @label, enabled = @enabled WHERE id = @id'),
  deleteDiscoverySource: db.prepare('DELETE FROM discovery_sources WHERE id = ?'),

  deleteAllCapabilities: db.prepare('DELETE FROM capabilities'),
  deleteAllPrincipals: db.prepare('DELETE FROM principals'),
  deleteAllGrants: db.prepare('DELETE FROM grants'),
  deleteAllUsageEvents: db.prepare('DELETE FROM usage_events'),
};

// ---------------------------------------------------------------------------
// Atomic per-row API — the HTTP hot path (app.js) uses this directly
// ---------------------------------------------------------------------------

class GrantConflictError extends Error {}
class CapabilityConflictError extends Error {}

function listCapabilities() {
  return stmts.listCapabilities.all().map(capOut);
}
/** Throws CapabilityConflictError (mapped to 409 by the caller) if this (kind, name) pair is already registered. */
function insertCapability(cap) {
  try {
    stmts.insertCapability.run(capIn(cap));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new CapabilityConflictError('a capability with this kind+name already exists');
    }
    throw err;
  }
  return cap;
}
function findCapabilityById(id) {
  return capOut(stmts.findCapabilityById.get(id));
}
/** Callers must check riskTier !== 'destructive' before setting autoGrant true — this layer just
 * persists whatever it's told (app.js's PATCH /api/capabilities/:id/auto-grant is the one gate). */
function setCapabilityAutoGrant(id, autoGrant) {
  stmts.updateCapabilityAutoGrant.run({ id, autoGrant: autoGrant ? 1 : 0 });
  return findCapabilityById(id);
}

function listPrincipals() {
  return stmts.listPrincipals.all().map(principalOut);
}
function insertPrincipal(p) {
  stmts.insertPrincipal.run(principalIn(p));
  return p;
}
function findPrincipalById(id) {
  return principalOut(stmts.findPrincipalById.get(id));
}
function findPrincipalByKindName(kind, name) {
  return principalOut(stmts.findPrincipalByKindName.get(kind, name));
}
/** status: 'pending' | 'active' | 'denied' (F7). Callers check the row exists first — this just
 * flips it and returns the updated row. */
function setPrincipalStatus(id, status) {
  stmts.updatePrincipalStatus.run({ id, status });
  return findPrincipalById(id);
}

/** includeRevoked: also return soft-deleted grants (history) — off by default, since callers
 * almost always mean "what's currently granted." */
function listGrants({ principalId, capabilityId, includeRevoked = false } = {}) {
  if (includeRevoked) return stmts.listAllGrants.all();
  if (principalId && capabilityId) return stmts.listGrantsByBoth.all(principalId, capabilityId);
  if (principalId) return stmts.listGrantsByPrincipal.all(principalId);
  if (capabilityId) return stmts.listGrantsByCapability.all(capabilityId);
  return stmts.listGrants.all();
}
function findGrant(principalId, capabilityId) {
  return stmts.findGrant.get(principalId, capabilityId) || null;
}
function findGrantById(id) {
  return stmts.findGrantById.get(id) || null;
}
/** Throws GrantConflictError (mapped to 409 by the caller) if this principal+capability pair is already granted. */
function insertGrant(grant) {
  try {
    stmts.insertGrant.run({
      ...grant,
      constraints: grant.constraints ?? null,
      expiresAt: grant.expiresAt ?? null,
      revokedAt: grant.revokedAt ?? null,
      revokedBy: grant.revokedBy ?? null,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new GrantConflictError('a grant for this principal+capability already exists');
    }
    throw err;
  }
  return grant;
}
/**
 * Soft-delete (F4): marks the grant revoked instead of removing the row, so it stays around for
 * history/audit. Returns the updated grant, or null if the id doesn't exist or was already
 * revoked (the UPDATE's `WHERE revokedAt IS NULL` makes a double-revoke a no-op, not an error).
 */
function revokeGrant(id, revokedBy) {
  const revokedAt = new Date().toISOString();
  const changed = stmts.revokeGrant.run({ id, revokedAt, revokedBy: revokedBy ?? null }).changes > 0;
  return changed ? findGrantById(id) : null;
}

function listUsageEvents() {
  return stmts.listUsageEvents.all();
}
const insertUsageEventTx = db.transaction((row) => {
  stmts.insertUsageEvent.run(row);
  rechainFrom(stmts.lastUsageEventRowid.get().rowid);
});
function insertUsageEvent(event) {
  insertUsageEventTx({
    ...event,
    correlationId: event.correlationId ?? null,
    reason: event.reason ?? null,
    capabilityLookupMs: event.capabilityLookupMs ?? null,
    principalResolveMs: event.principalResolveMs ?? null,
    brokerMs: event.brokerMs ?? null,
    grantCheckMs: event.grantCheckMs ?? null,
    osUser: event.osUser ?? null,
    hostname: event.hostname ?? null,
  });
  return findUsageEvent(event.id);
}
function findUsageEvent(id) {
  return stmts.findUsageEvent.get(id) || null;
}
const patchUsageEventTx = db.transaction((id, updated) => {
  stmts.updateUsageEvent.run(updated);
  rechainFrom(stmts.findUsageEventRowid.get(id).rowid);
});
/**
 * The only mutator of an already-inserted row. Callers (server/app.js's PATCH /api/usage/:id) are
 * responsible for the authorization checks — caller's own principal, correction window, one-way
 * outcome transition — before calling this; it enforces none of that itself, only rechains the
 * hash after the write so the chain always reflects current content.
 */
function patchUsageEvent(id, patch) {
  const existing = findUsageEvent(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, correctedAt: patch.correctedAt ?? existing.correctedAt ?? null };
  patchUsageEventTx(id, updated);
  return findUsageEvent(id);
}

function getDiscovery() {
  const row = stmts.getKv.get('discovery');
  return row ? JSON.parse(row.value) : null;
}
function setDiscovery(value) {
  stmts.setKv.run('discovery', JSON.stringify(value));
  return value;
}

// Which capability packages (server/packages.js) are turned on for this workspace — a plain
// {packageId: boolean} map, same kv-row pattern as `discovery` above. Packages themselves are
// defined in code (a deliberate policy, not user data); this is the one piece of state a workspace
// actually owns: not every workspace uses every integration.
// Persisted state for server/hookWatcher.js's tamper-check/self-heal poller: which adapters have
// ever been successfully installed (so a provider nobody turned on isn't force-installed) and a
// capped log of tamper/repair events for the dashboard. Same kv table/pattern as
// getDiscovery/getPackagesState above — no schema migration needed for a poller this small.
function getHookIntegrity() {
  const row = stmts.getKv.get('hook_integrity');
  return row ? JSON.parse(row.value) : { everInstalled: {}, log: [] };
}
function setHookIntegrity(value) {
  stmts.setKv.run('hook_integrity', JSON.stringify(value));
  return value;
}

// ---------------------------------------------------------------------------
// Pending-approval queue (F1/F3, see the approvals table comment above)
// ---------------------------------------------------------------------------

function listApprovals({ status } = {}) {
  const rows = status ? stmts.listApprovalsByStatus.all(status) : stmts.listApprovals.all();
  return rows.map(approvalOut);
}
function findApprovalById(id) {
  return approvalOut(stmts.findApprovalById.get(id));
}
/** action: 'grant' | 'revoke'. payload is whatever the eventual insertGrant/revokeGrant call needs. */
function insertApproval({ id, action, principalId, capabilityId, payload, requestedByScope, requestedAt }) {
  stmts.insertApproval.run({
    id,
    action,
    principalId: principalId ?? null,
    capabilityId: capabilityId ?? null,
    payload: JSON.stringify(payload),
    requestedByScope,
    requestedAt,
  });
  return findApprovalById(id);
}
/** status: 'approved' | 'denied'. Only flips a 'pending' row — callers check that themselves (app.js) so they can 409 with a clearer message than "0 rows changed". */
function decideApproval(id, { status, decidedByScope, reason, resultGrantId }) {
  stmts.decideApproval.run({
    id,
    status,
    decidedAt: new Date().toISOString(),
    decidedByScope,
    reason: reason ?? null,
    resultGrantId: resultGrantId ?? null,
  });
  return findApprovalById(id);
}

// ---------------------------------------------------------------------------
// Governance audit trail (F4, see the governance_audit table comment above) — append-only: every
// grant issue/revoke writes one row via insertAuditEntry; nothing in this file ever updates or
// deletes one.
// ---------------------------------------------------------------------------

/** action: 'grant_issue' | 'grant_revoke'. before/after are grant snapshots (plain objects), not JSON strings. */
function insertAuditEntry({ action, actorScope, osUser, hostname, principalId, capabilityId, grantId, before, after, reason }) {
  const row = {
    id: genId('aud'),
    action,
    actorScope,
    osUser: osUser ?? null,
    hostname: hostname ?? null,
    principalId: principalId ?? null,
    capabilityId: capabilityId ?? null,
    grantId: grantId ?? null,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  };
  stmts.insertAuditEntry.run(row);
  return auditOut(row);
}
function listAuditEntries({ grantId } = {}) {
  const rows = grantId ? stmts.listAuditEntriesByGrant.all(grantId) : stmts.listAuditEntries.all();
  return rows.map(auditOut);
}

function getPackagesState() {
  const row = stmts.getKv.get('packages_enabled');
  return row ? JSON.parse(row.value) : null;
}
function setPackagesState(value) {
  stmts.setKv.run('packages_enabled', JSON.stringify(value));
  return value;
}

class DiscoverySourceConflictError extends Error {}

function listDiscoverySources() {
  return stmts.listDiscoverySources.all().map(discoverySourceOut);
}
/** Filesystem roots scan.js walks for SKILL.md files — kind 'skill_dir', the historical default. */
function listEnabledDiscoverySourcePaths() {
  return stmts.listEnabledDiscoverySourcesByKind.all('skill_dir').map((row) => row.path);
}
/**
 * The full rows (id, path, label, ...) server/skills.js writes new SKILL.md files into — every
 * enabled 'skill_dir' source, excluding the ones marked non-writable (agy's installed-plugins
 * bundle dir) and, importantly, excluding any row with no label. An unlabeled row is either a raw
 * ad-hoc directory an admin added on the Sources page without naming it, or a stale leftover from
 * before this table carried labels at all (e.g. seeded under a since-changed home/repo path) — the
 * Skills page is meant to show "which provider do you want this skill written to", not a wall of
 * raw filesystem paths, so a source only becomes a write target once it has a name. This and
 * listEnabledDiscoverySourcePaths() above still read the same table, so a source an admin
 * adds/edits/disables/labels on the Sources page is automatically both what discovery scans *and*
 * (once labeled) what the Skills page offers to write into — one list, not two kept in sync by hand.
 */
function listSkillWriteTargets() {
  return stmts.listSkillWriteTargets.all().map(discoverySourceOut);
}
/** JSON manifest files mcpManifest.js merges in alongside the built-in known-mcp-tools.json. */
function listEnabledMcpManifestPaths() {
  return stmts.listEnabledDiscoverySourcesByKind.all('mcp_manifest').map((row) => row.path);
}
function findDiscoverySourceById(id) {
  return discoverySourceOut(stmts.findDiscoverySourceById.get(id));
}
/** Throws DiscoverySourceConflictError (mapped to 409 by the caller) if this path is already configured. */
function insertDiscoverySource(source) {
  const row = {
    id: source.id,
    path: source.path,
    label: source.label ?? null,
    kind: source.kind === 'mcp_manifest' ? 'mcp_manifest' : 'skill_dir',
    enabled: source.enabled === false ? 0 : 1,
    builtIn: source.builtIn ? 1 : 0,
    // Every source an admin adds by hand is writable by default — only the built-in seed/backfill
    // paths above can mark one non-writable (there's no UI control for it, since the only
    // non-writable case today, agy's plugin-bundle dir, is a known built-in, not something an
    // admin would hand-add as a skill directory).
    writable: source.writable === false ? 0 : 1,
    createdAt: source.createdAt,
  };
  try {
    stmts.insertDiscoverySource.run(row);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new DiscoverySourceConflictError('a discovery source for this path already exists');
    }
    throw err;
  }
  return findDiscoverySourceById(source.id);
}
function updateDiscoverySource(id, patch) {
  const existing = stmts.findDiscoverySourceById.get(id);
  if (!existing) return null;
  const merged = {
    id,
    path: patch.path !== undefined ? patch.path : existing.path,
    label: patch.label !== undefined ? patch.label : existing.label,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
  };
  try {
    stmts.updateDiscoverySource.run(merged);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new DiscoverySourceConflictError('a discovery source for this path already exists');
    }
    throw err;
  }
  return findDiscoverySourceById(id);
}
function deleteDiscoverySource(id) {
  return stmts.deleteDiscoverySource.run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Coarse snapshot compatibility layer — seed.js, discovery run-cli, principals resolve-cli, and
// the discovery merge pass (server/discovery/merge.js) all mutate a whole `{capabilities,
// principals, grants, usageEvents, discovery}` object in memory the way the old JSON store did.
// ---------------------------------------------------------------------------

function load() {
  return {
    capabilities: listCapabilities(),
    principals: listPrincipals(),
    // includeRevoked: a snapshot backup/restore round-trip has to preserve revoked grants too, or
    // save() below (which wipes and reinserts the whole table) would quietly erase revoke history
    // every time one of these batch call sites (seed.js, discovery merge, ...) runs.
    grants: listGrants({ includeRevoked: true }),
    usageEvents: listUsageEvents(),
    discovery: getDiscovery(),
  };
}

const replaceAll = db.transaction((snapshot) => {
  stmts.deleteAllGrants.run(); // first: grants have no FK enforcement but logically depend on the other two
  stmts.deleteAllCapabilities.run();
  stmts.deleteAllPrincipals.run();
  stmts.deleteAllUsageEvents.run();
  for (const cap of snapshot.capabilities || []) stmts.insertCapability.run(capIn(cap));
  for (const p of snapshot.principals || []) stmts.insertPrincipal.run(principalIn(p));
  for (const g of snapshot.grants || []) {
    stmts.insertGrant.run({
      ...g,
      constraints: g.constraints ?? null,
      expiresAt: g.expiresAt ?? null,
      revokedAt: g.revokedAt ?? null,
      revokedBy: g.revokedBy ?? null,
    });
  }
  for (const e of snapshot.usageEvents || []) {
    stmts.insertUsageEvent.run({
      ...e,
      correlationId: e.correlationId ?? null,
      reason: e.reason ?? null,
      capabilityLookupMs: e.capabilityLookupMs ?? null,
      principalResolveMs: e.principalResolveMs ?? null,
      brokerMs: e.brokerMs ?? null,
      grantCheckMs: e.grantCheckMs ?? null,
      osUser: e.osUser ?? null,
      hostname: e.hostname ?? null,
    });
  }
  if (snapshot.discovery !== undefined) setDiscovery(snapshot.discovery);
});

/** Replaces every table's contents in one transaction — all-or-nothing, unlike a raw file write. */
function save(snapshot) {
  replaceAll(snapshot);
}

module.exports = {
  DB_PATH,
  GrantConflictError,
  CapabilityConflictError,
  DiscoverySourceConflictError,

  listCapabilities,
  insertCapability,
  findCapabilityById,
  setCapabilityAutoGrant,
  listPrincipals,
  insertPrincipal,
  findPrincipalById,
  findPrincipalByKindName,
  setPrincipalStatus,
  listGrants,
  findGrant,
  findGrantById,
  insertGrant,
  revokeGrant,
  insertAuditEntry,
  listAuditEntries,
  listUsageEvents,
  insertUsageEvent,
  findUsageEvent,
  patchUsageEvent,
  verifyUsageEventChain,
  getDiscovery,
  setDiscovery,
  getPackagesState,
  setPackagesState,
  getHookIntegrity,
  setHookIntegrity,
  listApprovals,
  findApprovalById,
  insertApproval,
  decideApproval,

  listDiscoverySources,
  listEnabledDiscoverySourcePaths,
  listSkillWriteTargets,
  listEnabledMcpManifestPaths,
  findDiscoverySourceById,
  insertDiscoverySource,
  updateDiscoverySource,
  deleteDiscoverySource,

  load,
  save,
};
