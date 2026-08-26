// A tiny, fully client-side model of what the windrow broker does to a tool call — the same
// vocabulary the real product uses (principals, capabilities, risk tiers, grants, outcomes) but
// with an invented cast and no network at all. Everything the Playground shows is computed here in
// the browser: it is a toy of the real /api/invoke path, not a call to it.

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
  /** A pending principal is denied everything until "approved" — the demo's rogue agent. */
  pending?: boolean;
}

export interface SimCapability {
  id: string;
  /** The MCP-style tool name typed at the prompt, e.g. "github.create_issue". */
  name: string;
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

// ── The cast ────────────────────────────────────────────────────────────────

export const PRINCIPALS: SimPrincipal[] = [
  {
    id: "ci-deploy-bot",
    name: "ci-deploy-bot",
    kind: "role",
    blurb: "Your release robot. Ships code, files issues, reads the prod DB — nothing destructive.",
    grants: ["github.create_issue", "github.list_prs", "slack.post_message", "postgres.query", "sentry.list_issues"],
  },
  {
    id: "support-copilot",
    name: "support-copilot",
    kind: "instance",
    blurb: "Answers customer tickets. Can post to Slack and search the wiki, can't touch money.",
    grants: ["slack.post_message", "notion.search", "github.create_issue", "sentry.list_issues"],
  },
  {
    id: "data-analyst",
    name: "data-analyst",
    kind: "instance",
    blurb: "Reads, never writes. Query the warehouse and list charges — but no charging.",
    grants: ["postgres.query", "stripe.list_charges", "notion.search", "sentry.list_issues"],
  },
  {
    id: "intern-agent",
    name: "intern-agent",
    kind: "instance",
    blurb: "Day one. Read-only wiki search and nothing else — watch it get bounced.",
    grants: ["notion.search"],
  },
  {
    id: "rogue-scraper",
    name: "rogue-scraper",
    kind: "instance",
    blurb: "Unapproved principal. Every call it makes is denied on sight.",
    grants: [],
    pending: true,
  },
];

// ── The tools ─────────────────────────────────────────────────────────────

export const CAPABILITIES: SimCapability[] = [
  {
    id: "github.create_issue",
    name: "github.create_issue",
    owner: "GitHub",
    riskTier: "mutating",
    description: "Open a new issue on a repo.",
    result: ({ seq }) => ({ number: 1420 + seq, url: `github.com/acme/app/issues/${1420 + seq}`, state: "open" }),
  },
  {
    id: "github.list_prs",
    name: "github.list_prs",
    owner: "GitHub",
    riskTier: "read_only",
    description: "List open pull requests.",
    result: () => ({ open: 7, drafts: 2, oldest: "9 days" }),
  },
  {
    id: "github.merge_pr",
    name: "github.merge_pr",
    owner: "GitHub",
    riskTier: "destructive",
    description: "Merge a PR into main — irreversible.",
    result: ({ seq }) => ({ merged: true, sha: shortSha(seq), branch: "main" }),
  },
  {
    id: "slack.post_message",
    name: "slack.post_message",
    owner: "Slack",
    riskTier: "mutating",
    description: "Post a message to a channel.",
    result: ({ seq }) => ({ channel: "#deploys", ts: `171${800000 + seq}.001`, delivered: true }),
  },
  {
    id: "postgres.query",
    name: "postgres.query",
    owner: "Postgres",
    riskTier: "read_only",
    description: "Run a read-only SELECT.",
    result: () => ({ rows: 342, elapsed: "18ms", cached: false }),
  },
  {
    id: "postgres.drop_table",
    name: "postgres.drop_table",
    owner: "Postgres",
    riskTier: "destructive",
    description: "DROP a table — say goodbye to the data.",
    result: () => ({ dropped: "events_archive", rows_lost: 1_204_889 }),
  },
  {
    id: "stripe.list_charges",
    name: "stripe.list_charges",
    owner: "Stripe",
    riskTier: "read_only",
    description: "List recent charges.",
    result: () => ({ count: 25, currency: "usd", total: "$4,210.00" }),
  },
  {
    id: "stripe.create_charge",
    name: "stripe.create_charge",
    owner: "Stripe",
    riskTier: "destructive",
    description: "Charge a customer's card — real money.",
    result: ({ seq }) => ({ id: `ch_${shortSha(seq)}`, amount: "$49.00", status: "succeeded" }),
  },
  {
    id: "notion.search",
    name: "notion.search",
    owner: "Notion",
    riskTier: "read_only",
    description: "Search the internal wiki.",
    result: () => ({ hits: 12, top: "Runbook: rolling a release" }),
  },
  {
    id: "sentry.list_issues",
    name: "sentry.list_issues",
    owner: "Sentry",
    riskTier: "read_only",
    description: "List unresolved errors.",
    result: () => ({ unresolved: 3, new_today: 1, worst: "TypeError in checkout" }),
  },
  {
    id: "filesystem.delete_file",
    name: "filesystem.delete_file",
    owner: "Filesystem",
    riskTier: "destructive",
    description: "Delete a file from disk.",
    result: () => ({ deleted: "/tmp/build.log", bytes: 40_112 }),
  },
];

export const CAP_BY_NAME: Record<string, SimCapability> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, c]),
);

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
