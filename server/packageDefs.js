'use strict';
// Capability package DEFINITIONS — the data half of server/packages.js, split out so it can be read
// by two processes that must not share anything else.
//
// WHY A FILE OF ITS OWN. A package is a per-owner default policy (docs/design/capability-packages.md)
// and it is defined in code, not a database row — the same list on every machine. server/packages.js
// (the node) and server/central/packages.js (the authority) both need it, but they reach it from
// opposite sides of the WAN: the node's module `require('./store')` at load, which is better-sqlite3
// and a data directory, and central must never pull those into its process (the same reason
// server/central/policyStore.js re-declares RISK_TIERS rather than importing app.js). So the DATA
// lives here, with no store dependency, and each side supplies its own store when it acts on it.
//
// One source of truth for the list, two implementations of what "enable" and "sync" DO — because
// on the node they write the node's SQLite (standalone authority) and on central they write the
// policy tables that replicate to the whole fleet.

/** The standard orchestrator roles every general-purpose Claude Code agent runs as — the same set
 *  seed.js already grants identically (`general-purpose`/`claude`/`claudecode` are treated as one
 *  "full-stack catch-all" group there). `claude-standalone` is the bare-terminal/CI equivalent
 *  (docs/design/cross-field-and-standalone.md) and gets the same baseline. */
const DEFAULT_ROLES = ['claudecode', 'claude', 'claude-standalone', 'general-purpose'];

/** Shorthand `'auto'` means "auto-grant to `package.roles`" with no per-tier override. */
function normalizePolicy(tier, pkgRoles) {
  if (!tier) return { mode: 'none', roles: pkgRoles };
  if (tier === 'auto') return { mode: 'auto', roles: pkgRoles };
  return { mode: tier.mode, include: tier.include || [], roles: tier.roles || pkgRoles };
}

const PACKAGES = [
  // -------------------------------------------------------------------------
  // Providers — the agent runtime itself. No capabilities of their own (owners: []), so syncing a
  // provider package is a no-op today; the entry exists so the UI has one place to show "is this
  // backend's hook wiring even installed" (server/providers.js) alongside the integrations it
  // enables, and so a later phase can gate provider-scoped defaults the same way integrations are.
  // -------------------------------------------------------------------------
  {
    id: 'claude',
    kind: 'provider',
    label: 'Claude Code',
    description: 'Anthropic’s Claude Code CLI/SDK — the backend this workspace runs on by default.',
    owners: [],
    roles: ['claudecode', 'claude-standalone', 'general-purpose', 'Explore', 'Plan', 'design-agent', 'claude', 'statusline-setup'],
    enabledByDefault: true,
    policy: {},
  },
  {
    id: 'agy',
    kind: 'provider',
    label: 'Antigravity (agy)',
    description: 'Google’s Antigravity CLI backend adapter (server/hooks/agy-*.js).',
    owners: [],
    roles: ['agy'],
    enabledByDefault: true,
    policy: {},
  },
  {
    id: 'codex',
    kind: 'provider',
    label: 'Codex',
    description: 'OpenAI Codex backend adapter — hook scripts exist, hook-config file location unconfirmed (docs/design/cross-field-and-standalone.md).',
    owners: [],
    roles: ['codex'],
    enabledByDefault: false,
    policy: {},
  },

  // -------------------------------------------------------------------------
  // Integrations — one per capability owner. read_only auto-grants and self-heals; mutating and
  // destructive stay a curated include-list (docs/design/skill-mcp-governance.md §4's tiers),
  // sized to match what this workspace already grants today, so enabling a package that's already
  // in use doesn't change anything on sync.
  // -------------------------------------------------------------------------
  {
    id: 'windrow',
    kind: 'integration',
    label: 'Windrow (this tool)',
    description: 'The capability-governance tool’s own skills and lookup tools, plus the general skill catalog (owner "platform").',
    owners: ['platform', 'windrow', 'governance', 'capability-governance'],
    roles: DEFAULT_ROLES,
    enabledByDefault: true,
    policy: {
      read_only: 'auto',
      mutating: {
        mode: 'explicit',
        include: [
          'code-review', 'simplify', 'run', 'update-config', 'schedule', 'init',
          'frontend-design', 'governance-lookup', 'hook-development',
        ],
      },
      // grant_capability/revoke_grant are retiered 'destructive' (the MCP server used to grant
      // these to every default role, which
      // let any agent holding a grant for them call the admin-token-backed MCP server and
      // self-escalate to anything) and deliberately left out of every tier's include-list —
      // packages.js is a *default-grant* policy, and no default grant is right for a capability
      // that must always go through the pending-approval queue (server/app.js's
      // POST /api/grants/propose) instead of an ordinary grant.
      destructive: { mode: 'none' },
    },
  },
  {
    id: 'wispfield',
    kind: 'integration',
    label: 'Wispfield',
    description: 'The spatial multi-agent field this workspace runs on — loom orchestration, memory, and reporting tools.',
    owners: ['wispfield'],
    roles: DEFAULT_ROLES,
    enabledByDefault: true,
    policy: {
      read_only: 'auto',
      mutating: {
        mode: 'explicit',
        include: [
          'wispfield_spawn_agent', 'wispfield_dispatch_command', 'wispfield_report_progress',
          'wispfield_report_task_complete', 'wispfield_claim_files', 'wispfield_navigate_loom',
          'wispfield_organize_field', 'wispfield_show_document', 'wispfield_start_loom',
          'wispfield_ask_user', 'wispfield_add_want',
        ],
      },
      destructive: {
        mode: 'explicit',
        include: ['wispfield_clear_field', 'wispfield_halt_agents', 'wispfield_close_loom'],
      },
    },
  },
  {
    id: 'gmail',
    kind: 'integration',
    label: 'Gmail',
    description: 'Inbox search/triage via the claude_ai_Gmail MCP connector.',
    owners: ['gmail'],
    roles: DEFAULT_ROLES,
    enabledByDefault: true,
    policy: {
      read_only: 'auto',
      mutating: { mode: 'explicit', include: ['create_draft', 'label_message', 'create_label'] },
      // mark_message_spam stays ungranted everywhere, same deliberate exclusion seed.js made.
      destructive: { mode: 'explicit', include: ['trash_message'] },
    },
  },
  {
    id: 'gdrive',
    kind: 'integration',
    label: 'Google Drive',
    description: 'File search/read/create via the claude_ai_Google_Drive MCP connector.',
    owners: ['gdrive'],
    roles: DEFAULT_ROLES,
    enabledByDefault: true,
    policy: {
      read_only: 'auto',
      mutating: { mode: 'explicit', include: ['create_file', 'copy_file'] },
      destructive: { mode: 'none' },
    },
  },
  {
    id: 'claude-design',
    kind: 'integration',
    label: 'Claude Design',
    description: 'The design-project MCP server (claude-design) — mutating tools stay scoped to design-agent, the role that actually does design work.',
    owners: ['claude-design'],
    roles: DEFAULT_ROLES,
    enabledByDefault: true,
    policy: {
      read_only: 'auto',
      mutating: { mode: 'explicit', include: ['write_files', 'copy_files', 'finalize_plan'], roles: ['design-agent'] },
      // delete_files stays ungranted everywhere, same deliberate exclusion seed.js made.
      destructive: { mode: 'none' },
    },
  },
];

const byId = new Map(PACKAGES.map((p) => [p.id, p]));

/** The package definition for `id`, or null. Shared by both stores. */
function findPackage(id) {
  return byId.get(id) || null;
}

module.exports = { PACKAGES, DEFAULT_ROLES, normalizePolicy, findPackage };
