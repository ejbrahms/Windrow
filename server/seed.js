// Populates the NODE's own store (server/data/windrow.db) with the starter capability-governance
// dataset, per the "Seed data" section of docs/design/api-contract.md.
//
// The catalog itself moved to ./starterCatalog.js. That extraction is phase 4 arriving in this file
// (docs/design/setup-after-central.md §3): a fleet install seeds Postgres through ./seed-central.js
// instead of seeding here, because `store.save` is one of the mutators `guardPolicyWrite` wraps and
// correctly throws PolicyReadOnlyError on a node with WINDROW_POLICY_AUTHORITY=central. Two seeders,
// two engines, one catalog — see that file's header for why a copy-paste fork would be worse than
// no central seed at all.
//
// WHAT STAYS HERE and is deliberately not shared: the id minting (a node mints `cap_…`/`pr_…`
// locally; central mints its own and a node's ids mean nothing to it), the node-local capability
// columns (`source`/`discoveredAt`/`stale`/… — see below), and the instance principals, which are a
// snapshot of one workspace's live agent roster rather than a fleet baseline.
const { genId } = require('./id');
const store = require('./store');
const { upsertPrincipalFromIdentity } = require('./principals/registry');
const { CAPABILITIES, ROLES, capRef, grantsForRole } = require('./starterCatalog');

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

// Every row gets a node-minted id and the node-local discovery columns. `source: 'manual'` is the
// load-bearing one: these predate discovery (docs/design/integration-todo.md item 1), and marking
// them manual is what stops a discovery run mistaking them for something it is responsible for
// pruning or staling. None of those columns exist at central (server/central/centralMigrations.js
// migration 3), which is exactly why they are applied here and not in the shared catalog.
const capabilities = [];
const capByRef = new Map();
for (const entry of CAPABILITIES) {
  const cap = {
    id: genId('cap'),
    kind: entry.kind,
    name: entry.name,
    owner: entry.owner,
    riskTier: entry.riskTier,
    description: entry.description,
    source: 'manual', discoveredAt: null, lastSeenAt: null, stale: false, realUsage: null,
    autoGrant: Boolean(entry.autoGrant),
  };
  capabilities.push(cap);
  capByRef.set(capRef(cap.kind, cap.name), cap);
}

/** Resolve a `kind:name` reference to the row just minted for it. Throws rather than returning
 *  undefined, because a ref that matches nothing is a typo in the catalog and a grant silently
 *  pointing at `undefined.id` is the kind of seed that boots clean and denies everything. */
function cap(ref) {
  const found = capByRef.get(ref);
  if (!found) throw new Error(`starterCatalog has no capability "${ref}"`);
  return found;
}

// Skills are catalog-only and grant nothing (docs/design/skill-mcp-governance.md §0), so no skill
// cap is resolved for granting here — the instance grants below are MCP tools only.
const capWfView = cap(capRef('mcp_tool', 'wispfield_view'));
const capWfStatus = cap(capRef('mcp_tool', 'wispfield_get_field_status'));
const capWfRecall = cap(capRef('mcp_tool', 'wispfield_recall'));
const capWfSpawn = cap(capRef('mcp_tool', 'wispfield_spawn_agent'));
const capWfDispatch = cap(capRef('mcp_tool', 'wispfield_dispatch_command'));
const capWfReportProgress = cap(capRef('mcp_tool', 'wispfield_report_progress'));
const capWfClearField = cap(capRef('mcp_tool', 'wispfield_clear_field'));
const capWfHaltAgents = cap(capRef('mcp_tool', 'wispfield_halt_agents'));
const capGmSearch = cap(capRef('mcp_tool', 'search_threads'));
const capGmCreateDraft = cap(capRef('mcp_tool', 'create_draft'));
const capGmLabelMessage = cap(capRef('mcp_tool', 'label_message'));
const capGmCreateLabel = cap(capRef('mcp_tool', 'create_label'));
const capGmTrashMessage = cap(capRef('mcp_tool', 'trash_message'));
const capGdSearch = cap(capRef('mcp_tool', 'search_files'));
const capGdCreateFile = cap(capRef('mcp_tool', 'create_file'));
const capGdCopyFile = cap(capRef('mcp_tool', 'copy_file'));

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const principals = [];
function addPrincipal(kind, name, parentRole) {
  const p = { id: genId('pr'), kind, name, parentRole: parentRole || null };
  principals.push(p);
  return p;
}

// The roles come from the shared catalog: `claude`/`general-purpose`/`Explore`/`Plan`/
// `design-agent`/`statusline-setup` are Claude Code's own Task-tool subagent types — a role an
// agent *acts as* for a given call, not a platform identity — plus `claudecode`, the real
// top-level-agent role. They stay manually defined because a subagent runs inside its parent
// agent's process and has no `LOOM_NODE_ID` of its own to discover.
//
// `claudecode` is created here rather than left to `upsertPrincipalFromIdentity` below only so it
// lands `status: 'active'`. This is bootstrap/demo data standing in for a role a human has already
// reviewed (it is granted a full set of capabilities below), not a real first-sighting — upsertRole's
// The upsertRole default of `status: 'pending'` would show a misleading "awaiting approval" badge on an
// already-fully-provisioned seed role. The upsert below then finds this row by (kind, name) and
// reuses it.
const roleByName = new Map();
for (const role of ROLES) roleByName.set(role.name, addPrincipal('role', role.name, role.parentRole));
roleByName.get('claudecode').status = 'active';

// Instance principals, by contrast, ARE real platform identities — see
// server/principals/{fromEnv,registry}.js, roadmap item 2 ("Map real principals"). Each agent on
// the workspace gets a `claudecode`-role instance keyed on its real `LOOM_NODE_ID`, carrying its
// real human name/backend/field, upserted through the same `upsertPrincipalFromIdentity` a
// PreToolUse hook uses to self-register at call time (roadmap item 3). This snapshot is the
// actual workspace roster from `wispfield_get_field_status` at seed time (2026-08-13) — a live
// system replaces it continuously as agents come and go; seed.js only bootstraps the store once
// (roadmap item 5). It is NOT in the shared catalog: a particular PC's looms are not a fleet
// baseline, and writing them into central would hand every other node three principals that will
// never call it.
const principalsDb = { principals };
upsertPrincipalFromIdentity(principalsDb, {
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
function addGrant(principal, capability) {
  const g = {
    id: genId('gr'),
    principalId: principal.id,
    capabilityId: capability.id,
    constraints: null,
    createdAt: isoDaysAgo(randomInt(20, 90)),
    expiresAt: null,
  };
  grants.push(g);
  grantIndex.set(key(principal.id, capability.id), g);
  return g;
}
function addGrants(principal, caps) {
  for (const c of caps) addGrant(principal, c);
}

// Role grants come whole from the shared plan — the read-only baseline every role gets, plus each
// role's own mutating/destructive extras. `wispfield_close_loom`, `delete_files` and
// `mark_message_spam` appear in no role's list on purpose; see starterCatalog.js.
for (const { name } of ROLES) {
  addGrants(roleByName.get(name), grantsForRole(name).map(cap));
}

// Instance-level grants: named real agents get their own copy of a working subset of what
// `claudecode` grants by default (grants are role-scoped by default, with instance overrides
// for the specific agent actually making calls) — sized to what each agent was actually doing on
// this workspace at seed time. Node-local for the same reason the instances themselves are.
addGrants(instColeLoom, [
  // Cole: real capability discovery (roadmap item 1) — filesystem/MCP-manifest scanning, no
  // destructive or inbox/drive work. MCP tools only; skills are catalog-only.
  capWfView, capWfStatus, capWfRecall,
]);
addGrants(instMiraLoom, [
  // Mira: wiring real enforcement (roadmap item 3) — needs the full orchestration surface to
  // exercise the broker end to end. MCP tools only; skills are catalog-only.
  capWfView, capWfStatus, capWfRecall, capGmSearch, capGdSearch,
  capWfSpawn, capWfDispatch, capWfReportProgress,
  capGmCreateDraft, capGmLabelMessage, capGmCreateLabel,
  capGdCreateFile, capGdCopyFile,
  capWfClearField, capWfHaltAgents, capGmTrashMessage,
]);
addGrants(instFinnLoom, [
  // Finn: mapping real principals (roadmap item 2, this file) — workspace/registry work, no
  // destructive tools needed. MCP tools only; skills are catalog-only.
  capWfView, capWfStatus, capWfRecall, capGmSearch, capGdSearch,
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
