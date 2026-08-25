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
//     discovery's merge pass) whose logic mutates a whole in-memory snapshot at once. No
//     request-path or hook-path caller uses it: principal resolution, the last one that did, is
//     now `upsertPrincipalIdentity` below. `save()` replaces every table's contents inside one SQLite transaction,
//     so even this coarse path is all-or-nothing — a crash or a concurrent reader can never
//     observe a half-written table, unlike the old `fs.writeFileSync`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { genId } = require('./id');
const { discoverySourceDefaults, envCompat, cameFromEnvFile, DATA_DIR } = require('./config');
// The one definition of what an assurance tier may be — shared with principals/registry.js and
// app.js so a value this module accepts is a value the whole system recognises.
const { isAssuranceLevel } = require('./principals/subject');
const { normalizeUsageEvent } = require('./ingest/usageEvent');
// The schema and the migrator that applies it — see the Schema section below.
const { migrate } = require('./schema/migrator');
const { sqliteDriver } = require('./schema/sqliteDriver');
const { nodeMigrations } = require('./schema/nodeMigrations');

// WINDROW_DB_PATH. The GOVERNANCE_DB_PATH spelling was removed in tier 4 of
// docs/design/governance-to-windrow-rename.md and now throws — a stale name must not silently
// resolve to the default database, which would boot an empty registry that looks healthy.

const DEFAULT_DB_PATH = path.join(DATA_DIR, 'windrow.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'governance.db');
const DB_PATH = envCompat('DB_PATH', { fallback: DEFAULT_DB_PATH });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Tier 2 of docs/design/governance-to-windrow-rename.md: the SQLite file moves
// `governance.db` → `windrow.db`. It has to happen here — before `new Database()` opens anything,
// with the service stopped — because renaming a file SQLite has a handle on is not a migration,
// it is a corruption.
//
// Three files move, not one. The db runs in WAL mode (the pragma below), so `-wal` holds every
// transaction committed since the last checkpoint and `-shm` is the index into it; moving the
// `.db` alone silently rewinds the database to its last checkpoint. Each suffix is guarded
// independently on the destination not existing, so a half-completed move (a crash between two
// renames) finishes on the next boot rather than clobbering what already arrived.
//
// Scoped to the default location only: if DB_PATH came from the environment, the operator named
// the file they want and nothing here should move it — that is what the sandbox and OOBE scripts
// rely on when they point this module at a copy.
let dbFile = DB_PATH;
if (path.resolve(DB_PATH) === path.resolve(DEFAULT_DB_PATH)) {
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix) && !fs.existsSync(DEFAULT_DB_PATH + suffix)) {
        fs.renameSync(LEGACY_DB_PATH + suffix, DEFAULT_DB_PATH + suffix);
      }
    }
  } catch (err) {
    // On Windows the running service holds an open handle on the live db, and renaming a locked
    // file is EPERM/EBUSY. That is not an error worth killing a process over: it is the ordinary
    // state of every dev script, CLI and sandbox that requires this module while :4000 is up. If
    // nothing moved, this run just uses the old filename — exactly the pre-migration state — and
    // the next boot with the service stopped completes the move.
    //
    // Only when *nothing* moved, though. A partial move (the `.db` renamed but `-wal` refused)
    // must not fall back: opening the legacy name would create a fresh empty database beside a
    // WAL belonging to the one that just moved. That case rethrows, because it needs a human.
    if (fs.existsSync(LEGACY_DB_PATH) && !fs.existsSync(DEFAULT_DB_PATH)) {
      console.warn(`[store] could not rename ${LEGACY_DB_PATH} to ${DEFAULT_DB_PATH} (${err.code || err.message}) `
        + '— using the old filename for this run; retry with the service stopped.');
      dbFile = LEGACY_DB_PATH;
    } else {
      throw err;
    }
  }
}

const db = new Database(dbFile);
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
//
// One versioned migrator, shared with the central store — see server/schema/migrator.js for the
// mechanism and docs/design/global-identity-and-central-db.md §2.5 for why it is one and not two.
// The schema itself lives in server/schema/nodeMigrations.js as an ordered list; what used to be
// here — a `CREATE TABLE IF NOT EXISTS` block followed by a dozen hand-rolled `PRAGMA table_info`
// guards re-evaluated on every process start — is that list's first fourteen entries, statement
// for statement.
//
// Three things this buys that the inline blocks could not, all of them about a fleet rather than
// this machine (§2.6): the version is a number a node can report and central can compare; a
// database migrated by a *newer* build makes this one throw instead of quietly writing rows it
// does not understand; and an up-to-date database costs one indexed read here rather than a
// PRAGMA sweep per table on every CLI and hook invocation.
const schema = migrate({ driver: sqliteDriver(db), migrations: nodeMigrations, label: 'node' });

/**
 * The schema version this database is at. Exported so a node can *report* where it is — the fleet
 * half of §2.6, where N nodes update at N different times and "quiet" has to be distinguishable
 * from "behind". Nothing serves it yet; GET /api/policy/status is the natural place to put it.
 */
function schemaVersion() {
  return schema.to;
}

// Signals raised by the migrations that actually ran this boot, consumed once further down this
// file after the hashing helpers are defined. They used to be `let` flags reassigned from inside
// the guarded blocks; they say exactly the same thing, but now they can only be raised by a
// migration that ran, which is what makes them correct on a database that was already migrated.
//
// usageEventsNeedsHashBackfill — this run just added the hash-chain columns to a pre-existing db,
// so every existing row's prevHash/hash is still NULL and each node's chain has to be *built*, or
// every pre-existing row reads as tampered on the first verifyUsageEventChain() call.
const usageEventsNeedsHashBackfill = schema.signals.has('usageEventsNeedsHashBackfill');

// usageEventsNeedsRechain — a different situation, and it must not be conflated with the one
// above: this run added a column that is part of `canonicalizeUsageEvent` to a db whose chain was
// ALREADY built. Every pre-existing row still hashes fine against the *old* canonical form, but
// the new form emits an extra key for them (`"shadowOutcome":null`), so every stored hash stops
// matching and `verifyUsageEventChain()` reports a break at row 1 — the whole audit log reading as
// tampered because of a schema migration. Re-chaining fixes it, but re-chaining also overwrites
// the evidence of any tampering that had happened before now, so the consumer below verifies FIRST
// and shouts if the chain was already broken.
const usageEventsNeedsRechain = schema.signals.has('usageEventsNeedsRechain');

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
    subjectId: p.subjectId ?? null,
    assuranceLevel: p.assuranceLevel ?? null,
    parentRole: p.parentRole ?? null,
    humanName: p.humanName ?? null,
    backend: p.backend ?? null,
    agentType: p.agentType ?? null,
    field: p.field ?? null,
    standalone: p.standalone ? 1 : 0,
    status: p.status || 'active',
    // Carried through `save()`'s whole-table replace so a confirmed owner survives a snapshot
    // round-trip (discovery still writes that way). A row that has never been decided lands
    // 'unassigned' with nulls, which is what a fresh principal always is — the owner is never
    // inferred at write time, only proposed at read time. See server/schema/nodeMigrations.js.
    ownerStatus: p.ownerStatus || 'unassigned',
    ownerOsUser: p.ownerOsUser ?? null,
    ownerPrincipalId: p.ownerPrincipalId ?? null,
    ownerConfirmedAt: p.ownerConfirmedAt ?? null,
    ownerConfirmedBy: p.ownerConfirmedBy ?? null,
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
// Node identity
// ---------------------------------------------------------------------------

/**
 * This node's id — the identity every usage event is filed under and every credential is bound to
 * (docs/design/global-identity-and-central-db.md §2.7 phase 1).
 *
 * ==========================================================================================
 * IT COMES FROM CONFIGURATION OR THE CREDENTIAL, NEVER FROM THE DATABASE
 * ==========================================================================================
 *
 * docs/design/dashboard-placement.md item 5. This used to mint `node_<uuid>` into `kv` on first
 * use, which was right for a machine somebody installs once and wrong for a node you rebuild: a
 * rebuilt node got a fresh identity, so central's roster accumulated ghosts — the fleet this was
 * measured on showed **5 nodes, 1 seen in the last 24 hours** — and one machine's `kv` carried
 * `outbox_seq:` counters for two different node ids, which is that drift made visible.
 *
 * So the resolution order is, and the order is the argument:
 *
 *   1. `WINDROW_NODE_ID`         configuration. A rebuild reads the same file and is the same node.
 *   2. the enrollment credential  the id central issued and bound a certificate to. Authoritative
 *                                 by construction: shipping under any other id is refused at both
 *                                 ends, so reading it here removes a way for the two to disagree.
 *   3. `kv.node_id`               LEGACY ONLY. Never written any more, only read — because the
 *                                 databases in the field have one, those rows were written under
 *                                 it, and relabelling them would rewrite whose evidence they are.
 *                                 Logged once, with the fix, so the state is visible rather than
 *                                 inherited silently.
 *   4. mint — INTO CONFIGURATION, not into the database. A node with no central and no env var
 *      still needs an identity; it is written to `windrow.env` as `WINDROW_NODE_ID`, so the next
 *      boot takes path 1 and a rebuild that keeps the config file keeps the identity.
 *
 * Step 4 is what makes this a change of *where identity lives* rather than a removal of the
 * ability to start without one. Nothing here can fail closed: a node that cannot write its config
 * file still gets an id for this process and says so.
 *
 * Cached in-process after the first read: this is on the insert path for every governed tool call.
 */
let cachedNodeId = null;
let warnedAboutDatabaseIdentity = false;

/** The nodeId the enrollment credential was issued for, or null. Required lazily and defensively:
 *  this runs during store initialisation, the credential loader touches the filesystem, and a
 *  missing or unreadable credential directory is the ordinary state of an unenrolled node rather
 *  than a reason to fail to open the database. */
function nodeIdFromCredential() {
  try {
    // eslint-disable-next-line global-require
    const enrollClient = require('./enrollment/client');
    const credential = enrollClient.load(process.env.WINDROW_SHIP_CREDENTIAL_NAME || 'node-shipper');
    return (credential && credential.meta && credential.meta.nodeId) || null;
  } catch {
    return null;
  }
}

function nodeId() {
  if (process.env.WINDROW_NODE_ID) return process.env.WINDROW_NODE_ID;
  if (cachedNodeId) return cachedNodeId;

  const fromCredential = nodeIdFromCredential();
  if (fromCredential) {
    cachedNodeId = fromCredential;
    return cachedNodeId;
  }

  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('node_id');
  if (row && row.value) {
    cachedNodeId = row.value;
    if (!warnedAboutDatabaseIdentity) {
      warnedAboutDatabaseIdentity = true;
      console.warn(
        `[store] this node's id (${cachedNodeId}) is coming from the database, which is the one`,
        'place docs/design/dashboard-placement.md item 5 says it must not: rebuild this machine and',
        'the id is gone, so central gets a ghost on its roster instead of the same node back.',
        `Pin it by putting WINDROW_NODE_ID=${cachedNodeId} in windrow.env, or enroll this node.`
      );
    }
    return cachedNodeId;
  }

  // Nothing configured, nothing enrolled, nothing inherited: mint one and write it where a rebuild
  // will find it. Deliberately NOT into `kv` — see the header.
  const minted = `node_${crypto.randomUUID()}`;
  cachedNodeId = minted;
  try {
    // eslint-disable-next-line global-require
    const envFile = require('./envFile');
    envFile.write({ WINDROW_NODE_ID: minted }, {
      header: [
        'Node identity. Written once, when this node first needed one and nothing had given it an',
        'id (docs/design/dashboard-placement.md item 5). It lives here rather than in the database',
        'so that rebuilding this machine keeps it the same node.',
      ].join('\n'),
    });
    console.log(
      `[store] minted this node's id as ${minted} and wrote it to windrow.env as WINDROW_NODE_ID.`,
      'Identity now lives in configuration, so rebuilding this machine keeps it.'
    );
  } catch (err) {
    // The id still stands for this process. Saying so is the whole remedy: the failure mode being
    // guarded against is a node that silently gets a new identity every boot, and a node that
    // announces it could not persist one is not that.
    console.error(
      `[store] minted this node's id as ${minted} but could not write it to windrow.env (${err.message}).`,
      'It will NOT survive a restart — set WINDROW_NODE_ID in the environment before this node ships anything,',
      'or every restart will look to central like a different machine.'
    );
  }
  return cachedNodeId;
}

// ---------------------------------------------------------------------------
// Incarnation — docs/design/dashboard-placement.md item 5
// ---------------------------------------------------------------------------

/**
 * Which LIFETIME of this node is writing. Minted at startup, never read back from the database.
 *
 * ==========================================================================================
 * WHY A STABLE NODE ID ALONE WOULD MAKE THE TAMPER DETECTOR FIRE ON EVERY REBUILD
 * ==========================================================================================
 *
 * `seq` is assigned from `MAX(seq)` over this node's OWN table. A rebuilt node with a stable id
 * and an empty database therefore starts again at 1 — and central does not ignore that:
 * `server/central/queries.js` verifies the shipped stream is DENSE, using `LAG(seq)` to find
 * missing ranges and checking each row's `prevHash` against the previous row's `hash`. A rebuild
 * would present duplicate seqs with a null prevHash, which reads as tampering.
 *
 * That is the worst possible failure: a fleet of disposable nodes would generate a continuous
 * stream of chain violations that are all false, and an alarm that always rings gets switched off
 * — and then the real one is missed too.
 *
 * Three ways out were considered and two are wrong. Recovering `seq` from central at startup makes
 * cold start depend on central being reachable, which §2.8 exists to avoid. A fresh id per rebuild
 * gives correct chains and restores the ghost roster this change was made to fix. So:
 *
 *   THE CHAIN IS (nodeId, incarnation, seq).
 *
 * Stable logical identity for the roster, a fresh dense chain per lifetime, and no dependency on
 * central at boot. Central's density check then runs *within* an incarnation, which is the only
 * scope in which density was ever a meaningful claim.
 *
 * NEVER PERSISTED, AND THAT IS THE POINT. Reading it back from `kv` would make a rebuilt node
 * continue a chain whose rows it no longer holds — which is the broken state this exists to
 * prevent, arrived at by the other side. `WINDROW_INCARNATION` overrides it for a process that
 * must continue a specific lifetime (a supervisor handing a chain to a replacement child, and
 * server/supervisor.js does exactly that), because "same lifetime" is then a fact the caller knows
 * and this process cannot.
 *
 * TIME-ORDERED PREFIX. `inc_<utc compact>_<random>` sorts chronologically, so a node's
 * incarnations list in the order they happened without a join — which is what makes "this node has
 * been rebuilt eleven times this week" a readable row rather than a set of opaque ids.
 */
const INCARNATION = process.env.WINDROW_INCARNATION
  || `inc_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;

/** The sentinel every row written before incarnations existed belongs to. A literal rather than
 *  NULL because it is a chain coordinate: SQLite treats NULLs as distinct in a unique index, so
 *  `UNIQUE(nodeId, incarnation, seq)` over NULLs would enforce nothing, and the pre-incarnation
 *  chain — which is dense and real — would lose the constraint that protects it. */
const LEGACY_INCARNATION = 'inc_0';

function incarnation() {
  return INCARNATION;
}

// Give every pre-existing row a nodeId and a seq. Runs before any hashing, because the chain is
// keyed on (nodeId, seq) and a row without them has no place in one.
//
// Every row already in this db was written by this node, so this node's id is the honest value —
// unlike `observedAt`, which is left NULL because "when did we see it" has no honest answer after
// the fact. `seq` is assigned in rowid order, i.e. the same insertion order the chain used to be
// keyed on, so a db that migrates keeps the exact ordering its existing hashes were built over.
function backfillUsageEventNodeIds() {
  const pending = db
    .prepare('SELECT rowid, nodeId FROM usage_events WHERE nodeId IS NULL OR seq IS NULL ORDER BY rowid ASC')
    .all();
  if (!pending.length) return 0;
  const assign = db.prepare('UPDATE usage_events SET nodeId = ?, seq = ? WHERE rowid = ?');
  const maxSeq = db.prepare('SELECT MAX(seq) AS seq FROM usage_events WHERE nodeId = ?');
  // A row that already names a node keeps it — only its missing `seq` is filled in, at the end of
  // *that* node's chain. Reassigning it to this node would relabel another node's evidence, which
  // is a worse lie than the missing column it was meant to fix.
  const next = new Map();
  const run = db.transaction(() => {
    for (const row of pending) {
      const node = row.nodeId || nodeId();
      if (!next.has(node)) {
        const start = maxSeq.get(node);
        next.set(node, (start && start.seq != null ? start.seq : 0) + 1);
      }
      const seq = next.get(node);
      next.set(node, seq + 1);
      assign.run(node, seq, row.rowid);
    }
  });
  run();
  return pending.length;
}

// ---------------------------------------------------------------------------
// usage_events hash chain
// ---------------------------------------------------------------------------

// Every field that's actually part of the audit record — deliberately excludes prevHash/hash
// themselves (a row can't hash itself) so this is stable to call before either is known.
function canonicalizeUsageEvent(e) {
  return JSON.stringify({
    id: e.id,
    // The chain's own coordinates are part of what it protects: without them a row could be moved
    // to another node or another slot and still hash correctly, which is precisely the splice the
    // chain exists to detect. `observedAt` is in here for the ordinary reason every other column
    // is — it is evidence (of clock skew), so editing it has to break something.
    nodeId: e.nodeId ?? null,
    // Which LIFETIME of that node — docs/design/dashboard-placement.md item 5. In here for exactly
    // the reason nodeId and seq are: a rebuilt node starts a fresh chain at seq 1, so without this
    // coordinate a row could be moved from one lifetime to the same slot in another and still hash
    // correctly, which is the splice the chain exists to detect.
    incarnation: e.incarnation ?? null,
    seq: e.seq ?? null,
    observedAt: e.observedAt ?? null,
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
    actorLoomId: e.actorLoomId ?? null,
    actorAgentType: e.actorAgentType ?? null,
    actorBackend: e.actorBackend ?? null,
    actorField: e.actorField ?? null,
    subjectId: e.subjectId ?? null,
    assuranceLevel: e.assuranceLevel ?? null,
    // The shadow decision is in the chain for the same reason the enforced one is: it is the
    // evidence the phase-5 flip gets argued from, so an edit to it has to be detectable.
    shadowOutcome: e.shadowOutcome ?? null,
    shadowReason: e.shadowReason ?? null,
    shadowPrincipalId: e.shadowPrincipalId ?? null,
    correctedAt: e.correctedAt ?? null,
    // The payload fingerprint (server/hooks/lib.js's toolInputDigest, /api/invoke). In the chain so
    // the binding it asserts — "this row is about that exact call" — cannot be rewritten to point at
    // a different payload without breaking the hash. NULL on rows written before this column existed,
    // which land in the pre-toolInputDigest legacy form below.
    toolInputDigest: e.toolInputDigest ?? null,
    // Fields the writing build had no column for (§2.6, server/ingest/usageEvent.js). In the chain
    // for the ordinary reason everything else is: an unrecognised field is still evidence, and a
    // field parked outside the chain could be edited — or quietly emptied — without breaking
    // anything. Already a canonical string (sorted keys) when it arrives, so this does not
    // re-serialise it and cannot reorder what it hashes.
    extra: e.extra ?? null,
  });
}

// Every canonical form this table has ever been chained under, newest first, current form
// excluded. Adding a field to canonicalizeUsageEvent above changes the string every *existing*
// row hashes to, so on a db chained by an older build the whole log verifies as broken — which is
// indistinguishable, from the outside, from someone having edited a row. Keeping the superseded
// forms is what tells those two apart: a chain that still verifies under a previous form was
// merely out of date, and one that verifies under none of them was tampered with.
//
// Append the outgoing form here whenever canonicalizeUsageEvent gains or loses a field. They are
// frozen by definition — a legacy form describes rows already on disk, so editing one is only ever
// wrong.
const LEGACY_CANONICAL_FORMS = [
  // Pre-toolInputDigest: before usage_events carried a fingerprint of the exact payload
  // (server/hooks/lib.js's toolInputDigest). Newest legacy form and so first in the list — every
  // database written by the immediately preceding build is chained under this one, and the column is
  // nullable-and-not-back-filled, so those rows keep verifying here rather than being re-hashed.
  function canonicalizeUsageEventPreToolInputDigest(e) {
    return JSON.stringify({
      id: e.id,
      nodeId: e.nodeId ?? null,
      incarnation: e.incarnation ?? null,
      seq: e.seq ?? null,
      observedAt: e.observedAt ?? null,
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
      actorLoomId: e.actorLoomId ?? null,
      actorAgentType: e.actorAgentType ?? null,
      actorBackend: e.actorBackend ?? null,
      actorField: e.actorField ?? null,
      subjectId: e.subjectId ?? null,
      assuranceLevel: e.assuranceLevel ?? null,
      shadowOutcome: e.shadowOutcome ?? null,
      shadowReason: e.shadowReason ?? null,
      shadowPrincipalId: e.shadowPrincipalId ?? null,
      correctedAt: e.correctedAt ?? null,
      extra: e.extra ?? null,
    });
  },
  // Pre-incarnation (docs/design/dashboard-placement.md item 5): before the chain gained its third
  // coordinate. Every database in existence when incarnations were adopted is chained under this
  // one, and NOT re-chaining them is the point. Rewriting hashes to add a coordinate would destroy
  // the evidence it was added to protect.
  function canonicalizeUsageEventPreIncarnation(e) {
    return JSON.stringify({
      id: e.id,
      nodeId: e.nodeId ?? null,
      // The lifetime that wrote it, restored as recorded for the same reason nodeId is. A snapshot
      // taken before incarnations existed carries none, and those rows land in the legacy chain —
      // which is exactly where they belong, since that is the chain they were hashed into.
      incarnation: e.incarnation ?? LEGACY_INCARNATION,
      seq: e.seq ?? null,
      observedAt: e.observedAt ?? null,
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
      actorLoomId: e.actorLoomId ?? null,
      actorAgentType: e.actorAgentType ?? null,
      actorBackend: e.actorBackend ?? null,
      actorField: e.actorField ?? null,
      subjectId: e.subjectId ?? null,
      assuranceLevel: e.assuranceLevel ?? null,
      shadowOutcome: e.shadowOutcome ?? null,
      shadowReason: e.shadowReason ?? null,
      shadowPrincipalId: e.shadowPrincipalId ?? null,
      correctedAt: e.correctedAt ?? null,
      extra: e.extra ?? null,
    });
  },
  // Pre-§2.6: before `extra`, the column that keeps a field the writing build had no column for.
  // Newest legacy form and so first in the list — the one a database written by the immediately
  // preceding build validates under, which is every database in existence when §2.6 was adopted.
  function canonicalizeUsageEventPreExtra(e) {
    return JSON.stringify({
      id: e.id,
      nodeId: e.nodeId ?? null,
      seq: e.seq ?? null,
      observedAt: e.observedAt ?? null,
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
      actorLoomId: e.actorLoomId ?? null,
      actorAgentType: e.actorAgentType ?? null,
      actorBackend: e.actorBackend ?? null,
      actorField: e.actorField ?? null,
      subjectId: e.subjectId ?? null,
      assuranceLevel: e.assuranceLevel ?? null,
      shadowOutcome: e.shadowOutcome ?? null,
      shadowReason: e.shadowReason ?? null,
      shadowPrincipalId: e.shadowPrincipalId ?? null,
      correctedAt: e.correctedAt ?? null,
    });
  },
  // Pre-§2.7-phase-1: before `nodeId`/`seq` (the chain's own coordinates, once it stopped being
  // keyed on this db's rowid order) and `observedAt` (the node's clock beside the caller's).
  function canonicalizeUsageEventPreNode(e) {
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
      actorLoomId: e.actorLoomId ?? null,
      actorAgentType: e.actorAgentType ?? null,
      actorBackend: e.actorBackend ?? null,
      actorField: e.actorField ?? null,
      subjectId: e.subjectId ?? null,
      assuranceLevel: e.assuranceLevel ?? null,
      shadowOutcome: e.shadowOutcome ?? null,
      shadowReason: e.shadowReason ?? null,
      shadowPrincipalId: e.shadowPrincipalId ?? null,
      correctedAt: e.correctedAt ?? null,
    });
  },
  // Pre-§1.4/§1.6: before `subjectId`/`assuranceLevel` (the subject of the call) and the
  // `shadow*` columns (the user-keyed decision) joined the audit record.
  function canonicalizeUsageEventPreSubject(e) {
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
      actorLoomId: e.actorLoomId ?? null,
      actorAgentType: e.actorAgentType ?? null,
      actorBackend: e.actorBackend ?? null,
      actorField: e.actorField ?? null,
      correctedAt: e.correctedAt ?? null,
    });
  },
  // Older still — before the actor* columns (§1.2: the calling agent as a dimension of the call).
  // This is the form every *shipped* build chained under, so it is the one a real windrow.db
  // that has never run a working-tree build will validate against.
  function canonicalizeUsageEventPreActor(e) {
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
  },
];

function hashUsageEvent(prevHash, e, canonicalize = canonicalizeUsageEvent) {
  return crypto.createHash('sha256').update(`${prevHash || ''}|${canonicalize(e)}`).digest('hex');
}

/** The recorded tip of one LIFETIME of one node's chain, or null if that lifetime has written
 *  nothing here. Per incarnation since item 5: a node has as many chains as it has had lifetimes,
 *  and a single head would leave every earlier one truncatable without trace. */
function chainHead(node, inc = incarnation()) {
  return db.prepare('SELECT * FROM usage_chain_heads WHERE nodeId = ? AND incarnation = ?').get(node, inc) || null;
}
function listChainHeads() {
  return db.prepare('SELECT * FROM usage_chain_heads ORDER BY nodeId ASC, incarnation ASC').all();
}
const setChainHead = db.prepare(
  `INSERT INTO usage_chain_heads (nodeId, incarnation, seq, hash, updatedAt)
   VALUES (@nodeId, @incarnation, @seq, @hash, @updatedAt)
   ON CONFLICT(nodeId, incarnation) DO UPDATE SET
     seq = excluded.seq, hash = excluded.hash, updatedAt = excluded.updatedAt`
);

/**
 * Recomputes hash/prevHash for `node`'s row at `fromSeq` and every row after it in that node's
 * own sequence, then moves that node's recorded head to the new tail. Needed both for a fresh
 * insert (chain of one new tail row) and for a correcting PATCH (the corrected row's content
 * changed, so its own hash — and every hash chained after it — has to be redone; a PATCH lands
 * inside the correction window, which keeps how many rows that touches small in practice).
 *
 * Per node, not per rowid: rowid is this db's insertion order, which is a total order only while
 * there is exactly one writer (see the nodeId column comment). Re-chaining by rowid across a db
 * holding two nodes' rows would interleave them into one chain that neither node could verify or
 * extend on its own.
 *
 * Run inside the caller's transaction where one already wraps the write, so a crash mid-chain
 * can't leave hash/prevHash — or the head — desynced from the rows they describe.
 */
function rechainNodeFrom(node, inc, fromSeq) {
  const prevRow =
    fromSeq > 1
      ? db.prepare('SELECT hash FROM usage_events WHERE nodeId = ? AND incarnation = ? AND seq = ?')
        .get(node, inc, fromSeq - 1)
      : null;
  let prevHash = prevRow ? prevRow.hash : null;
  const rows = db
    .prepare('SELECT rowid, * FROM usage_events WHERE nodeId = ? AND incarnation = ? AND seq >= ? ORDER BY seq ASC')
    .all(node, inc, fromSeq);
  if (!rows.length) return;
  const setHash = db.prepare('UPDATE usage_events SET prevHash = ?, hash = ? WHERE rowid = ?');
  let tail = null;
  for (const row of rows) {
    const hash = hashUsageEvent(prevHash, row);
    setHash.run(prevHash, hash, row.rowid);
    prevHash = hash;
    tail = row;
  }
  setChainHead.run({
    nodeId: node, incarnation: inc, seq: tail.seq, hash: prevHash, updatedAt: new Date().toISOString(),
  });
}

/**
 * Every CHAIN in this table — one per (node, lifetime) — oldest-first within each. `null` nodeId
 * for rows a migration hasn't reached yet, kept as its own group rather than dropped so they are
 * still verified.
 *
 * Per incarnation since docs/design/dashboard-placement.md item 5. A node has as many chains as it
 * has had lifetimes, and walking them as one would report every rebuild as a splice — which is
 * precisely the false alarm the third coordinate was added to prevent, arriving from inside
 * instead of from central.
 */
function usageEventChains() {
  return db
    .prepare(`SELECT DISTINCT nodeId, incarnation FROM usage_events
              ORDER BY nodeId IS NULL, nodeId ASC, incarnation ASC`)
    .all()
    .map((r) => ({ nodeId: r.nodeId, incarnation: r.incarnation || LEGACY_INCARNATION }));
}

/**
 * Walks each node's chain and reports the first row (if any) whose stored hash doesn't match what
 * its content + prevHash actually hash to — that's either a direct edit that bypassed
 * insertUsageEvent/patchUsageEvent, or rows deleted/reordered out from under the chain. Three
 * distinct breaks are detected per node, all reported the same way:
 *
 *   - a hash or prevHash that doesn't match the row's content (an edit)
 *   - a gap or repeat in `seq` (a splice — the chain is gapless from 1 by construction)
 *   - a tail short of the node's recorded head (a truncation, which a chain read only out of the
 *     rows themselves cannot see at all: lop off the last N and the rest still verifies)
 *
 * Not on any hot path; for admin diagnostics (GET /api/usage/verify).
 */
function verifyUsageEventChain(canonicalize = null) {
  // Distinguishes "the caller asked about THIS form" from "the caller just wants to know whether
  // the log is intact". Only the second gets the per-chain fallback below.
  const explicitForm = Boolean(canonicalize);
  if (!canonicalize) canonicalize = canonicalizeUsageEvent;
  const nodes = [];
  let deepest = null;
  let checked = 0;

  // One chain's walk, under one canonical form. Extracted so the per-chain form fallback below can
  // re-run it without duplicating what a break means.
  const walk = (node, rows, head, form) => {
    let prevHash = null;
    let broken = null;
    for (const [i, row] of rows.entries()) {
      // Contiguity first: under a splice the hashes below would also fail, but "seq 7 is missing"
      // names what happened where "row 8's hash is wrong" only says something is off.
      if (node != null && row.seq !== i + 1) {
        return {
          broken: { brokenAt: row.id, rowid: row.rowid, seq: row.seq, reason: `expected seq ${i + 1}, found ${row.seq}` },
          prevHash,
        };
      }
      const expected = hashUsageEvent(prevHash, row, form);
      if (row.hash !== expected || (row.prevHash || null) !== (prevHash || null)) {
        return {
          broken: { brokenAt: row.id, rowid: row.rowid, seq: row.seq ?? null, reason: 'hash does not match row content' },
          prevHash,
        };
      }
      prevHash = row.hash;
    }
    if (node == null && rows.length) {
      broken = { brokenAt: rows[0].id, rowid: rows[0].rowid, seq: null, reason: 'rows carry no nodeId — not in any chain' };
    }
    if (!broken && head && (rows.length !== head.seq || prevHash !== head.hash)) {
      broken = {
        brokenAt: rows.length ? rows[rows.length - 1].id : null,
        rowid: rows.length ? rows[rows.length - 1].rowid : null,
        seq: rows.length ? rows[rows.length - 1].seq : 0,
        reason: `tail is seq ${rows.length} but the recorded head is seq ${head.seq} — rows were removed from the end`,
      };
    }
    return { broken, prevHash };
  };

  for (const { nodeId: node, incarnation: inc } of usageEventChains()) {
    const rows =
      node == null
        ? db.prepare('SELECT rowid, * FROM usage_events WHERE nodeId IS NULL ORDER BY rowid ASC').all()
        : db.prepare(`SELECT rowid, * FROM usage_events
                      WHERE nodeId = ? AND incarnation = ? ORDER BY seq ASC`).all(node, inc);
    checked += rows.length;
    const head = node == null ? null : chainHead(node, inc);

    let form = canonicalize;
    let { broken } = walk(node, rows, head, form);

    // PER-CHAIN FORM FALLBACK — docs/design/dashboard-placement.md item 5.
    //
    // Adding `incarnation` to the canonical form changed the string every EXISTING row hashes to.
    // Everywhere else in this file a canonical-form change is answered by re-chaining the whole
    // table; that is not available here and must not be, because those rows have already been
    // SHIPPED. Re-chaining them would silently rewrite hashes central holds copies of, turning a
    // routine migration into a fleet-wide `divergent` verdict that is entirely fictional.
    //
    // So the chains keep their hashes and this walks each one under the form it was actually
    // written with. That is exact rather than a search, because the legacy incarnation IS the set
    // of rows written before the change — but the loop over every superseded form is kept anyway,
    // since a database can also carry chains from builds older still.
    //
    // Only when the caller named no form. `diagnoseUsageEventChain` passes one deliberately and
    // must get an answer about THAT form, not about whichever one happens to fit.
    if (broken && !explicitForm) {
      for (const legacy of LEGACY_CANONICAL_FORMS) {
        const retry = walk(node, rows, head, legacy);
        if (!retry.broken) {
          broken = null;
          form = legacy;
          break;
        }
        // Still broken under this form too — keep the DEEPEST failure, not the last one tried.
        // Under a form the chain was never written with, everything mismatches from row 1, so
        // reporting that would point at the oldest row in the table rather than at the edit. The
        // form that gets furthest before failing is the one the chain was really written with, and
        // where it stops is the row to go and look at. Same rule diagnoseUsageEventChain applies
        // across forms; applied here per chain, because the fallback made it reachable per chain.
        if ((retry.broken.rowid || 0) > (broken.rowid || 0)) {
          broken = retry.broken;
          form = legacy;
        }
      }
    }

    nodes.push({
      nodeId: node,
      incarnation: node == null ? null : inc,
      checked: rows.length,
      // Which canonical form this chain verified under. Named rather than implied: a chain still
      // reading as valid under a superseded form is a fact worth seeing on the diagnostic, because
      // it is the difference between "old" and "edited" and those must never blur.
      form: form === canonicalizeUsageEvent ? 'canonicalizeUsageEvent' : (form.name || 'legacy'),
      head: head ? { seq: head.seq, hash: head.hash, updatedAt: head.updatedAt } : null,
      ok: !broken,
      ...(broken || {}),
    });
    // Deepest across nodes, for the same reason diagnoseUsageEventChain() picks the deepest across
    // canonical forms: the failure furthest into the log is the one that points at the edit.
    if (broken && (deepest == null || (broken.rowid || 0) > (deepest.rowid || 0))) deepest = broken;
  }

  if (deepest) return { ok: false, checked, nodes, ...deepest };
  return { ok: true, checked, nodes };
}

/**
 * "Is this log intact under ANY canonical form it could have been written with?" — the current one
 * or any superseded one. Used only by the re-chaining migration below, which has to tell an
 * out-of-date chain apart from a tampered one before it overwrites the difference between them.
 *
 * Returns `{ ok: true, form }` naming the form that validated it, or `{ ok: false, form, brokenAt,
 * rowid }` describing the *deepest* failure across all forms. Deepest, because under a form the log
 * was never written with everything mismatches from row 1, so reporting that would point at the
 * oldest row in the table rather than at the edit — the form that gets furthest before failing is
 * the one the log was really written with, and where it stops is the row to go and look at.
 */
function diagnoseUsageEventChain() {
  const current = verifyUsageEventChain();
  if (current.ok) return { ok: true, form: 'canonicalizeUsageEvent' };
  let deepest = { ...current, form: 'canonicalizeUsageEvent' };
  for (const form of LEGACY_CANONICAL_FORMS) {
    const result = verifyUsageEventChain(form);
    if (result.ok) return { ok: true, form: form.name };
    if ((result.rowid || 0) > (deepest.rowid || 0)) deepest = { ...result, form: form.name };
  }
  return deepest;
}

// Node coordinates first, before anything hashes anything: the chain is keyed on (nodeId, seq),
// and both the backfill and the re-chain below depend on every row having them. Unconditional
// rather than flag-driven — a row can also arrive without them from a `save()` snapshot restored
// out of an older export — and it reports whether it actually did anything, because assigning a
// row a nodeId changes its canonical form and so obliges the re-chain that follows.
const usageEventsBackfilled = backfillUsageEventNodeIds();
if (usageEventsBackfilled) {
  console.log(`[store] usage_events: assigned nodeId ${nodeId()} and a per-node seq to ${usageEventsBackfilled} row(s).`);
}

// A db that just had the hash-chain columns added (usageEventsNeedsHashBackfill, signalled by the
// migration that added them) has every existing row's prevHash/hash still NULL — chain every node's
// rows once now so each chain starts unbroken instead of every pre-existing row reading as
// tampered on the first verifyUsageEventChain() call.
if (usageEventsNeedsHashBackfill) {
  for (const c of usageEventChains()) if (c.nodeId != null) rechainNodeFrom(c.nodeId, c.incarnation, 1);
} else if (usageEventsNeedsRechain || usageEventsBackfilled) {
  // A canonical-form change on an already-chained db (see the flag's declaration). Check before
  // re-chaining: afterwards every row hashes correctly by construction, so a break that existed
  // beforehand would be silently erased by the migration that was supposed to be routine. This is
  // the one moment it can still be seen.
  //
  // Under the *new* form every pre-existing row fails, migration or tampering alike, so that check
  // says nothing on its own — the question is whether the chain was intact under the form it was
  // actually written with.
  const diagnosis = diagnoseUsageEventChain();
  if (diagnosis.ok) {
    console.log(`[store] usage_events re-chained: canonical form moved on from ${diagnosis.form}; chain was intact under it.`);
  } else {
    console.error(
      '[store] usage_events hash chain verifies under NO canonical form this table has ever used —',
      `it was edited outside insertUsageEvent/patchUsageEvent. Closest form ${diagnosis.form},`,
      `first mismatch at event ${diagnosis.brokenAt} (rowid ${diagnosis.rowid}).`,
      'The re-chain below makes the chain valid again and will not reveal this a second time —',
      'investigate that event now.'
    );
  }
  for (const c of usageEventChains()) if (c.nodeId != null) rechainNodeFrom(c.nodeId, c.incarnation, 1);
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
  insertPrincipal: db.prepare(`INSERT INTO principals (id, kind, name, subjectId, assuranceLevel, parentRole, humanName, backend, agentType, field, standalone, status,
     ownerStatus, ownerOsUser, ownerPrincipalId, ownerConfirmedAt, ownerConfirmedBy)
    VALUES (@id, @kind, @name, @subjectId, @assuranceLevel, @parentRole, @humanName, @backend, @agentType, @field, @standalone, @status,
     @ownerStatus, @ownerOsUser, @ownerPrincipalId, @ownerConfirmedAt, @ownerConfirmedBy)`),
  findPrincipalById: db.prepare('SELECT * FROM principals WHERE id = ?'),
  findPrincipalByKindName: db.prepare('SELECT * FROM principals WHERE kind = ? AND name = ?'),
  findPrincipalBySubjectId: db.prepare('SELECT * FROM principals WHERE subjectId = ?'),
  // `name` is a display label, so unlike the identity columns below it is *meant* to be rewritten
  // when the label changes — an OS account renamed, a nickname changed. Nothing is keyed on it for
  // a subject row (that's subjectId), so a rename re-attributes nothing.
  updatePrincipalName: db.prepare('UPDATE principals SET name = @name WHERE id = @id'),
  // Raises the recorded assurance tier of a subject — never lowers it here; see
  // `upsertSubjectPrincipal` for why a downgrade is a claim about one call, not about the row.
  updatePrincipalAssurance: db.prepare('UPDATE principals SET assuranceLevel = @assuranceLevel WHERE id = @id'),
  updatePrincipalStatus: db.prepare('UPDATE principals SET status = @status WHERE id = @id'),
  // The human's answer to an owner proposal (§1.6 phase 4). Every column here is written together
  // — a decision is one act — so there is no partial state where an instance is 'confirmed' with
  // no osUser or 'unassigned' with a confirmedAt.
  updatePrincipalOwner: db.prepare(`UPDATE principals SET
    ownerStatus = @ownerStatus, ownerOsUser = @ownerOsUser, ownerPrincipalId = @ownerPrincipalId,
    ownerConfirmedAt = @ownerConfirmedAt, ownerConfirmedBy = @ownerConfirmedBy WHERE id = @id`),
  // Evidence for the owner proposal: the (osUser, hostname) pairs actually seen on an instance's
  // events, most-used first. Grouped in SQL rather than pulled into JS because usage_events is the
  // largest table here and this runs on a dashboard load. Blank-but-not-null osUser values are
  // excluded alongside NULLs — an empty string is a hook that reported no identity, not a person.
  listOwnerEvidence: db.prepare(`SELECT principalId, osUser, hostname,
      COUNT(*) AS events, MAX(ts) AS lastSeenAt, MIN(ts) AS firstSeenAt
    FROM usage_events
    WHERE osUser IS NOT NULL AND TRIM(osUser) != ''
    GROUP BY principalId, osUser, hostname
    ORDER BY events DESC`),
  // Denominator for the proposal's confidence: how many events the instance has at all, so a
  // 3-of-3 modal osUser on an agent with 900 identity-less events doesn't read as certainty.
  countEventsByPrincipal: db.prepare(`SELECT principalId,
      COUNT(*) AS events,
      SUM(CASE WHEN osUser IS NULL OR TRIM(osUser) = '' THEN 1 ELSE 0 END) AS eventsWithoutOsUser
    FROM usage_events GROUP BY principalId`),
  // Identity-metadata refresh for the narrow principal upsert below. Deliberately cannot touch
  // `status` (that's POST /api/principals/:id/approve's job alone) or `kind`/`name`, which are
  // the row's key.
  updatePrincipalIdentity: db.prepare(`UPDATE principals SET
    parentRole = @parentRole, humanName = @humanName, backend = @backend,
    agentType = @agentType, field = @field, standalone = @standalone WHERE id = @id`),

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

  insertAuditEntry: db.prepare(`INSERT INTO windrow_audit
    (id, action, actorScope, osUser, hostname, principalId, capabilityId, grantId, before, after, reason, createdAt)
    VALUES (@id, @action, @actorScope, @osUser, @hostname, @principalId, @capabilityId, @grantId, @before, @after, @reason, @createdAt)`),
  listAuditEntries: db.prepare('SELECT * FROM windrow_audit ORDER BY createdAt DESC'),
  listAuditEntriesByGrant: db.prepare('SELECT * FROM windrow_audit WHERE grantId = ? ORDER BY createdAt DESC'),

  listUsageEvents: db.prepare('SELECT * FROM usage_events ORDER BY ts DESC'),
  insertUsageEvent: db.prepare(`INSERT INTO usage_events
    (id, nodeId, incarnation, seq, observedAt, principalId, capabilityId, ts, outcome, latencyMs, correlationId, reason,
     capabilityLookupMs, principalResolveMs, brokerMs, grantCheckMs, osUser, hostname,
     actorLoomId, actorAgentType, actorBackend, actorField, subjectId, assuranceLevel,
     shadowOutcome, shadowReason, shadowPrincipalId, correctedAt, toolInputDigest, extra)
    VALUES (@id, @nodeId, @incarnation, @seq, @observedAt, @principalId, @capabilityId, @ts, @outcome, @latencyMs, @correlationId, @reason,
     @capabilityLookupMs, @principalResolveMs, @brokerMs, @grantCheckMs, @osUser, @hostname,
     @actorLoomId, @actorAgentType, @actorBackend, @actorField, @subjectId, @assuranceLevel,
     @shadowOutcome, @shadowReason, @shadowPrincipalId, @correctedAt, @toolInputDigest, @extra)`),
  findUsageEvent: db.prepare('SELECT * FROM usage_events WHERE id = ?'),
  // Where in its own node's chain a row sits — the coordinate a correcting PATCH has to re-chain
  // from, now that "the rows after this one" means this node's, not this db's.
  findUsageEventSlot: db.prepare('SELECT nodeId, incarnation, seq FROM usage_events WHERE id = ?'),
  updateUsageEvent: db.prepare(
    `UPDATE usage_events SET outcome = @outcome, latencyMs = @latencyMs, reason = @reason,
     capabilityLookupMs = @capabilityLookupMs, principalResolveMs = @principalResolveMs,
     brokerMs = @brokerMs, grantCheckMs = @grantCheckMs, correctedAt = @correctedAt WHERE id = @id`
  ),

  // usage_outbox (§2.3). The insert runs inside insertUsageEventTx/patchUsageEventTx, so it is on
  // the same write path as a governed tool call and is prepared here with everything else rather
  // than built per call.
  insertOutbox: db.prepare(`INSERT INTO usage_outbox
    (nodeId, incarnation, seq, kind, eventId, urgent, payload, enqueuedAt, attempts, lastAttemptAt, lastError)
    VALUES (@nodeId, @incarnation, @seq, @kind, @eventId, @urgent, @payload, @enqueuedAt, 0, NULL, NULL)`),
  // Oldest first — see the index comment on the table. LIMIT is always bound: an outbox that
  // accumulated for a week offline must not be read into memory whole.
  // Every outbox read and write is scoped to ONE LIFETIME. The shipment counter restarts with the
  // incarnation, so `seq` alone stopped being unique per node the moment item 5 landed: a batch
  // read without the incarnation would interleave two lifetimes' shipments under one sequence and
  // hand central a stream that looks reordered.
  //
  // A DELIBERATE EXCEPTION IS `listOutboxAnyIncarnation`. A node that restarted with shipments
  // still queued has a previous lifetime's rows nobody would otherwise ever drain, and those rows
  // are governed decisions. scripts/retire.js and the shipper's catch-up both read through it.
  listOutboxBatch: db.prepare(
    'SELECT * FROM usage_outbox WHERE nodeId = ? AND incarnation = ? ORDER BY seq ASC LIMIT ?'
  ),
  listOutboxAnyIncarnation: db.prepare(
    'SELECT * FROM usage_outbox WHERE nodeId = ? ORDER BY incarnation ASC, seq ASC LIMIT ?'
  ),
  deleteOutboxRow: db.prepare('DELETE FROM usage_outbox WHERE nodeId = ? AND incarnation = ? AND seq = ?'),
  markOutboxAttempt: db.prepare(`UPDATE usage_outbox
    SET attempts = attempts + 1, lastAttemptAt = @lastAttemptAt, lastError = @lastError
    WHERE nodeId = @nodeId AND incarnation = @incarnation AND seq = @seq`),
  maxOutboxSeq: db.prepare('SELECT MAX(seq) AS seq FROM usage_outbox WHERE nodeId = ? AND incarnation = ?'),
  countOutbox: db.prepare(`SELECT
      COUNT(*) AS pending,
      SUM(CASE WHEN urgent = 1 THEN 1 ELSE 0 END) AS urgentPending,
      MIN(enqueuedAt) AS oldestEnqueuedAt,
      MAX(attempts) AS maxAttempts
    FROM usage_outbox WHERE nodeId = ?`),
  lastOutboxError: db.prepare(`SELECT lastError, lastAttemptAt FROM usage_outbox
    WHERE nodeId = ? AND lastError IS NOT NULL ORDER BY lastAttemptAt DESC LIMIT 1`),
  // Retention backstop, not a normal path — see trimUsageOutbox. Deliberately across every
  // lifetime and oldest-lifetime-first: if a queue has to be trimmed, the shipments from a
  // rebuild three weeks ago are the ones to lose before today's.
  trimOutbox: db.prepare(`DELETE FROM usage_outbox WHERE rowid IN (
    SELECT rowid FROM usage_outbox WHERE nodeId = @nodeId
    ORDER BY incarnation ASC, seq ASC LIMIT @drop)`),

  // native_tool_events. Every read below takes its filters as nullable bound parameters and
  // neutralises them with `@x IS NULL OR col = @x`, so one prepared statement serves the filtered
  // and unfiltered cases. That is worth more on this table than elsewhere: it is the only one read
  // on a dashboard poll AND written in bulk by the drain, so a statement rebuilt per request would
  // be re-planned against a table two orders of magnitude larger than any other here.
  insertNativeToolEvent: db.prepare(`INSERT OR IGNORE INTO native_tool_events
    (id, principalId, toolName, detail, ts, outcome, reason, sessionId,
     actorLoomId, actorHumanName, actorAgentType, actorBackend, actorField, osUser, hostname)
    VALUES (@id, @principalId, @toolName, @detail, @ts, @outcome, @reason, @sessionId,
     @actorLoomId, @actorHumanName, @actorAgentType, @actorBackend, @actorField, @osUser, @hostname)`),
  listNativeToolEvents: db.prepare(`SELECT * FROM native_tool_events
    WHERE (@principalId IS NULL OR principalId = @principalId)
      AND (@toolName IS NULL OR toolName = @toolName)
      AND (@since IS NULL OR ts >= @since)
    ORDER BY ts DESC LIMIT @limit`),
  summarizeNativeToolEvents: db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied,
      MIN(ts) AS observedFrom,
      MAX(ts) AS observedTo
    FROM native_tool_events WHERE (@since IS NULL OR ts >= @since)`),
  summarizeNativeToolEventsByTool: db.prepare(`SELECT
      toolName,
      COUNT(*) AS count,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM native_tool_events WHERE (@since IS NULL OR ts >= @since)
    GROUP BY toolName ORDER BY count DESC`),
  // LEFT JOIN, not an inner one: a principal row deleted out from under its observations must cost
  // the row its name, not its existence — the call still happened.
  //
  // humanName BEFORE name, unlike most reads of this table: an instance principal's `name` is its
  // loom id, so this card would otherwise be a list of `claude-mt05yzju-46`s. Every other consumer
  // of a principal name is answering "which row is this" and wants the stable id; this one is
  // answering "who has been busy", where the id is unreadable and the loom's human name — Finn,
  // Hana — is the whole answer.
  summarizeNativeToolEventsByPrincipal: db.prepare(`SELECT
      e.principalId AS principalId,
      COALESCE(MAX(e.actorHumanName), p.humanName, p.name, e.actorLoomId, e.principalId) AS name,
      COUNT(*) AS count
    FROM native_tool_events e LEFT JOIN principals p ON p.id = e.principalId
    WHERE (@since IS NULL OR e.ts >= @since)
    GROUP BY e.principalId ORDER BY count DESC`),
  // Calls-over-time. Buckets are cut with strftime rather than substr(ts, 1, n) because `ts` is
  // whatever ISO string the hook recorded — a string prefix would file an offset timestamp
  // ("…T14:03+02:00") under the wrong hour, whereas strftime normalises to UTC first. The format
  // string is bound, not interpolated, so one prepared statement serves all three grains.
  bucketNativeToolEvents: db.prepare(`SELECT
      strftime(@format, ts) AS bucket,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM native_tool_events
    WHERE (@since IS NULL OR ts >= @since)
      AND (@toolName IS NULL OR toolName = @toolName)
    GROUP BY bucket ORDER BY bucket ASC`),
  pruneNativeToolEvents: db.prepare('DELETE FROM native_tool_events WHERE ts < @cutoff'),
  // The same retention, but sparing rows central has not confirmed — see pruneNativeToolEvents
  // below for why that is a different statement rather than a parameter on the one above.
  pruneShippedNativeToolEvents: db.prepare(
    'DELETE FROM native_tool_events WHERE ts < @cutoff AND shippedAt IS NOT NULL'
  ),
  // The shipper's queue read: unshipped, oldest first, so central receives them in the order this
  // node observed them. Served by idx_native_unshipped.
  listUnshippedNativeToolEvents: db.prepare(
    'SELECT * FROM native_tool_events WHERE shippedAt IS NULL ORDER BY ts ASC LIMIT @limit'
  ),
  countUnshippedNativeToolEvents: db.prepare(
    'SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM native_tool_events WHERE shippedAt IS NULL'
  ),
  markNativeToolEventShipped: db.prepare(
    'UPDATE native_tool_events SET shippedAt = @shippedAt WHERE id = @id AND shippedAt IS NULL'
  ),
  // The backstop for a node that has not reached central in a very long time. Drops the OLDEST
  // unshipped rows — the same direction trimUsageOutbox drops in, and for the same reason: what
  // has been happening recently is the question anyone actually asks.
  trimUnshippedNativeToolEvents: db.prepare(`DELETE FROM native_tool_events WHERE id IN (
    SELECT id FROM native_tool_events WHERE shippedAt IS NULL ORDER BY ts ASC LIMIT @drop)`),
  // Re-points observations parked under a placeholder principal id onto the real row once one
  // exists — see reassignNativeToolEventPrincipal. Keyed on principalId, which is indexed, so
  // this is a lookup and not a scan over the largest table here.
  reassignNativeToolEventPrincipal: db.prepare(
    'UPDATE native_tool_events SET principalId = @to WHERE principalId = @from'
  ),

  setCapabilityDiscoveryState: db.prepare(`UPDATE capabilities SET
      source = @source, discoveredAt = @discoveredAt, lastSeenAt = @lastSeenAt,
      stale = @stale, realUsage = @realUsage
    WHERE id = @id`),
  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  // policy_changes (§2.4) — the delta channel's log.
  insertPolicyChange: db.prepare(
    'INSERT INTO policy_changes (entity, entityId, op, row, ts) VALUES (@entity, @entityId, @op, @row, @ts)'
  ),
  // COALESCE, because MAX() over an empty table is NULL and "there is no policy yet" must read as
  // version 0 rather than as a missing number every caller has to defend against.
  policyVersion: db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM policy_changes'),
  // The oldest version still retained. A node whose `since` predates this cannot be caught up by
  // deltas and has to be handed a snapshot — see listPolicyChanges/policyDelta.
  policyChangeFloor: db.prepare('SELECT COALESCE(MIN(version), 0) AS floor FROM policy_changes'),
  listPolicyChangesSince: db.prepare(
    'SELECT version, entity, entityId, op, row, ts FROM policy_changes WHERE version > @since ORDER BY version ASC LIMIT @limit'
  ),
  countPolicyChangesSince: db.prepare('SELECT COUNT(*) AS n FROM policy_changes WHERE version > @since'),
  // The always-full deny-list (§2.4). Deliberately a query over `grants`, not a separate table that
  // could disagree with it: a revoked grant IS the deny-list entry, so there is no second write to
  // forget. It stays small because it is monotone and narrow — ids only, no constraints blob.
  listRevokedGrants: db.prepare(
    'SELECT id, principalId, capabilityId, revokedAt FROM grants WHERE revokedAt IS NOT NULL ORDER BY revokedAt ASC'
  ),
  // A principal that is not 'active' must stop working for the same reason a revoked grant must,
  // and by the same channel: 'denied' is an explicit refusal and 'pending' holds zero grants.
  listBlockedPrincipals: db.prepare("SELECT id, status FROM principals WHERE status <> 'active'"),
  deletePolicyChangesBefore: db.prepare('DELETE FROM policy_changes WHERE version <= @keepBelow'),
  countPolicyChanges: db.prepare('SELECT COUNT(*) AS n FROM policy_changes'),

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

  // Node enrollment (§2.5). See the two table definitions in the schema block for what these are
  // and why the certificate identity is stored beside the node.
  insertEnrollmentToken: db.prepare(`INSERT INTO enrollment_tokens
    (id, tokenHash, label, scope, createdAt, createdByScope, expiresAt, maxUses, uses)
    VALUES (@id, @tokenHash, @label, @scope, @createdAt, @createdByScope, @expiresAt, @maxUses, 0)`),
  findEnrollmentTokenByHash: db.prepare('SELECT * FROM enrollment_tokens WHERE tokenHash = ?'),
  findEnrollmentTokenById: db.prepare('SELECT * FROM enrollment_tokens WHERE id = ?'),
  listEnrollmentTokens: db.prepare('SELECT * FROM enrollment_tokens ORDER BY createdAt DESC'),
  // THE single-use gate, and the reason it is one statement rather than a read followed by a
  // write: every condition that makes the token spendable is in the WHERE clause, so SQLite
  // evaluates and applies them under the same write lock. Two enrolments racing this see
  // `changes` 1 and 0 — there is no window between the check and the claim for the second to
  // squeeze into, which a SELECT-then-UPDATE would leave wide open and which would issue two
  // certificates against one token.
  // THE USE GATE. Was single-use; since docs/design/dashboard-placement.md item 7 it is
  // bounded-use, and the change is one clause: `usedAt IS NULL` became `uses < maxUses`. Still one
  // statement rather than a read followed by a write, and still for the same reason — every
  // condition that makes the token spendable is in the WHERE, so SQLite evaluates and applies them
  // under one write lock. Two enrolments racing a token with one use left see `changes` 1 and 0,
  // with no window between the check and the claim.
  //
  // `usedAt`/`usedByNodeId` now record the LATEST use rather than the only one. That is what they
  // always read like, and the count is what enforces the ceiling.
  consumeEnrollmentToken: db.prepare(`UPDATE enrollment_tokens
    SET usedAt = @usedAt, usedByNodeId = @nodeId, uses = uses + 1
    WHERE id = @id AND uses < maxUses AND revokedAt IS NULL
      AND (expiresAt IS NULL OR expiresAt > @now)`),
  revokeEnrollmentToken: db.prepare(
    'UPDATE enrollment_tokens SET revokedAt = @revokedAt WHERE id = @id AND revokedAt IS NULL'
  ),

  insertNode: db.prepare(`INSERT INTO nodes
    (id, nodeId, label, scope, enrolledAt, publicKey, certSerial, certFingerprint, certNotAfter)
    VALUES (@id, @nodeId, @label, @scope, @enrolledAt, @publicKey, @certSerial, @certFingerprint, @certNotAfter)`),
  // Certificate renewal for a node already enrolled: the credential changes, the node does not, so
  // `enrolledAt` deliberately keeps saying when this node first joined.
  updateNodeCert: db.prepare(`UPDATE nodes SET
    label = @label, scope = @scope, publicKey = @publicKey, certSerial = @certSerial,
    certFingerprint = @certFingerprint, certNotAfter = @certNotAfter
    WHERE nodeId = @nodeId AND revokedAt IS NULL`),
  // On the request path for every authenticated call — one indexed equality lookup, and the reason
  // idx_nodes_certSerial exists.
  findNodeByCertSerial: db.prepare('SELECT * FROM nodes WHERE certSerial = ?'),
  findNodeByNodeId: db.prepare('SELECT * FROM nodes WHERE nodeId = ?'),
  listNodes: db.prepare('SELECT * FROM nodes ORDER BY enrolledAt DESC'),
  revokeNode: db.prepare(
    'UPDATE nodes SET revokedAt = @revokedAt, revokedReason = @revokedReason WHERE nodeId = @nodeId AND revokedAt IS NULL'
  ),

  deleteAllCapabilities: db.prepare('DELETE FROM capabilities'),
  deleteAllPrincipals: db.prepare('DELETE FROM principals'),
  deleteAllGrants: db.prepare('DELETE FROM grants'),
  deleteAllUsageEvents: db.prepare('DELETE FROM usage_events'),
  deleteAllChainHeads: db.prepare('DELETE FROM usage_chain_heads'),
};

// ---------------------------------------------------------------------------
// Atomic per-row API — the HTTP hot path (app.js) uses this directly
// ---------------------------------------------------------------------------

class GrantConflictError extends Error {}
class CapabilityConflictError extends Error {}
class PrincipalConflictError extends Error {}

// ---------------------------------------------------------------------------
// REPLICA MODE — phase 4 of docs/design/global-identity-and-central-db.md §2.7
//
// When central owns policy (server/policy/authority.js), the three tables below this comment stop
// being *this* machine's registry and become a mirror of central's. The rows stay exactly where
// they were — that is what keeps `findActiveGrant` a local prepared statement and the hot path
// unchanged — but there is now precisely one way for a row to get into them: applyPolicyReplica,
// fed by a delta the policy client pulled and verified.
//
// The lock is not belt-and-braces. Without it, phase 4 would be a convention: server/app.js would
// route its writes to central, and the next caller to reach `store.insertGrant` directly — a
// script, a migration, a route written next year — would mint a row central has never heard of,
// which every subsequent delta would then silently fail to correct. §2.2's whole premise is that
// "neither direction ever has two writers for the same row"; this is the sentence enforced.
//
// A REFUSAL IS AN ERROR, NOT A NO-OP. A silently-dropped policy write is the worst available
// outcome: the caller believes the grant exists, the dashboard shows nothing, and the disagreement
// surfaces later as an inexplicable denial. PolicyReadOnlyError says which call was refused and
// where the write belongs, so a route that has not been pointed at central yet fails loudly the
// first time it is exercised rather than the first time someone audits it.
// ---------------------------------------------------------------------------

class PolicyReadOnlyError extends Error {}

let policyReadOnly = false;
// Re-entrancy: applyPolicyReplica is the one writer allowed through the lock, and it writes through
// its own statements rather than through the guarded functions, so this flag exists for the case
// where a future applier reaches one of them. Scoped to the synchronous body of the apply
// transaction — better-sqlite3 has no async inside a transaction, so there is no interleaving that
// could leave it stuck on.
let applyingReplica = false;

/** Put this node into (or out of) replica mode. Called once at boot by server/index.js. */
function setPolicyReadOnly(value) {
  policyReadOnly = Boolean(value);
  // Drop any hydrated index on a mode change so a node (or a test) that re-enters replica mode never
  // serves rows from a previous life — the next pull rebuilds it before any read consults it.
  replicaIndex = null;
  return policyReadOnly;
}

function isPolicyReadOnly() {
  return policyReadOnly;
}

function guardPolicyWrite(name) {
  if (!policyReadOnly || applyingReplica) return;
  throw new PolicyReadOnlyError(
    `${name}() is refused: central owns policy on this node (WINDROW_POLICY_AUTHORITY=central), so `
      + 'capabilities, principals and grants here are a read replica. Send this write to central '
      + '(server/policy/centralPolicyStore.js) — a row written locally would be a row no delta can correct.'
  );
}

/** Wrap a policy mutator so every caller — route, script or migration — meets the same refusal.
 *  Applied at the export boundary rather than inside each function so that adding a mutator and
 *  forgetting the guard is visible as a name missing from one list. */
function readOnlyGuarded(name, fn) {
  return (...args) => {
    guardPolicyWrite(name);
    return fn(...args);
  };
}

/** The replica's version and the schema it was stamped with, so `GET /api/policy/status` and the
 *  hook can both answer "how current is this mirror" from the database rather than from the JSON
 *  file the client happens to keep beside it. */
const POLICY_REPLICA_VERSION_KEY = 'policy_replica_version';
const POLICY_REPLICA_STAMP_KEY = 'policy_replica_stamped_at';

function policyReplicaState() {
  const version = stmts.getKv.get(POLICY_REPLICA_VERSION_KEY);
  const stamped = stmts.getKv.get(POLICY_REPLICA_STAMP_KEY);
  return {
    version: version ? Number(version.value) : 0,
    stampedAt: stamped ? stamped.value : null,
  };
}

// ---------------------------------------------------------------------------
// IN-MEMORY REPLICA INDEX — step 1 of docs/design/retiring-sqlite-on-the-node.md
//
// On a replica node the three tables above (capabilities, principals, grants) are a mirror of
// central, refetched wholesale on every policy pull and never written locally except by
// applyPolicyReplica and the two node-local column writers (setCapabilityDiscoveryState,
// setPrincipalOwnerLocal). The whole replica is ~700 rows and the server is long-lived, so the read
// side needs no database at all: an in-memory index hydrated once per pull answers findGrant,
// findPrincipalByKindName and the rest from a Map, which is synchronous and cheaper than the two
// prepared statements it stands in front of on the hot path (server/app.js's findActiveGrant).
//
// WHY THIS IS THE SAFE, STANDALONE HALF. It deletes nothing, changes no on-disk format, and reads
// through to the very same SQLite it caches: the index is BUILT from the store's own statements
// right after every write that could move these tables, so a stale index is impossible without a
// missed write hook, and the escape hatch (WINDROW_REPLICA_INDEX=off) drops straight back to reading
// SQLite per call with no other change. That reversibility is the point of shipping it before the
// write side moves — see the design note's "cheap half, ships on its own".
//
// SCOPED TO REPLICA MODE. The index is only consulted when this node is a policy replica
// (`policyReadOnly`), because that is the only mode in which these tables have exactly the three
// writers above; a standalone/authoritative node writes them through many paths and keeps reading
// SQLite directly, exactly as before.

const REPLICA_INDEX_ENABLED = envCompat('REPLICA_INDEX', { fallback: 'on' }) !== 'off';

/** Composite key for the (kind, name) principal lookup — NUL-joined so no pair of real values can
 *  collide with another by concatenation. */
function kindNameKey(kind, name) {
  return `${kind ?? ''} ${name ?? ''}`;
}

// null until the first build. A null index means "not hydrated yet" and every read falls through to
// SQLite, so the window between boot and the first pull behaves exactly as it does today.
let replicaIndex = null;

/**
 * Rebuild the whole index from SQLite. Called after applyPolicyReplica (the pull) and after a
 * node-local owner write; ~700 rows, synchronous, and reads through the raw statements rather than
 * the guarded/gated exports so it can never recurse into itself.
 *
 * Grants are indexed from the full set (including revoked) so findGrantById still sees history; the
 * active list is filtered off it and keeps `listAllGrants`' `createdAt DESC` order, which is the
 * order every grant list statement uses, so a JS filter over it reproduces each query exactly.
 */
function rebuildReplicaIndex() {
  const capabilities = stmts.listCapabilities.all().map(capOut);
  const principals = stmts.listPrincipals.all().map(principalOut);
  const grants = stmts.listAllGrants.all();

  const capById = new Map();
  for (const c of capabilities) capById.set(c.id, c);

  const prinById = new Map();
  const prinByKindName = new Map();
  const prinBySubjectId = new Map();
  for (const p of principals) {
    prinById.set(p.id, p);
    // First writer wins, matching `SELECT ... LIMIT 1`'s `.get()` — only `user` rows can share a
    // (kind, name) pair and none of the (kind, name) callers pass 'user'.
    const kn = kindNameKey(p.kind, p.name);
    if (!prinByKindName.has(kn)) prinByKindName.set(kn, p);
    if (p.subjectId != null && !prinBySubjectId.has(p.subjectId)) prinBySubjectId.set(p.subjectId, p);
  }

  const grantById = new Map();
  for (const g of grants) grantById.set(g.id, g);
  const activeGrants = grants.filter((g) => g.revokedAt == null);

  replicaIndex = { capabilities, capById, principals, prinById, prinByKindName, prinBySubjectId, grantById, activeGrants };
}

/** Refresh a single capability in place — the node-local discovery write touches one row and runs
 *  in bursts, so a targeted update beats a full rebuild. A no-op when the id is not in the mirror,
 *  which mirrors setCapabilityDiscoveryState's own no-op for an unknown id. */
function refreshCapabilityInIndex(id) {
  if (!replicaIndex) return;
  const row = capOut(stmts.findCapabilityById.get(id));
  if (!row) return;
  replicaIndex.capById.set(row.id, row);
  const idx = replicaIndex.capabilities.findIndex((c) => c.id === row.id);
  if (idx >= 0) replicaIndex.capabilities[idx] = row;
  else replicaIndex.capabilities.push(row);
}

/** True when reads should be served from the index: enabled, this node is a replica, and the index
 *  has been hydrated at least once. */
function replicaIndexActive() {
  return REPLICA_INDEX_ENABLED && policyReadOnly && replicaIndex !== null;
}

// Upserts keyed on `id`, because `id` is what central minted and what every grant, usage event and
// audit row points at. `kind`/`name` is only a lookup.
//
// CAPABILITIES ARE UPDATED COLUMN BY COLUMN, not replaced. `source`, `discoveredAt`, `lastSeenAt`,
// `stale` and `realUsage` are this machine's own discovery state (see the note on migration 3 in
// server/central/centralMigrations.js) and central holds no opinion about them — an `excluded.*` on
// those would blank a node's record of its own filesystem every time an unrelated capability
// changed centrally.
const replicaStmts = {
  upsertCapability: db.prepare(`
    INSERT INTO capabilities (id, kind, name, owner, riskTier, description, autoGrant)
    VALUES (@id, @kind, @name, @owner, @riskTier, @description, @autoGrant)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, owner = excluded.owner,
      riskTier = excluded.riskTier, description = excluded.description, autoGrant = excluded.autoGrant
  `),
  upsertPrincipal: db.prepare(`
    INSERT INTO principals (id, kind, name, subjectId, assuranceLevel, parentRole, humanName, backend,
                            agentType, field, standalone, status)
    VALUES (@id, @kind, @name, @subjectId, @assuranceLevel, @parentRole, @humanName, @backend,
            @agentType, @field, @standalone, @status)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, subjectId = excluded.subjectId,
      assuranceLevel = excluded.assuranceLevel, parentRole = excluded.parentRole,
      humanName = excluded.humanName, backend = excluded.backend, agentType = excluded.agentType,
      field = excluded.field, standalone = excluded.standalone, status = excluded.status
  `),
  upsertGrant: db.prepare(`
    INSERT INTO grants (id, principalId, capabilityId, constraints, createdAt, expiresAt, revokedAt, revokedBy)
    VALUES (@id, @principalId, @capabilityId, @constraints, @createdAt, @expiresAt, @revokedAt, @revokedBy)
    ON CONFLICT(id) DO UPDATE SET
      principalId = excluded.principalId, capabilityId = excluded.capabilityId,
      constraints = excluded.constraints, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt,
      revokedAt = excluded.revokedAt, revokedBy = excluded.revokedBy
  `),
  // The three collision clearers. A node that ran phase 3 minted its own ids, so its
  // `mcp/slack.post` and central's are the same capability under two ids — and the node's UNIQUE
  // indexes are on the natural keys, not on `id`, so the replica row cannot land until the
  // locally-minted one is out of the way. Deleting it is right rather than harsh: it is a row the
  // fleet has never heard of, nothing outside this machine references it, and the alternative is a
  // replica that silently stops applying at the first collision.
  displaceCapability: db.prepare('DELETE FROM capabilities WHERE kind IS ? AND name = ? AND id <> ?'),
  displacePrincipal: db.prepare('DELETE FROM principals WHERE kind = ? AND name = ? AND id <> ?'),
  displacePrincipalSubject: db.prepare('DELETE FROM principals WHERE subjectId = ? AND id <> ?'),
  displaceGrant: db.prepare(
    'DELETE FROM grants WHERE principalId = ? AND capabilityId = ? AND revokedAt IS NULL AND id <> ?'
  ),
  // Reset only: everything central's snapshot did not mention no longer exists.
  keepCapabilities: db.prepare('DELETE FROM capabilities WHERE id NOT IN (SELECT value FROM json_each(?))'),
  keepPrincipals: db.prepare('DELETE FROM principals WHERE id NOT IN (SELECT value FROM json_each(?))'),
  keepGrants: db.prepare('DELETE FROM grants WHERE id NOT IN (SELECT value FROM json_each(?))'),
};

/**
 * Write one applied delta (or one reset snapshot) into the mirror.
 *
 * THE ONE WRITE PATH INTO POLICY ON A REPLICA NODE, and the reason this lives in store.js rather
 * than in server/policy/: it needs the same prepared statements and the same transaction as every
 * other write here, and a version of it built on `load()`/`save()` would be the whole-table replace
 * phase 0 exists to remove — issued, this time, on a timer.
 *
 * ONE TRANSACTION for the whole batch. A half-applied delta is the state with no honest reading: a
 * grant present without the capability it points at reads as a broken registry rather than as an
 * interrupted sync, and the hook cannot tell the difference. All or nothing means the mirror is
 * always *some* consistent version of central, even if it is not the newest one.
 *
 * NOTHING HERE APPENDS TO `policy_changes`. That log is the authority's, and on a replica it is
 * dead weight at best — a node that logged its own replication would be serving a second, divergent
 * version history to anything that asked it for a delta. server/app.js stops mounting the node's
 * own /api/policy in replica mode for the same reason.
 *
 * @param {{reset?: boolean, version: number, capabilities?: object[], principals?: object[],
 *          grants?: object[]}} snapshot
 */
const applyPolicyReplicaTx = db.transaction((snapshot) => {
  const capabilities = snapshot.capabilities || [];
  const principals = snapshot.principals || [];
  const grants = snapshot.grants || [];

  if (snapshot.reset) {
    // Order matters on the way out as much as on the way in: grants first, so removing a principal
    // or capability never leaves a grant pointing at nothing even momentarily.
    replicaStmts.keepGrants.run(JSON.stringify(grants.map((g) => g.id)));
    replicaStmts.keepCapabilities.run(JSON.stringify(capabilities.map((c) => c.id)));
    replicaStmts.keepPrincipals.run(JSON.stringify(principals.map((p) => p.id)));
  }

  for (const cap of capabilities) {
    replicaStmts.displaceCapability.run(cap.kind ?? null, cap.name, cap.id);
    replicaStmts.upsertCapability.run({
      id: cap.id,
      kind: cap.kind ?? null,
      name: cap.name,
      owner: cap.owner ?? null,
      riskTier: cap.riskTier,
      description: cap.description ?? null,
      autoGrant: cap.autoGrant ? 1 : 0,
    });
  }

  for (const p of principals) {
    replicaStmts.displacePrincipal.run(p.kind, p.name, p.id);
    if (p.subjectId) replicaStmts.displacePrincipalSubject.run(p.subjectId, p.id);
    replicaStmts.upsertPrincipal.run({
      id: p.id,
      kind: p.kind,
      name: p.name,
      subjectId: p.subjectId ?? null,
      assuranceLevel: p.assuranceLevel ?? null,
      parentRole: p.parentRole ?? null,
      humanName: p.humanName ?? null,
      backend: p.backend ?? null,
      agentType: p.agentType ?? null,
      field: p.field ?? null,
      standalone: p.standalone ? 1 : 0,
      status: p.status || 'active',
    });
  }

  for (const g of grants) {
    // Only a LIVE grant can collide — the partial unique index is scoped to `revokedAt IS NULL` —
    // and displacing on a revoke would delete the very row the deny-list is about to name.
    if (!g.revokedAt) replicaStmts.displaceGrant.run(g.principalId, g.capabilityId, g.id);
    replicaStmts.upsertGrant.run({
      id: g.id,
      principalId: g.principalId,
      capabilityId: g.capabilityId,
      constraints: g.constraints ?? null,
      createdAt: g.createdAt,
      expiresAt: g.expiresAt ?? null,
      revokedAt: g.revokedAt ?? null,
      revokedBy: g.revokedBy ?? null,
    });
  }

  stmts.setKv.run(POLICY_REPLICA_VERSION_KEY, String(snapshot.version ?? 0));
  stmts.setKv.run(POLICY_REPLICA_STAMP_KEY, new Date().toISOString());
  return { capabilities: capabilities.length, principals: principals.length, grants: grants.length };
});

function applyPolicyReplica(snapshot) {
  applyingReplica = true;
  try {
    const result = applyPolicyReplicaTx(snapshot);
    // Rehydrate the in-memory index from the rows this pull just wrote — this is the "rebuilt on
    // every pull" the design turns on. Done after the transaction commits, so the index never
    // reflects a half-applied delta, and only when enabled to keep the standalone path untouched.
    if (REPLICA_INDEX_ENABLED) rebuildReplicaIndex();
    return result;
  } finally {
    applyingReplica = false;
  }
}

/**
 * The MACHINE-LOCAL half of a capability row: where this node found it, when it last saw it, and
 * whether it has gone stale. Writable on a replica node, and deliberately not behind the lock.
 *
 * §2.2 puts discovery on the node's side ("filesystem paths are machine-local by nature") while the
 * canonical capability row is central's. These five columns are that split expressed as a
 * statement: central decides what the capability IS and what tier it carries; this node records
 * that it saw a copy of it on its own disk five minutes ago. Shipping them centrally would make the
 * last node to rescan overwrite every other node's record of its own filesystem.
 *
 * A no-op when the id is not in the mirror yet, which is the ordinary case for a capability this
 * node has just proposed and not yet pulled back down.
 */
function setCapabilityDiscoveryState(id, { source, discoveredAt, lastSeenAt, stale, realUsage } = {}) {
  stmts.setCapabilityDiscoveryState.run({
    id,
    source: source ?? null,
    discoveredAt: discoveredAt ?? null,
    lastSeenAt: lastSeenAt ?? null,
    stale: stale ? 1 : 0,
    realUsage: realUsage != null ? JSON.stringify(realUsage) : null,
  });
  // Node-local columns the index also serves — keep it current between pulls. Targeted, not a
  // rebuild, because discovery writes one row at a time in bursts.
  refreshCapabilityInIndex(id);
  return findCapabilityById(id);
}

function listCapabilities() {
  if (replicaIndexActive()) return replicaIndex.capabilities.slice();
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
  recordPolicyChange('capability', cap.id, 'upsert', cap);
  return cap;
}
function findCapabilityById(id) {
  if (replicaIndexActive()) return replicaIndex.capById.get(id) || null;
  return capOut(stmts.findCapabilityById.get(id));
}
/** Callers must check riskTier !== 'destructive' before setting autoGrant true — this layer just
 * persists whatever it's told (app.js's PATCH /api/capabilities/:id/auto-grant is the one gate). */
function setCapabilityAutoGrant(id, autoGrant) {
  stmts.updateCapabilityAutoGrant.run({ id, autoGrant: autoGrant ? 1 : 0 });
  const updated = findCapabilityById(id);
  // autoGrant is an authorization decision (findActiveGrant treats the capability as always
  // granted), so it belongs on the channel exactly as a grant does.
  if (updated) recordPolicyChange('capability', id, 'upsert', updated);
  return updated;
}

function listPrincipals() {
  if (replicaIndexActive()) return replicaIndex.principals.slice();
  return stmts.listPrincipals.all().map(principalOut);
}
/**
 * Throws PrincipalConflictError (mapped to 409 by the caller) if this (kind, name) pair is already
 * registered — `principals` carries a UNIQUE(kind, name) index for every kind but `user`
 * (migration 16), so a registration race can't leave two rows a lookup picks between. A `user`
 * row is exempt because its key is `subjectId`, which has its own UNIQUE index and its own 409 in
 * app.js; a duplicate *label* on a user is legal.
 */
function insertPrincipal(p) {
  try {
    stmts.insertPrincipal.run(principalIn(p));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new PrincipalConflictError('a principal with this kind+name already exists');
    }
    throw err;
  }
  recordPolicyChange('principal', p.id, 'upsert', p);
  return p;
}
function findPrincipalById(id) {
  if (replicaIndexActive()) return replicaIndex.prinById.get(id) || null;
  return principalOut(stmts.findPrincipalById.get(id));
}
function findPrincipalByKindName(kind, name) {
  if (replicaIndexActive()) return replicaIndex.prinByKindName.get(kindNameKey(kind, name)) || null;
  return principalOut(stmts.findPrincipalByKindName.get(kind, name));
}
/** status: 'pending' | 'active' | 'denied'. Callers check the row exists first — this just
 * flips it and returns the updated row. */
function setPrincipalStatus(id, status) {
  stmts.updatePrincipalStatus.run({ id, status });
  const updated = findPrincipalById(id);
  // Status is the other half of the deny-list: a principal moved off 'active' holds no grants, and
  // a node must learn that by the same channel and with the same urgency as a revoke.
  if (updated) recordPolicyChange('principal', id, 'upsert', updated);
  return updated;
}
/**
 * Records a human's decision about who owns an instance principal
 * (docs/design/global-identity-and-central-db.md §1.6 phase 4). Nothing else in this file writes
 * these columns: the proposal is computed on read and stays a proposal until this is called from
 * `POST /api/principals/:id/owner` (server/app.js), which is admin-only.
 *
 * `status` is 'confirmed' (with an `osUser`), 'dismissed' (a human looked and could not name an
 * owner — recorded so the same guess isn't re-proposed forever) or 'unassigned' (reopen: the
 * decision is withdrawn and the instance goes back into the queue).
 */
function setPrincipalOwner(id, { status, osUser = null, ownerPrincipalId = null, decidedByScope = null } = {}) {
  const decided = status === 'unassigned' ? null : new Date().toISOString();
  stmts.updatePrincipalOwner.run({
    id,
    ownerStatus: status,
    // Only a confirmation carries evidence. Dismissing or reopening clears it rather than leaving
    // a stale username on a row that no longer claims one.
    ownerOsUser: status === 'confirmed' ? osUser : null,
    ownerPrincipalId: status === 'confirmed' ? ownerPrincipalId : null,
    ownerConfirmedAt: decided,
    ownerConfirmedBy: decided ? decidedByScope : null,
  });
  const updated = findPrincipalById(id);
  if (updated) recordPolicyChange('principal', id, 'upsert', updated);
  return updated;
}

/**
 * The same write, for a node that is a POLICY REPLICA — and it exists because that node cannot
 * call the function above.
 *
 * `setPrincipalOwner` is exported behind `readOnlyGuarded`, correctly: it is a principals-table
 * write, and on a replica a principals-table write has to go through the seam to central or the
 * node quietly enforces its own opinion. But the owner* columns are the one part of that row
 * central has no column for. §1.6's confirmed/dismissed/unassigned distinction lives here and
 * nowhere else, every reader of it is node-local (server/app.js's `buildOwnerProposals`,
 * server/rollup), and nothing about who a human says owns an agent decides whether that agent may
 * run. So a replica must still be able to record the decision locally, and the guard would refuse.
 *
 * WHAT WENT WRONG WITHOUT IT. `../policy/centralPolicyStore.js` forwarded the decision to central
 * and stopped there, so on a central-authority install the node's owner* columns were never
 * written. `GET /api/principals/owner-proposals` reads exactly those columns, so the dashboard's
 * Confirm button POSTed, got a 200, reloaded and re-rendered the identical unassigned row — a
 * write that succeeds and changes nothing the reader looks at, which from the outside is a dead
 * button.
 *
 * No `recordPolicyChange` here, deliberately, and that is the other half of the same reasoning: on
 * a replica the policy-change log is central's delta stream applied inbound, and a version bump
 * this node invented for a column central does not have would make the mirror claim to be ahead of
 * the authority it mirrors.
 */
function setPrincipalOwnerLocal(id, { status, osUser = null, ownerPrincipalId = null, decidedByScope = null } = {}) {
  const decided = status === 'unassigned' ? null : new Date().toISOString();
  stmts.updatePrincipalOwner.run({
    id,
    ownerStatus: status,
    ownerOsUser: status === 'confirmed' ? osUser : null,
    ownerPrincipalId: status === 'confirmed' ? ownerPrincipalId : null,
    ownerConfirmedAt: decided,
    ownerConfirmedBy: decided ? decidedByScope : null,
  });
  // Owner columns are read back through the index (principalOut carries them). A human deciding an
  // owner is rare enough that a full rebuild is cheaper to keep correct than a per-map splice.
  if (replicaIndex) rebuildReplicaIndex();
  return findPrincipalById(id);
}

/**
 * The raw evidence behind every owner proposal: per instance principal, which OS accounts its
 * calls were actually made under and how often. Two shapes come back — the per-(osUser, hostname)
 * distribution and the per-principal event totals — and the caller (server/app.js's
 * `buildOwnerProposals`) turns them into a ranked proposal. Kept as plain evidence here so the
 * *policy* (what counts as a strong enough signal to show) lives in one place and this stays a
 * query.
 *
 * `osUser` is a bare username off an unauthenticated request body (§1.5), so nothing derived from
 * it is an identity claim — it is the only recorded trace linking a loom to a person, and §1.6 is
 * explicit that the modal value is a suggestion for a human to confirm, never an automatic remap.
 */
function listOwnerEvidence() {
  return {
    byPrincipal: stmts.listOwnerEvidence.all(),
    totals: stmts.countEventsByPrincipal.all(),
  };
}

/** The subject key, which is what a `user` principal is actually keyed on — `name` on that row is
 * a label and repeats freely (two machines' `ejbra` are two subjects with the same label). */
function findPrincipalBySubjectId(subjectId) {
  if (replicaIndexActive()) return replicaIndex.prinBySubjectId.get(subjectId) || null;
  return principalOut(stmts.findPrincipalBySubjectId.get(subjectId));
}
/** Renames the display label. Safe by construction for a `user` row, whose identity is `subjectId`;
 * on a `role`/`instance` row `name` is still the lookup key until phase 5 flips the subject, so
 * renaming one of those orphans it from the identity that resolves to it — which is why the route
 * that exposes this (PATCH /api/principals/:id/name) refuses any kind but `user`. */
function setPrincipalName(id, name) {
  stmts.updatePrincipalName.run({ id, name });
  const updated = findPrincipalById(id);
  if (updated) recordPolicyChange('principal', id, 'upsert', updated);
  return updated;
}

/**
 * Narrow, atomic replacement for the old `load()` → `upsertPrincipalFromIdentity` → `save()`
 * dance that resolved a hook's principal (server/hooks/lib.js). That path rewrote *every table in
 * the database* (`replaceAll`) off a snapshot read moments earlier, triggered by an agent's first
 * tool call — so any grant, capability or usage row written between the read and the save was
 * silently lost. See docs/design/global-identity-and-central-db.md, phase 0.
 *
 * Touches only the two rows an identity actually maps to (its role and its instance), inside one
 * transaction, so a concurrent resolve for a different agent can't clobber it and neither can
 * clobber anything else. Semantics are otherwise identical to principals/registry.js's snapshot
 * version, which stays for seed.js's offline batch build: role is created `pending` with zero
 * grants on first sighting; instance is created with zero grants of its own (it inherits its
 * role's dynamically, at authorization time) and its identity metadata is **write-once** — set at
 * creation, NULLs back-filled later, and a differing observation returned as `identityDrift`
 * rather than overwritten. `mergeObservedIdentity` (principals/registry.js) is the shared rule,
 * required here rather than reimplemented so the two paths cannot drift apart; see
 * docs/design/global-identity-and-central-db.md §1.2 (want-mszgwf94-14) for why overwriting is a
 * correctness bug and not just a modelling wart.
 */
/**
 * Finds or creates the `user` principal for an identity's subject key — the person the call is
 * accountable to, as opposed to the agent that made it (docs/design/global-identity-and-central-db.md
 * §1.2/§1.4, want-mszgwij4-17). Keyed on `subjectId` and nothing else; the UNIQUE index is what
 * makes "one row per subject" a property of the database rather than of this function being the
 * only writer.
 *
 * Phase 1 semantics — **this changes no authorization decision.** The row is created `pending`
 * with zero grants and nothing reads it to authorize anything yet; `findActiveGrant` still resolves
 * instance → parentRole exactly as before. It exists so that the subject is *recorded* from now on,
 * which is the prerequisite for phase 3's shadow evaluation and, eventually, phase 5's flip.
 *
 * `name` here is a display label and nothing else — seeded from the OS username, then owned by
 * whoever edits it (PATCH /api/principals/:id/name). Renaming it is safe in a way that renaming an
 * instance row's `name` is not: the events, grants and audit rows all reference `principals.id`, so
 * a rename re-attributes nothing, and the row is *found* by `subjectId`. That is also why the
 * identity columns on an instance row behave the opposite way (write-once, divergence reported as
 * drift — want-mszgwf94-14): those are joined through to attribute historical events, and this
 * isn't.
 *
 * `assuranceLevel` only ever ratchets up. A run that fails to read the SID and falls back to the
 * tier-1 `env-user:` key produces a *different* subjectId, so it lands on its own row rather than
 * quietly downgrading the assurance of the real one; a same-key downgrade would therefore mean the
 * authority itself got weaker, which is a claim about that one call and not about the identity.
 */
function upsertSubjectPrincipalTx(identity) {
  const subjectId = identity.subjectId;
  if (!subjectId) return { subject: null, subjectCreated: false, subjectRenamed: false };

  const label = identity.osUser || subjectId;
  const assurance = isAssuranceLevel(identity.assuranceLevel) ? identity.assuranceLevel : null;

  let subject = stmts.findPrincipalBySubjectId.get(subjectId);
  if (!subject) {
    subject = {
      id: genId('pr'),
      kind: 'user',
      name: label,
      subjectId,
      assuranceLevel: assurance,
      // A user is not an agent: none of backend/agentType/field/standalone describe a person, so
      // they stay null here rather than being copied off whichever agent happened to be first to
      // report this subject (§1.2 — those are per-call dimensions, not subject attributes).
      parentRole: null,
      status: 'pending',
    };
    stmts.insertPrincipal.run(principalIn(subject));
    return { subject: principalOut(stmts.findPrincipalById.get(subject.id)), subjectCreated: true, subjectRenamed: false };
  }

  // The label is seeded from the OS username at creation and then left to people: a hook resolve
  // does *not* rewrite it. Both directions of that were considered and this one is the only one
  // that doesn't destroy information — the label's whole purpose is to be edited (an OS account
  // called `ejbra` belongs to a person called Eric), so letting every subsequent tool call
  // overwrite it with the raw username would undo `PATCH /principals/:id/name` seconds after an
  // admin used it. A genuinely renamed OS account is a rename here too, made by a human once,
  // rather than a value that flaps on every call. Only a NULL/empty label is filled in.
  let subjectRenamed = false;
  if (label && !subject.name) {
    stmts.updatePrincipalName.run({ id: subject.id, name: label });
    subjectRenamed = true;
  }
  if (assurance !== null && (subject.assuranceLevel === null || assurance > subject.assuranceLevel)) {
    stmts.updatePrincipalAssurance.run({ id: subject.id, assuranceLevel: assurance });
  }
  return { subject: principalOut(stmts.findPrincipalById.get(subject.id)), subjectCreated: false, subjectRenamed };
}

/**
 * Insert a `role`/`instance` row, or return the one that beat us to it. The UNIQUE(kind, name)
 * index (migration 16) is what makes the miss-then-insert below safe, but it is also what turns a
 * lost race into a thrown constraint: two hook processes resolving the same loom's first tool call
 * both SELECT nothing, and the second to reach the write violates the index. That is the correct
 * outcome for the *row* and the wrong one for the *call* — the winner's row is exactly what this
 * caller wanted, so re-read it and carry on rather than failing a tool call over which process got
 * there first. Any other error is a real one and propagates.
 */
function insertPrincipalOrExisting(p) {
  try {
    stmts.insertPrincipal.run(principalIn(p));
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    const existing = stmts.findPrincipalByKindName.get(p.kind, p.name);
    if (!existing) throw err;
    return { row: existing, created: false };
  }
  return { row: stmts.findPrincipalById.get(p.id), created: true };
}

const upsertPrincipalIdentityTx = db.transaction((roleName, identity) => {
  const { mergeObservedIdentity } = require('./principals/registry');

  let instance = stmts.findPrincipalByKindName.get('instance', identity.loomId);
  // The registered role wins over the observed one, for the same reason the registered identity
  // does: a drifting agentType would otherwise mint a phantom `pending` role nothing is parented
  // to. Only an instance that has never had a parentRole takes the caller's roleName.
  const effectiveRoleName = (instance && instance.parentRole) || roleName;

  let role = stmts.findPrincipalByKindName.get('role', effectiveRoleName);
  let roleCreated = false;
  if (!role) {
    const inserted = insertPrincipalOrExisting({
      id: genId('pr'), kind: 'role', name: effectiveRoleName, parentRole: null, status: 'pending',
    });
    role = inserted.row;
    roleCreated = inserted.created;
  }

  let instanceCreated = false;
  let identityDrift = [];
  let identityFilled = false;
  if (!instance) {
    instance = {
      id: genId('pr'),
      kind: 'instance',
      name: identity.loomId,
      parentRole: effectiveRoleName,
      humanName: identity.humanName || null,
      backend: identity.backend || null,
      agentType: identity.agentType || null,
      field: identity.field || null,
      standalone: identity.standalone ? 1 : 0,
    };
    const inserted = insertPrincipalOrExisting({ ...instance, standalone: identity.standalone });
    // Losing the race hands back the winner's row instead of ours, so this falls through to the
    // merge below rather than returning early: the identity we just observed still has to be
    // back-filled onto whichever row won, and `instanceCreated` stays false because we did not
    // create it — that flag is what the caller reports as a newly-sighted agent.
    instance = inserted.row;
    instanceCreated = inserted.created;
  }
  if (!instanceCreated) {
    const { fill, drift } = mergeObservedIdentity(instance, identity);
    identityDrift = drift;
    const needsParent = !instance.parentRole;
    identityFilled = Object.keys(fill).length > 0;
    if (identityFilled || needsParent) {
      // updatePrincipalIdentity writes every identity column, so the un-filled ones are passed
      // back at their registered values — this is a back-fill of NULLs, not a refresh.
      stmts.updatePrincipalIdentity.run({
        id: instance.id,
        parentRole: needsParent ? effectiveRoleName : instance.parentRole,
        humanName: fill.humanName ?? instance.humanName ?? null,
        backend: fill.backend ?? instance.backend ?? null,
        agentType: fill.agentType ?? instance.agentType ?? null,
        field: fill.field ?? instance.field ?? null,
        standalone: instance.standalone ? 1 : 0,
      });
    }
  }

  // Same transaction as the role/instance pair: a hook resolve either records the whole identity
  // it observed — actor *and* subject — or records none of it. Two rows became three; it is still
  // a narrow upsert and not a whole-table rewrite.
  const { subject, subjectCreated, subjectRenamed } = upsertSubjectPrincipalTx(identity);

  const roleRow = principalOut(stmts.findPrincipalById.get(role.id));
  const instanceRow = principalOut(stmts.findPrincipalById.get(instance.id));
  // Only what actually changed reaches the channel. This transaction runs on *every* hook
  // principal resolve — i.e. on a large share of all tool calls — so appending unconditionally
  // would turn the policy log into a call log and bump the version for nodes on every call, which
  // is a poke per tool call down every SSE connection in the fleet for no news.
  if (roleCreated) recordPolicyChange('principal', roleRow.id, 'upsert', roleRow);
  if (instanceCreated || identityFilled) recordPolicyChange('principal', instanceRow.id, 'upsert', instanceRow);
  if (subject && (subjectCreated || subjectRenamed)) recordPolicyChange('principal', subject.id, 'upsert', subject);

  return {
    role: roleRow,
    instance: instanceRow,
    subject,
    roleCreated,
    instanceCreated,
    subjectCreated,
    subjectRenamed,
    identityDrift,
    identityFilled,
  };
});

function upsertPrincipalIdentity(roleName, identity) {
  if (!roleName) throw new Error('upsertPrincipalIdentity requires a roleName');
  if (!identity || !identity.loomId) throw new Error('upsertPrincipalIdentity requires an identity with a loomId');
  return upsertPrincipalIdentityTx(roleName, identity);
}

/** includeRevoked: also return soft-deleted grants (history) — off by default, since callers
 * almost always mean "what's currently granted." */
function listGrants({ principalId, capabilityId, includeRevoked = false } = {}) {
  if (replicaIndexActive()) {
    // grantById preserves listAllGrants' insertion order (createdAt DESC), and activeGrants is a
    // filter off it, so every branch here matches the ORDER BY of the statement it replaces.
    if (includeRevoked) return Array.from(replicaIndex.grantById.values());
    let out = replicaIndex.activeGrants;
    if (principalId) out = out.filter((g) => g.principalId === principalId);
    if (capabilityId) out = out.filter((g) => g.capabilityId === capabilityId);
    return out === replicaIndex.activeGrants ? out.slice() : out;
  }
  if (includeRevoked) return stmts.listAllGrants.all();
  if (principalId && capabilityId) return stmts.listGrantsByBoth.all(principalId, capabilityId);
  if (principalId) return stmts.listGrantsByPrincipal.all(principalId);
  if (capabilityId) return stmts.listGrantsByCapability.all(capabilityId);
  return stmts.listGrants.all();
}
function findGrant(principalId, capabilityId) {
  if (replicaIndexActive()) {
    // The partial unique index (revokedAt IS NULL) guarantees at most one active grant per pair, so
    // the first match is the only match — no ordering to reproduce.
    return replicaIndex.activeGrants.find((g) => g.principalId === principalId && g.capabilityId === capabilityId) || null;
  }
  return stmts.findGrant.get(principalId, capabilityId) || null;
}
function findGrantById(id) {
  if (replicaIndexActive()) return replicaIndex.grantById.get(id) || null;
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
  recordPolicyChange('grant', grant.id, 'upsert', grant);
  return grant;
}
/**
 * Soft-delete: marks the grant revoked instead of removing the row, so it stays around for
 * history/audit. Returns the updated grant, or null if the id doesn't exist or was already
 * revoked (the UPDATE's `WHERE revokedAt IS NULL` makes a double-revoke a no-op, not an error).
 */
function revokeGrant(id, revokedBy) {
  const revokedAt = new Date().toISOString();
  const changed = stmts.revokeGrant.run({ id, revokedAt, revokedBy: revokedBy ?? null }).changes > 0;
  if (!changed) return null;
  const grant = findGrantById(id);
  recordPolicyChange('grant', id, 'revoke', grant);
  return grant;
}

// ---------------------------------------------------------------------------
// policy_changes — the control-plane distribution channel (§2.4)
//
// This half is only the log: what a policy mutation appends, how a version is read, and how a
// caller asks "what changed since v". Nothing here opens a socket. server/policy/routes.js serves
// it, server/policy/policyClient.js consumes it on a node, and the split is the same one
// usage_outbox / usageShipper.js makes — the append runs inside the same transaction as the grant
// it describes, so it must never be able to block.
//
// The four properties §2.4 asks for, and where each one lives:
//   monotonic version   — the AUTOINCREMENT column (see the table comment for why not a rowid)
//   deltas              — listPolicyChanges / policyDelta
//   push                — onPolicyChange, which routes.js turns into SSE
//   always-full         — policyDenyList, recomputed in full on every response rather than
//   deny-list             diffed, because "a node whose delta stream broke still denies correctly"
//                         is precisely a promise a delta cannot make
// ---------------------------------------------------------------------------

// Bumped when the *shape* of a change row or a /policy response changes incompatibly. A node
// refuses to apply a payload whose version it does not know rather than half-applying it (§2.6),
// so this number is the thing that makes a mixed-version fleet survivable.
const POLICY_SCHEMA_VERSION = 1;

const POLICY_SEEDED_KEY = 'policy_changes_seeded';

/** Listeners woken after a change commits. Registered by server/policy/routes.js for SSE. */
const policyChangeListeners = new Set();
let pendingPolicyNotify = false;

function onPolicyChange(listener) {
  policyChangeListeners.add(listener);
  return () => policyChangeListeners.delete(listener);
}

/**
 * Wake listeners once, on the next tick.
 *
 * Deferred rather than called inline because `recordPolicyChange` runs *inside* a better-sqlite3
 * transaction on several paths (upsertPrincipalIdentityTx, decideApproval): notifying there would
 * announce a version that a rollback could still take away, and would let an SSE handler re-enter
 * the database mid-transaction. Coalesced because a transaction that writes six rows is one
 * notification's worth of news — the event carries the current version, not a row, so a subscriber
 * that pulls once after the last of them is fully caught up.
 */
function schedulePolicyNotify() {
  if (pendingPolicyNotify || policyChangeListeners.size === 0) return;
  pendingPolicyNotify = true;
  setImmediate(() => {
    pendingPolicyNotify = false;
    const version = policyVersion();
    for (const listener of policyChangeListeners) {
      try {
        listener(version);
      } catch {
        /* a subscriber that throws must not take down the write path that told it */
      }
    }
  });
}

/**
 * Append one change and return its version. Called from every policy mutator in this file — that
 * is the invariant the whole channel rests on, so a new mutator that forgets this is a node that
 * silently never learns about its rows. `server/policy/distribution-test.js` asserts the coverage.
 */
function recordPolicyChange(entity, entityId, op, row) {
  const info = stmts.insertPolicyChange.run({
    entity,
    entityId,
    op,
    row: row === null || row === undefined ? null : JSON.stringify(row),
    ts: new Date().toISOString(),
  });
  schedulePolicyNotify();
  return Number(info.lastInsertRowid);
}

/** The current policy version: 0 when nothing has ever been recorded. */
function policyVersion() {
  return stmts.policyVersion.get().version;
}

/** The oldest version still in the log. A `since` below this cannot be served as a delta. */
function policyChangeFloor() {
  return stmts.policyChangeFloor.get().floor;
}

/**
 * Seed the log from the rows that already exist, once.
 *
 * Without this, an install that has been running for months has grants and capabilities but an
 * empty log, so `policyVersion()` is 0 and a node asking `since=0` would be told "you are current"
 * while holding nothing. Seeding makes the very first delta a complete description of the current
 * state, which is what lets every later reader treat "replay from the floor" as sound with no
 * special case for the first boot.
 *
 * Guarded by a kv flag rather than by "is the table empty": a fleet that legitimately trimmed its
 * log down to nothing must not re-seed a second baseline on top of the versions nodes already hold.
 */
const seedPolicyChangesTx = db.transaction(() => {
  for (const cap of stmts.listCapabilities.all().map(capOut)) {
    recordPolicyChange('capability', cap.id, 'upsert', cap);
  }
  for (const principal of stmts.listPrincipals.all().map(principalOut)) {
    recordPolicyChange('principal', principal.id, 'upsert', principal);
  }
  for (const grant of stmts.listAllGrants.all()) {
    recordPolicyChange('grant', grant.id, grant.revokedAt ? 'revoke' : 'upsert', grant);
  }
  stmts.setKv.run(POLICY_SEEDED_KEY, new Date().toISOString());
});

function seedPolicyChangesOnce() {
  if (stmts.getKv.get(POLICY_SEEDED_KEY)) return false;
  seedPolicyChangesTx();
  return true;
}

/**
 * The always-full deny-list (§2.4).
 *
 * Full, every time, and small enough that this is affordable: revocations are monotone and narrow.
 * The point of not deriving it from the delta stream is that it has to be correct for a node whose
 * delta stream is *broken* — so it carries no version dependency, only the pairs that must stop
 * working, plus the version it was computed at so a reader can report its age.
 *
 * `grantIds` and `pairs` both appear because a node can hold either handle: a replica row knows the
 * grant's id, while a hook that never saw the grant at all can still recognise the
 * principal+capability pair it would have needed.
 */
function policyDenyList() {
  const revoked = stmts.listRevokedGrants.all();
  return {
    version: policyVersion(),
    grantIds: revoked.map((g) => g.id),
    pairs: revoked.map((g) => `${g.principalId}:${g.capabilityId}`),
    principals: stmts.listBlockedPrincipals.all().map((p) => p.id),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Changes after `since`, capped. `limit` bounds one response, not the catch-up: the caller keeps
 * asking with the version it reached until `changes` comes back short, which is what stops a node
 * that has been offline for a month from being handed a single unbounded body.
 */
function listPolicyChanges(since = 0, { limit = 500 } = {}) {
  return stmts.listPolicyChangesSince
    .all({ since, limit })
    .map((r) => ({ ...r, row: r.row === null ? null : JSON.parse(r.row) }));
}

/**
 * One `GET /api/policy?since=<v>` answer, assembled where the data is.
 *
 * `reset` is the case worth reading closely: it means this node cannot be caught up incrementally
 * — its `since` predates the retained log, or is ahead of our own version (which means it is
 * talking to a *different* central, or one restored from a backup, and replaying our deltas onto it
 * would silently merge two histories). Both answers are the same: take the full snapshot below and
 * discard what you had.
 */
function policyDelta(since = 0, { limit = 500 } = {}) {
  const version = policyVersion();
  const floor = policyChangeFloor();
  const asked = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
  // `floor` is the oldest version still present, so a node holding exactly floor-1 is still
  // serviceable; anything older has a gap. A node at 0 on an empty log is current, not reset.
  const reset = asked > version || (asked > 0 && asked < floor - 1) || (asked === 0 && version > 0 && floor > 1);
  const base = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    version,
    floor,
    since: asked,
    servedAt: new Date().toISOString(),
    // Unconditional, on every response including a reset and including a no-op poll. That is the
    // "always-full" of §2.4: the one part of this payload whose correctness must not depend on the
    // delta stream having worked.
    denyList: policyDenyList(),
  };
  if (reset) {
    return {
      ...base,
      reset: true,
      snapshot: {
        capabilities: listCapabilities(),
        principals: listPrincipals(),
        grants: stmts.listAllGrants.all(),
      },
      changes: [],
      complete: true,
    };
  }
  const changes = listPolicyChanges(asked, { limit });
  return {
    ...base,
    reset: false,
    changes,
    // False means "ask again immediately with the version you just reached" — a node draining a
    // backlog must not wait out its poll interval between batches.
    complete: changes.length < limit,
  };
}

/**
 * Compact the log, keeping at least `keep` most recent versions.
 *
 * Safe only because of `reset`: trimming raises the floor, and a node below the new floor is handed
 * a snapshot rather than an incomplete replay. Keep this generous — a snapshot is far more
 * expensive than the rows it saves, so the log should only be trimmed to stop unbounded growth on a
 * long-lived install, not to stay small.
 */
function trimPolicyChanges(keep = 50_000) {
  const total = stmts.countPolicyChanges.get().n;
  if (total <= keep) return 0;
  const version = policyVersion();
  const keepBelow = version - keep;
  return stmts.deletePolicyChangesBefore.run({ keepBelow }).changes;
}

// ---------------------------------------------------------------------------
// usage_outbox — the node → central shipping queue (§2.3)
//
// This half is only the queue: what goes on it, in what order, and how a shipment is acked or
// retried. Nothing here opens a socket. server/usageShipper.js is the other half, and the split is
// deliberate — the enqueue runs inside the same transaction as a governed tool call's audit row,
// so it must be synchronous, allocation-light and incapable of blocking on a network.
// ---------------------------------------------------------------------------

// Off unless something turns it on. An install with no central configured has nothing to ship, and
// an outbox that queues forever on every such install would be a database growing without bound in
// exchange for nothing — so the enqueue is skipped entirely rather than filling a queue no shipper
// will ever drain. server/usageShipper.js turns it on at boot only when a central URL is set.
let outboxEnabled = false;
let onOutboxUrgent = null;

/**
 * Start queueing. `urgentHandler` is called — after the transaction has committed, never inside it
 * — when a row lands in the immediate lane, so the shipper can flush now instead of at the next
 * tick. Optional: without one, urgent rows simply wait for the timer like everything else.
 */
function enableUsageOutbox(urgentHandler) {
  outboxEnabled = true;
  onOutboxUrgent = typeof urgentHandler === 'function' ? urgentHandler : null;
}
function disableUsageOutbox() {
  outboxEnabled = false;
  onOutboxUrgent = null;
}
function isUsageOutboxEnabled() {
  return outboxEnabled;
}

const OUTBOX_SEQ_KV_PREFIX = 'outbox_seq:';

/**
 * The next shipment number for this node. Persisted in `kv` rather than derived from
 * `MAX(seq) FROM usage_outbox`, because the queue empties: derive it and the counter restarts at 1
 * after every successful drain, so central's `(nodeId, seq)` ingest key would read the next
 * genuinely-new shipment as a duplicate of one it already has and drop it. The counter has to
 * outlive the rows it numbers.
 *
 * `MAX(seq)` is still consulted as a floor, for the one case the kv row cannot cover: a database
 * whose kv was cleared (or restored from a snapshot) while queue rows survived.
 */
function nextOutboxSeq(node, inc) {
  // Keyed per LIFETIME as well as per node. The kv counter exists so a drained queue does not
  // restart the sequence and make central read the next shipment as a redelivery — but a rebuilt
  // node has no kv at all, which is exactly why the incarnation had to widen central's ledger key
  // rather than this counter alone being trusted to stay unique forever.
  const key = `${OUTBOX_SEQ_KV_PREFIX}${node}:${inc}`;
  const stored = stmts.getKv.get(key);
  const fromKv = stored ? Number(stored.value) || 0 : 0;
  const rows = stmts.maxOutboxSeq.get(node, inc);
  const next = Math.max(fromKv, rows && rows.seq != null ? rows.seq : 0) + 1;
  stmts.setKv.run(key, String(next));
  return next;
}

/**
 * Which lane an event rides in. §2.3: "Flush immediately on any `denied` outcome, any
 * `destructive`-tier call, and any consent correction; everything else rides the timer."
 *
 *   - `denied` is the outcome an alert exists to catch, and it is also the one an attacker most
 *     wants to sit unshipped in a local queue they can delete.
 *   - `approved` is the consent correction — POST /api/usage/:id/approve-consent, the branch where
 *     a human said yes to a call the registry had denied. That decision is the most
 *     security-relevant thing this system records and it is worth nothing five seconds stale.
 *   - `destructive` is read off the capability, mirroring the fail-open/fail-closed split by
 *     `riskTier` that `runPreToolUse` already applies, so it is one policy expressed twice rather
 *     than a second concept.
 *
 * A capability that has since been deleted yields no tier and so no urgency — the ordinary lane is
 * the safe default here, because being wrong costs at most five seconds.
 */
function outboxUrgency(event) {
  if (event.outcome === 'denied' || event.outcome === 'approved') return true;
  if (!event.capabilityId) return false;
  const capability = stmts.findCapabilityById.get(event.capabilityId);
  return Boolean(capability && capability.riskTier === 'destructive');
}

/**
 * Queue one shipment. MUST be called from inside a db.transaction — the whole value of an outbox
 * is that the queue row and the thing it describes commit together or not at all.
 *
 * Returns whether the row went in the immediate lane, so the caller can nudge the shipper once the
 * transaction it is inside has actually committed.
 */
function enqueueOutbox(node, inc, kind, event) {
  const urgent = outboxUrgency(event);
  const seq = nextOutboxSeq(node, inc);
  stmts.insertOutbox.run({
    nodeId: node,
    incarnation: inc,
    seq,
    kind,
    eventId: event.id,
    urgent: urgent ? 1 : 0,
    // The envelope, rendered now. `event` is the row as it stands after the re-chain, so it
    // carries its own `seq`/`prevHash`/`hash` and central can verify this node's chain from the
    // shipped stream alone rather than trusting the shipment order.
    //
    // The SHIPMENT number rides in the envelope too, and it is not the same number as
    // `event.seq`. §2.3 keys central's idempotent ingest on `(nodeId, seq)`, and only the shipment
    // number can carry that key: a correction (`usage_event_correction`) re-ships an event that
    // already went up, with the same chain seq and different contents, so keying on the chain seq
    // would make every correction look like a redelivery of the row it corrects and be discarded —
    // silently, and only for the most security-relevant writes this system makes. The shipment
    // number increments per shipment, so an insert and its later correction are two distinct keys,
    // and a genuine at-least-once redelivery of either is the same key twice.
    // `incarnation` beside the shipment number, because central's ledger key had to widen with it:
    // a rebuilt node reusing shipment numbers would otherwise have every genuine shipment
    // discarded as a redelivery of what a previous lifetime sent. The EVENT's own incarnation
    // rides inside `event`, and the two can differ — a correction is shipped by this lifetime for
    // an event written by an earlier one.
    payload: JSON.stringify({ nodeId: node, incarnation: inc, seq, kind, event }),
    enqueuedAt: new Date().toISOString(),
  });
  return urgent;
}

/**
 * Fire the shipper's urgent-flush hook. Called only after a transaction has committed: invoking it
 * inside one would run a network flush while holding a write lock, and would let the shipper read
 * a row its own caller had not committed yet.
 */
function notifyOutboxUrgent() {
  if (!onOutboxUrgent) return;
  try {
    onOutboxUrgent();
  } catch (err) {
    // The queue row is already durable, so the worst case here is that it waits for the timer.
    // That is never worth failing a tool call's audit write over.
    console.error('[outbox] urgent flush hook failed:', err.message);
  }
}

/**
 * The head of this node's queue, oldest first. Callers bind their own batch ceiling.
 *
 * ACROSS EVERY LIFETIME, OLDEST FIRST, and that is not a detail. Since item 5 the shipment counter
 * restarts with the incarnation, so a node that restarted with shipments still queued has rows
 * belonging to a lifetime this process is not. Reading only the current incarnation would leave
 * them queued forever — governed decisions, sitting in a table nobody drains, on a machine whose
 * whole premise is that it can be destroyed. That is the durability hole item 6 exists to close,
 * and it would have been reopened here.
 */
function listOutboxBatch({ limit = 500, node = nodeId() } = {}) {
  return stmts.listOutboxAnyIncarnation.all(node, Math.min(Math.max(Number(limit) || 500, 1), 5000));
}

/**
 * WHAT THIS MACHINE OWES CENTRAL, UNDER EVERY ID IT HAS EVER HELD — docs/design/disposable-nodes.md
 * §3's first correctness gap.
 *
 * `usageOutboxStats` scopes to the CURRENT nodeId, which is right for the shipper — it can only
 * deliver under the credential it holds — and wrong for `npm run node:retire`, whose entire job is
 * to answer "is anything lost if this box is destroyed". Rows queued under a PREVIOUS id are
 * exactly the drift the design note measured (two `outbox_seq:` counters in one `kv`), they are
 * still governed decisions that exist nowhere else, and the retire gate reported them as "nothing
 * is owed". §3: "The gate is right; its query is one predicate too narrow."
 *
 * One row per id, current first, so a caller can say which of them is deliverable and which is not.
 * Orphaned rows are NOT re-keyed onto the current id by anything here and must not be: they are the
 * previous incarnation's evidence, and relabelling whose evidence a row is would be forgery even
 * when the two ids are the same machine (see adoptNodeId's note on the same point).
 */
function usageOutboxStatsByNode() {
  const current = nodeId();
  const rows = db.prepare(`
    SELECT nodeId,
           COUNT(*) AS pending,
           MIN(enqueuedAt) AS oldestEnqueuedAt,
           COUNT(DISTINCT incarnation) AS incarnations
    FROM usage_outbox
    GROUP BY nodeId
    ORDER BY nodeId = ? DESC, nodeId ASC
  `).all(current);
  return rows.map((r) => ({
    nodeId: r.nodeId,
    pending: r.pending || 0,
    oldestEnqueuedAt: r.oldestEnqueuedAt || null,
    incarnations: r.incarnations || 0,
    // Deliverable exactly when it is this machine's current identity: central refuses a batch whose
    // envelope names a node other than the certificate's CN (NODE_IDENTITY_MISMATCH, and it refuses
    // the WHOLE batch), so shipping an orphan under today's credential does not half-work — it
    // fails, loudly, every time.
    deliverable: r.nodeId === current,
  }));
}

/** A shipment's coordinates. Accepts a row, a `{incarnation, seq}` pair, or — for a caller that
 *  predates incarnations — a bare seq, which is read as this process's own lifetime. */
function shipmentRef(ref) {
  if (ref && typeof ref === 'object') {
    return { incarnation: ref.incarnation || LEGACY_INCARNATION, seq: Number(ref.seq) };
  }
  return { incarnation: incarnation(), seq: Number(ref) };
}

/**
 * Delete shipments central has confirmed. Deleting on ack rather than on send is what makes
 * delivery at-least-once: a lost ack costs a duplicate that the ingest key throws away, where
 * deleting on send would cost the event itself.
 */
const ackOutboxTx = db.transaction((node, refs) => {
  for (const r of refs) stmts.deleteOutboxRow.run(node, r.incarnation, r.seq);
});
function ackOutbox(shipments, node = nodeId()) {
  if (!Array.isArray(shipments) || !shipments.length) return 0;
  ackOutboxTx(node, shipments.map(shipmentRef));
  return shipments.length;
}

/**
 * Record a failed delivery attempt against the rows that were in the batch. The rows stay queued —
 * this is bookkeeping for the shipper's backoff and for anyone asking why the queue is not moving.
 */
const markOutboxAttemptTx = db.transaction((node, refs, lastError, lastAttemptAt) => {
  for (const r of refs) {
    stmts.markOutboxAttempt.run({
      nodeId: node, incarnation: r.incarnation, seq: r.seq, lastError, lastAttemptAt,
    });
  }
});
function markOutboxAttempt(shipments, error, node = nodeId()) {
  if (!Array.isArray(shipments) || !shipments.length) return 0;
  markOutboxAttemptTx(
    node, shipments.map(shipmentRef),
    error ? String(error).slice(0, 500) : null, new Date().toISOString()
  );
  return shipments.length;
}

/**
 * What the queue looks like right now. The one number that matters operationally is
 * `oldestEnqueuedAt` — a shipper that is failing silently and a shipper that has nothing to do both
 * present as a quiet log line, and only the age of the head tells them apart.
 */
function usageOutboxStats(node = nodeId()) {
  const counts = stmts.countOutbox.get(node) || {};
  const failure = stmts.lastOutboxError.get(node) || {};
  return {
    nodeId: node,
    enabled: outboxEnabled,
    pending: counts.pending || 0,
    urgentPending: counts.urgentPending || 0,
    oldestEnqueuedAt: counts.oldestEnqueuedAt || null,
    maxAttempts: counts.maxAttempts || 0,
    lastError: failure.lastError || null,
    lastAttemptAt: failure.lastAttemptAt || null,
  };
}

/**
 * Backstop for a node that has been unable to reach central for a very long time. Drops the OLDEST
 * shipments, not the newest: if something has to be lost, losing the far past keeps the queue
 * describing recent activity, which is what an alert is for. Returns how many were dropped so the
 * caller can say a real number out loud — a silent truncation here would leave a gap in a gapless
 * sequence with nothing anywhere recording that it was deliberate.
 */
function trimUsageOutbox(maxRows, node = nodeId()) {
  const cap = Number(maxRows) || 0;
  if (cap <= 0) return 0;
  const pending = (stmts.countOutbox.get(node) || {}).pending || 0;
  if (pending <= cap) return 0;
  return stmts.trimOutbox.run({ nodeId: node, drop: pending - cap }).changes;
}

function listUsageEvents() {
  return stmts.listUsageEvents.all();
}

/**
 * How many usage events this node holds. A COUNT, not `listUsageEvents().length` — shadow mode's
 * comparison (server/central/shadow-compare.js) asks this on a schedule, and materialising every
 * row of a months-old log to take its length would make the check itself the most expensive thing
 * on the node.
 *
 * Per node rather than table-wide, because a database that has been through
 * server/rollup/index.js's merge holds other nodes' rows too, and comparing a merged total against
 * one node's stream at central would read as a permanent, growing divergence that is not one.
 */
function countUsageEvents(node = nodeId()) {
  // Across every lifetime, deliberately: the question this answers is "how many events does this
  // node hold", and central compares it against every event that node ever shipped. Scoping it to
  // the current incarnation would report a rebuilt node as having lost everything.
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE nodeId = ?').get(node);
  return (row && row.n) || 0;
}
// The node's own coordinates are assigned HERE, inside the same transaction as the insert, and
// never taken from the caller: `seq` has to be the tip of this node's chain plus one at the moment
// of the write, and `observedAt` means "when this node saw it" — a caller-supplied value for
// either would be a claim rather than an observation, and the whole point of recording observedAt
// beside the caller's own `ts` is that the two are independent.
const insertUsageEventTx = db.transaction((row) => {
  const node = nodeId();
  // This process's lifetime, minted at startup and never read back from the database — item 5 of
  // docs/design/dashboard-placement.md. It is what makes a rebuilt node's chain a NEW dense chain
  // from seq 1 rather than a duplicate of one central already holds, which without it reads as
  // tampering at the far end.
  const inc = incarnation();
  const head = chainHead(node, inc);
  // Whichever is further along: normally they agree, and where they don't (a head row deleted by
  // hand, a chain truncated) the rows win for *placement* — appending on top of the head's number
  // would collide with a row that is still there, and the unique index would reject the write.
  // verifyUsageEventChain() is what reports the disagreement; this only refuses to lose an event
  // over it.
  const maxRow = db
    .prepare('SELECT MAX(seq) AS seq FROM usage_events WHERE nodeId = ? AND incarnation = ?')
    .get(node, inc);
  const seq = Math.max(head ? head.seq : 0, maxRow && maxRow.seq != null ? maxRow.seq : 0) + 1;
  stmts.insertUsageEvent.run({
    ...row, nodeId: node, incarnation: inc, seq, observedAt: new Date().toISOString(),
  });
  rechainNodeFrom(node, inc, seq);
  // Queue it for central in the same transaction (§2.3). After the re-chain, not before: the
  // shipped envelope carries the row's own hash, and before the re-chain that hash is still the
  // previous row's problem. Re-read rather than reconstruct — `row` is the caller's object and has
  // neither the node coordinates assigned above nor the chain columns written just now.
  return outboxEnabled ? enqueueOutbox(node, inc, 'usage_event', stmts.findUsageEvent.get(row.id)) : false;
});
/**
 * Write one usage event, tolerating a caller from a different build (§2.6).
 *
 * The per-field `?? null` block this used to open with is now server/ingest/usageEvent.js, and the
 * move is the point rather than a tidy-up: that block filled in the fields it knew about, and the
 * prepared INSERT below binds exactly those, so anything the caller sent that this build has no
 * column for was dropped between the two without a word. `normalizeUsageEvent` keeps it in `extra`
 * instead, and still nulls every field the caller omitted — the two halves of the rule, in the one
 * place every event on this node goes through.
 *
 * A refusal is possible and there is exactly one of it: an event with no id (see the normalizer).
 * It throws rather than returning null, because the only caller that can produce one is a caller
 * with a bug, and the /invoke path already generates the id it hands back to the hook.
 */
function insertUsageEvent(event) {
  const normalized = normalizeUsageEvent(event);
  if (!normalized.ok) throw new Error(`cannot record usage event: ${normalized.reason}`);
  if (normalized.unknownKeys.length || normalized.coercedKeys.length) {
    // Said out loud, once per event, because this is the signal that this node is talking to a
    // build it does not match — the thing §2.6 exists to survive and the thing an operator has to
    // be able to notice. The event is already safely on its way to the insert either way.
    console.warn(
      `[ingest] usage event ${normalized.row.id} carried ${normalized.unknownKeys.length} field(s) this build has no column for`,
      `(${normalized.unknownKeys.join(', ') || 'none'})`,
      normalized.coercedKeys.length ? `and ${normalized.coercedKeys.length} that did not fit theirs (${normalized.coercedKeys.join(', ')})` : '',
      '— kept in usage_events.extra.'
    );
  }
  const urgent = insertUsageEventTx(normalized.row);
  // Outside the transaction, so the shipper cannot be woken to read a row that has not committed.
  if (urgent) notifyOutboxUrgent();
  // Same rule, same reason: the alert engine's first act is a GROUP BY over usage_events, and
  // inside the transaction that would either read its own uncommitted write or block on the lock
  // the write is holding. See notifyUsageEvent.
  notifyUsageEvent(normalized.row, urgent);
  return findUsageEvent(normalized.row.id);
}

// The alert engine's tap — docs/design/global-identity-and-central-db.md §2.3.
//
// A separate hook from `onOutboxUrgent` even though the two fire on an overlapping set of events,
// because the outbox hook is conditional on there BEING a central: `insertUsageEventTx` only calls
// `enqueueOutbox` when `outboxEnabled`, so on a single-machine install nothing is queued and the
// urgent hook never runs. The node-local rule engine has to work on exactly that machine — a PC
// with no central configured is the limit case of the partitioned PC §2.3 is about — so it cannot
// hang off a hook that only exists when the network does.
//
// `urgent` is passed through rather than recomputed. It is the flag store.js already derives from
// the outcome and the capability's risk tier (`outboxUrgency`), and §2.3 names that same set as
// "the events an alert exists to catch" — so it is exactly the signal that should make the engine
// evaluate now instead of on its debounce. On an install with no outbox it is always false and the
// engine falls back to the debounce, which costs a second.
let onUsageEventHandler = null;
function onUsageEvent(fn) {
  onUsageEventHandler = typeof fn === 'function' ? fn : null;
}
function notifyUsageEvent(row, urgent) {
  if (!onUsageEventHandler) return;
  try {
    onUsageEventHandler(row, { urgent: Boolean(urgent) });
  } catch (err) {
    // The event is already durable and already queued. Nothing about alerting is worth failing a
    // governed tool call's audit write over.
    console.error('[alerts] usage-event tap failed:', err.message);
  }
}
function findUsageEvent(id) {
  return stmts.findUsageEvent.get(id) || null;
}

// ---------------------------------------------------------------------------
// native_tool_events — observation, not audit. See the table's comment above for why these are
// not usage_events, and docs/design/native-tool-observability.md for the whole design. Note what
// is absent by design: no rechain, no seq, no nodeId, no patch function. There is nothing to
// correct later because nothing here was written optimistically — the observation is made from
// PostToolUse, after the tool already produced its result.
// ---------------------------------------------------------------------------

const insertNativeToolEventsTx = db.transaction((rows) => {
  let inserted = 0;
  for (const row of rows) {
    // OR IGNORE, paired with server/nativeObservations.js's content-derived ids, is what makes
    // re-draining a batch left behind by a crash a no-op rather than a duplicate. `changes` is 0
    // on an ignored row, so the count returned is genuinely new rows and not attempts.
    inserted += stmts.insertNativeToolEvent.run(row).changes;
  }
  return inserted;
});

/** Batch insert. Returns how many rows were genuinely new. */
function insertNativeToolEvents(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  return insertNativeToolEventsTx(
    rows.map((row) => ({
      ...row,
      detail: row.detail ?? null,
      reason: row.reason ?? null,
      sessionId: row.sessionId ?? null,
      actorLoomId: row.actorLoomId ?? null,
      actorHumanName: row.actorHumanName ?? null,
      actorAgentType: row.actorAgentType ?? null,
      actorBackend: row.actorBackend ?? null,
      actorField: row.actorField ?? null,
      osUser: row.osUser ?? null,
      hostname: row.hostname ?? null,
    }))
  );
}

/**
 * Newest first, always bounded. `limit` is clamped here rather than at the route, because this is
 * the table where an unbounded read is genuinely dangerous — it holds a row per file read, so
 * "select everything" is a different order of magnitude from what that phrase means anywhere else
 * in this file.
 */
function listNativeToolEvents({ principalId, toolName, since, limit = 100 } = {}) {
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return stmts.listNativeToolEvents.all({
    principalId: principalId || null,
    toolName: toolName || null,
    since: since || null,
    limit: bounded,
  });
}

/** Per-tool rollup over a window — the shape the dashboard's top-tools table reads. */
function summarizeNativeToolEventsByTool(since) {
  return stmts.summarizeNativeToolEventsByTool.all({ since: since || null });
}

/**
 * Counts per time bucket over a window — the series behind the calls-over-time chart.
 *
 * Returns only the buckets that actually have rows; the caller zero-fills, because SQL cannot
 * invent a bucket for a minute in which nothing happened and a chart that skips those minutes
 * would draw a quiet hour as a straight line between two busy ones.
 */
function bucketNativeToolEvents({ since, toolName, format } = {}) {
  return stmts.bucketNativeToolEvents.all({
    since: since || null,
    toolName: toolName || null,
    format: format || '%Y-%m-%dT%H:00:00.000Z',
  });
}

/** Per-principal rollup over the same window, joined to the display name. */
function summarizeNativeToolEventsByPrincipal(since) {
  return stmts.summarizeNativeToolEventsByPrincipal.all({ since: since || null });
}

/**
 * Totals plus the real extent of what is retained. `observedFrom`/`observedTo` matter more here
 * than they would elsewhere: with a retention window in force, an empty card has two completely
 * different meanings — "nothing has happened" and "nothing has happened *recently*" — and without
 * these the UI cannot tell a human which one it is looking at.
 */
function summarizeNativeToolEvents(since) {
  return (
    stmts.summarizeNativeToolEvents.get({ since: since || null }) || {
      total: 0,
      errors: 0,
      denied: 0,
      observedFrom: null,
      observedTo: null,
    }
  );
}

/**
 * Moves every observation recorded under `fromPrincipalId` onto `toPrincipalId`.
 *
 * Exists for one case: a native observation whose loom had no principal row at drain time (on a
 * replica the drain cannot mint one — central owns principals). Rather than dropping the row, the
 * drain parks it under a loom-derived placeholder id and calls this once the real principal shows
 * up, so the dashboard's per-principal rollup ends up with one agent instead of two. This is NOT a
 * policy write — `native_tool_events` is observation, carries no foreign key, and is not part of
 * any hash chain — so it is deliberately outside the read-only guard.
 */
function reassignNativeToolEventPrincipal(fromPrincipalId, toPrincipalId) {
  if (!fromPrincipalId || !toPrincipalId || fromPrincipalId === toPrincipalId) return 0;
  return stmts.reassignNativeToolEventPrincipal.run({ from: fromPrincipalId, to: toPrincipalId }).changes;
}

/**
 * Retention. Returns how many rows were dropped, so the caller can log a real number.
 *
 * `sparingUnshipped` is what stops retention silently undoing
 * docs/design/dashboard-placement.md item 1. The window is 14 days and a node can be offline for
 * longer than that; with the plain DELETE, an observation would age out of a table that is now
 * also its own shipping queue, so the rows most worth getting to central — the ones from the
 * outage — would be exactly the rows retention destroyed. The unshipped backlog is bounded by
 * `trimUnshippedNativeToolEvents` instead, which drops loudly rather than as a side effect of a
 * timer nobody is watching.
 *
 * Off by default, so a node with no central prunes exactly as it always did: there, nothing will
 * ever be shipped, and sparing unshipped rows would mean sparing all of them forever.
 */
function pruneNativeToolEvents(cutoffIso, { sparingUnshipped = false } = {}) {
  if (!cutoffIso) return 0;
  const stmt = sparingUnshipped ? stmts.pruneShippedNativeToolEvents : stmts.pruneNativeToolEvents;
  return stmt.run({ cutoff: cutoffIso }).changes;
}

// ---------------------------------------------------------------------------
// The native-observation shipping queue — docs/design/dashboard-placement.md item 1.
//
// The table is the queue and `shippedAt` is the cursor. See migration 18 for why there is no
// outbox beside this one: an observation is never corrected, so there is no frozen payload to
// keep, and one append being both the event and its place in line is the arrangement with fewer
// moving parts rather than weaker guarantees.
// ---------------------------------------------------------------------------

/** One batch for the shipper: unshipped, oldest first. */
function listUnshippedNativeToolEvents(limit = 500) {
  const bounded = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  return stmts.listUnshippedNativeToolEvents.all({ limit: bounded });
}

/**
 * Mark a shipped batch. Returns how many rows this call actually moved.
 *
 * Only rows still `shippedAt IS NULL` are touched, so an ack arriving twice cannot rewrite a
 * timestamp — and a row that was pruned or trimmed between the send and the ack is simply absent
 * rather than an error, which is the shape at-least-once delivery has to tolerate.
 */
const markNativeToolEventsShippedTx = db.transaction((ids, shippedAt) => {
  let moved = 0;
  for (const id of ids) moved += stmts.markNativeToolEventShipped.run({ id, shippedAt }).changes;
  return moved;
});
function markNativeToolEventsShipped(ids, shippedAt = new Date().toISOString()) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  return markNativeToolEventsShippedTx(ids, shippedAt);
}

/** How far behind the native shipper is, and since when. `oldest` is what turns "8 pending" into
 *  "8 pending, the oldest from six days ago" — the difference between a queue and an outage. */
function nativeShipStats() {
  const row = stmts.countUnshippedNativeToolEvents.get() || { n: 0, oldest: null };
  return { pending: row.n || 0, oldest: row.oldest || null };
}

/**
 * Bound the unshipped backlog. Returns how many rows were dropped — never silently: the caller
 * logs a real number, because a silent truncation would read as "you did N things" when the real
 * number was higher, which is the exact complaint the spool's own cap comment makes.
 */
function trimUnshippedNativeToolEvents(maxRows) {
  const cap = Number(maxRows) > 0 ? Number(maxRows) : 0;
  if (!cap) return 0;
  const { pending } = nativeShipStats();
  if (pending <= cap) return 0;
  return stmts.trimUnshippedNativeToolEvents.run({ drop: pending - cap }).changes;
}
const patchUsageEventTx = db.transaction((id, updated) => {
  stmts.updateUsageEvent.run(updated);
  const slot = stmts.findUsageEventSlot.get(id);
  // A row whose node coordinates are missing can't be re-chained from — it is in no chain to begin
  // with. That is a corrupt row, not a corrupt patch: the update above still stands, and
  // verifyUsageEventChain() reports it as "rows carry no nodeId".
  if (slot && slot.nodeId != null && slot.seq != null) {
    // The row's OWN lifetime, not this process's: a correction lands on an event that may have
    // been written by a previous incarnation, and re-chaining it into the current one would splice
    // two chains together.
    rechainNodeFrom(slot.nodeId, slot.incarnation || LEGACY_INCARNATION, slot.seq);
  }
  // A correction is its own shipment, not a rewrite of the original one (see the usage_outbox
  // table comment): central has already been told this event happened, and this says what it
  // turned out to be. `usage_event_correction` is the kind so an ingest can apply it by event id
  // instead of inserting a second row, and the payload carries the re-chained hashes — a
  // correction changes the row's content, so every hash from here to this node's head moved with
  // it and central's copy of the chain has to move too.
  //
  // Only this node's own rows are shipped. A row with no node coordinates is in no chain and so in
  // no node's stream (it is a corrupt row — see above), and a row belonging to another node arrived
  // here by a merge: numbering either into this node's gapless sequence would have this node
  // asserting an event it never observed. Central hears about a foreign row from the node that
  // owns it, which is the same rule §2.2 states for the whole data plane — one writer per stream.
  if (!outboxEnabled || !slot || slot.nodeId == null || slot.nodeId !== nodeId()) return false;
  // Shipped under THIS process's incarnation even though the event may belong to another, because
  // the shipment number is a fact about the sender and this lifetime is what is doing the sending.
  // The event's own incarnation rides inside the envelope, on the event, so central files the
  // correction against the right chain regardless.
  return enqueueOutbox(slot.nodeId, incarnation(), 'usage_event_correction', stmts.findUsageEvent.get(id));
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
  const urgent = patchUsageEventTx(id, updated);
  // Outside the transaction — same reason as insertUsageEvent. This is the path a consent
  // correction takes (outcome 'approved'), so it is the one §2.3 most wants off the timer.
  if (urgent) notifyOutboxUrgent();
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

/**
 * NODE-LOCAL BOOKKEEPING — a read/write pair over `kv` for state that is *derivable*, so losing it
 * on a rebuild costs work rather than evidence.
 *
 * Deliberately narrow, and deliberately named for what it is allowed to hold. `kv` is where two of
 * docs/design/disposable-nodes.md §3's four leaks live — `hook_integrity.everInstalled` and
 * `packages_enabled` — and those are leaks precisely because they are NOT derivable: lose them and
 * a missing hook reads as unknown, and every package reverts to its default. So this is not a
 * general escape hatch for putting facts in the database; it is for cursors and marks, whose worst
 * case on loss is that the node re-does something idempotent.
 *
 * server/nodeHealth.js's fault-journal cursor is the first user: lose it and the node re-ships
 * journal lines central already holds, which ingest deduplicates on their content hash.
 */
function getNodeMark(key, fallback = null) {
  const row = stmts.getKv.get(`mark.${key}`);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setNodeMark(key, value) {
  stmts.setKv.run(`mark.${key}`, JSON.stringify(value));
  return value;
}

// ---------------------------------------------------------------------------
// Pending-approval queue (see the approvals table comment above)
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
// Node enrollment (docs/design/global-identity-and-central-db.md §2.5)
//
// The storage half of replacing the fleet-wide shared bearer tokens with per-node mTLS client
// certificates. Everything cryptographic — minting, signing, presenting, verifying — lives in
// server/enrollment/**; this module stores what those decisions produced and answers two
// questions: "is this one-time enrolment token still spendable, and did I win it", and "is the
// node behind this certificate serial still allowed".
// ---------------------------------------------------------------------------

/** Raised when an enrolment would overwrite an identity it must not: a node that has been revoked
 * trying to re-enrol, or a certificate serial already registered to a different node. Both are
 * refusals, not failures — routes should map this to 409. */
class NodeConflictError extends Error {}

/** Issues a token row. `tokenHash` is SHA-256 of the token the caller generated and is about to
 * show the operator exactly once; this module never sees, and can never reconstruct, the token
 * itself. `expiresAt` null means no expiry — which is a real policy choice and, for a secret whose
 * only defence is being short-lived, usually the wrong one. */
function createEnrollmentToken({ tokenHash, label, scope, expiresAt, createdByScope, maxUses = 1 }) {
  if (!tokenHash || typeof tokenHash !== 'string') throw new TypeError('tokenHash is required');
  if (!scope || typeof scope !== 'string') throw new TypeError('scope is required');
  const row = {
    id: genId('entok'),
    tokenHash,
    label: label ?? null,
    scope,
    createdAt: new Date().toISOString(),
    createdByScope: createdByScope ?? null,
    expiresAt: expiresAt ?? null,
    // How many machines may spend it — docs/design/dashboard-placement.md item 7. Clamped to at
    // least 1 rather than trusted: a caller passing 0 or a negative would mint a token that can
    // never be spent, which is a confusing way to fail, and there is no meaning for "unlimited"
    // here on purpose (see migration 20).
    maxUses: Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Math.trunc(Number(maxUses)) : 1,
  };
  stmts.insertEnrollmentToken.run(row);
  return stmts.findEnrollmentTokenById.get(row.id);
}

/** The lookup an enrolling request makes: hash what was presented, find the row. Returns the raw
 * row (including `tokenHash`) or null — callers still have to consume it to spend it, and a row
 * coming back here means only that the hash is known, not that it is still spendable. */
function findEnrollmentTokenByHash(tokenHash) {
  if (!tokenHash) return null;
  return stmts.findEnrollmentTokenByHash.get(tokenHash) || null;
}

/**
 * Spends the token for `nodeId`, atomically and exactly once.
 *
 * Returns `{ok: true, token}` to the one caller that won it, and `{ok: false, reason, token}` to
 * every other — `reason` being one of `'unknown'`, `'revoked'`, `'expired'`, `'already-used'`.
 * The distinction matters: two enrolments racing the same token must produce exactly one
 * certificate, and the loser needs to be told it lost rather than left to infer it.
 *
 * The claim is a single guarded UPDATE (see stmts.consumeEnrollmentToken), so the check and the
 * write happen under one write lock and there is no window between them. The row is re-read
 * afterwards purely to *explain* a failure, never to decide one — deciding from a read would
 * reintroduce the race the single statement exists to close.
 */
function consumeEnrollmentToken(id, nodeId) {
  if (!nodeId || typeof nodeId !== 'string') throw new TypeError('nodeId is required to consume an enrollment token');
  const now = new Date().toISOString();
  const won = stmts.consumeEnrollmentToken.run({ id, nodeId, usedAt: now, now }).changes === 1;
  const token = stmts.findEnrollmentTokenById.get(id) || null;
  if (won) return { ok: true, token };
  if (!token) return { ok: false, reason: 'unknown', token: null };
  if (token.revokedAt) return { ok: false, reason: 'revoked', token };
  if (token.uses >= token.maxUses) return { ok: false, reason: 'already-used', token };
  return { ok: false, reason: 'expired', token };
}

/** Every token, newest first, **without** `tokenHash`. The hash is not the secret — you cannot
 * enrol with it — but it is the verifier for one, and an operator list has no use for it; the
 * enrolment path reaches it through findEnrollmentTokenByHash instead. `tokenHashPrefix` is kept
 * so a UI can still correlate a row with a specific token. */
function listEnrollmentTokens() {
  return stmts.listEnrollmentTokens.all().map(({ tokenHash, ...rest }) => ({
    ...rest,
    tokenHashPrefix: tokenHash ? tokenHash.slice(0, 8) : null,
  }));
}

/** Kills an unspent token. Returns the updated row, or null if it doesn't exist or was already
 * revoked (the guarded UPDATE makes a double-revoke a no-op, not an error). Deliberately allowed
 * on an already-*used* token too: revoking one is how an operator says "that enrolment should not
 * have happened", and the node it produced is then revoked separately via revokeNode. */
function revokeEnrollmentToken(id) {
  const changed = stmts.revokeEnrollmentToken.run({ id, revokedAt: new Date().toISOString() }).changes > 0;
  return changed ? stmts.findEnrollmentTokenById.get(id) : null;
}

/**
 * Records an enrolled node and the certificate it will present. Idempotent per `nodeId`: enrolling
 * a node that is already registered updates its certificate identity (a renewal) and keeps the
 * original `enrolledAt`.
 *
 * Throws NodeConflictError when the write would launder an identity:
 *   - the node is revoked — re-enrolment must not be a way to clear a revocation, or revoking
 *     anything would be pointless
 *   - the certificate serial already belongs to a different node — that is a CA duplicate, and
 *     since the serial is what every request authorises against, one node would be silently
 *     authorised as another
 */
function registerNode({ nodeId, label, scope, publicKey, certSerial, certFingerprint, certNotAfter }) {
  if (!nodeId || typeof nodeId !== 'string') throw new TypeError('nodeId is required');
  const existing = stmts.findNodeByNodeId.get(nodeId);
  if (existing && existing.revokedAt) {
    throw new NodeConflictError(`node ${nodeId} is revoked and cannot re-enroll`);
  }
  if (certSerial) {
    const bySerial = stmts.findNodeByCertSerial.get(certSerial);
    if (bySerial && bySerial.nodeId !== nodeId) {
      throw new NodeConflictError(`certificate serial ${certSerial} is already registered to node ${bySerial.nodeId}`);
    }
  }
  const fields = {
    nodeId,
    label: label ?? null,
    scope: scope ?? null,
    publicKey: publicKey ?? null,
    certSerial: certSerial ?? null,
    certFingerprint: certFingerprint ?? null,
    certNotAfter: certNotAfter ?? null,
  };
  if (existing) stmts.updateNodeCert.run(fields);
  else stmts.insertNode.run({ ...fields, id: genId('node'), enrolledAt: new Date().toISOString() });
  return stmts.findNodeByNodeId.get(nodeId);
}

/** The request-path lookup: one indexed equality hit. Returns the row **including `revokedAt`**
 * rather than filtering revoked nodes out — "no such certificate" and "that certificate is
 * revoked" are different answers and the caller needs to be able to tell them apart (and to log
 * the second). Callers must check `revokedAt` themselves; there is no variant that hides it. */
function findNodeByCertSerial(certSerial) {
  if (!certSerial) return null;
  return stmts.findNodeByCertSerial.get(certSerial) || null;
}
function findNodeByNodeId(nodeId) {
  if (!nodeId) return null;
  return stmts.findNodeByNodeId.get(nodeId) || null;
}
function listNodes() {
  return stmts.listNodes.all();
}

/** Refuses a node from the next request onward — this is the whole revocation story, in place of
 * CRL/OCSP. Returns the updated row, or null if the node is unknown or already revoked. */
function revokeNode(nodeId, reason) {
  const changed = stmts.revokeNode.run({
    nodeId,
    revokedAt: new Date().toISOString(),
    revokedReason: reason ?? null,
  }).changes > 0;
  return changed ? stmts.findNodeByNodeId.get(nodeId) : null;
}

/**
 * The seam enrollment calls when the CA has minted this node's identity: adopt `newNodeId` as the
 * id nodeId() returns from now on, so the certificate CN and the usage-event hash chain key are
 * one value rather than two that have to be kept equal by hand.
 *
 * Rows already written keep the id they were written under, and that is correct rather than a
 * gap: chains are per node (`usage_events.(nodeId, seq)`, one head each), so the old chain stays
 * complete and verifiable under the old id while new events start a fresh chain at seq 1 under
 * the new one. Nothing is orphaned and no history is rewritten — which is exactly what re-keying
 * a single global rowid chain could not have offered.
 *
 * Returns `{changed, nodeId, previousNodeId, persistedTo}`. Refuses (throws) when WINDROW_NODE_ID
 * was passed in by whoever STARTED this process and says something else: that env var overrides
 * every read, so persisting a different id would record an identity this process would then ignore.
 * A WINDROW_NODE_ID that server/config.js lifted out of `windrow.env` is not that — see the body.
 */
function adoptNodeId(newNodeId) {
  if (!newNodeId || typeof newNodeId !== 'string') throw new TypeError('newNodeId is required');
  const override = process.env.WINDROW_NODE_ID;
  // A VALUE OUT OF `windrow.env` IS NOT AN OVERRIDE, and telling the two apart is the second trap
  // docs/design/disposable-nodes.md §2.1 names. `server/config.js` copies that file into
  // `process.env` before anything reads it, so after a re-enrolment the OLD id is sitting right
  // there looking exactly like a deliberate override — and refusing on it means the CLI leaves the
  // stale id in place, it wins over the new credential, and every shipped batch is then rejected
  // whole as NODE_IDENTITY_MISMATCH. It is the previous enrolment's answer, in the file this
  // function is about to rewrite, so it is replaced rather than obeyed. A value that came from the
  // parent process — the Windows service, a sandbox, `WINDROW_NODE_ID=… npm start` — still wins,
  // because that process really would ignore whatever was recorded here.
  if (override && override !== newNodeId && !cameFromEnvFile('WINDROW_NODE_ID')) {
    throw new Error(
      `WINDROW_NODE_ID is set to ${override}; refusing to adopt ${newNodeId}, which this process would ignore`
    );
  }
  const previousNodeId = nodeId();
  if (previousNodeId === newNodeId) return { changed: false, nodeId: newNodeId, previousNodeId };

  // INTO CONFIGURATION, NOT INTO THE DATABASE — the same call `nodeId()`'s step 4 makes, and the
  // whole point of item 5. `kv.node_id` is read for the databases already in the field and is never
  // written any more; writing it here would put identity back in the one place a rebuild destroys.
  // Best-effort: a node that cannot write its config file still adopts the id for this process and
  // says so, exactly as minting does.
  let persistedTo = null;
  try {
    // eslint-disable-next-line global-require
    const envFile = require('./envFile');
    persistedTo = envFile.write({ WINDROW_NODE_ID: newNodeId }).file;
  } catch (err) {
    console.warn(`[store] could not record node id ${newNodeId} in windrow.env (${err.message}); it holds for this process only.`);
  }
  process.env.WINDROW_NODE_ID = newNodeId;
  cachedNodeId = newNodeId;
  console.log(
    `[store] node id adopted: ${previousNodeId} -> ${newNodeId}`
    + `${persistedTo ? ` (recorded in ${persistedTo})` : ''}; existing usage_events keep the old id and its chain.`
  );
  return { changed: true, nodeId: newNodeId, previousNodeId, persistedTo };
}

// ---------------------------------------------------------------------------
// Governance audit trail (see the windrow_audit table comment above) — append-only: every
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
// Coarse snapshot compatibility layer — seed.js, discovery run-cli, and the discovery merge pass
// (server/discovery/merge.js) all mutate a whole `{capabilities, principals, grants, usageEvents,
// discovery}` object in memory the way the old JSON store did. Batch/offline callers only: the
// hook path used to be here too (principal resolution) and is now a narrow upsert behind
// POST /api/principals/resolve — see upsertPrincipalIdentity above.
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
  // The heads go with the rows they describe. Left behind, they would claim a chain longer than
  // the table holds and every node would read as truncated after a restore — a head is a statement
  // about a set of rows, so wiping the rows without it manufactures the exact break
  // verifyUsageEventChain() exists to report. They are rebuilt by the re-chain at the end.
  stmts.deleteAllChainHeads.run();
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
    // Through the same §2.6 normalizer as a live insert, and for a sharper reason: a snapshot is
    // the one input to this store that routinely comes from a *different build* — an export taken
    // on another machine, or before an upgrade, or after one. Fields this build has no column for
    // survive the restore in `extra` instead of being dropped by the INSERT's column list.
    const normalized = normalizeUsageEvent(e);
    if (!normalized.ok) {
      console.warn(`[store] skipping a usage event in the restored snapshot: ${normalized.reason}`);
      continue;
    }
    stmts.insertUsageEvent.run({
      ...normalized.row,
      // Restored as they were recorded, not re-stamped: a snapshot round-trip must not relabel
      // which node observed an event or when it saw it. These three are writer-assigned on a live
      // insert, so the normalizer does not carry them — here the snapshot *is* the record of who
      // wrote the row, and they are put back deliberately. A snapshot taken before these columns
      // existed carries none, and the backfill below gives those rows this node's coordinates —
      // which is the honest answer for rows that were only ever written here.
      nodeId: e.nodeId ?? null,
      seq: e.seq ?? null,
      observedAt: e.observedAt ?? null,
    });
  }
  // Restored rows carry whatever hash the snapshot held — and a snapshot that predates the chain
  // holds none at all — so the chain and its heads are rebuilt over what actually landed. Hashing
  // is a pure function of a row's content, so a foreign node's rows come out with exactly the
  // hashes that node computed: this re-derives the chain, it does not re-sign it.
  backfillUsageEventNodeIds();
  for (const c of usageEventChains()) if (c.nodeId != null) rechainNodeFrom(c.nodeId, c.incarnation, 1);
  if (snapshot.discovery !== undefined) setDiscovery(snapshot.discovery);

  // This replaced every policy row in the database, and none of it went through a mutator, so the
  // change log describes a state that no longer exists. Emitting a fresh 'upsert' for every row is
  // not elegant, and it is the only honest answer available: a wholesale replace cannot be
  // expressed as a diff against rows that were deleted out from under it. Nodes see one large
  // delta — correct, monotone, and self-healing — rather than a version that silently stopped
  // describing the truth. Phase 0 deletes this call site; until it does, this is what keeps a node
  // from being wrong after a `seed.js` or a discovery merge.
  //
  // Deleted rows leave no tombstone here, which is why a node applying this is told to reconcile
  // against the snapshot rather than merge: see policyClient's `wholesale` handling.
  recordPolicyChange('snapshot', 'replaceAll', 'reset', {
    capabilities: (snapshot.capabilities || []).length,
    principals: (snapshot.principals || []).length,
    grants: (snapshot.grants || []).length,
  });
  for (const cap of stmts.listCapabilities.all().map(capOut)) recordPolicyChange('capability', cap.id, 'upsert', cap);
  for (const p of stmts.listPrincipals.all().map(principalOut)) recordPolicyChange('principal', p.id, 'upsert', p);
  for (const g of stmts.listAllGrants.all()) recordPolicyChange('grant', g.id, g.revokedAt ? 'revoke' : 'upsert', g);
});

/** Replaces every table's contents in one transaction — all-or-nothing, unlike a raw file write.
 *
 *  BEHIND THE REPLICA LOCK, and this is the call site that most needed to be. `replaceAll` writes
 *  capabilities, principals and grants through its own prepared statements, so it reaches straight
 *  past the guarded exports — on a replica node one `POST /api/discovery/run` would otherwise
 *  replace central's rows with locally-discovered ones and the next delta would have nothing to say
 *  about it, because from central's point of view nothing changed. Discovery on a replica proposes
 *  instead; see server/app.js's runDiscoveryAndPersist. */
function save(snapshot) {
  guardPolicyWrite('save');
  replaceAll(snapshot);
}

// ---------------------------------------------------------------------------
// Alerts — the node half of docs/design/global-identity-and-central-db.md §2.3,
// "Evaluate alerts at both ends".
//
// The engine that decides WHAT to evaluate is server/alerts/nodeEngine.js; this is only the SQL,
// kept here because `db` is private to this module and handing a raw handle out to a second file
// would put a second writer on tables whose transactions this one owns.
//
// ============================================================================================
// THE WINDOW IS COUNTED OVER `usage_events`, NOT OVER `usage_outbox`. THIS IS THE DESIGN.
// ============================================================================================
//
// §2.3 says the node-local engine evaluates "locally on the outbox", and taken as a literal
// instruction — count the rows sitting in usage_outbox — it produces a rule that gives a different
// answer depending on whether the network is up. The outbox DELETES ON ACK. So a burst of 40
// destructive calls that half-shipped before the WAN dropped counts 40 while central is
// unreachable and 12 the moment it comes back, and the same burst either trips or does not trip
// according to a fact about connectivity that has nothing to do with the user's behaviour. It also
// means a healthy node — the common case, where the outbox drains every five seconds and is nearly
// always empty — can essentially never reach any threshold, which would leave the node engine
// silently dead on every machine except a broken one.
//
// The outbox is the TRIGGER and the VISIBILITY MEASURE, and both of those are what §2.3 is actually
// reaching for:
//
//   TRIGGER          an urgent enqueue (denied / destructive / consent correction — store.js's
//                    `outboxUrgency`) is the moment worth re-evaluating, because it is the same
//                    set of events §2.3 already singles out as "the events an alert exists to
//                    catch". The node engine hangs off that hook rather than polling hard.
//
//   VISIBILITY       `countUnshippedMatches` says how many of the events in a breaching window are
//                    STILL IN THE QUEUE — i.e. how much of this breach central cannot see. That is
//                    the number that makes a node-local alert worth having: "40 destructive calls,
//                    38 of which central has not received" is a partitioned machine reporting a
//                    burst nobody else can know about, and it rides along on the alert.
//
// So the count is over the durable local log, which is the same set of rows central will
// eventually hold for this node — which is also what makes the two ends agree, and therefore what
// makes the dedup key do its job instead of just deduplicating disagreements.

/** `usage_events` rows are filtered on the node's own `observedAt`, never on the caller-supplied
 *  `ts`. §2.3's note: "trust node clocks for nothing." `ts` is a string a hook handed us and a user
 *  can set; back-dating it would let anyone slide a burst out of every window that would have
 *  caught it. `observedAt` is written by insertUsageEventTx inside the insert. Central makes the
 *  same choice for the same reason, on its own `observedAt`. */
const ALERT_TIME_COLUMN = 'e.observedAt';

/**
 * Translate a rule's `match` into a WHERE fragment plus bindings.
 *
 * Only the filters server/alerts/rules.js validates can arrive here — a rule naming an unknown one
 * is refused at load, so an unhandled key in this switch would be a rule that passed validation
 * this build cannot express, and it throws rather than quietly matching everything.
 */
function alertMatchSql(rule) {
  const where = [];
  const params = [];
  for (const [filter, value] of Object.entries(rule.match || {})) {
    if (filter === 'outcome') { where.push('e.outcome = ?'); params.push(value); continue; }
    if (filter === 'capabilityId') { where.push('e.capabilityId = ?'); params.push(value); continue; }
    // riskTier and capabilityKind live on the capability, not the event, so they need the join.
    // INNER, not LEFT: an event whose capability has since been deleted has no tier, and treating
    // "no tier" as a match would make a destructive-tier rule fire on ordinary calls the moment
    // someone removed a capability row.
    if (filter === 'riskTier') { where.push('c.riskTier = ?'); params.push(value); continue; }
    if (filter === 'capabilityKind') { where.push('c.kind = ?'); params.push(value); continue; }
    throw new Error(`alert rule ${rule.id}: no SQL for match filter "${filter}"`);
  }
  const needsCapability = where.some((w) => w.startsWith('c.'));
  return {
    join: needsCapability ? 'JOIN capabilities c ON c.id = e.capabilityId' : '',
    where: where.length ? ` AND ${where.join(' AND ')}` : '',
    params,
  };
}

/** What a rule counts, as a SQL aggregate. `distinctNodes` never reaches here — rules.js refuses it
 *  at node scope, since one node counts one node. */
function alertMetricSql(rule) {
  if (rule.metric === 'distinctCapabilities') return 'COUNT(DISTINCT e.capabilityId)';
  return 'COUNT(*)';
}

/** The subject an event is counted under, with the fallback both ends must agree on letter for
 *  letter — a node grouping an unattributed event under 'unknown' while central grouped it under
 *  its principalId would split one subject's activity in two and let a breach cross neither half's
 *  threshold. `principalId` is prefixed rather than used bare so a principal id can never collide
 *  with a genuine subject id. */
const ALERT_SUBJECT_SQL = "COALESCE(NULLIF(e.subjectId, ''), 'principal:' || e.principalId, 'unknown')";

/**
 * Every subject that BREACHES `rule` in the window, with the value that breached it.
 *
 * Grouped and filtered in SQL rather than enumerated in JS: a rule asking "who crossed 40" over a
 * ten-minute window on a busy node would otherwise materialise every event in that window to count
 * them per subject, on the hook API's own process. HAVING does it in one indexed pass.
 *
 * `node` scopes the count to this machine's own stream. A database that has been through
 * server/rollup/index.js's merge holds other nodes' rows too, and a node-scoped rule that counted
 * them would report another machine's burst as this one's.
 */
function alertBreaches(rule, { windowStart, windowEnd, node = nodeId() } = {}) {
  const m = alertMatchSql(rule);
  const sql = `
    SELECT ${ALERT_SUBJECT_SQL} AS subjectId, ${alertMetricSql(rule)} AS value
    FROM usage_events e
    ${m.join}
    WHERE e.nodeId = ? AND ${ALERT_TIME_COLUMN} >= ? AND ${ALERT_TIME_COLUMN} < ?${m.where}
    GROUP BY subjectId
    HAVING value >= ?
    ORDER BY value DESC`;
  return db.prepare(sql).all(node, windowStart, windowEnd, ...m.params, rule.threshold);
}

/**
 * How many of one subject's matching events in the window are STILL QUEUED for central.
 *
 * The number that says how much of this breach central is blind to — see the section header. Joined
 * through `usage_outbox.eventId` rather than counted off the queue's own payload JSON, because the
 * payload is a rendered snapshot and parsing it per row to re-apply the rule's filters would be
 * re-implementing `alertMatchSql` against a different shape.
 *
 * Corrections make this an upper bound: an event can hold two queued shipments (the original and a
 * `usage_event_correction`), so DISTINCT is on the event id.
 */
function countUnshippedMatches(rule, { windowStart, windowEnd, subjectId, node = nodeId() } = {}) {
  const m = alertMatchSql(rule);
  const sql = `
    SELECT COUNT(DISTINCT e.id) AS n
    FROM usage_outbox o
    JOIN usage_events e ON e.id = o.eventId AND e.nodeId = o.nodeId
    ${m.join}
    WHERE o.nodeId = ? AND ${ALERT_TIME_COLUMN} >= ? AND ${ALERT_TIME_COLUMN} < ?${m.where}
      AND ${ALERT_SUBJECT_SQL} = ?`;
  const row = db.prepare(sql).get(node, windowStart, windowEnd, ...m.params, subjectId);
  return (row && row.n) || 0;
}

/**
 * When (rule, scopeId, subject) last fired, for the cooldown check.
 *
 * Separate from the primary-key dedup and not replaceable by it: the key stops the SAME window
 * being reported twice (§2.3's two-ends case), and this stops the several ADJACENT windows that
 * one continuing breach satisfies under overlapping strides from each becoming their own alert.
 */
function lastAlertFiredAt(ruleId, scopeId, subjectId) {
  const row = db
    .prepare('SELECT firedAt FROM alerts WHERE ruleId = ? AND scopeId = ? AND subjectId = ? ORDER BY firedAt DESC LIMIT 1')
    .get(ruleId, scopeId, subjectId);
  return (row && row.firedAt) || null;
}

const insertAlertStmt = db.prepare(`
  INSERT OR IGNORE INTO alerts
    (key, ruleId, scope, scopeId, subjectId, windowStart, windowEnd, windowMs, metric, threshold,
     value, severity, title, firedBy, nodeId, firedAt, detail)
  VALUES
    (@key, @ruleId, @scope, @scopeId, @subjectId, @windowStart, @windowEnd, @windowMs, @metric,
     @threshold, @value, @severity, @title, @firedBy, @nodeId, @firedAt, @detail)`);

/**
 * Record one fire. Returns true if it was new, false if this exact key had already fired.
 *
 * INSERT OR IGNORE rather than a SELECT followed by an INSERT: the event-triggered evaluation and
 * the sweep timer can both be inside this function for the same key at the same moment, and only
 * the atomic form can tell them apart. The boolean is what the caller logs on — reporting a fire
 * that was actually a duplicate is how a deduped design still ends up shouting twice.
 */
function recordAlert(alert) {
  const info = insertAlertStmt.run({ ...alert, firedAt: alert.firedAt || new Date().toISOString() });
  return info.changes > 0;
}

/** Recent alerts, newest first. `since` is an ISO instant compared against firedAt. */
function listAlerts({ limit = 100, since = null, severity = null, ruleId = null } = {}) {
  const where = [];
  const params = [];
  if (since) { where.push('firedAt >= ?'); params.push(since); }
  if (severity) { where.push('severity = ?'); params.push(severity); }
  if (ruleId) { where.push('ruleId = ?'); params.push(ruleId); }
  const sql = `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY firedAt DESC LIMIT ?`;
  return db.prepare(sql).all(...params, Math.min(Math.max(Number(limit) || 100, 1), 1000));
}

/** Alerts central has not confirmed, oldest first — the shipper's queue. Unlike `usage_outbox`,
 *  nothing is deleted on ack; `syncedAt` is set instead, because an alert is evidence this node
 *  has to be able to show an operator long after it was delivered. */
function listUnsyncedAlerts(limit = 200) {
  return db
    .prepare('SELECT * FROM alerts WHERE syncedAt IS NULL ORDER BY firedAt LIMIT ?')
    .all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

const markAlertsSyncedTx = db.transaction((keys, at) => {
  const stmt = db.prepare('UPDATE alerts SET syncedAt = ?, syncError = NULL WHERE key = ?');
  for (const key of keys) stmt.run(at, key);
});
function markAlertsSynced(keys, at = new Date().toISOString()) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  markAlertsSyncedTx(keys, at);
  return keys.length;
}

const markAlertSyncAttemptTx = db.transaction((keys, error) => {
  const stmt = db.prepare('UPDATE alerts SET syncAttempts = syncAttempts + 1, syncError = ? WHERE key = ?');
  for (const key of keys) stmt.run(error, key);
});
function markAlertSyncAttempt(keys, error) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  markAlertSyncAttemptTx(keys, error ? String(error).slice(0, 500) : null);
  return keys.length;
}

/** Operational summary — the pair of numbers that tell a working engine from a dead one. A node
 *  with alerts none of which are synced is a node that is partitioned or whose credential is
 *  wrong, and both look identical from the log alone. */
function alertStats() {
  const row = db
    .prepare(`SELECT COUNT(*) AS total,
                     SUM(CASE WHEN syncedAt IS NULL THEN 1 ELSE 0 END) AS unsynced,
                     MAX(firedAt) AS lastFiredAt
              FROM alerts`)
    .get() || {};
  return { total: row.total || 0, unsynced: row.unsynced || 0, lastFiredAt: row.lastFiredAt || null };
}

module.exports = {
  DB_PATH,
  // The versioned schema this database is at (server/schema/migrator.js) — a number a node can
  // report and central can compare, per docs/design/global-identity-and-central-db.md §2.6.
  schemaVersion,
  GrantConflictError,
  CapabilityConflictError,
  PrincipalConflictError,
  DiscoverySourceConflictError,
  // Replica mode (§2.7 phase 4). PolicyReadOnlyError is part of the contract, not an internal
  // detail: server/policy/centralPolicyStore.js and the tests both branch on it.
  PolicyReadOnlyError,
  setPolicyReadOnly,
  isPolicyReadOnly,
  applyPolicyReplica,
  policyReplicaState,

  listCapabilities,
  findCapabilityById,
  // Node-local discovery columns — see the function. Unguarded on purpose: they are this machine's
  // observation of its own filesystem, not policy.
  setCapabilityDiscoveryState,
  listPrincipals,
  findPrincipalById,
  findPrincipalByKindName,
  findPrincipalBySubjectId,
  listOwnerEvidence,
  listGrants,
  findGrant,
  findGrantById,

  // ------------------------------------------------------------------ the guarded policy writers
  //
  // Every mutator of `capabilities`, `principals`, `grants` and `approvals`, wrapped so that on a
  // replica node they refuse rather than write (see PolicyReadOnlyError above). The wrapping is
  // here, in one list, rather than a line inside each function: a mutator added later and left off
  // this list is a hole, and a hole is easier to see as a name missing from a list than as a
  // missing first line thirty functions apart.
  //
  // The reads above are deliberately NOT wrapped. A replica exists to be read, and the hot path
  // (server/app.js's findActiveGrant) is nothing but reads — putting a branch in front of them
  // would put a branch on every governed tool call to answer a question that is constant for the
  // life of the process.
  insertCapability: readOnlyGuarded('insertCapability', insertCapability),
  setCapabilityAutoGrant: readOnlyGuarded('setCapabilityAutoGrant', setCapabilityAutoGrant),
  insertPrincipal: readOnlyGuarded('insertPrincipal', insertPrincipal),
  setPrincipalStatus: readOnlyGuarded('setPrincipalStatus', setPrincipalStatus),
  setPrincipalName: readOnlyGuarded('setPrincipalName', setPrincipalName),
  setPrincipalOwner: readOnlyGuarded('setPrincipalOwner', setPrincipalOwner),
  // Deliberately NOT guarded — see the note on the function. The owner* columns are node-local by
  // design, and a replica that could not write them could not record an owner decision at all.
  setPrincipalOwnerLocal,
  upsertPrincipalIdentity: readOnlyGuarded('upsertPrincipalIdentity', upsertPrincipalIdentity),
  insertGrant: readOnlyGuarded('insertGrant', insertGrant),
  revokeGrant: readOnlyGuarded('revokeGrant', revokeGrant),
  insertAuditEntry,
  listAuditEntries,
  listUsageEvents,
  countUsageEvents,
  insertUsageEvent,
  findUsageEvent,
  patchUsageEvent,
  verifyUsageEventChain,

  // policy_changes (§2.4) — the log half; server/policy/routes.js serves it and
  // server/policy/policyClient.js consumes it on a node.
  POLICY_SCHEMA_VERSION,
  policyVersion,
  policyChangeFloor,
  listPolicyChanges,
  policyDelta,
  policyDenyList,
  recordPolicyChange,
  seedPolicyChangesOnce,
  trimPolicyChanges,
  onPolicyChange,

  // usage_outbox (§2.3) — the queue half; server/usageShipper.js is the transport half.
  enableUsageOutbox,
  disableUsageOutbox,
  isUsageOutboxEnabled,
  listOutboxBatch,
  usageOutboxStatsByNode,
  ackOutbox,
  markOutboxAttempt,
  usageOutboxStats,
  trimUsageOutbox,

  // Alerts — the node half of §2.3's two-ended evaluation. See the section above module.exports
  // for why the window is counted over usage_events while the outbox supplies the trigger and the
  // "how much of this can central not see" number.
  onUsageEvent,
  alertBreaches,
  countUnshippedMatches,
  lastAlertFiredAt,
  recordAlert,
  listAlerts,
  listUnsyncedAlerts,
  markAlertsSynced,
  markAlertSyncAttempt,
  alertStats,

  insertNativeToolEvents,
  listNativeToolEvents,
  bucketNativeToolEvents,
  summarizeNativeToolEvents,
  summarizeNativeToolEventsByTool,
  summarizeNativeToolEventsByPrincipal,
  pruneNativeToolEvents,
  listUnshippedNativeToolEvents,
  markNativeToolEventsShipped,
  nativeShipStats,
  trimUnshippedNativeToolEvents,
  reassignNativeToolEventPrincipal,

  nodeId,
  incarnation,
  LEGACY_INCARNATION,
  adoptNodeId,
  listChainHeads,

  // Node enrollment (§2.5) — server/enrollment/** owns the crypto; this is only its storage.
  NodeConflictError,
  createEnrollmentToken,
  findEnrollmentTokenByHash,
  consumeEnrollmentToken,
  listEnrollmentTokens,
  revokeEnrollmentToken,
  registerNode,
  findNodeByCertSerial,
  findNodeByNodeId,
  listNodes,
  revokeNode,

  getDiscovery,
  setDiscovery,
  getPackagesState,
  setPackagesState,
  getHookIntegrity,
  getNodeMark,
  setNodeMark,
  setHookIntegrity,
  listApprovals,
  findApprovalById,
  // Approvals decide into grants, so they live on the same side of the seam and take the same lock
  // — an approval queued on a node that cannot issue the grant is a queue nobody can clear.
  insertApproval: readOnlyGuarded('insertApproval', insertApproval),
  decideApproval: readOnlyGuarded('decideApproval', decideApproval),

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
