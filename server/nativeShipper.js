'use strict';
// Ships this node's native tool observations to central — docs/design/dashboard-placement.md
// item 1, and the largest of the four pieces of work that note asks for.
//
// WHAT IT FIXES. `native_tool_events` is the biggest table on a node — more rows than the audit
// log — and until now it never left. So native tool observability was a per-machine, per-lifetime
// feature: rebuild the node and every observation it ever made is gone, and no second machine
// could ever see what the first one did. That is the opposite of what it was built for, and it is
// the strongest argument for this change independently of where the dashboard lives.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* SHARED WITH server/usageShipper.js
// ---------------------------------------------------------------------------------------------
//
// The transport is shared — `resolveTransport`, so this presents the SAME per-node certificate
// under the SAME plaintext-only-to-loopback rule, for the reason the alert shipper gives: two
// shippers with two opinions about which credential to use is how one ends up shipping under no
// identity at all. Everything above the socket is different, and each difference is a property of
// what an observation IS:
//
//   NO OUTBOX. `usage_outbox` exists so an event that committed locally cannot fail to be queued,
//   and so a correction landing between enqueue and ship cannot overwrite the original shipment.
//   An observation is never corrected — there is no patch path, by design — so the table is its
//   own queue and `shippedAt` is the cursor. One append is the observation *and* its place in
//   line, which is fewer moving parts, not weaker ones.
//
//   NO URGENT LANE. §2.3's immediate flush exists for the events an alert is watching for: a
//   denial, a destructive call, a consent correction. Nothing here is any of those, because
//   nothing here was enforced. A native observation is never the thing that has to reach an
//   operator inside a round trip, so it rides the timer, always, and a slower timer than usage.
//
//   NO ACK-DELETES. A usage shipment is deleted on ack because central then holds the only copy
//   that matters. An observation is *marked* shipped and kept until retention ages it out, so the
//   local dashboard's cards keep working on a node that is up — which is the whole reason those
//   rows exist locally in the first place.
//
//   A LOST BATCH IS NOT A HOLE IN AN AUDIT LOG. It is the same loss the spool already accepts when
//   it hits its cap. So this backs off and retries like the others, but it does not escalate to
//   the language the usage shipper uses about gaps in a stream, because there is no completeness
//   claim here to break.
//
// AT-LEAST-ONCE, AND THE RETRY IS FREE. `id` is a SHA-256 of the spool line the observation came
// from (./nativeObservations.js), so a redelivery is the same id and central's ingest resolves it
// against that id before inserting. Marking happens after the ack, never before, so a lost ack
// costs a duplicate rather than a loss — and a duplicate costs nothing.

const { URL } = require('url');
const { envCompat } = require('./config');
const { resolveTransport, REQUEST_TIMEOUT_MS } = require('./usageShipper');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const INGEST_PATH = envCompat('CENTRAL_NATIVE_INGEST_PATH') || '/api/ingest/native';

// Slower than usage's five seconds, on purpose. Nothing here is urgent and there is one to two
// orders of magnitude more of it, so the trade is the opposite of the audit stream's: batch harder,
// arrive later. Thirty seconds keeps a live fleet view honest while making a busy node's traffic a
// couple of requests a minute rather than a couple of hundred.
const SHIP_INTERVAL_MS = Number(envCompat('NATIVE_SHIP_INTERVAL_MS')) || 30_000;

// One request's ceiling. Larger than usage's 500 because the rows are smaller and the volume is
// higher — a node draining a fortnight's backlog has hundreds of thousands of them, and 500-row
// batches would take a thousand round trips to clear.
const BATCH_MAX = Number(envCompat('NATIVE_SHIP_BATCH_MAX')) || 2_000;

// How many full batches one cycle chases before yielding to the timer. Without it a large backlog
// holds the cycle for as long as it takes to drain.
const MAX_BATCHES_PER_CYCLE = Number(envCompat('NATIVE_SHIP_MAX_BATCHES')) || 10;

// The backstop for a node that has not reached central in a very long time. Past this the OLDEST
// unshipped rows are dropped — and the drop is logged with a real number, because a silent
// truncation would read as "this node was quiet" when it was in fact unreachable.
const MAX_UNSHIPPED = Number(envCompat('NATIVE_MAX_UNSHIPPED')) || 500_000;

const BACKOFF_CAP_MS = Number(envCompat('NATIVE_SHIP_BACKOFF_CAP_MS')) || 5 * 60_000;

let timer = null;
let store = null;
let target = null;
let inFlight = false;
let consecutiveFailures = 0;
let nextAttemptAt = 0;

/**
 * The wire shape. A projection rather than the row, so local bookkeeping stays local: `shippedAt`
 * is this node's record of its own delivery attempt and means nothing at central, where the
 * arrival time is a column central assigns for itself.
 */
function toEnvelope(row) {
  return {
    id: row.id,
    principalId: row.principalId,
    toolName: row.toolName,
    detail: row.detail,
    ts: row.ts,
    outcome: row.outcome,
    reason: row.reason,
    sessionId: row.sessionId,
    actorLoomId: row.actorLoomId,
    actorHumanName: row.actorHumanName,
    actorAgentType: row.actorAgentType,
    actorBackend: row.actorBackend,
    actorField: row.actorField,
    osUser: row.osUser,
    hostname: row.hostname,
  };
}

/** NDJSON, like usage, and for the same reason: a node draining a fortnight sends hundreds of
 *  thousands of rows, and one JSON array would be a body neither end can stream sensibly. */
function toNdjson(rows, nodeId, incarnation) {
  return rows
    .map((r) => JSON.stringify({ ...toEnvelope(r), nodeId, incarnation }))
    .join('\n') + '\n';
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
 * Marked AFTER the ack, never before — so the failure mode is a duplicate, which central's
 * content-derived id makes free, rather than an observation that this node believes it delivered
 * and central never received.
 */
async function shipOnce(nodeId, incarnation) {
  const rows = store.listUnshippedNativeToolEvents(BATCH_MAX);
  if (!rows.length) return 0;
  try {
    const result = await postBatch(toNdjson(rows, nodeId, incarnation), nodeId);
    store.markNativeToolEventsShipped(rows.map((r) => r.id));
    if (consecutiveFailures > 0) {
      console.log(`[native-shipper] central reachable again — shipped ${rows.length} after ${consecutiveFailures} failed cycle(s).`);
    }
    consecutiveFailures = 0;
    nextAttemptAt = 0;
    if (result && result.duplicates) {
      // The at-least-once contract working, not an error — and the one observable proof that both
      // ends agree about what an observation's identity is.
      console.log(`[native-shipper] central deduped ${result.duplicates} of ${rows.length} observation(s) — a previous ack was lost.`);
    }
    if (result && result.rejected) {
      console.warn(`[native-shipper] central rejected ${result.rejected} of ${rows.length}:`,
        JSON.stringify((result.rejections || []).slice(0, 3)));
    }
    return rows.length;
  } catch (err) {
    consecutiveFailures += 1;
    const wait = Math.min(SHIP_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 10), BACKOFF_CAP_MS);
    nextAttemptAt = Date.now() + wait;
    const say = consecutiveFailures >= 5 ? console.error : console.warn;
    say(
      `[native-shipper] batch of ${rows.length} failed (attempt ${consecutiveFailures}): ${err.message}.`,
      `Retrying in ${Math.round(wait / 1000)}s; ${store.nativeShipStats().pending} observation(s) queued.`
    );
    return null;
  }
}

/** One cycle: chase full batches until the queue is short, this cycle's ceiling is hit, or a
 *  request fails. Reentrancy is guarded rather than queued, for the usage shipper's reason. */
async function drain() {
  if (inFlight || !store || !target) return;
  if (nextAttemptAt && Date.now() < nextAttemptAt) return; // backing off
  inFlight = true;
  try {
    const nodeId = store.nodeId();
    const incarnation = typeof store.incarnation === 'function' ? store.incarnation() : null;
    for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i += 1) {
      const shipped = await shipOnce(nodeId, incarnation);
      if (shipped === null) break; // failed — backoff is set, try again next cycle
      if (shipped < BATCH_MAX) break; // queue drained
    }
    const dropped = store.trimUnshippedNativeToolEvents(MAX_UNSHIPPED);
    if (dropped) {
      console.error(
        `[native-shipper] unshipped backlog exceeded ${MAX_UNSHIPPED} — dropped the ${dropped} oldest.`,
        'Those observations reached central never. Unlike a trimmed usage outbox this leaves no gap',
        'in any chain, because observations were never a complete record — but the fleet view of',
        'this node is missing that window and nothing will fill it in.'
      );
    }
  } catch (err) {
    // A throw from anywhere above must not kill the timer, or one bad cycle ends shipping for the
    // lifetime of the process.
    console.error('[native-shipper] cycle failed:', err.message);
  } finally {
    inFlight = false;
  }
}

/**
 * Start shipping. A no-op when no central is configured — on a standalone install the observations
 * stay local and the dashboard on that machine reads them directly, which is exactly what it did
 * before this file existed.
 */
function startNativeShipper(storeModule) {
  if (timer) return timer;
  if (!CENTRAL_URL) return null;

  const resolved = resolveTransport(CENTRAL_URL);
  if (resolved.error) {
    console.error(`[native-shipper] not shipping observations to ${CENTRAL_URL} — ${resolved.error}`);
    return null;
  }
  // The same identity check the other two shippers make: a credential directory copied between
  // machines would file one machine's activity under another's name.
  if (resolved.nodeId && resolved.nodeId !== storeModule.nodeId()) {
    console.error(
      `[native-shipper] credential was issued to node ${resolved.nodeId} but this node is`,
      `${storeModule.nodeId()} — refusing to ship. Enroll this node for its own certificate.`
    );
    resolved.agent.destroy();
    return null;
  }
  store = storeModule;
  target = { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };

  const { pending, oldest } = store.nativeShipStats();
  console.log(
    `[native-shipper] shipping native observations to ${new URL(INGEST_PATH, CENTRAL_URL).href}`,
    `every ${SHIP_INTERVAL_MS / 1000}s as node ${store.nodeId()};`,
    pending ? `${pending} queued, oldest ${oldest}.` : 'queue is empty.'
  );

  // Immediately, before the first interval: whatever accumulated while this process was down is
  // the backlog most worth clearing. Same reasoning as the other two shippers' catch-up tick.
  setImmediate(drain);
  timer = setInterval(drain, SHIP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopNativeShipper() {
  if (timer) clearInterval(timer);
  timer = null;
  if (target && target.agent && typeof target.agent.destroy === 'function') target.agent.destroy();
  target = null;
  store = null;
  inFlight = false;
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

/** True when this node has somewhere to ship observations to. Read by
 *  server/nativeObservations.js's prune, which must not age out rows the shipper still owes
 *  central — and must age them out normally on a node that will never ship anything. */
function isShipping() {
  return Boolean(timer && target);
}

module.exports = {
  startNativeShipper,
  stopNativeShipper,
  drain,
  isShipping,
  toEnvelope,
  toNdjson,
  CENTRAL_URL,
  INGEST_PATH,
  SHIP_INTERVAL_MS,
  BATCH_MAX,
  MAX_UNSHIPPED,
};
