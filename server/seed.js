// Populates server/data/db.json with a realistic capability-governance dataset,
// per the "Seed data" section of docs/design/api-contract.md.
const { genId } = require('./id');
const store = require('./store');
const { upsertPrincipalFromIdentity } = require('./principals/registry');

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isoDaysAgo(days, hoursJitter = 24) {
  const ms = Date.now() - days * 86400000 - randomInt(0, hoursJitter * 3600) * 1000;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const capabilities = [];
function addCap(kind, name, owner, riskTier, description) {
  const cap = {
    id: genId('cap'), kind, name, owner, riskTier, description,
    // Predates discovery (docs/design/integration-todo.md item 1) — "manual" so a discovery run
    // never mistakes these for something it's responsible for pruning/staling.
    source: 'manual', discoveredAt: null, lastSeenAt: null, stale: false, realUsage: null,
  };
  capabilities.push(cap);
  return cap;
}

// Skills
const capCodeReview = addCap('skill', 'code-review', 'platform', 'mutating', 'Reviews the current diff or PR for bugs and cleanups; can post inline comments or apply fixes.');
const capSimplify = addCap('skill', 'simplify', 'platform', 'mutating', 'Reviews changed code for reuse/simplification/efficiency and applies the fixes.');
const capSecurityReview = addCap('skill', 'security-review', 'platform', 'read_only', 'Completes a security review of the pending changes on the current branch.');
const capDataviz = addCap('skill', 'dataviz', 'platform', 'read_only', 'Design guidance for building charts, graphs, plots, and dashboards.');
const capRun = addCap('skill', 'run', 'platform', 'mutating', 'Launches and drives the project app to see a change working.');
const capUpdateConfig = addCap('skill', 'update-config', 'platform', 'mutating', 'Configures the Claude Code harness via settings.json (hooks, permissions, env vars).');
const capLoop = addCap('skill', 'loop', 'platform', 'read_only', 'Runs a prompt or slash command on a recurring interval.');
const capSchedule = addCap('skill', 'schedule', 'platform', 'mutating', 'Creates, updates, lists, or runs scheduled cloud agents (routines).');
const capInit = addCap('skill', 'init', 'platform', 'mutating', 'Initializes a new CLAUDE.md file with codebase documentation.');

// The governance tool's own skills. Registered explicitly (source: 'manual', like the rest of
// this file) rather than left for filesystem discovery to pick up: discovery defaults an
// unclassified skill to riskTier 'mutating' (server/discovery/scan.js), which would make the
// governance tool gate access to *itself* behind a grant nobody has issued yet. read_only here
// is deliberate — both skills only read/open the dashboard or write local dev config
// (hooks.json/settings.json), asked-for explicitly by the "auto-enable the governance tool's own
// capabilities" requirement — and both are added to `allReadOnly` below so every current and
// future role gets them for free, the same auto-grant policy the design doc gives every other
// read-only capability (docs/design/skill-mcp-governance.md section 4).
const capOpenDashboard = addCap('skill', 'open-capabilities-dashboard', 'capability-governance', 'read_only', 'Opens the capability-governance dashboard as a field card.');
const capDeployGovernanceServer = addCap('skill', 'deploy-capability-governance-server', 'capability-governance', 'read_only', 'Deploys/wires the capability-governance server onto a Wispfield field.');

// claude-design MCP
const capCdReadFile = addCap('mcp_tool', 'read_file', 'claude-design', 'read_only', 'Read a file from a Claude Design project.');
const capCdListFiles = addCap('mcp_tool', 'list_files', 'claude-design', 'read_only', 'List files in a Claude Design project.');
const capCdListProjects = addCap('mcp_tool', 'list_projects', 'claude-design', 'read_only', 'List Claude Design projects.');
const capCdWriteFiles = addCap('mcp_tool', 'write_files', 'claude-design', 'mutating', 'Write files into a Claude Design project.');
const capCdCopyFiles = addCap('mcp_tool', 'copy_files', 'claude-design', 'mutating', 'Copy files within a Claude Design project.');
const capCdDeleteFiles = addCap('mcp_tool', 'delete_files', 'claude-design', 'destructive', 'Delete files from a Claude Design project.');

// wispfield MCP
const capWfView = addCap('mcp_tool', 'wispfield_view', 'wispfield', 'read_only', 'View the current field state.');
const capWfStatus = addCap('mcp_tool', 'wispfield_get_field_status', 'wispfield', 'read_only', 'Get status of looms running on the field.');
const capWfRecall = addCap('mcp_tool', 'wispfield_recall', 'wispfield', 'read_only', 'Recall prior field memory/context.');
const capWfSpawn = addCap('mcp_tool', 'wispfield_spawn_agent', 'wispfield', 'mutating', 'Spawn a new agent loom on the field.');
const capWfDispatch = addCap('mcp_tool', 'wispfield_dispatch_command', 'wispfield', 'mutating', 'Dispatch an instruction to another loom on the field.');
const capWfReportProgress = addCap('mcp_tool', 'wispfield_report_progress', 'wispfield', 'mutating', 'Publish a plan/progress update to a loom card.');
const capWfClearField = addCap('mcp_tool', 'wispfield_clear_field', 'wispfield', 'destructive', 'Clear all looms from the field.');
const capWfHaltAgents = addCap('mcp_tool', 'wispfield_halt_agents', 'wispfield', 'destructive', 'Halt all running agents on the field.');
const capWfCloseLoom = addCap('mcp_tool', 'wispfield_close_loom', 'wispfield', 'destructive', 'Close a specific loom on the field.');

// gmail MCP
const capGmSearch = addCap('mcp_tool', 'search_threads', 'gmail', 'read_only', 'Search Gmail threads.');
const capGmGetMessage = addCap('mcp_tool', 'get_message', 'gmail', 'read_only', 'Get a Gmail message.');
const capGmListLabels = addCap('mcp_tool', 'list_labels', 'gmail', 'read_only', 'List Gmail labels.');
const capGmCreateDraft = addCap('mcp_tool', 'create_draft', 'gmail', 'mutating', 'Create a Gmail draft.');
const capGmLabelMessage = addCap('mcp_tool', 'label_message', 'gmail', 'mutating', 'Apply a label to a Gmail message.');
const capGmCreateLabel = addCap('mcp_tool', 'create_label', 'gmail', 'mutating', 'Create a Gmail label.');
const capGmTrashMessage = addCap('mcp_tool', 'trash_message', 'gmail', 'destructive', 'Move a Gmail message to trash.');
const capGmMarkSpam = addCap('mcp_tool', 'mark_message_spam', 'gmail', 'destructive', 'Mark a Gmail message as spam.');

// claude_ai_Google_Drive MCP
const capGdSearch = addCap('mcp_tool', 'search_files', 'gdrive', 'read_only', 'Search Google Drive files.');
const capGdReadContent = addCap('mcp_tool', 'read_file_content', 'gdrive', 'read_only', 'Read the content of a Google Drive file.');
const capGdMetadata = addCap('mcp_tool', 'get_file_metadata', 'gdrive', 'read_only', 'Get metadata for a Google Drive file.');
const capGdCreateFile = addCap('mcp_tool', 'create_file', 'gdrive', 'mutating', 'Create a Google Drive file.');
const capGdCopyFile = addCap('mcp_tool', 'copy_file', 'gdrive', 'mutating', 'Copy a Google Drive file.');

const allReadOnly = [
  capSecurityReview, capDataviz, capLoop,
  capOpenDashboard, capDeployGovernanceServer,
  capCdReadFile, capCdListFiles, capCdListProjects,
  capWfView, capWfStatus, capWfRecall,
  capGmSearch, capGmGetMessage, capGmListLabels,
  capGdSearch, capGdReadContent, capGdMetadata,
];

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const principals = [];
function addPrincipal(kind, name, parentRole) {
  const p = { id: genId('pr'), kind, name, parentRole: parentRole || null };
  principals.push(p);
  return p;
}

// `claude`/`general-purpose`/`Explore`/`Plan`/`design-agent`/`statusline-setup` are Claude Code's
// own Task-tool subagent types — a role a loom *acts as* for a given call, not a Wispfield
// identity. They stay manually defined: a subagent runs inside its parent loom's process and has
// no `LOOM_NODE_ID` of its own to discover.
const roleGeneralPurpose = addPrincipal('role', 'general-purpose');
const roleExplore = addPrincipal('role', 'Explore');
const rolePlan = addPrincipal('role', 'Plan');
const roleDesignAgent = addPrincipal('role', 'design-agent');
const roleClaude = addPrincipal('role', 'claude');
const roleStatusline = addPrincipal('role', 'statusline-setup');

// Instance principals, by contrast, ARE real Wispfield identities — see
// server/principals/{fromEnv,registry}.js, roadmap item 2 ("Map real principals"). Each loom on
// the field gets a `claudecode`-role instance keyed on its real `LOOM_NODE_ID`, carrying its
// real human name/backend/field, upserted through the same `upsertPrincipalFromIdentity` a
// PreToolUse hook uses to self-register at call time (roadmap item 3). This snapshot is the
// actual field roster from `wispfield_get_field_status` at seed time (2026-08-13) — a live
// system replaces it continuously as looms come and go; seed.js only bootstraps the store once
// (roadmap item 5).
const principalsDb = { principals };
const { role: roleClaudecode } = upsertPrincipalFromIdentity(principalsDb, {
  loomId: 'claude-msri1c9v-43', humanName: 'Finn', backend: 'claude', agentType: 'claudecode', field: 'windrow',
});
const instFinnLoom = principals.find((p) => p.name === 'claude-msri1c9v-43');
const instColeLoom = upsertPrincipalFromIdentity(principalsDb, {
  loomId: 'claude-msqvb0zl-4', humanName: 'Cole', backend: 'claude', agentType: 'claudecode', field: 'windrow',
}).instance;
const instMiraLoom = upsertPrincipalFromIdentity(principalsDb, {
  loomId: 'claude-msri1bho-41', humanName: 'Mira', backend: 'claude', agentType: 'claudecode', field: 'windrow',
}).instance;

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const grants = [];
// Track (principal, capability) -> grant so the usage generator can look them up,
// and so we can deliberately withhold usage from a handful ("unused grants").
const grantIndex = new Map();
function key(principalId, capabilityId) {
  return `${principalId}::${capabilityId}`;
}
function addGrant(principal, cap) {
  const g = {
    id: genId('gr'),
    principalId: principal.id,
    capabilityId: cap.id,
    constraints: null,
    createdAt: isoDaysAgo(randomInt(20, 90)),
    expiresAt: null,
  };
  grants.push(g);
  grantIndex.set(key(principal.id, cap.id), g);
  return g;
}
function addGrants(principal, caps) {
  for (const cap of caps) addGrant(principal, cap);
}

// Read-only: auto-granted to every role that plausibly needs it. `claudecode` is the real
// top-level-loom role (see above) and gets the same read-only baseline as everything else.
for (const role of [roleGeneralPurpose, roleExplore, rolePlan, roleDesignAgent, roleClaude, roleStatusline, roleClaudecode]) {
  addGrants(role, allReadOnly);
}

// Mutating skills: general-purpose/claude/claudecode are full-stack catch-alls; design-agent
// does a narrower slice; Plan/Explore are read-only agents and get none.
addGrants(roleGeneralPurpose, [capCodeReview, capSimplify, capRun, capUpdateConfig, capSchedule, capInit]);
addGrants(roleClaude, [capCodeReview, capSimplify, capRun, capUpdateConfig, capSchedule, capInit]);
addGrants(roleClaudecode, [capCodeReview, capSimplify, capRun, capUpdateConfig, capSchedule, capInit]);
addGrants(roleDesignAgent, [capCodeReview, capSimplify, capRun]);
addGrants(roleStatusline, [capUpdateConfig]);

// claude-design mutating tools: design-agent only. delete_files stays ungranted everywhere.
addGrants(roleDesignAgent, [capCdWriteFiles, capCdCopyFiles]);

// wispfield mutating tools: the roles that actually orchestrate the field.
addGrants(roleGeneralPurpose, [capWfSpawn, capWfDispatch, capWfReportProgress]);
addGrants(roleClaude, [capWfSpawn, capWfDispatch, capWfReportProgress]);
addGrants(roleClaudecode, [capWfSpawn, capWfDispatch, capWfReportProgress]);
// wispfield destructive tools: granted sparingly — only claude/claudecode. wispfield_close_loom
// stays ungranted everywhere.
addGrants(roleClaude, [capWfClearField, capWfHaltAgents]);
addGrants(roleClaudecode, [capWfClearField, capWfHaltAgents]);

// gmail mutating tools: general-purpose/claude/claudecode handle inbox triage work.
addGrants(roleGeneralPurpose, [capGmCreateDraft, capGmLabelMessage, capGmCreateLabel]);
addGrants(roleClaude, [capGmCreateDraft, capGmLabelMessage, capGmCreateLabel]);
addGrants(roleClaudecode, [capGmCreateDraft, capGmLabelMessage, capGmCreateLabel]);
// gmail destructive: only claude/claudecode, and only trash_message. mark_message_spam stays ungranted.
addGrants(roleClaude, [capGmTrashMessage]);
addGrants(roleClaudecode, [capGmTrashMessage]);

// gdrive mutating tools: general-purpose/claude/claudecode.
addGrants(roleGeneralPurpose, [capGdCreateFile, capGdCopyFile]);
addGrants(roleClaude, [capGdCreateFile, capGdCopyFile]);
addGrants(roleClaudecode, [capGdCreateFile, capGdCopyFile]);

// Instance-level grants: named real looms get their own copy of a working subset of what
// `claudecode` grants by default (grants are role-scoped by default, with instance overrides
// for the specific loom actually making calls) — sized to what each loom was actually doing on
// this field at seed time.
addGrants(instColeLoom, [
  // Cole: real capability discovery (roadmap item 1) — filesystem/MCP-manifest scanning, no
  // destructive or inbox/drive work.
  capWfView, capWfStatus, capWfRecall, capSecurityReview,
  capCodeReview, capSimplify, capRun, capUpdateConfig, capInit,
]);
addGrants(instMiraLoom, [
  // Mira: wiring real enforcement (roadmap item 3) — needs the full orchestration surface to
  // exercise the broker end to end.
  capWfView, capWfStatus, capWfRecall, capGmSearch, capGdSearch, capSecurityReview,
  capCodeReview, capSimplify, capRun, capUpdateConfig, capSchedule, capInit,
  capWfSpawn, capWfDispatch, capWfReportProgress,
  capGmCreateDraft, capGmLabelMessage, capGmCreateLabel,
  capGdCreateFile, capGdCopyFile,
  capWfClearField, capWfHaltAgents, capGmTrashMessage,
]);
addGrants(instFinnLoom, [
  // Finn: mapping real principals (roadmap item 2, this file) — field/registry work, no
  // destructive tools needed.
  capWfView, capWfStatus, capWfRecall, capGmSearch, capGdSearch, capSecurityReview,
  capCodeReview, capSimplify, capRun, capUpdateConfig, capSchedule, capInit,
  capWfSpawn, capWfDispatch, capWfReportProgress,
]);

// ---------------------------------------------------------------------------
// Write the store
// ---------------------------------------------------------------------------

// No usageEvents here: this file bootstraps the capability/principal/grant baseline once
// (docs/design/roadmap item 5). Real usage events accumulate at runtime from the PreToolUse /
// PostToolUse hooks (server/hooks/{pre,post}-tool-use.js) via POST /invoke and PATCH
// /usage/:id — fabricating them here would only mask whether that pipeline is actually wired up.
// If the store already has usageEvents (a live db.json from a running system), preserve them
// instead of clobbering them with an empty array.
const existing = store.load();
const db = { capabilities, principals, grants, usageEvents: existing.usageEvents || [] };
store.save(db);

console.log(`Seeded ${capabilities.length} capabilities, ${principals.length} principals, ` +
  `${grants.length} grants -> ${store.DB_PATH} (usageEvents left untouched: ${db.usageEvents.length} existing)`);
