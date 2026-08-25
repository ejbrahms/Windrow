// Verification for the policy distribution channel — docs/design/global-identity-and-central-db.md
// §2.4. Run it with: node server/policy/distribution-test.js
//
// Everything runs against a scratch database under the OS temp dir and a real HTTP listener on a
// loopback port; the live server/data is never touched and no network is required. The auth gates
// are neutered on purpose, exactly as server/policy/smoke.js does it: what is under test is the
// channel, not the mTLS admission in front of it.
//
// Four things §2.4 promises, and one test each for the way each can silently fail:
//
//   1. THE VERSION IS MONOTONIC AND COMPLETE. Every policy mutation appends. A mutator that forgets
//      to is a node that never learns about those rows, and nothing else in the system would
//      notice — so this is asserted per mutator, not in aggregate.
//   2. DELTAS ARE SOUND. since=v returns exactly what follows v, a `since` older than the log gets a
//      snapshot instead of a hole, and replaying deltas from zero lands on the same state as the
//      snapshot. That last equivalence is the one that matters: it is what makes an incremental
//      node and a fresh node interchangeable.
//   3. THE PUSH CHANNEL POKES. A mutation reaches a held SSE connection.
//   4. REVOCATION SURVIVES A BROKEN STREAM. The one this whole design exists for: with the delta
//      stream refusing to apply (schema skew), a revoked grant is still denied — and past
//      MAX_POLICY_AGE, mutating and destructive fail closed while read_only stays open.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A REAL windrow.env MUST NOT REACH THIS TEST. Part 5 stands app.js up and asserts that
// /api/policy, /api/policy/deny-list and /api/policy/events answer — routes app.js deliberately
// leaves unmounted under central authority, since a replica's own policy log is a history of
// nothing. A developer's windrow.env sets exactly that (WINDROW_POLICY_AUTHORITY=central), so
// without this line the suite passes on CI, where no such file exists, and fails on the machine of
// anyone whose node is enrolled in a fleet — the environment least able to tell it is a false
// alarm. Every other input is already redirected below; this is the last one.
process.env.WINDROW_NO_ENV_FILE = '1';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-policy-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
// The hook-side files this test writes and reads. Redirected so a run cannot overwrite the live
// node's deny-list — which is a file that decides whether real tool calls are allowed.
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const http = require('http');
const store = require('../store');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Every policy mutator appends to the log
// ---------------------------------------------------------------------------

const before = store.policyVersion();
check(before === 0, 'a fresh database is at policy version 0', `got ${before}`);

const cap = {
  id: 'cap_test_1', kind: 'mcp_tool', name: 'test/tool', owner: null, riskTier: 'mutating',
  description: null, source: 'test', discoveredAt: new Date().toISOString(), lastSeenAt: null,
  stale: 0, realUsage: null, autoGrant: 0,
};
const role = { id: 'pr_role_1', kind: 'role', name: 'tester', parentRole: null, status: 'active' };

const steps = [
  ['insertCapability', () => store.insertCapability(cap)],
  ['insertPrincipal', () => store.insertPrincipal(role)],
  ['setCapabilityAutoGrant', () => store.setCapabilityAutoGrant(cap.id, false)],
  ['setPrincipalStatus', () => store.setPrincipalStatus(role.id, 'active')],
  ['insertGrant', () => store.insertGrant({
    id: 'gr_1', principalId: role.id, capabilityId: cap.id, constraints: null,
    createdAt: new Date().toISOString(), expiresAt: null,
  })],
  ['revokeGrant', () => store.revokeGrant('gr_1', 'test')],
];
let last = store.policyVersion();
for (const [label, run] of steps) {
  run();
  const now = store.policyVersion();
  check(now > last, `${label} bumps the policy version`, `stayed at ${now}`);
  last = now;
}

// A mutator that forgets to append is invisible to every other test here, so name the ones that
// must: this is a list to extend when a policy mutator is added, and its failure message says so.
// Named by their *definition site*, which for the identity upsert and the wholesale replace is the
// transaction rather than any wrapper around it — the append has to be inside the transaction, or a
// rollback would leave the log describing rows that were never written.
const mutators = [
  ['insertCapability', 'function insertCapability('],
  ['setCapabilityAutoGrant', 'function setCapabilityAutoGrant('],
  ['insertPrincipal', 'function insertPrincipal('],
  ['setPrincipalStatus', 'function setPrincipalStatus('],
  ['setPrincipalName', 'function setPrincipalName('],
  ['setPrincipalOwner', 'function setPrincipalOwner('],
  ['insertGrant', 'function insertGrant('],
  ['revokeGrant', 'function revokeGrant('],
  ['upsertPrincipalIdentityTx', 'const upsertPrincipalIdentityTx = db.transaction('],
  ['replaceAll', 'const replaceAll = db.transaction('],
];
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
const uninstrumented = mutators
  .filter(([, anchor]) => {
    const from = storeSrc.indexOf(anchor);
    if (from === -1) return true; // renamed or gone — the list is stale, and that is worth a failure
    const body = storeSrc.slice(from);
    const end = body.indexOf('\n}');
    return !body.slice(0, end === -1 ? body.length : end).includes('recordPolicyChange');
  })
  .map(([name]) => name);
check(
  uninstrumented.length === 0,
  'every policy mutator in store.js calls recordPolicyChange',
  `not instrumented: ${uninstrumented.join(', ')} — a mutation nodes will never hear about`
);

// ---------------------------------------------------------------------------
// 2. Deltas are sound
// ---------------------------------------------------------------------------

const full = store.policyDelta(0);
check(full.changes.length === last, 'since=0 returns every change', `${full.changes.length} of ${last}`);
check(full.version === last && !full.reset, 'since=0 on an untrimmed log is a delta, not a reset');

const tail = store.policyDelta(last - 2);
check(tail.changes.length === 2, 'since=v returns exactly what follows v', `got ${tail.changes.length}`);
check(
  tail.changes.every((c, i) => i === 0 || c.version > tail.changes[i - 1].version),
  'changes come back in ascending version order'
);

const ahead = store.policyDelta(last + 500);
check(ahead.reset === true, 'a `since` ahead of central resets the node rather than replaying onto it');
check(Array.isArray(ahead.snapshot?.grants), 'a reset carries a full snapshot');

// Replay-vs-snapshot equivalence: an incrementally-caught-up node and a freshly-reset one must hold
// the same rows, or a node's behaviour would depend on how it got there.
const replicaMod = require('./replica');
let incremental = replicaMod.emptyReplica();
const step1 = replicaMod.applyDelta(incremental, store.policyDelta(0, { limit: 3 }));
check(step1.ok, 'a partial delta applies', step1.reason);
// The one that would rot silently: central caps the batch at 3 but reports the log's head as
// `version`, so a replica that took the head would ask `since=head` next time and be told it was
// current — with the rows in between missing forever and nothing anywhere reporting a gap.
check(
  step1.replica.version === 3 && store.policyDelta(0, { limit: 3 }).complete === false,
  'a capped batch leaves the replica at the last change applied, not at the log head',
  `replica at ${step1.replica.version}, log head at ${last}`
);
incremental = step1.replica;
// ...and the next pull picks up exactly where it left off, with no gap and no repeat.
const step2 = replicaMod.applyDelta(incremental, store.policyDelta(incremental.version));
check(step2.ok && step2.replica.version === last, 'the next pull catches the replica up to the head', step2.reason);
const fromSnapshot = replicaMod.applyDelta(replicaMod.emptyReplica(), store.policyDelta(last + 500));
check(fromSnapshot.ok && fromSnapshot.reset, 'a reset applies as a wholesale replace', fromSnapshot.reason);

const replayed = replicaMod.applyDelta(replicaMod.emptyReplica(), store.policyDelta(0));
check(replayed.ok, 'a full replay from zero applies', replayed.reason);
check(
  JSON.stringify(Object.keys(replayed.replica.grants).sort())
    === JSON.stringify(Object.keys(fromSnapshot.replica.grants).sort()),
  'replaying every delta lands on the same grants as taking the snapshot'
);

// §2.6: a payload this node does not understand is refused whole, not applied in part.
const skewed = replicaMod.applyDelta(replayed.replica, { ...store.policyDelta(last), schemaVersion: 99 });
check(skewed.ok === false && skewed.skew === true, 'an unknown schemaVersion is refused, not half-applied');

// A delta that does not start where the replica ended would leave a hole.
const gapped = replicaMod.applyDelta(replayed.replica, { ...store.policyDelta(0), since: 0 });
check(gapped.ok === false, 'a delta that does not continue from the replica is refused');

// ---------------------------------------------------------------------------
// 3. The deny-list is always full, and independent of the delta stream
// ---------------------------------------------------------------------------

const deny = store.policyDenyList();
check(deny.grantIds.includes('gr_1'), 'a revoked grant is on the deny-list');
check(deny.pairs.includes(`${role.id}:${cap.id}`), 'the deny-list carries the principal:capability pair');
check(store.policyDelta(last).denyList.grantIds.includes('gr_1'), 'the deny-list rides a no-op delta too');
check(store.policyDelta(last + 500).denyList.grantIds.includes('gr_1'), 'the deny-list rides a reset too');

// ---------------------------------------------------------------------------
// 4. The hook enforces it: revocation survives, and staleness fails closed
// ---------------------------------------------------------------------------

const hooks = require('../hooks/lib');
const principal = { id: role.id, kind: 'role', name: 'tester', parentRole: null };
const mutatingCap = { id: cap.id, name: cap.name, riskTier: 'mutating', autoGrant: false };
const readCap = { id: cap.id, name: cap.name, riskTier: 'read_only', autoGrant: false };
const destructiveCap = { id: cap.id, name: cap.name, riskTier: 'destructive', autoGrant: false };

// Fresh policy, nothing revoked for this pair: the gate says nothing and the live check runs.
replicaMod.saveDenyList({ denyList: { grantIds: [], pairs: [], principals: [] }, version: last, fetchedAt: Date.now(), central: true });
check(hooks.policyChannelGate({ principal, capability: mutatingCap }) === null, 'a healthy channel does not interfere');

// Revoked, and the stream is beside the point: a deny-list hit denies every tier.
replicaMod.saveDenyList({ denyList: deny, version: last, fetchedAt: Date.now(), central: true });
const revokedVerdict = hooks.policyChannelGate({ principal, capability: mutatingCap });
check(revokedVerdict?.decision === 'deny', 'a revoked grant is denied from the deny-list alone', JSON.stringify(revokedVerdict));
check(
  String(revokedVerdict?.reason).startsWith('[governance:denied]'),
  'a deny-list denial carries the policy tag, not a fault tag — retrying will not help and the agent is told so',
  revokedVerdict?.reason
);
check(
  hooks.policyChannelGate({ principal, capability: readCap })?.decision === 'deny',
  'a revocation denies read_only too — there is no tier for which "stop" is optional'
);

// Past MAX_POLICY_AGE with nothing revoked: fail closed for mutating/destructive, open for read_only.
const old = Date.now() - hooks.MAX_POLICY_AGE_MS - 60_000;
replicaMod.saveDenyList({ denyList: { grantIds: [], pairs: [], principals: [] }, version: last, fetchedAt: old, central: true });
check(hooks.policyChannelGate({ principal, capability: mutatingCap })?.decision === 'deny', 'stale policy fails mutating closed');
check(hooks.policyChannelGate({ principal, capability: destructiveCap })?.decision === 'deny', 'stale policy fails destructive closed');
check(hooks.policyChannelGate({ principal, capability: readCap }) === null, 'stale policy stays open for read_only');
check(
  String(hooks.policyChannelGate({ principal, capability: mutatingCap })?.reason).includes(hooks.FAULT.STALE_POLICY),
  'a staleness denial is classified as a fault, naming stale-policy'
);

// Never confirmed at all — the marker server/policy/policyClient.js lays down at startup.
replicaMod.saveDenyList({ denyList: { grantIds: [], pairs: [], principals: [] }, version: 0, fetchedAt: null, central: true });
check(hooks.policyChannelGate({ principal, capability: mutatingCap })?.decision === 'deny', 'a node that never confirmed policy fails mutating closed');

// Standalone: this node's own database is the authority, so age is not a meaningful claim about it.
replicaMod.saveDenyList({ denyList: { grantIds: [], pairs: [], principals: [] }, version: last, fetchedAt: old, central: false });
check(hooks.policyChannelGate({ principal, capability: mutatingCap }) === null, 'a standalone install is never judged stale against itself');

// ---------------------------------------------------------------------------
// 5. Over a real socket: the routes, and the push channel
// ---------------------------------------------------------------------------

const auth = require('../auth.js');
auth.requireAdmin = (req, res, next) => next();
auth.requireProposer = (req, res, next) => next();
const app = require('../app.js');
const T = auth.AGENT_TOKEN;

const srv = http.createServer(app).listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const get = (p) =>
    new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: `Bearer ${T}` } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* leave null — the check below reports it */ }
          resolve({ status: res.statusCode, body });
        });
      }).on('error', () => resolve({ status: 0, body: null }));
    });

  try {
    const served = await get('/api/policy?since=0');
    check(served.status === 200, 'GET /api/policy answers 200', `status ${served.status}`);
    check(served.body?.version === store.policyVersion(), 'the served version matches the store');
    check(Array.isArray(served.body?.denyList?.grantIds), 'the served response carries a deny-list');
    check(served.body?.schemaVersion === store.POLICY_SCHEMA_VERSION, 'the response is stamped with a schema version');

    const denyOnly = await get('/api/policy/deny-list');
    check(denyOnly.status === 200 && denyOnly.body?.grantIds.includes('gr_1'), 'GET /api/policy/deny-list serves it standalone');

    const bogus = await get('/api/policy?since=not-a-number');
    check(bogus.status === 200 && bogus.body?.since === 0, 'an unparseable `since` is read as 0, not rejected');

    const status = await get('/api/policy/status');
    check(status.status === 200 && status.body?.central === null, 'GET /api/policy/status reports no central on a standalone node');

    // The push channel. Hold the stream, mutate, and require the poke — with a deadline, because
    // the failure this catches is "the event never arrives", which without one is a hung test.
    const poked = await new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/policy/events', headers: { Authorization: `Bearer ${T}`, accept: 'text/event-stream' } },
        (res) => {
          let seen = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            for (const frame of chunk.split('\n\n')) {
              if (!frame.includes('data:')) continue;
              seen += 1;
              // The first event is the on-connect version. Mutate once we have it, and resolve on
              // the second — which is the one that proves a *change* propagated.
              if (seen === 1) {
                store.insertCapability({ ...cap, id: 'cap_test_2', name: 'test/tool2' });
              } else {
                req.destroy();
                resolve(true);
              }
            }
          });
        }
      );
      req.on('error', () => resolve(false));
      const deadline = setTimeout(() => { req.destroy(); resolve(false); }, 5_000);
      if (typeof deadline.unref === 'function') deadline.unref();
    });
    check(poked, 'a policy mutation reaches a held SSE connection');
  } finally {
    srv.close();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    // Best-effort: Windows holds the open better-sqlite3 handle, so the scratch directory can
    // outlive the run. A leftover temp db is not worth failing a passing test over.
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* see above */ }
    process.exit(failures ? 1 : 0);
  }
});
