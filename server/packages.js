'use strict';
// Capability packages — docs/design/capability-packages.md.
//
// Replaces the failure mode that caused a 21-capability default-grant gap (`wispfield_close_loom`,
// `wispfield_report_task_complete`, and every governance lookup tool shipped with zero grants
// because seed.js's addGrants(...) calls are hand-maintained and nothing forced them to stay in
// sync with new capabilities): a package binds a capability *owner* to a default policy, so a new
// capability under an already-enabled owner picks up that policy the moment discovery finds it,
// not the next time someone happens to audit by hand.
//
// A package is defined here in code, not a database row — the policy is a deliberate per-owner
// decision (which risk tiers auto-grant vs. need a curated include-list), not user data. What *is*
// persisted (server/store.js's `packages_enabled` kv row) is which packages are turned on for this
// workspace, since "not every workspace uses wispfield" (docs/design/capability-packages.md §4).

const store = require('./store');
const { genId } = require('./id');
const { currentOsUser, currentHostname } = require('./principals/fromEnv');

// Audit actor for package-driven grant changes — sync/revoke run in-process on this server, triggered by an admin toggling a package on the
// Providers page, so there's no request to read a token scope off; 'package' marks these rows as
// policy-driven rather than a human directly issuing/revoking one grant at a time.
function auditActor() {
  return { actorScope: 'package', osUser: currentOsUser(process.env), hostname: currentHostname(process.env) };
}

// The standard orchestrator roles every general-purpose Claude Code agent runs as — the same set
// seed.js already grants identically (`general-purpose`/`claude`/`claudecode` are treated as one
// "full-stack catch-all" group there). `claude-standalone` is the bare-terminal/CI equivalent
// (docs/design/cross-field-and-standalone.md) and gets the same baseline.
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

function findPackage(id) {
  return byId.get(id) || null;
}

function getEnabledMap() {
  const stored = store.getPackagesState();
  const map = {};
  for (const pkg of PACKAGES) {
    map[pkg.id] = stored && Object.prototype.hasOwnProperty.call(stored, pkg.id) ? Boolean(stored[pkg.id]) : pkg.enabledByDefault;
  }
  return map;
}

function setEnabled(id, enabled) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const map = getEnabledMap();
  map[id] = enabled;
  store.setPackagesState(map);
  return map[id];
}

/** Capabilities this package could grant, i.e. every capability whose owner it claims. */
function eligibleCapabilities(pkg) {
  if (!pkg.owners.length) return [];
  return store.listCapabilities().filter((c) => pkg.owners.includes(c.owner));
}

/**
 * Grants every eligible capability's policy-included tier to the package's role principals.
 * Idempotent — findGrant/insertGrant's UNIQUE(principalId, capabilityId) means a re-run only adds
 * what's missing, same as running this by hand with grant_capability (which is exactly what this
 * replaces). Returns counts, not the grants themselves — the dashboard just needs "did anything
 * change," not a list to render.
 */
function syncPackage(id) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  const now = new Date().toISOString();
  let granted = 0;
  let alreadyPresent = 0;
  let skipped = 0;

  for (const cap of eligibleCapabilities(pkg)) {
    const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
    const included =
      policy.mode === 'auto' ||
      (policy.mode === 'explicit' && policy.include.includes(cap.name));
    if (!included) {
      skipped++;
      continue;
    }
    for (const roleName of policy.roles) {
      const role = roleByName.get(roleName);
      if (!role) continue; // this role hasn't been seen on this workspace yet — nothing to grant
      if (store.findGrant(role.id, cap.id)) {
        alreadyPresent++;
        continue;
      }
      const grant = {
        id: genId('gr'),
        principalId: role.id,
        capabilityId: cap.id,
        constraints: null,
        createdAt: now,
        expiresAt: null,
      };
      store.insertGrant(grant);
      store.insertAuditEntry({
        action: 'grant_issue',
        ...auditActor(),
        principalId: role.id,
        capabilityId: cap.id,
        grantId: grant.id,
        after: grant,
        reason: `synced by package ${pkg.id}`,
      });
      granted++;
    }
  }
  return { packageId: id, granted, alreadyPresent, skipped };
}

/**
 * The explicit teardown counterpart to syncPackage: deletes every grant this package could have
 * issued — any (eligible capability × package role) pair currently granted, not just the ones the
 * current policy would auto-grant, since a grant made explicit by policy or by hand under this
 * package's ownership is still this package's to revoke. Disable alone deliberately doesn't do
 * this (server/app.js's /disable comment) so an in-flight agent isn't cut off by a config toggle;
 * this is the separate, deliberate "actually take it back" action for when that's what's wanted.
 */
function revokePackage(id) {
  const pkg = findPackage(id);
  if (!pkg) return null;
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  let revoked = 0;

  for (const cap of eligibleCapabilities(pkg)) {
    for (const roleName of pkg.roles) {
      const role = roleByName.get(roleName);
      if (!role) continue;
      const grant = store.findGrant(role.id, cap.id);
      if (!grant) continue;
      const after = store.revokeGrant(grant.id, `package:${pkg.id}`);
      if (!after) continue;
      store.insertAuditEntry({
        action: 'grant_revoke',
        ...auditActor(),
        principalId: role.id,
        capabilityId: cap.id,
        grantId: grant.id,
        before: grant,
        after,
        reason: `revoked by package ${pkg.id}`,
      });
      revoked++;
    }
  }
  return { packageId: id, revoked };
}

/** One row per package for the Providers & Integrations page: status + how much is covered. */
function listPackagesWithStatus() {
  const enabledMap = getEnabledMap();
  const roleByName = new Map(store.listPrincipals().filter((p) => p.kind === 'role').map((p) => [p.name, p]));
  return PACKAGES.map((pkg) => {
    const caps = eligibleCapabilities(pkg);
    let policyEligible = 0;
    let granted = 0;
    for (const cap of caps) {
      const policy = normalizePolicy(pkg.policy[cap.riskTier], pkg.roles);
      const included = policy.mode === 'auto' || (policy.mode === 'explicit' && policy.include.includes(cap.name));
      if (!included) continue;
      for (const roleName of policy.roles) {
        const role = roleByName.get(roleName);
        if (!role) continue;
        policyEligible++;
        if (store.findGrant(role.id, cap.id)) granted++;
      }
    }
    return {
      id: pkg.id,
      kind: pkg.kind,
      label: pkg.label,
      description: pkg.description,
      owners: pkg.owners,
      roles: pkg.roles,
      enabled: enabledMap[pkg.id],
      capabilityCount: caps.length,
      coverage: { granted, total: policyEligible },
    };
  });
}

module.exports = {
  PACKAGES,
  findPackage,
  getEnabledMap,
  setEnabled,
  syncPackage,
  revokePackage,
  listPackagesWithStatus,
};
