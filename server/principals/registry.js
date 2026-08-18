// Upserts a real platform identity (see fromEnv.js) into db.principals. Mirrors the discovery
// module's merge semantics: matched by a stable key, updated in place, never duplicated.
//
// Id scheme (roadmap item 2's "decide role-level vs instance-level" question):
//   - role kind:     one per `agentType` (e.g. "claudecode"). Carries the default grants every
//                     agent of that kind gets.
//   - instance kind: one per `loomId` (the platform's own `LOOM_NODE_ID`, e.g.
//                     "claude-msri1c9v-43"), `parentRole` set to its role. Carries overrides —
//                     a specific agent can be granted more (or, if policy needs it later, less)
//                     than its role's defaults. This is the same role-vs-instance shape the
//                     original seed used; the difference is instances are now real agent ids
//                     pulled from the platform, with a real human name/backend/field attached,
//                     instead of invented strings.
const { genId } = require('../id');

function principalRoleName(identity) {
  return identity.agentType || identity.backend || 'unknown';
}

/**
 * Policy: an *approved* role principal's starting grants are every `read_only` capability —
 * read-only access needs no per-principal justification the way mutating/destructive access does.
 * This is no longer called on first sighting (see `upsertRole` below, F7) — only from the
 * `POST /api/principals/:id/approve` route, once a human has looked at the role.
 *
 * Instance principals get none of this: they inherit their parent role's grants *dynamically*,
 * at authorization time (app.js's findActiveGrant falls back to the role when the instance has
 * no direct grant of its own). Earlier this also materialized a real, per-instance copy of every
 * grant the role held at creation time — mutating/destructive included — which then had its own
 * lifecycle independent of the role's. Revoking the role's grant left every instance created
 * before that point still holding its copy (docs/design/governance-review-2026-08-16.md, F6). The
 * dynamic fallback alone is sufficient and doesn't have that failure mode, so materialization is
 * gone: an instance principal is created with zero grants of its own and gets everything through
 * the fallback.
 *
 * Only applied on the `db.load()`-style snapshot (has `capabilities` and `grants` arrays);
 * seed.js's principals-only snapshot manages its own grants and is left alone.
 * Idempotent — skips any capability the principal already has a direct grant for — so it's safe
 * to call on every upsert, not just on first creation.
 */
function grantReadOnlyBaseline(db, principal) {
  if (!db.capabilities || !db.grants) return;
  const now = new Date().toISOString();
  const alreadyGranted = new Set(
    db.grants.filter((g) => g.principalId === principal.id).map((g) => g.capabilityId)
  );
  const readOnlyCapIds = db.capabilities.filter((c) => c.riskTier === 'read_only').map((c) => c.id);

  for (const capId of readOnlyCapIds) {
    if (alreadyGranted.has(capId)) continue;
    db.grants.push({
      id: genId('gr'),
      principalId: principal.id,
      capabilityId: capId,
      constraints: null,
      createdAt: now,
      expiresAt: null,
    });
  }
}

/**
 * Finds or creates the role principal for an identity's agentType.
 *
 * F7 (docs/design/governance-review-2026-08-16.md): a role's first sighting used to be its
 * provisioning too — `grantReadOnlyBaseline` ran right here, so anything that could make
 * `deriveAgentType`/`detectStandaloneBackend` return an unused string (an unmapped
 * `LOOM_PROVIDER` value, say) minted itself a fresh, fully-provisioned principal with no human in
 * the loop. A newly-sighted role now lands `status: 'pending'` with zero grants instead; the
 * baseline is applied only by `POST /api/principals/:id/approve` (server/app.js), once an admin
 * has actually looked at it.
 */
function upsertRole(db, roleName) {
  let role = db.principals.find((p) => p.kind === 'role' && p.name === roleName);
  let created = false;
  if (!role) {
    role = { id: genId('pr'), kind: 'role', name: roleName, parentRole: null, status: 'pending' };
    db.principals.push(role);
    created = true;
  }
  return { role, created };
}

/**
 * Finds or creates the instance principal for a real platform identity, keyed on `loomId`.
 * Refreshes the identity metadata in place on every call — an agent's human name or workspace can
 * differ across a respawn on the same node id, and we want the registry to reflect the latest
 * observation rather than freeze the first one seen.
 */
function upsertPrincipalFromIdentity(db, identity) {
  if (!identity || !identity.loomId) {
    throw new Error('upsertPrincipalFromIdentity requires an identity with a loomId');
  }
  const roleName = principalRoleName(identity);
  const { role, created: roleCreated } = upsertRole(db, roleName);

  let instance = db.principals.find((p) => p.kind === 'instance' && p.name === identity.loomId);
  let instanceCreated = false;
  if (!instance) {
    // No grants materialized here — it inherits its role's grants dynamically (see
    // grantReadOnlyBaseline's doc comment above).
    instance = { id: genId('pr'), kind: 'instance', name: identity.loomId, parentRole: roleName };
    db.principals.push(instance);
    instanceCreated = true;
  }
  instance.parentRole = roleName;
  instance.humanName = identity.humanName || null;
  instance.backend = identity.backend || null;
  instance.agentType = identity.agentType || null;
  instance.field = identity.field || null;
  instance.standalone = Boolean(identity.standalone);

  return { role, instance, roleCreated, instanceCreated };
}

module.exports = { principalRoleName, upsertPrincipalFromIdentity, grantReadOnlyBaseline };
