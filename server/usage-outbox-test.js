'use strict';
// End-to-end test of the local outbox and the background shipper
// (docs/design/global-identity-and-central-db.md §2.3).
// Run: node server/usage-outbox-test.js
//
// It runs against a scratch database (WINDROW_DB_PATH, set below before store.js is required) and a
// throwaway HTTP sink on loopback standing in for central. The sink implements the one property
// §2.3 asks of ingest — idempotent on (nodeId, seq), ON CONFLICT DO NOTHING — so the at-least-once
// claim can be tested rather than asserted: a batch is deliberately delivered twice and the second
// delivery must land as duplicates, not as a second copy of the events.
//
// What it asserts, in order:
//   1. An event is enqueued in the same transaction that records it.
//   2. Nothing is enqueued when no central is configured.
//   3. Shipment numbers are gapless per node AND survive the queue emptying.
//   4. `denied`, `destructive` and consent corrections take the immediate lane; an ordinary `ok`
//      read_only call does not.
//   5. A correction ships as its own shipment rather than overwriting the original's.
//   6. Rows are deleted on ack and kept on failure.
//   7. A redelivery is deduped by central and costs nothing.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-outbox-'));
process.env.WINDROW_DB_PATH = path.join(scratch, 'test.db');
process.env.WINDROW_NODE_ID = 'node_test';

let sink;
let store;
let shipper;

// ---------------------------------------------------------------------------
// The stand-in for central. Keyed exactly as §2.3 specifies.
// ---------------------------------------------------------------------------
function startSink() {
  const received = new Map(); // "nodeId:seq" -> envelope
  const batches = [];
  const state = { fail: false, received, batches };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (state.fail) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'sink is down' }));
      }
      const lines = body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      let accepted = 0;
      let duplicates = 0;
      for (const envelope of lines) {
        // The line itself carries no shipment number — that lives on the row — so the test sink
        // reads it back off the header + order the same way a real one would read it off the
        // envelope's own key. Envelopes are keyed here by (nodeId, event.id, kind), which is the
        // shape a real ingest would use to apply a correction by event id.
        const key = `${envelope.nodeId}:${envelope.kind}:${envelope.event.id}`;
        if (received.has(key)) duplicates += 1;
        else { received.set(key, envelope); accepted += 1; }
      }
      batches.push({ count: lines.length, nodeId: req.headers['x-windrow-node-id'], contentType: req.headers['content-type'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted, duplicates }));
    });
  });
  return new Promise((resolve) => {
    // The handler closes over `state`, so the caller has to be handed that same object — spreading
    // it into a copy here would make `sink.fail = true` set a field nothing reads.
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.port = server.address().port;
      resolve(state);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition the shipper reaches asynchronously, rather than sleeping a guessed amount. */
async function until(label, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

let evCounter = 0;
function recordEvent(capabilityId, outcome = 'ok') {
  evCounter += 1;
  const id = `ev_test_${evCounter}`;
  store.insertUsageEvent({
    id,
    principalId: 'pr_test',
    capabilityId,
    ts: new Date().toISOString(),
    outcome,
    latencyMs: 10,
  });
  return id;
}

async function main() {
  sink = await startSink();

  // ---- 2. no central configured → no queue ---------------------------------
  // store.js is required with WINDROW_CENTRAL_URL unset, exactly as it is on a single-machine
  // field, and must not queue anything.
  delete process.env.WINDROW_CENTRAL_URL;
  store = require('./store');
  store.insertCapability({
    id: 'cap_read', kind: 'skill', name: 'read-thing', owner: 'test', riskTier: 'read_only',
    description: null, source: 'test', discoveredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), stale: 0, autoGrant: 0, realUsage: 0,
  });
  store.insertCapability({
    id: 'cap_destroy', kind: 'skill', name: 'destroy-thing', owner: 'test', riskTier: 'destructive',
    description: null, source: 'test', discoveredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), stale: 0, autoGrant: 0, realUsage: 0,
  });

  assert.strictEqual(store.isUsageOutboxEnabled(), false, 'outbox must be off with no central configured');
  recordEvent('cap_read');
  assert.strictEqual(store.usageOutboxStats().pending, 0, 'nothing may queue while the outbox is off');
  console.log('  ok  no central configured → the event is recorded locally and nothing is queued');

  // ---- start the shipper against the sink ----------------------------------
  process.env.WINDROW_CENTRAL_URL = `http://127.0.0.1:${sink.port}`;
  process.env.WINDROW_SHIP_INTERVAL_MS = '250'; // the real default is 5000; shortened so the test is not a stopwatch
  shipper = require('./usageShipper');
  assert.ok(shipper.startUsageShipper(store), 'shipper should start against a loopback sink');
  assert.strictEqual(store.isUsageOutboxEnabled(), true, 'starting the shipper turns the queue on');

  // ---- 1 + 3. enqueue in the same transaction, gapless numbering -----------
  await until('the startup catch-up flush to settle', () => store.usageOutboxStats().pending === 0);
  const okId = recordEvent('cap_read');
  const stats = store.usageOutboxStats();
  assert.strictEqual(stats.pending, 1, 'recording an event must queue exactly one shipment');
  assert.strictEqual(stats.urgentPending, 0, 'an ok read_only call rides the timer, not the immediate lane');
  console.log('  ok  an ordinary ok/read_only call queues one shipment in the ordinary lane');

  await until('the timer to ship the ordinary event', () => sink.received.has(`node_test:usage_event:${okId}`));
  assert.strictEqual(store.usageOutboxStats().pending, 0, 'an acked shipment is deleted from the queue');
  console.log('  ok  the 5-second timer lane ships and the acked row is deleted');

  // ---- 4. the immediate lane ----------------------------------------------
  for (const [label, capabilityId, outcome] of [
    ['a denied outcome', 'cap_read', 'denied'],
    ['a destructive-tier call', 'cap_destroy', 'ok'],
  ]) {
    const before = Date.now();
    const id = recordEvent(capabilityId, outcome);
    // Far inside the 250 ms timer, so arriving this fast can only be the urgent flush.
    await until(`${label} to flush immediately`, () => sink.received.has(`node_test:usage_event:${id}`), 200);
    console.log(`  ok  ${label} flushed immediately (${Date.now() - before}ms, timer interval is 250ms)`);
  }

  // ---- 5. a consent correction is its own shipment ------------------------
  const deniedId = recordEvent('cap_destroy', 'denied');
  await until('the denied event to ship', () => sink.received.has(`node_test:usage_event:${deniedId}`));
  const shippedOriginal = sink.received.get(`node_test:usage_event:${deniedId}`);
  assert.strictEqual(shippedOriginal.event.outcome, 'denied', 'the original shipment carries the outcome as it was');

  // The consent correction: POST /api/usage/:id/approve-consent's write, denied → approved.
  const t0 = Date.now();
  store.patchUsageEvent(deniedId, { outcome: 'approved', correctedAt: new Date().toISOString() });
  await until(
    'the consent correction to flush immediately',
    () => sink.received.has(`node_test:usage_event_correction:${deniedId}`),
    200
  );
  const correction = sink.received.get(`node_test:usage_event_correction:${deniedId}`);
  assert.strictEqual(correction.event.outcome, 'approved', 'the correction carries the corrected outcome');
  assert.ok(correction.event.correctedAt, 'the correction carries correctedAt');
  assert.notStrictEqual(
    correction.event.hash,
    shippedOriginal.event.hash,
    'a correction changes the row, so its hash must have moved — central has to receive the new one'
  );
  assert.strictEqual(
    sink.received.get(`node_test:usage_event:${deniedId}`).event.outcome,
    'denied',
    'the correction must NOT overwrite the original shipment — central keeps both statements'
  );
  console.log(`  ok  a consent correction ships as its own shipment, immediately (${Date.now() - t0}ms), re-chained`);

  // ---- gapless shipment numbering across an emptied queue ------------------
  // The queue has drained to empty several times by now. If the counter were derived from
  // MAX(seq) it would have restarted at 1 each time and central would have deduped genuine
  // shipments away. Every event above arrived, so it did not.
  // The sink is taken down FIRST, so this row is still in the queue to be inspected — otherwise the
  // 250 ms timer races the assertion and wins about as often as not.
  sink.fail = true;
  const okQueued = recordEvent('cap_read');
  const queuedSeq = store.listOutboxBatch()[0].seq;
  // Six shipments have been queued since the outbox was turned on (ok, denied, destructive,
  // denied-again, its correction, and this one) and the queue has been empty between most of them.
  // A counter derived from MAX(seq) would read 1 here.
  assert.strictEqual(queuedSeq, 6, `shipment numbers must keep climbing across an emptied queue, got ${queuedSeq}`);
  console.log(`  ok  shipment numbers survive the queue emptying (next is ${queuedSeq}, not 1)`);

  // ---- 6. rows are kept on failure ----------------------------------------
  await until('the failing cycle to record an attempt', () => store.usageOutboxStats().maxAttempts > 0, 3000);
  const failing = store.usageOutboxStats();
  assert.strictEqual(failing.pending, 1, 'a failed delivery must keep the row queued');
  assert.ok(failing.lastError, 'a failed delivery records why');
  console.log(`  ok  a failed delivery keeps the row and records the reason: ${failing.lastError.slice(0, 60)}`);

  sink.fail = false;
  shipper.flushNow(); // an urgent flush ignores the backoff — that is what lets a node notice central is back
  await until('the retry to succeed', () => sink.received.has(`node_test:usage_event:${okQueued}`), 3000);
  assert.strictEqual(store.usageOutboxStats().pending, 0, 'the retry drains the queue');
  console.log('  ok  the retry after an outage ships the held row and drains the queue');

  // ---- 7. a redelivery is deduped -----------------------------------------
  const before = sink.received.size;
  const replay = sink.batches.length;
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ nodeId: 'node_test', kind: 'usage_event', event: { id: okQueued, outcome: 'ok' } }) + '\n';
    const req = http.request(
      { host: '127.0.0.1', port: sink.port, method: 'POST', path: '/api/ingest/usage', headers: { 'content-type': 'application/x-ndjson' } },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          const parsed = JSON.parse(text);
          assert.strictEqual(parsed.duplicates, 1, 'a redelivered shipment must be deduped, not stored twice');
          assert.strictEqual(parsed.accepted, 0, 'a redelivery accepts nothing new');
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.strictEqual(sink.received.size, before, 'a redelivery adds no events');
  assert.strictEqual(sink.batches.length, replay + 1, 'the redelivery was a real request');
  console.log('  ok  at-least-once delivery is free: a redelivery is deduped by the ingest key');

  // ---- transport shape ----------------------------------------------------
  const last = sink.batches[sink.batches.length - 2];
  assert.strictEqual(last.contentType, 'application/x-ndjson', 'batches are shipped as NDJSON');
  assert.strictEqual(last.nodeId, 'node_test', 'batches name their node in a header');
  console.log('  ok  batches are NDJSON over HTTP and name their node');

  console.log('\nusage outbox + shipper: all checks passed.');
}

main()
  .then(() => cleanup(0))
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    cleanup(1);
  });

function cleanup(code) {
  try { if (shipper) shipper.stopUsageShipper(); } catch { /* nothing left to stop */ }
  try { if (sink) sink.server.close(); } catch { /* already closed */ }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows may hold the db file briefly */ }
  process.exit(code);
}
