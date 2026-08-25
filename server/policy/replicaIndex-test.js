// Verification for the in-memory replica index — step 1 of docs/design/retiring-sqlite-on-the-node.md.
// Run it with: node server/policy/replicaIndex-test.js  (npm run test:replica-index --prefix server)
//
// The index is a read-through cache of the three replica tables, rebuilt on every policy pull. Its
// whole safety argument is PARITY: a read served from the Map must be byte-for-byte the answer the
// prepared statement would have given, and it must stay so across the node-local writes that happen
// between pulls (discovery scans, owner decisions). This file asserts that, and asserts the escape
// hatch — WINDROW_REPLICA_INDEX=off drops straight back to SQLite with the same answers — by running
// the SAME assertion body under both settings: the parent runs with the index on (its default),
// then re-execs itself with it off. If the two disagree on any read, the ship is not reversible.
//
// Nothing here needs a network, a central, or Postgres: applyPolicyReplica is the local applier and
// the index sits behind the same reads the hot path (server/app.js's findActiveGrant) uses.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const indexOn = process.env.WINDROW_REPLICA_INDEX !== 'off';
const label = indexOn ? 'index ON ' : 'index OFF';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-replica-index-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const store = require('../store');

let failures = 0;
function check(ok, name, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${label}] ${name}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

const now = new Date().toISOString();

// A capability with node-local discovery state set while still authoritative, so we can prove the
// index carries the local columns through and not just central's.
store.insertCapability({
  id: 'cap_a', kind: 'mcp_tool', name: 'a/tool', owner: null, riskTier: 'mutating', description: 'A',
  source: 'discovery', discoveredAt: now, lastSeenAt: now, stale: 0, realUsage: null, autoGrant: 0,
});
store.insertPrincipal({ id: 'role_a', kind: 'role', name: 'agent', parentRole: null, status: 'active' });
store.insertPrincipal({ id: 'inst_a', kind: 'instance', name: 'loom-1', parentRole: 'agent', status: 'active' });
store.insertPrincipal({ id: 'user_a', kind: 'user', name: 'ejbra', subjectId: 'sid-123', status: 'active' });
store.insertGrant({ id: 'gr_a', principalId: 'role_a', capabilityId: 'cap_a', constraints: null, createdAt: now, expiresAt: null });

// Flip to replica mode and re-materialise the very same rows through the applier — this is the pull
// that builds the index (when on). Everything below reads through whichever path the flag selects.
store.setPolicyReadOnly(true);
store.applyPolicyReplica({
  reset: true,
  version: 7,
  capabilities: [{ id: 'cap_a', kind: 'mcp_tool', name: 'a/tool', owner: null, riskTier: 'mutating', description: 'A', autoGrant: false }],
  principals: [
    { id: 'role_a', kind: 'role', name: 'agent', subjectId: null, parentRole: null, standalone: false, status: 'active' },
    { id: 'inst_a', kind: 'instance', name: 'loom-1', subjectId: null, parentRole: 'agent', standalone: false, status: 'active' },
    { id: 'user_a', kind: 'user', name: 'ejbra', subjectId: 'sid-123', parentRole: null, standalone: false, status: 'active' },
  ],
  grants: [{ id: 'gr_a', principalId: 'role_a', capabilityId: 'cap_a', constraints: null, createdAt: now, expiresAt: null, revokedAt: null, revokedBy: null }],
});

// --- the reads the hot path and the dashboard use ---
check(store.findGrant('role_a', 'cap_a') !== null, 'findGrant returns the live grant');
check(store.findGrant('inst_a', 'cap_a') === null, 'findGrant does not confuse an instance with its role');
check(store.findGrantById('gr_a') !== null, 'findGrantById resolves');
check(store.findPrincipalByKindName('role', 'agent')?.id === 'role_a', 'findPrincipalByKindName resolves the role the broker inherits through');
check(store.findPrincipalByKindName('role', 'missing') === null, 'findPrincipalByKindName returns null for an unknown pair');
check(store.findPrincipalBySubjectId('sid-123')?.id === 'user_a', 'findPrincipalBySubjectId resolves the subject');
check(store.findPrincipalBySubjectId('nope') === null, 'findPrincipalBySubjectId returns null for an unknown subject');
check(store.findCapabilityById('cap_a')?.riskTier === 'mutating', 'findCapabilityById carries the tier');
check(store.listCapabilities().length === 1, 'listCapabilities returns the mirror');
check(store.listPrincipals().length === 3, 'listPrincipals returns every mirrored principal');
check(store.listGrants().length === 1, 'listGrants (active) returns the live grant');
check(store.listGrants({ principalId: 'role_a' }).length === 1, 'listGrants filtered by principal');
check(store.listGrants({ capabilityId: 'cap_a' }).length === 1, 'listGrants filtered by capability');
check(store.listGrants({ principalId: 'inst_a' }).length === 0, 'listGrants filtered by a principal with no grants');

// A returned list must not be the cache's own array — a caller sorting it must not reorder the mirror.
const caps = store.listCapabilities();
caps.push({ id: 'poison' });
check(store.listCapabilities().length === 1, 'a mutated list result does not corrupt the index');

// --- freshness across a node-local write between pulls ---
// setCapabilityDiscoveryState writes columns the index also serves; the index must reflect it at
// once, not at the next pull, or the dashboard shows a stale "last seen".
const later = new Date(Date.now() + 60_000).toISOString();
store.setCapabilityDiscoveryState('cap_a', { source: 'discovery', discoveredAt: now, lastSeenAt: later, stale: true });
check(store.findCapabilityById('cap_a')?.lastSeenAt === later, 'a discovery write is visible immediately (index refreshed, not stale)');
check(store.findCapabilityById('cap_a')?.stale === true, 'and the stale flag comes back as a boolean, not a 1');

// setPrincipalOwnerLocal writes owner columns the index serves — a confirm must show at once.
store.setPrincipalOwnerLocal('inst_a', { status: 'confirmed', osUser: 'ejbra', ownerPrincipalId: 'user_a', decidedByScope: 'admin' });
check(store.findPrincipalById('inst_a')?.ownerStatus === 'confirmed', 'an owner decision is visible immediately');

// --- a revoke arriving on the next pull ---
store.applyPolicyReplica({
  reset: false,
  version: 8,
  grants: [{ id: 'gr_a', principalId: 'role_a', capabilityId: 'cap_a', constraints: null, createdAt: now, expiresAt: null, revokedAt: new Date().toISOString(), revokedBy: 'admin' }],
});
check(store.findGrant('role_a', 'cap_a') === null, 'after a replicated revoke the live-grant lookup finds nothing');
check(store.findGrantById('gr_a')?.revokedAt != null, 'while the soft-deleted row is still there by id');
check(store.listGrants().length === 0, 'and it drops out of the active list');
check(store.listGrants({ includeRevoked: true }).length === 1, 'but remains in the history list');

// --- leaving replica mode falls back to SQLite with the same answers ---
store.setPolicyReadOnly(false);
check(store.findCapabilityById('cap_a') !== null, 'reads still work after leaving replica mode');
check(store.findGrantById('gr_a')?.revokedAt != null, 'and see the same SQLite the index was mirroring');

// Re-exec ourselves with the index off to prove the escape hatch answers identically. Only the
// parent (index on) spawns; the child sets nothing further and just runs the body above.
if (indexOn && failures === 0) {
  const child = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, WINDROW_REPLICA_INDEX: 'off', WINDROW_DB_PATH: '', WINDROW_CA_DIR: '', WINDROW_BOOTSTRAP_TOKEN_PATH: '' },
  });
  if (child.status !== 0) failures += 1;
}

try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
if (indexOn) console.log(failures === 0 ? '\nall replica-index checks passed (both settings)' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
