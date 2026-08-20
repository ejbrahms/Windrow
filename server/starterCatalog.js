'use strict';

// THE STARTER CATALOG — the capability/principal/grant baseline a fresh Windrow install boots with,
// held in one place because there are now two databases that need it.
//
// It used to live inline in ./seed.js, and inline was correct while there was exactly one store to
// write it into. Phase 4 of docs/design/global-identity-and-central-db.md moved authority for
// `capabilities` and `grants` to central, which means a fleet install seeds Postgres and a
// standalone install seeds SQLite — the same rows, two engines, two id-minting functions. The
// audit (docs/design/setup-after-central.md §3) is blunt about what happens without a central seed:
// `npm run seed` correctly throws PolicyReadOnlyError on a phase-4 node, so nothing seeds the
// catalog and central starts empty, with no capabilities for any node to be granted anything
// against.
//
// A COPY-PASTE FORK WOULD BE THE WORSE FAILURE, not the smaller one. The two catalogs would agree
// on the day they were written and diverge on the first capability anyone added to one of them, and
// the symptom is a fleet where a node's local dev install enforces a tier that central has never
// heard of — a difference nothing reports, because a capability that only exists on one side simply
// looks unregistered on the other. So the catalog is data here, and ./seed.js and ./seed-central.js
// are two writers of it.
//
// NO IDS IN THIS FILE, and that is the whole reason it is data rather than rows. §2.2: ids are
// minted by whoever owns the table — `genId('cap')` on a node, `insertCapability` at central — so a
// capability is identified here by the pair the unique index is on, `(kind, name)`. Both seeders
// resolve a `kind:name` reference to whatever id their own store handed back. That is also what
// makes the central seeder idempotent against a store somebody has already used: it matches on the
// same key the database enforces uniqueness with, rather than on an id it would have to have minted
// itself to recognise.
//
// WHAT IS DELIBERATELY NOT HERE: the instance principals in ./seed.js. Those are a snapshot of one
// workspace's live agent roster at one moment (real `LOOM_NODE_ID`s), which is bootstrap/demo data
// for a single machine, not a fleet baseline — writing a particular PC's looms into a fleet's
// registry would hand every other node in the fleet three principals that will never call it.

/** The reference form used everywhere below: the pair `capabilities` has its unique index on.
 *  `COALESCE(kind,'')` in the index and a bare join here mean the same thing — a capability with no
 *  kind is identified by its name alone, in both stores. */
function capRef(kind, name) {
  return `${kind || ''}:${name}`;
}

/**
 * The capabilities themselves.
 *
 * `source: 'manual'` is applied by ./seed.js and by nothing here, because it is a node-local column
 * — central's `capabilities` has no `source`/`discoveredAt`/`lastSeenAt`/`stale`/`realUsage`
 * (see ./central/centralMigrations.js migration 3): those describe what a *particular machine*
 * found on its own filesystem, and the last node to report would otherwise overwrite every other
 * node's record of when it last saw its own copy.
 */
const CAPABILITIES = [
  // ---- skills -----------------------------------------------------------------------------
  { kind: 'skill', name: 'code-review', owner: 'platform', riskTier: 'mutating', description: 'Reviews the current diff or PR for bugs and cleanups; can post inline comments or apply fixes.' },
  { kind: 'skill', name: 'simplify', owner: 'platform', riskTier: 'mutating', description: 'Reviews changed code for reuse/simplification/efficiency and applies the fixes.' },
  { kind: 'skill', name: 'security-review', owner: 'platform', riskTier: 'read_only', description: 'Completes a security review of the pending changes on the current branch.' },
  { kind: 'skill', name: 'dataviz', owner: 'platform', riskTier: 'read_only', description: 'Design guidance for building charts, graphs, plots, and dashboards.' },
  { kind: 'skill', name: 'run', owner: 'platform', riskTier: 'mutating', description: 'Launches and drives the project app to see a change working.' },
  { kind: 'skill', name: 'update-config', owner: 'platform', riskTier: 'mutating', description: 'Configures the Claude Code harness via settings.json (hooks, permissions, env vars).' },
  { kind: 'skill', name: 'loop', owner: 'platform', riskTier: 'read_only', description: 'Runs a prompt or slash command on a recurring interval.' },
  { kind: 'skill', name: 'schedule', owner: 'platform', riskTier: 'mutating', description: 'Creates, updates, lists, or runs scheduled cloud agents (routines).' },
  { kind: 'skill', name: 'init', owner: 'platform', riskTier: 'mutating', description: 'Initializes a new CLAUDE.md file with codebase documentation.' },

  // The governance tool's own skills. Registered explicitly (rather than left for filesystem
  // discovery to pick up) because discovery defaults an unclassified skill to riskTier 'mutating'
  // (./discovery/scan.js), which would make Windrow gate access to *itself* behind a grant nobody
  // has issued yet. read_only is deliberate — both only read/open the dashboard or write local dev
  // config — and both are in READ_ONLY_BASELINE below so every current and future role gets them,
  // the same auto-grant policy docs/design/skill-mcp-governance.md §4 gives every read-only row.
  { kind: 'skill', name: 'open-capabilities-dashboard', owner: 'capability-governance', riskTier: 'read_only', description: 'Opens the capability-governance dashboard as a workspace card.' },
  { kind: 'skill', name: 'deploy-capability-governance-server', owner: 'capability-governance', riskTier: 'read_only', description: 'Deploys/wires the capability-governance server onto a workspace.' },

  // ---- claude-design MCP ------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'read_file', owner: 'claude-design', riskTier: 'read_only', description: 'Read a file from a Claude Design project.' },
  { kind: 'mcp_tool', name: 'list_files', owner: 'claude-design', riskTier: 'read_only', description: 'List files in a Claude Design project.' },
  { kind: 'mcp_tool', name: 'list_projects', owner: 'claude-design', riskTier: 'read_only', description: 'List Claude Design projects.' },
  { kind: 'mcp_tool', name: 'write_files', owner: 'claude-design', riskTier: 'mutating', description: 'Write files into a Claude Design project.' },
  { kind: 'mcp_tool', name: 'copy_files', owner: 'claude-design', riskTier: 'mutating', description: 'Copy files within a Claude Design project.' },
  { kind: 'mcp_tool', name: 'delete_files', owner: 'claude-design', riskTier: 'destructive', description: 'Delete files from a Claude Design project.' },

  // ---- wispfield MCP ----------------------------------------------------------------------
  // The three read-only control-surface tools are autoGrant: true (F5, docs/design/
  // governance-review-2026-08-16.md) — how an agent drives the platform itself, not a third-party
  // tool a human curates access to. autoGrant is never set on a destructive row, and both stores
  // refuse it independently rather than trusting this list (./app.js, ./central/policyStore.js).
  { kind: 'mcp_tool', name: 'wispfield_view', owner: 'wispfield', riskTier: 'read_only', description: 'View the current workspace state.', autoGrant: true },
  { kind: 'mcp_tool', name: 'wispfield_get_field_status', owner: 'wispfield', riskTier: 'read_only', description: 'Get status of agents running in the workspace.', autoGrant: true },
  { kind: 'mcp_tool', name: 'wispfield_recall', owner: 'wispfield', riskTier: 'read_only', description: 'Recall prior workspace memory/context.', autoGrant: true },
  { kind: 'mcp_tool', name: 'wispfield_spawn_agent', owner: 'wispfield', riskTier: 'mutating', description: 'Spawn a new agent in the workspace.' },
  { kind: 'mcp_tool', name: 'wispfield_dispatch_command', owner: 'wispfield', riskTier: 'mutating', description: 'Dispatch an instruction to another agent in the workspace.' },
  { kind: 'mcp_tool', name: 'wispfield_report_progress', owner: 'wispfield', riskTier: 'mutating', description: 'Publish a plan/progress update to an agent card.' },
  { kind: 'mcp_tool', name: 'wispfield_clear_field', owner: 'wispfield', riskTier: 'destructive', description: 'Clear all agents from the workspace.' },
  { kind: 'mcp_tool', name: 'wispfield_halt_agents', owner: 'wispfield', riskTier: 'destructive', description: 'Halt all running agents in the workspace.' },
  { kind: 'mcp_tool', name: 'wispfield_close_loom', owner: 'wispfield', riskTier: 'destructive', description: 'Close a specific agent in the workspace.' },

  // ---- gmail MCP --------------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'search_threads', owner: 'gmail', riskTier: 'read_only', description: 'Search Gmail threads.' },
  { kind: 'mcp_tool', name: 'get_message', owner: 'gmail', riskTier: 'read_only', description: 'Get a Gmail message.' },
  { kind: 'mcp_tool', name: 'list_labels', owner: 'gmail', riskTier: 'read_only', description: 'List Gmail labels.' },
  { kind: 'mcp_tool', name: 'create_draft', owner: 'gmail', riskTier: 'mutating', description: 'Create a Gmail draft.' },
  { kind: 'mcp_tool', name: 'label_message', owner: 'gmail', riskTier: 'mutating', description: 'Apply a label to a Gmail message.' },
  { kind: 'mcp_tool', name: 'create_label', owner: 'gmail', riskTier: 'mutating', description: 'Create a Gmail label.' },
  { kind: 'mcp_tool', name: 'trash_message', owner: 'gmail', riskTier: 'destructive', description: 'Move a Gmail message to trash.' },
  { kind: 'mcp_tool', name: 'mark_message_spam', owner: 'gmail', riskTier: 'destructive', description: 'Mark a Gmail message as spam.' },

  // ---- Google Drive MCP -------------------------------------------------------------------
  { kind: 'mcp_tool', name: 'search_files', owner: 'gdrive', riskTier: 'read_only', description: 'Search Google Drive files.' },
  { kind: 'mcp_tool', name: 'read_file_content', owner: 'gdrive', riskTier: 'read_only', description: 'Read the content of a Google Drive file.' },
  { kind: 'mcp_tool', name: 'get_file_metadata', owner: 'gdrive', riskTier: 'read_only', description: 'Get metadata for a Google Drive file.' },
  { kind: 'mcp_tool', name: 'create_file', owner: 'gdrive', riskTier: 'mutating', description: 'Create a Google Drive file.' },
  { kind: 'mcp_tool', name: 'copy_file', owner: 'gdrive', riskTier: 'mutating', description: 'Copy a Google Drive file.' },
];

/**
 * The read-only baseline every role gets.
 *
 * Written out rather than derived with `.filter(riskTier === 'read_only')`, because the two are not
 * the same statement: the filter would silently enlarge every role's grants the moment somebody
 * added a read-only capability, and "read-only" is a tier, not a promise that a tool is
 * uninteresting — a read-only tool that reads a mailbox is still a decision someone should make on
 * purpose. This list is that decision, and adding to it is an edit.
 */
const READ_ONLY_BASELINE = [
  capRef('skill', 'security-review'),
  capRef('skill', 'dataviz'),
  capRef('skill', 'loop'),
  capRef('skill', 'open-capabilities-dashboard'),
  capRef('skill', 'deploy-capability-governance-server'),
  capRef('mcp_tool', 'read_file'),
  capRef('mcp_tool', 'list_files'),
  capRef('mcp_tool', 'list_projects'),
  capRef('mcp_tool', 'wispfield_view'),
  capRef('mcp_tool', 'wispfield_get_field_status'),
  capRef('mcp_tool', 'wispfield_recall'),
  capRef('mcp_tool', 'search_threads'),
  capRef('mcp_tool', 'get_message'),
  capRef('mcp_tool', 'list_labels'),
  capRef('mcp_tool', 'search_files'),
  capRef('mcp_tool', 'read_file_content'),
  capRef('mcp_tool', 'get_file_metadata'),
];

/**
 * The roles.
 *
 * `general-purpose`/`Explore`/`Plan`/`design-agent`/`claude`/`statusline-setup` are Claude Code's
 * own Task-tool subagent types — a role an agent *acts as* for a given call, not a platform
 * identity. They are defined here rather than discovered because a subagent runs inside its
 * parent's process and has no `LOOM_NODE_ID` of its own to self-register with.
 *
 * `claudecode` is the real top-level-agent role, the one ./principals/registry.js upserts every
 * live loom under. On a node ./seed.js gets it for free by upserting a real identity; central has
 * no loom to upsert, so it is listed here explicitly — an empty central otherwise has the grants
 * plan below referring to a role that does not exist, which is the shape of "the fleet's catalog
 * seeded but nobody can use it".
 */
const ROLES = [
  { kind: 'role', name: 'general-purpose' },
  { kind: 'role', name: 'Explore' },
  { kind: 'role', name: 'Plan' },
  { kind: 'role', name: 'design-agent' },
  { kind: 'role', name: 'claude' },
  { kind: 'role', name: 'statusline-setup' },
  { kind: 'role', name: 'claudecode' },
];

/**
 * Grants beyond the read-only baseline, by role name. Every role in ROLES also receives all of
 * READ_ONLY_BASELINE; a role absent from this map (Explore, Plan) receives only that, which is the
 * correct surface for a read-only agent.
 *
 * `wispfield_close_loom`, `delete_files` and `mark_message_spam` appear nowhere on purpose. They
 * are the three destructive rows a fresh install leaves ungranted, so that the first person to need
 * one goes through the approvals path rather than finding it already open.
 */
const ROLE_GRANTS = {
  // The full-stack catch-alls.
  'general-purpose': [
    capRef('skill', 'code-review'), capRef('skill', 'simplify'), capRef('skill', 'run'),
    capRef('skill', 'update-config'), capRef('skill', 'schedule'), capRef('skill', 'init'),
    capRef('mcp_tool', 'wispfield_spawn_agent'), capRef('mcp_tool', 'wispfield_dispatch_command'),
    capRef('mcp_tool', 'wispfield_report_progress'),
    capRef('mcp_tool', 'create_draft'), capRef('mcp_tool', 'label_message'), capRef('mcp_tool', 'create_label'),
    capRef('mcp_tool', 'create_file'), capRef('mcp_tool', 'copy_file'),
  ],
  // claude and claudecode are the same surface plus the two destructive rows a workspace operator
  // actually uses. Spelled out twice rather than aliased: they are two rows in `principals` and a
  // future edit that narrows one should not silently narrow the other.
  claude: [
    capRef('skill', 'code-review'), capRef('skill', 'simplify'), capRef('skill', 'run'),
    capRef('skill', 'update-config'), capRef('skill', 'schedule'), capRef('skill', 'init'),
    capRef('mcp_tool', 'wispfield_spawn_agent'), capRef('mcp_tool', 'wispfield_dispatch_command'),
    capRef('mcp_tool', 'wispfield_report_progress'),
    capRef('mcp_tool', 'create_draft'), capRef('mcp_tool', 'label_message'), capRef('mcp_tool', 'create_label'),
    capRef('mcp_tool', 'create_file'), capRef('mcp_tool', 'copy_file'),
    capRef('mcp_tool', 'wispfield_clear_field'), capRef('mcp_tool', 'wispfield_halt_agents'),
    capRef('mcp_tool', 'trash_message'),
  ],
  claudecode: [
    capRef('skill', 'code-review'), capRef('skill', 'simplify'), capRef('skill', 'run'),
    capRef('skill', 'update-config'), capRef('skill', 'schedule'), capRef('skill', 'init'),
    capRef('mcp_tool', 'wispfield_spawn_agent'), capRef('mcp_tool', 'wispfield_dispatch_command'),
    capRef('mcp_tool', 'wispfield_report_progress'),
    capRef('mcp_tool', 'create_draft'), capRef('mcp_tool', 'label_message'), capRef('mcp_tool', 'create_label'),
    capRef('mcp_tool', 'create_file'), capRef('mcp_tool', 'copy_file'),
    capRef('mcp_tool', 'wispfield_clear_field'), capRef('mcp_tool', 'wispfield_halt_agents'),
    capRef('mcp_tool', 'trash_message'),
  ],
  // A narrower slice: design work, plus the two claude-design writes. delete_files stays out.
  'design-agent': [
    capRef('skill', 'code-review'), capRef('skill', 'simplify'), capRef('skill', 'run'),
    capRef('mcp_tool', 'write_files'), capRef('mcp_tool', 'copy_files'),
  ],
  'statusline-setup': [capRef('skill', 'update-config')],
};

/** Index the catalog by reference, so a seeder can resolve `mcp_tool:create_file` without a scan
 *  per grant. Built once here rather than in each seeder, since a ref that matches nothing is a
 *  typo in THIS file and both seeders should fail on it identically. */
function catalogByRef() {
  const byRef = new Map();
  for (const cap of CAPABILITIES) byRef.set(capRef(cap.kind, cap.name), cap);
  return byRef;
}

/** Every ref a role should hold: the baseline plus its own extras, de-duplicated. */
function grantsForRole(roleName) {
  return [...new Set([...READ_ONLY_BASELINE, ...(ROLE_GRANTS[roleName] || [])])];
}

module.exports = { CAPABILITIES, READ_ONLY_BASELINE, ROLES, ROLE_GRANTS, capRef, catalogByRef, grantsForRole };
