// One-time migration: imports the old server/data/db.json into the new SQLite store
// (server/data/windrow.db). Safe to run multiple times — it's a no-op once db.json has been
// renamed to db.json.bak, and it refuses to run if the SQLite store already has data (so it never
// silently clobbers a live database with a stale JSON snapshot).
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const JSON_PATH = path.join(__dirname, 'data', 'db.json');
const BACKUP_PATH = path.join(__dirname, 'data', 'db.json.bak');

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log('No server/data/db.json found — nothing to migrate.');
    return;
  }
  const current = store.load();
  const hasData =
    current.capabilities.length || current.principals.length || current.grants.length || current.usageEvents.length;
  if (hasData) {
    console.log('server/data/windrow.db already has data — refusing to overwrite. Delete it first if you really want to re-import.');
    return;
  }
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  const snapshot = {
    capabilities: parsed.capabilities || [],
    principals: parsed.principals || [],
    grants: parsed.grants || [],
    usageEvents: parsed.usageEvents || [],
    discovery: parsed.discovery || null,
  };
  store.save(snapshot);
  fs.renameSync(JSON_PATH, BACKUP_PATH);
  console.log(
    `Migrated ${snapshot.capabilities.length} capabilities, ${snapshot.principals.length} principals, ` +
      `${snapshot.grants.length} grants, ${snapshot.usageEvents.length} usage events -> ${store.DB_PATH}\n` +
      `Old file kept as ${BACKUP_PATH}.`
  );
}

main();
