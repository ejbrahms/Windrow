'use strict';

// One versioned migrator, shared by the node store and the central store.
// docs/design/global-identity-and-central-db.md §2.5, "Schema migration" row: *one versioned
// migrator for both stores*, replacing the ad-hoc guarded `ALTER TABLE` blocks `server/store.js`
// used to hand-roll inline. The reason to do it now rather than later is in the same row — N nodes
// on user PCs update at N different times (§2.6), and "what schema is this database at" has to be
// a number a machine can read, compare and refuse on, not something inferred by sweeping
// `PRAGMA table_info` over every table on every boot.
//
// What the ledger buys that the guarded blocks did not:
//
//   - **A number.** `schema_migrations` records every applied version with a timestamp, so a node
//     can report where it is and central can tell a fleet at mixed versions apart from a fleet
//     that is merely quiet. `currentVersion()` is that number.
//   - **A refusal.** A database at a version *higher* than the code knows about is a downgrade —
//     an older build opened a database a newer one already migrated. The guarded blocks could not
//     see this at all: every guard reads "column already present, nothing to do" and the old code
//     runs happily against a shape it does not understand, writing rows the new build will read
//     back wrong. Here it throws before a single statement runs.
//   - **A no-op boot.** Once a database is at the latest version this does one indexed read and
//     returns. The old blocks ran ~10 `PRAGMA table_info` sweeps and a dozen conditionals on every
//     process start, including every CLI and hook invocation.
//   - **One place migrations are declared**, in order, each with a name that survives into the
//     ledger — so "which change is this database missing" is answerable without reading code.
//
// ## Driver seam
//
// The core is dialect-agnostic; everything SQLite-specific lives behind a driver object, so the
// central Postgres store of §2.5 reuses this file unchanged with its own driver and its own
// migration list. A driver provides:
//
//   {
//     name,                        // for log lines: 'sqlite', 'postgres'
//     exec(sql),                   // run one or more statements, no result
//     get(sql, params) -> row|undefined,
//     all(sql, params) -> rows,
//     transaction(fn) -> fn',      // returns a function that runs fn atomically
//     ddl: {                       // the handful of shapes that differ between engines
//       hasTable(name) -> bool,
//       columns(table) -> string[],
//       createLedger(table),       // CREATE TABLE IF NOT EXISTS <table> (...)
//     },
//   }
//
// ## How a migration is written
//
// Each entry is `{ version, name, up(ctx) }`, `version` a positive integer, dense and ascending.
// `ctx` carries the driver plus the small helpers below (`addColumn`, `hasTable`, `hasColumn`,
// `signal`). `up` runs inside a transaction together with the ledger insert, so a crash mid-way
// leaves the database at the previous version and the next boot retries — never half-applied and
// recorded as done.
//
// > Migrations stay idempotent even though the ledger means they normally run once. That is
// > deliberate, and it is what makes adopting this safe on the databases that already exist:
// > version 1 creates the schema in its *current* full shape (`CREATE TABLE IF NOT EXISTS`), so on
// > a fresh database every later column-adding migration finds its column already there. Those
// > migrations exist for the databases in the field that predate each column. `addColumn()` is the
// > one place that guard now lives, instead of a hand-written `PRAGMA table_info` block per column.
// > An existing un-ledgered database is therefore baselined by simply running the whole list: each
// > migration no-ops over what it already has. Nothing is rewritten, nothing is dropped.

const LEDGER_TABLE = 'schema_migrations';

/** Thrown when the database is at a version this build does not know about — a downgrade. */
class SchemaTooNewError extends Error {
  constructor(dbVersion, codeVersion, label) {
    super(
      `${label} database is at schema version ${dbVersion} but this build only knows up to `
        + `${codeVersion}. A newer build already migrated it; downgrading would corrupt it. `
        + 'Run the newer build, or restore a backup taken before the upgrade.'
    );
    this.name = 'SchemaTooNewError';
    this.dbVersion = dbVersion;
    this.codeVersion = codeVersion;
  }
}

/** Ordered, dense, ascending from 1 — a gap or a repeat is a merge accident, caught before it runs. */
function assertWellFormed(migrations, label) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `${label} migration list is malformed at index ${i}: expected version ${i + 1}, found `
          + `${m.version} (${m.name || 'unnamed'}). Versions must be dense and ascending from 1.`
      );
    }
    if (!m.name) throw new Error(`${label} migration ${m.version} has no name.`);
    if (typeof m.up !== 'function') throw new Error(`${label} migration ${m.version} (${m.name}) has no up().`);
  });
}

/** The highest version recorded in the ledger, or 0 on a database that has never been migrated. */
function currentVersion(driver) {
  if (!driver.ddl.hasTable(LEDGER_TABLE)) return 0;
  const row = driver.get(`SELECT MAX(version) AS v FROM ${LEDGER_TABLE}`);
  return (row && row.v) || 0;
}

/** The ledger writer: parameterised if the driver offers one, otherwise a literal INSERT. */
function ledgerRecorder(driver) {
  if (driver.prepareLedgerInsert) return driver.prepareLedgerInsert(LEDGER_TABLE);
  return (version, name, appliedAt) =>
    driver.exec(
      `INSERT INTO ${LEDGER_TABLE} (version, name, appliedAt) `
        + `VALUES (${version}, '${String(name).replace(/'/g, "''")}', '${appliedAt}')`
    );
}

/** The `ctx` one migration's `up()` receives. Identical for both runners — the only difference
 *  between them is whether the calls it makes return values or promises, and a migration written
 *  for an async driver simply awaits them. */
function migrationContext(driver, signals) {
  return {
    driver,
    exec: (sql) => driver.exec(sql),
    get: (sql, params) => driver.get(sql, params),
    all: (sql, params) => driver.all(sql, params),
    hasTable: (t) => driver.ddl.hasTable(t),
    hasColumn: (t, c) => driver.ddl.columns(t).includes(c),
    /** Add a column if the table doesn't already have it. The one guard, in one place. */
    addColumn: (table, column, definition) => {
      const present = driver.ddl.columns(table);
      // Sync driver: an array. Async driver: a promise of one. Both answer the same question, so
      // the guard is written once and the async caller awaits the answer.
      if (present && typeof present.then === 'function') {
        return present.then((cols) =>
          cols.includes(column) ? false : Promise.resolve(driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)).then(() => true)
        );
      }
      if (present.includes(column)) return false;
      driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    },
    signal: (name) => signals.add(name),
  };
}

function migratedLine(label, from, latest, applied) {
  return `[schema] ${label}: migrated ${from} → ${latest} (${applied.map((m) => `${m.version} ${m.name}`).join(', ')})`;
}

/**
 * Bring `driver`'s database up to the latest version in `migrations`.
 *
 * Returns `{ from, to, applied, signals }`. `signals` is a Set of strings raised by migrations via
 * `ctx.signal(name)` — the way a migration tells the store "you now have work to do that isn't
 * DDL", e.g. the usage-event hash chain needs re-chaining because a column that feeds the
 * canonical form just arrived. Callers read it with `signals.has('…')`; a migration that didn't
 * run this boot raises nothing, which is exactly the old `let needsRechain = false` flags but
 * without them being module-level state in the middle of the schema.
 *
 * Synchronous — the node store calls this on the boot path of every CLI and hook process, so it
 * must not be a promise. See `migrateAsync` for the central Postgres half.
 */
function migrate({ driver, migrations, label = driver.name, log = console.log }) {
  assertWellFormed(migrations, label);
  const latest = migrations.length;

  driver.ddl.createLedger(LEDGER_TABLE);
  const from = currentVersion(driver);

  if (from > latest) throw new SchemaTooNewError(from, latest, label);
  if (from === latest) return { from, to: from, applied: [], signals: new Set() };

  const signals = new Set();
  const applied = [];
  const record = ledgerRecorder(driver);

  for (const m of migrations.slice(from)) {
    const ctx = migrationContext(driver, signals);
    // The migration and its ledger row commit together: a crash between them would otherwise
    // record work that did not happen (silently skipping it forever) or repeat work that did.
    driver.transaction(() => {
      m.up(ctx);
      record(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m);
  }

  log(migratedLine(label, from, latest, applied));
  return { from, to: latest, applied, signals };
}

/**
 * The same migrator, for a driver whose calls return promises.
 *
 * WHY THERE ARE TWO. §2.5 says one versioned migrator serves both stores, and this is still that
 * file, that ledger, that `SchemaTooNewError`, that well-formedness check and that context shape —
 * what could not be shared is the loop, because **there is no synchronous PostgreSQL client for
 * Node**. `better-sqlite3` returns rows; `pg` returns promises. Making the one runner async would
 * have handed the node a promise on a path that is taken by every hook process and every CLI on
 * every tool call, where the boot cost is measured in milliseconds (docs/design/latency-
 * breakdown.md) and a promise means at minimum another turn of the event loop before the first
 * statement can run.
 *
 * So the split is along the one axis the two stores genuinely differ on, and nothing else is
 * duplicated: a migration list is written the same way for either, and an `await` in front of
 * `ctx.exec` is harmless on the sync driver.
 *
 * `driver.transaction(fn)` here returns a function that runs `fn` — which may be async — inside a
 * transaction, and resolves once it has committed.
 */
async function migrateAsync({ driver, migrations, label = driver.name, log = console.log }) {
  assertWellFormed(migrations, label);
  const latest = migrations.length;

  await driver.ddl.createLedger(LEDGER_TABLE);
  const from = (await driver.ddl.hasTable(LEDGER_TABLE))
    ? Number((await driver.get(`SELECT MAX(version) AS v FROM ${LEDGER_TABLE}`))?.v || 0)
    : 0;

  if (from > latest) throw new SchemaTooNewError(from, latest, label);
  if (from === latest) return { from, to: from, applied: [], signals: new Set() };

  const signals = new Set();
  const applied = [];
  const record = ledgerRecorder(driver);

  for (const m of migrations.slice(from)) {
    const ctx = migrationContext(driver, signals);
    await driver.transaction(async () => {
      await m.up(ctx);
      await record(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m);
  }

  log(migratedLine(label, from, latest, applied));
  return { from, to: latest, applied, signals };
}

module.exports = { migrate, migrateAsync, currentVersion, SchemaTooNewError, LEDGER_TABLE };
