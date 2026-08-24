import { qs, request } from "./client";
import { num } from "./fleet";
import type { Numeric } from "./fleet";

/**
 * Central's POLICY CONTROL PLANE — `GET/POST/PATCH/DELETE /api/policy/*`, read straight off
 * server/central/policyRoutes.js.
 *
 * ITS OWN MODULE, beside ./fleet.ts and for the same reason: these routes exist on ONE host.
 * The difference between the two is worth stating, because it is the difference between the pages
 * they back. `/api/fleet/*` is OBSERVATION — what the fleet did, aggregated, read-only. Everything
 * here is CONTROL: central is the single writer for policy (server/central/policyStore.js), every
 * mutation below appends to `policy_changes`, and every node replicates that log. A button on a
 * page backed by ./fleet.ts changes what you are looking at; a button on a page backed by this
 * module changes what thirty machines are allowed to do.
 *
 * NOT A SECOND COPY OF ./client.ts's `api.capabilities` / `api.grants` / `api.principals`. Those
 * are the NODE's machine-local routes, and a node's policy tables are a read-only mirror now
 * (server/store.js's PolicyReadOnlyError). The shapes are close enough to tempt a shared type and
 * different enough that sharing one would be a bug: central's capability row has `autoGrant`, the
 * node's derived `autoGranted`; central's approval `action` is `grant_capability`, the node's is
 * `grant`/`revoke`/`consent`; and central's grant carries `revokedAt`/`revokedBy`, which the node's
 * type has never had. See `PolicyGrant` on why that last one is the most important of the three.
 *
 * NUMBERS. The policy tables are TEXT, BOOLEAN and one INTEGER — no NUMERIC anywhere, so unlike
 * ./fleet.ts nothing here is an average arriving as a string. The one exception is the replication
 * state below, where the coercion happens in the store rather than in the driver's type parser;
 * `Numeric` and `num()` are reused from ./fleet.ts there rather than redeclared, for the reason
 * that file's header gives — a NaN in a tile says "this page is broken" when the truth was "this
 * number came back as a string".
 */

// ---------------------------------------------------------------------------- capabilities

/** The three tiers, and the whole of them — server/central/policyStore.js's RISK_TIERS. Exported
 *  as a value because every page here groups, orders and colours by it. */
export const RISK_TIERS = ["read_only", "mutating", "destructive"] as const;
export type PolicyRiskTier = (typeof RISK_TIERS)[number];

export interface PolicyCapability {
  id: string;
  /** Null is ordinary, not missing: a capability registered without one. The unique index is over
   *  `COALESCE(kind, '')` precisely because of that. */
  kind: string | null;
  name: string;
  owner: string | null;
  riskTier: PolicyRiskTier;
  description: string | null;
  /** Bypasses the grant table entirely on every node, so it is never permitted on a `destructive`
   *  row — central refuses that with a 400 and the page surfaces the refusal rather than
   *  re-implementing the rule. */
  autoGrant: boolean;
  createdAt: string;
}

export interface NewCapability {
  kind?: string | null;
  name: string;
  owner?: string | null;
  riskTier: PolicyRiskTier;
  description?: string | null;
  autoGrant?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------- principals

/** "user" is the person a call is accountable to, keyed on `subjectId`; "role" is the agent kind;
 *  "instance" is one running loom, which inherits its role's grants and holds none of its own. */
export type PolicyPrincipalKind = "role" | "instance" | "user";

/** The lifecycle vocabulary, and the whole of it (policyStore's PRINCIPAL_STATUSES). A principal
 *  whose status is not 'active' is on the always-full deny list every node fetches, so a word
 *  outside this set is an agent that stops working fleet-wide. */
export const PRINCIPAL_STATUSES = ["active", "pending", "denied"] as const;
export type PolicyPrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

export interface PolicyPrincipal {
  id: string;
  kind: PolicyPrincipalKind;
  /** A display label on a `user` row and a lookup key on the other two — an agentType on a role,
   *  a loom id on an instance. */
  name: string;
  /** The stable key, on `user` rows only: prefixed by the authority that issued it
   *  ("win-sid:…", "posix:…", "env-user:…"). Null on agent-shaped rows. */
  subjectId: string | null;
  assuranceLevel: number | null;
  parentRole: string | null;
  humanName: string | null;
  backend: string | null;
  agentType: string | null;
  field: string | null;
  standalone: boolean;
  status: PolicyPrincipalStatus;
  owner: string | null;
  createdAt: string;
}

/** What `PATCH /api/policy/principals/:id` will accept — policyStore's PRINCIPAL_MUTABLE, and no
 *  wider. Anything outside it is refused with "nothing updatable in …", which is a 400 the page
 *  would have no way to explain. */
export interface PrincipalPatch {
  status?: PolicyPrincipalStatus;
  name?: string;
  owner?: string | null;
  humanName?: string | null;
  parentRole?: string | null;
  assuranceLevel?: number | null;
  reason?: string;
}

export interface NewPrincipal {
  kind: PolicyPrincipalKind;
  name: string;
  parentRole?: string | null;
  humanName?: string | null;
  owner?: string | null;
  status?: PolicyPrincipalStatus;
}

// ---------------------------------------------------------------------------- grants

export interface PolicyGrant {
  id: string;
  principalId: string;
  capabilityId: string;
  constraints: string | null;
  createdAt: string;
  expiresAt: string | null;
  /**
   * A REVOKE IS A SOFT DELETE, and this is the field that makes it one.
   *
   * `GET /api/policy/grants` returns revoked rows alongside live ones — the row survives so that
   * "who held this, and who took it away" survives with it. Every caller in this app therefore
   * filters on `revokedAt === null` before counting anything; see `activeGrants` below, which is
   * that filter written once. A page that forgot it would report 529 grants where 481 are real,
   * and would draw a revoked capability as still granted.
   */
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface NewGrant {
  principalId: string;
  capabilityId: string;
  constraints?: string | null;
  expiresAt?: string | null;
  reason?: string;
}

/** Live grants only — the one filter every reader of `grants.list()` needs. See `PolicyGrant`. */
export function activeGrants(grants: PolicyGrant[] | null | undefined): PolicyGrant[] {
  return (grants ?? []).filter((g) => g.revokedAt === null);
}

// ---------------------------------------------------------------------------- approvals

/** Central's approval vocabulary, which is NOT the node's. `grant_capability` is the one action
 *  approving actually executes — policyRoutes turns it into a real grant inside the decision, so
 *  there is no window where the approval is decided and the grant does not exist. */
export type PolicyApprovalStatus = "pending" | "approved" | "denied";

export interface PolicyApproval {
  id: string;
  action: string;
  status: PolicyApprovalStatus;
  principalId: string | null;
  capabilityId: string | null;
  /** Free-form by design — for `grant_capability` it is a `NewGrant`, and for anything else it is
   *  whatever the proposer sent. Typed `unknown` rather than guessed at: this queue is written by
   *  a node, and a shape asserted here would be a lie the moment somebody adds an action. */
  payload: unknown;
  requestedByScope: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedByScope: string | null;
  reason: string | null;
  resultGrantId: string | null;
}

/** The `grant_capability` payload, when that is what it is. Read through a guard rather than a
 *  cast so an unfamiliar payload renders as JSON instead of as an undefined principal. */
export function grantPayload(approval: PolicyApproval): NewGrant | null {
  const p = approval.payload;
  if (!p || typeof p !== "object") return null;
  const body = p as Record<string, unknown>;
  if (typeof body.principalId !== "string" || typeof body.capabilityId !== "string") return null;
  return {
    principalId: body.principalId,
    capabilityId: body.capabilityId,
    constraints: typeof body.constraints === "string" ? body.constraints : null,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  };
}

// ---------------------------------------------------------------------------- audit

/** The control-plane audit log — every decision this UI makes lands here, and it is the only
 *  record of them. §2.2 puts it centrally with "none" on the node, because a control-plane change
 *  can only *happen* centrally now. */
export interface PolicyAuditEntry {
  id: string;
  action: string;
  actorScope: string;
  osUser: string | null;
  hostname: string | null;
  nodeId: string | null;
  principalId: string | null;
  capabilityId: string | null;
  grantId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------- replication state

export interface NodePolicyState {
  nodeId: string;
  /** BIGINT over the wire. See the header — coerced in the store, not in the driver's type
   *  parser, so it is read through `num()` here rather than trusted to be a number. */
  replicaVersion: Numeric;
  schemaVersion: number | null;
  lastPulledAt: string | null;
  lastResetAt: string | null;
  behindBy: Numeric;
}

export interface FleetPolicyState {
  centralVersion: Numeric;
  nodes: NodePolicyState[];
}

/** How far behind the worst node is, or null when no node has ever pulled. The number a revoke is
 *  actually measured by — a grant taken away here is gone on a node only once it pulls. */
export function worstBehind(state: FleetPolicyState | null | undefined): number | null {
  const values = (state?.nodes ?? []).map((n) => num(n.behindBy)).filter((v): v is number => v !== null);
  return values.length ? Math.max(...values) : null;
}

// ---------------------------------------------------------------------------- fetchers

export const policy = {
  capabilities: {
    list: () => request<PolicyCapability[]>("/policy/capabilities"),
    create: (body: NewCapability) =>
      request<PolicyCapability>("/policy/capabilities", { method: "POST", body: JSON.stringify(body) }),
    // Refused server-side on a destructive capability, so no caller needs its own copy of that
    // rule — it surfaces whatever error comes back.
    setAutoGrant: (id: string, autoGrant: boolean) =>
      request<PolicyCapability>(`/policy/capabilities/${encodeURIComponent(id)}/auto-grant`, {
        method: "PATCH",
        body: JSON.stringify({ autoGrant }),
      }),
  },
  principals: {
    list: () => request<PolicyPrincipal[]>("/policy/principals"),
    create: (body: NewPrincipal) =>
      request<PolicyPrincipal>("/policy/principals", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, patch: PrincipalPatch) =>
      request<PolicyPrincipal>(`/policy/principals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
  },
  grants: {
    /** Returns REVOKED ROWS TOO — filter with `activeGrants` unless you mean the history. */
    list: (params: { principalId?: string; capabilityId?: string } = {}) =>
      request<PolicyGrant[]>(`/policy/grants${qs(params)}`),
    create: (body: NewGrant) => request<PolicyGrant>("/policy/grants", { method: "POST", body: JSON.stringify(body) }),
    // 200 with the revoked row rather than a 204, and the row is worth keeping: its `revokedAt` is
    // what puts the grant on the deny-list every node fetches in full on every poll.
    revoke: (id: string, reason?: string) =>
      request<PolicyGrant>(`/policy/grants/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      }),
  },
  approvals: {
    list: (params: { status?: PolicyApprovalStatus } = {}) => request<PolicyApproval[]>(`/policy/approvals${qs(params)}`),
    decide: (id: string, status: "approved" | "denied", reason?: string) =>
      request<PolicyApproval>(`/policy/approvals/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        body: JSON.stringify({ status, reason }),
      }),
  },
  audit: (params: { limit?: number } = {}) => request<{ entries: PolicyAuditEntry[] }>(`/policy/audit${qs(params)}`),
  /** Who is behind, and by how much — `GET /api/fleet/policy`. A fleet route by URL and a policy
   *  question by subject, which is why it lives here rather than in ./fleet.ts. */
  nodeState: () => request<FleetPolicyState>("/fleet/policy"),
};
