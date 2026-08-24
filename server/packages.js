'use strict';
// Capability packages — docs/design/capability-packages.md.
//
// Replaces the failure mode that caused a 21-capability default-grant gap (`wispfield_close_loom`,
// `wispfield_report_task_complete`, and every governance lookup tool shipped with zero grants
// because seed.js's addGrants(...) calls are hand-maintained and nothing forced them to stay in
// sync with new capabilities): a package binds a capability *owner* to a default policy, so a new
// capability under an already-enabled owner picks up that policy the moment discovery finds it,
// not the next time someone happens to audit by hand.
//
// A package is defined in code, not a database row — the policy is a deliberate per-owner
// decision (which risk tiers auto-grant vs. need a curated include-list), not user data. That
// definition now lives in ./packageDefs.js so the central authority can read the same list without
// pulling this file's node-only `require('./store')`. What *is* persisted here (server/store.js's
// `packages_enabled` kv row) is which packages are turned on for this workspace, since "not every
// workspace uses wispfield" (docs/design/capability-packages.md §4).
//
// THIS FILE IS THE NODE'S IMPLEMENTATION. Under central authority the fleet-wide equivalent is
// server/central/packages.js, which acts the same package list against central's policy tables so
// the grants replicate to every node. This one still runs for a standalone install, where the node
// is its own authority.

const store = require('./store');
const { genId } = require('./id');
const { currentOsUser, currentHostname } = require('./principals/fromEnv');
// The package list, DEFAULT_ROLES and normalizePolicy live in ./packageDefs.js so central can read
// them without pulling this file's `require('./store')` (better-sqlite3) into its process (the same
// reason server/central/policyStore.js re-declares RISK_TIERS rather than importing app.js).
const { PACKAGES, normalizePolicy, findPackage } = require('./packageDefs');

// Audit actor for package-driven grant changes — sync/revoke run in-process on this server, triggered by an admin toggling a package on the
// Providers page, so there's no request to read a token scope off; 'package' marks these rows as
// policy-driven rather than a human directly issuing/revoking one grant at a time.
function auditActor() {
  return { actorScope: 'package', osUser: currentOsUser(process.env), hostname: currentHostname(process.env) };
}

function getEnabledMap() {
  const stored = store.getPackagesState();
  const map = {};
  for (const pkg of PACKAGES) {
    map[pkg.id] = stored && Object.prototype.hasOwnProperty.call(stored, pkg.id) ? Boolean(stored[pkg.id]) : pkg.enabledByDefault;
  }
  return map;
}

function setEnabled(id, enabled) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const map = getEnabledMap();
  map[id] = enabled;
  store.setPackagesState(map);
  return map[id];
}

/** Capabilities this package could grant, i.e. every capability whose owner it claims. */
function eligibleCapabilities(pkg) {
  if (!pkg.owners.length) return [];
  return store.listCapabilities().filter((c) => pkg.owners.includes(c.owner));
}

/**
 * Grants every eligible capability's policy-included tier to the package's role principals.
 * Idempotent — findGrant/insertGrant's UNIQUE(principalId, capabilityId) means a re-run only adds
 * what's missing, same as running this by hand with grant_capability (which is exactly what this
 * replaces). Returns counts, not the grants themselves — the dashboard just needs "did anything
 * change," not a list to render.
 */
function syncPackage(id) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  const now = new Date().toISOString();
  let granted = 0;
  let alreadyPresent = 0;
  let skipped = 0;

  for (const cap of eligibleCapabilities(pkg)) {
    const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
    const included =
      policy.mode === 'auto' ||
      (policy.mode === 'explicit' && policy.include.includes(cap.name));
    if (!included) {
      skipped++;
      continue;
    }
    for (const roleName of policy.roles) {
      const role = roleByName.get(roleName);
      if (!role) continue; // this role hasn't been seen on this workspace yet — nothing to grant
      if (store.findGrant(role.id, cap.id)) {
        alreadyPresent++;
        continue;
      }
      const grant = {
        id: genId('gr'),
        principalId: role.id,
        capabilityId: cap.id,
        constraints: null,
        createdAt: now,
        expiresAt: null,
      };
      store.insertGrant(grant);
      store.insertAuditEntry({
        action: 'grant_issue',
        ...auditActor(),
        principalId: role.id,
        capabilityId: cap.id,
        grantId: grant.id,
        after: grant,
        reason: `synced by package ${pkg.id}`,
      });
      granted++;
    }
  }
  return { packageId: id, granted, alreadyPresent, skipped };
}

/**
 * The explicit teardown counterpart to syncPackage: deletes every grant this package could have
 * issued — any (eligible capability × package role) pair currently granted, not just the ones the
 * current policy would auto-grant, since a grant made explicit by policy or by hand under this
 * package's ownership is still this package's to revoke. Disable alone deliberately doesn't do
 * this (server/app.js's /disable comment) so an in-flight agent isn't cut off by a config toggle;
 * this is the separate, deliberate "actually take it back" action for when that's what's wanted.
 */
function revokePackage(id) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  let revoked = 0;

  for (const cap of eligibleCapabilities(pkg)) {
    for (const roleName of pkg.roles) {
      const role = roleByName.get(roleName);
      if (!role) continue;
      const grant = store.findGrant(role.id, cap.id);
      if (!grant) continue;
      const after = store.revokeGrant(grant.id, `package:${pkg.id}`);
      if (!after) continue;
      store.insertAuditEntry({
        action: 'grant_revoke',
        ...auditActor(),
        principalId: role.id,
        capabilityId: cap.id,
        grantId: grant.id,
        before: grant,
        after,
        reason: `revoked by package ${pkg.id}`,
      });
      revoked++;
    }
  }
  return { packageId: id, revoked };
}

/** One row per package for the Providers & Integrations page: status + how much is covered. */
function listPackagesWithStatus() {
  const enabledMap = getEnabledMap();
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  return PACKAGES.map((pkg) => {
    const caps = eligibleCapabilities(pkg);
    let policyEligible = 0;
    let granted = 0;
    for (const cap of caps) {
      const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
      const included = policy.mode === 'auto' || (policy.mode === 'explicit' && policy.include.includes(cap.name));
      if (!included) continue;
      for (const roleName of policy.roles) {
        const role = roleByName.get(roleName);
        if (!role) continue;
        policyEligible++;
        if (store.findGrant(role.id, cap.id)) granted++;
      }
    }
    return {
      id: pkg.id,
      kind: pkg.kind,
      label: pkg.label,
      description: pkg.description,
      owners: pkg.owners,
      roles: pkg.roles,
      enabled: enabledMap[pkg.id],
      capabilityCount: caps.length,
      coverage: { granted, total: policyEligible },
    };
  });
}

module.exports = {
  PACKAGES,
  findPackage,
  getEnabledMap,
  setEnabled,
  syncPackage,
  revokePackage,
  listPackagesWithStatus,
};
