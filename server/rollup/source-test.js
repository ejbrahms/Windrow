// Verification for the rollup's source seam — docs/design/global-identity-and-central-db.md §2.7
// phase 5. Run it with: node server/rollup/source-test.js  (npm run test:rollup --prefix server)
//
// Nothing here needs a network, a central or Postgres. What is under test is the NODE half: which
// source a given configuration picks, what a failure means in each mode, and whether central's
// payload comes back in the shape every existing reader was written against. The central half — the
// SQL itself — is asserted against a real Postgres in ../central/smoke.js, which skips when none is
// configured; this file must not skip, because it is the half that runs on every user's PC.
//
// FIVE PROPERTIES, each one a way phase 5 could look correct and not be:
//
//   1. THE DEFAULT IS UNCHANGED BEHAVIOUR. A node with no central configured still scans its own
//      workspace directories. Phase 5 must not turn a working standalone install into an install
//      that reports nothing.
//   2. A FALL BACK IS NEVER SILENT. In `auto`, a central that cannot be reached degrades to the
//      scan — but the payload says so, because one machine's rows presented under fleet headings is
//      a wrong number that looks like a right one.
//   3. `central` MEANS CENTRAL OR NOTHING. The deployment that has decided the fleet view is the
//      only true one gets an error, not this machine's numbers.
//   4. THE PAYLOAD SHAPE IS THE CONTRACT. client/src/api/types.ts and server/app.js's routes were
//      written against the scan's shape; every key they read has to survive the central path, and
//      the ones central genuinely cannot know have to be null rather than invented.
//   5. THE SCAN IS STILL REACHABLE UNDER ITS OWN NAME, so a caller that specifically wants this
//      machine's disk — the fallback above, a diagnostic — can ask for it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-rollup-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');
// The scan's root, pointed at an empty scratch directory: this test is about which source answers,
// not about how many workspaces happen to sit next to this checkout on the machine running it.
process.env.WISPFIELD_FIELDS_ROOT = path.join(SCRATCH, 'fields');
fs.mkdirSync(process.env.WISPFIELD_FIELDS_ROOT, { recursive: true });

const centralSource = require('./central');
const rollup = require('./index');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

/** Run `fn` with a staged WINDROW_ROLLUP_SOURCE / WINDROW_CENTRAL_URL, restoring both after. The
 *  module reads them per call rather than at load, which is what makes this possible — and is
 *  deliberate: an operator flipping the source should not have to reason about when the process
 *  started. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Replace the one network call for the duration of `fn`. The seam calls it through the module
 *  object, so this is the whole of the mocking needed — no HTTP, no fake server. */
async function withFetch(impl, fn) {
  const real = centralSource.fetchRollup;
  centralSource.fetchRollup = impl;
  try {
    return await fn();
  } finally {
    centralSource.fetchRollup = real;
  }
}

// One central answer, in central's own payload shape (server/central/queries.js `rollup`).
const CENTRAL_PAYLOAD = {
  source: 'central',
  scope: { nodeIds: null },
  since: null,
  totals: {
    calls: 30,
    denied: 3,
    denialRate: 0.1,
    unattributedCalls: 2,
    nodes: 2,
    lastEventAt: '2026-08-19T10:00:00.000Z',
    clockSkew: { sampled: 28, maxAheadMs: 900, maxBehindMs: 40 },
  },
  byField: [
    { field: 'windrow', fieldPath: null, calls: 20, denied: 2, principalCount: 5, lastEventAt: '2026-08-19T10:00:00.000Z', nodes: 1 },
    { field: 'atlas', fieldPath: null, calls: 8, denied: 1, principalCount: 3, lastEventAt: '2026-08-19T09:00:00.000Z', nodes: 1 },
  ],
  byPrincipal: [
    { principalId: 'pr_1', name: 'Dez', agentName: 'claude-abc', field: 'windrow', standalone: false, backend: null, calls: 20, denied: 2 },
    { principalId: 'pr_2', name: 'pr_2', agentName: null, field: null, standalone: true, backend: 'claude', calls: 2, denied: 0 },
  ],
  standalone: { calls: 2, denied: 0, byBackend: [{ backend: 'claude', calls: 2, denied: 0 }] },
};

async function main() {
  // -------------------------------------------------------------------------
  // 1. The default is unchanged behaviour
  // -------------------------------------------------------------------------

  await withEnv({ WINDROW_ROLLUP_SOURCE: undefined, WINDROW_CENTRAL_URL: undefined }, async () => {
    check(centralSource.mode() === centralSource.AUTO, 'no WINDROW_ROLLUP_SOURCE means auto');
    check(centralSource.enabled() === false, 'auto with no central configured does not query central');
    const s = await rollup.summary();
    check(s.source === 'local-scan', 'a node with no central answers from the local scan', s.source);
    check(s.centralError === null, 'and reports no central error, because none was attempted');
    check(typeof s.totals.calls === 'number' && Array.isArray(s.byField), 'the scan payload is unchanged in shape');
    const f = await rollup.listFields();
    check(f.source === 'local-scan' && typeof f.root === 'string', 'listFields likewise, with the scan root still a path');
  });

  await withEnv({ WINDROW_ROLLUP_SOURCE: 'local', WINDROW_CENTRAL_URL: 'https://central.example' }, async () => {
    check(centralSource.enabled() === false, 'WINDROW_ROLLUP_SOURCE=local ignores a configured central');
    const s = await rollup.summary();
    check(s.source === 'local-scan', 'and answers from the scan', s.source);
  });

  // -------------------------------------------------------------------------
  // 2. A fall back is never silent
  // -------------------------------------------------------------------------

  await withEnv({ WINDROW_ROLLUP_SOURCE: undefined, WINDROW_CENTRAL_URL: 'https://central.example' }, async () => {
    check(centralSource.enabled() === true, 'auto with a central configured queries it');
    check(centralSource.required() === false, 'and does not require it');
    await withFetch(async () => { throw new Error('connect ECONNREFUSED'); }, async () => {
      const s = await rollup.summary();
      check(s.source === 'local-scan', 'an unreachable central degrades to the scan rather than erroring', s.source);
      check(
        typeof s.centralError === 'string' && s.centralError.includes('ECONNREFUSED'),
        'and the payload carries WHY, so the page can say these are one machine\'s numbers',
        s.centralError
      );
      const f = await rollup.listFields();
      check(f.source === 'local-scan' && typeof f.centralError === 'string', 'listFields degrades the same way');
    });
  });

  // -------------------------------------------------------------------------
  // 3. `central` means central or nothing
  // -------------------------------------------------------------------------

  await withEnv({ WINDROW_ROLLUP_SOURCE: 'central', WINDROW_CENTRAL_URL: 'https://central.example' }, async () => {
    check(centralSource.required() === true, 'WINDROW_ROLLUP_SOURCE=central requires central');
    await withFetch(async () => { throw new Error('connect ECONNREFUSED'); }, async () => {
      let threw = null;
      try { await rollup.summary(); } catch (err) { threw = err; }
      check(threw !== null, 'an unreachable central is an error, not this machine\'s rows under fleet headings');
      check(threw && threw.message.includes('ECONNREFUSED'), 'and the error is the transport\'s own', threw && threw.message);
    });
  });

  await withEnv({ WINDROW_ROLLUP_SOURCE: 'central', WINDROW_CENTRAL_URL: undefined }, async () => {
    let threw = null;
    try { await rollup.summary(); } catch (err) { threw = err; }
    check(
      threw !== null && /WINDROW_CENTRAL_URL/.test(threw.message),
      'asking for central with nowhere to ask is refused by name, not silently downgraded',
      threw && threw.message
    );
  });

  // -------------------------------------------------------------------------
  // 4. The payload shape is the contract
  // -------------------------------------------------------------------------

  await withEnv({ WINDROW_ROLLUP_SOURCE: 'central', WINDROW_CENTRAL_URL: 'https://central.example' }, async () => {
    await withFetch(async () => CENTRAL_PAYLOAD, async () => {
      const s = await rollup.summary();
      check(s.source === 'central', 'a central answer is labelled central');
      check(s.totals.calls === 30 && s.totals.denied === 3, 'totals come through', JSON.stringify(s.totals));
      check(s.totals.duplicatesSkipped === 0, 'duplicatesSkipped is 0 — ingest de-duplicates on (nodeId, seq)');
      check(s.totals.clockSkew.sampled === 28, 'clock skew comes off central\'s own column');
      check(s.totals.unattributedCalls === 2, 'and the number the scan could never produce is carried');
      check(
        s.byField.length === 2 && s.byField[0].field === 'windrow' && s.byField[0].principalCount === 5,
        'byField keeps field / calls / denied / principalCount',
        JSON.stringify(s.byField)
      );
      check(s.byField.every((f) => f.fieldPath === null), 'fieldPath is null — central knows events, not any node\'s disk');
      check(s.standalone.byBackend[0].backend === 'claude', 'standalone is broken out by backend as before');
      check(
        s.fields.length === 2 && s.fields.every((f) => f.reachable === true && f.warnings.length === 0),
        'the per-workspace status list is present; presence is the evidence, so reachable is true'
      );

      const f = await rollup.listFields();
      check(f.source === 'central' && f.root === null, 'listFields: no root on the central path, because a fleet has no directory');
      check(f.thisField === rollup.THIS_FIELD_NAME, 'this workspace is still named, so the page can mark its own row');
      check(
        f.fields.length === 2 && f.fields[0].eventCount === 20 && f.fields[0].lastEventAt === '2026-08-19T10:00:00.000Z',
        'per-workspace counts and last-event times survive',
        JSON.stringify(f.fields[0])
      );
      check(f.fields.every((x) => x.dbPath === null && x.sharedOnly === false), 'dbPath/sharedOnly are file-level facts and are null/false');
    });
  });

  // A node certificate scopes central's answer to its own rows; the page must be able to tell.
  await withEnv({ WINDROW_ROLLUP_SOURCE: 'central', WINDROW_CENTRAL_URL: 'https://central.example' }, async () => {
    await withFetch(async () => ({ ...CENTRAL_PAYLOAD, scope: { nodeIds: ['node-a'] } }), async () => {
      const s = await rollup.summary();
      check(
        Array.isArray(s.scope.nodeIds) && s.scope.nodeIds[0] === 'node-a',
        'a scoped answer says which nodes it covers, so "the fleet" is never claimed for one node',
        JSON.stringify(s.scope)
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4b. A node certificate cannot read the fleet
  //
  // The scoping rule on central's side of the same feature. It lives here rather than in
  // ../central/smoke.js because that file skips when no Postgres is configured, and this is the
  // half that must never go unasserted: /api/fleet/rollup is the ONLY fleet route a node
  // certificate reaches, and what makes that safe is that it is pinned to that node's own rows.
  // -------------------------------------------------------------------------

  const { rollupScopeFor } = require('../central/routes');
  check(
    JSON.stringify(rollupScopeFor({ authScope: 'node', nodeId: 'node-a', query: {} }).nodeIds) === '["node-a"]',
    'a node certificate is scoped to its own node'
  );
  check(
    JSON.stringify(rollupScopeFor({ authScope: 'node', nodeId: 'node-a', query: { nodeId: 'node-b' } }).nodeIds) === '["node-a"]',
    'and asking for another node does not widen it — the certificate decides, not the query string'
  );
  check(
    rollupScopeFor({ authScope: 'admin', nodeId: 'admin-1', query: {} }).nodeIds === null,
    'an admin certificate gets the fleet'
  );
  check(
    JSON.stringify(rollupScopeFor({ authScope: 'admin', nodeId: 'admin-1', query: { nodeId: ['a', 'b'] } }).nodeIds) === '["a","b"]',
    'and may narrow to a named set'
  );
  check(
    rollupScopeFor({ authScope: 'node', nodeId: 'node-a', query: {} }).sinceMs === null,
    'no window by default — the scan this replaces had none, and a number must not change on its own'
  );
  check(
    rollupScopeFor({ authScope: 'admin', nodeId: 'a', query: { hours: '2' } }).sinceMs === 7200000,
    '?hours= narrows the window'
  );

  // -------------------------------------------------------------------------
  // 5. The scan is still reachable under its own name
  // -------------------------------------------------------------------------

  check(typeof rollup.scanSummary === 'function' && typeof rollup.scanFields === 'function', 'scanSummary/scanFields are exported');
  const scanned = rollup.scanSummary();
  check(
    scanned && typeof scanned.totals.calls === 'number' && scanned.source === undefined,
    'and the scan itself is untouched — synchronous, and with no source label of its own'
  );

  console.log(failures === 0 ? '\nall rollup source checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
