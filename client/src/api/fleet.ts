import { qs, request } from "./client";
// The bucket shape is shared with the node's own calls-over-time endpoint rather than redeclared —
// see `nativeSeries` at the bottom of this file for why that matters.
import type { NativeCallsGranularity, NativeCallsTimeseries } from "./nativeCalls";
// Same principle for governed decisions: the events page's calls-over-time chart and latency
// breakdown consume the node's `UsageBucket` unchanged, and central's `/fleet/usage/series` returns
// that identical shape — so `LineChart`/`LatencyBreakdownChart` draw either host's series without a
// second, drifting copy of the type. See `usageSeries` below.
import type { UsageBucket, UsageGranularity } from "./types";
// Type-only, so no runtime cycle with policy.ts (which imports num() from here): the drill-down
// grid keys capabilities by the same three risk tiers the policy module already names.
import type { PolicyRiskTier } from "./policy";

/**
 * Central's fleet surface — `GET /api/fleet/*`, read straight off server/central/queries.js.
 *
 * ITS OWN MODULE, not another branch of `api` in ./client.ts, for the reason ./nativeCalls.ts
 * gives about native observations: these routes exist on ONE host. `client/dist` is served by
 * central alone now (docs/design/dashboard-placement.md item 4), and central answers `/api/fleet`,
 * `/api/policy`, `/api/enroll` and `/health` — nothing else. Every fetcher in ./client.ts is a
 * machine-local route that 404s here, and every fetcher below is a route that 404s on a node. Two
 * modules is what stops that distinction being a comment somebody has to remember; see ./host.ts
 * for the runtime half of it.
 *
 * NUMBERS ARE NOT ALL NUMBERS. server/central/pgDriver.js parses BIGINT (oid 20) to a JS number
 * and leaves NUMERIC alone, so an average comes back as a string like "12.34" while a count comes
 * back as 12. Rather than pretend otherwise in the types, the averages are typed `Numeric` and
 * every reader runs them through `num()` — a lie in the type here would show up as `NaN` in a
 * tile, which is the one failure mode a dashboard cannot explain to its reader.
 */

/** A value Postgres may hand back as either — see the header. */
export type Numeric = number | string | null;

/** Coerce a Numeric to a number, or null. Never NaN: a tile showing NaN is worse than one showing
 *  an em dash, because the em dash says "not recorded" and NaN says "this page is broken". */
export function num(v: Numeric | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------- summary

export interface FleetTotals {
  events: number;
  nodes: number;
  principals: number;
  subjects: number;
  capabilities: number;
  denied: number;
  errored: number;
  approved: number;
  /** §2.6: rows an unfamiliar build shipped with no outcome column at all. Reported separately
   *  rather than folded into 'ok', because a fleet-wide schema skew showing up as healthy traffic
   *  is exactly what that column comment exists to prevent. */
  outcomeUnrecorded: number;
  withUnknownFields: number;
  avgLatencyMs: Numeric;
  worstClockSkewMs: number | null;
}

export interface FleetSummary {
  since: string;
  totals: FleetTotals;
  byOutcome: { outcome: string; n: number }[];
  byNode: { nodeId: string; n: number; denied: number }[];
}

// ---------------------------------------------------------------------------- roster

/** 'installed' is the only healthy value. 'unknown' means the node has never reported — which on
 *  a check whose subject is "has governance been switched off on that machine" is not the same
 *  claim as 'missing', and must not be drawn as if it were. */
export type HookStatus = "installed" | "tampered" | "missing" | "unknown";

export interface FleetNode {
  nodeId: string;
  hostname: string | null;
  osUser: string | null;
  certSubject: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastSeq: number | null;
  eventCount: number | null;
  lastClockSkewMs: number | null;
  hookStatus: HookStatus | null;
  hookInstalledCount: number | null;
  hookInstallableCount: number | null;
  hookBrokenCount: number | null;
  hookTamperCount: number | null;
  hookLastTamperAt: string | null;
  hookReportedAt: string | null;
  nativeLastSeenAt: string | null;
  /** How many times this machine has been REBUILT. On a disposable fleet it is the most
   *  operationally interesting number about a node, so it is surfaced rather than buried — see
   *  docs/design/dashboard-placement.md item 5. Optional because a central that predates the
   *  incarnation columns omits them entirely, and an absent column has to read as "not recorded"
   *  rather than as zero rebuilds. */
  lastIncarnation?: string | null;
  incarnationCount?: number | null;
  lastIncarnationAt?: string | null;
  /** `numeric` over the wire, not a number — see `age()` in ../pages/fleet/shared.tsx. Central's
   *  own arithmetic against its own clock, which is the only clock worth measuring staleness on. */
  silentForMs: Numeric;
  shipmentCount: number | null;
  /**
   * §5's divergence state, folded onto the roster so a node that is not enforcing is visible
   * without opening it. Optional for the same reason `lastIncarnation` is: a central that predates
   * docs/design/disposable-nodes.md §5 omits the columns entirely, and an absent column has to read
   * as "not recorded" rather than as "enforcing, valid". `paused` true is the alarming state; a
   * grace lease is ordinary maintenance and is deliberately not surfaced on the roster row.
   */
  paused?: boolean;
  pauseId?: string | null;
  pauseUntil?: string | null;
  pauseTiers?: string | null;
  pauseReason?: string | null;
  leaseUntil?: string | null;
  leaseTiers?: string | null;
  credentialState?: CredentialState | null;
  credentialNotAfter?: string | null;
  journalEntries?: number | null;
  journalLastAt?: string | null;
}

// ---------------------------------------------------------------------------- one node

export interface NodeStreamGap {
  /** Which lifetime the hole is in. Density was only ever a claim about one writer's output, and
   *  a writer is a lifetime rather than a machine. */
  incarnation: string | null;
  from: number;
  to: number;
  missing: number;
}

export interface NodeStream {
  nodeId: string;
  shipments: number | null;
  minSeq: number | null;
  maxSeq: number | null;
  lastReceivedAt: string | null;
  events: number | null;
  maxChainSeq: number | null;
  lastObservedAt: string | null;
  gaps: NodeStreamGap[];
  incarnations: number;
}

export interface ChainBreak {
  incarnation: string;
  at: number;
  kind: "missing" | "unlinked";
  detail: string;
}

export interface ChainHead {
  incarnation: string;
  seq: number;
  hash: string | null;
}

export interface NodeVerify {
  nodeId: string;
  checked: number;
  ok: boolean;
  breaks: ChainBreak[];
  breakCount: number;
  /** One per lifetime. `head` is the newest of them, flattened for the readers that predate
   *  incarnations. */
  heads: ChainHead[];
  incarnations: number;
  head: { seq: number; hash: string | null } | null;
}

// ---------------------------------------------------------------------------- usage

/** The dimensions server/central/queries.js's GROUPABLE allows. Anything else is a 500 whose
 *  message lists these, so the picker offers exactly this set rather than a free-text box. */
export const FLEET_USAGE_DIMENSIONS = [
  "principalId",
  "subjectId",
  "capabilityId",
  "nodeId",
  "outcome",
  "actorAgentType",
  "actorBackend",
  "actorField",
  "actorLoomId",
  "hostname",
  "osUser",
] as const;

export type FleetUsageDimension = (typeof FLEET_USAGE_DIMENSIONS)[number];

export interface FleetUsageRow {
  /**
   * A readable name for `key`, or null when nothing can name it.
   *
   * NULL IS A REAL ANSWER AND MUST BE RENDERED AS THE ID, never as a guess or a blank. Central
   * resolves this from its own registry and falls back to what the event recorded at call time; a
   * fleet whose catalog was never seeded upward has capability ids nothing can name, and showing
   * an empty cell there would read as "no capability" rather than "not named here".
   *
   * The key stays the id — see `usageBy` in server/central/queries.js on why grouping on a mutable
   * display name silently merges two agents or splits one.
   */
  label: string | null;
  key: string;
  calls: number;
  denied: number;
  avgLatencyMs: Numeric;
  lastSeenAt: string | null;
}

// ---------------------------------------------------------------------------- events

/** One shipped usage event as central stores it — the node's own columns in the node's own
 *  spelling, plus the four central assigns. `extra` is §2.6's forward-compatibility column and
 *  stays the canonical JSON *text* the node hashed, never a parsed object. */
export interface FleetEvent {
  id: string;
  nodeId: string;
  principalId: string | null;
  capabilityId: string | null;
  /** Resolved names, ADDED beside the ids rather than replacing them — a tail is for taking a
   *  suspicious row and looking it up, which needs the id. Null when unresolvable. */
  principalLabel: string | null;
  capabilityLabel: string | null;
  subjectId: string | null;
  ts: string | null;
  outcome: string | null;
  reason: string | null;
  latencyMs: number | null;
  /** The per-phase latency breakdown central stores beside the total — where the time went inside a
   *  single decision. Any may be null on a build that shipped no column for it (§2.6). */
  capabilityLookupMs: number | null;
  principalResolveMs: number | null;
  brokerMs: number | null;
  grantCheckMs: number | null;
  correlationId: string | null;
  osUser: string | null;
  hostname: string | null;
  actorLoomId: string | null;
  actorAgentType: string | null;
  actorBackend: string | null;
  actorField: string | null;
  assuranceLevel: number | null;
  seq: number | null;
  incarnation: string | null;
  observedAt: string;
  /** The node's own observedAt — kept because it is inside the node's hash chain. Central orders on
   *  `observedAt` (its arrival clock) instead; the two differing by more than `clockSkewMs` is worth
   *  a look. Null on a build that shipped no column for it. */
  nodeObservedAt: string | null;
  clockSkewMs: number | null;
  shipmentSeq: number | null;
  ingestKind: string | null;
  /** §2.6's forward-compatibility column — the exact canonical JSON string the node hashed, holding
   *  any field this build has no column for. Rendered token-highlighted in the event drawer. */
  extra: string | null;
}

// ---------------------------------------------------------------------------- alerts

export interface FleetAlert {
  key: string;
  ruleId: string;
  scope: string;
  scopeId: string;
  subjectId: string;
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  metric: string;
  threshold: number;
  value: number;
  severity: string;
  title: string | null;
  /** The column worth reading first: 'node' means a machine caught the breach itself — possibly
   *  while it could not reach central at all — and 'central' means nobody knew until the events
   *  landed here. */
  firedBy: string;
  nodeId: string | null;
  firedAt: string;
  recordedAt: string;
  detail: unknown;
  /** The loser's count for the same window, kept rather than discarded. The two disagreeing is
   *  either shipping lag or a hole in that node's stream — never nothing. */
  peerFiredBy: string | null;
  peerValue: number | null;
  peerSeenAt: string | null;
}

export interface AlertEngineStats {
  sweeps: number;
  fired: number;
  deduped: number;
  suppressed: number;
  errors: number;
  rules: { id: string; scope: string }[];
  running: boolean;
}

// ---------------------------------------------------------------------------- shadow

export type ShadowVerdict = "match" | "lagging" | "gap" | "divergent";

export interface ShadowLatest {
  nodeId: string;
  checkedAt: string;
  verdict: ShadowVerdict;
  detail: string | null;
  nodeEventCount: number | null;
  centralEventCount: number | null;
  nodeOutboxPending: number | null;
}

export interface ShadowStatus {
  since: string;
  latest: ShadowLatest[];
  tally: { verdict: ShadowVerdict; n: number }[];
  /** Deliberately not called `ready`: it says what was measured, not what to do about it. */
  everyNodeAgrees: boolean;
}

export interface ShadowCheck extends ShadowLatest {
  id: number;
  nodeChainSeq: number | null;
  nodeChainHash: string | null;
  centralMaxSeq: number | null;
  centralChainHash: string | null;
  centralShipmentCount: number | null;
}

// ---------------------------------------------------------------------------- storage

export interface PartitionRow {
  name: string;
  bounds: string | null;
  bytes: number | null;
  estimatedRows: number | null;
}

export interface TableStorage {
  partitions: PartitionRow[];
  /** Should be zero forever. A row here means partition maintenance did not run in time. */
  defaultPartitionRows: number;
  totalBytes: number;
}

export interface FleetStorage {
  /** The original three keys, still usage_events alone — kept unchanged because this route had
   *  readers before native observations became a second partitioned table. */
  partitions: PartitionRow[];
  defaultPartitionRows: number;
  totalBytes: number;
  tables: Record<string, TableStorage>;
  fleetTotalBytes: number;
}

// ---------------------------------------------------------------------------- native

export interface NativeByTool {
  toolName: string;
  observations: number;
  errors: number;
  denied: number;
}

export interface FleetNative {
  since: string;
  nodeId: string | null;
  /** Nothing here is called `calls` or `events`, and the shape says so deliberately: a native
   *  observation is a sighting and a usage event is a decision. The two totals must never be
   *  summed. */
  observations: number;
  nodes: number;
  principals: number;
  errors: number;
  denied: number;
  observedFrom: string | null;
  observedTo: string | null;
  byTool: NativeByTool[];
  byNode: { nodeId: string; observations: number; lastObservedAt: string | null }[];
  byPrincipal: { principalId: string; name: string | null; observations: number }[];
}

// ---------------------------------------------------------------------------- hooks

/**
 * One backend adapter's line in a node's hook report — enough to name the file an operator would
 * go and run `npm run providers:install` against. See server/nodeHealth.js hookHealth().
 */
export interface HookProviderDetail {
  id: string;
  label: string | null;
  installed: boolean;
  installable: boolean;
  configPath: string | null;
  error: string | null;
}

/**
 * The WHOLE hook report central stored, not a display string.
 *
 * server/central stores this in a JSONB column (centralMigrations.js migration 6) and node-postgres
 * hands JSONB back as a parsed OBJECT, not text — server/central/pgDriver.js overrides only the
 * BIGINT parser. So `hookDetail` arrives here as this shape; typing it `string` and rendering it as
 * a React child is what unmounted the Hook integrity route (the same failure `list()` above guards
 * against). The page derives its muted subline from these fields rather than printing the object.
 */
export interface HookDetail {
  status?: HookStatus;
  installedCount?: number;
  installableCount?: number;
  brokenCount?: number;
  tamperCount?: number;
  lastTamperAt?: string | null;
  providers?: HookProviderDetail[];
  unreadable?: { id: string; error: string | null }[];
}

export interface HookIntegrityNode {
  nodeId: string;
  hostname: string | null;
  osUser: string | null;
  hookStatus: HookStatus | null;
  hookInstalledCount: number | null;
  hookInstallableCount: number | null;
  hookBrokenCount: number | null;
  hookTamperCount: number | null;
  hookLastTamperAt: string | null;
  /** The node's own claim about when it last looked. */
  hookCheckedAt: string | null;
  /** Central's arrival clock. Both come back because a node that stopped reporting looks identical
   *  to a healthy one on `hookStatus` alone — the worst possible failure mode for a check whose
   *  subject is "has governance been switched off on that machine". */
  hookReportedAt: string | null;
  /** The whole report as a JSONB object, NOT a display string — see HookDetail. */
  hookDetail: HookDetail | null;
  /** `numeric` over the wire, like `silentForMs` above. */
  reportAgeMs: Numeric;
}

// ---------------------------------------------------------------------------- rollup

export interface FleetRollup {
  source: "central";
  /** Null means every node central has heard from. A list means the caller's certificate scoped
   *  the answer, and a page that renders "the fleet" from a scoped one would be claiming more
   *  than it read. */
  scope: { nodeIds: string[] | null };
  since: string | null;
  totals: {
    calls: number;
    denied: number;
    denialRate: number;
    unattributedCalls: number;
    nodes: number;
    lastEventAt: string | null;
    clockSkew: { sampled: number; maxAheadMs: number | null; maxBehindMs: number | null };
  };
  byField: {
    field: string;
    fieldPath: null;
    calls: number;
    denied: number;
    principalCount: number;
    lastEventAt: string | null;
    nodes: number;
  }[];
  byPrincipal: {
    principalId: string;
    name: string;
    agentName: string | null;
    field: string | null;
    standalone: boolean;
    backend: string | null;
    calls: number;
    denied: number;
  }[];
  standalone: {
    calls: number;
    denied: number;
    byBackend: { backend: string; calls: number; denied: number }[];
  };
}

// ---------------------------------------------------------------------------- divergence

/** The node's own leaf certificate — §2.2's year fuse. `expiring` and `expired` are the two that
 *  bring a node onto the divergence list; `not-applicable` is a node central never issued one to. */
export type CredentialState =
  | "valid"
  | "expiring"
  | "expired"
  | "absent"
  | "unreadable"
  | "not-applicable";

/**
 * The ways a node's effective enforcement can differ from central's right now — §5. Two of them are
 * a node overturning central: an enforcement pause (a real deny, held off for up to 30 min on the
 * node's own signature) and, distinct from it, a grace lease (softens faults for up to 60 min, and
 * is NOT a bypass of a healthy deny). The other three are the credential going the way §2.2 warns.
 *
 * A PAUSE AND AN EXPIRED CREDENTIAL ARE ALARMING; A GRACE LEASE IS ORDINARY MAINTENANCE. §5 calls
 * out conflating the pause and the lease as a mistake, so they are kept apart here and drawn apart
 * on the page — see FleetEnforcementPage.
 */
export type DivergenceReason =
  | "enforcement-paused"
  | "grace-lease"
  | "credential-expired"
  | "credential-expiring"
  | "credential-unreadable";

export interface DivergenceNode {
  nodeId: string;
  /** The node's class label — display today, a policy profile in §5's recommendation. May be null. */
  label: string | null;
  lastSeenAt: string | null;
  /** The pause that is overturning a central deny, or null. The id is what makes the fault journal
   *  answer "what did THIS window let through" in one click — see `journal`. */
  pauseId: string | null;
  pauseUntil: string | null;
  /** Comma-joined risk tiers a pause or lease covers, e.g. "read_only,mutating" — never an array. */
  pauseTiers: string | null;
  pauseReason: string | null;
  pauseIssuedBy: string | null;
  leaseUntil: string | null;
  leaseTiers: string | null;
  credentialState: CredentialState | null;
  credentialNotAfter: string | null;
  journalEntries: number | null;
  journalLastAt: string | null;
  paused: boolean;
  leased: boolean;
  credentialAtRisk: boolean;
  /** How many journal entries a pause let through. THE number §5 is about: a pause is invisible
   *  while it runs because nothing fails, so the count of what it suppressed is the only evidence
   *  it happened. */
  suppressedDenials: number | null;
  reasons: DivergenceReason[];
}

export interface FleetDivergence {
  /** Central's clock at the moment it computed the list — every `until` above is relative to this,
   *  not to the browser's, for the same reason `age()` takes a server-computed span. */
  now: string;
  /** Only nodes that are actually diverging. An empty array is the good state, not an error. */
  nodes: DivergenceNode[];
}

// ---------------------------------------------------------------------------- fault journal

/**
 * One decision a node made without central, or one denial a pause suppressed. §3 calls this "the
 * important one": it used to exist in exactly one copy, on the machine, and a `docker rm` took it
 * with the machine. `pauseId` on an entry ties it to the window that let it through.
 */
export interface JournalEntry {
  id: string;
  /** The node's own clock when it decided; `receivedAt` is central's when the report landed. */
  ts: string | null;
  receivedAt: string | null;
  fault: string | null;
  denialKind: string | null;
  tier: string | null;
  capability: string | null;
  principalId: string | null;
  outcome: string | null;
  why: string | null;
  pauseId: string | null;
  policyAgeMs: number | null;
  policyVersion: number | null;
  /** The canonical entry as the node recorded it, kept as text — the tail for an operator carrying
   *  a suspicious row onward, never parsed into a shape this table pretends to understand. */
  raw: string | null;
}

export interface NodeJournal {
  nodeId: string;
  /** The window this response was narrowed to, or null for the whole journal. Echoes the request. */
  pauseId: string | null;
  entries: JournalEntry[];
  total: number;
  /** How many of `total` carry a pause id — the ones a pause let through, across every window. */
  suppressed: number;
  oldest: string | null;
  newest: string | null;
}

// ---------------------------------------------------------------------------- usage series

/** The governed-decision calls-over-time series, buckets in the node's `UsageBucket` shape so the
 *  existing `LineChart`/`LatencyBreakdownChart` draw central's series unchanged — see the import at
 *  the top of this file and `usageSeries` in server/central/queries.js. */
export interface FleetUsageSeries {
  byBucket: UsageBucket[];
  granularity: UsageGranularity;
  windowMinutes: number;
  bucketMinutes: number;
  nodeId: string | null;
}

// ---------------------------------------------------------------------------- settings

/** Which way "more restrictive" points for a policy parameter — server/policy/nodeConfig.js's
 *  direction, so the page can say what a profile is allowed to do to each dial. */
export type ParameterDirection = "lower" | "higher" | "subset" | "false" | "tier";

/**
 * One fleet-wide policy parameter central distributes — server/policy/nodeConfig.js's PARAMETERS.
 * `fallback` is the fleet-wide baseline a node with no profile uses; a profile may only narrow it
 * in the declared `direction`. It arrives already typed (number, boolean, list or null), so the
 * union mirrors that rather than flattening to `unknown`.
 */
export interface SettingsParameter {
  key: string;
  env: string;
  direction: ParameterDirection;
  fallback: number | boolean | string[] | string | null;
}

/** A node profile — a class label with a narrowing ceiling. `config` is the subset of parameter
 *  keys this profile tightens; `nodeCount` is how many nodes are actually in it. */
export interface SettingsProfile {
  name: string;
  description: string | null;
  config: Record<string, number | boolean | string[] | string | null>;
  constraints: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  nodeCount: number;
}

export interface FleetSettings {
  mode: "authority" | "shadow";
  /** `mtls` false means the developer insecure-loopback carve-out is on — the one posture worth
   *  drawing as a warning, since it is what would admit an unauthenticated loopback caller. */
  security: { mtls: boolean; insecureLoopback: boolean };
  bundleBuilt: boolean;
  storage: { defaultPartitionRows: number };
  parameters: SettingsParameter[];
  profiles: SettingsProfile[];
}

// ---------------------------------------------------------------------------- integrations

/** A package's family — `provider` bundles a backend adapter's default grants, `integration` an MCP
 *  tool family or skill catalog. The Fleet Providers & Integrations page draws both, one section
 *  each; installing a provider's hooks stays node-local. Mirrors server/packageDefs.js. */
export type IntegrationKind = "provider" | "integration";

/** One node's EFFECTIVE local state for a package: its own `packages_enabled` override if it set
 *  one, else the package's default. `explicit` says which — a node running the default is not the
 *  same claim as one that deliberately turned it on, and drawing them the same would invent
 *  agreement the fleet never actually has. */
export interface IntegrationNodeState {
  nodeId: string;
  label: string | null;
  enabled: boolean;
  explicit: boolean;
  factsReportedAt: string | null;
}

/** The fleet-wide status of one package, as `listPackagesWithStatus` reports it — what a write route
 *  echoes back. `coverage`/`capabilityCount` are null in shadow mode, where the grants they count do
 *  not live centrally yet. */
export interface IntegrationStatus {
  id: string;
  kind: IntegrationKind;
  label: string;
  description: string;
  owners: string[];
  roles: string[];
  /** Central's fleet-wide decision. Under authority this is what replicates to every node as grants. */
  enabled: boolean;
  capabilityCount: number | null;
  coverage: { granted: number; total: number } | null;
}

export interface FleetIntegration extends IntegrationStatus {
  /** The package's own default, used to read a node that never overrode it. */
  enabledByDefault: boolean;
  adoption: {
    /** Nodes that have reported machine facts at all — the denominator for the counts below. */
    reporting: number;
    enabled: number;
    disabled: number;
    /** Nodes whose effective local state disagrees with the fleet `enabled` — drift, not error. */
    diverged: number;
    nodes: IntegrationNodeState[];
  };
}

export interface FleetIntegrations {
  mode: "authority" | "shadow";
  /** False in shadow: the read answers (adoption needs no policy tables), but enable/disable/sync/
   *  revoke 409 until central holds the policy tables. The page disables its controls and says why. */
  writable: boolean;
  nodes: { reporting: number };
  integrations: FleetIntegration[];
}

export interface IntegrationSyncResult {
  packageId: string;
  granted: number;
  alreadyPresent: number;
  skipped: number;
}

export interface IntegrationRevokeResult {
  packageId: string;
  revoked: number;
}

/** A write route's reply — the package's fresh status plus whatever the action counted. The page
 *  reloads the whole list afterwards for the adoption axis, so `integration` here is only used for
 *  the sync/revoke tallies. */
export interface IntegrationActionResult {
  integration: IntegrationStatus | null;
  sync?: IntegrationSyncResult;
  revoke?: IntegrationRevokeResult;
}

// ------------------------------------------------------------------ integration drill-down

/** One (capability × role) cell of the drill-down grid. `principalId` is null where the role is
 *  named in the package defs but no node has registered it fleet-wide yet — present-but-not-
 *  toggleable, because a grant needs a principal to point at. `grantId` is the handle a revoke
 *  needs, non-null exactly when `granted`. */
export interface IntegrationGrantCell {
  roleName: string;
  principalId: string | null;
  registered: boolean;
  grantId: string | null;
  granted: boolean;
}

/** One capability the package owns, with its per-role grant state. `included` is whether the
 *  package's default policy would grant this on Sync — a row it skips still shows, so "the package
 *  never grants this" is legible as distinct from "nobody has yet." */
export interface IntegrationDetailCapability {
  id: string;
  kind: string | null;
  name: string;
  riskTier: PolicyRiskTier;
  description: string | null;
  autoGrant: boolean;
  included: boolean;
  roles: IntegrationGrantCell[];
}

/** The owned capabilities of one tier. `policyMode` is how the package treats this tier —
 *  `auto` grants every capability in it, `explicit` a curated include-list, `none` nothing by
 *  default (the toggles still work; the default just leaves them off). */
export interface IntegrationDetailTier {
  tier: PolicyRiskTier;
  policyMode: "auto" | "explicit" | "none";
  capabilities: IntegrationDetailCapability[];
}

/** One package in full — `GET /api/fleet/integrations/:id/detail`. Authority-only: a per-role grant
 *  matrix is entirely a claim about grants that only live centrally under authority, so in shadow
 *  the route 409s rather than return an empty grid that would read as "nothing granted." */
export interface IntegrationDetail {
  id: string;
  kind: IntegrationKind;
  label: string;
  description: string;
  owners: string[];
  enabled: boolean;
  capabilityCount: number;
  /** Every role the package targets across all tiers, resolved to principals where they exist. */
  roles: { roleName: string; principalId: string | null; registered: boolean }[];
  tiers: IntegrationDetailTier[];
}

// ---------------------------------------------------------------------------- fetchers

export const fleet = {
  summary: (params: { hours?: number } = {}) => request<FleetSummary>(`/fleet/summary${qs(params)}`),
  nodes: () => request<{ nodes: FleetNode[] }>("/fleet/nodes"),
  /** §5's short list: only the nodes that are not enforcing, degraded, or about to lose their
   *  credential. An empty `nodes` is every node enforcing, which the page says in words. */
  divergence: () => request<FleetDivergence>("/fleet/divergence"),
  /** One node's fault journal. `pauseId` narrows it to a single window — the query §5 says the
   *  pause id exists to make answerable. */
  journal: (nodeId: string, params: { pauseId?: string; limit?: number } = {}) =>
    request<NodeJournal>(`/fleet/nodes/${encodeURIComponent(nodeId)}/journal${qs(params)}`),
  nodeStream: (nodeId: string) => request<NodeStream>(`/fleet/nodes/${encodeURIComponent(nodeId)}/stream`),
  nodeVerify: (nodeId: string) => request<NodeVerify>(`/fleet/nodes/${encodeURIComponent(nodeId)}/verify`),
  usage: (params: { by?: FleetUsageDimension; hours?: number; limit?: number } = {}) =>
    request<{ by: string; rows: FleetUsageRow[] }>(`/fleet/usage${qs(params)}`),
  /**
   * The live tail, narrowed server-side. `outcome` accepts any recorded value plus the sentinel
   * 'unrecorded' for §2.6's null-outcome rows; `hours` windows on central's arrival clock; `text` is
   * a free-text match across a row's ids, reason and the names central resolved them to. Filtering on
   * the server rather than in the page keeps the row cap meaningful — the tail returns the newest
   * `limit` rows that MATCH, not the newest `limit` rows the page then hides most of.
   */
  events: (
    params: {
      limit?: number;
      nodeId?: string;
      outcome?: string;
      principalId?: string;
      hours?: number;
      text?: string;
    } = {},
  ) => request<{ events: FleetEvent[] }>(`/fleet/events${qs(params)}`),
  /**
   * Governed decisions over time — the calls-over-time chart and latency breakdown the events page
   * draws above its tail. Typed with the node's `UsageBucket` for `nativeSeries`'s reason: central
   * returns the identical shape, so one chart draws either host and there is no second copy to
   * drift. A separate call from `events` because a chart re-fetches on every granularity change and
   * the tail does not.
   */
  usageSeries: (
    params: { granularity?: UsageGranularity; windowMinutes?: number; nodeId?: string } = {},
  ) => request<FleetUsageSeries>(`/fleet/usage/series${qs(params)}`),
  alerts: (
    params: {
      limit?: number;
      since?: string;
      severity?: string;
      ruleId?: string;
      nodeId?: string;
      subjectId?: string;
    } = {},
  ) => request<{ alerts: FleetAlert[]; engine: AlertEngineStats }>(`/fleet/alerts${qs(params)}`),
  shadow: (params: { hours?: number } = {}) => request<ShadowStatus>(`/fleet/shadow${qs(params)}`),
  shadowHistory: (params: { nodeId?: string; limit?: number } = {}) =>
    request<{ checks: ShadowCheck[] }>(`/fleet/shadow/history${qs(params)}`),
  storage: () => request<FleetStorage>("/fleet/storage"),
  /** Central's own configuration — its deployment posture and the fleet-wide policy parameters it
   *  distributes, with the node profiles that narrow them. Read-only; profile edits go to
   *  /api/policy/node-profiles. */
  settings: () => request<FleetSettings>("/fleet/settings"),
  native: (params: { hours?: number; nodeId?: string; limit?: number } = {}) =>
    request<FleetNative>(`/fleet/native${qs(params)}`),
  /**
   * The fleet's calls-over-time series.
   *
   * TYPED WITH `NativeCallsBucket` FROM ./nativeCalls, NOT A LOCAL COPY. The node has served this
   * exact shape since native observability shipped, and central's `nativeSeries` deliberately
   * returns the identical one — so `NativeCallsChart` draws either without knowing which host it
   * is looking at. Declaring a second, structurally identical bucket type here is how the two
   * would eventually drift into two charts that answer the same question differently.
   *
   * A SEPARATE CALL FROM `native` above because a chart re-fetches on every granularity change
   * and the summary does not; folding them would make every page load pay for up to 400 buckets
   * nobody asked for.
   */
  nativeSeries: (
    params: { granularity?: NativeCallsGranularity; windowMinutes?: number; nodeId?: string; toolName?: string } = {},
  ) => request<NativeCallsTimeseries>(`/fleet/native/series${qs(params)}`),
  hooks: (params: { unhealthy?: 1 } = {}) =>
    request<{ nodes: HookIntegrityNode[] }>(`/fleet/hooks${qs(params)}`),
  rollup: (params: { hours?: number; limit?: number } = {}) =>
    request<FleetRollup>(`/fleet/rollup${qs(params)}`),
  /** Every package's fleet-wide setting, its per-node adoption, and whether writes are possible on
   *  this central (authority vs shadow). The Fleet Providers & Integrations page reads this and
   *  splits it into a provider section and an integration section by `kind`. */
  integrations: () => request<FleetIntegrations>("/fleet/integrations"),
  /** One package in full — its owned capabilities crossed with the roles it targets, and the live
   *  grant on each pair. The drill-down behind a card on the Integrations page; authority-only,
   *  since a per-role grant matrix has no meaning until central holds the policy tables. */
  integrationDetail: (id: string) =>
    request<IntegrationDetail>(`/fleet/integrations/${encodeURIComponent(id)}/detail`),
  /** Enable a package fleet-wide: records the decision AND syncs its default grants in one step, so
   *  a toggle never leaves an enabled package granting nothing until a forgotten second action. */
  enableIntegration: (id: string) =>
    request<IntegrationActionResult>(`/fleet/integrations/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  /** Records the off decision only — deliberately does NOT revoke, so it never cuts an in-flight
   *  agent off. `revokeIntegration` is the explicit take-it-back. */
  disableIntegration: (id: string) =>
    request<IntegrationActionResult>(`/fleet/integrations/${encodeURIComponent(id)}/disable`, { method: "POST" }),
  syncIntegration: (id: string) =>
    request<IntegrationActionResult>(`/fleet/integrations/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  revokeIntegration: (id: string) =>
    request<IntegrationActionResult>(`/fleet/integrations/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
};
