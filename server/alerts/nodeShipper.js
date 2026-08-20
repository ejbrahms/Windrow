'use strict';
// Ships this node's fired alerts to central — the second half of §2.3's dedup, seen from the node.
//
// WHY AN ALERT IS SHIPPED AT ALL, GIVEN CENTRAL RE-DERIVES IT. Central evaluates node-scoped rules
// too (see the header of ./rules.js), so for a healthy node the alert this posts is one central
// would have computed for itself within a sweep. The posting still earns its place in the two cases
// that are not the healthy one:
//
//   THE NODE SAW IT FIRST      A partitioned node fires while the events are still queued. When the
//                              link returns, the alert and the events it was derived from arrive
//                              together, and the alert carries the local count — so central learns
//                              the burst was *detected at the time* rather than reconstructed after
//                              the fact. `firedBy` and `firedAt` are the difference, and they are
//                              not recoverable from the events.
//
//   THE EVENTS NEVER ARRIVE    `trimUsageOutbox` drops the oldest shipments on a node that has been
//                              offline past the queue ceiling. Those events reach central never, so
//                              central can never re-derive the alert — and the alert is the small,
//                              cheap, already-summarised statement that survives when the evidence
//                              it summarised does not.
//
// AT-LEAST-ONCE, AND THE RETRY IS FREE. The primary key IS the §2.3 dedup key, on both ends, so a
// redelivery is an ON CONFLICT DO NOTHING and a duplicate costs nothing. That is why this ships
// straight from the `alerts` table with a `syncedAt` flag rather than through a second outbox: the
// idempotency the design already required makes the queue unnecessary.

const { URL } = require('url');
const { envCompat } = require('../config');
const { resolveTransport, REQUEST_TIMEOUT_MS } = require('../usageShipper');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const ALERT_INGEST_PATH = envCompat('CENTRAL_ALERT_INGEST_PATH') || '/api/ingest/alerts';

// Alerts are rare and small — a node firing more than a handful per sweep is a node with a rule
// that is too loose, not a node with a shipping problem — so one modest batch per attempt is
// enough, and a ceiling keeps a misconfigured rule from posting a megabyte.
const BATCH_MAX = Number(envCompat('ALERT_SHIP_BATCH_MAX')) || 200;

let target = null;
let store = null;
let inFlight = false;
let consecutiveFailures = 0;

function post(body, nodeId) {
  return new Promise((resolve, reject) => {
    const url = new URL(ALERT_INGEST_PATH, target.base);
    const req = target.module.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        agent: target.agent,
        headers: {
          'content-type': 'application/json',
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
 * Post whatever is unsynced. Safe to call on every sweep and on every fire.
 *
 * Returns how many alerts central confirmed, or null if the attempt failed — in which case the rows
 * keep their `syncedAt IS NULL` and are tried again. Nothing is ever deleted here: unlike a usage
 * shipment, an alert is evidence this node has to be able to show an operator whether or not it was
 * ever delivered.
 */
async function shipAlertsNow() {
  if (!store || !target || inFlight) return 0;
  const pending = store.listUnsyncedAlerts(BATCH_MAX);
  if (!pending.length) return 0;
  inFlight = true;
  const keys = pending.map((a) => a.key);
  try {
    const nodeId = store.nodeId();
    const body = JSON.stringify({ nodeId, alerts: pending.map(toEnvelope) });
    const result = await post(body, nodeId);
    store.markAlertsSynced(keys);
    if (consecutiveFailures > 0) {
      console.log(`[alerts] central reachable again — delivered ${keys.length} alert(s) after ${consecutiveFailures} failed attempt(s).`);
    }
    consecutiveFailures = 0;
    // `duplicates` means central had already derived this breach from the events. That is the §2.3
    // dedup working rather than an error, and it is worth one line because it is also the proof
    // that the two ends computed the same key.
    if (result && result.duplicates) {
      console.log(`[alerts] central had already fired ${result.duplicates} of ${keys.length} — the dedup key matched on both sides.`);
    }
    return keys.length;
  } catch (err) {
    consecutiveFailures += 1;
    store.markAlertSyncAttempt(keys, err.message);
    // A node that cannot reach central is the NORMAL state this engine was built for, so the first
    // failures are a log line rather than an error: the alert is recorded locally and the operator
    // on that machine can see it. Sustained failure is a different problem and escalates.
    const say = consecutiveFailures >= 5 ? console.error : console.warn;
    say(
      `[alerts] could not deliver ${keys.length} alert(s) to central (attempt ${consecutiveFailures}): ${err.message}.`,
      'They are recorded locally and will be retried on the next sweep.'
    );
    return null;
  } finally {
    inFlight = false;
  }
}

/** The wire shape. A projection rather than the row, so local bookkeeping — `syncedAt`,
 *  `syncAttempts`, `syncError` — stays local: those are facts about THIS node's delivery attempts,
 *  and shipping them would invite central to store one node's retry count as if it meant something
 *  about the alert. */
function toEnvelope(row) {
  return {
    key: row.key,
    ruleId: row.ruleId,
    scope: row.scope,
    scopeId: row.scopeId,
    subjectId: row.subjectId,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    windowMs: row.windowMs,
    metric: row.metric,
    threshold: row.threshold,
    value: row.value,
    severity: row.severity,
    title: row.title,
    firedBy: row.firedBy,
    nodeId: row.nodeId,
    firedAt: row.firedAt,
    detail: row.detail,
  };
}

/**
 * Wire the shipper up. A no-op without a central, which leaves the local engine running and every
 * alert recorded on the machine that fired it — the standalone install's correct behaviour, not a
 * degraded one.
 */
function startAlertShipper(storeModule) {
  if (!CENTRAL_URL) return null;
  const resolved = resolveTransport(CENTRAL_URL);
  if (resolved.error) {
    console.error(`[alerts] not delivering alerts to ${CENTRAL_URL} — ${resolved.error}`);
    return null;
  }
  // The same identity check the usage shipper makes, for the same reason: a credential directory
  // copied between machines would post one node's alerts under another node's identity, and a
  // node-scoped alert whose scopeId names the wrong machine sends an operator to the wrong PC.
  if (resolved.nodeId && resolved.nodeId !== storeModule.nodeId()) {
    console.error(
      `[alerts] credential was issued to node ${resolved.nodeId} but this database is node ${storeModule.nodeId()}`,
      '— refusing to deliver alerts. Enroll this node for its own certificate.'
    );
    resolved.agent.destroy();
    return null;
  }
  store = storeModule;
  target = { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };
  return target;
}

function stopAlertShipper() {
  if (target && target.agent && typeof target.agent.destroy === 'function') target.agent.destroy();
  target = null;
  store = null;
  inFlight = false;
  consecutiveFailures = 0;
}

module.exports = {
  startAlertShipper,
  stopAlertShipper,
  shipAlertsNow,
  toEnvelope,
  CENTRAL_URL,
  ALERT_INGEST_PATH,
};
