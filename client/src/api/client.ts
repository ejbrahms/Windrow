import type {
  Capability,
  DirectoryBrowseResult,
  DiscoveryLastResult,
  DiscoveryResult,
  DiscoverySourceEntry,
  DriftReport,
  Grant,
  HookIntegrityState,
  InvokeResult,
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

// The dev proxy injects the API's bearer token server-side (see vite.config.ts), so nothing is
// needed here in development. A production build that serves the client separately from the
// proxy needs the token baked in at build time via VITE_GOVERNANCE_API_TOKEN.
const TOKEN = import.meta.env.VITE_GOVERNANCE_API_TOKEN as string | undefined;

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
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

function qs(params: Record<string, string | number | undefined>): string {
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
  },
  principals: {
    list: () => request<Principal[]>("/principals"),
    create: (body: { kind: Principal["kind"]; name: string; parentRole?: string | null }) =>
      request<Principal>("/principals", { method: "POST", body: JSON.stringify(body) }),
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
