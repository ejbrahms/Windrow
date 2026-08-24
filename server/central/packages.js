'use strict';

// CENTRAL'S CAPABILITY PACKAGES — the fleet-wide half of server/packages.js.
//
// Same package list (../packageDefs.js), same "enable a package → grant its owner's capabilities to
// its roles" behaviour, but acting on the AUTHORITY's tables (./policyStore.js) instead of one
// machine's SQLite. That single difference is the whole feature: every grant this writes appends to
// `policy_changes` in the same transaction, so it replicates to every node down the delta stream
// server/central/policyRoutes.js already serves. Enabling the Gmail integration here grants Gmail's
// read-only tools to the default roles once, on central, and thirty nodes learn it on their next
// poll. Nothing new ships the decision; the grants ARE the decision, and grants already travel.
//
// ASYNC, like everything in ./policyStore.js and for the same reason (../central/pgDriver.js: no
// synchronous Postgres client). Every caller is a route on the central process, off the hot path.
//
// WHY NOT REUSE server/packages.js. That file `require('./store')` at load — better-sqlite3 and the
// node's data directory — which must never enter the central process. So the DATA (the package list)
// is shared through ../packageDefs.js and the two IMPLEMENTATIONS stay apart, exactly the split
// ./policyStore.js makes against ../app.js.

const { PACKAGES, normalizePolicy, findPackage } = require('../packageDefs');
const policyStore = require('./policyStore');

/** Which packages are enabled, merging the `package_state` table over each package's default. A
 *  package with no row falls back to its `enabledByDefault` in code, so a package newly added to the
 *  defs is on/off by its own default until someone decides — the same rule as the node's. */
async function getEnabledMap(driver) {
  const rows = await driver.all('SELECT "id", "enabled" FROM package_state');
  const stored = new Map(rows.map((r) => [r.id, Boolean(r.enabled)]));
  const map = {};
  for (const pkg of PACKAGES) {
    map[pkg.id] = stored.has(pkg.id) ? stored.get(pkg.id) : pkg.enabledByDefault;
  }
  return map;
}

/** Record the on/off decision. Not a policy change — the node never reads this; it reads the grants
 *  the decision produces. See centralMigrations.js migration 11. */
async function setEnabled(driver, id, enabled, updatedByScope = null) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  await driver.query(
    `INSERT INTO package_state ("id", "enabled", "updatedAt", "updatedByScope")
     VALUES ($1, $2, now(), $3)
     ON CONFLICT ("id") DO UPDATE SET
       "enabled" = EXCLUDED."enabled",
       "updatedAt" = now(),
       "updatedByScope" = EXCLUDED."updatedByScope"`,
    [id, Boolean(enabled), updatedByScope]
  );
  return Boolean(enabled);
}

/** Capabilities this package could grant — every central capability whose owner it claims. */
function eligibleCapabilities(pkg, allCapabilities) {
  if (!pkg.owners.length) return [];
  return allCapabilities.filter((c) => pkg.owners.includes(c.owner));
}

/** role-name → principal row, for the role principals a package grants to. */
function roleIndex(allPrincipals) {
  return new Map(allPrincipals.filter((p) => p.kind === 'role').map((p) => [p.name, p]));
}

/** Live grants keyed `${principalId}:${capabilityId}` → grant row. One read, so a sync over dozens
 *  of (capability × role) pairs is not dozens of `findGrant` round-trips. */
function liveGrantIndex(allGrants) {
  const idx = new Map();
  for (const g of allGrants) {
    if (g.revokedAt == null) idx.set(`${g.principalId}:${g.capabilityId}`, g);
  }
  return idx;
}

/**
 * Grant every eligible capability's policy-included tier to the package's role principals — the
 * counterpart of server/packages.js `syncPackage`, writing central's tables so the grants replicate.
 * Idempotent: policyStore.insertGrant's live UNIQUE(principalId, capabilityId) means a re-run only
 * adds what is missing, and the pre-read `live` index skips the round-trip for pairs already granted.
 * Returns counts, not rows.
 *
 * AUTO-GRANT PROPAGATION. When this issues at least one new grant, it propagates to every node
 * connected to central inside the propagation window (policyStore.propagateToConnected) and returns
 * the set under `propagation`. The grant reaches every node either way — it is on the delta stream —
 * so this is not a second delivery path; it is the answer to "which boxes have it now", captured at
 * issue time and written to the audit log so enabling a package leaves a record of where it landed
 * and who is still catching up. A pure re-sync that grants nothing propagates nothing.
 */
async function syncPackage(driver, id, { actorScope = 'package' } = {}) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const [caps, principals, grants] = await Promise.all([
    policyStore.listCapabilities(driver),
    policyStore.listPrincipals(driver),
    policyStore.listGrants(driver),
  ]);
  const roleByName = roleIndex(principals);
  const live = liveGrantIndex(grants);
  let granted = 0;
  let alreadyPresent = 0;
  let skipped = 0;

  for (const cap of eligibleCapabilities(pkg, caps)) {
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
      if (!role) continue; // this role hasn't been registered fleet-wide yet — nothing to grant
      if (live.has(`${role.id}:${cap.id}`)) {
        alreadyPresent++;
        continue;
      }
      try {
        const grant = await policyStore.insertGrant(driver, { principalId: role.id, capabilityId: cap.id });
        await policyStore.recordAuditEntry(driver, {
          action: 'grant_issue',
          actorScope,
          principalId: role.id,
          capabilityId: cap.id,
          grantId: grant.id,
          after: grant,
          reason: `synced by package ${pkg.id}`,
        });
        granted++;
      } catch (err) {
        // A concurrent grant for the same pair (another admin, or a re-run racing itself) is the
        // idempotent case arriving out of order, not a failure — count it as already present.
        if (err instanceof policyStore.GrantConflictError) alreadyPresent++;
        else throw err;
      }
    }
  }
  // Propagate only what this run actually created. A re-sync that found everything already granted
  // has issued no new policy and has nothing to land on a node, so it reports no propagation rather
  // than a poke that would tell the fleet to pull a version it already holds.
  let propagation = null;
  if (granted > 0) {
    propagation = await policyStore.propagateToConnected(driver, await policyStore.policyVersion(driver));
    await policyStore.recordAuditEntry(driver, {
      action: 'grant_propagate',
      actorScope,
      after: propagation,
      reason: `package ${pkg.id}: ${granted} new grant(s) propagated to ${propagation.connected} connected node(s)`,
    });
  }
  return { packageId: id, granted, alreadyPresent, skipped, propagation };
}

/**
 * The explicit teardown — revoke every grant this package could have issued (any eligible
 * capability × package role currently granted), the counterpart of server/packages.js
 * `revokePackage`. A revoke is a soft delete that rides the always-full deny-list, so it lands on a
 * node even if its delta stream is broken. Disable does NOT call this, on purpose: a config toggle
 * must not cut an in-flight agent off; this is the deliberate "actually take it back".
 */
async function revokePackage(driver, id, { actorScope = 'package' } = {}) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const [caps, principals, grants] = await Promise.all([
    policyStore.listCapabilities(driver),
    policyStore.listPrincipals(driver),
    policyStore.listGrants(driver),
  ]);
  const roleByName = roleIndex(principals);
  const live = liveGrantIndex(grants);
  let revoked = 0;

  for (const cap of eligibleCapabilities(pkg, caps)) {
    for (const roleName of pkg.roles) {
      const role = roleByName.get(roleName);
      if (!role) continue;
      const grant = live.get(`${role.id}:${cap.id}`);
      if (!grant) continue;
      const after = await policyStore.revokeGrant(driver, grant.id, `package:${pkg.id}`);
      if (!after) continue;
      await policyStore.recordAuditEntry(driver, {
        action: 'grant_revoke',
        actorScope,
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

/** Risk tiers in their reading order — read the least dangerous first, exactly as the dashboard's
 *  grant pages group. Kept local rather than imported so this file's one dependency stays the
 *  package defs; policyStore holds the canonical copy the API type mirrors. */
const TIER_ORDER = ['read_only', 'mutating', 'destructive'];

/**
 * ONE PACKAGE IN FULL — the drill-down behind the Integrations & Providers card.
 *
 * The list view (`listPackagesWithStatus`) answers "how much of this integration is granted"; this
 * answers the question the aggregate cannot — "which capability, to which role, and let me change
 * exactly that one." It is the same (capability × role) pairs `syncPackage` iterates, but returned
 * rather than acted on: each owned capability, grouped by tier, crossed with the roles that
 * capability's tier policy targets (the per-tier `roles` override respected, so claude-design's
 * mutating tools show only design-agent, not every default role), with the live grant beside each.
 *
 * `included` marks the pairs a Sync would grant — a row the default policy skips still appears, but
 * reads as off-by-design rather than merely ungranted, so an admin can tell "the package never
 * grants this" from "nobody has yet." The toggle a caller wires to each pair is the ordinary
 * /api/policy/grants create/revoke, so nothing new replicates through here; this only reads.
 */
async function packageDetail(driver, id) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const [enabledMap, caps, principals, grants] = await Promise.all([
    getEnabledMap(driver),
    policyStore.listCapabilities(driver),
    policyStore.listPrincipals(driver),
    policyStore.listGrants(driver),
  ]);
  const roleByName = roleIndex(principals);
  const live = liveGrantIndex(grants);

  /** A role name resolved to the principal a grant would target — null where no node has registered
   *  that role fleet-wide yet, which the caller draws as present-but-not-toggleable. */
  const resolveRole = (name) => {
    const principal = roleByName.get(name) || null;
    return { roleName: name, principalId: principal ? principal.id : null, registered: Boolean(principal) };
  };

  // The union of every role the package targets across all its tiers — the header roster. A tier's
  // own `roles` override can name a role the package-level list does not (design-agent), so both are
  // folded in rather than trusting `pkg.roles` alone.
  const roleNames = new Set(pkg.roles);
  for (const tier of TIER_ORDER) {
    for (const r of normalizePolicy(pkg.policy[tier], pkg.roles).roles) roleNames.add(r);
  }
  const roles = [...roleNames].sort().map(resolveRole);

  const byTier = new Map();
  for (const cap of eligibleCapabilities(pkg, caps)) {
    const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
    const included =
      policy.mode === 'auto' || (policy.mode === 'explicit' && policy.include.includes(cap.name));
    const capRoles = policy.roles.map((roleName) => {
      const ref = resolveRole(roleName);
      const grant = ref.principalId ? live.get(`${ref.principalId}:${cap.id}`) || null : null;
      return { ...ref, grantId: grant ? grant.id : null, granted: Boolean(grant) };
    });
    if (!byTier.has(cap.riskTier)) {
      byTier.set(cap.riskTier, { tier: cap.riskTier, policyMode: policy.mode, capabilities: [] });
    }
    byTier.get(cap.riskTier).capabilities.push({
      id: cap.id,
      kind: cap.kind,
      name: cap.name,
      riskTier: cap.riskTier,
      description: cap.description,
      autoGrant: Boolean(cap.autoGrant),
      included,
      roles: capRoles,
    });
  }
  for (const group of byTier.values()) {
    group.capabilities.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    id: pkg.id,
    kind: pkg.kind,
    label: pkg.label,
    description: pkg.description,
    owners: pkg.owners,
    enabled: enabledMap[pkg.id],
    capabilityCount: eligibleCapabilities(pkg, caps).length,
    roles,
    tiers: TIER_ORDER.filter((t) => byTier.has(t)).map((t) => byTier.get(t)),
  };
}

/** One row per package for the Integrations & Providers page: status + how much is covered. Reads
 *  capabilities, principals and grants once each rather than probing per pair. */
async function listPackagesWithStatus(driver) {
  const [enabledMap, caps, principals, grants] = await Promise.all([
    getEnabledMap(driver),
    policyStore.listCapabilities(driver),
    policyStore.listPrincipals(driver),
    policyStore.listGrants(driver),
  ]);
  const roleByName = roleIndex(principals);
  const live = liveGrantIndex(grants);

  return PACKAGES.map((pkg) => {
    const eligible = eligibleCapabilities(pkg, caps);
    let policyEligible = 0;
    let granted = 0;
    for (const cap of eligible) {
      const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
      const included = policy.mode === 'auto' || (policy.mode === 'explicit' && policy.include.includes(cap.name));
      if (!included) continue;
      for (const roleName of policy.roles) {
        const role = roleByName.get(roleName);
        if (!role) continue;
        policyEligible++;
        if (live.has(`${role.id}:${cap.id}`)) granted++;
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
      capabilityCount: eligible.length,
      coverage: { granted, total: policyEligible },
    };
  });
}

module.exports = {
  getEnabledMap,
  setEnabled,
  syncPackage,
  revokePackage,
  listPackagesWithStatus,
  packageDetail,
  findPackage,
};
