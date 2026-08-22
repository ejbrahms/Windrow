#!/usr/bin/env node
'use strict';
// Repairs principals whose LIFECYCLE status is a word the lifecycle does not have.
//
// WHY THIS EXISTS. `policyDenyList` (server/store.js, server/central/policyStore.js) blocks every
// principal whose status is not 'active', and the hook checks that deny-list *before* the grant
// check — so a bad word in that column is a hard deny of every governed call the agent makes, at
// every tier, reported to it as "has been revoked", and no grant can clear it.
//
// One caller wrote such a word: the node's setPrincipalOwner forwarded the OWNER decision
// ('confirmed' | 'dismissed' | 'unassigned' — who a human says this agent belongs to) into
// central's PATCH route, whose only `status` column is the lifecycle one. Confirming an agent's
// owner in the dashboard therefore switched that agent off fleet-wide. Fixed at the source in
// server/policy/centralPolicyStore.js and made unwritable in server/central/policyStore.js; this
// script repairs the rows already written.
//
//   node scripts/repair-principal-status.js            # report only
//   node scripts/repair-principal-status.js --apply    # set them back to 'active'
//
// It goes through central's API rather than its database so the change rides the policy-change log
// and reaches every node's replica and deny-list by the normal channel — a row written behind the
// log is a row no delta can correct.

const CENTRAL = process.env.WINDROW_CENTRAL_URL || 'http://127.0.0.1:5000';
const APPLY = process.argv.includes('--apply');

// The whole lifecycle vocabulary. Anything else is the bug this repairs.
const VALID = new Set(['active', 'pending', 'denied']);

async function api(method, path, body) {
  const res = await fetch(`${CENTRAL}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

(async () => {
  const principals = await api('GET', '/policy/principals');
  const broken = principals.filter((p) => !VALID.has(p.status));

  if (!broken.length) {
    console.log(`No principals carry an invalid status. Checked ${principals.length}.`);
    return;
  }

  console.log(`${broken.length} principal(s) carry a status outside the lifecycle vocabulary:\n`);
  for (const p of broken) {
    console.log(`  ${p.id}  ${p.kind.padEnd(8)} ${(p.humanName || p.name).padEnd(34)} status="${p.status}"`);
  }

  if (!APPLY) {
    console.log('\nEvery one of these is on the deny-list and cannot make a governed call.');
    console.log('Re-run with --apply to set them back to "active".');
    return;
  }

  console.log('');
  for (const p of broken) {
    // eslint-disable-next-line no-await-in-loop
    await api('PATCH', `/policy/principals/${encodeURIComponent(p.id)}`, {
      status: 'active',
      reason: `repair: "${p.status}" is an owner decision, not a lifecycle status (scripts/repair-principal-status.js)`,
    });
    console.log(`  restored ${p.id} (${p.humanName || p.name}) -> active`);
  }
  console.log('\nDone. Each node picks this up on its next policy poll, which also rewrites its deny-list.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
