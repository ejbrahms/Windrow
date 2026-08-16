const app = require('./app');
const store = require('./store');
const { startCacheWarmer } = require('./cacheWarmer');
const { startHookWatcher } = require('./hookWatcher');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Capability governance API listening on http://localhost:${PORT}/api`);
  // Recurring pre-warm of the hook-side capability/principal caches (server/cacheWarmer.js) —
  // keeps them fresh proactively instead of relying on each hook's own on-miss fetch to fill
  // them once and then let them go stale until the next unlucky call pays that cost again.
  startCacheWarmer(store);
  // Watches each backend's hook-config file (~/.claude/settings.json, etc.) for the
  // PreToolUse/PostToolUse entries providers.js installed — restores them and logs a tamper
  // event within a debounce window of any hand-edit or strip-out, via fs.watch rather than a
  // slow poll (server/hookWatcher.js).
  startHookWatcher(store);
});
