'use strict';

// THE REPLICA ADAPTER — phase 4 of docs/design/global-identity-and-central-db.md §2.7, node side.
// The sibling ./localPolicyStore.js's header predicted: "this file stays as the replica reader and a
// sibling adapter takes over the write half; nothing in server/app.js changes again."
//
// It implements the same policyStore contract (./index.js) and splits it exactly down §2.2's line:
//
//   READS  → the node's own SQLite, unchanged and SYNCHRONOUS. Those tables are now a mirror of
//            central rather than this machine's own registry, but they are the same tables with the
//            same indexes, so `findActiveGrant` is still two prepared statements and the hot path
//            never touches the network. That is §2.8's first row and the reason phase 4 is
//            shippable at all: the WAN is on the *write* path, where a human is waiting on a
//            dashboard, not on the *decision* path, where an agent is waiting on a tool call.
//
//   WRITES → central, over the node's enrollment certificate, and then a forced pull so the mirror
//            reflects the change before the route answers.
//
// WHY WRITES ARE ASYNC AND READS ARE NOT. There is no synchronous HTTP in Node, so a proxied write
// has to return a promise; server/app.js awaits every policy mutation for that reason. The reads
// stay synchronous because making them async would put a microtask on the decision path of every
// governed tool call to no purpose — a promise around a better-sqlite3 statement buys nothing and
// costs the one thing this system measures.
//
// WHAT A FAILED WRITE MEANS, and why nothing here retries. Central refused it, or was unreachable.
// Either way the row does not exist anywhere, the caller is a human at a dashboard who will see the
// error, and the correct response is to say so — not to queue it. A queued grant is a grant that
// might land in ten minutes, and "your revoke is somewhere in a retry queue" is a worse answer than
// "your revoke failed, try again." The usage direction queues (server/usageShipper.js) because a
// dropped observation is unrecoverable; the policy direction does not, because a dropped intention
// is simply not acted on. The one asymmetry that matters: REVOCATION still lands on every node
// through the deny-list even when this path is down, because that channel does not go through here.

const store = require('../store');
const { centralRequest, pullNow } = require('./policyClient');

/** Central's policy surface. Prefixed `/api/policy` so a node can point at a central that also
 *  serves ingest and fleet on the same origin, which is the ordinary deployment. */
const P = {
  capabilities: '/api/policy/capabilities',
  capabilityResolve: '/api/policy/capabilities/resolve',
  principals: '/api/policy/principals',
  principalResolve: '/api/policy/principals/resolve',
  grants: '/api/policy/grants',
  approvals: '/api/policy/approvals',
};

/**
 * Send a write, then make the local mirror current before returning.
 *
 * The pull is what keeps this drop-in. Without it `POST /api/grants` returns 201 and the very next
 * `GET /api/grants` against the same node shows nothing, because the poller has not come round —
 * behaviour a caller reads as data loss rather than as replication lag. `pullNow` is bounded and
 * best-effort: if it times out the route still answers with CENTRAL'S OWN ROW, which is the
 * authoritative answer whatever the mirror currently holds.
 */
async function writeThrough(method, path, body) {
  const result = await centralRequest(method, path, body);
  try {
    await pullNow();
  } catch (err) {
    // The write landed. Failing the request now would tell the caller their grant does not exist
    // when it does, which is the worse of the two available lies.
    console.warn('[central-policy] write accepted but the follow-up pull failed:', err.message);
  }
  return result;
}

/**
 * Map central's HTTP status back onto the seam's error taxonomy.
 *
 * server/app.js catches `policyStore.GrantConflictError` and answers 409; it must not have to know
 * that the conflict was detected across a WAN by a Postgres unique index rather than locally by a
 * SQLite one. Reusing server/store.js's classes rather than declaring look-alikes here is what makes
 * the `instanceof` in those routes keep working — two classes with the same name are two classes.
 */
function rethrow(err, kind) {
  if (err && err.status === 409) {
    if (kind === 'grant') throw new store.GrantConflictError(err.message);
    if (kind === 'capability') throw new store.CapabilityConflictError(err.message);
    if (kind === 'principal') throw new store.PrincipalConflictError(err.message);
  }
  throw err;
}

module.exports = {
  // --- error taxonomy -------------------------------------------------------
  // The same classes the local adapter exports, deliberately. See rethrow above.
  GrantConflictError: store.GrantConflictError,
  CapabilityConflictError: store.CapabilityConflictError,
  PrincipalConflictError: store.PrincipalConflictError,

  // --- capabilities ---------------------------------------------------------
  // Reads: the mirror. Identical to the local adapter, and that identity is the point — a route
  // reading capabilities cannot tell which adapter is bound, so there is one code path to reason
  // about instead of two.
  listCapabilities: (...args) => store.listCapabilities(...args),
  findCapabilityById: (...args) => store.findCapabilityById(...args),

  /**
   * Register a capability centrally. THE ID COMES BACK; it is not sent.
   *
   * §2.2: "central owns the canonical capability row and its id." An id minted on this node would
   * be an id no other machine recognises, so a grant against it would be a grant only this machine
   * could evaluate — which is the failure phase 4 exists to remove, arriving through the back door.
   */
  insertCapability: async (input) => {
    const { id, ...body } = input || {};
    try {
      return await writeThrough('POST', P.capabilities, body);
    } catch (err) {
      return rethrow(err, 'capability');
    }
  },

  setCapabilityAutoGrant: async (id, autoGrant) =>
    writeThrough('PATCH', `${P.capabilities}/${encodeURIComponent(id)}/auto-grant`, { autoGrant }),

  /**
   * The one write a node may cause without an admin: propose a capability it found on its own disk
   * and be told which row it is (§2.2). Idempotent by (kind, name), and it cannot retier an existing
   * row — the tier that comes back is whatever central already decided, which is what stops a
   * discovery channel from becoming an escalation channel.
   */
  resolveCapability: async (input) => writeThrough('POST', P.capabilityResolve, {
    kind: input.kind ?? null,
    name: input.name,
    riskTier: input.riskTier,
    description: input.description ?? null,
    owner: input.owner ?? null,
  }),

  // --- principals -----------------------------------------------------------
  listPrincipals: (...args) => store.listPrincipals(...args),
  findPrincipalById: (...args) => store.findPrincipalById(...args),
  findPrincipalByKindName: (...args) => store.findPrincipalByKindName(...args),
  findPrincipalBySubjectId: (...args) => store.findPrincipalBySubjectId(...args),
  // Owner evidence is derived from THIS node's usage events — who actually ran under which OS
  // account on this machine. It is an observation, not policy, so it stays local and stays a read
  // of the node's own tables even here.
  listOwnerEvidence: (...args) => store.listOwnerEvidence(...args),

  insertPrincipal: async (input) => {
    const { id, ...body } = input || {};
    try {
      return await writeThrough('POST', P.principals, body);
    } catch (err) {
      return rethrow(err, 'principal');
    }
  },

  // The four narrow column updates collapse to one central route, because on the authority side
  // they are one operation — "set these columns, log the change" — and four routes would be four
  // places to forget the log. The *permission* to call each one still differs, and that check stays
  // where it was: on the node's own route, in front of the seam.
  setPrincipalStatus: async (id, status) => writeThrough('PATCH', `${P.principals}/${encodeURIComponent(id)}`, { status }),
  setPrincipalName: async (id, name) => writeThrough('PATCH', `${P.principals}/${encodeURIComponent(id)}`, { name }),
  /**
   * Confirm, dismiss or reopen WHO OWNS an instance principal.
   *
   * The `status` this takes is the OWNER decision — 'confirmed' | 'dismissed' | 'unassigned'
   * (server/store.js setPrincipalOwner) — and it is deliberately NOT forwarded. Central's PATCH
   * route has exactly one `status` column and it is the principal's LIFECYCLE status
   * ('active' | 'pending' | 'denied'). Sending the owner word into it wrote 'confirmed' onto the
   * lifecycle column, and `policyDenyList` blocks every principal whose status is not 'active' —
   * so confirming an agent's owner in the dashboard put that agent on the always-full deny list
   * and hard-denied every governed call it made, at every tier, with "has been revoked". Issuing
   * grants could not clear it: the deny-list is checked first, precisely so that it cannot be.
   *
   * Only `owner` crosses the seam, which is the only column central actually has for this. The
   * confirmed/dismissed/unassigned distinction stays on the node (store.setPrincipalOwnerLocal
   * writes the owner* columns there); a null owner is what 'dismissed' and 'unassigned' both mean
   * to central, and neither is a statement about whether the agent may run.
   *
   * SO THIS ADAPTER HAS TO DO BOTH, and for a while it did only the first. Forwarding alone left
   * the node's own owner* columns untouched, and those columns are what
   * `GET /api/principals/owner-proposals` reads: the dashboard's Confirm button POSTed, got a 200,
   * reloaded, and re-rendered the identical unassigned row. A write that succeeds and changes
   * nothing the reader looks at is indistinguishable from a dead button.
   *
   * The local half goes through `setPrincipalOwnerLocal` rather than `setPrincipalOwner`, because
   * the latter is one of the exports `setPolicyReadOnly` refuses on a replica — correctly, since
   * this is the seam and a route reaching around it is exactly what that guard exists to catch.
   * The owner* columns are node-local by design, so they get their own unguarded writer.
   */
  setPrincipalOwner: async (id, decision = {}) => {
    const { status, osUser = null, ownerPrincipalId = null, decidedByScope = null } = decision;
    // Central first: it is the half that can fail, and a refusal there must leave the node's
    // record of the decision unwritten rather than diverged from the fleet's.
    await writeThrough('PATCH', `${P.principals}/${encodeURIComponent(id)}`, {
      owner: status === 'confirmed' ? ownerPrincipalId || osUser || null : null,
      reason: decidedByScope ? `owner ${status} by ${decidedByScope}` : `owner ${status}`,
    });
    // Returns the node's row, not central's: the caller (server/app.js) reads ownerStatus /
    // ownerOsUser / ownerPrincipalId off it for the audit entry's `after`, and central's shape
    // carries none of them.
    return store.setPrincipalOwnerLocal(id, { status, osUser, ownerPrincipalId, decidedByScope });
  },

  /**
   * The hook path's registration — the one write an ordinary agent causes, now fleet-wide.
   *
   * This is the call that makes phase 4 a change to the HOOK CONTRACT rather than only to the admin
   * surface. Before it, a first-sighted agentType minted a `pending` role in this machine's own
   * registry and an admin on this machine approved it. After it, that role is one row the whole
   * fleet shares: approved once, everywhere. The cost is that a node which cannot reach central
   * cannot register a *new* agent at all — resolvePrincipal throws, and server/hooks/lib.js takes
   * the FAULT.NO_PRINCIPAL ladder, which is read_only-open and mutating/destructive-closed. An
   * already-registered agent is unaffected: its principal is in the hook's own cache and in the
   * mirror.
   */
  upsertPrincipalIdentity: async (roleName, identity) =>
    writeThrough('POST', P.principalResolve, { ...identity, roleName }),

  // --- grants ---------------------------------------------------------------
  listGrants: (...args) => store.listGrants(...args),
  findGrant: (...args) => store.findGrant(...args),
  findGrantById: (...args) => store.findGrantById(...args),

  insertGrant: async (input) => {
    const { id, createdAt, ...body } = input || {};
    try {
      return await writeThrough('POST', P.grants, body);
    } catch (err) {
      return rethrow(err, 'grant');
    }
  },

  /**
   * Revoke. The one write whose *latency to every other node* is a security number rather than a
   * convenience one (§2.4) — and the reason it needs nothing special here: once central has the
   * row, the revocation rides the always-full deny-list on every node's next poll, including nodes
   * whose delta stream is broken and nodes frozen on an old schema. This function's only job is to
   * get it into central.
   */
  revokeGrant: async (id, revokedBy) =>
    writeThrough('DELETE', `${P.grants}/${encodeURIComponent(id)}`, { revokedBy }),

  // --- approvals ------------------------------------------------------------
  // Read from the mirror like everything else. An approval queue that lived only centrally would
  // make the node's dashboard unable to show pending items during a partition; replicating them
  // costs nothing, since they are few and small.
  listApprovals: (...args) => store.listApprovals(...args),
  findApprovalById: (...args) => store.findApprovalById(...args),

  insertApproval: async (input) => {
    const { id, requestedAt, ...body } = input || {};
    return writeThrough('POST', P.approvals, body);
  },

  decideApproval: async (id, { status, decidedByScope, reason, resultGrantId }) =>
    // `resultGrantId` is deliberately not forwarded: central issues the grant itself as part of
    // deciding, in one transaction, so a node choosing the id would be a node minting one. What
    // comes back carries the id central actually used.
    writeThrough('POST', `${P.approvals}/${encodeURIComponent(id)}/decide`, { status, decidedByScope, reason }),
};
