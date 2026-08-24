'use strict';

// AUTO-GRANT PROPAGATION — the logic that needs no database.
// Run it with: node server/central/propagation-test.js
//
// ./policy-smoke.js exercises propagation against a real Postgres (the window SQL, an actual grant
// landing on a connected node). This file covers the two pieces that decide the *shape* of the
// answer and would be a silent bug if wrong, without standing a database up:
//
//   1. THE WINDOW BOUND. connectedNodes must ask Postgres for `lastPulledAt >= now - windowMs`, not
//      `> now` or `>= now`. A cutoff computed a sign the wrong way would report the whole fleet as
//      connected, or none of it — the exact failure the window exists to prevent, and invisible
//      unless the parameter it sends is checked.
//   2. THE PARTITION. classifyPropagation splits connected nodes into those already carrying the
//      target version and those the pull still has to reach. Getting the boundary wrong (a node
//      exactly at the target counted as pending) would report a node as catching up forever.

const policyStore = require('./policyStore');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`     ${detail}`);
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** A driver stub that records the query it is asked and answers with canned rows. Only `all` is
 *  touched by connectedNodes; propagateToConnected also calls scheduleNotify, which is a no-op with
 *  no SSE listeners attached, so nothing else is needed. */
function fakeDriver(rows) {
  const calls = [];
  return {
    calls,
    async all(sql, params) {
      calls.push({ sql, params });
      return rows;
    },
  };
}

async function main() {
  // ------------------------------------------------------------------ 1. the window bound
  console.log('connectedNodes asks for the right window');
  const asOf = '2026-08-23T12:00:00.000Z';
  const windowMs = 90_000;
  const driver = fakeDriver([
    { nodeId: 'node_a', replicaVersion: '7', lastPulledAt: '2026-08-23T11:59:30.000Z' },
    { nodeId: 'node_b', replicaVersion: 5, lastPulledAt: '2026-08-23T11:59:00.000Z' },
  ]);
  const connected = await policyStore.connectedNodes(driver, { windowMs, asOf });
  const call = driver.calls[0];
  ok(/WHERE\s+"lastPulledAt"\s*>=\s*\$1/.test(call.sql), 'the cutoff is a lower bound on lastPulledAt', call.sql);
  eq(call.params[0], '2026-08-23T11:58:30.000Z', 'and it is exactly asOf minus the window (90s earlier)');
  eq(connected.map((n) => n.nodeId), ['node_a', 'node_b'], 'every returned row becomes a connected node');
  eq(connected[0].replicaVersion, 7, 'and its replicaVersion is coerced to a number, whatever the driver returned');

  // The default window applies when none is passed — a caller that forgets it must not get "no
  // window" (every node) but the configured PROPAGATION_WINDOW_MS.
  const dflt = fakeDriver([]);
  await policyStore.connectedNodes(dflt, { asOf });
  const expectedDefaultCutoff = new Date(new Date(asOf).getTime() - policyStore.PROPAGATION_WINDOW_MS).toISOString();
  eq(dflt.calls[0].params[0], expectedDefaultCutoff, 'with no window given, the default PROPAGATION_WINDOW_MS is used');

  // ------------------------------------------------------------------ 2. the partition
  console.log('\nclassifyPropagation splits at the target version');
  const nodes = [
    { nodeId: 'behind', replicaVersion: 4 },
    { nodeId: 'exact', replicaVersion: 9 },
    { nodeId: 'ahead', replicaVersion: 12 },
  ];
  const part = policyStore.classifyPropagation(nodes, 9);
  eq(part.pending, ['behind'], 'a node below the target is pending — the pull still has to reach it');
  eq(part.current.sort(), ['ahead', 'exact'], 'a node at OR past the target already has it');
  eq(policyStore.classifyPropagation([], 9), { current: [], pending: [] }, 'an empty connected set partitions to two empty sets');

  // ------------------------------------------------------------------ propagateToConnected shape
  console.log('\npropagateToConnected reports the connected set against the target');
  const both = fakeDriver([
    { nodeId: 'has_it', replicaVersion: 10, lastPulledAt: asOf },
    { nodeId: 'needs_it', replicaVersion: 8, lastPulledAt: asOf },
  ]);
  const report = await policyStore.propagateToConnected(both, 10, { windowMs, asOf });
  eq(report.targetVersion, 10, 'the report names the version being propagated');
  eq(report.connected, 2, 'and how many nodes were connected inside the window');
  eq(report.pending, ['needs_it'], 'the ones the grant is newly reaching');
  eq(report.current, ['has_it'], 'and the ones already at the version');

  console.log(`\n[propagation-test] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[propagation-test] threw:', err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { main };
