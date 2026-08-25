'use strict';
// Correction-semantics fixture for the node's local usage copy.
// Run: node server/usage-correction-test.js
//
// This test GATES step 3 of docs/design/retiring-sqlite-on-the-node.md ("audit spool + head, and
// the outbox disappears"). That step makes the node's local usage copy append-only, and the doc is
// explicit that this is the one place a reader would notice a difference:
//
//   "Making the node's local copy append-only means its local read of a corrected event becomes
//    'last statement wins' rather than 'the row' — a real behaviour change, and the only one in
//    this plan that a reader would notice."
//
// Today `patchUsageEvent` rewrites the row in place and re-chains from it. After step 3 a correction
// is an appended statement and the read collapses the statements to the latest. Either way, the
// behaviour a *reader* is entitled to must not move — and that is what this fixture pins, in terms
// only of the sink contract's own reads (findUsageEvent / listUsageEvents / verifyUsageEventChain),
// never the storage shape underneath. It passes against the current mutable copy; it must still pass
// against the append-only one, or the change broke a reader.
//
// It runs against a scratch database (WINDROW_DB_PATH, set below before store.js is required), with
// no central configured — corrections and the hash chain are entirely node-local, so this needs no
// sink. (The shipping side of a correction — that it travels as its own `usage_event_correction`
// shipment and does not overwrite the original — is covered by usage-outbox-test.js. This is the
// read side.)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-correction-'));
process.env.WINDROW_DB_PATH = path.join(scratch, 'test.db');
process.env.WINDROW_NODE_ID = 'node_test';
delete process.env.WINDROW_CENTRAL_URL; // node-local: no outbox, no shipper

const store = require('./store');

let evCounter = 0;
function recordEvent(capabilityId, outcome = 'ok', extra = {}) {
  evCounter += 1;
  const id = `ev_test_${evCounter}`;
  store.insertUsageEvent({
    id,
    principalId: 'pr_test',
    capabilityId,
    ts: new Date().toISOString(),
    outcome,
    latencyMs: 10,
    ...extra,
  });
  return id;
}

function countFor(id) {
  return store.listUsageEvents().filter((r) => r.id === id).length;
}

function main() {
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

  // ---- 1. a fresh event reads as itself, uncorrected ------------------------
  const id = recordEvent('cap_destroy', 'denied', { reason: 'no grant' });
  let read = store.findUsageEvent(id);
  assert.strictEqual(read.outcome, 'denied', 'a fresh event reads with the outcome it was recorded with');
  assert.strictEqual(read.reason, 'no grant', 'a fresh event reads with its reason');
  assert.strictEqual(read.correctedAt, null, 'a fresh event carries no correctedAt');
  console.log('  ok  a fresh event reads as itself, with no correction marker');

  // ---- 2. last statement wins: a corrected event reads as its correction ----
  // The consent path: POST /api/usage/:id/approve-consent's write, denied -> approved.
  const correctedAt = new Date().toISOString();
  store.patchUsageEvent(id, { outcome: 'approved', reason: 'owner approved', correctedAt });
  read = store.findUsageEvent(id);
  assert.strictEqual(read.outcome, 'approved', 'reading a corrected event yields the correction, not the original');
  assert.strictEqual(read.reason, 'owner approved', 'the correction supersedes the original reason too');
  assert.strictEqual(read.correctedAt, correctedAt, 'a corrected event reads with correctedAt set');
  console.log('  ok  last statement wins: a corrected event reads as its latest statement');

  // ---- 3. a correction supersedes; it does not fork the read ----------------
  // The invariant that most tightly constrains an append-only rewrite: a reader must still see ONE
  // current event per id. If step 3 appends the correction as a second visible row instead of
  // collapsing to the latest, this is where it shows.
  assert.strictEqual(countFor(id), 1, 'a corrected event appears exactly once to a reader, not once per statement');
  console.log('  ok  a correction supersedes the original for a reader — one row per event, never two');

  // ---- 4. untouched fields survive a correction -----------------------------
  // A correction states a new outcome; it must not lose the rest of what was observed.
  assert.strictEqual(read.capabilityId, 'cap_destroy', 'a correction preserves the capability');
  assert.strictEqual(read.principalId, 'pr_test', 'a correction preserves the principal');
  assert.strictEqual(read.nodeId, 'node_test', "a correction preserves the event's node coordinate");
  console.log('  ok  a correction changes only what it states; the rest of the event survives');

  // ---- 5. corrections compose: the LATEST wins, not the first --------------
  const later = new Date(Date.now() + 1000).toISOString();
  store.patchUsageEvent(id, { outcome: 'denied', reason: 'approval rescinded', correctedAt: later });
  read = store.findUsageEvent(id);
  assert.strictEqual(read.outcome, 'denied', 'a second correction wins over the first');
  assert.strictEqual(read.reason, 'approval rescinded', 'the reason is the latest statement, not an earlier one');
  assert.strictEqual(read.correctedAt, later, 'correctedAt advances to the latest correction');
  assert.strictEqual(countFor(id), 1, 'multiple corrections still read as one current event');
  console.log('  ok  corrections compose — the latest statement wins over every earlier one');

  // ---- 6. the chain still verifies after a correction ----------------------
  // The re-chain is the risk the doc flags: a correction moves this row's hash and every hash after
  // it. Whatever step 3 does to keep an append-only spool verifiable, a reader's chain check must
  // still come back intact — otherwise a routine correction reads as tampering.
  recordEvent('cap_read', 'ok'); // an event AFTER the corrected one, so a bad re-chain has a tail to break
  store.patchUsageEvent(id, { outcome: 'approved', correctedAt: new Date().toISOString() });
  const chain = store.verifyUsageEventChain();
  assert.strictEqual(chain.ok, true, `the chain must verify after a correction, got: ${JSON.stringify(chain)}`);
  console.log('  ok  the hash chain verifies after a correction — a correction is not tampering');

  console.log('\nusage correction semantics: all checks passed.');
}

try {
  main();
  cleanup(0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  cleanup(1);
}

function cleanup(code) {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows may hold the db file briefly */ }
  process.exit(code);
}
