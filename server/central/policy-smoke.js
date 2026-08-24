'use strict';

// CENTRAL AS THE POLICY AUTHORITY — the phase-4 half of ./smoke.js, against a real Postgres.
// Run it with: npm run smoke:central-policy --prefix server
//
// SKIPS, LOUDLY, when no central database is configured — the same contract ./smoke.js keeps. A
// developer with no Postgres must be able to run the whole suite and see this reported as "not
// exercised" rather than as a pass, because the alternative is a green run that proves nothing about
// the half of phase 4 that decides what a grant means.
//
// WHAT IS ASSERTED, and why each one is a way phase 4 could look right and be wrong:
//
//   1. IDS ARE CENTRAL'S. Registering the same (kind, name) from two different "nodes" yields ONE
//      row and ONE id. If it did not, two machines would hold two capability rows for one tool and a
//      grant against either would be invisible to the other — the exact condition a fleet registry
//      exists to remove, arriving silently.
//   2. THE CHANGE LOG COVERS EVERY MUTATOR. A row written without its change row is a row no node
//      ever learns about — invisible rather than broken, so it is asserted per mutator.
//   3. THE PAYLOAD IS THE ONE THE NODE ALREADY APPLIES. Central's delta is fed through the node's
//      own server/policy/replica.js applyDelta, unmodified. That is the whole claim of phase 4 being
//      a change of *which machine answers* rather than a rewrite of the client, and it is the check
//      that would catch a field renamed on one side.
//   4. A REVOKE RIDES THE DENY-LIST WITH NO VERSION DEPENDENCY. §2.4's promise, asserted where it is
//      produced: the revoked pair appears on a deny-list computed from a `since` that has nothing to
//      do with it.
//   5. A NODE TOO FAR BEHIND IS RESET, NOT PATCHED. Serving deltas from a floor a node predates
//      leaves a hole no later pull can close.
//   6. DISCOVERY CANNOT ESCALATE. A node re-reporting an existing capability with a higher tier does
//      not retier it — otherwise "what may this tool do" is decided by whichever machine rescanned
//      its filesystem most recently.

const store = require('./store');
const { assertSafeToTruncate } = require('./smokeGuard');
const policyStore = require('./policyStore');
const { centralDbConfig } = require('./pgDriver');
const replica = require('../policy/replica');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`     ${detail}`);
}
const eq = (a, b, label) => ok(a === b, label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function main() {
  if (!centralDbConfig()) {
    console.log(
      '[smoke:central-policy] SKIPPED — no central database configured.\n'
        + '  Set WINDROW_CENTRAL_DB_URL (or the PG* variables) and re-run. `docker compose -f '
        + 'server/central/docker-compose.yml up -d` brings one up.\n'
        + '  Nothing about phase 4’s central half was exercised by this run.'
    );
    return 0;
  }

  const driver = await store.open();
  // A clean slate, and CASCADE-free: these tables have no foreign keys between them by design (the
  // ids are minted here but the rows are written by different requests), so the order is only about
  // reading the output of a failed run.
  // LOOK BEFORE DESTROYING — see ./smokeGuard.js. This line ran against a live central on
  // 2026-08-22 and took the fleet's whole control plane with it; the guard refuses when the target
  // holds rows, because "is this scratch or production" is not answerable from the database name.
  const DOOMED = ['policy_changes', 'grants', 'approvals', 'capabilities', 'principals',
    'windrow_audit', 'node_policy_state'];
  await assertSafeToTruncate(driver, DOOMED, { label: 'smoke:central-policy' });
  await driver.exec(`TRUNCATE ${DOOMED.join(', ')}`);

  // ------------------------------------------------------------------ 1. central mints the id
  console.log('\ncentral owns the row and its id (§2.2)');
  const first = await policyStore.resolveCapability(driver, { kind: 'mcp_tool', name: 'slack/post', riskTier: 'mutating' });
  const second = await policyStore.resolveCapability(driver, { kind: 'mcp_tool', name: 'slack/post', riskTier: 'mutating' });
  ok(first.created && !second.created, 'the first node to report a tool creates it; the second does not');
  eq(second.capability.id, first.capability.id, 'both nodes are handed the same capability id');
  ok(/^cap_[0-9a-f]{12}$/.test(first.capability.id), 'and it is a central-minted id in the contract’s shape', first.capability.id);

  // 6. Discovery proposes; it does not decide.
  const escalated = await policyStore.resolveCapability(driver, { kind: 'mcp_tool', name: 'slack/post', riskTier: 'destructive' });
  eq(escalated.capability.riskTier, 'mutating', 'a node re-reporting a known tool cannot retier it');
  const untiered = await policyStore.resolveCapability(driver, { kind: 'mcp_tool', name: 'unknown/tool' });
  eq(untiered.capability.riskTier, 'read_only', 'a discovered tool with no stated tier lands at the LEAST it could be');

  // ------------------------------------------------------------------ 2. every mutator logs
  console.log('\nevery policy mutation appends to the log (§2.4)');
  const role = await policyStore.insertPrincipal(driver, { kind: 'role', name: 'tester', status: 'pending' });
  const mutators = [
    ['setCapabilityAutoGrant', () => policyStore.setCapabilityAutoGrant(driver, first.capability.id, true)],
    ['updatePrincipal', () => policyStore.updatePrincipal(driver, role.id, { status: 'active' })],
    ['insertGrant', () => policyStore.insertGrant(driver, { principalId: role.id, capabilityId: first.capability.id })],
  ];
  for (const [name, run] of mutators) {
    const before = await policyStore.policyVersion(driver);
    // eslint-disable-next-line no-await-in-loop
    await run();
    // eslint-disable-next-line no-await-in-loop
    const after = await policyStore.policyVersion(driver);
    ok(after > before, `${name}() advanced the policy version`, `${before} -> ${after}`);
  }

  // ------------------------------------------------------------------ 3. the node applies it unmodified
  console.log('\ncentral’s delta is the payload the node already knows how to apply (§2.6)');
  const fromZero = await policyStore.policyDelta(driver, 0);
  const applied = replica.applyDelta(replica.emptyReplica(), fromZero);
  ok(applied.ok, 'server/policy/replica.js applies central’s delta with no translation', applied.reason);
  if (applied.ok) {
    eq(applied.replica.version, fromZero.version, 'and lands on central’s version');
    eq(Object.keys(applied.replica.capabilities).length, 2, 'with every capability central holds');
    ok(
      applied.replica.grants[Object.keys(applied.replica.grants)[0]].capabilityId === first.capability.id,
      'and the grant pointing at central’s capability id, not a locally-minted one'
    );
  }

  // ------------------------------------------------------------------ 4. revocation, with no version dependency
  console.log('\nrevocation rides the always-full deny-list (§2.4)');
  const live = await policyStore.findGrant(driver, role.id, first.capability.id);
  await policyStore.revokeGrant(driver, live.id, 'smoke');
  const head = await policyStore.policyVersion(driver);
  // Asked with `since` at the HEAD, i.e. a no-op poll that carries no changes at all. The deny-list
  // must still be complete — that is precisely the case a node with a broken delta stream is in.
  const noop = await policyStore.policyDelta(driver, head);
  eq(noop.changes.length, 0, 'a poll at the head returns no changes');
  ok(noop.denyList.grantIds.includes(live.id), 'and the deny-list still names the revoked grant');
  ok(
    noop.denyList.pairs.includes(`${role.id}:${first.capability.id}`),
    'by pair as well as by id, so a node that never saw the grant can still recognise it'
  );
  const blocked = await policyStore.insertPrincipal(driver, { kind: 'role', name: 'rejected', status: 'denied' });
  const withBlocked = await policyStore.policyDelta(driver, head);
  ok(withBlocked.denyList.principals.includes(blocked.id), 'a non-active principal is on the deny-list too');

  // ------------------------------------------------------------------ 5. reset rather than a hole
  console.log('\na node too far behind is reset, not patched');
  const ahead = await policyStore.policyDelta(driver, (await policyStore.policyVersion(driver)) + 500);
  ok(ahead.reset === true, 'a node claiming a version ahead of central is reset (a restored backup, or a different central)');
  ok(Array.isArray(ahead.snapshot.capabilities) && ahead.snapshot.capabilities.length === 2, 'and handed a full snapshot');
  const resetApplied = replica.applyDelta({ ...replica.emptyReplica(), version: 9999 }, ahead);
  ok(resetApplied.ok && resetApplied.reset, 'which the node applies as a replacement rather than a merge');

  // ------------------------------------------------------------------ who is behind
  console.log('\nfleet policy state');
  await policyStore.noteNodePull(driver, 'node_a', { replicaVersion: 2, schemaVersion: 1, reset: false });
  await policyStore.noteNodePull(driver, 'node_a', { replicaVersion: 1, schemaVersion: 1, reset: false });
  const state = await policyStore.nodePolicyState(driver);
  const a = state.nodes.find((x) => x.nodeId === 'node_a');
  eq(a.replicaVersion, 2, 'a node’s recorded replica version never goes backwards on a re-pull');
  ok(a.behindBy > 0, 'and "behind by" is measured against central’s own head', JSON.stringify(a));

  // ------------------------------------------------------------------ auto-grant propagation
  console.log('\nauto-grant propagation reaches the nodes connected inside the window');
  // A node that pulled just now is connected; one that pulled well before the window opened is not.
  // The pull timestamp is central's own now(), so the "stale" node is aged by writing it directly.
  await policyStore.noteNodePull(driver, 'connected_node', { replicaVersion: 1, schemaVersion: 1, reset: false });
  await policyStore.noteNodePull(driver, 'stale_node', { replicaVersion: 1, schemaVersion: 1, reset: false });
  await driver.query(
    `UPDATE node_policy_state SET "lastPulledAt" = now() - ($1::bigint * interval '1 millisecond') WHERE "nodeId" = 'stale_node'`,
    [policyStore.PROPAGATION_WINDOW_MS + 60_000]
  );
  const connected = await policyStore.connectedNodes(driver);
  ok(connected.some((n) => n.nodeId === 'connected_node'), 'a node that just pulled is connected');
  ok(!connected.some((n) => n.nodeId === 'stale_node'), 'a node silent past the window is not — it catches up on its next pull');

  const propHead = await policyStore.policyVersion(driver);
  const report = await policyStore.propagateToConnected(driver, propHead);
  ok(report.pending.includes('connected_node'), 'the connected node behind the head is a propagation target', JSON.stringify(report));
  ok(!report.pending.includes('stale_node') && !report.current.includes('stale_node'), 'the stale node is absent from the propagation entirely');

  // The path a package actually drives: syncing one returns the propagation set alongside its counts.
  const pkgSync = await require('./packages').syncPackage(driver, 'claude', { actorScope: 'smoke' });
  ok(pkgSync && 'propagation' in pkgSync, 'syncPackage returns a propagation field', JSON.stringify(pkgSync));
  const propShaped = pkgSync.granted > 0
    ? pkgSync.propagation && Array.isArray(pkgSync.propagation.pending) && Array.isArray(pkgSync.propagation.current)
    : pkgSync.propagation === null;
  ok(propShaped, 'it is a report with pending/current when grants were issued, and null when none were', JSON.stringify(pkgSync));

  await store.close();
  console.log(`\n[smoke:central-policy] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch(async (err) => {
      console.error('[smoke:central-policy] threw:', err.stack || err.message);
      await store.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { main };
