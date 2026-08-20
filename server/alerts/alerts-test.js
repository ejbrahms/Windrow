'use strict';
// End-to-end test of the two-ended alert engine
// (docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both ends").
// Run: node server/alerts/alerts-test.js
//
// It runs the NODE end for real — a scratch SQLite database, real usage events, the real rule
// engine — and stands central in as an in-memory table keyed exactly as the design specifies. That
// split is deliberate: the node half is the half that has to work on a machine with no network, so
// it is the half worth exercising against a real store, while central's contribution to the
// property under test is one primary key on a shared string. A Postgres-backed run of central's own
// engine is `server/central/smoke.js`'s territory; ./rules.js's key is what makes the two agree,
// and this file tests THAT.
//
// What it asserts, in order:
//   1. The window is snapped, so two evaluations at different instants inside one stride produce
//      ONE key — the property the whole dedup rests on.
//   2. A burst under the threshold fires nothing; crossing it fires exactly one alert.
//   3. Re-evaluating the same breach does not fire again (the primary key), and neither does the
//      next overlapping window (the cooldown).
//   4. A breach seen from BOTH ends lands on one row: the node's alert and central's independently
//      derived alert compute the same key, and the second is a duplicate.
//   5. Central's re-derivation records the node's count in `peerValue` rather than discarding it.
//   6. A node may not fire an alert about another machine.
//   7. The count is taken over `usage_events`, NOT over the outbox — draining the queue must not
//      change whether a burst breached.
//   8. A fleet-scoped rule is never evaluated by the node, at any traffic level.
//   9. The subject fallback is the same string on both ends.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-alerts-'));
process.env.WINDROW_DB_PATH = path.join(scratch, 'test.db');
process.env.WINDROW_NODE_ID = 'node_a';

const rules = require('./rules');
const store = require('../store');
const engine = require('./nodeEngine');
const central = require('../central/alertEngine');

const NODE_A = 'node_a';

// A rule list of our own, so the test does not break every time a shipped threshold is retuned.
// Same shapes as the defaults: one node-scoped volume rule and one fleet-scoped one.
const TEST_RULES = [
  {
    id: 'test-burst',
    title: 'test burst',
    scope: 'node',
    match: { riskTier: 'destructive' },
    metric: 'count',
    threshold: 5,
    windowMs: 5 * 60_000,
    strideMs: 60_000,
    cooldownMs: 5 * 60_000,
    severity: 'critical',
  },
  {
    id: 'test-fleet',
    title: 'test fleet',
    scope: 'fleet',
    match: { outcome: 'denied' },
    metric: 'count',
    threshold: 3,
    windowMs: 10 * 60_000,
    strideMs: 2 * 60_000,
    cooldownMs: 10 * 60_000,
    severity: 'warning',
  },
];

const { rules: loaded } = rules.loadRules(TEST_RULES);
const burstRule = loaded.find((r) => r.id === 'test-burst');
const fleetRule = loaded.find((r) => r.id === 'test-fleet');

// ---------------------------------------------------------------------------
// The stand-in for central: one Map keyed on the alert key, which is the entirety of what §2.3
// asks of central's side of the dedup. `insert` returns whether the row was new, exactly as
// `ON CONFLICT (key) DO NOTHING ... RETURNING key` does.
// ---------------------------------------------------------------------------
function newCentral() {
  const rows = new Map();
  return {
    rows,
    insert(alert) {
      if (rows.has(alert.key)) {
        const existing = rows.get(alert.key);
        // The UPDATE ... WHERE "peerValue" IS NULL AND "firedBy" <> $2 branch of upsertAlert.
        if (existing.peerValue == null && existing.firedBy !== alert.firedBy) {
          existing.peerFiredBy = alert.firedBy;
          existing.peerValue = alert.value;
        }
        return false;
      }
      rows.set(alert.key, { ...alert });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let seq = 0;
function seedCapability(id, riskTier) {
  store.save({
    ...store.load(),
    capabilities: [
      ...store.load().capabilities.filter((c) => c.id !== id),
      { id, kind: 'mcp_tool', name: id, description: id, riskTier, owner: 'test' },
    ],
  });
}

function record({ capabilityId, outcome = 'ok', subjectId = 'sub-1' }) {
  seq += 1;
  return store.insertUsageEvent({
    id: `ev_${seq}`,
    principalId: 'p1',
    capabilityId,
    ts: new Date().toISOString(),
    outcome,
    subjectId,
  });
}

function alertsInStore() {
  return store.listAlerts({ limit: 1000 });
}

// ---------------------------------------------------------------------------
function testWindowIsSnapped() {
  // The property everything else rests on: two clocks a few seconds apart inside one stride bucket
  // must produce the same window, and therefore the same key. A sliding window would fail this,
  // and every dedup below would silently stop working.
  const t = Date.parse('2026-08-19T12:04:07.000Z');
  const a = rules.windowFor(burstRule, t);
  const b = rules.windowFor(burstRule, t + 31_000); // still inside the 12:04 stride bucket
  assert.deepStrictEqual(a, b, 'two evaluations inside one stride must share a window');
  assert.strictEqual(rules.windowKey(a.windowStart), '2026-08-19T12:00:00.000Z');
  assert.strictEqual(rules.windowKey(a.windowEnd), '2026-08-19T12:05:00.000Z');

  // ...and the next bucket is a DIFFERENT window, so a genuinely later breach is not swallowed.
  const c = rules.windowFor(burstRule, t + 60_000);
  assert.notStrictEqual(c.windowStart, a.windowStart, 'the next stride bucket must be its own window');

  // The event that triggered the evaluation is inside the window it triggered — the reason
  // windowEnd is the END of the bucket rather than its start.
  const onBoundary = Date.parse('2026-08-19T12:04:00.000Z');
  const w = rules.windowFor(burstRule, onBoundary);
  assert.ok(onBoundary >= w.windowStart && onBoundary < w.windowEnd, 'an event on a stride boundary must fall in its own window');

  // A rule whose stride exceeds its window leaves uncounted time — refused, not clamped.
  const bad = rules.normalizeRule({ ...TEST_RULES[0], id: 'too-fast', windowMs: 60_000, strideMs: 120_000 });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /uncounted/);
  console.log('  ok  1. the window is snapped to a stride both ends can compute');
}

function testBurstFiresOnce() {
  seedCapability('cap_destructive', 'destructive');
  seedCapability('cap_read', 'read_only');

  // Under the threshold: nothing.
  for (let i = 0; i < 4; i += 1) record({ capabilityId: 'cap_destructive' });
  assert.deepStrictEqual(engine.evaluateNow(), [], 'four destructive calls must not breach a threshold of five');
  assert.strictEqual(alertsInStore().length, 0);

  // Read-only calls do not count toward a destructive-tier rule, however many there are.
  for (let i = 0; i < 20; i += 1) record({ capabilityId: 'cap_read' });
  assert.deepStrictEqual(engine.evaluateNow(), [], 'read_only calls must not satisfy a destructive-tier rule');

  // Crossing it: exactly one alert, and it is >= rather than >.
  record({ capabilityId: 'cap_destructive' });
  const fired = engine.evaluateNow();
  assert.strictEqual(fired.length, 1, 'the fifth destructive call must fire exactly one alert');
  assert.strictEqual(fired[0].ruleId, 'test-burst');
  assert.strictEqual(fired[0].value, 5);
  assert.strictEqual(fired[0].scopeId, NODE_A, 'a node-scoped alert is keyed to the machine it happened on');
  assert.strictEqual(fired[0].firedBy, 'node');
  console.log('  ok  2. a burst under the threshold is silent; crossing it fires once');
  return fired[0];
}

function testNoRefire(first) {
  // Same window, evaluated again: the primary key swallows it.
  const again = engine.evaluateNow();
  assert.deepStrictEqual(again, [], 'the same window must not fire twice');
  assert.strictEqual(alertsInStore().length, 1);

  // The NEXT overlapping window is a different key — only the cooldown stops it. Evaluate one
  // stride later with the same events still inside the window.
  const later = engine.evaluateNow(Date.now() + burstRule.strideMs);
  assert.deepStrictEqual(later, [], 'an adjacent overlapping window of one continuing breach must be suppressed by the cooldown');
  assert.strictEqual(alertsInStore().length, 1, 'one continuing breach is one alert, not one per stride');


  // ...and it really was the COOLDOWN that stopped it, not the key. The adjacent window is a
  // genuinely new key, which is the whole reason the cooldown has to exist as a second mechanism:
  // with overlapping strides the primary key alone would let one five-minute burst produce one
  // alert per stride. Recording that next-window alert directly is a new row, and that is the
  // proof — if the key had covered it, this would return false.
  const nextWindow = rules.buildAlert({
    rule: burstRule,
    scopeId: NODE_A,
    subjectId: first.subjectId,
    value: first.value,
    windowStartMs: Date.parse(first.windowStart) + burstRule.strideMs,
    firedBy: rules.FIRED_BY_NODE,
    nodeId: NODE_A,
    firedAt: new Date().toISOString(),
  });
  assert.notStrictEqual(nextWindow.key, first.key, 'the adjacent window is its own key');
  assert.strictEqual(store.recordAlert(nextWindow), true, 'the key alone would have let the adjacent window through');
  assert.strictEqual(store.recordAlert(nextWindow), false, 'and the key does stop that same window arriving twice');
  console.log('  ok  3. the key stops a repeat of one window; the cooldown stops adjacent windows');
}

function testBothEndsFireOnce(nodeAlert) {
  const centralDb = newCentral();

  // The node's alert reaches central through POST /api/ingest/alerts, whose normalizer RECOMPUTES
  // the key rather than trusting the node's.
  const incoming = central.normalizeIncoming(
    { ...nodeAlert, detail: nodeAlert.detail },
    NODE_A
  );
  assert.strictEqual(incoming.ok, true, incoming.reason);
  assert.strictEqual(incoming.value.key, nodeAlert.key, 'central must recompute the same key the node computed');
  assert.strictEqual(centralDb.insert(incoming.value), true, 'the first arrival is a new row');

  // Now central derives the SAME breach independently from the events that have since shipped.
  // Different value (central saw one more event), different firedBy, same window, same subject.
  const centralAlert = rules.buildAlert({
    rule: burstRule,
    scopeId: NODE_A,
    subjectId: nodeAlert.subjectId,
    value: nodeAlert.value + 1,
    windowStartMs: Date.parse(nodeAlert.windowStart),
    firedBy: rules.FIRED_BY_CENTRAL,
    nodeId: NODE_A,
    firedAt: new Date().toISOString(),
  });
  assert.strictEqual(centralAlert.key, nodeAlert.key, 'both ends must compute the same key for one breach');
  assert.strictEqual(centralDb.insert(centralAlert), false, 'a breach seen from both sides fires once');
  assert.strictEqual(centralDb.rows.size, 1);
  console.log('  ok  4. a breach seen from both ends lands on one row');

  const row = centralDb.rows.get(nodeAlert.key);
  assert.strictEqual(row.firedBy, 'node', 'the FIRST observation is kept — the node saw it first');
  assert.strictEqual(row.value, nodeAlert.value, 'the winning row keeps the winner\'s count');
  assert.strictEqual(row.peerFiredBy, 'central');
  assert.strictEqual(row.peerValue, nodeAlert.value + 1, 'the loser\'s count is recorded, not discarded');
  console.log('  ok  5. the second observation is kept as peerValue rather than thrown away');
}

function testNodeCannotForgeAnotherNode(nodeAlert) {
  const forged = central.normalizeIncoming({ ...nodeAlert, scopeId: 'node_b', nodeId: 'node_b' }, NODE_A);
  assert.strictEqual(forged.ok, false, 'a node claiming another machine\'s scope must be refused');
  assert.match(forged.reason, /may only fire alerts about itself/);

  // And a body that claims central detected it does not get to say so.
  const claiming = central.normalizeIncoming({ ...nodeAlert, firedBy: 'central' }, NODE_A);
  assert.strictEqual(claiming.ok, true);
  assert.strictEqual(claiming.value.firedBy, 'node', 'anything arriving on the node channel is fired by a node');
  console.log('  ok  6. a node may only fire alerts about itself');
}

function testCountIsOverEventsNotTheOutbox() {
  // The design decision the store's "Alerts" section argues: the window is counted over
  // usage_events, so draining the queue cannot change whether a burst breached. Counting the
  // outbox directly would make the answer depend on whether the WAN was up.
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const windowEnd = new Date(Date.now() + 60_000).toISOString();
  const before = store.alertBreaches({ ...burstRule, threshold: 1 }, { windowStart, windowEnd, node: NODE_A });
  assert.ok(before.length && before[0].value >= 5, 'the destructive calls are counted');

  // The outbox was never enabled in this test (no central configured), so it holds nothing at all —
  // which is exactly the state that would make an outbox-counting engine blind on a HEALTHY node.
  assert.strictEqual(store.usageOutboxStats(NODE_A).pending, 0, 'no central configured means an empty queue');
  const after = store.alertBreaches({ ...burstRule, threshold: 1 }, { windowStart, windowEnd, node: NODE_A });
  assert.deepStrictEqual(after, before, 'an empty outbox must not change what the rule counts');
  console.log('  ok  7. the count is over usage_events — an empty queue does not hide a burst');
}

function testFleetRuleIsNeverNodeEvaluated() {
  // A fleet-scoped rule must not be evaluated locally at ANY traffic level: a partial count under
  // the fleet key would be inserted first and central's correct count discarded as a duplicate.
  for (let i = 0; i < 50; i += 1) record({ capabilityId: 'cap_read', outcome: 'denied' });
  const fired = engine.evaluateNow(Date.now() + 10 * burstRule.cooldownMs);
  assert.ok(
    fired.every((a) => a.ruleId !== 'test-fleet'),
    'the node must never fire a fleet-scoped rule, however much local traffic there is'
  );
  assert.strictEqual(
    engine.nodeAlertStats().rules.includes('test-fleet'), false,
    'a fleet-scoped rule must not even be loaded into the node engine'
  );

  // Central, over the aggregate, is where it belongs — and its scopeId is the constant.
  const fleetAlert = rules.buildAlert({
    rule: fleetRule,
    scopeId: rules.FLEET,
    subjectId: 'sub-1',
    value: 50,
    windowStartMs: rules.windowFor(fleetRule, Date.now()).windowStart,
    firedBy: rules.FIRED_BY_CENTRAL,
  });
  assert.ok(fleetAlert.key.includes('|fleet|'), 'a fleet alert is keyed under the fleet, not a node');
  console.log('  ok  8. a fleet-scoped rule is central\'s alone');
}

function testSubjectFallbackMatches() {
  // Both ends must produce the same subject string for an event with no subjectId, or one subject's
  // activity is split in two and neither half crosses a threshold the whole would.
  const ev = record({ capabilityId: 'cap_destructive', subjectId: null });
  assert.strictEqual(ev.subjectId, null);
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const windowEnd = new Date(Date.now() + 60_000).toISOString();
  const rowsFound = store.alertBreaches({ ...burstRule, threshold: 1 }, { windowStart, windowEnd, node: NODE_A });
  const unattributed = rowsFound.find((r) => r.subjectId === 'principal:p1');
  assert.ok(unattributed, 'an event with no subject is counted under principal:<id>, the same fallback central uses');
  console.log('  ok  9. the subject fallback is one string, shared by both ends');
}

// ---------------------------------------------------------------------------
function main() {
  console.log('two-ended alert evaluation — docs/design/global-identity-and-central-db.md §2.3\n');
  // Wire the engine to the test rule list rather than the shipped one, and without the shipper:
  // this test is about what fires and what is deduped, not about delivery.
  engine.startNodeAlertEngine(store, { ruleSet: TEST_RULES });

  testWindowIsSnapped();
  const first = testBurstFiresOnce();
  testNoRefire(first);
  testBothEndsFireOnce(first);
  testNodeCannotForgeAnotherNode(first);
  testCountIsOverEventsNotTheOutbox();
  testFleetRuleIsNeverNodeEvaluated();
  testSubjectFallbackMatches();

  engine.stopNodeAlertEngine();
  console.log('\nall alert assertions passed.');
}

try {
  main();
  process.exitCode = 0;
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir on Windows can be held briefly */ }
}
