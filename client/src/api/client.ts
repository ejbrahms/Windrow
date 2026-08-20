import type {
  Approval,
  ApprovalStatus,
  Capability,
  DirectoryBrowseResult,
  DiscoveryLastResult,
  DiscoveryResult,
  DiscoverySourceEntry,
  DriftReport,
  Grant,
  HookIntegrityState,
  InvokeResult,
  OwnerProposalsResult,
  OwnerStatus,
  PackageActionResult,
  PackageStatus,
  Principal,
  ProviderStatus,
  RollupFieldsResult,
  RollupSummary,
  SkillRemoveResult,
  SkillTarget,
  SkillTargetPresence,
  SkillWriteResult,
  UsageEvent,
  UsageSummary,
  UsageSummaryParams,
} from "./types";

// All requests are relative so the app works both through the Vite dev
// proxy (see vite.config.ts) and when served behind the same host as the
// API in production.
const BASE = "/api";

// There is no token here any more, and deliberately none baked into the bundle.
//
// The API authenticates callers with a per-node client certificate over mutual TLS
// (docs/design/per-node-enrollment-credentials.md), so identity is carried by the TLS handshake
// rather than by a header the bundle has to hold. That removes a real weakness of the old build:
// `VITE_WINDROW_API_TOKEN` was compiled into the shipped JavaScript, so anyone who could read the
// bundle held the admin credential for the whole fleet.
//
// In development the Vite proxy presents the certificate on the browser's behalf (see
// vite.config.ts), so `npm run dev` needs nothing installed. A production browser must have its
// own client certificate in the OS certificate store.

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Shared by every module under src/api/ — exported so a feature module (see nativeCalls.ts) can
 * add its own fetchers without re-deriving the base URL, the dev-proxy token rule or the
 * ApiError shape. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore — not all error responses are JSON
    }
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : null) ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "";
  const search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `?${search.toString()}`;
}

export const api = {
  capabilities: {
    list: () => request<Capability[]>("/capabilities"),
    create: (body: Pick<Capability, "kind" | "name" | "owner" | "riskTier" | "description">) =>
      request<Capability>("/capabilities", { method: "POST", body: JSON.stringify(body) }),
    // F5 — refused server-side for a 'destructive' capability, so the caller (CatalogPage) never
    // needs its own copy of that rule; it just surfaces whatever error comes back.
    setAutoGrant: (id: string, autoGrant: boolean) =>
      request<Capability>(`/capabilities/${id}/auto-grant`, { method: "PATCH", body: JSON.stringify({ autoGrant }) }),
  },
  principals: {
    list: () => request<Principal[]>("/principals"),
    create: (body: { kind: Principal["kind"]; name: string; parentRole?: string | null }) =>
      request<Principal>("/principals", { method: "POST", body: JSON.stringify(body) }),
    // F7 — applies the read-only baseline and flips a first-sighted role to 'active'.
    approve: (id: string, reason?: string) =>
      request<Principal>(`/principals/${id}/approve`, { method: "POST", body: JSON.stringify({ reason }) }),
    // Leaves the principal at zero grants permanently instead of re-litigating it every sighting.
    deny: (id: string, reason?: string) =>
      request<Principal>(`/principals/${id}/deny`, { method: "POST", body: JSON.stringify({ reason }) }),
    // Owner proposals (docs/design/global-identity-and-central-db.md §1.6): the modal
    // `usage_events.osUser` per instance principal, computed per request and stored nowhere until
    // a human confirms it. "needs_review" is the queue; "all" includes decided instances and ones
    // with no evidence to propose from.
    ownerProposals: (params: { status?: "needs_review" | "all" } = {}) =>
      request<OwnerProposalsResult>(`/principals/owner-proposals${qs(params)}`),
    // The human's decision. `osUser` is whatever they chose — the proposal is a suggestion, so
    // correcting it is the same call as accepting it. `proposedOsUser` is recorded in the audit
    // entry as what they were shown, which is what makes the decision reconstructable after the
    // heuristic changes.
    setOwner: (
      id: string,
      body: { status: OwnerStatus; osUser?: string; ownerPrincipalId?: string | null; proposedOsUser?: string | null; reason?: string }
    ) => request<{ principal: Principal }>(`/principals/${id}/owner`, { method: "POST", body: JSON.stringify(body) }),
  },
  grants: {
    list: (params: { principalId?: string; capabilityId?: string } = {}) =>
      request<Grant[]>(`/grants${qs(params)}`),
    create: (body: {
      principalId: string;
      capabilityId: string;
      constraints?: string | null;
      expiresAt?: string | null;
    }) => request<Grant>("/grants", { method: "POST", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/grants/${id}`, { method: "DELETE" }),
  },
  approvals: {
    list: (params: { status?: ApprovalStatus } = {}) => request<Approval[]>(`/approvals${qs(params)}`),
    approve: (id: string) => request<{ approval: Approval }>(`/approvals/${id}/approve`, { method: "POST" }),
    deny: (id: string, reason?: string) =>
      request<{ approval: Approval }>(`/approvals/${id}/deny`, { method: "POST", body: JSON.stringify({ reason }) }),
    // F3: turns a one-time "consent" approval into a real expiresAt grant, so the same
    // principal+capability pair doesn't have to ask again for `hours` (default 1).
    extendGrant: (id: string, hours?: number) =>
      request<{ approval: Approval; grant: Grant }>(`/approvals/${id}/extend-grant`, {
        method: "POST",
        body: JSON.stringify({ hours }),
      }),
  },
  invoke: (body: { principalId: string; capabilityId: string; correlationId?: string }) =>
    request<InvokeResult>("/invoke", { method: "POST", body: JSON.stringify(body) }),
  usage: {
    list: (params: { principalId?: string; capabilityId?: string; limit?: number } = {}) =>
      request<UsageEvent[]>(`/usage${qs(params)}`),
    summary: (params: UsageSummaryParams = {}) =>
      request<UsageSummary>(`/usage/summary${qs({ ...params })}`),
  },
  drift: () => request<DriftReport>("/drift"),
  discovery: {
    run: () => request<DiscoveryResult>("/discovery/run", { method: "POST" }),
    // Discovery may never have run yet (fresh install) — that's a real, expected 404, not an
    // error state, so callers should treat it as "no result" rather than surfacing it.
    last: () => request<DiscoveryLastResult>("/discovery/last"),
    sources: {
      list: () => request<DiscoverySourceEntry[]>("/discovery/sources"),
      create: (body: { path: string; label?: string | null; kind?: DiscoverySourceEntry["kind"] }) =>
        request<DiscoverySourceEntry>("/discovery/sources", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: { path?: string; label?: string | null; enabled?: boolean }) =>
        request<DiscoverySourceEntry>(`/discovery/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<void>(`/discovery/sources/${id}`, { method: "DELETE" }),
    },
    // Server-side directory listing backing the Sources page's "Browse…" picker (path is on the
    // server's machine, not the browser's — see server/app.js). Omit `path` for the roots.
    browse: (path?: string) => request<DirectoryBrowseResult>(`/discovery/browse${qs({ path })}`),
  },
  rollup: {
    fields: () => request<RollupFieldsResult>("/rollup/fields"),
    summary: () => request<RollupSummary>("/rollup/summary"),
  },
  providers: {
    list: () => request<ProviderStatus[]>("/providers"),
    install: (id: string) => request<ProviderStatus>(`/providers/${id}/install`, { method: "POST" }),
    uninstall: (id: string) => request<ProviderStatus>(`/providers/${id}/uninstall`, { method: "POST" }),
  },
  hookIntegrity: {
    get: () => request<HookIntegrityState>("/hook-integrity"),
  },
  packages: {
    list: () => request<PackageStatus[]>("/packages"),
    enable: (id: string) => request<PackageActionResult>(`/packages/${id}/enable`, { method: "POST" }),
    disable: (id: string) => request<PackageActionResult>(`/packages/${id}/disable`, { method: "POST" }),
    sync: (id: string) => request<PackageActionResult>(`/packages/${id}/sync`, { method: "POST" }),
    revoke: (id: string) => request<PackageActionResult>(`/packages/${id}/revoke`, { method: "POST" }),
  },
  skills: {
    targets: () => request<SkillTarget[]>("/skills/targets"),
    presence: (name: string) => request<SkillTargetPresence[]>(`/skills/${encodeURIComponent(name)}/presence`),
    create: (body: { name: string; description?: string; targetIds: string[] }) =>
      request<SkillWriteResult>("/skills", { method: "POST", body: JSON.stringify(body) }),
    remove: (name: string, targetIds?: string[]) =>
      request<SkillRemoveResult>(`/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
        body: JSON.stringify({ targetIds }),
      }),
  },
};
