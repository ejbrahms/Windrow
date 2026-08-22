// Tier 4 of docs/design/governance-to-windrow-rename.md: the GOVERNANCE_* env names are gone.
// This runs FIRST, before any require() that reads configuration, so a field still setting the old
// names is told all of them at once at boot instead of discovering them one restart at a time.
const { assertNoLegacyEnv } = require('./config');
assertNoLegacyEnv();

const http = require('http');
const https = require('https');
const app = require('./app');
const store = require('./store');
const ca = require('./enrollment/ca');
const { startCacheWarmer } = require('./cacheWarmer');
const { startHookWatcher } = require('./hookWatcher');
const { applyEnvEnforcementPause, startEnforcementPauseHeartbeat } = require('./enforcementPause');
const { startNativeObservationDrain } = require('./nativeObservations');
const { startUsageShipper } = require('./usageShipper');
const { startNodeAlertEngine } = require('./alerts/nodeEngine');
const { startAlertShipper, shipAlertsNow } = require('./alerts/nodeShipper');
const { startPolicyClient } = require('./policy/policyClient');
const { setBackends } = require('./policy');
const { resolvePolicyAuthority, CENTRAL } = require('./policy/authority');

// ---------------------------------------------------------------------------
// WHO OWNS POLICY — docs/design/global-identity-and-central-db.md §2.7 phase 4.
//
// This runs at require time, BEFORE ./app is required below, and that ordering is the whole of it.
// server/app.js resolves the same authority when it loads and decides then whether to mount its own
// policy channel; and the store has to be locked before any route can reach a mutator. Binding
// after the app had loaded would leave a window in which a write could still land locally — short,
// but the kind of window that only ever opens under load.
//
// TWO EFFECTS, and they are deliberately separate:
//
//   setBackends   points the policyStore seam at the replica adapter, so every write in app.js goes
//                 to central and every read comes from the local mirror.
//   setPolicyReadOnly  makes the store itself refuse a policy write from ANY caller — a script, a
//                 migration, a route written next year. Without it the flip would be a convention
//                 that holds only for code that happens to go through the seam.
//
// A node that asks for central authority and cannot name a central stays node-authoritative and
// says so loudly (./policy/authority.js). Downgrading quietly would leave an operator believing a
// machine was replicating while it enforced its own opinion.
const { authority: policyAuthority, centralUrl, error: authorityError } = resolvePolicyAuthority();
if (authorityError) console.error('[policy-authority]', authorityError);
if (policyAuthority === CENTRAL) {
  // eslint-disable-next-line global-require
  setBackends({ policyStore: require('./policy/centralPolicyStore') });
  store.setPolicyReadOnly(true);
  console.log(
    `[policy-authority] central at ${centralUrl} owns grants and capabilities on this node.`,
    'Local policy tables are a read replica; writes are proxied and revocations ride the deny-list.'
  );
}

// TWO LISTENERS, NOT ONE (docs/design/per-node-enrollment-credentials.md).
//
// Callers now authenticate with a per-node client certificate rather than a shared bearer token,
// but hooks are deliberately exempt: a PreToolUse/PostToolUse hook is a fresh Node process per tool
// call, so it can never reuse a connection, and docs/design/latency-breakdown.md measures ~20 ms
// lost merely to `fetch()` building its agent lazily in each process. A TLS handshake is worse.
//
// So the plaintext listener survives for hooks alone, and is bound to 127.0.0.1 explicitly — that
// bind is what makes the agent token machine-local by construction rather than by convention, which
// is the property that replaces the fleet-wide token this change removed. server/auth.js will only
// ever grant `agent` scope on it, so admin authority cannot travel over it even if a credential for
// admin were somehow presented.
const PORT = process.env.PORT || 4000;
const TLS_PORT = process.env.WINDROW_TLS_PORT || 4443;

// A throwaway instance booted by scripts/sandbox.js against a *copy* of the live database. All
// three background workers below reach outside that copy — the cache warmer rewrites
// server/data/hook-*-cache.json, which the live hooks read on every tool call; the hook watcher
// restores hook entries into the real ~/.claude/settings.json; and the native-observation drain
// CONSUMES the live spool, deleting lines the real instance has not recorded yet. That last one is
// the most damaging of the three to run by accident, because it is destructive rather than merely
// misdirected: the observations would land in the scratch database and be gone from the real one.
//
// The usage shipper is a fourth, and worse in a way that is not obvious: the copy carries the real
// node's id and its outbox shipment numbers, so a sandbox would ship the copy's queue under the
// real node's identity and *burn those shipment numbers*. Central dedupes on (nodeId, seq)
// (docs/design/global-identity-and-central-db.md §2.3), so the real instance's genuine shipments
// would then arrive looking like duplicates of the sandbox's and be dropped — silently, and only
// for as long as the sandbox ran, which is the hardest kind of gap to ever notice.
//
// So a sandbox serves the API and nothing else.
const SANDBOX = process.env.WINDROW_SANDBOX === '1';

// The mTLS listener: the dashboard, the MCP server and CLI/admin scripts.
// `requestCert` asks for a certificate; `rejectUnauthorized: false` deliberately lets the request
// through to `requireAuth` anyway, so an unauthenticated caller gets a JSON 401 that explains
// itself instead of a bare TLS alert with no diagnosis. Nothing is authorised by reaching the app —
// requireAuth checks `socket.authorized` before it reads anything off the certificate.
const root = ca.loadOrCreateCa();
const serverCert = ca.loadOrCreateServerCert(root);
https
  .createServer({
    key: serverCert.key,
    cert: serverCert.cert,
    ca: root.certPem,
    requestCert: true,
    rejectUnauthorized: false,
  }, app)
  .listen(TLS_PORT, () => {
    console.log(`Windrow API (mutual TLS) listening on https://localhost:${TLS_PORT}/api`);
  });

http.createServer(app).listen(PORT, '127.0.0.1', () => {
  console.log(`Windrow hook API listening on http://127.0.0.1:${PORT}/api (loopback only, agent scope)`);
  // The debugging pause (server/enforcementPause.js). Both halves run BEFORE the sandbox return:
  // a sandbox is the likeliest place to want denials off, and a pause that survived a restart must
  // be announced on every boot regardless of which workers this instance runs. The env var is a
  // request to a *server that is coming up healthy* to sign a pause — it is never a flag the hook
  // reads for itself, which is what keeps a governed process from bypassing its own governance.
  applyEnvEnforcementPause();
  // Says so once a minute for as long as one is in force, and once more when it lapses. A pause is
  // otherwise invisible: nothing fails while it is on.
  startEnforcementPauseHeartbeat();
  if (SANDBOX) {
    console.log('WINDROW_SANDBOX=1 — cache warmer, hook watcher, native-observation drain, usage shipper, alert engine and policy client are disabled for this instance.');
    return;
  }
  // Recurring pre-warm of the hook-side capability/principal caches (server/cacheWarmer.js) —
  // keeps them fresh proactively instead of relying on each hook's own on-miss fetch to fill
  // them once and then let them go stale until the next unlucky call pays that cost again.
  // Give the policy change log a baseline before anything can read it. An install that has been
  // running for months has grants and capabilities but an empty log, so without this a node asking
  // `since=0` would be told it was current while holding nothing
  // (docs/design/global-identity-and-central-db.md §2.4). Idempotent and once-only — see
  // store.seedPolicyChangesOnce.
  // Skipped on a replica node: the seed exists so that a node serving its OWN deltas describes its
  // existing rows to whoever asks, and a replica serves no deltas. Seeding there would write a
  // second version history into a log that is already meaningless on this side of the flip.
  if (policyAuthority !== CENTRAL && store.seedPolicyChangesOnce()) {
    console.log(`[policy] seeded the policy change log from existing rows — now at version ${store.policyVersion()}.`);
  }
  startCacheWarmer(store);
  // Watches each backend's hook-config file (~/.claude/settings.json, etc.) for the
  // PreToolUse/PostToolUse entries providers.js installed — restores them and logs a tamper
  // event within a debounce window of any hand-edit or strip-out, via fs.watch rather than a
  // slow poll (server/hookWatcher.js).
  startHookWatcher(store);
  // Drains the hook's native-tool spool (server/hooks/lib.js NATIVE_JOURNAL_PATH) into
  // native_tool_events, and prunes past the retention window — server/nativeObservations.js. Runs
  // once immediately to absorb whatever accumulated while this process was down, since the spool
  // is written by hooks that keep working regardless of whether the server is up.
  startNativeObservationDrain(store);
  // Drains usage_outbox to the central sink as batched NDJSON — server/usageShipper.js,
  // docs/design/global-identity-and-central-db.md §2.3. A no-op, including the enqueue itself,
  // unless WINDROW_CENTRAL_URL is set, so a single-machine field neither ships nor queues.
  startUsageShipper(store);
  // §2.3's node half: evaluate the alert rules against this machine's own stream, so a burst is
  // caught on a PC that cannot reach central at all — while the WAN is down central holds none of
  // the events the rule counts. Started REGARDLESS of whether a central is configured, unlike the
  // shipper above: a standalone install is the limit case of the partitioned machine, and there a
  // local alert is the only alert there will ever be.
  //
  // The shipper is wired first so that `onFired` has somewhere to post to on the very first fire;
  // it is a no-op without a central, which leaves every alert recorded locally and readable from
  // GET /api/alerts on this machine. Delivery is deliberately best-effort at this seam — an alert
  // that failed to post keeps `syncedAt` null and is retried on the engine's next sweep, because
  // the primary key is the same on both ends and a redelivery costs nothing.
  startAlertShipper(store);
  const deliverAlerts = () => { shipAlertsNow().catch(() => {}); };
  startNodeAlertEngine(store, { onFired: deliverAlerts, afterSweep: deliverAlerts });
  // The other direction: pulls policy deltas down from central, holds the SSE connection that pokes
  // an immediate pull, and writes the always-full deny-list the hook enforces from
  // (server/policy/policyClient.js, §2.4). Like the shipper, a no-op unless WINDROW_CENTRAL_URL is
  // set — on a standalone install the cache warmer writes the deny-list from this node's own
  // database instead, so the hook's check behaves identically either way.
  startPolicyClient();
});
