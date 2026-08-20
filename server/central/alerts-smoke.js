'use strict';
// Central's half of the two-ended alert engine, against a real Postgres
// (docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both ends").
// Run: WINDROW_CENTRAL_DB_URL=postgres://windrow:windrow@localhost:5432/windrow_central \
//        node server/central/alerts-smoke.js
//
// `server/alerts/alerts-test.js` covers the node end and the KEY — the arithmetic that makes both
// ends name one breach the same way — with central standing in as a Map. This file covers what a
// Map cannot: the aggregate SQL, the partitioned scan behind it, and the `ON CONFLICT (key) DO
// NOTHING` that is where "a breach seen from both sides fires once" is actually enforced.
//
// The case it exists for is §2.3's own central example: "this user is on five PCs and the total
// crossed the threshold." That number does not exist on any node, so it is unreachable by any test
// that does not build a fleet.
//
// What it asserts, in order:
//   1. A fleet-scoped rule fires on a total NO SINGLE NODE could reach.
//   2. A node-scoped rule is evaluated centrally too, per node, and each machine is its own alert.
//   3. A second sweep over the same window fires nothing — the primary key holds.
//   4. A node's own alert for a window central already fired lands as a duplicate, and its count is
//      kept in `peerValue` rather than overwriting or being lost.
//   5. A node's alert for a window central has NOT fired is accepted, and central's later
//      re-derivation of it is the duplicate — the dedup is symmetric.
//   6. A node cannot post an alert about another machine.
//   7. Central filters on its own `observedAt`, so a node back-dating `ts` cannot slide a burst out
//      of the window that would have caught it.

const store = require('./store');
const alertEngine = require('./alertEngine');
const rules = require('../alerts/rules');
const { centralDbConfig } = require('./pgDriver');

let failures = 0;
let checks = 0;
function ok(condition, label, detail) {
  checks += 1;
  if (condition) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// A rule list of the test's own, so a retuned shipped threshold does not break this.
const TEST_RULES = [
  {
    id: 'smoke-fleet',
    title: 'fleet denial total',
    scope: 'fleet',
    match: { outcome: 'denied' },
    metric: 'count',
    threshold: 10,
    windowMs: 60 * 60_000,
    strideMs: 60 * 60_000, // tumbling, so one sweep sees one window and the test is deterministic
    cooldownMs: 0, // the cooldown is the node test's subject; here the primary key is
    severity: 'warning',
  },
  {
    id: 'smoke-node',
    title: 'per-machine destructive burst',
    scope: 'node',
    match: { riskTier: 'destructive' },
    metric: 'count',
    threshold: 3,
    windowMs: 60 * 60_000,
    strideMs: 60 * 60_000,
    cooldownMs: 0,
    severity: 'critical',
  },
  {
    id: 'smoke-fanout',
    title: 'one subject on many machines',
    scope: 'fleet',
    match: {},
    metric: 'distinctNodes',
    threshold: 5,
    windowMs: 60 * 60_000,
    strideMs: 60 * 60_000,
    cooldownMs: 0,
    severity: 'warning',
  },
];
const { rules: loaded } = rules.loadRules(TEST_RULES);
const byId = Object.fromEntries(loaded.map((r) => [r.id, r]));

let seq = 0;
function envelope(nodeId, event) {
  seq += 1;
  return JSON.stringify({ nodeId, seq, kind: 'usage_event', event });
}

function usageEvent(overrides) {
  return {
    id: `alrt-${seq + 1}-${Math.round(overrides.n || 0)}`,
    principalId: 'p-smoke',
    capabilityId: 'cap-smoke-read',
    ts: new Date().toISOString(),
    outcome: 'ok',
    subjectId: 'win-sid:S-1-5-21-smoke',
    ...overrides,
  };
}

async function reset(driver) {
  // Only this file's own fixtures, so it can be run against a database ./smoke.js also uses.
  await driver.exec(`DELETE FROM usage_events WHERE "principalId" = 'p-smoke'`);
  await driver.exec(`DELETE FROM alerts WHERE "ruleId" LIKE 'smoke-%'`);
  await driver.exec(`DELETE FROM capabilities WHERE id LIKE 'cap-smoke-%'`);
  await driver.exec(`
    INSERT INTO capabilities (id, kind, name, description, "riskTier", owner, "createdAt")
    VALUES ('cap-smoke-read', 'mcp_tool', 'smoke-read', 'smoke', 'read_only', 'smoke', now()::text),
           ('cap-smoke-destroy', 'mcp_tool', 'smoke-destroy', 'smoke', 'destructive', 'smoke', now()::text)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function main() {
  if (!centralDbConfig()) {
    console.log('[smoke:central-alerts] SKIPPED — no central database configured.');
    console.log('  Set WINDROW_CENTRAL_DB_URL, e.g. postgres://windrow:windrow@localhost:5432/windrow_central');
    console.log('  A scratch one: docker compose -f server/central/docker-compose.yml up -d');
    return 0;
  }
  const driver = await store.open();
  await reset(driver);

  // ------------------------------------------------------------------ the fleet case (§2.3)
  console.log('\nthe number no node can see');
  // Five PCs, two denials each. Ten in the fleet, two on any machine — a threshold of ten is
  // unreachable from every node at once, which is the whole reason central evaluates at all.
  let n = 0;
  for (const nodeId of ['n1', 'n2', 'n3', 'n4', 'n5']) {
    for (let i = 0; i < 2; i += 1) {
      n += 1;
      await store.ingestBatch(envelope(nodeId, usageEvent({ id: `alrt-deny-${n}`, outcome: 'denied', n })));
    }
  }
  let fired = await alertEngine.sweepWith(loaded);
  const fleetAlert = fired.find((a) => a.ruleId === 'smoke-fleet');
  ok(Boolean(fleetAlert), 'a fleet-scoped rule fires on a total no single node reached');
  ok(fleetAlert && fleetAlert.value === 10, 'and it counted the fleet, not one machine', fleetAlert && `value ${fleetAlert.value}`);
  ok(fleetAlert && fleetAlert.scopeId === 'fleet', 'a fleet alert is keyed under the fleet');
  ok(fleetAlert && fleetAlert.nodeId === null, 'and names no node, because no machine owns it');

  const fanout = fired.find((a) => a.ruleId === 'smoke-fanout');
  ok(Boolean(fanout) && fanout.value === 5, 'distinctNodes counts machines, which is only answerable here', fanout && `value ${fanout.value}`);

  // ------------------------------------------------------------------ node rules, centrally
  console.log('\nnode-scoped rules, re-derived centrally as the backstop');
  for (const nodeId of ['n1', 'n2']) {
    for (let i = 0; i < 3; i += 1) {
      n += 1;
      await store.ingestBatch(envelope(nodeId, usageEvent({ id: `alrt-dest-${n}`, capabilityId: 'cap-smoke-destroy', n })));
    }
  }
  fired = await alertEngine.sweepWith(loaded);
  const perNode = fired.filter((a) => a.ruleId === 'smoke-node');
  ok(perNode.length === 2, 'two machines bursting is two alerts, not one', `got ${perNode.length}`);
  ok(
    perNode.every((a) => a.scopeId === a.nodeId && ['n1', 'n2'].includes(a.nodeId)),
    'each is keyed to the machine it happened on — the reason scopeId is in the key'
  );

  // ------------------------------------------------------------------ the dedup, both directions
  console.log('\n"a breach seen from both sides fires once"');
  const again = await alertEngine.sweepWith(loaded);
  ok(again.length === 0, 'a second sweep over the same window fires nothing', `got ${again.length}`);

  // A node reports the breach central already fired. Same key, different count.
  const target = perNode.find((a) => a.nodeId === 'n1');
  const posted = await alertEngine.ingestNodeAlerts(
    { alerts: [{ ...target, value: target.value + 2, firedBy: 'node', firedAt: new Date().toISOString() }] },
    { authenticatedNodeId: 'n1' }
  );
  ok(posted.duplicates === 1 && posted.accepted === 0, 'the node\'s copy of a breach central already fired is a duplicate');
  const row = await driver.get('SELECT * FROM alerts WHERE key = $1', [target.key]);
  ok(row && row.firedBy === 'central', 'the first observation is kept');
  ok(row && Number(row.value) === target.value, 'and its count is not overwritten');
  ok(row && Number(row.peerValue) === target.value + 2, 'the node\'s disagreeing count is recorded in peerValue', row && `peerValue ${row.peerValue}`);
  ok(row && row.peerFiredBy === 'node', 'attributed to the end that reported it');

  // The other direction: a node fires a window central has not evaluated, then central catches up.
  const window = rules.windowFor(byId['smoke-node'], Date.now());
  const nodeFirst = rules.buildAlert({
    rule: byId['smoke-node'],
    scopeId: 'n9',
    subjectId: 'win-sid:S-1-5-21-smoke',
    value: 7,
    windowStartMs: window.windowStart,
    firedBy: rules.FIRED_BY_NODE,
    nodeId: 'n9',
    firedAt: new Date().toISOString(),
    detail: { unshippedInWindow: 7 },
  });
  const first = await alertEngine.ingestNodeAlerts({ alerts: [nodeFirst] }, { authenticatedNodeId: 'n9' });
  ok(first.accepted === 1, 'a window central has not evaluated is accepted from the node');
  const second = await alertEngine.upsertAlert({ ...nodeFirst, firedBy: rules.FIRED_BY_CENTRAL, value: 7 });
  ok(second.inserted === false, 'and central re-deriving it later is the duplicate — the dedup is symmetric');

  // ------------------------------------------------------------------ forgery
  console.log('\na node may only speak for itself');
  const forged = await alertEngine.ingestNodeAlerts(
    { alerts: [{ ...nodeFirst, scopeId: 'n1', nodeId: 'n1', key: 'anything' }] },
    { authenticatedNodeId: 'n9' }
  );
  ok(forged.rejected.length === 1 && forged.accepted === 0, 'an alert about another machine is refused');
  ok(/may only fire alerts about itself/.test(forged.rejected[0].reason), 'and says why');

  // ------------------------------------------------------------------ the clock
  console.log('\ntrust node clocks for nothing (§2.3)');
  await driver.exec(`DELETE FROM alerts WHERE "ruleId" LIKE 'smoke-%'`);
  // Ten more denials, every one of them claiming to have happened in 1999. `observedAt` is assigned
  // at ingest, so they are inside the window whatever `ts` says — a node that could back-date its
  // way out of a rule could silence every alert about itself.
  for (let i = 0; i < 10; i += 1) {
    n += 1;
    await store.ingestBatch(envelope('n7', usageEvent({ id: `alrt-old-${n}`, outcome: 'denied', ts: '1999-01-01T00:00:00.000Z', n })));
  }
  fired = await alertEngine.sweepWith(loaded);
  ok(
    fired.some((a) => a.ruleId === 'smoke-fleet'),
    'back-dated events are still counted — the window is on central\'s observedAt, not the node\'s ts'
  );

  await reset(driver);
  await store.close();
  console.log(`\n[smoke:central-alerts] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch(async (err) => {
    console.error('[smoke:central-alerts] failed:', err.stack || err.message);
    await store.close().catch(() => {});
    process.exitCode = 1;
  });
