'use strict';
// The transport half of docs/design/global-identity-and-central-db.md §2.3: a background shipper
// that drains this node's usage_outbox to the central sink as batched NDJSON over HTTPS.
//
// server/store.js owns the queue — what goes on it, in what order, how a shipment is acked. This
// file owns everything that touches a network, and the split is the point. The enqueue runs inside
// the same transaction as a governed tool call's audit row, so it must never be able to block on a
// socket; the shipper runs on a timer in a long-lived process, so it can afford a TLS handshake and
// a warm connection pool. §2.1 measures why that separation is not optional: a fresh Node process
// per tool call cannot reuse a connection, and merely building an HTTP agent lazily in each one
// cost ~20 ms (docs/design/latency-breakdown.md). A WAN hop with a fresh handshake is worse.
//
// Nothing here influences an allow/deny decision. If the shipper never ran, every tool call would
// behave exactly as it does today and every event would still be recorded locally — the queue would
// simply grow, and `trimUsageOutbox` bounds that.
//
// TWO LANES (§2.3). Everything rides a 5-second timer except the events an alert exists to catch —
// a `denied` outcome, a `destructive`-tier call, a consent correction — which flush the moment they
// commit. The lane is decided at write time by `store.outboxUrgency`; this file only supplies the
// hook that gets woken. Batching every event on a timer "is right for the 95% and wrong for exactly
// the events an alert exists to catch".
//
// DELIVERY IS AT-LEAST-ONCE. Rows are deleted on ack, never on send, so the failure mode is a
// duplicate rather than a loss — and central's idempotent ingest, keyed `(nodeId, seq)` with
// ON CONFLICT DO NOTHING, is what makes a duplicate free. See the usage_outbox table comment in
// server/store.js for why that `seq` is the shipment number and not the event's chain seq.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { envCompat } = require('./config');
const enrollClient = require('./enrollment/client');

// Where central listens. Absent means there is no central, which is the normal state of a
// single-machine install — the shipper does not start and store.js never queues anything, so the
// whole feature costs an unconfigured field one `if`.
const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const INGEST_PATH = envCompat('CENTRAL_INGEST_PATH') || '/api/ingest/usage';

// §2.3's number, and the only one in this file taken straight from the design rather than chosen
// here: "everything else rides the timer", and the timer is five seconds.
const SHIP_INTERVAL_MS = Number(envCompat('SHIP_INTERVAL_MS')) || 5_000;

// One request's ceiling. A node that was offline for a week hands us a queue of hundreds of
// thousands of rows; shipping it as one body would be a request neither end can stream sensibly and
// a single failure would cost the whole backlog a retry. A full batch is drained in a loop instead
// (see `drain`), so this bounds a request, not a cycle.
const BATCH_MAX = Number(envCompat('SHIP_BATCH_MAX')) || 500;

// How many full batches one cycle will chase before yielding to the timer. Without it, a large
// backlog would hold the cycle for as long as it takes to drain, and an urgent flush arriving
// behind it would wait on the whole thing.
const MAX_BATCHES_PER_CYCLE = Number(envCompat('SHIP_MAX_BATCHES')) || 20;

// The backstop for a node that has not reached central in a very long time. Past this the OLDEST
// shipments are dropped — see `trimUsageOutbox` for why that direction — and the drop is logged
// with a real number rather than left to look like a queue that quietly caught up.
const MAX_OUTBOX_ROWS = Number(envCompat('SHIP_MAX_OUTBOX_ROWS')) || 100_000;

const REQUEST_TIMEOUT_MS = Number(envCompat('SHIP_TIMEOUT_MS')) || 15_000;

// Retry backoff. Doubles per consecutive failure from the base interval, capped — a central that is
// down for an hour should not be hit every five seconds for that hour, and a node that comes back
// should not wait ten minutes to notice.
const BACKOFF_CAP_MS = Number(envCompat('SHIP_BACKOFF_CAP_MS')) || 5 * 60_000;

// The per-node client certificate this node presents (§2.5). NOT a bearer token, and deliberately
// not falling back to one: "a central ingest endpoint accepting one fleet-wide agent token means
// any node can forge any other node's usage events and any user's attribution" — which is the exact
// property Part 1 of that document exists to establish. A node with no credential does not ship.
const CREDENTIAL_NAME = envCompat('SHIP_CREDENTIAL_NAME') || 'node-shipper';

let timer = null;
let agent = null;
let store = null;
let target = null;
let inFlight = false;
// Set when an urgent row lands while a flush is already running: the row it describes may have
// committed after that flush read its batch, so the cycle has to run again rather than assume the
// in-flight request carried it.
let flushRequested = false;
let consecutiveFailures = 0;
let nextAttemptAt = 0;

/**
 * Resolve the credential, or explain why there is none. Returns null rather than throwing: a node
 * that cannot authenticate to central still has to serve tool calls, and the correct behaviour is
 * to keep every event locally and say so once, not to fail to boot.
 */
function resolveTransport(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    // Plaintext is allowed only to loopback, and only because a developer standing up a central
    // ingest on their own machine has nothing to hand out certificates yet. Anything else would be
    // usage attribution crossing a network in the clear, which the whole of §2.5 is about.
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
        'enroll this node before it can ship usage (POST /api/enrollment-tokens, then server/enrollment/client.js enroll())',
    };
  }
  return { module: https, agent: enrollClient.agentFor(credential), nodeId: credential.meta && credential.meta.nodeId };
}

/**
 * One NDJSON line per shipment. The payload was rendered and frozen at enqueue time (see the
 * usage_outbox table comment), so this is a concatenation and not a re-serialization — the bytes
 * central receives are the bytes that were committed alongside the event.
 */
function toNdjson(rows) {
  return rows.map((r) => r.payload).join('\n') + '\n';
}

function postBatch(body, nodeId) {
  return new Promise((resolve, reject) => {
    const url = new URL(INGEST_PATH, target.base);
    const req = target.module.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        agent: target.agent,
        headers: {
          'content-type': 'application/x-ndjson',
          'content-length': Buffer.byteLength(body),
          // Redundant with the certificate on an https target and with each envelope's own
          // `nodeId`, and sent anyway: it lets central route or rate-limit a batch without parsing
          // the body, and it lets a mismatch between the certificate and the payload be *detected*
          // there rather than assumed away.
          'x-windrow-node-id': nodeId,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* an empty or non-JSON 200 is still an ack */ }
            return resolve(parsed || {});
          }
          // 4xx is not retried into oblivion by a special case here: it still fails, still backs
          // off, and still keeps the rows. A malformed batch that central will never accept is a
          // bug to see in the log, and §2.6 requires ingest to be additive-only and tolerant
          // precisely so a version-skewed node does not produce one.
          reject(new Error(`central returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Ship one batch. Returns how many rows were acked, or null if the request failed.
 *
 * Note what happens to the rows on failure: nothing. They stay queued and gain an attempt count.
 * The only thing that deletes a row is central confirming it.
 */
async function shipOnce(nodeId) {
  const rows = store.listOutboxBatch({ limit: BATCH_MAX, node: nodeId });
  if (!rows.length) return 0;
  const seqs = rows.map((r) => r.seq);
  try {
    const result = await postBatch(toNdjson(rows), nodeId);
    store.ackOutbox(seqs, nodeId);
    if (consecutiveFailures > 0) {
      console.log(`[usage-shipper] central reachable again — shipped ${seqs.length} after ${consecutiveFailures} failed cycle(s).`);
    }
    consecutiveFailures = 0;
    nextAttemptAt = 0;
    // `duplicates` is central telling us it had already seen part of this batch, which is the
    // at-least-once contract working rather than an error — worth a line only when it happens, so a
    // field that starts logging it every cycle is visibly acking nothing.
    if (result && result.duplicates) {
      console.log(`[usage-shipper] central deduped ${result.duplicates} of ${seqs.length} shipment(s) — a previous ack was lost.`);
    }
    return seqs.length;
  } catch (err) {
    store.markOutboxAttempt(seqs, err.message, nodeId);
    consecutiveFailures += 1;
    const wait = Math.min(SHIP_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 10), BACKOFF_CAP_MS);
    nextAttemptAt = Date.now() + wait;
    // Escalates from log to error rather than shouting from the first miss: one failed cycle is a
    // dropped packet, and a queue that has been stuck for minutes is an operator's problem.
    const say = consecutiveFailures >= 5 ? console.error : console.warn;
    say(
      `[usage-shipper] batch of ${seqs.length} failed (attempt ${consecutiveFailures}): ${err.message}.`,
      `Retrying in ${Math.round(wait / 1000)}s; ${store.usageOutboxStats(nodeId).pending} shipment(s) queued.`
    );
    return null;
  }
}

/**
 * One cycle: chase full batches until the queue is short, this cycle's ceiling is hit, or a request
 * fails. Reentrancy is guarded rather than queued — two concurrent drains would read overlapping
 * batches and ship every row twice, which the ingest key would absorb but which would also double
 * the bytes for no gain.
 */
async function drain() {
  if (inFlight || !store || !target) return;
  if (nextAttemptAt && Date.now() < nextAttemptAt) return; // backing off
  inFlight = true;
  try {
    const nodeId = store.nodeId();
    for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i += 1) {
      const shipped = await shipOnce(nodeId);
      if (shipped === null) break; // failed — backoff is set, try again next cycle
      if (shipped < BATCH_MAX) break; // queue drained
    }
    const dropped = store.trimUsageOutbox(MAX_OUTBOX_ROWS, nodeId);
    if (dropped) {
      console.error(
        `[usage-shipper] outbox exceeded ${MAX_OUTBOX_ROWS} shipments — dropped the ${dropped} oldest.`,
        'Those events remain in usage_events locally but central will never receive them, and its',
        'copy of this node\'s stream now has a gap.'
      );
    }
  } catch (err) {
    // A throw from anywhere above must not kill the timer, or one bad cycle silently ends shipping
    // for the lifetime of the process.
    console.error('[usage-shipper] cycle failed:', err.message);
  } finally {
    inFlight = false;
  }
  if (flushRequested) {
    flushRequested = false;
    setImmediate(drain);
  }
}

/**
 * The immediate lane. Called by store.js the moment an urgent row commits — never from inside its
 * transaction — so a denial, a destructive call or a consent correction reaches central in about a
 * round trip instead of up to five seconds later.
 *
 * Deliberately ignores the backoff: an urgent flush is exactly the moment worth spending one
 * request to find out whether central came back.
 */
function flushNow() {
  if (!store || !target) return;
  if (inFlight) {
    flushRequested = true;
    return;
  }
  nextAttemptAt = 0;
  setImmediate(drain);
}

/**
 * Start shipping. A no-op — including the enqueue in store.js — when no central is configured, so
 * a single-machine field pays nothing for this and grows no queue it will never drain.
 */
function startUsageShipper(storeModule) {
  if (timer) return timer;
  if (!CENTRAL_URL) return null;

  const resolved = resolveTransport(CENTRAL_URL);
  if (resolved.error) {
    // Refusing to ship is the correct outcome, and saying so once at boot is the whole of the
    // remedy: events keep being recorded locally, nothing is queued, and nothing is lost.
    console.error(`[usage-shipper] not shipping to ${CENTRAL_URL} — ${resolved.error}`);
    return null;
  }
  store = storeModule;
  target = { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };
  agent = resolved.agent;

  // The certificate names a node and so does the database, and if they disagree this node is about
  // to ship one node's stream under another's identity — which is precisely the forgery §2.5 says
  // per-node credentials exist to prevent, arriving by accident (a credential directory copied
  // between machines) rather than by attack. Shipping anyway would corrupt both nodes' sequences at
  // central, so it is a warning loud enough to act on rather than a silent mismatch. Central rejects
  // it too, on the certificate — this is what makes the reason legible from the node's own log.
  if (resolved.nodeId && resolved.nodeId !== store.nodeId()) {
    console.error(
      `[usage-shipper] credential "${CREDENTIAL_NAME}" was issued to node ${resolved.nodeId} but this database is`,
      `node ${store.nodeId()} — refusing to ship. The credential directory has been copied between machines;`,
      'enroll this node for its own certificate.'
    );
    store = null;
    target = null;
    agent = null;
    resolved.agent.destroy();
    return null;
  }

  // Turning the queue on and starting the drain are one act: an outbox nobody drains is just a
  // table that grows.
  store.enableUsageOutbox(flushNow);

  console.log(
    `[usage-shipper] shipping usage to ${new URL(INGEST_PATH, CENTRAL_URL).href} every ${SHIP_INTERVAL_MS / 1000}s`,
    `as node ${store.nodeId()}; denied/destructive/consent events flush immediately.`
  );

  // Immediately, before the first interval: whatever queued while this process was down is the
  // backlog most worth clearing, and on a node that has been offline it is the only thing in the
  // queue. Same reasoning as the native-observation drain's catch-up tick.
  setImmediate(drain);
  timer = setInterval(drain, SHIP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref(); // background upkeep must not hold the process open
  return timer;
}

function stopUsageShipper() {
  if (timer) clearInterval(timer);
  timer = null;
  if (agent && typeof agent.destroy === 'function') agent.destroy();
  agent = null;
  if (store) store.disableUsageOutbox();
  store = null;
  target = null;
  inFlight = false;
  flushRequested = false;
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

module.exports = {
  startUsageShipper,
  // Shared with server/alerts/nodeShipper.js so the alert channel presents the SAME per-node
  // certificate under the SAME plaintext-only-to-loopback rule. Two shippers with two opinions
  // about which credential to use is how one of them ends up shipping under no identity at all.
  resolveTransport,
  CREDENTIAL_NAME,
  REQUEST_TIMEOUT_MS,
  stopUsageShipper,
  flushNow,
  toNdjson,
  CENTRAL_URL,
  INGEST_PATH,
  SHIP_INTERVAL_MS,
  BATCH_MAX,
  MAX_OUTBOX_ROWS,
};
