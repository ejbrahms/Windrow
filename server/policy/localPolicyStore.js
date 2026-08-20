'use strict';

// Local (node-authoritative) implementation of the policyStore contract — see ./index.js for what
// the contract is and why it exists. Every method here is a thin delegate to server/store.js, the
// node's own SQLite database, which today is the only authority for policy. That is deliberate:
// phase 2 of docs/design/global-identity-and-central-db.md §2.7 is a *pure refactor*, so this
// adapter must be behaviourally identical to the direct `store.*` calls it replaced — same return
// shapes, same thrown errors, same synchronous signatures.
//
// When phase 4 flips authority for grants/capabilities to central, this file stays as the replica
// reader and a sibling adapter takes over the write half; nothing in server/app.js changes again.

const store = require('../store');
const { genId } = require('../id');

// ---------------------------------------------------------------------------
// MINTING MOVED BEHIND THE SEAM — phase 4 of docs/design/global-identity-and-central-db.md §2.7.
//
// server/app.js used to build a row with its own `genId('cap')`/`genId('gr')`/`genId('pr')` and
// hand it to the store. It cannot any more, and the reason is §2.2's discovery rule: "central owns
// the canonical capability row and its id". A node that minted its own would produce an id no other
// machine recognises, and a grant referencing it would be a grant only that machine could evaluate.
//
// So the id is now decided by whichever adapter is bound — here, locally, exactly as before; in
// ../policy/centralPolicyStore.js, by central. The route above the seam does not know which, which
// is the point: the same handler serves a standalone install and a replica node.
//
// These three therefore RETURN THE STORED ROW, where before they returned nothing and the caller
// used the object it had just built. A caller that used its own copy would, on a replica node, be
// holding an id central never issued.
// ---------------------------------------------------------------------------

module.exports = {
  // --- error taxonomy -------------------------------------------------------
  // Part of the contract, not an implementation detail: callers branch on these with `instanceof`,
  // so any future adapter has to throw these same classes rather than its own look-alikes.
  GrantConflictError: store.GrantConflictError,
  CapabilityConflictError: store.CapabilityConflictError,
  PrincipalConflictError: store.PrincipalConflictError,

  // --- capabilities ---------------------------------------------------------
  listCapabilities: (...args) => store.listCapabilities(...args),
  findCapabilityById: (...args) => store.findCapabilityById(...args),
  insertCapability: (input) => {
    const capability = {
      autoGrant: false,
      ...input,
      // An id supplied by the caller is honoured — server/seed.js and the migration path both hand
      // one over deliberately — and absent, one is minted here. That is what lets the seam mint
      // without breaking the callers that legitimately choose their own.
      id: input.id || genId('cap'),
    };
    store.insertCapability(capability);
    return store.findCapabilityById(capability.id);
  },
  setCapabilityAutoGrant: (...args) => store.setCapabilityAutoGrant(...args),

  /**
   * §2.2's discovery direction — "the node reports what it found, central owns the canonical
   * capability row and its id" — expressed as a seam member so discovery does not have to know
   * which authority it is talking to.
   *
   * Locally it is find-or-create against this node's own tables, which is what discovery already
   * did inline. What it must NOT do, here or centrally, is retier an existing row: that would make
   * "what may this tool do" a race between an admin and whichever machine rescanned last.
   */
  resolveCapability: (input) => {
    const existing = store.listCapabilities().find(
      (c) => (c.kind ?? null) === (input.kind ?? null) && c.name === input.name
    );
    if (existing) return existing;
    const capability = {
      id: input.id || genId('cap'),
      kind: input.kind ?? null,
      name: input.name,
      owner: input.owner ?? null,
      riskTier: input.riskTier || 'read_only',
      description: input.description ?? null,
      autoGrant: false,
    };
    store.insertCapability(capability);
    return store.findCapabilityById(capability.id);
  },

  // --- principals -----------------------------------------------------------
  listPrincipals: (...args) => store.listPrincipals(...args),
  findPrincipalById: (...args) => store.findPrincipalById(...args),
  findPrincipalByKindName: (...args) => store.findPrincipalByKindName(...args),
  findPrincipalBySubjectId: (...args) => store.findPrincipalBySubjectId(...args),
  listOwnerEvidence: (...args) => store.listOwnerEvidence(...args),
  insertPrincipal: (input) => {
    const principal = { ...input, id: input.id || genId('pr') };
    store.insertPrincipal(principal);
    return store.findPrincipalById(principal.id);
  },
  setPrincipalStatus: (...args) => store.setPrincipalStatus(...args),
  setPrincipalName: (...args) => store.setPrincipalName(...args),
  setPrincipalOwner: (...args) => store.setPrincipalOwner(...args),
  upsertPrincipalIdentity: (...args) => store.upsertPrincipalIdentity(...args),

  // --- grants ---------------------------------------------------------------
  listGrants: (...args) => store.listGrants(...args),
  findGrant: (...args) => store.findGrant(...args),
  findGrantById: (...args) => store.findGrantById(...args),
  insertGrant: (input) => {
    const grant = {
      constraints: null,
      expiresAt: null,
      ...input,
      id: input.id || genId('gr'),
      // The authority stamps the creation time, not the caller. On a replica node that clock is
      // central's; keeping the local adapter's the same shape means a row does not change meaning
      // when the seam is rebound.
      createdAt: input.createdAt || new Date().toISOString(),
    };
    store.insertGrant(grant);
    return store.findGrantById(grant.id);
  },
  revokeGrant: (...args) => store.revokeGrant(...args),

  // --- approvals ------------------------------------------------------------
  // Approvals are policy *proposals*; they live on the same side of the seam as the grants they
  // decide into, so an approval and its resulting grant can never end up on opposite authorities.
  listApprovals: (...args) => store.listApprovals(...args),
  findApprovalById: (...args) => store.findApprovalById(...args),
  insertApproval: (input) => {
    const approval = { ...input, id: input.id || genId('appr'), requestedAt: input.requestedAt || new Date().toISOString() };
    store.insertApproval(approval);
    return store.findApprovalById(approval.id);
  },
  decideApproval: (...args) => store.decideApproval(...args),
};
