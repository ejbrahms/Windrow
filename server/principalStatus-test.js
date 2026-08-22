// Verification for the PRINCIPAL LIFECYCLE STATUS column — the one field that can switch an agent
// off fleet-wide without anybody revoking anything.
// Run it with: node server/principalStatus-test.js  (npm run test:principal-status --prefix server)
//
// WHAT WENT WRONG. Two vocabularies met on one column name. `store.setPrincipalOwner` takes an
// OWNER decision — 'confirmed' | 'dismissed' | 'unassigned', a human saying which person an agent
// belongs to — and the node's central adapter forwarded that word to central's PATCH route as
// `status`, whose only status column is the LIFECYCLE one ('active' | 'pending' | 'denied').
//
// `policyDenyList` blocks every principal whose status is not 'active', and server/hooks/lib.js
// checks that deny-list BEFORE the grant check, deliberately, so that a revocation cannot be
// out-granted. So confirming an agent's owner in the dashboard put that agent on the always-full
// deny list: every governed call it made was denied, at every tier, and it was told its access
// "has been revoked". Issuing grants could not clear it. Four looms on this machine were switched
// off this way, and nothing in the product said so.
//
// THREE PROPERTIES:
//
//   1. THE OWNER DECISION NEVER CROSSES AS A LIFECYCLE STATUS. Asserted against the adapter's own
//      source, because the mistake was a single key in a request body — there is no behaviour to
//      observe between "sends it" and "does not" short of a live central.
//   2. CENTRAL REFUSES A STATUS OUTSIDE THE LIFECYCLE. The caller is fixed; this is the barrier
//      that makes the *next* caller unable to repeat it. It must refuse before touching the
//      database, so a rejected patch cannot half-apply.
//   3. THE REAL STATUSES STILL PASS. A guard that also blocks 'active'/'pending'/'denied' would
//      break approving and denying agents, which is the same outage from the other side.

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
}

// 1. The adapter does not forward the owner decision as a lifecycle status.
{
  const source = fs.readFileSync(path.join(__dirname, 'policy', 'centralPolicyStore.js'), 'utf8');
  const body = source.slice(source.indexOf('setPrincipalOwner:'), source.indexOf('upsertPrincipalIdentity:'));
  check(body.length > 0, '1. setPrincipalOwner is still where this test looks for it');
  check(
    !/^\s*status,?\s*$/m.test(body),
    '1. setPrincipalOwner does not forward the owner decision as `status`',
    'the owner vocabulary is confirmed/dismissed/unassigned; the column is active/pending/denied'
  );
  check(/owner:/.test(body), '1. ...it still sends the owner itself');
}

// 2 & 3. Central refuses a status outside the lifecycle, and lets the real ones through.
async function centralGuard() {
  // A driver that fails the test if it is reached: an invalid patch must be refused before any
  // query runs, not rolled back after one.
  const untouchableDriver = {
    withTransaction: () => {
      throw new Error('the database was reached for a patch that should have been refused outright');
    },
  };
  const central = require('./central/policyStore');

  // `untouchableDriver` throws if reached, so "refused before any query" is asserted by the
  // rejection carrying the guard's own message rather than the driver's.
  const refuse = async (status) => {
    try {
      await central.updatePrincipal(untouchableDriver, 'pr_x', { status });
      return null;
    } catch (err) {
      return err;
    }
  };

  for (const bad of ['confirmed', 'dismissed', 'unassigned']) {
    // eslint-disable-next-line no-await-in-loop
    const err = await refuse(bad);
    check(Boolean(err), `2. central refuses status "${bad}"`, 'it was accepted');
    check(err ? err.status === 400 : false, '2. ...as a caller error, not a 500', err ? String(err.status) : 'n/a');
    check(
      err ? /deny.list|active/i.test(err.message) : false,
      '2. ...refused before the database was touched, saying what it would have cost',
      err ? err.message : 'n/a'
    );
  }

  for (const good of ['active', 'pending', 'denied']) {
    let reachedDb = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      await central.updatePrincipal(
        { withTransaction: () => { reachedDb = true; return Promise.resolve(null); } },
        'pr_x',
        { status: good }
      );
    } catch (err) {
      check(false, `3. status "${good}" is still accepted`, err.message);
    }
    check(reachedDb, `3. status "${good}" is still accepted and reaches the database`);
  }
}

centralGuard().then(() => {
  console.log(failures === 0 ? '\nAll principal-status properties hold.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
