// `npm run discover` — runs a discovery pass directly against data/db.json, no server needed.
// Useful for a future cron job (roadmap item 1 is meant to run periodically, not just on demand).
const store = require('../store');
const { runDiscovery } = require('./index');

const db = store.load();
const result = runDiscovery(db);
store.save(db);

console.log(
  `Discovery run: +${result.added.length} added, ${result.updated.length} updated, ` +
    `${result.staled.length} newly stale.`
);
if (result.added.length) {
  console.log('Added:', result.added.map((c) => `${c.kind}/${c.name} (${c.source})`).join(', '));
}
if (result.staled.length) {
  console.log('Newly stale:', result.staled.map((c) => `${c.kind}/${c.name}`).join(', '));
}
