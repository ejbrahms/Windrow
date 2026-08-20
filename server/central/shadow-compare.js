'use strict';

// The node half of shadow mode — `npm run shadow:compare --prefix server`.
//
// docs/design/global-identity-and-central-db.md §2.7 phase 3 is three things: stand central up,
// ship everything to it, and **compare**. This is the compare. It runs ON A NODE, reads that
// node's own database directly, and posts the resulting account of itself to central's
// `POST /api/ingest/reconcile`, which stores the verdict in `shadow_reconciliations` and hands it
// straight back.
//
// WHY THE NODE REPORTS RATHER THAN CENTRAL ASKING. Phase 3's whole promise is that the node stays
// authoritative and that stopping central changes nothing. A central that reached into nodes to
// audit them would need a channel INTO each node — a port to open, a credential for central to
// hold, and an inbound path on a user's PC — and that channel, once it exists, is the obvious
// place for phase 4's authority to arrive through before anyone has decided it should. Pushing
// keeps every direction of travel the same as §2.2's: policy down, usage up, and nothing reaching
// down into a node that is not policy.
//
// WHAT IT MEASURES, and why each number is on the list:
//
//   eventCount     what the node holds. The count central's copy is compared against.
//   chainSeq/Hash  the node's own chain head. If central's copy of the stream reconstructs to a
//                  different head, central's copy has been written by something else — the one
//                  finding that would stop phase 4 outright.
//   outboxPending  what has not shipped yet. This is what turns "central is behind" from an alarm
//                  into arithmetic: behind by exactly the queue depth is the 5-second timer doing
//                  its job, and behind by more than the queue depth is missing data.
//
// Exits non-zero on a `gap` or `divergent` verdict, so this is usable as a scheduled check rather
// than only as something a person reads.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { envCompat } = require('../config');
const enrollClient = require('../enrollment/client');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const RECONCILE_PATH = envCompat('CENTRAL_RECONCILE_PATH') || '/api/ingest/reconcile';
const CREDENTIAL_NAME = envCompat('SHIP_CREDENTIAL_NAME') || 'node-shipper';

/** This node's account of itself, read straight out of its own SQLite. */
function nodeReport(store) {
  const node = store.nodeId();
  const head = store.listChainHeads().find((h) => h.nodeId === node) || null;
  const outbox = store.usageOutboxStats(node);
  return {
    nodeId: node,
    // Reported, not asserted: §2.6's version-skew rule works both ways, and central telling a
    // mixed-version fleet from a quiet one (its own words) needs the number.
    schemaVersion: typeof store.schemaVersion === 'function' ? store.schemaVersion() : null,
    eventCount: store.countUsageEvents(node),
    chainSeq: head ? head.seq : null,
    chainHash: head ? head.hash : null,
    outboxPending: outbox.pending,
    outboxOldestEnqueuedAt: outbox.oldestEnqueuedAt,
    outboxLastError: outbox.lastError,
    reportedAt: new Date().toISOString(),
  };
}

function post(url, body, agent, mod) {
  return new Promise((resolve, reject) => {
    const target = new URL(RECONCILE_PATH, url);
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { return resolve(JSON.parse(text)); } catch (err) { return reject(new Error(`central sent unparseable JSON: ${err.message}`)); }
        }
        reject(new Error(`central returned HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('no response within 30s')));
    req.on('error', reject);
    req.end(body);
  });
}

async function compare(store) {
  if (!CENTRAL_URL) throw new Error('WINDROW_CENTRAL_URL is not set — there is no central to compare against.');
  const parsed = new URL(CENTRAL_URL);
  let agent;
  let mod;
  if (parsed.protocol === 'http:') {
    // Same loopback-only carve-out server/usageShipper.js makes, for the same reason and with the
    // same limit: a developer's central has nothing to issue certificates with yet.
    const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (!local) throw new Error(`WINDROW_CENTRAL_URL is plaintext http to ${parsed.hostname} — only https, or http to loopback, is accepted`);
    mod = http;
    agent = new http.Agent({ keepAlive: false });
  } else {
    const credential = enrollClient.load(CREDENTIAL_NAME);
    if (!credential) throw new Error(`no per-node credential "${CREDENTIAL_NAME}" — enroll this node before it can reconcile.`);
    mod = https;
    agent = enrollClient.agentFor(credential);
  }
  const report = nodeReport(store);
  const result = await post(CENTRAL_URL, JSON.stringify(report), agent, mod);
  if (agent.destroy) agent.destroy();
  return { report, result };
}

function describe({ report, result }) {
  const lines = [
    `node ${report.nodeId}`,
    `  node:    ${report.eventCount} event(s), chain at seq ${report.chainSeq ?? '—'}, ${report.outboxPending} queued`,
    `  central: ${result.central.events} event(s), ${result.central.shipments} shipment(s) received`,
    `  verdict: ${result.verdict.toUpperCase()} — ${result.detail}`,
  ];
  if (result.central.gaps && result.central.gaps.length) {
    lines.push(`  gaps:    ${result.central.gaps.map((g) => `${g.from}-${g.to}`).join(', ')}`);
  }
  if (result.central.chain && !result.central.chain.ok) {
    lines.push(`  chain:   ${result.central.chain.breakCount} break(s) in central's copy`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  // Required here rather than at the top so that importing this module for its `nodeReport` does
  // not open the node's database as a side effect.
  // eslint-disable-next-line global-require
  const store = require('../store');
  compare(store)
    .then((outcome) => {
      console.log(describe(outcome));
      // A gap or a divergence is a finding, not a crash — but a scheduled check has to be able to
      // tell them apart from a clean run without parsing prose, so they set the exit code.
      const bad = outcome.result.verdict === 'gap' || outcome.result.verdict === 'divergent';
      process.exit(bad ? 1 : 0);
    })
    .catch((err) => {
      console.error('[shadow-compare]', err.message);
      process.exit(2); // 2 = could not check, distinct from 1 = checked and found a problem
    });
}

module.exports = { compare, nodeReport, describe };
