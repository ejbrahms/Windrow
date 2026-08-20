'use strict';

// `npm run smoke:central --prefix server` — the verification gate for phase 3.
//
// Needs a real Postgres. Set WINDROW_CENTRAL_DB_URL (or the PG* variables) and point it at a
// scratch database; `server/central/docker-compose.yml` brings one up. With none configured it
// SKIPS rather than fails, and says so — a node developer who has never run central should not
// have a red gate for a dependency they do not have.
//
// EVERY ASSERTION HERE IS A CLAIM MADE SOMEWHERE IN docs/design/global-identity-and-central-db.md,
// and the ones worth naming are the properties that would otherwise fail silently:
//
//   - a redelivered shipment does not double-count           §2.3 at-least-once, idempotent ingest
//   - a correction is NOT mistaken for a redelivery          the reason `kind` is in the ledger key
//   - a row lands in the partition for the month it arrived  §2.5 range-partitioned by month
//   - a field this build has no column for survives          §2.6 unknown -> `extra`
//   - a missing field reads null, never invented             §2.6 missing -> null
//   - a node claiming another node's id is refused whole     §2.5 per-node credentials
//   - central behind by exactly the outbox depth is LAGGING, and behind by more is DIVERGENT
//                                                            §2.7 phase 3, what "compare" means
//   - a hole in the shipment sequence is found and located   the gap the shipper warns it creates

const store = require('./store');
const queries = require('./queries');
const partitions = require('./partitions');
const { centralDbConfig } = require('./pgDriver');

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(String(actual) === String(expected), label, `expected ${expected}, got ${actual}`);
}

/** One envelope as server/store.js's enqueueOutbox renders it. */
function envelope(nodeId, seq, event, kind = 'usage_event') {
  return JSON.stringify({ nodeId, seq, kind, event });
}

function usageEvent(overrides = {}) {
  return {
    id: overrides.id || `evt-${Math.random().toString(16).slice(2)}`,
    principalId: 'principal-1',
    capabilityId: 'cap-1',
    ts: new Date().toISOString(),
    outcome: 'ok',
    latencyMs: 12,
    osUser: 'tester',
    hostname: 'test-host',
    actorAgentType: 'claude',
    actorBackend: 'claude',
    subjectId: 'win-sid:S-1-5-21-test',
    assuranceLevel: 2,
    nodeId: overrides.nodeId || 'node-a',
    seq: overrides.seq ?? 1,
    prevHash: overrides.prevHash ?? null,
    hash: overrides.hash ?? 'hash-1',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Wipe the tables this suite writes, so a re-run against the same scratch database is clean.
 *  Deliberately TRUNCATE rather than DROP: the schema is what is under test, and recreating it
 *  every run would mean the migrator's "already at the latest version" path was never exercised. */
async function reset(driver) {
  await driver.exec('TRUNCATE usage_events, usage_shipments, nodes, shadow_reconciliations');
}

async function main() {
  if (!centralDbConfig()) {
    console.log('[smoke:central] SKIPPED — no central database configured.');
    console.log('  Set WINDROW_CENTRAL_DB_URL, e.g. postgres://windrow:windrow@localhost:5432/windrow_central');
    console.log('  A scratch one: docker compose -f server/central/docker-compose.yml up -d');
    return 0;
  }

  console.log('[smoke:central] opening and migrating…');
  const driver = await store.open();
  await reset(driver);

  // --- the schema is what the design says it is -------------------------------------------
  console.log('\npartitioning (§2.5)');
  const parted = await driver.get(
    "SELECT partstrat FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname = 'usage_events'"
  );
  ok(parted && parted.partstrat === 'r', 'usage_events is RANGE partitioned');
  const key = await driver.get(`
    SELECT pg_get_partkeydef(c.oid) AS def FROM pg_class c WHERE c.relname = 'usage_events'
  `);
  ok(key && /observedAt/.test(key.def), 'the partition key is observedAt (central\'s clock, not the node\'s)', key && key.def);

  const parts = await partitions.listPartitions(driver);
  const monthly = parts.filter((p) => /^usage_events_\d{4}_\d{2}$/.test(p.name));
  ok(monthly.length >= 4, `monthly partitions are created ahead (${monthly.length} present)`);
  ok(parts.some((p) => p.name === partitions.DEFAULT_PARTITION), 'a DEFAULT partition exists as the catch-all');
  eq(await partitions.defaultPartitionRows(driver), 0, 'the default partition is empty');

  // A second maintenance pass must create nothing — it runs hourly forever.
  const again = await partitions.ensurePartitions(driver, { log: () => {} });
  eq(again.length, 0, 'a repeat maintenance pass is a no-op');

  // --- ingest ------------------------------------------------------------------------------
  console.log('\ningest (§2.3, §2.6)');
  const e1 = usageEvent({ id: 'evt-1', seq: 1, hash: 'h1' });
  const e2 = usageEvent({ id: 'evt-2', seq: 2, prevHash: 'h1', hash: 'h2', outcome: 'denied' });
  let r = await store.ingestBatch([envelope('node-a', 1, e1), envelope('node-a', 2, e2)].join('\n'));
  eq(r.accepted, 2, 'a two-event batch is accepted');
  eq(r.duplicates, 0, 'nothing is deduped on a first delivery');

  // At-least-once: the same batch again, which is what a lost ack produces.
  r = await store.ingestBatch([envelope('node-a', 1, e1), envelope('node-a', 2, e2)].join('\n'));
  eq(r.accepted, 0, 'a redelivered batch inserts nothing');
  eq(r.duplicates, 2, 'a redelivered batch is reported as duplicates, not an error');
  const total = await driver.get('SELECT COUNT(*)::int AS n FROM usage_events');
  eq(total.n, 2, 'a redelivery does not double-count');

  // The property the `kind` in the ledger key exists for.
  const corrected = usageEvent({ id: 'evt-2', seq: 2, prevHash: 'h1', hash: 'h2b', outcome: 'approved', correctedAt: new Date().toISOString() });
  r = await store.ingestBatch(envelope('node-a', 3, corrected, 'usage_event_correction'));
  eq(r.corrections, 1, 'a correction of an already-shipped event is applied');
  eq(r.duplicates, 0, 'a correction is NOT mistaken for a redelivery of the row it corrects');
  const fixed = await driver.get('SELECT outcome, "correctedAt" FROM usage_events WHERE "id" = $1', ['evt-2']);
  eq(fixed.outcome, 'approved', 'the corrected outcome is what central now holds');
  ok(fixed.correctedAt, 'correctedAt survived the correction');
  const stillTwo = await driver.get('SELECT COUNT(*)::int AS n FROM usage_events');
  eq(stillTwo.n, 2, 'a correction updates in place rather than adding a row');

  // §2.6, both halves at once: a field this build has no column for, and a field it does have but
  // the node did not send.
  // prevHash is h2b, not h2: the node RE-CHAINS on a correction (server/store.js's patch path), so
  // the event after a corrected one links to the corrected hash. Writing h2 here would stage a
  // genuinely broken chain, and the reconcile assertions below would then be measuring a fixture
  // bug rather than the code.
  const future = usageEvent({ id: 'evt-3', seq: 3, prevHash: 'h2b', hash: 'h3', quantumRiskTier: 'spicy', outcome: undefined, latencyMs: undefined });
  r = await store.ingestBatch(envelope('node-a', 4, future));
  eq(r.accepted, 1, 'an event carrying an unknown field is accepted, not rejected');
  ok(r.unknownFields >= 1, 'the unknown field is counted in the ack, so fleet skew is a number');
  const kept = await driver.get('SELECT extra, outcome, "latencyMs" FROM usage_events WHERE "id" = $1', ['evt-3']);
  ok(kept.extra && JSON.parse(kept.extra).quantumRiskTier === 'spicy', 'the unknown field is stored verbatim in extra');
  ok(kept.outcome === null, 'a field the node did not send reads NULL, never an invented value');
  ok(kept.latencyMs === null, 'a missing latency is NULL, not 0');

  // The clock delta §2.3 says to keep.
  const skewed = usageEvent({ id: 'evt-4', seq: 4, prevHash: 'h3', hash: 'h4', ts: new Date(Date.now() + 3600_000).toISOString() });
  await store.ingestBatch(envelope('node-a', 5, skewed));
  const skewRow = await driver.get('SELECT "clockSkewMs" FROM usage_events WHERE "id" = $1', ['evt-4']);
  ok(Number(skewRow.clockSkewMs) > 3_000_000, 'an hour-ahead node clock is recorded as measured skew', skewRow.clockSkewMs);

  // The node's own observedAt is kept as shipped — it is inside the node's hash chain, so
  // overwriting it with central's arrival time would break every re-verification.
  // The node's observedAt is fixed well in the past, so "kept verbatim" and "central assigned its
  // own" are two distinguishable facts rather than two clocks that happened to agree to the
  // millisecond. This matters because the node's value is inside the node's hash chain: central
  // overwriting it with the arrival time would fail every later re-verification of that chain.
  const NODE_SAW_IT = '2020-01-02T03:04:05.000Z';
  await store.ingestBatch(envelope('node-a', 6, usageEvent({
    id: 'evt-5', seq: 5, prevHash: 'h4', hash: 'h5', observedAt: NODE_SAW_IT,
  })));
  const both = await driver.get('SELECT "observedAt", "nodeObservedAt" FROM usage_events WHERE "id" = $1', ['evt-5']);
  eq(both.nodeObservedAt, NODE_SAW_IT, 'the node\'s own observedAt is kept verbatim — it is inside the node\'s hash chain');
  ok(both.observedAt.getTime() > Date.parse(NODE_SAW_IT), 'central\'s observedAt is its own arrival time, not a copy of the node\'s');

  // A row must be in the partition for the month it ARRIVED in.
  const month = partitions.partitionName(partitions.monthStart(new Date()));
  const placed = await driver.get(`SELECT COUNT(*)::int AS n FROM "${month}"`);
  ok(placed.n >= 5, `rows land in this month's partition (${month})`);
  eq(await partitions.defaultPartitionRows(driver), 0, 'nothing fell through to the default partition');

  // --- identity ----------------------------------------------------------------------------
  console.log('\nnode identity (§2.5)');
  let refused = null;
  try {
    await store.ingestBatch(envelope('node-b', 9, usageEvent({ id: 'evt-forged', nodeId: 'node-b' })), {
      authenticatedNodeId: 'node-a',
    });
  } catch (err) {
    refused = err;
  }
  ok(refused && refused.status === 403, 'a batch claiming another node\'s id is refused whole');
  ok(refused && refused.code === 'NODE_IDENTITY_MISMATCH', 'the refusal names the mismatch');
  const forged = await driver.get('SELECT COUNT(*)::int AS n FROM usage_events WHERE "id" = $1', ['evt-forged']);
  eq(forged.n, 0, 'nothing from a refused batch landed');

  // --- the fleet view ----------------------------------------------------------------------
  console.log('\nfleet view (§2.7 — the thing phase 3 ships)');
  const summary = await queries.fleetSummary(driver);
  eq(summary.totals.events, 5, 'the fleet summary counts every event once');
  eq(summary.totals.denied, 0, 'the denied count follows the correction (evt-2 is now approved)');
  eq(summary.totals.outcomeUnrecorded, 1, 'an event with no outcome is counted as unrecorded, not as ok');
  const byBackend = await queries.usageBy(driver, 'actorBackend');
  ok(byBackend.length >= 1, 'usage groups by an actor dimension');
  const roster = await queries.nodeRoster(driver);
  eq(roster.length, 1, 'the node roster has the one node that shipped');
  eq(roster[0].nodeId, 'node-a', 'the roster names it');
  const storage = await queries.storage(driver);
  ok(storage.partitions.length >= 5, 'storage reports per-partition sizes');

  // --- the comparison ----------------------------------------------------------------------
  console.log('\nshadow comparison (§2.7 phase 3 — "compare")');
  const stream = await queries.nodeStream(driver, 'node-a');
  eq(stream.events, 5, 'central knows how many events it holds for the node');
  eq(stream.gaps.length, 0, 'no gaps in a complete stream');

  let verdict = await queries.reconcile(driver, 'node-a', { eventCount: 5, outboxPending: 0, chainSeq: 5 });
  eq(verdict.verdict, 'match', 'node and central agreeing reads as MATCH');

  verdict = await queries.reconcile(driver, 'node-a', { eventCount: 8, outboxPending: 3, chainSeq: 8 });
  eq(verdict.verdict, 'lagging', 'behind by exactly the outbox depth reads as LAGGING, not a fault');

  verdict = await queries.reconcile(driver, 'node-a', { eventCount: 40, outboxPending: 1, chainSeq: 40 });
  eq(verdict.verdict, 'divergent', 'behind by MORE than the queue explains reads as DIVERGENT');

  // A hole in the shipment sequence: what the shipper creates when it trims an over-long outbox.
  await store.ingestBatch(envelope('node-a', 99, usageEvent({ id: 'evt-99', seq: 99, hash: 'h99' })));
  const holed = await queries.nodeStream(driver, 'node-a');
  ok(holed.gaps.length === 1, 'a hole in the shipment sequence is found');
  eq(holed.gaps[0].from, 7, 'the gap is located, not just counted');
  eq(holed.gaps[0].missing, 92, 'and its size is reported');
  verdict = await queries.reconcile(driver, 'node-a', { eventCount: 6, outboxPending: 0 });
  eq(verdict.verdict, 'gap', 'a stream with a hole reads as GAP — the verdict that blocks phase 4');

  const status = await queries.shadowStatus(driver);
  ok(status.latest.length === 1, 'shadow status reports the latest verdict per node');
  ok(status.everyNodeAgrees === false, 'and does not claim agreement while a gap stands');
  ok(status.tally.some((t) => t.verdict === 'match'), 'the verdict history is kept for the phase-4 argument');

  // --- the cross-field rollup, as one query (§2.7 phase 5) ----------------------------------
  //
  // What server/rollup/index.js used to answer by opening every sibling workspace's SQLite file.
  // The properties under test are the ones the scan got wrong or could not do at all: attribution
  // from the EVENT rather than from the file it was read out of, standalone usage broken out,
  // events whose workspace cannot be established reported rather than misfiled, and a scope that
  // can be narrowed to one node for a node-scoped certificate.
  console.log('\ncross-field rollup (§2.7 phase 5)');
  await reset(driver);
  await driver.exec("DELETE FROM principals WHERE id LIKE 'rollup-%'");
  const principal = (id, name, field, standalone, kind = 'instance') => driver.exec(`
    INSERT INTO principals ("id", "kind", "name", "humanName", "backend", "field", "standalone", "createdAt")
    VALUES ('${id}', '${kind}', '${name}', 'Dez', 'claude', ${field ? `'${field}'` : 'NULL'}, ${standalone}, '2026-08-19T00:00:00.000Z')
  `);
  await principal('rollup-a', 'loom-a', 'windrow', false);
  await principal('rollup-b', 'loom-b', 'atlas', false);
  await principal('rollup-solo', 'loom-solo', null, true);
  // A workspace with a registered principal and no calls yet — invisible unless it is seeded from
  // the registry, which is the case that made the scan seed its buckets from principals too.
  await principal('rollup-quiet', 'loom-quiet', 'quiet-field', false);

  let s = 0;
  const rollupEvent = (over) => envelope('node-a', ++s, usageEvent({ id: `roll-${s}`, seq: s, hash: `rh-${s}`, ...over }));
  // Attributed by the event's own actorField.
  await store.ingestBatch(rollupEvent({ principalId: 'rollup-a', actorField: 'windrow' }));
  await store.ingestBatch(rollupEvent({ principalId: 'rollup-a', actorField: 'windrow', outcome: 'denied' }));
  // No actorField: attributed through the principal row, which is the pre-actor-column fallback.
  await store.ingestBatch(rollupEvent({ principalId: 'rollup-b', actorField: null }));
  // Standalone — no workspace by construction, and broken out by backend.
  await store.ingestBatch(rollupEvent({ principalId: 'rollup-solo', actorField: null, actorBackend: 'codex' }));
  // Neither: no actorField and a principal central has never heard of. The scan filed these under
  // whichever directory it read them from; this must not.
  await store.ingestBatch(rollupEvent({ principalId: 'rollup-missing', actorField: null }));
  // A second node, so "the fleet" is more than one machine — the half the scan could never do.
  await store.ingestBatch(envelope('node-b', 1, usageEvent({
    id: 'roll-nb-1', seq: 1, hash: 'rh-nb-1', nodeId: 'node-b', principalId: 'rollup-b', actorField: 'atlas',
  })));

  const roll = await queries.rollup(driver);
  eq(roll.totals.calls, 6, 'every event across both nodes is counted once');
  eq(roll.totals.denied, 1, 'denials come through');
  eq(roll.totals.nodes, 2, 'the rollup spans machines — what the sibling-directory scan could not do');
  eq(roll.totals.unattributedCalls, 1, 'an event with no establishable workspace is REPORTED, not misfiled');
  const windrow = roll.byField.find((f) => f.field === 'windrow');
  const atlas = roll.byField.find((f) => f.field === 'atlas');
  eq(windrow && windrow.calls, 2, "actorField attributes a call to the workspace the hook saw");
  eq(windrow && windrow.denied, 1, 'and denials are per workspace');
  eq(atlas && atlas.calls, 2, 'the principal row is the fallback when the event carries no actorField');
  eq(atlas && atlas.nodes, 2, 'one workspace whose calls came from two nodes is one row, not two');
  ok(
    roll.byField.some((f) => f.field === 'quiet-field' && f.calls === 0 && f.principalCount === 1),
    'a workspace with principals and no calls yet is listed rather than invisible'
  );
  ok(
    !roll.byField.some((f) => f.field === null),
    'the unattributed event does not become a workspace called null'
  );
  eq(roll.standalone.calls, 1, 'standalone usage is broken out');
  eq(roll.standalone.byBackend[0].backend, 'codex', "and by the backend the CALL recorded, not the principal's");
  ok(
    roll.byPrincipal.every((p) => typeof p.principalId === 'string' && p.principalId.length > 0),
    'byPrincipal is keyed on the principal id, never on the display name (§1.1)'
  );
  ok(
    roll.byPrincipal.some((p) => p.principalId === 'rollup-a' && p.name === 'Dez' && p.agentName === 'loom-a'),
    'the nickname rides along as a label beside the agent name — two principals here share it'
  );
  ok(
    roll.byPrincipal.some((p) => p.standalone === true && p.field === null),
    'a standalone principal has no workspace, and says so rather than inventing one'
  );
  eq(roll.totals.duplicatesSkipped, undefined, 'there is no de-duplication pass to report — ingest already did it');

  // A redelivery: the exact thing the scan de-duplicated in JavaScript, absorbed here by the
  // shipment ledger before it can ever become a second row.
  await store.ingestBatch(envelope('node-a', 1, usageEvent({ id: 'roll-1', seq: 1, hash: 'rh-1', principalId: 'rollup-a', actorField: 'windrow' })));
  const afterRedelivery = await queries.rollup(driver);
  eq(afterRedelivery.totals.calls, 6, 'a redelivered shipment does not inflate the rollup');

  // The scoping a node-scoped certificate gets on server/central/routes.js's /api/fleet/rollup.
  const scoped = await queries.rollup(driver, { nodeIds: ['node-b'] });
  eq(scoped.totals.calls, 1, 'a node-scoped rollup sees only that node');
  eq(scoped.totals.nodes, 1, 'and reports the narrower scope in its own totals');
  ok(scoped.scope.nodeIds && scoped.scope.nodeIds[0] === 'node-b', 'the answer states which nodes it covers');

  // The window, which the scan never had. Everything above was ingested seconds ago, so a window
  // that ends before it excludes all of it.
  const windowed = await queries.rollup(driver, { sinceMs: 1000, now: new Date(Date.now() + 3600_000) });
  eq(windowed.totals.calls, 0, 'the window is on observedAt — central\'s clock, the partition key');

  await driver.exec("DELETE FROM principals WHERE id LIKE 'rollup-%'");

  // --- the migrator's own guarantees --------------------------------------------------------
  console.log('\nschema ledger (§2.5)');
  const ledger = await driver.all('SELECT version, name FROM schema_migrations ORDER BY version');
  ok(ledger.length >= 2, `every migration is recorded (${ledger.length})`);
  const rerun = await require('../schema/migrator').migrateAsync({
    driver, migrations: require('./centralMigrations').migrations, label: 'central', log: () => {},
  });
  eq(rerun.applied.length, 0, 'an up-to-date database applies nothing on a second boot');
  let tooNew = null;
  try {
    await require('../schema/migrator').migrateAsync({ driver, migrations: [ledger[0] && { version: 1, name: 'x', up: () => {} }], label: 'central', log: () => {} });
  } catch (err) {
    tooNew = err;
  }
  ok(tooNew && tooNew.name === 'SchemaTooNewError', 'an older build refuses to downgrade a newer database');

  await store.close();

  console.log(`\n[smoke:central] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch(async (err) => {
      console.error('[smoke:central] threw:', err.stack || err.message);
      await store.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { main };
