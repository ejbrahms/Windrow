'use strict';
// SQLite-backed store — replaces the old load-whole-file/mutate/save-whole-file JSON store
// (server/data/db.json), which had no real atomicity: two concurrent requests could both read a
// stale snapshot, both decide it was safe to write, and the second `fs.writeFileSync` would
// silently clobber the first (lost grants) or, worse, two writers racing on the same file could
// interleave and corrupt it. See docs/design/api-contract.md.
//
// Two APIs are exposed:
//   - Atomic per-row operations (listCapabilities/insertGrant/deleteGrant/...) — used by the
//     Express hot path in app.js. Each one is a single SQL statement, so it's atomic on its own;
//     `grants` additionally has a UNIQUE(principalId, capabilityId) constraint, which is what
//     actually closes the self-grant race (see insertGrant below).
//   - A coarse `load()`/`save(snapshot)` pair, kept for the batch/offline call sites (seed.js,
//     discovery's merge pass, principal registry upsert) whose logic mutates a whole in-memory
//     snapshot at once. `save()` replaces every table's contents inside one SQLite transaction,
//     so even this coarse path is all-or-nothing — a crash or a concurrent reader can never
//     observe a half-written table, unlike the old `fs.writeFileSync`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { genId } = require('./id');
const { discoveryPaths, REPO_ROOT } = require('./config');

const DB_PATH = process.env.GOVERNANCE_DB_PATH || path.join(__dirname, 'data', 'governance.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
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
    realUsage TEXT
  );

  CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    parentRole TEXT,
    humanName TEXT,
    backend TEXT,
    agentType TEXT,
    field TEXT,
    standalone INTEGER NOT NULL DEFAULT 0
  );

  -- UNIQUE(principalId, capabilityId) is the actual fix for "anything can self-grant twice" /
  -- lost-write races: two concurrent POST /api/grants for the same pair can no longer both
  -- succeed off a stale read — the loser gets a real SQLITE_CONSTRAINT error (mapped to 409).
  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    principalId TEXT NOT NULL,
    capabilityId TEXT NOT NULL,
    constraints TEXT,
    createdAt TEXT NOT NULL,
    expiresAt TEXT,
    UNIQUE(principalId, capabilityId)
  );

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
    hostname TEXT
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
  CREATE TABLE IF NOT EXISTS discovery_sources (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    label TEXT,
    kind TEXT NOT NULL DEFAULT 'skill_dir',
    enabled INTEGER NOT NULL DEFAULT 1,
    builtIn INTEGER NOT NULL DEFAULT 0,
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
}

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
}

// Same idea for `discovery_sources.kind` (custom MCP discovery sources) added after some
// governance.db files already existed — the column default ('skill_dir') makes every pre-existing
// row (all filesystem roots) come out correctly typed with no data migration needed.
{
  const discoverySourceCols = db.prepare('PRAGMA table_info(discovery_sources)').all().map((c) => c.name);
  if (!discoverySourceCols.includes('kind')) {
    db.exec("ALTER TABLE discovery_sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill_dir'");
  }
}

// Seed discovery_sources once, from server/config.js's discoveryPaths() defaults (which itself
// honors SKILL_DIRS), so an unconfigured server scans exactly what it always has. Guarded on the
// table being empty — after this first run, the table is the source of truth and config.js's
// defaults are never consulted again, so a row a human deletes here stays deleted across restarts.
{
  const existingSourceCount = db.prepare('SELECT COUNT(*) AS n FROM discovery_sources').get().n;
  if (existingSourceCount === 0) {
    const seedStmt = db.prepare(`INSERT INTO discovery_sources (id, path, label, enabled, builtIn, createdAt)
      VALUES (@id, @path, @label, 1, 1, @createdAt)`);
    const now = new Date().toISOString();
    const seedTx = db.transaction((paths) => {
      for (const p of paths) {
        seedStmt.run({ id: genId('src'), path: p, label: null, createdAt: now });
      }
    });
    seedTx(discoveryPaths());
  }
}

// Backfill the agy (Antigravity) default directories added to discoveryPaths() after the seed
// above may already have run on this db — the "seed once, table's the source of truth after"
// guard means an existing db never picks up a *new* default path on its own. Scoped to just these
// three paths (not "any path in discoveryPaths() missing from the table") so it can't ever
// resurrect a path a human deliberately removed; INSERT OR IGNORE makes it a no-op on a db that's
// already seen them, including one where a human has since deleted or re-added one by hand.
{
  const agyDefaults = [
    path.join(REPO_ROOT, '.agents', 'skills'),
    path.join(os.homedir(), '.gemini', 'config', 'skills'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'plugins'),
  ];
  const insertIfMissing = db.prepare(`INSERT OR IGNORE INTO discovery_sources (id, path, label, enabled, builtIn, createdAt)
    VALUES (@id, @path, NULL, 1, 1, @createdAt)`);
  const now = new Date().toISOString();
  const backfillTx = db.transaction((paths) => {
    for (const p of paths) {
      insertIfMissing.run({ id: genId('src'), path: p, createdAt: now });
    }
  });
  backfillTx(agyDefaults);
}

// ---------------------------------------------------------------------------
// Row <-> JS object mapping (SQLite has no boolean or nested-object column type)
// ---------------------------------------------------------------------------

function capOut(row) {
  if (!row) return null;
  return { ...row, stale: !!row.stale, realUsage: row.realUsage ? JSON.parse(row.realUsage) : null };
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
  };
}
function principalOut(row) {
  if (!row) return null;
  return { ...row, standalone: !!row.standalone };
}
function discoverySourceOut(row) {
  if (!row) return null;
  return { ...row, enabled: !!row.enabled, builtIn: !!row.builtIn };
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmts = {
  listCapabilities: db.prepare('SELECT * FROM capabilities'),
  insertCapability: db.prepare(`INSERT INTO capabilities
    (id, kind, name, owner, riskTier, description, source, discoveredAt, lastSeenAt, stale, realUsage)
    VALUES (@id, @kind, @name, @owner, @riskTier, @description, @source, @discoveredAt, @lastSeenAt, @stale, @realUsage)`),
  findCapabilityById: db.prepare('SELECT * FROM capabilities WHERE id = ?'),

  listPrincipals: db.prepare('SELECT * FROM principals'),
  insertPrincipal: db.prepare(`INSERT INTO principals (id, kind, name, parentRole, humanName, backend, agentType, field, standalone)
    VALUES (@id, @kind, @name, @parentRole, @humanName, @backend, @agentType, @field, @standalone)`),
  findPrincipalById: db.prepare('SELECT * FROM principals WHERE id = ?'),
  findPrincipalByKindName: db.prepare('SELECT * FROM principals WHERE kind = ? AND name = ?'),

  listGrants: db.prepare('SELECT * FROM grants ORDER BY createdAt DESC'),
  listGrantsByPrincipal: db.prepare('SELECT * FROM grants WHERE principalId = ? ORDER BY createdAt DESC'),
  listGrantsByCapability: db.prepare('SELECT * FROM grants WHERE capabilityId = ? ORDER BY createdAt DESC'),
  listGrantsByBoth: db.prepare('SELECT * FROM grants WHERE principalId = ? AND capabilityId = ? ORDER BY createdAt DESC'),
  findGrant: db.prepare('SELECT * FROM grants WHERE principalId = ? AND capabilityId = ?'),
  insertGrant: db.prepare(`INSERT INTO grants (id, principalId, capabilityId, constraints, createdAt, expiresAt)
    VALUES (@id, @principalId, @capabilityId, @constraints, @createdAt, @expiresAt)`),
  deleteGrant: db.prepare('DELETE FROM grants WHERE id = ?'),

  listUsageEvents: db.prepare('SELECT * FROM usage_events ORDER BY ts DESC'),
  insertUsageEvent: db.prepare(`INSERT INTO usage_events
    (id, principalId, capabilityId, ts, outcome, latencyMs, correlationId, reason,
     capabilityLookupMs, principalResolveMs, brokerMs, grantCheckMs, osUser, hostname)
    VALUES (@id, @principalId, @capabilityId, @ts, @outcome, @latencyMs, @correlationId, @reason,
     @capabilityLookupMs, @principalResolveMs, @brokerMs, @grantCheckMs, @osUser, @hostname)`),
  findUsageEvent: db.prepare('SELECT * FROM usage_events WHERE id = ?'),
  updateUsageEvent: db.prepare(
    `UPDATE usage_events SET outcome = @outcome, latencyMs = @latencyMs, reason = @reason,
     capabilityLookupMs = @capabilityLookupMs, principalResolveMs = @principalResolveMs,
     brokerMs = @brokerMs, grantCheckMs = @grantCheckMs WHERE id = @id`
  ),

  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  listDiscoverySources: db.prepare('SELECT * FROM discovery_sources ORDER BY createdAt ASC'),
  listEnabledDiscoverySourcesByKind: db.prepare('SELECT * FROM discovery_sources WHERE enabled = 1 AND kind = ? ORDER BY createdAt ASC'),
  findDiscoverySourceById: db.prepare('SELECT * FROM discovery_sources WHERE id = ?'),
  insertDiscoverySource: db.prepare(`INSERT INTO discovery_sources (id, path, label, kind, enabled, builtIn, createdAt)
    VALUES (@id, @path, @label, @kind, @enabled, @builtIn, @createdAt)`),
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

function listCapabilities() {
  return stmts.listCapabilities.all().map(capOut);
}
function insertCapability(cap) {
  stmts.insertCapability.run(capIn(cap));
  return cap;
}
function findCapabilityById(id) {
  return capOut(stmts.findCapabilityById.get(id));
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

function listGrants({ principalId, capabilityId } = {}) {
  if (principalId && capabilityId) return stmts.listGrantsByBoth.all(principalId, capabilityId);
  if (principalId) return stmts.listGrantsByPrincipal.all(principalId);
  if (capabilityId) return stmts.listGrantsByCapability.all(capabilityId);
  return stmts.listGrants.all();
}
function findGrant(principalId, capabilityId) {
  return stmts.findGrant.get(principalId, capabilityId) || null;
}
/** Throws GrantConflictError (mapped to 409 by the caller) if this principal+capability pair is already granted. */
function insertGrant(grant) {
  try {
    stmts.insertGrant.run({ ...grant, constraints: grant.constraints ?? null, expiresAt: grant.expiresAt ?? null });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new GrantConflictError('a grant for this principal+capability already exists');
    }
    throw err;
  }
  return grant;
}
function deleteGrant(id) {
  return stmts.deleteGrant.run(id).changes > 0;
}

function listUsageEvents() {
  return stmts.listUsageEvents.all();
}
function insertUsageEvent(event) {
  stmts.insertUsageEvent.run({
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
  return event;
}
function findUsageEvent(id) {
  return stmts.findUsageEvent.get(id) || null;
}
function patchUsageEvent(id, patch) {
  const existing = findUsageEvent(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  stmts.updateUsageEvent.run(updated);
  return updated;
}

function getDiscovery() {
  const row = stmts.getKv.get('discovery');
  return row ? JSON.parse(row.value) : null;
}
function setDiscovery(value) {
  stmts.setKv.run('discovery', JSON.stringify(value));
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
    grants: listGrants(),
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
    stmts.insertGrant.run({ ...g, constraints: g.constraints ?? null, expiresAt: g.expiresAt ?? null });
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
  DiscoverySourceConflictError,

  listCapabilities,
  insertCapability,
  findCapabilityById,
  listPrincipals,
  insertPrincipal,
  findPrincipalById,
  findPrincipalByKindName,
  listGrants,
  findGrant,
  insertGrant,
  deleteGrant,
  listUsageEvents,
  insertUsageEvent,
  findUsageEvent,
  patchUsageEvent,
  getDiscovery,
  setDiscovery,

  listDiscoverySources,
  listEnabledDiscoverySourcePaths,
  listEnabledMcpManifestPaths,
  findDiscoverySourceById,
  insertDiscoverySource,
  updateDiscoverySource,
  deleteDiscoverySource,

  load,
  save,
};
