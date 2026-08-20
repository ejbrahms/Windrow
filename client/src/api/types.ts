// Mirrors docs/design/api-contract.md

export type CapabilityKind = "skill" | "mcp_tool";
export type RiskTier = "read_only" | "mutating" | "destructive";
// "user" is the *subject* of a call — the OS account it is accountable to, keyed on `subjectId`
// (docs/design/global-identity-and-central-db.md §1.4) — as opposed to "role"/"instance", which
// describe the agent that made it. Nothing authorizes off a user row yet: phase 1 records the
// subject, phase 5 flips the grant onto it.
export type PrincipalKind = "role" | "instance" | "user";
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
  // A mutable display label, never an identity. On a "user" principal it is the OS username and
  // can be renamed freely (PATCH /principals/:id/name) because that row is keyed on `subjectId`;
  // on a "role"/"instance" row it still doubles as the lookup key (agentType / loom id) until the
  // subject flip, which is why the rename route refuses those kinds.
  name: string;
  // The stable key, on "user" principals only: an opaque OS identifier prefixed by the authority
  // that issued it — "win-sid:S-1-5-…-1001", "posix:1000@host", "env-user:name@host" (display
  // assurance only), "federated:…" reserved. Null on agent-shaped rows.
  subjectId?: string | null;
  // How that key was obtained: 3 server-verified, 2 OS-read on this machine, 1 env-derived. Null
  // where there is no subject. Windrow reads tier 2 on Windows/POSIX and falls back to 1.
  // Ratchets up only — this is the strongest reading ever made of the key, so for how a *particular*
  // call was identified, read `UsageEvent.assuranceLevel` instead.
  assuranceLevel?: AssuranceLevel | null;
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
  // Who this agent instance belongs to (docs/design/global-identity-and-central-db.md §1.6,
  // phase 4). Only ever written by a human confirming a proposal on the dashboard — the
  // suggestion itself is computed per request and stored nowhere, so these fields are a decision
  // and never a guess. 'unassigned' on every row until someone decides.
  ownerStatus?: OwnerStatus;
  // The OS account confirmed as the owner. A bare username, exactly as `usage_events.osUser`
  // recorded it — not a subject key, because a username carries no SID or host qualifier.
  ownerOsUser?: string | null;
  // The existing "user" principal for that account, when there is one. Null is a legitimate
  // confirmed state: the account can be named without a subject row existing for it yet.
  ownerPrincipalId?: string | null;
  ownerConfirmedAt?: string | null;
  ownerConfirmedBy?: string | null;
}

/** 'unassigned' — nobody has decided. 'dismissed' — a human looked and could not name an owner,
 * which is a decision and stops the proposal recurring. */
export type OwnerStatus = "unassigned" | "confirmed" | "dismissed";

/** One OS account seen on an instance's calls, and how much of its traffic it accounts for. */
export interface OwnerCandidate {
  osUser: string;
  events: number;
  hostnames: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The suggestion: the modal `usage_events.osUser` for an instance, plus the evidence a human
 * needs to disagree with it. Never applied automatically — §1.6 is explicit that this is "a
 * dashboard suggestion for a human to confirm, never an automatic remap". */
export interface OwnerProposalDetail extends OwnerCandidate {
  // Events carrying any osUser at all, and the instance's full event count — a 3-of-3 modal name
  // on an agent with 900 identity-less events is not the same claim as 3-of-3 overall.
  identifiedEvents: number;
  totalEvents: number;
  eventsWithoutOsUser: number;
  /** `events / identifiedEvents`. */
  share: number;
  /** Too few events to mean anything on their own. */
  weak: boolean;
  /** The instance's calls are split across accounts — a shared or reused loom. */
  contested: boolean;
  // The existing "user" principal this would map to, if any. `matchBasis` says how it was found:
  // "subject-key" is the exact `env-user:<name>@<host>` key a hook would produce; "label" is a
  // case-insensitive display-name match, which repeats across machines and is weaker.
  matchedUser: { id: string; name: string; subjectId: string | null; assuranceLevel: AssuranceLevel | null } | null;
  matchBasis: "subject-key" | "label" | null;
}

export interface OwnerProposal {
  principal: Principal;
  owner: {
    status: OwnerStatus;
    osUser: string | null;
    principalId: string | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  /** Null when the instance has no event carrying an osUser — there is nothing to propose, which
   * is worth showing rather than omitting the agent. */
  proposal: OwnerProposalDetail | null;
  /** Every account seen, most-used first, so a human can pick a non-modal one. */
  candidates: OwnerCandidate[];
}

export interface OwnerProposalsResult {
  status: "needs_review" | "all";
  summary: {
    instances: number;
    confirmed: number;
    dismissed: number;
    needsReview: number;
    noEvidence: number;
  };
  proposals: OwnerProposal[];
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
  // Which node recorded this event, and where it sits in that node's own hash chain
  // (docs/design/global-identity-and-central-db.md §2.7 phase 1). Assigned by the server at
  // insert, so both are null on the copy `POST /invoke` hands back — that response is returned
  // before the row is written — and on rows predating the columns.
  nodeId: string | null;
  seq: number | null;
  ts: string;
  // When the *node* stamped the row, against `ts` above, which is when the *caller* said the call
  // happened. Two clocks, kept apart on purpose: `observedAt - ts` is the only measurable evidence
  // of skew between the machine that made the call and the one that recorded it. Sort by `ts` to
  // read the log as the callers experienced it, by `observedAt` to read it as this node saw it.
  observedAt: string | null;
  principalId: string;
  capabilityId: string;
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
  // The calling agent, snapshotted onto the call. Prefer these over joining `principalId` to a
  // principal row when attributing historical usage: the principal row is mutable (identity gets
  // back-filled, an instance can be repointed at another role) so a join rewrites the past,
  // whereas these are what the hook observed when the call was made. Null on events predating
  // the columns, and on events with no hook behind them (e.g. this dashboard's Invoke panel).
  actorLoomId: string | null;
  actorAgentType: string | null;
  actorBackend: string | null;
  actorField: string | null;
  // The subject this call was accountable to, and how strongly that identity was established *for
  // this call* — 3 server-verified, 2 OS-read on the calling machine, 1 env-derived username. Read
  // it here rather than off the subject principal: `Principal.assuranceLevel` only ever ratchets
  // up, so it says how well this person has *ever* been identified, while this says how well they
  // were identified when the call happened. Null means not recorded (an event predating the
  // columns, or one with no hook behind it) — which is not the same claim as tier 1.
  subjectId: string | null;
  assuranceLevel: AssuranceLevel | null;
}

/** 3 server-verified, 2 OS-read on this machine, 1 env-derived — see `assuranceLabel`. */
export type AssuranceLevel = 1 | 2 | 3;

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
  // The grouping key. `name` is a platform-assigned nickname that may repeat across principals and
  // changes on respawn, so it is a label only — see docs/design/global-identity-and-central-db.md.
  principalId: string;
  name: string;
  // The agent/role name (a loom id, for instances) — null when the principal row is gone. Tells
  // two rows apart when they carry the same nickname.
  agentName: string | null;
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
  // The node that owns this db — one governance.db and the server process that writes it
  // (docs/design/global-identity-and-central-db.md §2.7 phase 1). Two workspaces reporting the
  // same nodeId are sharing one db (Mode B), which is why their event counts are not additive.
  // Null on a workspace whose server hasn't started since that id was introduced.
  nodeId: string | null;
  reachable: boolean;
  error: string | null;
  // Reachable but only partially read: this workspace's db is on a different schema version than
  // ours and a table the rollup wanted wasn't there. Counts on this row may be low, not wrong.
  warnings: string[];
  principalCount: number;
  eventCount: number;
  lastEventAt: string | null;
  sharedOnly: boolean;
}

// Which source answered, and what it covers — docs/design/global-identity-and-central-db.md §2.7
// phase 5. `local-scan` is this machine's workspace directories, read off disk; `central` is one
// query over every node that has reported. The two answer different questions, so a page that
// renders either must say which it got rather than labelling both "the fleet".
export type RollupSource = "central" | "local-scan";

export interface RollupProvenance {
  source: RollupSource;
  // Why the central query was not used, when `auto` fell back to the scan. Null when central
  // answered, and null when no central is configured at all.
  centralError: string | null;
  // Null nodeIds means every node central has heard from. A list means the caller's certificate
  // scoped the answer — a node certificate reaches this route only for its own node's rows.
  scope: { nodeIds: string[] | null };
  // The window central was asked for, ISO. Null means all time, which is what the scan always did.
  since: string | null;
}

export interface RollupFieldsResult extends RollupProvenance {
  // Null on the central path: the scan's root is a directory on this machine, and a fleet has none.
  root: string | null;
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
  // The grouping key, same as UsageByPrincipal: never the display name.
  principalId: string;
  name: string;
  agentName: string | null;
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

export interface RollupSummary extends RollupProvenance {
  fields: { field: string; fieldPath: string; nodeId: string | null; reachable: boolean; error: string | null; warnings: string[] }[];
  totals: {
    calls: number;
    denied: number;
    denialRate: number;
    // Events seen more than once across the workspaces merged above and counted only once — the
    // shared-db deployment reaches the same rows through every workspace directory pointing at it.
    // Non-zero is normal there and is what `calls` no longer double-counts. Always 0 when
    // `source` is "central", and 0 there by construction rather than by measurement: ingest is
    // idempotent on (nodeId, seq), so a duplicate never becomes a row to skip.
    duplicatesSkipped: number;
    // Measured disagreement between the node's clock (`observedAt`) and the caller's (`ts`), in ms.
    // `sampled` is how many events carried both; a small sample means not-yet-measurable rather
    // than no skew. `maxBehindMs` is the direction that shouldn't happen — a call claiming a time
    // later than the node that recorded it.
    clockSkew: { sampled: number; maxAheadMs: number | null; maxBehindMs: number | null };
    // Central only. Calls whose workspace could not be established at all — no actorField, and no
    // principal row carrying one. The scan had no such number because it attributed them to
    // whichever directory it read them from, which named a workspace unrelated to the call.
    unattributedCalls?: number;
    // Central only: how many nodes contributed to these totals.
    nodes?: number;
  };
  byField: RollupFieldUsage[];
  byPrincipal: RollupPrincipalUsage[];
  standalone: { calls: number; denied: number; byBackend: RollupStandaloneBackend[] };
}
