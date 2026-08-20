// Verification for the authority flip — docs/design/global-identity-and-central-db.md §2.7 phase 4.
// Run it with: node server/policy/authority-test.js  (npm run test:authority --prefix server)
//
// Everything runs against a scratch database under the OS temp dir. Nothing here needs a network, a
// central, or Postgres: what is under test is the NODE half of the flip — the lock, the applier, the
// wire compatibility of the payload, and the one hook branch whose meaning changed. The central half
// is asserted against a real Postgres in server/central/smoke.js, which skips when none is
// configured; this file must not, because it is the half that runs on every user's PC.
//
// SIX PROPERTIES, each chosen because it is a way phase 4 could look correct and not be:
//
//   1. AUTHORITY NEEDS BOTH HALVES. Asking for central without naming one stays node-authoritative
//      and says so. A quiet downgrade would leave an operator believing a machine replicates while
//      it enforces its own opinion — which is indistinguishable from a working flip until the day
//      a revoke does not land.
//   2. THE LOCK IS ABSOLUTE. Every policy mutator refuses on a replica node, from any caller, and
//      refuses LOUDLY. A silently-dropped grant is the worst available outcome: the admin sees a
//      success, the dashboard shows nothing, and the disagreement surfaces weeks later as an
//      inexplicable denial.
//   3. THE APPLIER IS THE ONE WAY IN, and it survives the collision a phase-3 node guarantees:
//      locally-minted ids for rows central also holds, colliding on UNIQUE(kind, name).
//   4. A REVOKE REPLICATES AS A ROW, NOT AS A DELETION. A replica that dropped revoked grants could
//      not tell "revoked" from "never existed", and the deny-list is built from `revokedAt`.
//   5. A RESET REMOVES WHAT CENTRAL NO LONGER HAS. Merging a snapshot instead of replacing keeps
//      deleted rows alive forever — the failure mode that makes a reset useless as a repair.
//   6. AN UNKNOWN CAPABILITY IS NOT AUTOMATICALLY UNGOVERNED any more. This is the hook-contract
//      change, and both directions are asserted: a stale replica denies, a fresh one allows.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-authority-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const store = require('../store');
const replica = require('./replica');
const { resolvePolicyAuthority, CENTRAL, NODE } = require('./authority');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Authority needs both halves
// ---------------------------------------------------------------------------

check(
  resolvePolicyAuthority({}).authority === NODE,
  'an install with nothing configured is node-authoritative'
);
check(
  resolvePolicyAuthority({ WINDROW_CENTRAL_URL: 'https://central.example' }).authority === NODE,
  'naming a central does not by itself hand it authority (phase 3 ships usage to a central it does not obey)'
);
{
  const asked = resolvePolicyAuthority({ WINDROW_POLICY_AUTHORITY: 'central' });
  check(asked.authority === NODE, 'central authority with no central URL does not take effect');
  check(
    Boolean(asked.error) && asked.error.includes('WINDROW_CENTRAL_URL'),
    'and it says why, rather than downgrading quietly',
    asked.error
  );
}
check(
  resolvePolicyAuthority({ WINDROW_POLICY_AUTHORITY: 'central', WINDROW_CENTRAL_URL: 'https://c.example' }).authority === CENTRAL,
  'both halves present flips authority to central'
);
check(
  resolvePolicyAuthority({ WINDROW_POLICY_AUTHORITY: 'nonsense', WINDROW_CENTRAL_URL: 'https://c.example' }).authority === NODE,
  'an unrecognised value fails safe to node authority rather than to central'
);

// ---------------------------------------------------------------------------
// 2. The lock
//
// Seed while still node-authoritative, so there is something to replicate over later.
// ---------------------------------------------------------------------------

const localCap = {
  id: 'cap_local_1', kind: 'mcp_tool', name: 'shared/tool', owner: null, riskTier: 'mutating',
  description: null, source: 'discovery', discoveredAt: new Date().toISOString(), lastSeenAt: null,
  stale: 0, realUsage: null, autoGrant: 0,
};
store.insertCapability(localCap);
store.insertPrincipal({ id: 'pr_local_1', kind: 'role', name: 'tester', parentRole: null, status: 'active' });
store.insertGrant({
  id: 'gr_local_1', principalId: 'pr_local_1', capabilityId: 'cap_local_1',
  constraints: null, createdAt: new Date().toISOString(), expiresAt: null,
});
check(Boolean(store.findGrant('pr_local_1', 'cap_local_1')), 'a node-authoritative install writes its own grants');

store.setPolicyReadOnly(true);

const refusals = [
  ['insertCapability', () => store.insertCapability({ ...localCap, id: 'cap_x', name: 'other/tool' })],
  ['setCapabilityAutoGrant', () => store.setCapabilityAutoGrant('cap_local_1', true)],
  ['insertPrincipal', () => store.insertPrincipal({ id: 'pr_x', kind: 'role', name: 'x', status: 'active' })],
  ['setPrincipalStatus', () => store.setPrincipalStatus('pr_local_1', 'denied')],
  ['setPrincipalName', () => store.setPrincipalName('pr_local_1', 'renamed')],
  ['setPrincipalOwner', () => store.setPrincipalOwner('pr_local_1', { status: 'active' })],
  ['upsertPrincipalIdentity', () => store.upsertPrincipalIdentity('tester', { loomId: 'loom-1' })],
  ['insertGrant', () => store.insertGrant({ id: 'gr_x', principalId: 'pr_local_1', capabilityId: 'cap_local_1', createdAt: 'now' })],
  ['revokeGrant', () => store.revokeGrant('gr_local_1', 'test')],
  ['insertApproval', () => store.insertApproval({ id: 'ap_x', action: 'grant', payload: {}, requestedByScope: 'test', requestedAt: 'now' })],
  ['decideApproval', () => store.decideApproval('ap_x', { status: 'approved' })],
  // The one that reaches around every guarded export: replaceAll writes capabilities, principals
  // and grants through its own statements, so a discovery run on a replica would otherwise replace
  // central’s rows and nothing would correct it — from central’s point of view nothing changed.
  ['save', () => store.save({ capabilities: [], principals: [], grants: [] })],
];
for (const [name, run] of refusals) {
  let thrown = null;
  try { run(); } catch (err) { thrown = err; }
  check(
    thrown instanceof store.PolicyReadOnlyError,
    `${name}() is refused on a replica node`,
    thrown ? `threw ${thrown.constructor.name}: ${thrown.message}` : 'it did not throw at all — the write landed locally'
  );
}
check(
  !store.findGrantById('gr_x') && store.findGrantById('gr_local_1').revokedAt === null,
  'and nothing it refused was written anyway'
);

// ---------------------------------------------------------------------------
// 3-4. The applier, including the collision a phase-3 node guarantees
//
// `cap_central_1` is central's row for the SAME (kind, name) the node minted locally as
// `cap_local_1`. Both cannot exist — the node's UNIQUE(kind, name) index forbids it — so the
// applier has to displace the locally-minted one. Getting this wrong is not a visible crash: the
// upsert fails, the delta is logged as applied, and the node quietly enforces a capability id no
// grant in the fleet references.
// ---------------------------------------------------------------------------

const centralCap = {
  id: 'cap_central_1', kind: 'mcp_tool', name: 'shared/tool', owner: null,
  riskTier: 'destructive', description: 'central owns this row', autoGrant: false,
  createdAt: new Date().toISOString(),
};
const centralRole = {
  id: 'pr_central_1', kind: 'role', name: 'tester', subjectId: null, assuranceLevel: null,
  parentRole: null, humanName: null, backend: null, agentType: null, field: null,
  standalone: false, status: 'active',
};
const centralGrant = {
  id: 'gr_central_1', principalId: 'pr_central_1', capabilityId: 'cap_central_1',
  constraints: null, createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, revokedBy: null,
};

store.applyPolicyReplica({
  reset: false,
  version: 12,
  capabilities: [centralCap],
  principals: [centralRole],
  grants: [centralGrant],
});

check(
  store.findCapabilityById('cap_central_1') !== null && store.findCapabilityById('cap_local_1') === null,
  'the applier displaces a locally-minted row that collides with central on (kind, name)'
);
check(
  store.findCapabilityById('cap_central_1').riskTier === 'destructive',
  "and central's tier is what governs afterwards, not the node's"
);
check(
  store.findPrincipalById('pr_central_1') !== null && store.findPrincipalById('pr_local_1') === null,
  'the same holds for principals, which are resolved by (kind, name) on the hook path'
);
check(
  Boolean(store.findGrant('pr_central_1', 'cap_central_1')),
  'and the replicated grant is live in the tables the hot path reads'
);
check(
  store.policyReplicaState().version === 12,
  'the mirror records which of central’s versions it holds',
  JSON.stringify(store.policyReplicaState())
);

// A revoke arrives as the row, carrying revokedAt — not as a removal.
store.applyPolicyReplica({
  reset: false,
  version: 13,
  grants: [{ ...centralGrant, revokedAt: new Date().toISOString(), revokedBy: 'admin' }],
});
check(
  store.findGrantById('gr_central_1') !== null && store.findGrantById('gr_central_1').revokedAt !== null,
  'a revoke replicates as a soft-deleted row, so "revoked" stays distinguishable from "never existed"'
);
check(
  store.findGrant('pr_central_1', 'cap_central_1') === null,
  'and the live-grant lookup the broker uses no longer finds it'
);

// 5. A reset replaces rather than merges.
store.applyPolicyReplica({
  reset: true,
  version: 40,
  capabilities: [centralCap],
  principals: [centralRole],
  grants: [],
});
check(
  store.findGrantById('gr_central_1') === null,
  'a reset removes a grant central’s snapshot no longer mentions'
);
check(
  store.findCapabilityById('cap_central_1') !== null,
  'while keeping everything the snapshot does mention'
);

// The applier itself is never blocked by the lock it enforces on everyone else.
check(store.isPolicyReadOnly() === true, 'the store is still locked after all of that');

// ---------------------------------------------------------------------------
// 6. The hook-contract change: an unknown capability is not automatically ungoverned
//
// Driven through the real deny-list file, because that file IS the interface — the hook runs in the
// agent's environment and cannot read the server's configuration, so anything this test asserted
// through a function argument instead would be asserting a path the hook never takes.
// ---------------------------------------------------------------------------

const hooks = require('../hooks/lib');

function stageDenyList({ authority, ageMs }) {
  replica.saveDenyList({
    denyList: { grantIds: [], pairs: [], principals: [] },
    version: 40,
    fetchedAt: ageMs === null ? null : Date.now() - ageMs,
    central: authority === 'central',
    authority,
  });
}

stageDenyList({ authority: 'central', ageMs: 5_000 });
{
  const posture = hooks.policyPosture();
  check(posture.replicating && !posture.stale, 'a freshly-pulled replica reads as replicating and current');
}

stageDenyList({ authority: 'central', ageMs: hooks.MAX_POLICY_AGE_MS + 60_000 });
{
  const posture = hooks.policyPosture();
  check(posture.replicating && posture.stale, 'a replica past MAX_POLICY_AGE reads as stale');
}

stageDenyList({ authority: 'central', ageMs: null });
{
  const posture = hooks.policyPosture();
  check(
    posture.stale,
    'a node that has NEVER confirmed policy is stale, not fresh — "never" is the strongest form of old'
  );
}

stageDenyList({ authority: 'node', ageMs: null });
{
  const posture = hooks.policyPosture();
  check(
    !posture.replicating && !posture.stale,
    'a standalone install is neither replicating nor stale — its own database is the authority'
  );
}

// The decision itself. `findCapability` is driven off the hook's capability cache, which this test
// leaves empty on purpose: an empty cache and a server that answers "no such capability" are the
// same input to the branch under test, and the branch is what changed.
async function decideFor(posture) {
  stageDenyList(posture);
  let decision = null;
  let reason = null;
  await hooks.runPreToolUse({
    toolName: 'mcp__unregistered__tool',
    toolInput: {},
    sessionId: 'authority-test',
    decideFn: (d, r) => { decision = d; reason = r; },
  });
  return { decision, reason };
}

(async () => {
  const stale = await decideFor({ authority: 'central', ageMs: hooks.MAX_POLICY_AGE_MS + 60_000 });
  check(
    stale.decision === 'deny' && /governance:fault\/not-replicated/.test(stale.reason || ''),
    'an unknown capability on a STALE replica fails closed as a fault, not as a denial',
    `${stale.decision}: ${stale.reason}`
  );
  check(
    /NOT a permission denial/.test(stale.reason || ''),
    'and the agent is told outright that no grant is missing, so it does not go and ask for one'
  );

  const fresh = await decideFor({ authority: 'central', ageMs: 5_000 });
  check(
    fresh.decision === 'allow',
    'the same call on a CURRENT replica is ungoverned and allowed, exactly as before phase 4',
    `${fresh.decision}: ${fresh.reason}`
  );

  const standalone = await decideFor({ authority: 'node', ageMs: null });
  check(
    standalone.decision === 'allow',
    'and a standalone install is untouched by any of this'
  );

  console.log(failures === 0 ? '\nall authority checks passed' : `\n${failures} check(s) FAILED`);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
  process.exit(failures === 0 ? 0 : 1);
})();
