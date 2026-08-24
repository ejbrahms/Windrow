'use strict';

// DISPOSABLE NODES, AT CENTRAL — docs/design/disposable-nodes.md §5 and §6, against a real Postgres.
// Run it with: npm run smoke:disposable --prefix server
//
// Three things land at central in that design, and all three are the kind that look right in a unit
// test and are wrong against a database: a JSONB column that never gets written, an ON CONFLICT
// clause that clears a field it should keep, an idempotency key that is not one.
//
//   §5  LOCAL DIVERGENCE. The pause and the lease reaching the roster, and the fault journal — "the
//       only record that a node stopped enforcing", and until now the only copy — reaching a table.
//       The subtle assertion is the CLEARING one: a report with no pause must wipe the columns, or a
//       pause that lapsed half an hour ago sits on the fleet view forever and the signal becomes
//       noise. A report that carries no divergence block at ALL must do the opposite and leave them
//       alone, because that is an older node and erasing its history would be a downgrade.
//
//   §5  NODE PROFILES. A class label with a ceiling on it, and the fact that a profile's config
//       reaches the right node's policy response and nobody else's.
//
//   §6  nodeConfig ON THE POLICY RESPONSE. Beside the deny-list, on the same channel, and — the
//       assertion that matters — ABSENT rather than defaulted for a parameter central has no
//       opinion about, because ../policy/nodeConfig.js reads absent as "the node's own setting
//       stands" and a value as a ceiling.
//
// SKIPS, LOUDLY, when no central database is configured — the same contract ./smoke.js keeps.

const store = require('./store');
const policyStore = require('./policyStore');
const queries = require('./queries');
const { assertSafeToTruncate } = require('./smokeGuard');
const { centralDbConfig } = require('./pgDriver');
const { resolveNodeConfig } = require('../policy/nodeConfig');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`     ${detail}`);
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const NODE = 'node-smoke-disposable';
const OTHER = 'node-smoke-other';

function journalEntry(id, extra = {}) {
  return {
    id,
    ts: new Date().toISOString(),
    fault: null,
    denialKind: 'policy',
    tier: 'mutating',
    capability: 'mcp_tool/deploy',
    principalId: 'prin_smoke',
    outcome: 'allow',
    why: 'enforcement-pause',
    ...extra,
  };
}

async function main() {
  if (!centralDbConfig()) {
    console.log(
      '[smoke:disposable] SKIPPED — no central database configured.\n'
        + '  Set WINDROW_CENTRAL_DB_URL and re-run. Nothing about §5 or §6 was exercised.'
    );
    return 0;
  }

  const driver = await store.open();
  // `nodes` is deliberately NOT in the truncate list, and the two rows this suite creates are
  // deleted by name instead. Every other central smoke populates that table, so truncating it would
  // make this suite's result depend on the order the sweep happened to run in — and would trip
  // ./smokeGuard.js on any database where one of them ran first, which reads as a failure of the
  // thing under test rather than of the harness.
  const DOOMED = ['node_fault_journal', 'node_profiles'];
  await assertSafeToTruncate(driver, DOOMED, { label: 'smoke:disposable' });
  await driver.exec(`TRUNCATE ${DOOMED.join(', ')}`);
  await driver.query('DELETE FROM nodes WHERE "nodeId" = ANY($1)', [[NODE, OTHER]]);

  // -------------------------------------------------------------- §5 divergence on the roster
  console.log('\n§5 — the two levers a node holds, arriving where central can see them');

  const until = new Date(Date.now() + 20 * 60_000).toISOString();
  await store.ingestNodeHealth({
    nodeId: NODE,
    reportedAt: new Date().toISOString(),
    hooks: { status: 'installed', installedCount: 1, installableCount: 1 },
    divergence: {
      enforcing: false,
      pause: { id: 'pz1', issuedAt: new Date().toISOString(), until, tolerate: ['read_only', 'mutating'], reason: 'debugging', issuedBy: 'admin' },
      lease: null,
    },
    credential: { state: 'expiring', notAfter: new Date(Date.now() + 5 * 86_400_000).toISOString(), expiresInDays: 5 },
    journal: { entries: [journalEntry('j1', { pauseId: 'pz1' }), journalEntry('j2', { pauseId: 'pz1' })], fromByte: 0, throughByte: 512 },
  }, { authenticatedNodeId: NODE });

  let row = await driver.get('SELECT * FROM nodes WHERE "nodeId" = $1', [NODE]);
  eq(row.enforcing, false, 'a paused node reads as NOT enforcing on the roster');
  eq(row.pauseId, 'pz1', 'the pause id is recorded, so the journal can be filtered by it');
  eq(row.pauseTiers, 'read_only,mutating', 'and which tiers it suppresses');
  eq(row.credentialState, 'expiring', '§2.2 — a credential about to run out is reported before it does');
  eq(Number(row.journalEntries), 2, 'the fault journal entries were taken');
  eq(Number(row.journalBytes), 512, 'and the roster records how far into the journal central has read');

  // The idempotency claim: a node that lost its cursor re-ships from zero and nothing duplicates.
  const again = await store.ingestNodeHealth({
    nodeId: NODE,
    hooks: {},
    journal: { entries: [journalEntry('j1', { pauseId: 'pz1' }), journalEntry('j3', { pauseId: 'pz1' })], fromByte: 0, throughByte: 700 },
  }, { authenticatedNodeId: NODE });
  eq(again.journalAccepted, 1, 'a re-shipped journal line is deduplicated on its content hash');
  const total = await driver.get('SELECT COUNT(*)::int AS n FROM node_fault_journal WHERE "nodeId" = $1', [NODE]);
  eq(total.n, 3, 'so a cursor lost to a rebuild costs a re-ship, not a duplicate');

  // The clearing assertion. This is the one that goes wrong quietly.
  await store.ingestNodeHealth({
    nodeId: NODE,
    hooks: {},
    divergence: { enforcing: true, pause: null, lease: null },
  }, { authenticatedNodeId: NODE });
  row = await driver.get('SELECT * FROM nodes WHERE "nodeId" = $1', [NODE]);
  eq(row.pauseId, null, 'a report with NO pause clears the columns rather than leaving a lapsed one on the fleet view');
  eq(row.enforcing, true, 'and the node reads as enforcing again');

  // ...and the opposite, for a node that predates the block entirely.
  await store.ingestNodeHealth({
    nodeId: NODE, hooks: {},
    divergence: { enforcing: false, pause: { id: 'pz2', until, tolerate: ['read_only'] }, lease: null },
  }, { authenticatedNodeId: NODE });
  await store.ingestNodeHealth({ nodeId: NODE, hooks: { status: 'installed' } }, { authenticatedNodeId: NODE });
  row = await driver.get('SELECT * FROM nodes WHERE "nodeId" = $1', [NODE]);
  eq(row.pauseId, 'pz2', 'a report that carries no divergence block at all leaves what is known standing');

  // -------------------------------------------------------------- the fleet queries
  console.log('\nthe short list an operator actually reads');
  const divergence = await queries.fleetDivergence(driver);
  const listed = divergence.nodes.find((n) => n.nodeId === NODE);
  ok(Boolean(listed), 'a diverging node is on the list');
  ok(listed.reasons.includes('enforcement-paused'), 'and says why', listed && listed.reasons);
  eq(Number(listed.suppressedDenials), 3, 'with the count of denials the pause let through');

  const journal = await queries.nodeFaultJournal(driver, NODE, { pauseId: 'pz1' });
  eq(journal.entries.length, 3, 'and one pause id narrows the journal to that window');

  // -------------------------------------------------------------- §6 machine facts
  console.log('\n§6 — the machine-fact tier, reported up');
  await store.ingestNodeHealth({
    nodeId: NODE, hooks: {},
    facts: {
      discoverySources: [{ path: 'C:/skills/custom', label: 'hand-added', enabled: true, builtIn: false, writable: true }],
      everInstalled: { claude: true },
      packagesEnabled: { git: false },
      userHome: 'C:/Users/smoke',
    },
  }, { authenticatedNodeId: NODE });
  const facts = await queries.nodeFacts(driver, NODE);
  eq(facts.facts.discoverySources[0].path, 'C:/skills/custom',
    'a source somebody added by hand — which a rescan does NOT reproduce — is now off the machine');
  eq(facts.facts.everInstalled, { claude: true },
    'and which adapters were ever turned on, so a missing hook does not read as unknown after a rebuild');
  await store.ingestNodeHealth({ nodeId: NODE, hooks: {} }, { authenticatedNodeId: NODE });
  const kept = await queries.nodeFacts(driver, NODE);
  eq(kept.facts.userHome, 'C:/Users/smoke', 'a later report with no facts keeps the last ones rather than erasing them');

  // -------------------------------------------------------------- §5 profiles + §6 nodeConfig
  console.log('\n§5/§6 — a class label with a ceiling, reaching the right node');

  await policyStore.upsertNodeProfile(driver, {
    name: 'laptop',
    description: 'somebody’s own machine',
    config: { maxTier: 'read_only', maxPolicyAgeMs: 5 * 60_000, allowPause: false },
    constraints: { readOnly: true },
  });
  let refused = null;
  try {
    await policyStore.upsertNodeProfile(driver, { name: 'typo', config: { maxTeir: 'read_only' } });
  } catch (err) { refused = err; }
  ok(refused && refused.status === 400, 'a profile naming a parameter that does not exist is REFUSED, not stored', refused && refused.message);

  await store.ingestNodeHealth({ nodeId: OTHER, hooks: {} }, { authenticatedNodeId: OTHER });
  await policyStore.setNodeProfile(driver, NODE, 'laptop');

  const mine = await policyStore.policyDelta(driver, 0, { nodeId: NODE });
  const theirs = await policyStore.policyDelta(driver, 0, { nodeId: OTHER });
  // Compared as a sorted-key object: JSONB does not preserve insertion order and nothing should
  // depend on it — the readers are keyed lookups.
  const sortKeys = (o) => (o ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) : o);
  eq(sortKeys(mine.nodeConfig), sortKeys({ maxTier: 'read_only', maxPolicyAgeMs: 300000, allowPause: false }),
    'the profile rides the policy response, beside the deny-list');
  eq(mine.nodeProfile.constraints, { readOnly: true }, 'and its constraint leg travels with it');
  eq(theirs.nodeConfig, null, 'a node in no profile is told nothing — absent, not defaulted');
  ok(Object.prototype.hasOwnProperty.call(mine, 'denyList'), 'the deny-list still rides every response in full');
  ok(!Object.prototype.hasOwnProperty.call(mine.nodeConfig, 'leaseMaxMs'),
    'a parameter central has no opinion about is ABSENT, so the node’s own setting stands');

  // The whole point, end to end: what the node computes from what central sent.
  const resolved = resolveNodeConfig(mine.nodeConfig, { WINDROW_MAX_POLICY_AGE_MS: String(60 * 60_000) });
  eq(resolved.values.maxPolicyAgeMs, 300000, 'and the node cannot widen it — the env var is a floor, not an override');
  eq(resolved.values.maxTier, 'read_only', 'the tier ceiling arrives intact');
  eq(resolved.values.allowPause, false, 'and central can forbid this machine from pausing enforcement at all');

  // Deleting a profile must not leave a node pointing at nothing.
  await policyStore.deleteNodeProfile(driver, 'laptop');
  const orphaned = await policyStore.policyDelta(driver, 0, { nodeId: NODE });
  eq(orphaned.nodeConfig, null, 'deleting a profile takes its nodes out of it rather than leaving a dangling ceiling');

  await driver.exec(`TRUNCATE ${DOOMED.join(', ')}`);
  await driver.query('DELETE FROM nodes WHERE "nodeId" = ANY($1)', [[NODE, OTHER]]);
  await store.close();
  console.log(`\n[smoke:disposable] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[smoke:disposable] failed:', err.stack || err.message);
  process.exit(1);
});
