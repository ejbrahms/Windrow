// A tiny, fully client-side model of what the windrow broker does to a tool call — the same
// vocabulary the real product uses (principals, capabilities, risk tiers, grants, outcomes) and,
// now, the SAME catalog. The tools below are the real skills and MCP tools this install registers
// (server/starterCatalog.js) — the exact rows the Catalog page lists — and each principal's grants
// mirror what server/seed.js hands that role. Everything the Sandbox shows is still computed here in
// the browser: it is a toy of the real /api/invoke path, not a call to it, so it can run on the
// public read-only demo with no backend and no writes. Kept in sync by hand with starterCatalog.js
// the same way server/seed-central.js is — one catalog, mirrored, not forked into a new vocabulary.

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
  /** A pending principal is denied everything until "approved" — the demo's just-sighted loom. */
  pending?: boolean;
}

export interface SimCapability {
  id: string;
  /** The real MCP-tool / skill name typed at the prompt, e.g. "wispfield_spawn_agent". */
  name: string;
  /** The registering server or platform surface, e.g. "gmail", "wispfield", "claude-design". */
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
// Drawn straight from server/starterCatalog.js — a representative slice spanning every owner and
// all three risk tiers. The name and riskTier of each row match the Catalog page exactly; only the
// `result` payload is invented, because a browser-only toy cannot honestly run the real call.
//
// MCP TOOLS ONLY — no skills. Skills are catalog-only and grant nothing
// (docs/design/skill-mcp-governance.md §0), so there is no allow/deny decision to demonstrate for
// one; a Sandbox that fired a skill would be teaching a control that does not exist.

export const CAPABILITIES: SimCapability[] = [
  // ---- read-only ----------------------------------------------------------------------------
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
  {
    id: "wispfield_view",
    name: "wispfield_view",
    owner: "wispfield",
    riskTier: "read_only",
    description: "View the current workspace state.",
    result: () => ({ agents: 5, running: 2, field: "windrow" }),
  },
  {
    id: "read_file",
    name: "read_file",
    owner: "claude-design",
    riskTier: "read_only",
    description: "Read a file from a Claude Design project.",
    result: () => ({ path: "src/App.tsx", bytes: 4218, lines: 132 }),
  },

  // ---- mutating -----------------------------------------------------------------------------
  {
    id: "create_draft",
    name: "create_draft",
    owner: "gmail",
    riskTier: "mutating",
    description: "Create a Gmail draft.",
    result: ({ seq }) => ({ draftId: `r-${shortSha(seq)}`, to: "team@acme.dev", subject: "Deploy summary" }),
  },
  {
    id: "label_message",
    name: "label_message",
    owner: "gmail",
    riskTier: "mutating",
    description: "Apply a label to a Gmail message.",
    result: ({ seq }) => ({ messageId: `msg_${shortSha(seq)}`, label: "Triaged", applied: true }),
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
    id: "write_files",
    name: "write_files",
    owner: "claude-design",
    riskTier: "mutating",
    description: "Write files into a Claude Design project.",
    result: () => ({ written: 3, project: "acme-dashboard", bytes: 12_803 }),
  },
  {
    id: "wispfield_spawn_agent",
    name: "wispfield_spawn_agent",
    owner: "wispfield",
    riskTier: "mutating",
    description: "Spawn a new agent in the workspace.",
    result: ({ seq }) => ({ loomId: `claude-${shortSha(seq)}`, agentType: "claude", field: "windrow" }),
  },
  {
    id: "wispfield_dispatch_command",
    name: "wispfield_dispatch_command",
    owner: "wispfield",
    riskTier: "mutating",
    description: "Dispatch an instruction to another agent.",
    result: ({ seq }) => ({ taskId: `task_${shortSha(seq)}`, target: "Mira", accepted: true }),
  },

  // ---- destructive --------------------------------------------------------------------------
  {
    id: "trash_message",
    name: "trash_message",
    owner: "gmail",
    riskTier: "destructive",
    description: "Move a Gmail message to trash.",
    result: ({ seq }) => ({ messageId: `msg_${shortSha(seq)}`, trashed: true }),
  },
  {
    id: "mark_message_spam",
    name: "mark_message_spam",
    owner: "gmail",
    riskTier: "destructive",
    description: "Mark a Gmail message as spam.",
    result: ({ seq }) => ({ messageId: `msg_${shortSha(seq)}`, spam: true }),
  },
  {
    id: "delete_files",
    name: "delete_files",
    owner: "claude-design",
    riskTier: "destructive",
    description: "Delete files from a Claude Design project.",
    result: () => ({ deleted: 2, project: "acme-dashboard", bytesFreed: 40_112 }),
  },
  {
    id: "wispfield_clear_field",
    name: "wispfield_clear_field",
    owner: "wispfield",
    riskTier: "destructive",
    description: "Clear all agents from the workspace.",
    result: () => ({ cleared: 5, field: "windrow" }),
  },
  {
    id: "wispfield_halt_agents",
    name: "wispfield_halt_agents",
    owner: "wispfield",
    riskTier: "destructive",
    description: "Halt all running agents in the workspace.",
    result: () => ({ halted: 3, field: "windrow" }),
  },
  {
    id: "wispfield_close_loom",
    name: "wispfield_close_loom",
    owner: "wispfield",
    riskTier: "destructive",
    description: "Close a specific agent in the workspace.",
    result: () => ({ loomId: "claude-msri1bho-41", closed: true }),
  },
];

export const CAP_BY_NAME: Record<string, SimCapability> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, c]),
);

// ── The cast ────────────────────────────────────────────────────────────────
// The real roles from server/starterCatalog.js plus one just-sighted instance. Each `grants` list
// is that role's grantsForRole(...) intersected with the palette above: the read-only baseline
// every role gets, plus its own extras. `mark_message_spam`, `delete_files` and
// `wispfield_close_loom` are held by nobody on purpose — the three destructive rows a fresh install
// leaves ungranted, so the first agent to reach for one is escalated to a human.

const BASELINE = ["wispfield_view", "search_threads", "search_files", "read_file"];

export const PRINCIPALS: SimPrincipal[] = [
  {
    id: "claudecode",
    name: "claudecode",
    kind: "role",
    blurb: "The top-level agent role. Full working surface plus the two destructive workspace controls an operator actually uses.",
    grants: [
      ...BASELINE,
      "wispfield_spawn_agent", "wispfield_dispatch_command",
      "create_draft", "label_message", "create_file",
      "wispfield_clear_field", "wispfield_halt_agents", "trash_message",
    ],
  },
  {
    id: "general-purpose",
    name: "general-purpose",
    kind: "role",
    blurb: "The full-stack catch-all. Can mail, spawn agents and write files — but holds no destructive grant.",
    grants: [
      ...BASELINE,
      "wispfield_spawn_agent", "wispfield_dispatch_command",
      "create_draft", "label_message", "create_file",
    ],
  },
  {
    id: "design-agent",
    name: "design-agent",
    kind: "role",
    blurb: "A narrow slice: the two claude-design writes. No mail, no orchestration.",
    grants: [...BASELINE, "write_files"],
  },
  {
    id: "Explore",
    name: "Explore",
    kind: "role",
    blurb: "Read-only by design. Gets the baseline and nothing else — watch every write get bounced.",
    grants: [...BASELINE],
  },
  {
    id: "claude-newhire-7",
    name: "claude-newhire-7",
    kind: "instance",
    blurb: "A loom the broker just saw for the first time. Pending approval — every call it makes is denied on sight.",
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
