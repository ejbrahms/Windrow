'use strict';

// Smoke test for the versioned migrator — `npm run smoke:schema --prefix server`.
//
// Two halves, and the second is the one that matters for
// docs/design/global-identity-and-central-db.md §2.5:
//
//   A. Core invariants, against a synthetic migration list on a scratch database: the ledger
//      records what ran, a second run is a no-op, a downgrade throws instead of proceeding, a
//      migration that throws leaves the version where it was, and signals reach the caller.
//   B. The real node list, run three ways — onto an empty file, onto a database already at the
//      latest version (must do nothing), and onto a *legacy-shaped* database built to look like
//      one in the field that predates the column-adding migrations (must arrive at the same
//      schema as the fresh one). That third case is the whole point: it is the N-nodes-at-mixed-
//      versions problem, reproduced in a temp file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, currentVersion, SchemaTooNewError, LEDGER_TABLE } = require('./migrator');
const { sqliteDriver } = require('./sqliteDriver');

let failures = 0;
let checks = 0;
function check(label, cond, detail) {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(name) {
  console.log(`\n${name}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-schema-'));
const scratch = [];
function scratchDb(name) {
  const file = path.join(tmpDir, `${name}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  scratch.push(db);
  return db;
}
const quiet = () => {};

// ---------------------------------------------------------------------------
// A. Core invariants
// ---------------------------------------------------------------------------

section('core: a fresh database runs every migration and records them');
{
  const db = scratchDb('core-fresh');
  const driver = sqliteDriver(db);
  const migrations = [
    { version: 1, name: 'create-t', up: (ctx) => ctx.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)') },
    { version: 2, name: 'add-col', up: (ctx) => ctx.addColumn('t', 'extra', 'TEXT') },
  ];
  const result = migrate({ driver, migrations, label: 'test', log: quiet });
  check('from is 0', result.from === 0, `got ${result.from}`);
  check('to is 2', result.to === 2, `got ${result.to}`);
  check('applied both', result.applied.length === 2, `got ${result.applied.length}`);
  const rows = db.prepare(`SELECT version, name, appliedAt FROM ${LEDGER_TABLE} ORDER BY version`).all();
  check('ledger has 2 rows', rows.length === 2, `got ${rows.length}`);
  check('ledger names the migrations', rows[1] && rows[1].name === 'add-col', JSON.stringify(rows[1]));
  check('ledger stamps a time', !!(rows[0] && rows[0].appliedAt), JSON.stringify(rows[0]));
  check('column exists', db.prepare('PRAGMA table_info(t)').all().some((c) => c.name === 'extra'));

  section('core: a second run is a no-op');
  const again = migrate({ driver, migrations, label: 'test', log: quiet });
  check('nothing applied', again.applied.length === 0, `got ${again.applied.length}`);
  check('from === to', again.from === 2 && again.to === 2, `${again.from} → ${again.to}`);
  check('currentVersion reads 2', currentVersion(driver) === 2, `got ${currentVersion(driver)}`);

  section('core: a database newer than the code is refused, not opened');
  let threw = null;
  try {
    migrate({ driver, migrations: migrations.slice(0, 1), label: 'test', log: quiet });
  } catch (err) {
    threw = err;
  }
  check('throws SchemaTooNewError', threw instanceof SchemaTooNewError, threw ? threw.name : 'did not throw');
  check('names both versions', !!threw && threw.dbVersion === 2 && threw.codeVersion === 1);
}

section('core: a failing migration leaves the version where it was');
{
  const db = scratchDb('core-fail');
  const driver = sqliteDriver(db);
  const migrations = [
    { version: 1, name: 'ok', up: (ctx) => ctx.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)') },
    {
      version: 2,
      name: 'half-then-throw',
      up: (ctx) => {
        ctx.exec('CREATE TABLE IF NOT EXISTS t2 (id TEXT PRIMARY KEY)');
        throw new Error('boom');
      },
    },
  ];
  let threw = null;
  try {
    migrate({ driver, migrations, label: 'test', log: quiet });
  } catch (err) {
    threw = err;
  }
  check('the error propagates', !!threw && threw.message === 'boom', threw ? threw.message : 'did not throw');
  check('version stayed at 1', currentVersion(driver) === 1, `got ${currentVersion(driver)}`);
  check(
    'the half-applied table rolled back with it',
    !driver.ddl.hasTable('t2'),
    't2 survived — the migration was not atomic'
  );
}

section('core: malformed lists are caught before anything runs');
{
  const db = scratchDb('core-malformed');
  const driver = sqliteDriver(db);
  const cases = [
    ['a gap', [{ version: 1, name: 'a', up: () => {} }, { version: 3, name: 'c', up: () => {} }]],
    ['a repeat', [{ version: 1, name: 'a', up: () => {} }, { version: 1, name: 'b', up: () => {} }]],
    ['no name', [{ version: 1, up: () => {} }]],
    ['no up()', [{ version: 1, name: 'a' }]],
  ];
  for (const [label, migrations] of cases) {
    let threw = null;
    try {
      migrate({ driver, migrations, label: 'test', log: quiet });
    } catch (err) {
      threw = err;
    }
    check(`rejects ${label}`, !!threw, 'accepted a malformed list');
  }
}

section('core: signals reach the caller, and only from migrations that ran');
{
  const db = scratchDb('core-signals');
  const driver = sqliteDriver(db);
  const migrations = [
    { version: 1, name: 'create', up: (ctx) => ctx.exec('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)') },
    {
      version: 2,
      name: 'add-and-signal',
      up: (ctx) => {
        if (ctx.addColumn('t', 'extra', 'TEXT')) ctx.signal('needsRechain');
      },
    },
  ];
  const first = migrate({ driver, migrations, label: 'test', log: quiet });
  check('signal raised on the run that applied it', first.signals.has('needsRechain'));
  const second = migrate({ driver, migrations, label: 'test', log: quiet });
  check('no signal on a no-op run', !second.signals.has('needsRechain'));
}

section('core: addColumn is idempotent, so re-running a migration cannot double-add');
{
  const db = scratchDb('core-addcolumn');
  const driver = sqliteDriver(db);
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, extra TEXT)');
  const migrations = [
    {
      version: 1,
      name: 'add-extra',
      up: (ctx) => {
        check('addColumn reports false when the column is already there', ctx.addColumn('t', 'extra', 'TEXT') === false);
        check('addColumn reports true when it really adds', ctx.addColumn('t', 'other', 'TEXT') === true);
      },
    },
  ];
  migrate({ driver, migrations, label: 'test', log: quiet });
  check('hasColumn agrees', driver.ddl.columns('t').includes('other'));
}

// ---------------------------------------------------------------------------
// B. The real node migration list
// ---------------------------------------------------------------------------

const { nodeMigrations } = require('./nodeMigrations');

/** table -> sorted column list, plus every index name — the shape two databases must agree on. */
function schemaShape(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const shape = {};
  for (const t of tables) {
    shape[t] = db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ''}`)
      .sort();
  }
  shape['#indexes'] = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return shape;
}

section('node: a fresh database reaches the latest version');
const freshDb = scratchDb('node-fresh');
{
  const driver = sqliteDriver(freshDb);
  const result = migrate({ driver, migrations: nodeMigrations, label: 'node', log: quiet });
  check('from 0', result.from === 0, `got ${result.from}`);
  check('to latest', result.to === nodeMigrations.length, `${result.to} of ${nodeMigrations.length}`);
  for (const t of ['capabilities', 'principals', 'grants', 'usage_events', 'windrow_audit', 'kv']) {
    check(`created ${t}`, driver.ddl.hasTable(t));
  }
}

section('node: reopening an up-to-date database does nothing');
{
  const driver = sqliteDriver(freshDb);
  const result = migrate({ driver, migrations: nodeMigrations, label: 'node', log: quiet });
  check('nothing applied', result.applied.length === 0, `applied ${result.applied.length}`);
  check('no signals', result.signals.size === 0, [...result.signals].join(','));
}

section('node: a legacy-shaped database migrates to the same schema as a fresh one');
{
  // A database as it looked before the column-adding migrations: the core tables with only the
  // columns that predate them. This is the field case the ledger exists for — an old node opened
  // by a new build.
  const legacyDb = scratchDb('node-legacy');
  legacyDb.exec(`
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT NOT NULL, owner TEXT, riskTier TEXT NOT NULL,
      description TEXT, source TEXT, discoveredAt TEXT, lastSeenAt TEXT,
      stale INTEGER NOT NULL DEFAULT 0, realUsage TEXT
    );
    CREATE TABLE principals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, parentRole TEXT,
      humanName TEXT, backend TEXT, agentType TEXT, field TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, principalId TEXT NOT NULL, capabilityId TEXT NOT NULL,
      constraints TEXT, createdAt TEXT NOT NULL, expiresAt TEXT,
      UNIQUE(principalId, capabilityId)
    );
    CREATE TABLE governance_audit (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, actorScope TEXT NOT NULL, osUser TEXT,
      hostname TEXT, principalId TEXT, capabilityId TEXT, grantId TEXT, before TEXT, after TEXT,
      reason TEXT, createdAt TEXT NOT NULL
    );
    CREATE INDEX idx_governance_audit_createdAt ON governance_audit(createdAt);
    CREATE INDEX idx_governance_audit_grantId ON governance_audit(grantId);
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY, principalId TEXT NOT NULL, capabilityId TEXT NOT NULL,
      ts TEXT NOT NULL, outcome TEXT NOT NULL, latencyMs INTEGER NOT NULL,
      correlationId TEXT, reason TEXT
    );
    CREATE TABLE discovery_sources (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, label TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      builtIn INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
    );
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Rows that must survive: the rename must carry the audit trail, and the grants rebuild must
  // carry the grants.
  legacyDb
    .prepare('INSERT INTO governance_audit (id, grantId, action, actorScope, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run('aud_1', 'gr_1', 'grant', 'admin', '2026-01-01T00:00:00.000Z');
  legacyDb
    .prepare('INSERT INTO grants (id, principalId, capabilityId, createdAt) VALUES (?, ?, ?, ?)')
    .run('gr_1', 'pr_1', 'cap_1', '2026-01-01T00:00:00.000Z');
  legacyDb
    .prepare("INSERT INTO capabilities (id, name, riskTier, owner) VALUES ('cap_1', 'mcp__x', 'read_only', 'governance')")
    .run();
  // Duplicate (kind, name) principals — the state migration 16's UNIQUE index cannot be created
  // over, and the one an old node can genuinely be holding: two hook processes both missed and
  // both inserted. Inserted oldest-first so "keeps MIN(rowid)" is a claim about which row wins.
  // The two `user` rows are the exemption: their key is subjectId (NULL here, since the column
  // arrives with migration 3), their name is a label, and both must survive.
  for (const [id, kind, name] of [
    ['pr_dup_old', 'instance', 'loom-1'],
    ['pr_dup_new', 'instance', 'loom-1'],
    ['pr_role_old', 'role', 'claude'],
    ['pr_role_new', 'role', 'claude'],
    ['pr_user_a', 'user', 'ejbra'],
    ['pr_user_b', 'user', 'ejbra'],
  ]) {
    legacyDb.prepare('INSERT INTO principals (id, kind, name) VALUES (?, ?, ?)').run(id, kind, name);
  }

  const driver = sqliteDriver(legacyDb);
  check('starts un-ledgered at version 0', currentVersion(driver) === 0, `got ${currentVersion(driver)}`);
  const result = migrate({ driver, migrations: nodeMigrations, label: 'node', log: quiet });
  check('reaches latest', result.to === nodeMigrations.length, `${result.to} of ${nodeMigrations.length}`);

  const fresh = schemaShape(freshDb);
  const upgraded = schemaShape(legacyDb);
  for (const table of Object.keys(fresh)) {
    const a = JSON.stringify(fresh[table]);
    const b = JSON.stringify(upgraded[table]);
    check(`${table} matches the fresh schema`, a === b, a === b ? '' : `\n      fresh:    ${a}\n      upgraded: ${b}`);
  }
  check('no table left behind', !driver.ddl.hasTable('governance_audit'), 'governance_audit still present');
  check(
    'audit rows survived the rename',
    legacyDb.prepare("SELECT COUNT(*) AS n FROM windrow_audit WHERE id = 'aud_1'").get().n === 1
  );
  check(
    'grants survived the table rebuild',
    legacyDb.prepare("SELECT COUNT(*) AS n FROM grants WHERE id = 'gr_1' AND revokedAt IS NULL").get().n === 1
  );
  check(
    "the owner rename applied",
    legacyDb.prepare("SELECT owner FROM capabilities WHERE id = 'cap_1'").get().owner === 'windrow'
  );
  const survivors = legacyDb
    .prepare("SELECT id FROM principals WHERE name IN ('loom-1', 'claude') ORDER BY id")
    .all()
    .map((r) => r.id);
  check(
    'duplicate role/instance principals deduped to the oldest row',
    JSON.stringify(survivors) === JSON.stringify(['pr_dup_old', 'pr_role_old']),
    survivors.join(',')
  );
  check(
    'two user rows sharing a label both survived (name is a label, not a key)',
    legacyDb.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'user' AND name = 'ejbra'").get().n === 2
  );
  let rejected = false;
  try {
    legacyDb.prepare('INSERT INTO principals (id, kind, name) VALUES (?, ?, ?)').run('pr_dup_3', 'instance', 'loom-1');
  } catch (err) {
    rejected = err.code === 'SQLITE_CONSTRAINT_UNIQUE';
  }
  check('a fresh duplicate instance is refused by the index', rejected, 'the insert was accepted');
  let userAccepted = true;
  try {
    legacyDb.prepare('INSERT INTO principals (id, kind, name) VALUES (?, ?, ?)').run('pr_user_c', 'user', 'ejbra');
  } catch (err) {
    userAccepted = false;
  }
  check('a third user with the same label is still accepted', userAccepted, 'the index caught a user row');
}

// ---------------------------------------------------------------------------

for (const db of scratch) {
  try {
    db.close();
  } catch {
    /* closing a scratch db is best-effort */
  }
}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // Windows can hold a handle on a just-closed WAL file; a leftover temp dir is not a failure.
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
