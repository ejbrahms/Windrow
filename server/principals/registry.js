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
const { isAssuranceLevel } = require('./subject');

function principalRoleName(identity) {
  return identity.agentType || identity.backend || 'unknown';
}

// The label to *show* for a principal: an instance mapped from a real running agent carries a
// platform-assigned nickname (see upsertPrincipalFromIdentity below), which reads better than the
// raw agent/role name. Display only — the nickname comes from a fixed cast pack and is neither
// unique nor stable across respawns, so never group or key on it
// (docs/design/global-identity-and-central-db.md §1.1). client/src/api/principal.ts carries the
// browser-side twin of this, which cannot require() across the bundle boundary; keep the two in
// step.
function principalDisplayName(principal, fallbackId) {
  if (!principal) return fallbackId;
  return principal.humanName || principal.name;
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
 * The identity attributes an instance principal carries. Written once, at first sighting — see
 * `mergeObservedIdentity`. `standalone` is deliberately not in here: its column is NOT NULL
 * DEFAULT 0, so "never observed" and "observed false" are indistinguishable and there is no
 * missing value to back-fill. It is set at creation and left alone.
 */
const IDENTITY_FIELDS = ['humanName', 'backend', 'agentType', 'field'];

/**
 * want-mszgwf94-14 (docs/design/global-identity-and-central-db.md §1.2): these attributes used to
 * be refreshed in place on every upsert, on the theory that the registry should reflect the latest
 * observation. That is a live correctness bug, not a preference — usage reports resolve an event's
 * agent by joining out to the principal row, so a last-write-wins overwrite silently re-attributes
 * *every historical event* to the agent's current human name / backend / field. A month of Cole's
 * calls become Mira's the moment the node id is reused.
 *
 * So the registered value wins: an attribute is written when the principal is created and never
 * replaced afterwards. Two deliberate exceptions to "never touched again":
 *
 *   - A NULL attribute is back-filled. Rows created before a column existed (or by a hook that
 *     resolved a partial identity) carry no value at all, so filling one in doesn't re-attribute
 *     anything — it attributes events that had nothing.
 *   - A *differing* observation is reported back to the caller as `identityDrift` rather than
 *     applied. Nothing here can store per-call identity; that's `want-mszgwhfj-16`, the actor
 *     columns on `usage_events`, which is where a genuine rename belongs. Until it lands the
 *     divergence is logged (server/app.js's /api/principals/resolve) instead of dropped silently.
 *
 * Returns the columns to write (`fill`, possibly empty) and the divergences not written (`drift`).
 */
function mergeObservedIdentity(existing, identity) {
  const fill = {};
  const drift = [];
  for (const key of IDENTITY_FIELDS) {
    const observed = identity[key] || null;
    const registered = existing[key] ?? null;
    if (registered === null) {
      if (observed !== null) fill[key] = observed;
    } else if (observed !== null && observed !== registered) {
      drift.push({ field: key, registered, observed });
    }
  }
  return { fill, drift };
}

/**
 * Snapshot-based upsert, used by seed.js's offline batch build. The *live* path — a hook
 * resolving the agent it runs inside — no longer goes through here: it posts its identity to
 * `POST /api/principals/resolve` (server/app.js), which does the same thing as a narrow two-row
 * transaction (store.js's `upsertPrincipalIdentity`) instead of `store.save()`'s whole-table
 * replace. Keep the two in step; see docs/design/global-identity-and-central-db.md phase 0.
 *
 * Finds or creates the instance principal for a real platform identity, keyed on `loomId`. The
 * identity metadata is write-once — see `mergeObservedIdentity` above for why, and for what
 * happens to an observation that disagrees with the registered one.
 *
 * The role is resolved from the *registered* `agentType` (the instance's own `parentRole`) when
 * the instance already exists, not from the incoming identity. Otherwise a drifting agentType
 * would mint a fresh `pending` role principal that nothing is ever parented to — a phantom row in
 * the approvals queue for an agent that is already registered under its real role.
 */
/**
 * Snapshot twin of store.js's `upsertSubjectPrincipalTx` — the `user` principal for an identity's
 * subject key (docs/design/global-identity-and-central-db.md §1.4, want-mszgwij4-17). Keyed on
 * `subjectId`, never on `name`, which is a mutable display label here as everywhere — seeded from
 * the OS username and then owned by whoever edits it, safely, because nothing is attributed through
 * it (events, grants and audit rows all reference `principals.id`).
 *
 * Created `pending` with zero grants and read by no authorization path yet — phase 1 records the
 * subject, phase 5 flips the decision onto it. Keep this and the store's transaction in step; they
 * exist separately only because seed.js builds a whole snapshot offline while the hook path writes
 * two — now three — rows.
 */
function upsertSubjectPrincipal(db, identity) {
  if (!identity.subjectId) return { subject: null, subjectCreated: false };
  const label = identity.osUser || identity.subjectId;
  let subject = db.principals.find((p) => p.subjectId === identity.subjectId);
  if (!subject) {
    subject = {
      id: genId('pr'),
      kind: 'user',
      name: label,
      subjectId: identity.subjectId,
      assuranceLevel: isAssuranceLevel(identity.assuranceLevel) ? identity.assuranceLevel : null,
      parentRole: null,
      status: 'pending',
    };
    db.principals.push(subject);
    return { subject, subjectCreated: true };
  }
  // Seeded at creation, then human-owned — an observation never overwrites a label a person set.
  // See the store's copy for the argument.
  if (label && !subject.name) subject.name = label;
  // Ratchets up only — a weaker reading of the same key is a fact about one call, not about the
  // identity. See the store's copy for the full argument.
  if (
    isAssuranceLevel(identity.assuranceLevel) &&
    (subject.assuranceLevel == null || identity.assuranceLevel > subject.assuranceLevel)
  ) {
    subject.assuranceLevel = identity.assuranceLevel;
  }
  return { subject, subjectCreated: false };
}

function upsertPrincipalFromIdentity(db, identity) {
  if (!identity || !identity.loomId) {
    throw new Error('upsertPrincipalFromIdentity requires an identity with a loomId');
  }
  let instance = db.principals.find((p) => p.kind === 'instance' && p.name === identity.loomId);
  const roleName = (instance && instance.parentRole) || principalRoleName(identity);
  const { role, created: roleCreated } = upsertRole(db, roleName);

  let instanceCreated = false;
  let drift = [];
  let identityFilled = false;
  if (!instance) {
    // No grants materialized here — it inherits its role's grants dynamically (see
    // grantReadOnlyBaseline's doc comment above).
    instance = {
      id: genId('pr'),
      kind: 'instance',
      name: identity.loomId,
      parentRole: roleName,
      humanName: identity.humanName || null,
      backend: identity.backend || null,
      agentType: identity.agentType || null,
      field: identity.field || null,
      standalone: Boolean(identity.standalone),
    };
    db.principals.push(instance);
    instanceCreated = true;
  } else {
    const merged = mergeObservedIdentity(instance, identity);
    identityFilled = Object.keys(merged.fill).length > 0;
    Object.assign(instance, merged.fill);
    if (!instance.parentRole) instance.parentRole = roleName;
    drift = merged.drift;
  }

  const { subject, subjectCreated } = upsertSubjectPrincipal(db, identity);

  return { role, instance, subject, roleCreated, instanceCreated, subjectCreated, identityDrift: drift, identityFilled };
}

module.exports = {
  principalRoleName,
  principalDisplayName,
  upsertPrincipalFromIdentity,
  upsertSubjectPrincipal,
  grantReadOnlyBaseline,
  mergeObservedIdentity,
  IDENTITY_FIELDS,
};
