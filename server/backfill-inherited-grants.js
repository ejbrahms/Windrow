// One-time backfill: the live principal-registration paths (hooks/lib.js,
// principals/resolve-cli.js, principals/registry.js, app.js's POST /api/principals) now start
// every *new* principal off its parent's grants — an instance principal inherits every grant
// already held by its parent role (mutating/destructive included, not just read-only), and a role
// principal, having no parent, falls back to every read_only capability (see grantInherited in
// principals/registry.js). This script applies that same policy to principals that were already
// in the database before it existed, so the two populations don't end up on different rules
// depending on when they were created.
//
// Roles are backfilled before instances so an instance inherits its role's backfilled grants too,
// not just whatever the role happened to hold already.
//
// Idempotent — only inserts a grant where the principal has no existing direct grant for that
// capability, so re-running this after the fact (or against a store some principals already got
// the default on) is a no-op for anything already covered.
const { genId } = require('./id');
const store = require('./store');

function backfillInheritedGrants() {
  const principals = store.listPrincipals();
  const readOnlyCapIds = store.listCapabilities()
    .filter((c) => c.riskTier === 'read_only')
    .map((c) => c.id);
  const grants = store.listGrants();

  const grantedByPrincipal = new Map(); // principalId -> Set(capabilityId)
  for (const g of grants) {
    if (!grantedByPrincipal.has(g.principalId)) grantedByPrincipal.set(g.principalId, new Set());
    grantedByPrincipal.get(g.principalId).add(g.capabilityId);
  }

  const roleByName = new Map(
    principals.filter((p) => p.kind === 'role').map((p) => [p.name, p])
  );

  function grantCap(principal, capId) {
    const already = grantedByPrincipal.get(principal.id) || new Set();
    if (already.has(capId)) return null;
    const grant = {
      id: genId('gr'),
      principalId: principal.id,
      capabilityId: capId,
      constraints: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    };
    store.insertGrant(grant);
    already.add(capId);
    grantedByPrincipal.set(principal.id, already);
    return grant;
  }

  const created = [];

  // Roles first: no parent to inherit from, so they get the read_only baseline.
  for (const principal of principals) {
    if (principal.kind !== 'role') continue;
    for (const capId of readOnlyCapIds) {
      const grant = grantCap(principal, capId);
      if (grant) created.push(grant);
    }
  }

  // Instances: inherit whatever their parent role now holds (including the read_only baseline
  // roles were just backfilled with above).
  for (const principal of principals) {
    if (principal.kind !== 'instance') continue;
    const parent = principal.parentRole ? roleByName.get(principal.parentRole) : null;
    const sourceCapIds = parent
      ? Array.from(grantedByPrincipal.get(parent.id) || [])
      : readOnlyCapIds;
    for (const capId of sourceCapIds) {
      const grant = grantCap(principal, capId);
      if (grant) created.push(grant);
    }
  }

  return { principalCount: principals.length, created };
}

if (require.main === module) {
  const { principalCount, created } = backfillInheritedGrants();
  console.log(
    `Backfilled ${created.length} inherited grant(s) across ${principalCount} principal(s) -> ${store.DB_PATH}`
  );
}

module.exports = { backfillInheritedGrants };
