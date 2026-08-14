const app = require('./app');
const store = require('./store');
const { startCacheWarmer } = require('./cacheWarmer');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Capability governance API listening on http://localhost:${PORT}/api`);
  // Recurring pre-warm of the hook-side capability/principal caches (server/cacheWarmer.js) —
  // keeps them fresh proactively instead of relying on each hook's own on-miss fetch to fill
  // them once and then let them go stale until the next unlucky call pays that cost again.
  startCacheWarmer(store);
});
