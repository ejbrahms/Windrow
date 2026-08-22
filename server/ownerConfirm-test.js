// Verification for "Confirm owner" on a POLICY REPLICA — docs/design/global-identity-and-central-db.md §1.6.
// Run it with: node server/ownerConfirm-test.js
//
// WHAT WENT WRONG. The owner decision has two destinations and they are not the same shape.
// Central has one column for it (`owner`, a bare string) and no vocabulary for
// confirmed/dismissed/unassigned; the node has five columns (`ownerStatus`, `ownerOsUser`,
// `ownerPrincipalId`, `ownerConfirmedAt`, `ownerConfirmedBy`) and they are the ONLY thing
// `GET /api/principals/owner-proposals` reads. ../policy/centralPolicyStore.js forwarded to central
// and stopped, so on a central-authority install the node's columns were never written: the
// dashboard POSTed, got a 200, reloaded, and re-rendered the identical unassigned row.
//
// That is the failure this file exists to catch, and it is worth naming why it needed a test at
// all. Nothing errored. The route answered 200, the audit row was written, central held the right
// answer — every signal an operator or a log would look at said the write had landed. The only
// observable was a button that appeared not to be wired up.
//
// FOUR PROPERTIES:
//   1. A node-authoritative install still writes the columns (the path that always worked).
//   2. The replica lock still refuses `setPrincipalOwner`. The fix must not be a hole in the lock:
//      a principals-table write on a replica has to go through the seam, and only the owner*
//      columns — which central has no column for — are exempt.
//   3. `setPrincipalOwnerLocal` writes them anyway, and reads back, under that same lock.
//   4. The central adapter does BOTH halves: forwards to central AND lands the local row. Asserted
//      with the transport stubbed, because what is under test is the adapter's own sequencing, not
//      whether Postgres is up.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-owner-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const store = require('./store');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

const INSTANCE = {
  id: 'pr_inst_1',
  kind: 'instance',
  name: 'claude/loom-1',
  parentRole: null,
  status: 'active',
};

// ---------------------------------------------------------------------------
// 1. Node-authoritative: the path that was never broken.
// ---------------------------------------------------------------------------

store.insertPrincipal(INSTANCE);
store.setPrincipalOwner(INSTANCE.id, { status: 'confirmed', osUser: 'ejbra', decidedByScope: 'admin' });
let row = store.findPrincipalById(INSTANCE.id);
check(
  row.ownerStatus === 'confirmed' && row.ownerOsUser === 'ejbra' && row.ownerConfirmedBy === 'admin',
  '1. a node-authoritative install records the owner decision on its own row',
  JSON.stringify({ ownerStatus: row.ownerStatus, ownerOsUser: row.ownerOsUser })
);

// Reopening clears the evidence rather than leaving a stale username beside 'unassigned'.
store.setPrincipalOwner(INSTANCE.id, { status: 'unassigned' });
row = store.findPrincipalById(INSTANCE.id);
check(
  row.ownerStatus === 'unassigned' && row.ownerOsUser === null && row.ownerConfirmedAt === null,
  '1. reopening clears the osUser and the timestamp with it'
);

// ---------------------------------------------------------------------------
// 2-3. The replica: the lock holds, and the node-local write still lands.
// ---------------------------------------------------------------------------

store.setPolicyReadOnly(true);

let thrown = null;
try {
  store.setPrincipalOwner(INSTANCE.id, { status: 'confirmed', osUser: 'ejbra' });
} catch (err) {
  thrown = err;
}
check(
  thrown instanceof store.PolicyReadOnlyError,
  '2. setPrincipalOwner() is still refused on a replica — the fix is not a hole in the lock',
  thrown ? `threw ${thrown.constructor.name}` : 'it did not throw at all'
);

const updated = store.setPrincipalOwnerLocal(INSTANCE.id, {
  status: 'confirmed',
  osUser: 'ejbra',
  ownerPrincipalId: null,
  decidedByScope: 'admin',
});
check(
  updated && updated.ownerStatus === 'confirmed' && updated.ownerOsUser === 'ejbra',
  '3. setPrincipalOwnerLocal() returns the node row it just wrote'
);
row = store.findPrincipalById(INSTANCE.id);
check(
  row.ownerStatus === 'confirmed' && row.ownerOsUser === 'ejbra' && row.ownerConfirmedBy === 'admin',
  '3. ...and a re-read sees it, which is what the dashboard does on reload'
);

// (The mirror's own upsert deliberately does not name the owner* columns — see
// replicaStmts.upsertPrincipal — so the decision survives the next poll rather than being blanked
// by it.)

store.setPolicyReadOnly(false);

// ---------------------------------------------------------------------------
// 4. The central adapter does both halves.
//
// The transport is stubbed by mutating ./policy/policyClient's exports BEFORE requiring the
// adapter, which destructures them at require time. What is under test is that the adapter lands a
// local row at all — the wire shape of the central PATCH is asserted in server/central/smoke.js
// against a real Postgres.
// ---------------------------------------------------------------------------

const policyClient = require('./policy/policyClient');
const sent = [];
policyClient.centralRequest = async (method, p, body) => {
  sent.push({ method, path: p, body });
  return { id: INSTANCE.id, owner: body.owner };
};
policyClient.pullNow = async () => {};

const centralPolicyStore = require('./policy/centralPolicyStore');

(async () => {
  store.setPrincipalOwnerLocal(INSTANCE.id, { status: 'unassigned' });
  store.setPolicyReadOnly(true);

  const result = await centralPolicyStore.setPrincipalOwner(INSTANCE.id, {
    status: 'confirmed',
    osUser: 'ejbra',
    ownerPrincipalId: null,
    decidedByScope: 'admin',
  });

  check(sent.length === 1 && sent[0].method === 'PATCH', '4. the decision is forwarded to central');
  check(
    sent[0].body.owner === 'ejbra' && sent[0].body.reason === 'owner confirmed by admin',
    '4. ...as central\'s one `owner` column, never as its lifecycle `status`',
    JSON.stringify(sent[0].body)
  );

  row = store.findPrincipalById(INSTANCE.id);
  check(
    row.ownerStatus === 'confirmed' && row.ownerOsUser === 'ejbra',
    '4. ...AND the node\'s own owner* columns are written, which is what owner-proposals reads',
    `ownerStatus=${row.ownerStatus} ownerOsUser=${row.ownerOsUser} — this is the regression: a 200 that changed nothing the reader looks at`
  );
  check(
    result && result.ownerStatus === 'confirmed',
    '4. ...and the node row comes back, so the audit entry\'s `after` is not all undefined',
    JSON.stringify(result && { ownerStatus: result.ownerStatus, ownerOsUser: result.ownerOsUser })
  );

  // Dismissing sends a null owner across the seam and records 'dismissed' here — the distinction
  // central has no column for.
  sent.length = 0;
  await centralPolicyStore.setPrincipalOwner(INSTANCE.id, { status: 'dismissed', decidedByScope: 'admin' });
  row = store.findPrincipalById(INSTANCE.id);
  check(
    sent[0].body.owner === null && row.ownerStatus === 'dismissed' && row.ownerOsUser === null,
    '4. dismissing clears central\'s owner and records "dismissed" on the node'
  );

  store.setPolicyReadOnly(false);
  // Best-effort: Windows holds the SQLite file open for the life of the process, so the scratch dir
  // outlives the run. It is under the OS temp dir; failing the test over it would be noise.
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* temp dir, left to the OS */ }
  console.log(failures === 0 ? '\nall ok' : `\n${failures} failing`);
  process.exit(failures === 0 ? 0 : 1);
})();
