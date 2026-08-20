'use strict';

// The SQLite half of the driver seam described in ./migrator.js — everything in this file is a
// statement or a catalogue query that Postgres spells differently, and nothing else is. The node
// store passes one of these; the central store of docs/design/global-identity-and-central-db.md
// §2.5 passes a Postgres one and reuses the migrator unchanged.

/** @param {import('better-sqlite3').Database} db */
function sqliteDriver(db) {
  return {
    name: 'sqlite',
    exec: (sql) => db.exec(sql),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    transaction: (fn) => db.transaction(fn),
    ddl: {
      hasTable: (name) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined,
      // Empty array for a table that doesn't exist, which is what makes `addColumn` on a
      // not-yet-created table a loud failure (the ALTER throws) rather than a silent skip.
      columns: (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
      createLedger: (table) =>
        db.exec(`
          CREATE TABLE IF NOT EXISTS ${table} (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            appliedAt TEXT NOT NULL
          )
        `),
    },
    // Parameterised, so a migration name is never interpolated into SQL.
    prepareLedgerInsert: (table) => {
      const stmt = db.prepare(`INSERT INTO ${table} (version, name, appliedAt) VALUES (?, ?, ?)`);
      return (version, name, appliedAt) => stmt.run(version, name, appliedAt);
    },
  };
}

module.exports = { sqliteDriver };
