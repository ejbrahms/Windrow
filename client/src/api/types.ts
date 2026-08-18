// Mirrors docs/design/api-contract.md

export type CapabilityKind = "skill" | "mcp_tool";
export type RiskTier = "read_only" | "mutating" | "destructive";
export type PrincipalKind = "role" | "instance";
// "approved" (F3, docs/design/governance-review-2026-08-16.md) is distinct from "ok": "ok" means
// an active grant covered the call from the start; "approved" means the call was initially denied
// (no grant), the hook asked the harness's own permission prompt, and a human said yes — see
// POST /api/usage/:id/approve-consent and the matching "consent" Approval below.
export type UsageOutcome = "ok" | "denied" | "error" | "approved";

export type CapabilitySource = "filesystem" | "usage-history-only" | "mcp-manifest" | "manual";

export interface RealUsage {
  usageCount: number;
  lastUsedAt: string;
}

export interface Capability {
  id: string;
  kind: CapabilityKind;
  name: string;
  owner: string;
  riskTier: RiskTier;
  description: string;
  // Discovery (v1) fields — docs/design/api-contract.md. Absent/null on capabilities created
  // before discovery existed and never (re)matched by a scan.
  source?: CapabilitySource;
  discoveredAt?: string | null;
  lastSeenAt?: string | null;
  stale?: boolean;
  // Real historical usage imported from this machine's own Claude Code record — distinct from
  // (and not to be confused with) this system's own simulated UsageEvent log.
  realUsage?: RealUsage | null;
  // True when this capability's own `autoGrant` flag (server/store.js) makes server/app.js's
  // findActiveGrant bypass the grant table entirely for it — every principal effectively already
  // has it, so granting/revoking it here would be a no-op the UI shouldn't offer as if it did
  // something. Never true for a 'destructive' capability — the server refuses to set it there.
  autoGranted?: boolean;
}

export interface DiscoveryResult {
  added: Capability[];
  updated: Capability[];
  staled: Capability[];
}

export interface DiscoveryLastResult extends DiscoveryResult {
  ranAt: string;
}

// Manually configured discovery source — either a filesystem scan root (server/discovery/scan.js)
// or a custom MCP tool manifest file (server/discovery/mcpManifest.js) — what the Sources page
// lets an admin add/enable/disable/remove, backed by server/store.js's discovery_sources table.
export type DiscoverySourceKind = "skill_dir" | "mcp_manifest";

export interface DiscoverySourceEntry {
  id: string;
  path: string;
  label: string | null;
  // 'skill_dir': a directory scan.js walks for SKILL.md files. 'mcp_manifest': a JSON file, same
  // shape as known-mcp-tools.json, mcpManifest.js merges in. Defaults to 'skill_dir' server-side,
  // so every row (including ones from before this field existed) always has one.
  kind: DiscoverySourceKind;
  enabled: boolean;
  // Seeded from server/config.js's defaults the first time the table was empty, vs. added by a
  // human afterward — shown as a badge, doesn't restrict any action (a built-in can be edited or
  // removed just like any other source).
  builtIn: boolean;
  createdAt: string;
  // Computed at read time (fs.existsSync on the server) — lets the UI flag a configured path that
  // doesn't exist on this machine without failing the whole list.
  exists: boolean;
}

// One page of server/app.js's GET /api/discovery/browse — the directory picker backing Sources'
// "Browse…" button walks the server's filesystem one level at a time using these.
export interface DirectoryBrowseEntry {
  name: string;
  path: string;
}

export interface DirectoryBrowseResult {
  path: string;
  parent: string | null;
  entries: DirectoryBrowseEntry[];
}

export interface Principal {
  id: string;
  kind: PrincipalKind;
  name: string;
  parentRole: string | null;
  // Real agent-runtime identity fields (roadmap item 2) — set on `instance` principals that were
  // mapped from an actual running agent via server/principals/, absent on manually-defined roles
  // (Claude Code's own Task-tool subagent types, which have no agent-runtime identity of their own).
  humanName?: string | null;
  backend?: string | null;
  agentType?: string | null;
  field?: string | null;
  // Set on principals synthesized outside any tracked agent runtime entirely (bare terminal, CI) —
  // see docs/design/cross-field-and-standalone.md. `field` is always null when this is true.
  standalone?: boolean;
  // F7 (docs/design/governance-review-2026-08-16.md): a role minted by first sighting lands
  // 'pending' with zero grants; POST /principals/:id/approve flips it to 'active' and applies the
  // read-only baseline, POST /principals/:id/deny flips it to 'denied' permanently. Older rows and
  // anything created through the admin-only create form default to 'active'.
  status?: "pending" | "active" | "denied";
}

export interface Grant {
  id: string;
  principalId: string;
  capabilityId: string;
  constraints: string | null;
  createdAt: string;
  expiresAt: string | null;
}

// Pending-approval queue (docs/design/governance-review-2026-08-16.md, F1/F3): the write side of a
// destructive grant/revoke a non-admin caller (the governance MCP server's proposer token) can only
// *request*, never execute directly — server/app.js's POST /api/grants/propose and
// POST /api/grants/:id/propose-revoke create these; only POST /api/approvals/:id/approve|deny
// (admin-only) resolves one.
// "consent" (F3) is the ask-consent record created by POST /api/usage/:id/approve-consent once a
// destructive call with no grant got a "yes" out of the harness's own permission prompt — unlike
// "grant"/"revoke" it's never pending: by the time it can exist, the human has already answered.
export type ApprovalAction = "grant" | "revoke" | "consent";
export type ApprovalStatus = "pending" | "approved" | "denied";

export interface ApprovalGrantPayload {
  principalId: string;
  capabilityId: string;
  constraints: string | null;
  expiresAt: string | null;
}
export interface ApprovalRevokePayload {
  grantId: string;
}
export interface ApprovalConsentPayload {
  usageEventId: string;
  correlationId: string | null;
  // Always "once" as written — POST /api/approvals/:id/extend-grant is what turns this into a real
  // expiresAt grant after the fact; resultGrantId being set on the Approval is the actual marker
  // that happened, this field is left as a human-readable label.
  decision: "once";
}

export interface Approval {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  principalId: string | null;
  capabilityId: string | null;
  payload: ApprovalGrantPayload | ApprovalRevokePayload | ApprovalConsentPayload;
  requestedByScope: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedByScope: string | null;
  reason: string | null;
  resultGrantId: string | null;
}

export interface UsageEvent {
  id: string;
  principalId: string;
  capabilityId: string;
  ts: string;
  outcome: UsageOutcome;
  latencyMs: number;
  correlationId: string | null;
  reason: string | null;
  // Latency breakdown (docs/design/latency-breakdown.md) — null on events logged before this
  // existed, or that failed open before the phase that fills it in ever ran.
  capabilityLookupMs: number | null;
  principalResolveMs: number | null;
  brokerMs: number | null;
  grantCheckMs: number | null;
  // Real computer account/machine that issued this call (server/principals/fromEnv.js), forwarded
  // by the hook that made it. Null for events without a hook behind them — e.g. a manual invoke
  // fired from this dashboard's own Invoke panel.
  osUser: string | null;
  hostname: string | null;
}

export interface InvokeResult {
  allowed: boolean;
  event: UsageEvent;
}

export interface UsageSummaryTotals {
  calls: number;
  denied: number;
  denialRate: number;
  avgLatencyMs: number;
  // Per-phase averages for bottleneck-hunting (docs/design/latency-breakdown.md) — null when no
  // event in the window carries that phase, not 0.
  avgCapabilityLookupMs: number | null;
  avgPrincipalResolveMs: number | null;
  avgBrokerMs: number | null;
  avgGrantCheckMs: number | null;
}

export interface UsageByCapability {
  capabilityId: string;
  name: string;
  calls: number;
  denied: number;
  avgLatencyMs: number;
}

export interface UsageByPrincipal {
  principalId: string;
  name: string;
  calls: number;
  denied: number;
}

export type UsageGranularity = "minute" | "hour" | "day";

export interface UsageBucket {
  // ISO timestamp marking the start of the bucket — LineChart formats it per `granularity`.
  bucket: string;
  calls: number;
  denied: number;
  // Total round-trip latency (tool + harness overhead combined) within this bucket — null, not 0,
  // when the bucket has no events.
  avgLatencyMs: number | null;
  // Per-phase averages within this bucket (docs/design/latency-breakdown.md) — null, not 0, when
  // no event in the bucket carries that phase.
  avgCapabilityLookupMs: number | null;
  avgPrincipalResolveMs: number | null;
  avgBrokerMs: number | null;
  avgGrantCheckMs: number | null;
}

export interface UsageSummary {
  totals: UsageSummaryTotals;
  byCapability: UsageByCapability[];
  byPrincipal: UsageByPrincipal[];
  byBucket: UsageBucket[];
  granularity: UsageGranularity;
  windowMinutes: number;
}

export interface UsageSummaryParams {
  granularity?: UsageGranularity;
  // Custom lookback window, in minutes — lets the x-axis granularity control ("hours, minutes,
  // custom") pick both the bucket width and how far back it spans.
  windowMinutes?: number;
  capabilityKind?: CapabilityKind;
  riskTier?: RiskTier;
  capabilityOwner?: string;
  capabilitySource?: CapabilitySource;
}

export interface UnusedGrant {
  grantId: string;
  principalName: string;
  capabilityName: string;
  grantedAt: string;
  lastUsedAt: string;
}

export interface HighDenialCapability {
  capabilityId: string;
  name: string;
  denialRate: number;
  calls: number;
}

export interface DriftReport {
  unusedGrants: UnusedGrant[];
  highDenial: HighDenialCapability[];
}

// Provider hook-install status (server/providers.js) — one entry per backend adapter
// (server/hooks/*.js), reflecting whether that backend's own hook-config file actually has the
// PreToolUse/PostToolUse entries wired in, not just whether the hook scripts exist on disk.
export interface ProviderStatus {
  id: string;
  label: string;
  // Key into client/src/components/ProviderIcon.tsx's ICONS map (server/providers.js
  // ADAPTERS[id].icon). Null for an adapter that hasn't set one; ProviderIcon falls back to a
  // generic glyph rather than rendering nothing.
  icon: string | null;
  // Null when this backend has no known hook-config file location yet (e.g. Codex) — install is
  // never possible in that case regardless of `installable`.
  configPath: string | null;
  configExists: boolean;
  installed: boolean;
  // False when there's nowhere to write yet (configPath is null) even though the hook scripts
  // themselves already exist in hookFiles below.
  installable: boolean;
  hookFiles: string[];
  // Set when configPath exists but couldn't be parsed as JSON — install/uninstall would refuse
  // to touch it rather than risk clobbering a human-edited file.
  error: string | null;
}

// Persisted state behind GET /api/hook-integrity (server/store.js, server/hookWatcher.js) — the
// tamper-check/self-heal poller's log of times a backend's own hook-config file lost its
// PreToolUse/PostToolUse entries and whether the watcher put them back.
export interface HookIntegrityEntry {
  ts: string;
  provider: string;
  configPath: string;
  reason: string;
  repaired: boolean;
}

export interface HookIntegrityState {
  everInstalled: Record<string, boolean>;
  log: HookIntegrityEntry[];
}

// Capability packages (docs/design/capability-packages.md, server/packages.js) — a bundle of
// capabilities by owner (provider or integration) behind one enabled flag and a default grant
// policy, so turning a package on grants sane defaults instead of a human tracking down every new
// capability that needs one. Distinct from ProviderStatus above: that's about whether a backend's
// PreToolUse/PostToolUse hooks are *wired up*; this is about what gets *granted by default* once
// they are — a provider package and an integration package are both packages, just with owners: []
// for providers (they don't own any capabilities directly, only enable the roles that use them).
export type PackageKind = "provider" | "integration";

export interface PackageCoverage {
  // How many (capability, role) pairs the policy says should be granted, and how many already are
  // — "granted < total" is exactly what a Sync would close.
  granted: number;
  total: number;
}

export interface PackageStatus {
  id: string;
  kind: PackageKind;
  label: string;
  description: string;
  owners: string[];
  roles: string[];
  enabled: boolean;
  capabilityCount: number;
  coverage: PackageCoverage;
}

export interface PackageSyncResult {
  packageId: string;
  granted: number;
  alreadyPresent: number;
  skipped: number;
}

export interface PackageRevokeResult {
  packageId: string;
  revoked: number;
}

export interface PackageActionResult {
  package: PackageStatus;
  sync?: PackageSyncResult;
  revoke?: PackageRevokeResult;
}

// Skills management (server/skills.js) — the write path for SKILL.md across every provider's
// skill directory. Distinct from Capability: skills are catalog-only (docs/design/
// skill-mcp-governance.md §0), so this lives outside the grant/usage system entirely; GET
// /api/capabilities (filtered to kind==='skill') is still the read side for the catalog view.

export interface SkillTarget {
  id: string;
  label: string;
  path: string;
  exists: boolean;
}

export interface SkillTargetPresence extends SkillTarget {
  present: boolean;
}

export interface SkillWriteResult {
  slug: string;
  written: string[];
  discovery: DiscoveryResult;
}

export interface SkillRemoveResult {
  slug: string;
  removed: string[];
  discovery: DiscoveryResult;
}

// Cross-workspace / standalone rollup (docs/design/cross-field-and-standalone.md)

export interface RollupFieldStatus {
  field: string;
  // Null for a workspace discovered only via principal data inside another workspace's shared db
  // (Mode B) — it never had a `server/data/governance.db` of its own on this machine. See `sharedOnly`.
  fieldPath: string | null;
  dbPath: string | null;
  reachable: boolean;
  error: string | null;
  principalCount: number;
  eventCount: number;
  lastEventAt: string | null;
  sharedOnly: boolean;
}

export interface RollupFieldsResult {
  root: string;
  thisField: string;
  fields: RollupFieldStatus[];
}

export interface RollupFieldUsage {
  field: string;
  // Null when this workspace's calls were only observed via principal attribution inside another
  // workspace's shared db, not read from a `governance.db` in that workspace's own directory.
  fieldPath: string | null;
  calls: number;
  denied: number;
  principalCount: number;
}

export interface RollupPrincipalUsage {
  name: string;
  field: string | null;
  standalone: boolean;
  backend: string | null;
  calls: number;
  denied: number;
}

export interface RollupStandaloneBackend {
  backend: string;
  calls: number;
  denied: number;
}

export interface RollupSummary {
  fields: { field: string; fieldPath: string; reachable: boolean; error: string | null }[];
  totals: { calls: number; denied: number; denialRate: number };
  byField: RollupFieldUsage[];
  byPrincipal: RollupPrincipalUsage[];
  standalone: { calls: number; denied: number; byBackend: RollupStandaloneBackend[] };
}
