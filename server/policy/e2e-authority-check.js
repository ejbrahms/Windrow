// A live end-to-end check of the phase-4 flip: a node in replica mode, a real central, and one
// grant travelling node → central → back into the node's own tables.
//
//   docker compose -f server/central/docker-compose.yml up -d
//   WINDROW_CENTRAL_DB_URL=postgres://windrow:windrow@localhost:5432/windrow_central \
//     WINDROW_CENTRAL_ALLOW_INSECURE=1 npm run central --prefix server
//   WINDROW_CENTRAL_URL=http://127.0.0.1:5000 npm run e2e:authority --prefix server
//
// WHY THIS EXISTS ALONGSIDE ./authority-test.js AND ../central/policy-smoke.js. Those two assert the
// halves: the node's lock and applier with no network, and central's minting and deltas with no
// node. Each is fast, deterministic and runs in CI. Neither can catch the thing that only exists
// between them — that a write leaves the node, is accepted by central as the row central expects,
// comes back down the delta stream, and lands in the tables the broker actually reads. Every field
// name in that round trip is agreed in two files, and two files are what drift.
//
// It SKIPS rather than fails when there is no central to talk to, for the same reason the smokes do:
// a developer with no Postgres must see "not exercised", never a green tick for work that did not
// happen.

process.env.WINDROW_POLICY_AUTHORITY = 'central';

const { envCompat } = require('../config');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`     ${detail}`);
}

async function main() {
  if (!CENTRAL_URL) {
    console.log(
      '[e2e:authority] SKIPPED — WINDROW_CENTRAL_URL is not set, so there is no authority to flip to.\n'
        + '  Nothing about the node↔central round trip was exercised by this run.'
    );
    return 0;
  }

  const store = require('../store');
  const policy = require('./index');
  const centralPolicyStore = require('./centralPolicyStore');
  const { startPolicyClient, stopPolicyClient, pullNow, policyClientStatus } = require('./policyClient');

  // Exactly what server/index.js does at boot, in the same order and for the same reasons.
  policy.setBackends({ policyStore: centralPolicyStore });
  store.setPolicyReadOnly(true);
  startPolicyClient();

  // Reachability first, and separately: every later failure would otherwise read as a bug in the
  // flip when it is a central nobody started.
  try {
    await pullNow();
  } catch (err) {
    console.log(`[e2e:authority] SKIPPED — could not reach central at ${CENTRAL_URL}: ${err.message}`);
    stopPolicyClient();
    return 0;
  }
  const initial = policyClientStatus();
  ok(initial.authority === 'central', 'the node reports itself as replicating from central');
  ok(Number.isFinite(initial.mirrorVersion), 'and the local mirror has a version', JSON.stringify(initial));

  // A name unique to this run, so repeated runs against one central do not collide on
  // UNIQUE(kind, name) and report a conflict as a failure of the round trip.
  const stamp = process.hrtime.bigint().toString(36);
  const capName = `e2e/${stamp}`;
  const roleName = `e2e-role-${stamp}`;

  // ---- the round trip -------------------------------------------------------
  const capability = await policy.policyStore.insertCapability({
    kind: 'mcp_tool', name: capName, riskTier: 'mutating', description: 'e2e authority check',
  });
  ok(/^cap_[0-9a-f]{12}$/.test(capability.id), 'the capability id came back from central', capability.id);
  ok(
    store.findCapabilityById(capability.id) !== null,
    'and the row is already in the NODE tables — the write pulled its own change back down'
  );

  const principal = await policy.policyStore.insertPrincipal({ kind: 'role', name: roleName, status: 'active' });
  const grant = await policy.policyStore.insertGrant({ principalId: principal.id, capabilityId: capability.id });
  ok(
    Boolean(store.findGrant(principal.id, capability.id)),
    'a grant issued through the node is live in the table the broker reads'
  );

  // ---- the property the whole design exists for -----------------------------
  await policy.policyStore.revokeGrant(grant.id, 'e2e');
  ok(
    store.findGrant(principal.id, capability.id) === null,
    'and revoking it centrally removes it from the node’s live-grant lookup'
  );
  const replica = require('./replica');
  const deny = replica.loadDenyList();
  ok(
    Boolean(deny) && deny.grantIds.includes(grant.id),
    'the revoked grant is on the deny-list the hook reads on every governed call',
    JSON.stringify(deny && deny.grantIds)
  );
  ok(
    deny.authority === 'central',
    'and the deny-list tells the hook that this node is a replica — the marker the unknown-capability rule reads'
  );

  // ---- the lock, from the other side ---------------------------------------
  let refused = null;
  try {
    store.insertGrant({ id: 'gr_e2e_local', principalId: principal.id, capabilityId: capability.id, createdAt: 'now' });
  } catch (err) {
    refused = err;
  }
  ok(
    refused instanceof store.PolicyReadOnlyError,
    'a direct local write is still refused while all of that is working',
    refused ? refused.message : 'it was NOT refused — the lock is off on a live replica node'
  );

  stopPolicyClient();
  console.log(`\n[e2e:authority] ${checks - failures}/${checks} checks passed.`);
  return failures ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[e2e:authority] threw:', err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { main };
