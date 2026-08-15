'use strict';
// Keeps the hook-side file caches (server/hooks/lib.js: CAPABILITY_CACHE_PATH,
// PRINCIPAL_CACHE_PATH) warm from the server side, instead of leaving them to be filled lazily —
// on miss, inline, by whichever hook process happens to run right after the previous cache goes
// stale or an agent's very first call. That lazy fill is a one-time step *per file*: it happens
// once, on demand, and pays its `GET /capabilities` (or store upsert) round trip on the hot path
// of whatever tool call triggered it. This module turns that into a standing background process
// with two triggers instead:
//
//   1. A recurring timer, running strictly inside the hook's own TTL window, so under normal
//      operation a cache should never be judged stale by a reading hook in the first place —
//      it's rewritten before that can happen.
//   2. An immediate refresh right after any request in *this* process that mutates capabilities
//      or principals (register/retier a capability, create a principal, run discovery), so a
//      change is visible to the very next hook call instead of waiting out the timer.
//
// The timer alone also covers every out-of-band mutation path a per-route refresh can't see —
// the discovery CLI (server/discovery/run-cli.js), migrate-json-to-sqlite.js,
// backfill-inherited-grants.js, or any other script that calls store.save() directly without
// going through this server's routes.
//
// Both writers produce the *exact* file shape hooks/lib.js's loadCapabilityCache/
// loadPrincipalCache expect — this is a producer for that consumer's cache, not a second,
// independent one.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CAPABILITY_CACHE_PATH = path.join(DATA_DIR, 'hook-capability-cache.json');
const PRINCIPAL_CACHE_PATH = path.join(DATA_DIR, 'hook-principal-cache.json');

// Same TTL env var hooks/lib.js reads, so the two stay in lockstep without either hardcoding the
// other's default. The warm interval defaults to well inside that window (60%) so a hook should
// essentially never observe an expired cache during normal operation, only during an actual
// server outage (at which point hooks/lib.js's own stale-cache fallback takes over).
const CAPABILITY_CACHE_TTL_MS = Number(process.env.GOVERNANCE_CAPABILITY_CACHE_TTL_MS) || 30_000;
const WARM_INTERVAL_MS =
  Number(process.env.GOVERNANCE_CACHE_WARM_INTERVAL_MS) || Math.floor(CAPABILITY_CACHE_TTL_MS * 0.6);

/** write-then-rename so a hook reading mid-refresh never sees a truncated/partial JSON body. */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function refreshCapabilityCache(store) {
  writeJsonAtomic(CAPABILITY_CACHE_PATH, { fetchedAt: Date.now(), capabilities: store.listCapabilities() });
}

/**
 * hooks/lib.js's resolvePrincipal() keys its cache by `identity.loomId`, and only ever stores
 * `instance`-kind principals (the per-agent row) — see server/principals/registry.js, where
 * `instance.name` *is* the loomId. Mirror that shape exactly so a pre-warmed entry is
 * indistinguishable from one the hook would have written itself.
 */
function refreshPrincipalCache(store) {
  const cache = {};
  for (const principal of store.listPrincipals()) {
    if (principal.kind === 'instance') cache[principal.name] = principal;
  }
  writeJsonAtomic(PRINCIPAL_CACHE_PATH, cache);
}

function refreshAll(store) {
  try {
    refreshCapabilityCache(store);
    refreshPrincipalCache(store);
  } catch (err) {
    // Best-effort: a failed pre-warm just means the next hook falls back to its own lazy
    // fetch/upsert, exactly as if this module didn't exist. Never let it take the server down.
    console.error('[cache-warmer] refresh failed:', err.message);
  }
}

/**
 * Starts the recurring pre-warm timer and does one immediate synchronous warm-up first, so the
 * very first hook call after a fresh server start already finds a warm cache instead of paying
 * the old one-time miss. Call once, at server startup (server/index.js). Returns a `stop()`
 * function (tests / graceful shutdown); the timer is `unref()`d so it never keeps the process
 * alive on its own.
 */
function startCacheWarmer(store, { intervalMs = WARM_INTERVAL_MS } = {}) {
  refreshAll(store);
  const timer = setInterval(() => refreshAll(store), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startCacheWarmer, refreshAll, refreshCapabilityCache, refreshPrincipalCache };
