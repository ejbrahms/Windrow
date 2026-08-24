'use strict';

// INGEST DATA RESILIENCE, AT CENTRAL — docs/design/ingest-data-resilience.md, against a real
// Postgres. Run it with: npm run smoke:dead-letter --prefix server
//
// The property under test is the one that fails SILENTLY without a database: a packet central
// cannot store used to be counted, acked by the node, and dropped — gone from both ends with no
// durable trace. Every assertion here is that hole staying closed:
//
//   - a malformed NDJSON line is quarantined verbatim, not lost, and the good events beside it land
//   - a rejected event (no id) is quarantined with its reason and its raw payload
//   - a redelivered bad packet bumps `occurrences`, it does not multiply rows        (idempotent DLQ)
//   - the batch trace id is stamped on the row and returned in the result            (traceability)
//   - a NODE_IDENTITY_MISMATCH is NOT dead-lettered — a forgery signal stays loud    (the carve-out)
//   - replay of a recoverable packet stores it and marks the row `replayed`          (recovery)
//   - replay of a structurally-broken packet leaves it quarantined, reason recorded  (no false success)
//   - discard is a marker, not a delete                                              (history survives)
//
// SKIPS, LOUDLY, when no central database is configured — the same contract ./smoke.js keeps.

const store = require('./store');
const queries = require('./queries');
const { assertSafeToTruncate } = require('./smokeGuard');
const { centralDbConfig } = require('./pgDriver');

let checks = 0;
let failures = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}
const eq = (actual, expected, label) => ok(String(actual) === String(expected), label, `expected ${expected}, got ${actual}`);

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
    nodeId: overrides.nodeId || 'node-dl',
    seq: overrides.seq ?? 1,
    hash: overrides.hash ?? 'hash-1',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function reset(driver) {
  const DOOMED = ['usage_events', 'usage_shipments', 'nodes', 'ingest_dead_letter'];
  await assertSafeToTruncate(driver, DOOMED, { label: 'smoke:dead-letter' });
  await driver.exec(`TRUNCATE ${DOOMED.join(', ')}`);
}

async function main() {
  if (!centralDbConfig()) {
    console.log('[smoke:dead-letter] SKIPPED — no central database configured.');
    console.log('  Set WINDROW_CENTRAL_DB_URL and re-run. Nothing about ingest resilience was exercised.');
    console.log('  A scratch one: docker compose -f server/central/docker-compose.yml up -d');
    return 0;
  }

  console.log('[smoke:dead-letter] opening and migrating…');
  const driver = await store.open();
  await reset(driver);

  // --- a malformed line does not cost the good events their delivery -------------------------
  console.log('\nquarantine (malformed transport)');
  const good = usageEvent({ id: 'evt-good-1', seq: 1 });
  const body = [envelope('node-dl', 1, good), '{ this is not json', ''].join('\n');
  let r = await store.ingestBatch(body, { authenticatedNodeId: 'node-dl', traceId: 'trace-A' });
  eq(r.accepted, 1, 'the good event beside a malformed line is still stored');
  eq(r.deadLettered, 1, 'the malformed line is quarantined, not dropped');
  eq(r.traceId, 'trace-A', 'the batch trace id is echoed on the result');

  let dl = await queries.deadLetters(driver, {});
  eq(dl.rows.length, 1, 'the quarantined line is a row in the dead-letter table');
  eq(dl.rows[0].kind, 'malformed_line', 'it is recorded as a malformed line');
  eq(dl.rows[0].traceId, 'trace-A', 'the trace id is stamped on the row (traceability)');
  ok(dl.rows[0].payload.includes('not json'), 'the raw payload is kept verbatim, so it can be inspected', dl.rows[0].payload);
  eq(dl.byStatus.quarantined, 1, 'byStatus counts the quarantined row');

  // --- a rejected event (no id) is quarantined with its reason -------------------------------
  console.log('\nquarantine (rejected event)');
  const noId = usageEvent({ seq: 2 });
  delete noId.id;
  r = await store.ingestBatch(envelope('node-dl', 2, noId), { authenticatedNodeId: 'node-dl', traceId: 'trace-B' });
  eq(r.accepted, 0, 'an event with no id is not stored');
  eq(r.deadLettered, 1, 'an event with no id is quarantined');
  dl = await queries.deadLetters(driver, { traceId: 'trace-B' });
  eq(dl.rows.length, 1, 'the by-trace filter finds exactly this batch\'s packet');
  eq(dl.rows[0].kind, 'rejected_event', 'it is recorded as a rejected event');
  ok(/no id/.test(dl.rows[0].reason), 'the reason names the missing id', dl.rows[0].reason);

  // --- a minted trace id when the caller sends none -----------------------------------------
  r = await store.ingestBatch('{ garbage', { authenticatedNodeId: 'node-dl' });
  ok(/^ctr_/.test(r.traceId), 'central mints a ctr_-prefixed trace id when none is sent', r.traceId);

  // --- idempotency: the same bad packet twice is one row, occurrences bumped -----------------
  console.log('\nidempotent quarantine (a lost ack redelivers the bad packet)');
  const dup = ['{ dup garbage'].join('\n');
  await store.ingestBatch(dup, { authenticatedNodeId: 'node-dl', traceId: 'trace-C' });
  await store.ingestBatch(dup, { authenticatedNodeId: 'node-dl', traceId: 'trace-C2' });
  const dupId = store.deadLetterId('node-dl', 'malformed_line', '{ dup garbage');
  const dupRow = await driver.get('SELECT * FROM ingest_dead_letter WHERE "id" = $1', [dupId]);
  eq(dupRow.occurrences, 2, 'a redelivered bad packet bumps occurrences rather than adding a row');
  eq(dupRow.traceId, 'trace-C', 'the FIRST trace id is kept — the sighting worth tracing back to');

  // --- the carve-out: a forgery is refused whole and NOT quarantined -------------------------
  console.log('\nidentity mismatch is refused, not quarantined');
  await reset(driver);
  let threw = null;
  try {
    await store.ingestBatch(envelope('node-impostor', 1, usageEvent({ id: 'evt-x', nodeId: 'node-impostor' })), {
      authenticatedNodeId: 'node-real',
    });
  } catch (err) { threw = err; }
  eq(threw && threw.code, 'NODE_IDENTITY_MISMATCH', 'a batch claiming another node is refused whole');
  const afterMismatch = await driver.get('SELECT COUNT(*)::int AS n FROM ingest_dead_letter');
  eq(afterMismatch.n, 0, 'a forgery is NOT dead-lettered — it stays on the node to be retried, and stays loud');

  // --- replay recovers a packet whose failure was transient ---------------------------------
  console.log('\nreplay (recovery)');
  await reset(driver);
  // Simulate a packet that WAS quarantined (say, a since-fixed central bug) but is actually
  // storable: insert a valid envelope straight into the dead-letter table, then replay it.
  const recoverable = usageEvent({ id: 'evt-recover', seq: 5, nodeId: 'node-dl' });
  const recoverPayload = envelope('node-dl', 5, recoverable);
  const recoverId = store.deadLetterId('node-dl', 'rejected_event', recoverPayload);
  await driver.query(
    `INSERT INTO ingest_dead_letter ("id","nodeId","traceId","kind","reason","payload","firstSeenAt","lastSeenAt","occurrences","status")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,'quarantined')`,
    [recoverId, 'node-dl', 'trace-R', 'rejected_event', 'simulated transient failure', recoverPayload, new Date().toISOString()]
  );
  let rep = await store.replayDeadLetters(driver, { ids: [recoverId] });
  eq(rep.replayed, 1, 'a recoverable packet is replayed');
  const stored = await driver.get('SELECT COUNT(*)::int AS n FROM usage_events WHERE "id" = $1', ['evt-recover']);
  eq(stored.n, 1, 'the replayed packet is now in usage_events');
  const replayedRow = await driver.get('SELECT status, "replayedAt" FROM ingest_dead_letter WHERE "id" = $1', [recoverId]);
  eq(replayedRow.status, 'replayed', 'the dead-letter row is marked replayed');
  ok(replayedRow.replayedAt, 'the replay time is recorded');

  // --- replay of a structurally-broken packet is honest, not a false success ----------------
  const brokenId = store.deadLetterId('node-dl', 'malformed_line', '{ permanently broken');
  await driver.query(
    `INSERT INTO ingest_dead_letter ("id","nodeId","traceId","kind","reason","payload","firstSeenAt","lastSeenAt","occurrences","status")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,'quarantined')`,
    [brokenId, 'node-dl', 'trace-X', 'malformed_line', 'line 1: bad', '{ permanently broken', new Date().toISOString()]
  );
  rep = await store.replayDeadLetters(driver, { ids: [brokenId] });
  eq(rep.stillFailing, 1, 'a structurally-broken packet does not replay');
  const brokenRow = await driver.get('SELECT status, "replayResult" FROM ingest_dead_letter WHERE "id" = $1', [brokenId]);
  eq(brokenRow.status, 'quarantined', 'a failed replay leaves the packet quarantined, not lost');
  ok(/still unstorable/.test(brokenRow.replayResult), 'the failed replay records why', brokenRow.replayResult);

  // --- discard is a marker, not a delete ----------------------------------------------------
  console.log('\ndiscard');
  const disc = await store.discardDeadLetters(driver, { ids: [brokenId] });
  eq(disc.discarded, 1, 'the packet is discarded');
  const discRow = await driver.get('SELECT status FROM ingest_dead_letter WHERE "id" = $1', [brokenId]);
  eq(discRow.status, 'discarded', 'discard marks the row rather than deleting it — the record survives');

  await store.close();

  console.log(`\n[smoke:dead-letter] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[smoke:dead-letter] crashed:', err.stack || err.message);
    process.exit(1);
  });
