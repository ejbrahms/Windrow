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
// the discovery CLI (server/discovery/run-cli.js), migrate-json-to-sqlite.js, or any other script
// that calls store.save() directly without going through this server's routes.
//
// Both writers produce the *exact* file shape hooks/lib.js's loadCapabilityCache/
// loadPrincipalCache expect — this is a producer for that consumer's cache, not a second,
// independent one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AGENT_TOKEN } = require('./auth');
const { GRANT_SUBJECT_EPOCH } = require('./principals/subject');
const { envCompat, DATA_DIR } = require('./config');
const replica = require('./policy/replica');

// True when a central is configured, i.e. when server/policy/policyClient.js is the writer of the
// deny-list file. Read once here rather than passed in, because it is the same env var that decides
// whether the client starts at all (server/index.js) and the two must not be able to disagree.
const POLICY_CLIENT_OWNS_DENY_LIST = Boolean(envCompat('CENTRAL_URL'));


const CAPABILITY_CACHE_PATH = path.join(DATA_DIR, 'hook-capability-cache.json');
const PRINCIPAL_CACHE_PATH = path.join(DATA_DIR, 'hook-principal-cache.json');
// The grant replica read by hooks/lib.js on a fault — see refreshGrantCache below.
const GRANT_CACHE_PATH = path.join(DATA_DIR, 'hook-grant-cache.json');

// Same TTL env var hooks/lib.js reads, so the two stay in lockstep without either hardcoding the
// other's default. The warm interval defaults to well inside that window (60%) so a hook should
// essentially never observe an expired cache during normal operation, only during an actual
// server outage (at which point hooks/lib.js's own stale-cache fallback takes over).
const CAPABILITY_CACHE_TTL_MS = Number(envCompat('CAPABILITY_CACHE_TTL_MS')) || 30_000;
const WARM_INTERVAL_MS =
  Number(envCompat('CACHE_WARM_INTERVAL_MS')) || Math.floor(CAPABILITY_CACHE_TTL_MS * 0.6);

/**
 * write-then-rename so a hook reading mid-refresh never sees a truncated/partial JSON body.
 *
 * hooks/lib.js's readSignedCache() rejects (treats as absent, same as a missing file) any cache
 * file that isn't wrapped in its `{payload, sig}` HMAC envelope (finding #4 — see that file's
 * signPayload/readSignedCache). This writer has to produce that exact shape or every pre-warmed
 * file just silently fails that check on read, which sends every hook invocation back to a live
 * `GET /capabilities` / store upsert — the warmer would run, "succeed", and do nothing.
 */
function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payload, sig }));
  fs.renameSync(tmp, filePath);
}

function refreshCapabilityCache(store) {
  writeJsonAtomic(CAPABILITY_CACHE_PATH, { fetchedAt: Date.now(), capabilities: store.listCapabilities() });
}

/**
 * hooks/lib.js's resolvePrincipal() keys its cache by `identity.loomId`, and only ever stores
 * `instance`-kind principals (the per-agent row) — see server/principals/registry.js, where
 * `instance.name` *is* the loomId. Mirror that shape exactly (including the `epoch`/`subjects`
 * envelope that hook reads back — see hooks/lib.js's loadPrincipalCache) so a pre-warmed entry is
 * indistinguishable from one the hook would have written itself.
 */
function refreshPrincipalCache(store) {
  const principals = {};
  for (const principal of store.listPrincipals()) {
    if (principal.kind === 'instance') principals[principal.name] = principal;
  }
  // `epoch` is the grant-subject invalidation stamp the hook checks on every read: write anything
  // else here and hooks/lib.js discards the whole file, so a bump to GRANT_SUBJECT_EPOCH takes
  // effect on both writers at once. `subjects` is left empty on purpose — that map records the
  // subject a *hook* resolved an entry under, and these entries are mirrored from the live db on
  // the timer rather than resolved, so they are fresh by construction and need no stamp.
  writeJsonAtomic(PRINCIPAL_CACHE_PATH, { epoch: GRANT_SUBJECT_EPOCH, principals, subjects: {} });
}

/**
 * The grant replica (docs/design/upgrade-resilience.md §3.3). Without this, a hook that cannot
 * reach the server has no way to answer "is this principal actually granted this capability?", so
 * the only safe fault behaviour for a `mutating` call is a blanket deny — which is exactly the
 * outage that motivated the design. With it, a fault under a maintenance grace lease can run the
 * *real* grant check against cached rows, so a revoked grant is still denied rather than the whole
 * question being skipped.
 *
 * Mirrors app.js's `findActiveGrant` inputs, and only those:
 *   - `grants` is already revocation-filtered by store.listGrants (WHERE revokedAt IS NULL);
 *     expiry is left to the reader, since a cache written now is read later and `expiresAt` has to
 *     be evaluated against the time of the *call*, not the time of the warm.
 *   - `roles` maps a role name to its principal id, which is what the instance→parentRole fallback
 *     needs and is the one lookup the hook's principal cache can't answer (it stores only
 *     `instance` rows).
 * Deliberately NOT written on the same TTL contract as the capability cache: a grant replica is
 * only ever consulted on a fault, and `fetchedAt` is recorded so a reader can judge its age.
 */
function refreshGrantCache(store) {
  const roles = {};
  for (const principal of store.listPrincipals()) {
    if (principal.kind === 'role') roles[principal.name] = principal.id;
  }
  const grants = store.listGrants().map((g) => ({
    principalId: g.principalId,
    capabilityId: g.capabilityId,
    expiresAt: g.expiresAt ?? null,
  }));
  writeJsonAtomic(GRANT_CACHE_PATH, { fetchedAt: Date.now(), grants, roles });
}

/**
 * The always-full deny-list (docs/design/global-identity-and-central-db.md §2.4), for the install
 * that has no central.
 *
 * server/policy/policyClient.js writes this same file from central's responses on an enrolled node.
 * Here the node's own database *is* the authority, so the list is computed locally and stamped
 * `central: false` — which is what tells server/hooks/lib.js not to apply a staleness bound to it.
 * A single-machine install has no policy age: there is no channel that could be behind.
 *
 * Written even though app.js already denies revoked grants on the live path, because the hook's
 * deny-list check has to behave the same in both deployments. If this file only existed on enrolled
 * nodes, the check would be dead code on every standalone box and would first run in anger on the
 * day a fleet was stood up.
 */
function refreshDenyList(store) {
  if (typeof store.policyDenyList !== 'function') return; // store predates the policy log
  const denyList = store.policyDenyList();
  replica.saveDenyList({
    denyList,
    version: denyList.version,
    fetchedAt: Date.now(),
    central: false,
    // HAS THIS INSTALL'S REGISTRY EVER BEEN POPULATED — docs/design/disposable-nodes.md §3's third
    // correctness gap, and the mirror image of item 8's fix for the central case.
    //
    // The gap: on a FRESH STANDALONE node the database is empty, so `policyPosture.replicating` is
    // false, so the hook's unknown-capability branch takes "allow, ungoverned" — and EVERY GOVERNED
    // CALL IS PERMITTED until discovery and seeding repopulate, while /api/ready happily returns
    // 200. Item 8 closed exactly this window for a replica node ("policy-never-pulled"); the
    // standalone case was still a fresh-install window in which nothing is governed.
    //
    // The fix is the same shape and rides the same file: the WRITER states whether it has anything
    // to be authoritative about, because the hook cannot ask — it runs in the agent's environment
    // and has no database handle. An empty registry is not "nothing is governed here", it is "this
    // machine does not know yet", and those must not be the same answer.
    //
    // `capabilityCount` rather than a boolean, because the number is the diagnosis: a hook denying
    // an unknown tool says "this node's registry holds 0 capabilities", and an operator reads that
    // as "run discovery" rather than as a mystery.
    seeded: capabilityCount(store) > 0,
    capabilityCount: capabilityCount(store),
  });
}

/** How many capabilities this node's own registry holds. Cheap, and the one fact that distinguishes
 *  a machine with nothing to govern from a machine that has not looked yet. */
function capabilityCount(store) {
  try {
    return typeof store.listCapabilities === 'function' ? store.listCapabilities().length : 0;
  } catch {
    return 0;
  }
}

function refreshAll(store) {
  try {
    refreshCapabilityCache(store);
    refreshPrincipalCache(store);
    refreshGrantCache(store);
    // Skipped on an enrolled node: policyClient owns the file there, and two writers would race —
    // the local one would keep stamping a fresh `fetchedAt` onto policy that central has not
    // confirmed, which is exactly the staleness the bound exists to detect.
    if (!POLICY_CLIENT_OWNS_DENY_LIST) refreshDenyList(store);
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

module.exports = { startCacheWarmer, refreshAll, refreshCapabilityCache, refreshPrincipalCache, refreshGrantCache, refreshDenyList };
