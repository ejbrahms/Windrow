// Upserts a real Wispfield identity (see fromEnv.js) into db.principals. Mirrors the discovery
// module's merge semantics: matched by a stable key, updated in place, never duplicated.
//
// Id scheme (roadmap item 2's "decide role-level vs instance-level" question):
//   - role kind:     one per `agentType` (e.g. "claudecode"). Carries the default grants every
//                     loom of that kind gets.
//   - instance kind: one per `loomId` (Wispfield's own `LOOM_NODE_ID`, e.g.
//                     "claude-msri1c9v-43"), `parentRole` set to its role. Carries overrides —
//                     a specific loom can be granted more (or, if policy needs it later, less)
//                     than its role's defaults. This is the same role-vs-instance shape the
//                     original seed used; the difference is instances are now real loom ids
//                     pulled from Wispfield, with a real human name/backend/field attached,
//                     instead of invented strings.
const { genId } = require('../id');

function principalRoleName(identity) {
  return identity.agentType || identity.backend || 'unknown';
}

/**
 * Policy: a new principal's starting grants come from its parent.
 *   - Instance principals (`parentRole` set) inherit every grant already held by their parent
 *     role principal — mutating/destructive included, not just read-only — because the role *is*
 *     "the default grants every loom of that kind gets" (api-contract.md). This mirrors, and now
 *     also materializes as real rows, the dynamic role-fallback app.js's findActiveGrant already
 *     does at authorization time.
 *   - Role principals have no parent to inherit from, so they fall back to every read_only
 *     capability — read-only access needs no per-principal justification the way mutating/
 *     destructive access does.
 * Only applied on the `db.load()`-style snapshot (has `capabilities` and `grants` arrays);
 * seed.js's principals-only snapshot manages its own grants and is left alone.
 * Idempotent — skips any capability the principal already has a direct grant for — so it's safe
 * to call on every upsert, not just on first creation.
 */
function grantInherited(db, principal) {
  if (!db.capabilities || !db.grants) return;
  const now = new Date().toISOString();
  const alreadyGranted = new Set(
    db.grants.filter((g) => g.principalId === principal.id).map((g) => g.capabilityId)
  );

  const parent = principal.parentRole
    ? db.principals.find((p) => p.kind === 'role' && p.name === principal.parentRole)
    : null;

  const sourceCapIds = parent
    ? new Set(
        db.grants.filter((g) => g.principalId === parent.id).map((g) => g.capabilityId)
      )
    : new Set(db.capabilities.filter((c) => c.riskTier === 'read_only').map((c) => c.id));

  for (const capId of sourceCapIds) {
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

/** Finds or creates the role principal for an identity's agentType. */
function upsertRole(db, roleName) {
  let role = db.principals.find((p) => p.kind === 'role' && p.name === roleName);
  let created = false;
  if (!role) {
    role = { id: genId('pr'), kind: 'role', name: roleName, parentRole: null };
    db.principals.push(role);
    created = true;
    grantInherited(db, role);
  }
  return { role, created };
}

/**
 * Finds or creates the instance principal for a real Wispfield identity, keyed on `loomId`.
 * Refreshes the identity metadata in place on every call — a loom's human name or field can
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
    instance = { id: genId('pr'), kind: 'instance', name: identity.loomId, parentRole: roleName };
    db.principals.push(instance);
    instanceCreated = true;
    grantInherited(db, instance);
  }
  instance.parentRole = roleName;
  instance.humanName = identity.humanName || null;
  instance.backend = identity.backend || null;
  instance.agentType = identity.agentType || null;
  instance.field = identity.field || null;
  instance.standalone = Boolean(identity.standalone);

  return { role, instance, roleCreated, instanceCreated };
}

module.exports = { principalRoleName, upsertPrincipalFromIdentity, grantInherited };
