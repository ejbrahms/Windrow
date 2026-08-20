'use strict';
// The policy distribution channel, node side — docs/design/global-identity-and-central-db.md §2.4.
//
// The mirror image of server/usageShipper.js: usage goes up on a timer with an urgent lane, policy
// comes down on a timer with a push lane. Same process, same warm connection pool, same reason it
// cannot live in a hook — a hook is a fresh Node process per tool call and could not hold an SSE
// connection or amortise a TLS handshake if it wanted to.
//
// THREE CHANNELS, IN ORDER OF HOW MUCH THEY CAN BE TRUSTED TO WORK
//   1. SSE (/api/policy/events)   pokes a pull within a round trip of a change. Cheapest and
//                                 first to break — a proxy closes it, a laptop sleeps.
//   2. Poll (/api/policy?since=)  runs regardless, on POLICY_POLL_INTERVAL_MS. Bounds the
//                                 revocation window at the interval even with SSE dead.
//   3. Deny-list                  rides every response, always in full, and is written to disk
//                                 SEPARATELY from the replica. A delta this node refuses to apply
//                                 — schema skew, a gap, a rewind — still yields a deny-list, and
//                                 that is the entire point of it being a separate file rather than
//                                 a field on the replica.
//
// And when all three fail: server/hooks/lib.js reads the deny-list's `fetchedAt` and fails closed
// for mutating/destructive past MAX_POLICY_AGE. That bound is enforced there, on the decision path,
// not here — a client that has stopped running cannot enforce anything, which is exactly the
// failure the bound exists for. This file's only obligation to it is the one stated in
// replica.saveDenyList: never stamp `fetchedAt` on anything but a successful fetch.
//
// PHASE 4 CHANGED WHAT THIS FILE IS ALLOWED TO DO. It used to write nothing into the node's own
// database — the channel filled a JSON replica the hot path never read. Now, and only when
// ./authority.js says central owns policy, an applied delta is ALSO written into the node's
// capabilities/principals/grants tables (materialiseReplica below). That is what makes the decision
// in server/app.js a read of central's policy rather than of this machine's own opinion.
//
// The two things that did not change are the ones the safety argument rests on: the deny-list is
// still written separately and still lands from a delta this node refuses to apply, and the hot
// path still never opens a socket to central. What moved is where the rows came from.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { envCompat } = require('../config');
const enrollClient = require('../enrollment/client');
const replica = require('./replica');
const { isCentralAuthority } = require('./authority');

// Absent means there is no central — the normal state of a single-machine install. The client does
// not start, and server/cacheWarmer.js keeps writing the local deny-list from the node's own
// database instead, so the hook's deny-list check behaves identically on a standalone box.
const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const POLICY_PATH = envCompat('CENTRAL_POLICY_PATH') || '/api/policy';
const EVENTS_PATH = envCompat('CENTRAL_POLICY_EVENTS_PATH') || '/api/policy/events';

// §2.4 prices the poll channel at "30s, matching the existing capability cache", and that is where
// this default comes from rather than from a fresh guess. It is the revocation window when SSE is
// down, so it trades directly against N nodes × 2 requests/min at central.
const POLL_INTERVAL_MS = Number(envCompat('POLICY_POLL_INTERVAL_MS')) || 30_000;

const REQUEST_TIMEOUT_MS = Number(envCompat('POLICY_TIMEOUT_MS')) || 15_000;

// Backoff for a central that is down. Same shape and the same reasoning as usageShipper's: an hour
// of downtime should not be an hour of requests every 30s, and a node that comes back should not
// wait ten minutes to find out.
const BACKOFF_CAP_MS = Number(envCompat('POLICY_BACKOFF_CAP_MS')) || 5 * 60_000;

// How long to wait before re-opening a dropped SSE connection. Short, because while it is down the
// only channel left is the poll, and the poll is 60× slower.
const SSE_RECONNECT_MS = Number(envCompat('POLICY_SSE_RECONNECT_MS')) || 5_000;

// The per-node client certificate (§2.5). Same credential the shipper uses by default: one
// enrollment, one identity, both directions. A node with no credential does not pull, for the same
// reason it does not ship — an unauthenticated policy fetch is a policy fetch anyone can serve.
const CREDENTIAL_NAME = envCompat('POLICY_CREDENTIAL_NAME') || envCompat('SHIP_CREDENTIAL_NAME') || 'node-shipper';

let pollTimer = null;
let sseRequest = null;
let sseRetryTimer = null;
let target = null;
let inFlight = false;
let stopped = true;
let consecutiveFailures = 0;
let nextAttemptAt = 0;
let lastGoodAt = null;
let lastError = null;
// The §2.6 refusal, held separately from `lastError` and deliberately NOT cleared by a successful
// transport cycle. A node refusing a delta for schema skew keeps polling and keeps landing the
// deny-list, so every one of those cycles "succeeded" — clearing this on one would erase the only
// evidence that this node is frozen on its last-good replica. It is cleared by an *applied* delta,
// which is the one event that means the skew is over.
let schemaSkew = null;

/** Same policy as usageShipper.resolveTransport, and deliberately identical: plaintext only to
 *  loopback (a developer standing up a central with no CA yet), a per-node certificate otherwise. */
function resolveTransport(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    if (!local) {
      return { error: `WINDROW_CENTRAL_URL is plaintext http to ${parsed.hostname} — only https, or http to loopback, is accepted` };
    }
    return { module: http, agent: new http.Agent({ keepAlive: true }) };
  }
  if (parsed.protocol !== 'https:') {
    return { error: `WINDROW_CENTRAL_URL must be http or https, got ${parsed.protocol}` };
  }
  const credential = enrollClient.load(CREDENTIAL_NAME);
  if (!credential) {
    return {
      error:
        `no per-node credential "${CREDENTIAL_NAME}" in ${enrollClient.DEFAULT_DIR} — ` +
        'enroll this node before it can pull policy (POST /api/enrollment-tokens, then server/enrollment/client.js enroll())',
    };
  }
  return { module: https, agent: enrollClient.agentFor(credential) };
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, target.base);
    const req = target.module.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        agent: target.agent,
        headers: { accept: 'application/json' },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`central returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`central returned unparseable JSON: ${err.message}`));
          }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * A request to central that is NOT the policy pull — the write half of phase 4.
 *
 * ./centralPolicyStore.js is the only caller. It lives here rather than in its own transport module
 * so that a node has exactly one place that knows how to reach central: one credential, one
 * plaintext-loopback carve-out, one timeout. Two transports would be two places for the mTLS rules
 * to drift apart, and the direction they would drift is the one where a write goes out
 * unauthenticated.
 *
 * `target` is reused when the client is running (a warm connection pool — §2.3's reason the shipper
 * lives in the long-lived service) and resolved on demand when it is not, so an admin route works
 * on a node whose poller has not started yet.
 *
 * ERRORS CARRY THE STATUS. `err.status` is what ./centralPolicyStore.js maps back onto the seam's
 * conflict taxonomy, so a 409 from central reaches server/app.js as the same GrantConflictError a
 * standalone install would have thrown locally.
 */
function centralRequest(method, pathname, body) {
  const active = target || (() => {
    if (!CENTRAL_URL) throw new Error('no central is configured (WINDROW_CENTRAL_URL), so there is nowhere to send this write');
    const resolved = resolveTransport(CENTRAL_URL);
    if (resolved.error) throw new Error(resolved.error);
    return { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };
  })();

  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, active.base);
    const req = active.module.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        agent: active.agent,
        headers: {
          accept: 'application/json',
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error((parsed && parsed.error) || `central returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
            err.status = res.statusCode;
            return reject(err);
          }
          if (parsed === null && text) return reject(new Error('central returned unparseable JSON'));
          resolve(parsed);
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Pull now and wait for it — what a write calls once central has accepted it, so the row is in this
 * node's mirror before the route that made it answers.
 *
 * Without this, `POST /api/grants` would return 201 and the very next `GET /api/grants` on the same
 * machine would not show the row, because the poller had not come round yet. That is a real
 * regression from the standalone behaviour and it is the kind that reads as data loss.
 *
 * The wait for an in-flight cycle is a poll rather than a promise the cycle resolves, because
 * pullOnce is also driven by a timer and an SSE poke and does not otherwise need to be awaitable.
 * The ceiling matters more than the granularity: past it, this returns anyway and the route answers
 * with central's own row, which is the authoritative answer regardless of what the mirror holds.
 */
async function pullNow({ timeoutMs = 5_000 } = {}) {
  nextAttemptAt = 0; // a write is worth spending a request on even mid-backoff
  const deadline = Date.now() + timeoutMs;
  while (inFlight && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
  await pullOnce();
}

/**
 * The deny-list, taken from whatever response we just got and written unconditionally.
 *
 * Called BEFORE the replica is updated and regardless of whether the delta was applied, because the
 * two guarantees are independent: "this node knows current policy" can fail while "this node denies
 * what central revoked" must not. Ordering it first also means a crash between the two writes
 * leaves the safe side written.
 */
function persistDenyList(delta) {
  if (!delta || !delta.denyList) return;
  replica.saveDenyList({
    denyList: delta.denyList,
    version: delta.version,
    fetchedAt: Date.now(),
    central: true,
    authority: isCentralAuthority() ? 'central' : 'node',
  });
  lastGoodAt = Date.now();
}

/**
 * Write an applied delta into the node's own tables — phase 4 of §2.7, and the line the phase-2/3
 * version of this file explicitly would not cross ("nothing here writes to the node's own
 * database").
 *
 * GATED ON AUTHORITY, not on a central being configured. A phase-3 node ships usage to a central it
 * does not obey and keeps its own tables authoritative; writing central's rows into them there
 * would change every decision on the box, which is exactly what ./replica.js's header refused to do
 * before anyone had decided it should. `isCentralAuthority()` is that decision, made once in
 * ./authority.js and read here.
 *
 * BEST-EFFORT ONLY IN ONE DIRECTION. A failure to materialise is logged and swallowed rather than
 * failing the pull, because the pull also landed the deny-list — and a node that keeps revoking
 * correctly while its mirror is stuck is strictly better than one that stops doing both. The
 * mirror's staleness is not silent either: the deny-list's `fetchedAt` keeps moving, but
 * `store.policyReplicaState().version` does not, and GET /api/policy/status reports both.
 */
function materialiseReplica(delta, applied) {
  if (!isCentralAuthority()) return;
  // Required lazily. This module is loaded by server/index.js on a node and by nothing on central,
  // but requiring the store at the top would open the SQLite database as a side effect of reading
  // this file — which the distribution tests do without wanting a database.
  // eslint-disable-next-line global-require
  const store = require('../store');

  const snapshot = { reset: Boolean(delta.reset), version: applied.version, capabilities: [], principals: [], grants: [] };
  if (delta.reset) {
    snapshot.capabilities = delta.snapshot?.capabilities || [];
    snapshot.principals = delta.snapshot?.principals || [];
    snapshot.grants = delta.snapshot?.grants || [];
  } else {
    for (const change of delta.changes || []) {
      if (!change.row) continue;
      if (change.entity === 'capability') snapshot.capabilities.push(change.row);
      else if (change.entity === 'principal') snapshot.principals.push(change.row);
      else if (change.entity === 'grant') snapshot.grants.push(change.row);
      // An unrecognised entity is skipped here exactly as ./replica.js skips it: it advanced the
      // version and carried no row this build knows how to store.
    }
  }
  try {
    store.applyPolicyReplica(snapshot);
  } catch (err) {
    console.error('[policy-client] could not write the replica into the local tables:', err.message);
  }
}

/**
 * One pull cycle. Loops while central reports `complete: false`, so a node draining a month of
 * backlog catches up in one cycle rather than one batch per poll interval.
 */
async function pullOnce() {
  if (inFlight || stopped || !target) return;
  if (nextAttemptAt && Date.now() < nextAttemptAt) return;
  inFlight = true;
  try {
    let current = replica.loadReplica();
    for (let i = 0; i < 100; i += 1) {
      const delta = await getJson(`${POLICY_PATH}?since=${current.version}`);
      // Unconditional and first — see persistDenyList.
      persistDenyList(delta);

      const result = replica.applyDelta(current, delta);
      if (!result.ok) {
        // A refusal is not a transport failure: central answered, the deny-list landed, and this
        // node is running on its last-good replica exactly as §2.6 prescribes. Loud, because the
        // remedy is an upgrade or an operator, and silent skew is how a fleet drifts.
        console.error(`[policy-client] refusing to apply delta — ${result.reason}`);
        lastError = result.reason;
        if (result.skew) {
          schemaSkew = {
            since: schemaSkew ? schemaSkew.since : new Date().toISOString(),
            centralSchemaVersion: delta.schemaVersion ?? null,
            understood: [...replica.SUPPORTED_SCHEMA_VERSIONS],
            frozenAtVersion: current.version,
            reason: result.reason,
          };
        }
        break;
      }
      // The phase-4 half: put the rows where the hot path can see them, BEFORE the JSON replica
      // records that this version was applied. The order is the crash-safety argument. The JSON
      // file is what the next pull's `since` is read from, so saving it first would mean a crash in
      // between leaves the node asking for changes *after* rows it never wrote into the mirror —
      // and since a delta is only ever sent once, those rows would be missing until the next reset.
      // This way a crash costs a re-send, and every mirror write is an idempotent upsert.
      materialiseReplica(delta, result.replica);
      replica.saveReplica(result.replica);
      current = result.replica;
      lastError = null;
      schemaSkew = null;
      if (result.reset) {
        console.log(`[policy-client] central reset this node to a full snapshot at version ${current.version}.`);
      }
      if (delta.complete) break;
    }
    if (consecutiveFailures > 0) {
      console.log(`[policy-client] central reachable again at version ${current.version} after ${consecutiveFailures} failed cycle(s).`);
    }
    consecutiveFailures = 0;
    nextAttemptAt = 0;
  } catch (err) {
    consecutiveFailures += 1;
    lastError = err.message;
    const wait = Math.min(POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 8), BACKOFF_CAP_MS);
    nextAttemptAt = Date.now() + wait;
    // Note what is NOT done here: the deny-list's `fetchedAt` is not touched. The policy this node
    // is enforcing is now measurably older, and past MAX_POLICY_AGE the hook stops trusting it —
    // which is the designed outcome, not a gap to paper over.
    const say = consecutiveFailures >= 5 ? console.error : console.warn;
    const age = lastGoodAt ? `${Math.round((Date.now() - lastGoodAt) / 1000)}s` : 'never';
    say(
      `[policy-client] pull failed (attempt ${consecutiveFailures}): ${err.message}.`,
      `Retrying in ${Math.round(wait / 1000)}s; policy last refreshed ${age} ago.`
    );
  } finally {
    inFlight = false;
  }
}

/**
 * The push channel: hold /api/policy/events open and pull the moment central says the version moved.
 *
 * Parsed by hand rather than with an SSE library because the grammar this consumes is three lines
 * — `event:`, `data:`, and a `:` comment — and a dependency for that would be a dependency on the
 * one path that has to work when everything else in the network is being difficult.
 *
 * The event carries only a version, and this deliberately does not compare it to anything: pulling
 * is idempotent and cheap (a no-op poll is one request that returns zero changes), while a
 * comparison against a replica this function does not own is a second source of truth to get wrong.
 */
function openEventStream() {
  if (stopped || !target) return;
  const url = new URL(EVENTS_PATH, target.base);
  const req = target.module.request(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      agent: target.agent,
      headers: { accept: 'text/event-stream' },
    },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return scheduleReconnect(`central returned HTTP ${res.statusCode} on the event stream`);
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        // Events are separated by a blank line. Anything after the last separator is a partial
        // event and stays in the buffer — SSE frames are split across TCP reads routinely, and
        // treating a partial frame as a whole one is the classic way this parser goes wrong.
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith(':') || !frame.includes('data:')) continue; // heartbeat or retry hint
          // Poke, don't parse for content: the pull is what reads policy.
          nextAttemptAt = 0; // a poke is worth spending one request on even mid-backoff
          setImmediate(pullOnce);
        }
      });
      res.on('end', () => scheduleReconnect('central closed the event stream'));
      res.on('error', (err) => scheduleReconnect(err.message));
    }
  );
  // No socket timeout on this request, unlike every other one in this file: an idle SSE connection
  // is the normal state of a quiet policy day, and a timeout would tear down a healthy channel
  // every few minutes. Liveness comes from central's heartbeat comment instead.
  req.on('error', (err) => scheduleReconnect(err.message));
  req.end();
  sseRequest = req;
}

function scheduleReconnect(reason) {
  if (stopped) return;
  if (sseRequest) {
    sseRequest.destroy();
    sseRequest = null;
  }
  if (sseRetryTimer) return; // already queued — a stream that errors and then ends must not double
  // Debug-level on purpose: a dropped SSE connection is expected on a laptop that sleeps or behind
  // a proxy with an idle timeout, and it costs nothing — the poll channel covers it. What is worth
  // shouting about is the pull failing, which pullOnce already does.
  if (process.env.WINDROW_DEBUG) console.log(`[policy-client] event stream reconnecting: ${reason}`);
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    openEventStream();
  }, SSE_RECONNECT_MS);
  if (typeof sseRetryTimer.unref === 'function') sseRetryTimer.unref();
}

/**
 * Start pulling policy. A no-op when no central is configured — a standalone install has nothing to
 * pull from and its own database is already the authority.
 */
function startPolicyClient() {
  if (pollTimer) return pollTimer;
  if (!CENTRAL_URL) return null;

  const resolved = resolveTransport(CENTRAL_URL);
  if (resolved.error) {
    // Refusing to pull, and saying so once at boot, is the whole remedy. Note the consequence and
    // that it is the correct one: with no successful fetch, the deny-list file is never stamped, so
    // the hook sees policy of unbounded age and fails closed for mutating/destructive. A node that
    // cannot authenticate to central does not get to keep enforcing from an unverifiable copy.
    console.error(`[policy-client] not pulling policy from ${CENTRAL_URL} — ${resolved.error}`);
    markNeverConfirmed();
    return null;
  }
  stopped = false;
  target = { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };

  console.log(
    `[policy-client] pulling policy from ${new URL(POLICY_PATH, CENTRAL_URL).href} every ${POLL_INTERVAL_MS / 1000}s,`,
    `with push on ${EVENTS_PATH}; the deny-list rides every response.`
  );

  markNeverConfirmed();

  // Immediately, before the first interval and before the stream: whatever changed while this
  // process was down is the most valuable thing to learn, and on a node that has been off it is the
  // only thing there is to learn.
  setImmediate(pullOnce);
  openEventStream();
  pollTimer = setInterval(pullOnce, POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
  return pollTimer;
}

function stopPolicyClient() {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (sseRetryTimer) clearTimeout(sseRetryTimer);
  sseRetryTimer = null;
  if (sseRequest) sseRequest.destroy();
  sseRequest = null;
  if (target && target.agent && typeof target.agent.destroy === 'function') target.agent.destroy();
  target = null;
  inFlight = false;
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

/**
 * Lay down a deny-list marked `central: true` with no `fetchedAt`, unless one already exists.
 *
 * This is what disambiguates a missing file for server/hooks/lib.js, which cannot read this
 * process's environment and so cannot otherwise tell "no central is configured" from "a central is
 * configured and this node has never reached it". The marker says the second, and the hook fails
 * mutating/destructive closed on it — which is the correct answer for a node whose policy has never
 * been confirmed by the authority that owns it.
 *
 * Never overwrites a real one: it is written at startup, and a node restarting must not have its
 * age clock reset to "never" and lock itself out of tools it was correctly enforcing a second ago.
 * A genuinely stale file stays stale and ages out on its own timestamp.
 */
function markNeverConfirmed() {
  const existing = replica.loadDenyList();
  if (existing && existing.central) return;
  replica.saveDenyList({
    // Empty, and that is not a gap: an empty deny-list denies nothing, and everything it would have
    // denied is covered by the staleness bound this marker triggers, which is strictly stronger.
    denyList: { grantIds: [], pairs: [], principals: [] },
    version: 0,
    fetchedAt: null,
    central: true,
    authority: isCentralAuthority() ? 'central' : 'node',
  });
}

/** The mirror's own version, or nothing at all on a node-authoritative install where there is no
 *  mirror — reporting `mirrorVersion: 0` there would read as "a replica that has never synced"
 *  rather than "no replica, by design". Required lazily for the reason materialiseReplica gives. */
function mirrorStatus() {
  if (!isCentralAuthority()) return {};
  try {
    // eslint-disable-next-line global-require
    const { version, stampedAt } = require('../store').policyReplicaState();
    return { mirrorVersion: version, mirrorStampedAt: stampedAt };
  } catch (err) {
    return { mirrorError: err.message };
  }
}

/** What /api/policy/status reports — enough to tell "current", "behind" and "not running" apart. */
function policyClientStatus() {
  const current = replica.loadReplica();
  const deny = replica.loadDenyList();
  return {
    central: CENTRAL_URL,
    running: Boolean(pollTimer),
    streamConnected: Boolean(sseRequest && !sseRequest.destroyed),
    version: current.version,
    replicaFetchedAt: current.fetchedAt,
    denyListFetchedAt: deny ? deny.fetchedAt : null,
    denyListAgeMs: deny && deny.fetchedAt ? Date.now() - deny.fetchedAt : null,
    revokedGrants: deny ? deny.grantIds.length : 0,
    // Phase 4: the MIRROR the hot path actually reads, as against the JSON replica above. The two
    // move together on a healthy node and come apart in exactly one case worth seeing — a delta
    // that applied to the JSON but could not be written into SQLite — so reporting only one of them
    // would make that case invisible, which is the shape of failure §2.6 keeps warning about.
    authority: isCentralAuthority() ? 'central' : 'node',
    ...mirrorStatus(),
    consecutiveFailures,
    lastError,
    // §2.6: "central can tell a fleet at mixed versions from a fleet that is merely quiet". Without
    // this field the two look identical from central — a skewed node polls on schedule, refreshes
    // its deny-list on schedule and reports no transport failure, while its replica silently stops
    // moving. `frozenAtVersion` beside a moving central version is what names it.
    schemaSkew,
  };
}

module.exports = {
  startPolicyClient,
  stopPolicyClient,
  policyClientStatus,
  pullOnce,
  // Phase 4. `centralRequest` is the node's one outbound path for a policy WRITE and `pullNow` is
  // how the mirror is made current before the route that caused it answers — see each above.
  centralRequest,
  pullNow,
  resolveTransport,
  CENTRAL_URL,
  POLICY_PATH,
  EVENTS_PATH,
  POLL_INTERVAL_MS,
};
