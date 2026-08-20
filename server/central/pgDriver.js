'use strict';

// The Postgres half of the driver seam described in ../schema/migrator.js — the counterpart to
// ../schema/sqliteDriver.js, and, as that file predicted, nothing in here is anything but "a
// statement or a catalogue query that the other engine spells differently".
//
// docs/design/global-identity-and-central-db.md §2.5 picks PostgreSQL 16 for central because it is
// boring: range partitioning, `ON CONFLICT` and `LISTEN/NOTIFY` are all built in. This file is the
// smallest possible amount of code that lets the existing migrator drive it.
//
// TWO DIFFERENCES FROM THE SQLITE DRIVER, both forced by the engine rather than chosen here:
//
//   1. **Everything is async.** There is no synchronous Postgres client for Node, which is why
//      ../schema/migrator.js grew `migrateAsync` alongside `migrate`. See the comment there.
//   2. **Placeholders are `$1`, not `?`.** Callers write `$1`; nothing rewrites `?` behind their
//      back, because a silent dialect translation is how a query starts meaning two things.
//
// IDENTIFIER CASE. Postgres folds unquoted identifiers to lower case, and the node's schema is
// camelCase throughout (`nodeId`, `latencyMs`, `capabilityLookupMs`). Rather than rename every
// column at the boundary — which would make the shipped envelope and the stored row disagree, and
// every query in this directory a translation of one naming scheme into another — central quotes
// its identifiers and keeps the node's spelling exactly. `pg` then returns rows whose keys are the
// camelCase names the rest of the codebase already uses, so a row read out of central and a row
// read out of a node's SQLite are the same shape.

const { envCompat } = require('../config');

/**
 * `pg` is required lazily and reported, not thrown, when absent.
 *
 * Central is one machine; nodes are N user PCs that never open a Postgres connection. A top-level
 * `require('pg')` would make every hook process, every CLI and every node boot pay for a module
 * they will never call — and would turn "this install has no central" into a crash rather than the
 * normal state it is.
 */
let bigintsAreNumbers = false;

/**
 * `pg` returns `BIGINT` (oid 20) as a **string**, and that default is right for a general driver
 * and wrong for every column central has.
 *
 * The reason it is not a preference: every count in ./queries.js is `COUNT(*)::BIGINT`, and every
 * sequence number is `BIGINT`, so left as strings `seq !== prev + 1` compares "2" against "11" and
 * a perfectly continuous hash chain reports a break — the chain-verification failing OPEN in the
 * one direction that matters, since the check that is supposed to detect a tampered stream would
 * instead alarm on every intact one. Downstream arithmetic goes the same way: `nodeCount -
 * centralCount` on two strings is a concatenation.
 *
 * The precision this trades away is real and it is not reachable here. `Number` is exact to 2^53;
 * the largest BIGINT central produces is a per-node shipment counter, which at the ~10k events/s
 * §2.5 names as the point a real queue is warranted would take about thirty thousand years to
 * overflow. Every other BIGINT is a COUNT over the same rows.
 */
function coerceBigints(pg) {
  if (bigintsAreNumbers) return;
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  bigintsAreNumbers = true;
}

function loadPg() {
  try {
    // eslint-disable-next-line global-require
    const pg = require('pg');
    coerceBigints(pg);
    return pg;
  } catch (err) {
    throw new Error(
      'the `pg` package is not installed, so the central store cannot open a connection. '
        + 'Run `npm install --prefix server` on the central host. '
        + `(${err.message})`
    );
  }
}

/** Connection settings, from one URL or the standard PG* pieces. Returns null when nothing is
 *  configured, which is what tells a caller "there is no central here" without guessing. */
function centralDbConfig(env = process.env) {
  const url = envCompat('CENTRAL_DB_URL', { env }) || env.DATABASE_URL || null;
  if (url) return { connectionString: url };
  if (!env.PGHOST && !env.PGDATABASE) return null;
  return {
    host: env.PGHOST,
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
  };
}

/**
 * Open a pool. One pool per process; `pg` keeps the connections warm, which is the whole reason
 * §2.3 puts shipping in the long-lived service and not in the per-call hook process.
 */
function openPool(config = centralDbConfig()) {
  if (!config) {
    throw new Error(
      'no central database configured — set WINDROW_CENTRAL_DB_URL '
        + '(e.g. postgres://windrow:…@localhost:5432/windrow_central) or the PG* environment variables.'
    );
  }
  const { Pool } = loadPg();
  const pool = new Pool({
    ...config,
    max: Number(envCompat('CENTRAL_DB_POOL_MAX')) || 10,
    // A connect that hangs is worse than one that fails: ingest has a node waiting on it with a
    // retry queue that is already durable, so failing fast and letting the node keep the rows is
    // strictly better than holding its request open.
    connectionTimeoutMillis: Number(envCompat('CENTRAL_DB_CONNECT_TIMEOUT_MS')) || 10_000,
    idleTimeoutMillis: 30_000,
  });
  // A pool with no error listener crashes the process when an idle backend is killed — routine
  // during a Postgres restart, and not a reason for central to go down with it.
  pool.on('error', (err) => console.error('[central-db] idle client error:', err.message));
  return pool;
}

/**
 * Wrap a pool (or a single checked-out client) as a migrator driver.
 *
 * Pass a client rather than the pool when the caller already holds one — `transaction` below needs
 * every statement in the transaction to run on the *same* connection, which a pool does not
 * guarantee, so it re-wraps its client with this same function.
 */
function pgDriver(poolOrClient) {
  const isPool = typeof poolOrClient.connect === 'function' && typeof poolOrClient.release !== 'function';

  const driver = {
    name: 'postgres',
    query: (sql, params = []) => poolOrClient.query(sql, params),
    exec: async (sql) => { await poolOrClient.query(sql); },
    get: async (sql, params = []) => (await poolOrClient.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await poolOrClient.query(sql, params)).rows,

    /**
     * Returns a function that runs `fn` inside BEGIN/COMMIT on one connection.
     *
     * When this driver already *is* a single client, it does not open a nested transaction —
     * Postgres has no nested BEGIN, and issuing one logs a warning and silently joins the outer
     * transaction, so a "rollback" of the inner one would roll back the outer too. Joining
     * explicitly is the honest version of what would happen anyway.
     */
    transaction: (fn) => async (...args) => {
      if (!isPool) return fn(...args);
      const client = await poolOrClient.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the connection is already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },

    /** Run `fn(driverForOneClient)` on a single pooled connection inside a transaction. This is
     *  what a migration or a batch insert wants: `ctx.exec` inside it must reach the same
     *  connection as the BEGIN, which `pool.query` cannot promise. */
    withTransaction: async (fn) => {
      if (!isPool) return fn(driver);
      const client = await poolOrClient.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(pgDriver(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },

    ddl: {
      hasTable: async (name) => {
        const row = await driver.get('SELECT to_regclass($1) AS oid', [name]);
        return Boolean(row && row.oid);
      },
      // Empty array for a table that doesn't exist — same contract as the SQLite driver, so
      // `addColumn` against a missing table fails loudly on the ALTER rather than silently
      // skipping.
      columns: async (table) =>
        (await driver.all(
          'SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()',
          [table]
        )).map((c) => c.column_name),
      createLedger: (table) =>
        driver.exec(`
          CREATE TABLE IF NOT EXISTS "${table}" (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            "appliedAt" TEXT NOT NULL
          )
        `),
    },

    // Parameterised, so a migration name is never interpolated into SQL.
    prepareLedgerInsert: (table) => (version, name, appliedAt) =>
      driver.query(`INSERT INTO "${table}" (version, name, "appliedAt") VALUES ($1, $2, $3)`, [version, name, appliedAt]),
  };

  return driver;
}

module.exports = { pgDriver, openPool, centralDbConfig };
