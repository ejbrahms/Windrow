// A tiny, fully client-side model of what the windrow broker does to a tool call — the same
// vocabulary the real product uses (principals, capabilities, risk tiers, grants, outcomes) on the
// SAME catalog the public demo shows. The Sandbox appears ONLY on the public read-only demo
// (client/src/hooks/useHost.tsx's "demo" scope), whose catalog is the third-party MCP servers in
// scripts/demo-catalog.js — GitHub, Slack, Gmail, Google Drive, Postgres, Sentry, Linear, Stripe,
// Playwright. So the tools and roles below are drawn from THAT catalog, not from a local install's
// wispfield-owned control surface, which has no place on a public product demo. Everything here is
// computed in the browser — a toy of the real /api/invoke path, not a call to it — so it runs on the
// read-only demo with no backend and no writes. Kept in sync by hand with scripts/demo-catalog.js.

export type RiskTier = "read_only" | "mutating" | "destructive";
export type Outcome = "ok" | "denied" | "approved" | "error";

export interface SimPrincipal {
  id: string;
  /** Display handle shown at the prompt. */
  name: string;
  kind: "role" | "instance";
  /** One-line character note, shown under the picker. */
  blurb: string;
  /** Capability ids this principal holds an active grant for. */
  grants: string[];
  /** A pending principal is denied everything until "approved" — the demo's unapproved backend. */
  pending?: boolean;
}

export interface SimCapability {
  id: string;
  /** The real MCP-tool name typed at the prompt, e.g. "create_issue". */
  name: string;
  /** The registering MCP server, e.g. "github", "gmail", "stripe". */
  owner: string;
  riskTier: RiskTier;
  /** Short human description shown in the command palette. */
  description: string;
  /** Builds a playful, believable result payload for an allowed call. */
  result: (ctx: ResultContext) => Record<string, unknown>;
}

export interface ResultContext {
  principal: SimPrincipal;
  /** A small incrementing seed so ids look like they advance without needing Math.random. */
  seq: number;
}

// ── The tools ─────────────────────────────────────────────────────────────
// A representative slice of scripts/demo-catalog.js spanning several MCP servers and all three risk
// tiers. Every name and riskTier matches the demo's Catalog page exactly; only the `result` payload
// is invented, because a browser-only toy cannot honestly run the real call.

export const CAPABILITIES: SimCapability[] = [
  // ---- read-only ----------------------------------------------------------------------------
  {
    id: "get_file_contents",
    name: "get_file_contents",
    owner: "github",
    riskTier: "read_only",
    description: "Read a file or directory from a GitHub repository.",
    result: () => ({ path: "src/checkout/cart.ts", bytes: 4218, lines: 132 }),
  },
  {
    id: "query",
    name: "query",
    owner: "postgres",
    riskTier: "read_only",
    description: "Run a read-only SQL query against the connected database.",
    result: () => ({ rows: 342, elapsed: "18ms", cached: false }),
  },
  {
    id: "find_issues",
    name: "find_issues",
    owner: "sentry",
    riskTier: "read_only",
    description: "Search Sentry issues.",
    result: () => ({ unresolved: 3, new_today: 1, worst: "TypeError in checkout" }),
  },
  {
    id: "search_threads",
    name: "search_threads",
    owner: "gmail",
    riskTier: "read_only",
    description: "Search Gmail threads.",
    result: () => ({ threads: 8, unread: 2, top: "Re: incident #4821" }),
  },
  {
    id: "search_files",
    name: "search_files",
    owner: "gdrive",
    riskTier: "read_only",
    description: "Search Google Drive files.",
    result: () => ({ files: 14, folders: 3, top: "Q3 roadmap.gdoc" }),
  },

  // ---- mutating -----------------------------------------------------------------------------
  {
    id: "create_issue",
    name: "create_issue",
    owner: "github",
    riskTier: "mutating",
    description: "Open a GitHub issue.",
    result: ({ seq }) => ({ number: 1420 + seq, url: `github.com/acme/app/issues/${1420 + seq}`, state: "open" }),
  },
  {
    id: "slack_post_message",
    name: "slack_post_message",
    owner: "slack",
    riskTier: "mutating",
    description: "Post a message to a channel.",
    result: ({ seq }) => ({ channel: "#deploys", ts: `171${800000 + seq}.001`, delivered: true }),
  },
  {
    id: "create_draft",
    name: "create_draft",
    owner: "gmail",
    riskTier: "mutating",
    description: "Create a Gmail draft.",
    result: ({ seq }) => ({ draftId: `r-${shortSha(seq)}`, to: "team@acme.dev", subject: "Deploy summary" }),
  },
  {
    id: "create_file",
    name: "create_file",
    owner: "gdrive",
    riskTier: "mutating",
    description: "Create a Google Drive file.",
    result: ({ seq }) => ({ fileId: `1${shortSha(seq)}`, name: "release-notes.gdoc", url: "drive.google.com/…" }),
  },
  {
    id: "update_issue",
    name: "update_issue",
    owner: "linear",
    riskTier: "mutating",
    description: "Change a Linear issue's state, assignee or estimate.",
    result: ({ seq }) => ({ id: `ENG-${1200 + seq}`, state: "In Progress", assignee: "ada" }),
  },

  // ---- destructive --------------------------------------------------------------------------
  {
    id: "merge_pull_request",
    name: "merge_pull_request",
    owner: "github",
    riskTier: "destructive",
    description: "Merge a pull request into its base branch.",
    result: ({ seq }) => ({ merged: true, sha: shortSha(seq), base: "main" }),
  },
  {
    id: "delete_file",
    name: "delete_file",
    owner: "github",
    riskTier: "destructive",
    description: "Delete a file from a repository.",
    result: () => ({ deleted: "src/legacy/old-cart.ts", branch: "main" }),
  },
  {
    id: "send_message",
    name: "send_message",
    owner: "gmail",
    riskTier: "destructive",
    description: "Send mail as the authenticated user.",
    result: ({ seq }) => ({ id: `msg_${shortSha(seq)}`, to: "customer@example.com", sent: true }),
  },
  {
    id: "create_refund",
    name: "create_refund",
    owner: "stripe",
    riskTier: "destructive",
    description: "Refund a Stripe payment intent — real money.",
    result: ({ seq }) => ({ id: `re_${shortSha(seq)}`, amount: "$49.00", status: "succeeded" }),
  },
  {
    id: "browser_evaluate",
    name: "browser_evaluate",
    owner: "playwright",
    riskTier: "destructive",
    description: "Evaluate arbitrary JavaScript in the current page.",
    result: () => ({ evaluated: true, returned: "42" }),
  },
];

export const CAP_BY_NAME: Record<string, SimCapability> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, c]),
);

// ── The cast ────────────────────────────────────────────────────────────────
// The demo's roles (scripts/demo-catalog.js ROLES) plus its one pending backend. Each `grants` list
// is a subset of that role's grants in demo-catalog, intersected with the palette above. `delete_file`,
// `send_message`, `create_refund` and `browser_evaluate` are held by nobody on purpose — the
// destructive rows the demo leaves ungranted, so the first agent to reach for one is escalated.

const BASELINE = ["get_file_contents"];

export const PRINCIPALS: SimPrincipal[] = [
  {
    id: "claudecode",
    name: "claudecode",
    kind: "role",
    blurb: "The top-level agent role. Reads code, files issues, mails, queries the DB — and merges PRs.",
    grants: [
      ...BASELINE,
      "query", "find_issues", "search_threads", "search_files",
      "create_issue", "slack_post_message", "create_draft", "create_file", "update_issue",
      "merge_pull_request",
    ],
  },
  {
    id: "general-purpose",
    name: "general-purpose",
    kind: "role",
    blurb: "The full-stack catch-all. Files issues, posts to Slack, triages Sentry — but holds no destructive grant.",
    grants: [...BASELINE, "query", "find_issues", "create_issue", "slack_post_message", "update_issue"],
  },
  {
    id: "design-agent",
    name: "design-agent",
    kind: "role",
    blurb: "A narrow slice: read the repo, search Drive and create a doc. No repository writes, no mail.",
    grants: [...BASELINE, "search_files", "create_file"],
  },
  {
    id: "Explore",
    name: "Explore",
    kind: "role",
    blurb: "Read-only by design. Holds only the baseline read — watch every write, and most reads, get bounced.",
    grants: [...BASELINE],
  },
  {
    id: "codex",
    name: "codex",
    kind: "instance",
    blurb: "A backend the broker just saw for the first time. Pending approval — every call it makes is denied on sight.",
    grants: [],
    pending: true,
  },
];

// ── The decision ──────────────────────────────────────────────────────────

export type Decision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "needs_approval"; reason: string };

/**
 * The whole broker, in one pure function. Mirrors the real rules the demo teaches:
 * an unapproved principal is denied outright; an active grant allows the call; a destructive
 * call with no grant is not simply denied but escalated to a human approval; anything else with
 * no grant is denied for want of one.
 */
export function decide(principal: SimPrincipal, cap: SimCapability): Decision {
  if (principal.pending) {
    return { kind: "deny", reason: `principal ${principal.name} is pending approval — no calls permitted` };
  }
  if (principal.grants.includes(cap.id)) {
    return { kind: "allow", reason: `active grant: ${principal.name} → ${cap.name}` };
  }
  if (cap.riskTier === "destructive") {
    return {
      kind: "needs_approval",
      reason: `${cap.name} is destructive and ungranted — escalating to a human`,
    };
  }
  return { kind: "deny", reason: `no active grant for ${cap.name}` };
}

/** Per-phase broker latencies (ms), the same breakdown the real usage log records. */
export interface Latency {
  capabilityLookup: number;
  principalResolve: number;
  grantCheck: number;
  total: number;
}

/** Deterministic-ish jitter from a seed so numbers move without Math.random. */
export function latencyFor(seq: number): Latency {
  const wobble = (n: number, base: number, span: number) =>
    Math.round((base + ((seq * 9301 + n * 49297) % 233) / 233 * span) * 10) / 10;
  const capabilityLookup = wobble(1, 0.2, 0.9);
  const principalResolve = wobble(2, 0.2, 0.7);
  const grantCheck = wobble(3, 0.6, 1.8);
  const total = Math.round((capabilityLookup + principalResolve + grantCheck) * 10) / 10;
  return { capabilityLookup, principalResolve, grantCheck, total };
}

function shortSha(seq: number): string {
  const hex = ((seq + 1) * 2654435761).toString(16).padStart(7, "0");
  return hex.slice(-7);
}

export function riskLabel(tier: RiskTier): string {
  return tier === "read_only" ? "Read-only" : tier === "mutating" ? "Mutating" : "Destructive";
}
