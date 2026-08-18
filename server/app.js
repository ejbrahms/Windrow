const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { genId } = require('./id');
const store = require('./store');
const { requireAuth, requireAdmin, requireProposer } = require('./auth');
const { runDiscovery } = require('./discovery');
const { listProviders, installProvider, uninstallProvider, NotFoundError: ProviderNotFoundError, UnsupportedError: ProviderUnsupportedError } = require('./providers');
const packages = require('./packages');
const rollup = require('./rollup');
const skills = require('./skills');
const { refreshCapabilityCache, refreshPrincipalCache } = require('./cacheWarmer');
const { currentOsUser, currentHostname } = require('./principals/fromEnv');

// Actor identity attached to every governance_audit row (F4, docs/design/governance-review-
// 2026-08-16.md): admin/proposer requests all come from a local process (the dashboard, an admin
// CLI script, the governance MCP server) on the same machine as this server, so — unlike
// /api/invoke, which trusts a caller-supplied osUser/hostname because the *hook* is the one that
// actually ran on the calling machine — the server's own live process identity is what's real
// here, not something to trust from the request body.
function auditActor(req) {
  return { actorScope: req.tokenScope, osUser: currentOsUser(process.env), hostname: currentHostname(process.env) };
}

const RISK_TIERS = ['read_only', 'mutating', 'destructive'];

// Capabilities can carry their own `autoGrant` flag (server/store.js) marking them exempt from the
// grant system entirely — how an agent drives the platform itself (viewing status, recalling
// memory), not a third-party tool a human is choosing to expose. Gating them behind a grant nobody
// has issued yet would just break the workspace, and there's no meaningful "revoke" case for an
// agent's own read-only control surface. See findActiveGrant below and GrantsPage.tsx, which locks
// them "on" in the grant/revoke UI for the same reason.
//
// This replaces the old owner-string AUTO_GRANT_OWNERS set (docs/design/governance-review-
// 2026-08-16.md, F5): that bypassed *every* capability owned by 'wispfield', destructive tools
// (wispfield_clear_field/halt_agents/close_loom) included, unconditionally and invisibly. A
// destructive capability can never carry autoGrant=true — enforced at both write sites below
// (POST /api/capabilities and PATCH /api/capabilities/:id/auto-grant), not just documented here.

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sortByName(arr) {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name));
}

// Latency-breakdown fields are nullable (older events, or a call that failed open before a given
// phase ran, never got one) — average only over events that actually carry the field, and report
// null rather than a misleading 0 when none do.
function avgOf(events, field) {
  const withValue = events.filter((e) => typeof e[field] === 'number');
  if (withValue.length === 0) return null;
  return Math.round(withValue.reduce((sum, e) => sum + e[field], 0) / withValue.length);
}

// Instance principals mapped from a real running agent carry the human's actual name
// (server/principals/) — prefer that over the agent/role name, which is otherwise the only
// thing usage views had to show.
function principalDisplayName(principal, fallbackId) {
  if (!principal) return fallbackId;
  return principal.humanName || principal.name;
}

// Usage summary's x-axis: how wide each bucket is, keyed by the granularity a caller asks for
// (dashboard graph's "hours / minutes / custom" control).
const BUCKET_MINUTES = { minute: 1, hour: 60, day: 1440 };
const DEFAULT_WINDOW_MINUTES = { minute: 60, hour: 24 * 60, day: 14 * 1440 };
// Caps how many buckets a custom window can demand, so a caller can't ask for e.g. a year of
// minute-granularity buckets and force us to build tens of thousands of them.
const MAX_BUCKETS = 500;

function bucketLabel(date, granularity) {
  const iso = date.toISOString();
  if (granularity === 'day') return iso.slice(0, 10);
  if (granularity === 'hour') return iso.slice(0, 13) + ':00:00.000Z';
  return iso.slice(0, 16) + ':00.000Z'; // minute
}

/** Capability-property filters (kind/riskTier/owner/source) for the usage summary — narrows the
 * event set to calls against capabilities matching all of the given properties before any
 * aggregation happens, so totals/byCapability/byPrincipal/byBucket all reflect the same filter. */
function filterEventsByCapabilityProps(events, capabilities, query) {
  const { capabilityKind, riskTier, capabilityOwner, capabilitySource } = query;
  if (!capabilityKind && !riskTier && !capabilityOwner && !capabilitySource) {
    return events;
  }
  const matchingIds = new Set(
    capabilities
      .filter(
        (c) =>
          (!capabilityKind || c.kind === capabilityKind) &&
          (!riskTier || c.riskTier === riskTier) &&
          (!capabilityOwner || c.owner === capabilityOwner) &&
          (!capabilitySource || c.source === capabilitySource)
      )
      .map((c) => c.id)
  );
  return events.filter((e) => matchingIds.has(e.capabilityId));
}

function isGrantActive(grant, now) {
  if (!grant.expiresAt) return true;
  return new Date(grant.expiresAt) > now;
}

/**
 * Grants are role-scoped by default (design doc §4): an instance principal without its own
 * grant for a capability inherits its parent role's grant. Instance-level grants, when present,
 * take precedence (they're the "rare one-off" override).
 *
 * Capabilities with autoGrant=true skip grant lookup entirely and return a synthetic always-active
 * grant — every principal can call them, unconditionally. Never true for a 'destructive' capability
 * (enforced where autoGrant is set, not here — this just trusts the flag).
 */
function findActiveGrant(principal, capability, now) {
  if (capability && capability.autoGrant) {
    return { id: 'auto', principalId: principal.id, capabilityId: capability.id, constraints: null, createdAt: null, expiresAt: null };
  }
  const direct = store.findGrant(principal.id, capability.id);
  if (direct && isGrantActive(direct, now)) return direct;
  if (principal.kind === 'instance' && principal.parentRole) {
    const rolePrincipal = store.findPrincipalByKindName('role', principal.parentRole);
    if (rolePrincipal) {
      const roleGrant = store.findGrant(rolePrincipal.id, capability.id);
      if (roleGrant && isGrantActive(roleGrant, now)) return roleGrant;
    }
  }
  return null;
}

const app = express();
app.use(cors({ origin: 'http://localhost:5173' })); // still needed for `vite dev` (port 5173); a
// same-origin production build below never triggers CORS at all.
app.use(express.json());

// Serve the built client (`npm run build` in client/, embedding its bearer token at build time —
// see client/src/api/client.ts and package.json's `build` script) so backend and frontend ship
// and run as one process instead of two things that have to be started, restarted, and kept
// alive independently of each other. Static assets and the SPA shell are public (no secrets in
// them — the token lives in the built JS the same way it would in any SPA); only `/api/*` needs
// the bearer token, so this is registered before `requireAuth` below and the auth gate's behavior
// for the API itself is unchanged.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST));
// SPA fallback: any other GET that isn't `/api/*` is a client-side route (react-router) — hand it
// index.html so the client can take over routing. Must stay ahead of `requireAuth` too, or a
// fresh page load on e.g. `/fleet` would 401 on the HTML shell itself.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// CORS above only restricts *browser* origins — it does nothing against a same-machine process
// (curl, another local tool) calling the API directly, which is exactly how "anything on
// localhost can self-grant" happened. Every request now needs the bearer token from server/auth.js.
app.use(requireAuth);

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

app.get('/api/capabilities', (req, res) => {
  // `autoGranted` mirrors the stored `autoGrant` column under the name the client already reads —
  // a client that hides or disables toggling for these needs to know which ones, and findActiveGrant
  // (above) is what actually decides it, so this is just relaying that flag, not a second source of truth.
  const withAutoGranted = sortByName(store.listCapabilities()).map((c) => ({
    ...c,
    autoGranted: c.autoGrant,
  }));
  res.json(withAutoGranted);
});

// Registry-mutating routes are admin-scoped only (docs/design/governance-vulnerability-review.md
// finding #1): the agent token every hook process carries can resolve capabilities and log
// invocations, but cannot register/retier a capability, create a principal, or issue/revoke a
// grant — closing the self-grant path where any tool call that could read the (formerly single)
// token off disk could escalate itself to anything, including destructive tiers.
app.post('/api/capabilities', requireAdmin, (req, res) => {
  const { kind, name, owner, riskTier, description, autoGrant } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!RISK_TIERS.includes(riskTier)) {
    return res.status(400).json({ error: `riskTier must be one of ${RISK_TIERS.join(', ')}` });
  }
  // F5: autoGrant bypasses the grant table entirely (findActiveGrant, above) — never on a
  // destructive row, checked here as well as on the PATCH below so it can't be set either way it
  // could be reached.
  if (autoGrant && riskTier === 'destructive') {
    return res.status(400).json({ error: 'destructive capabilities cannot be auto-granted' });
  }
  const capability = {
    id: genId('cap'),
    kind: kind || null,
    name,
    owner: owner || null,
    riskTier,
    description: description || null,
    autoGrant: !!autoGrant,
  };
  // capabilities has a UNIQUE(kind, name) constraint (finding #10) — not a pre-check against a
  // snapshot that could go stale between the check and the write — so a registration race can't
  // leave two rows for the same (kind, name) pair with resolution order deciding which one governs.
  try {
    store.insertCapability(capability);
  } catch (err) {
    if (err instanceof store.CapabilityConflictError) {
      return res.status(409).json({ error: 'a capability with this kind+name already exists' });
    }
    throw err;
  }
  // Push the new/changed capability into the hook-side cache immediately (see cacheWarmer.js)
  // instead of leaving the next hook call to either miss (a fresh agent's first invocation of
  // this capability) or wait out the warm timer.
  refreshCapabilityCache(store);
  res.status(201).json(capability);
});

// F5 fix — toggles a capability's autoGrant flag (see the comment above findActiveGrant). Admin-
// scoped for the same self-escalation reason as every other registry-mutating route above: this is
// a strictly stronger switch than an ordinary grant (it can't be revoked per-principal, and it's
// invisible to grant lookups), so it needs the same gate a retier would.
app.patch('/api/capabilities/:id/auto-grant', requireAdmin, (req, res) => {
  const { autoGrant } = req.body || {};
  if (typeof autoGrant !== 'boolean') {
    return res.status(400).json({ error: 'autoGrant must be a boolean' });
  }
  const before = store.findCapabilityById(req.params.id);
  if (!before) {
    return res.status(404).json({ error: 'capability not found' });
  }
  if (autoGrant && before.riskTier === 'destructive') {
    return res.status(400).json({ error: 'destructive capabilities cannot be auto-granted' });
  }
  const after = store.setCapabilityAutoGrant(before.id, autoGrant);
  store.insertAuditEntry({
    action: 'capability_auto_grant_set',
    ...auditActor(req),
    capabilityId: before.id,
    before,
    after,
    reason: null,
  });
  refreshCapabilityCache(store);
  res.json({ ...after, autoGranted: after.autoGrant });
});

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

app.get('/api/principals', (req, res) => {
  res.json(sortByName(store.listPrincipals()));
});

app.post('/api/principals', requireAdmin, (req, res) => {
  const { kind, name, parentRole } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (kind !== 'role' && kind !== 'instance') {
    return res.status(400).json({ error: 'kind must be "role" or "instance"' });
  }
  const principal = {
    id: genId('pr'),
    kind,
    name,
    parentRole: parentRole || null,
  };
  store.insertPrincipal(principal);
  // Policy: a role principal's starting grants are every read_only capability — the same baseline
  // principals/registry.js's grantReadOnlyBaseline gives a freshly-sighted role. An instance
  // principal (parentRole set) gets no grants of its own here: it inherits its parent role's
  // grants dynamically, at authorization time (findActiveGrant, above). Earlier this materialized
  // a real per-instance copy of the role's grants at creation time instead, which then had its own
  // lifecycle independent of the role's — revoking the role's grant didn't touch instances that
  // already copied it (docs/design/governance-review-2026-08-16.md, F6). Dropped.
  if (kind === 'role') {
    const readOnlyCapIds = store.listCapabilities().filter((c) => c.riskTier === 'read_only').map((c) => c.id);
    for (const capId of readOnlyCapIds) {
      store.insertGrant({
        id: genId('gr'),
        principalId: principal.id,
        capabilityId: capId,
        constraints: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      });
    }
  }
  refreshPrincipalCache(store);
  res.status(201).json(principal);
});

// F7 (docs/design/governance-review-2026-08-16.md): a role principal minted by first sighting
// (server/principals/registry.js's upsertRole, run from the hook path for any agentType it hasn't
// seen before) lands `status: 'pending'` with zero grants instead of the old auto-provision. This
// is the only place the read-only baseline gets applied to one now — an admin has to actually look
// at the role first. Idempotent-safe against double-granting the same way grantReadOnlyBaseline is:
// insertGrant's active-grant unique index would 409 on a repeat, so this skips capabilities the
// role already holds a direct grant for rather than racing that.
app.post('/api/principals/:id/approve', requireAdmin, (req, res) => {
  const principal = store.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (principal.status !== 'pending') {
    return res.status(409).json({ error: `principal is ${principal.status}, not pending` });
  }
  if (principal.kind === 'role') {
    const alreadyGranted = new Set(
      store.listGrants({ principalId: principal.id }).map((g) => g.capabilityId)
    );
    const readOnlyCapIds = store.listCapabilities().filter((c) => c.riskTier === 'read_only').map((c) => c.id);
    for (const capId of readOnlyCapIds) {
      if (alreadyGranted.has(capId)) continue;
      const grant = {
        id: genId('gr'),
        principalId: principal.id,
        capabilityId: capId,
        constraints: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      };
      store.insertGrant(grant);
      store.insertAuditEntry({
        action: 'grant_issue',
        ...auditActor(req),
        principalId: principal.id,
        capabilityId: capId,
        grantId: grant.id,
        after: grant,
        reason: `read-only baseline on approving principal ${principal.id}`,
      });
    }
  }
  const updated = store.setPrincipalStatus(principal.id, 'active');
  store.insertAuditEntry({
    action: 'principal_approve',
    ...auditActor(req),
    principalId: principal.id,
    reason: (req.body && req.body.reason) || null,
  });
  refreshPrincipalCache(store);
  res.json(updated);
});

// Rejects a pending principal instead of approving it — leaves it at zero grants permanently
// (rather than deleting the row, so a denied principal's later hook calls keep resolving to the
// same id/history instead of re-triggering upsertRole's create-as-pending path over and over).
app.post('/api/principals/:id/deny', requireAdmin, (req, res) => {
  const principal = store.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (principal.status !== 'pending') {
    return res.status(409).json({ error: `principal is ${principal.status}, not pending` });
  }
  const updated = store.setPrincipalStatus(principal.id, 'denied');
  store.insertAuditEntry({
    action: 'principal_deny',
    ...auditActor(req),
    principalId: principal.id,
    reason: (req.body && req.body.reason) || null,
  });
  refreshPrincipalCache(store);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

app.get('/api/grants', (req, res) => {
  const { principalId, capabilityId } = req.query;
  res.json(store.listGrants({ principalId, capabilityId }));
});

app.post('/api/grants', requireAdmin, (req, res) => {
  const { principalId, capabilityId, constraints, expiresAt, reason } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  if (!store.findPrincipalById(principalId)) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (!store.findCapabilityById(capabilityId)) {
    return res.status(404).json({ error: 'capability not found' });
  }
  const grant = {
    id: genId('gr'),
    principalId,
    capabilityId,
    constraints: constraints || null,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
  };
  // The active-grants partial unique index on (principalId, capabilityId) — not a pre-check
  // against a snapshot that could go stale between the check and the write — is what makes this
  // race-safe.
  try {
    store.insertGrant(grant);
  } catch (err) {
    if (err instanceof store.GrantConflictError) {
      return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
    }
    throw err;
  }
  store.insertAuditEntry({ action: 'grant_issue', ...auditActor(req), principalId, capabilityId, grantId: grant.id, after: grant, reason: reason || null });
  res.status(201).json(grant);
});

app.delete('/api/grants/:id', requireAdmin, (req, res) => {
  const before = store.findGrantById(req.params.id);
  const revoked = before && !before.revokedAt ? store.revokeGrant(req.params.id, req.tokenScope) : null;
  if (!revoked) {
    return res.status(404).json({ error: 'grant not found' });
  }
  store.insertAuditEntry({
    action: 'grant_revoke',
    ...auditActor(req),
    principalId: before.principalId,
    capabilityId: before.capabilityId,
    grantId: before.id,
    before,
    after: revoked,
    reason: (req.body && req.body.reason) || null,
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Pending approvals (docs/design/governance-review-2026-08-16.md, F1/F3): the propose endpoints
// below are the *only* thing the proposer-scoped token (server/auth.js's PROPOSER_TOKEN — what the
// governance MCP server now holds instead of the admin token) can do to the grants table, and even
// that isn't direct — they queue an `approvals` row and never call insertGrant/revokeGrant
// themselves. Only POST /api/approvals/:id/approve, admin-only, actually executes one. This is
// what closes the confused-deputy chain: an agent with a grant for `grant_capability` can make the
// MCP server *propose* anything, but proposing no longer grants anything on its own — a human has
// to clear the queue in the dashboard first.
// ---------------------------------------------------------------------------

app.get('/api/approvals', requireAdmin, (req, res) => {
  const { status } = req.query;
  res.json(store.listApprovals({ status }));
});

// Read side of the F4 audit trail — admin-only, same as everything else that can see who did what.
app.get('/api/audit', requireAdmin, (req, res) => {
  const { grantId } = req.query;
  res.json(store.listAuditEntries({ grantId }));
});

app.post('/api/grants/propose', requireProposer, (req, res) => {
  const { principalId, capabilityId, constraints, expiresAt } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  if (!store.findPrincipalById(principalId)) {
    return res.status(404).json({ error: 'principal not found' });
  }
  const capability = store.findCapabilityById(capabilityId);
  if (!capability) {
    return res.status(404).json({ error: 'capability not found' });
  }
  if (store.findGrant(principalId, capabilityId)) {
    return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
  }
  const approval = store.insertApproval({
    id: genId('appr'),
    action: 'grant',
    principalId,
    capabilityId,
    payload: { principalId, capabilityId, constraints: constraints || null, expiresAt: expiresAt || null },
    requestedByScope: req.tokenScope,
    requestedAt: new Date().toISOString(),
  });
  res.status(202).json({ pending: true, approval });
});

app.post('/api/grants/:id/propose-revoke', requireProposer, (req, res) => {
  const grant = store.listGrants().find((g) => g.id === req.params.id);
  if (!grant) {
    return res.status(404).json({ error: 'grant not found' });
  }
  const approval = store.insertApproval({
    id: genId('appr'),
    action: 'revoke',
    principalId: grant.principalId,
    capabilityId: grant.capabilityId,
    payload: { grantId: grant.id },
    requestedByScope: req.tokenScope,
    requestedAt: new Date().toISOString(),
  });
  res.status(202).json({ pending: true, approval });
});

app.post('/api/approvals/:id/approve', requireAdmin, (req, res) => {
  const approval = store.findApprovalById(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'approval not found' });
  }
  if (approval.status !== 'pending') {
    return res.status(409).json({ error: `approval already ${approval.status}` });
  }
  if (approval.action === 'grant') {
    const { principalId, capabilityId, constraints, expiresAt } = approval.payload;
    const grant = { id: genId('gr'), principalId, capabilityId, constraints, createdAt: new Date().toISOString(), expiresAt };
    try {
      store.insertGrant(grant);
    } catch (err) {
      if (err instanceof store.GrantConflictError) {
        return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
      }
      throw err;
    }
    store.insertAuditEntry({
      action: 'grant_issue',
      ...auditActor(req),
      principalId,
      capabilityId,
      grantId: grant.id,
      after: grant,
      reason: `approved proposal ${approval.id}`,
    });
    const decided = store.decideApproval(approval.id, { status: 'approved', decidedByScope: req.tokenScope, resultGrantId: grant.id });
    return res.json({ approval: decided, grant });
  }
  // action === 'revoke'
  const before = store.findGrantById(approval.payload.grantId);
  const revoked = before && !before.revokedAt ? store.revokeGrant(approval.payload.grantId, req.tokenScope) : null;
  if (revoked) {
    store.insertAuditEntry({
      action: 'grant_revoke',
      ...auditActor(req),
      principalId: before.principalId,
      capabilityId: before.capabilityId,
      grantId: before.id,
      before,
      after: revoked,
      reason: `approved proposal ${approval.id}`,
    });
  }
  const decided = store.decideApproval(approval.id, { status: 'approved', decidedByScope: req.tokenScope });
  res.json({ approval: decided, revoked: Boolean(revoked) });
});

app.post('/api/approvals/:id/deny', requireAdmin, (req, res) => {
  const approval = store.findApprovalById(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'approval not found' });
  }
  if (approval.status !== 'pending') {
    return res.status(409).json({ error: `approval already ${approval.status}` });
  }
  const { reason } = req.body || {};
  const decided = store.decideApproval(approval.id, { status: 'denied', decidedByScope: req.tokenScope, reason: reason || null });
  res.json({ approval: decided });
});

// Default length of the real grant an admin issues when they extend a one-time consent approval
// into standing access (F3's "approve for an hour" option) — a body-supplied `hours` overrides it.
const CONSENT_EXTEND_DEFAULT_HOURS = 1;

// F3 (docs/design/governance-review-2026-08-16.md): the ask-consent path (see POST
// /api/usage/:id/approve-consent below) only ever records a one-time approval — it has no channel
// back to the human mid-prompt to offer "approve for an hour" instead of "approve once", since the
// harness's own ask dialog is the only thing actually blocking on their answer. This is the second
// half of that choice: once the one-time approval is on record, an admin can retroactively turn it
// into a real time-boxed grant from the Approvals page, so the *next* call to the same
// principal+capability pair doesn't have to ask again for up to `hours`.
app.post('/api/approvals/:id/extend-grant', requireAdmin, (req, res) => {
  const approval = store.findApprovalById(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'approval not found' });
  }
  if (approval.action !== 'consent') {
    return res.status(400).json({ error: 'only a consent approval can be extended into a grant' });
  }
  if (approval.status !== 'approved') {
    return res.status(409).json({ error: `approval is ${approval.status}, not approved` });
  }
  if (approval.resultGrantId) {
    return res.status(409).json({ error: 'this consent approval already has a grant' });
  }
  if (!approval.principalId || !approval.capabilityId) {
    return res.status(400).json({ error: 'approval is missing a principal or capability to grant' });
  }
  const hoursRaw = req.body && req.body.hours;
  const hours = hoursRaw === undefined ? CONSENT_EXTEND_DEFAULT_HOURS : Number(hoursRaw);
  if (!(hours > 0)) {
    return res.status(400).json({ error: 'hours must be a positive number' });
  }
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const grant = {
    id: genId('gr'),
    principalId: approval.principalId,
    capabilityId: approval.capabilityId,
    constraints: null,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  try {
    store.insertGrant(grant);
  } catch (err) {
    if (err instanceof store.GrantConflictError) {
      return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
    }
    throw err;
  }
  store.insertAuditEntry({
    action: 'grant_issue',
    ...auditActor(req),
    principalId: approval.principalId,
    capabilityId: approval.capabilityId,
    grantId: grant.id,
    after: grant,
    reason: `extended consent approval ${approval.id} to a ${hours}h grant`,
  });
  const decided = store.decideApproval(approval.id, {
    status: 'approved',
    decidedByScope: approval.decidedByScope,
    reason: `${approval.reason || 'approved via harness ask prompt'} — extended to a ${hours}h grant`,
    resultGrantId: grant.id,
  });
  res.json({ approval: decided, grant });
});

// ---------------------------------------------------------------------------
// Invoke — the broker
// ---------------------------------------------------------------------------

app.post('/api/invoke', (req, res) => {
  const { principalId, capabilityId, correlationId, osUser, hostname } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  const principal = store.findPrincipalById(principalId);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  const capability = store.findCapabilityById(capabilityId);
  if (!capability) {
    return res.status(404).json({ error: 'capability not found' });
  }

  const now = new Date();
  // brokerMs isolates just the grant-check work (findActiveGrant) from the rest of the /invoke
  // round trip (network, Express, JSON, the log write itself) — see docs/design/latency-breakdown.md.
  // Answers "is the grant lookup itself slow" with a real number instead of a guess.
  const brokerStart = Date.now();
  const grant = findActiveGrant(principal, capability, now);
  const allowed = Boolean(grant);
  const brokerMs = Date.now() - brokerStart;

  const event = {
    id: genId('ev'),
    principalId,
    capabilityId,
    ts: now.toISOString(),
    outcome: allowed ? 'ok' : 'denied',
    latencyMs: randomInt(40, 400),
    correlationId: correlationId || null,
    reason: allowed ? null : 'no active grant for principal+capability',
    brokerMs,
    // Real computer account/machine that issued this call (server/principals/fromEnv.js's
    // identityFromEnv, forwarded by the hook — see server/hooks/lib.js's resolvePrincipal/invoke),
    // distinct from `principalId` which identifies the agent, not the human OS account behind it.
    osUser: osUser || null,
    hostname: hostname || null,
  };

  // The hook is blocked on this response for its allow/deny decision, but nothing needs the
  // audit-log row to be durable before that decision goes out — only the PATCH from
  // PostToolUse (and anyone reading /api/usage afterwards) does, and both happen strictly later.
  // Respond first, write after: this takes the insert (and, even at synchronous=NORMAL, its
  // small remaining commit cost) off the latency the hook actually measures as grantCheckMs.
  // event.id is generated above (genId), not by the insert, so the caller already has a valid
  // eventId to hand back to PostToolUse even though the row isn't written yet.
  res.json({ allowed, event });
  setImmediate(() => {
    try {
      store.insertUsageEvent(event);
    } catch (err) {
      console.error('[invoke] failed to persist usage event', event.id, err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// PostToolUse hook correction: /invoke logs an event at grant-check time with simulated latency
// (no real tool ran yet behind it). Once the real tool call finishes, the hook PATCHes the same
// event with the actual outcome (ok/error, from what the tool returned) and real latency.
// How long after the original /invoke a correcting PATCH is still trusted as "the tool this hook
// pair was watching just finished" rather than "someone with the shared agent token is rewriting
// old history". Generous enough for a genuinely slow tool call's PostToolUse to land.
const USAGE_CORRECTION_WINDOW_MS = 10 * 60 * 1000;

// Finding: AGENT_TOKEN (server/auth.js) is one secret shared by every hook process for every
// principal — nothing about the bearer token itself says *which* principal is PATCHing. Before
// this, that meant anyone holding it could PATCH any usage event, at any time, to anything:
// flip a denied/error call to ok, blank out the reason, backdate nothing (ts isn't patchable) but
// otherwise rewrite the audit trail freely. Three checks close that without needing a token per
// principal:
//   - the caller must assert the principalId the event was actually logged under (PostToolUse
//     now carries this through from its own pending-file record — server/hooks/lib.js — rather
//     than guessing), so principal A's hook process can't correct principal B's event.
//   - the correction must land inside USAGE_CORRECTION_WINDOW_MS of the original call — anything
//     legitimate is done well before then, so a later PATCH is rewriting history, not correcting it.
//   - the outcome may only take its one legitimate step: the /invoke-time placeholder 'ok'
//     (allowed, tool hasn't run yet) becoming the real 'ok' or 'error' once it has, and only once
//     per event — 'denied' never ran a tool (nothing to correct), and a second PATCH targeting an
//     already-corrected row is rejected outright regardless of what it asks for.
// store.patchUsageEvent() also rechains this row's hash (and everything after it) on every write,
// so even a bug in the checks above — or a write that reached the row some other way — leaves a
// verifiable trace (store.verifyUsageEventChain()) instead of silently passing as legitimate.
app.patch('/api/usage/:id', (req, res) => {
  const existing = store.findUsageEvent(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'usage event not found' });
  }

  const { principalId } = req.body || {};
  if (!principalId || principalId !== existing.principalId) {
    return res.status(403).json({ error: "forbidden: principalId must match the event's own principal" });
  }
  const ageMs = Date.now() - new Date(existing.ts).getTime();
  if (!(ageMs >= 0) || ageMs > USAGE_CORRECTION_WINDOW_MS) {
    return res.status(409).json({ error: `usage event is outside the ${USAGE_CORRECTION_WINDOW_MS / 60000}-minute correction window` });
  }
  if (existing.correctedAt) {
    return res.status(409).json({ error: 'usage event has already been corrected once' });
  }

  const {
    outcome,
    latencyMs,
    reason,
    capabilityLookupMs,
    principalResolveMs,
    grantCheckMs,
  } = req.body || {};
  const patch = {};
  if (outcome !== undefined) {
    if (!['ok', 'denied', 'error'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be one of ok, denied, error' });
    }
    // One-way transition: only the /invoke-time 'ok' placeholder may move, and only to a real
    // terminal outcome — see the block comment above.
    if (existing.outcome !== 'ok' || !['ok', 'error'].includes(outcome)) {
      return res.status(409).json({ error: `outcome cannot transition from ${existing.outcome} to ${outcome}` });
    }
    patch.outcome = outcome;
  }
  if (latencyMs !== undefined) {
    if (typeof latencyMs !== 'number' || latencyMs < 0) {
      return res.status(400).json({ error: 'latencyMs must be a non-negative number' });
    }
    patch.latencyMs = latencyMs;
  }
  if (reason !== undefined) {
    patch.reason = reason;
  }
  // Latency-breakdown fields (docs/design/latency-breakdown.md) — PreToolUse measures these
  // itself (capability lookup, principal resolve, the /invoke round trip) and hands them to
  // PostToolUse via the pending file, which folds them into the same correcting PATCH as
  // outcome/latencyMs. All optional and independently validated so a hook on an older build can
  // still PATCH outcome/latencyMs without these.
  for (const [key, value] of Object.entries({ capabilityLookupMs, principalResolveMs, grantCheckMs })) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || value < 0) {
      return res.status(400).json({ error: `${key} must be a non-negative number` });
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length > 0) {
    // Marks the one-shot correction as spent — see the checks above and the column comment on
    // usage_events.correctedAt in server/store.js.
    patch.correctedAt = new Date().toISOString();
  }
  const event = store.patchUsageEvent(req.params.id, patch);
  res.json(event);
});

// F3 (docs/design/governance-review-2026-08-16.md): the ask branch of runPreToolUse logs its
// /invoke-time event as `denied` (no active grant) and then asks the harness's own permission
// prompt, which the hook can't see the answer to — only whether the tool actually ran. If it did,
// a human said yes, and this is PostToolUse's counterpart correction for that branch: instead of
// the ok/error transition PATCH /api/usage/:id handles, a `denied` event that was really approved
// moves to the dedicated `approved` outcome, and a matching row lands in the append-only
// `approvals` table (action 'consent') so "who approved this destructive call, and when" has an
// answer for the first time. Kept as its own endpoint rather than folded into PATCH so the general
// one-way ok->ok/error transition there doesn't have to grow a second, unrelated legal move.
app.post('/api/usage/:id/approve-consent', (req, res) => {
  const existing = store.findUsageEvent(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'usage event not found' });
  }
  const { principalId, correlationId } = req.body || {};
  if (!principalId || principalId !== existing.principalId) {
    return res.status(403).json({ error: "forbidden: principalId must match the event's own principal" });
  }
  if (existing.outcome !== 'denied') {
    return res.status(409).json({ error: `usage event is ${existing.outcome}, not denied — nothing to approve` });
  }
  const ageMs = Date.now() - new Date(existing.ts).getTime();
  if (!(ageMs >= 0) || ageMs > USAGE_CORRECTION_WINDOW_MS) {
    return res.status(409).json({ error: `usage event is outside the ${USAGE_CORRECTION_WINDOW_MS / 60000}-minute correction window` });
  }
  if (existing.correctedAt) {
    return res.status(409).json({ error: 'usage event has already been corrected once' });
  }

  const event = store.patchUsageEvent(req.params.id, {
    outcome: 'approved',
    correctedAt: new Date().toISOString(),
  });

  const approval = store.insertApproval({
    id: genId('appr'),
    action: 'consent',
    principalId: existing.principalId,
    capabilityId: existing.capabilityId,
    payload: { usageEventId: existing.id, correlationId: correlationId || existing.correlationId || null, decision: 'once' },
    requestedByScope: req.tokenScope,
    requestedAt: new Date().toISOString(),
  });
  // The harness's own ask prompt already got a "yes" out of the human before the tool (and
  // therefore PostToolUse, and therefore this call) could ever have run — so this record is
  // created already decided, not left pending for a second look.
  const decided = store.decideApproval(approval.id, {
    status: 'approved',
    decidedByScope: req.tokenScope,
    reason: 'approved via harness ask prompt',
  });

  res.json({ event, approval: decided });
});

// Admin diagnostic for the hash chain above — not on any hot path, just "has anything in the
// audit log been tampered with outside the app". Scoped requireAdmin like every other
// registry-inspection route that isn't part of the hook's own read/log/correct flow.
app.get('/api/usage/verify', requireAdmin, (req, res) => {
  res.json(store.verifyUsageEventChain());
});

app.get('/api/usage', (req, res) => {
  const { principalId, capabilityId } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
  let events = store.listUsageEvents(); // already newest-first (ORDER BY ts DESC)
  if (principalId) events = events.filter((e) => e.principalId === principalId);
  if (capabilityId) events = events.filter((e) => e.capabilityId === capabilityId);
  events = events.slice(0, limit);
  res.json(events);
});

app.get('/api/usage/summary', (req, res) => {
  const capabilities = store.listCapabilities();
  const principals = store.listPrincipals();

  // Graph controls: granularity picks the bucket width, windowMinutes how far back to look
  // (defaults per granularity, but a caller can pass any custom value — clamped so it can't
  // demand more than MAX_BUCKETS buckets).
  const granularity = ['minute', 'hour', 'day'].includes(req.query.granularity)
    ? req.query.granularity
    : 'day';
  const bucketMinutes = BUCKET_MINUTES[granularity];
  let windowMinutes = parseInt(req.query.windowMinutes, 10);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    windowMinutes = DEFAULT_WINDOW_MINUTES[granularity];
  }
  windowMinutes = Math.min(windowMinutes, bucketMinutes * MAX_BUCKETS);

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMinutes * 60000);

  let events = filterEventsByCapabilityProps(store.listUsageEvents(), capabilities, req.query);
  events = events.filter((e) => new Date(e.ts) >= windowStart);

  const calls = events.length;
  const denied = events.filter((e) => e.outcome === 'denied').length;
  const denialRate = calls === 0 ? 0 : denied / calls;
  const avgLatencyMs =
    calls === 0 ? 0 : Math.round(events.reduce((sum, e) => sum + e.latencyMs, 0) / calls);
  // Per-phase averages for bottleneck-hunting (docs/design/latency-breakdown.md) — each is null,
  // not 0, when no event in the window carries that phase (e.g. every call in range predates the
  // breakdown fields, or failed open before reaching that phase).
  const avgCapabilityLookupMs = avgOf(events, 'capabilityLookupMs');
  const avgPrincipalResolveMs = avgOf(events, 'principalResolveMs');
  const avgBrokerMs = avgOf(events, 'brokerMs');
  const avgGrantCheckMs = avgOf(events, 'grantCheckMs');

  const byCapabilityMap = new Map();
  for (const e of events) {
    if (!byCapabilityMap.has(e.capabilityId)) {
      byCapabilityMap.set(e.capabilityId, []);
    }
    byCapabilityMap.get(e.capabilityId).push(e);
  }
  const byCapability = [...byCapabilityMap.entries()].map(([capabilityId, evs]) => {
    const cap = capabilities.find((c) => c.id === capabilityId);
    const capCalls = evs.length;
    const capDenied = evs.filter((e) => e.outcome === 'denied').length;
    return {
      capabilityId,
      name: cap ? cap.name : capabilityId,
      calls: capCalls,
      denied: capDenied,
      avgLatencyMs: Math.round(evs.reduce((sum, e) => sum + e.latencyMs, 0) / capCalls),
    };
  });
  byCapability.sort((a, b) => b.calls - a.calls);

  // Group by *display name*, not principalId — a human with several agent instances (or an
  // instance plus its role) would otherwise show up as separate rows with the same human name.
  const byPrincipalMap = new Map();
  for (const e of events) {
    const principal = principals.find((p) => p.id === e.principalId);
    const name = principalDisplayName(principal, e.principalId);
    if (!byPrincipalMap.has(name)) {
      byPrincipalMap.set(name, { principalId: e.principalId, name, evs: [] });
    }
    byPrincipalMap.get(name).evs.push(e);
  }
  const byPrincipal = [...byPrincipalMap.values()].map(({ principalId, name, evs }) => ({
    principalId,
    name,
    calls: evs.length,
    denied: evs.filter((e) => e.outcome === 'denied').length,
  }));
  byPrincipal.sort((a, b) => b.calls - a.calls);

  const byBucket = [];
  const numBuckets = Math.ceil(windowMinutes / bucketMinutes);
  for (let i = numBuckets - 1; i >= 0; i--) {
    const bucketStart = new Date(now.getTime() - (i + 1) * bucketMinutes * 60000);
    const bucketEnd = new Date(now.getTime() - i * bucketMinutes * 60000);
    const bucketEvents = events.filter((e) => {
      const t = new Date(e.ts).getTime();
      return t >= bucketStart.getTime() && t < bucketEnd.getTime();
    });
    byBucket.push({
      bucket: bucketLabel(bucketStart, granularity),
      calls: bucketEvents.length,
      denied: bucketEvents.filter((e) => e.outcome === 'denied').length,
      // Total round-trip latency (tool + harness overhead) alongside the phase breakdown below, so
      // the chart can offer it as a selectable series — null, not 0, when the bucket is empty.
      avgLatencyMs: avgOf(bucketEvents, 'latencyMs'),
      // Per-phase averages within this bucket, for the latency-over-time chart — same null-vs-0
      // convention as the window totals above (docs/design/latency-breakdown.md).
      avgCapabilityLookupMs: avgOf(bucketEvents, 'capabilityLookupMs'),
      avgPrincipalResolveMs: avgOf(bucketEvents, 'principalResolveMs'),
      avgBrokerMs: avgOf(bucketEvents, 'brokerMs'),
      avgGrantCheckMs: avgOf(bucketEvents, 'grantCheckMs'),
    });
  }

  res.json({
    totals: {
      calls,
      denied,
      denialRate,
      avgLatencyMs,
      avgCapabilityLookupMs,
      avgPrincipalResolveMs,
      avgBrokerMs,
      avgGrantCheckMs,
    },
    byCapability,
    byPrincipal,
    byBucket,
    granularity,
    windowMinutes,
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

app.get('/api/drift', (req, res) => {
  const capabilities = store.listCapabilities();
  const principals = store.listPrincipals();
  const grants = store.listGrants();
  const usageEvents = store.listUsageEvents();

  const DRIFT_IDLE_DAYS = 90;
  const driftCutoff = Date.now() - DRIFT_IDLE_DAYS * 24 * 60 * 60 * 1000;

  const unusedGrants = grants
    .map((g) => {
      const lastUsedAt = usageEvents
        .filter((e) => e.principalId === g.principalId && e.capabilityId === g.capabilityId)
        .reduce((latest, e) => (!latest || e.ts > latest ? e.ts : latest), null);
      return { grant: g, lastUsedAt: lastUsedAt || g.createdAt };
    })
    .filter(({ lastUsedAt }) => new Date(lastUsedAt).getTime() <= driftCutoff)
    .map(({ grant: g, lastUsedAt }) => {
      const principal = principals.find((p) => p.id === g.principalId);
      const capability = capabilities.find((c) => c.id === g.capabilityId);
      return {
        grantId: g.id,
        principalName: principalDisplayName(principal, g.principalId),
        capabilityName: capability ? capability.name : g.capabilityId,
        grantedAt: g.createdAt,
        lastUsedAt,
      };
    });

  const byCapability = new Map();
  for (const e of usageEvents) {
    if (!byCapability.has(e.capabilityId)) {
      byCapability.set(e.capabilityId, []);
    }
    byCapability.get(e.capabilityId).push(e);
  }
  const highDenial = [...byCapability.entries()]
    .map(([capabilityId, evs]) => {
      const cap = capabilities.find((c) => c.id === capabilityId);
      const calls = evs.length;
      const denied = evs.filter((e) => e.outcome === 'denied').length;
      return {
        capabilityId,
        name: cap ? cap.name : capabilityId,
        denialRate: calls === 0 ? 0 : denied / calls,
        calls,
      };
    })
    .filter((c) => c.calls >= 5 && c.denialRate >= 0.2)
    .sort((a, b) => b.denialRate - a.denialRate);

  res.json({ unusedGrants, highDenial });
});

// ---------------------------------------------------------------------------
// Discovery — item 1 of docs/design/integration-todo.md
// ---------------------------------------------------------------------------

// Admin-scoped too (finding #9): discovery writes attacker-influenceable SKILL.md frontmatter
// straight into the registry, so triggering a run needs the same authority as any other registry
// mutation, not just any token holder.
app.post('/api/discovery/run', requireAdmin, (req, res) => {
  const db = store.load();
  const result = runDiscovery(db);
  store.save(db);
  // Discovery can register new capabilities/principals in bulk — warm both hook-side caches
  // immediately rather than leaving a batch of fresh registrations to trickle in via the timer.
  refreshCapabilityCache(store);
  refreshPrincipalCache(store);
  res.json(result);
});

app.get('/api/discovery/last', (req, res) => {
  const discovery = store.getDiscovery();
  if (!discovery) {
    return res.status(404).json({ error: 'discovery has not run yet' });
  }
  res.json(discovery);
});

// ---------------------------------------------------------------------------
// Discovery sources — manual configuration of the "capability sources" the discovery pass draws
// from: filesystem roots scan.js walks for SKILL.md files (kind 'skill_dir', the default) and
// custom MCP tool manifest files mcpManifest.js merges in alongside the built-in one (kind
// 'mcp_manifest') — see server/store.js's discovery_sources table. Read is open to any
// authenticated caller (the Sources page needs it to render); every mutation is admin-scoped,
// same as every other registry write.
// ---------------------------------------------------------------------------

app.get('/api/discovery/sources', (req, res) => {
  const sources = store.listDiscoverySources().map((s) => ({ ...s, exists: fs.existsSync(s.path) }));
  res.json(sources);
});

// Directory browser backing the "Browse…" picker on the Add-a-source form: sources are paths on
// *this* machine (the server this UI is served from is the same box discovery scans), so a
// browser-native file picker can't help — it never exposes an absolute filesystem path. This
// walks the server's own filesystem instead. No `path` query param means "show the roots"
// (drive letters on Windows, `/` elsewhere).
app.get('/api/discovery/browse', (req, res) => {
  const requested = typeof req.query.path === 'string' ? req.query.path : '';

  if (!requested.trim()) {
    if (process.platform === 'win32') {
      const drives = [];
      for (let code = 65; code <= 90; code++) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\`;
        if (fs.existsSync(root)) drives.push({ name: root, path: root });
      }
      return res.json({ path: '', parent: null, entries: drives });
    }
    return res.json({ path: '/', parent: null, entries: listSubdirectories('/') });
  }

  const target = path.resolve(requested);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return res.status(404).json({ error: 'path not found' });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'path is not a directory' });
  }

  const parentDir = path.dirname(target);
  // At a filesystem root, dirname(target) === target (e.g. "C:\\" or "/") — that's the signal to
  // stop, so the client shows drive letters / "/" instead of trying to go further up.
  const parent = parentDir === target ? null : parentDir;

  res.json({ path: target, parent, entries: listSubdirectories(target) });
});

function listSubdirectories(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => {
      // Follow symlinks/junctions (common for skill dirs shared via a link) but skip anything that
      // errors out (permission-denied entries under e.g. C:\Windows are common and shouldn't 500
      // the whole listing).
      try {
        return entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(dir, entry.name)).isDirectory());
      } catch {
        return false;
      }
    })
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

app.post('/api/discovery/sources', requireAdmin, (req, res) => {
  const { path: sourcePath, label, kind } = req.body || {};
  if (!sourcePath || typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  if (kind !== undefined && kind !== 'skill_dir' && kind !== 'mcp_manifest') {
    return res.status(400).json({ error: "kind must be 'skill_dir' or 'mcp_manifest'" });
  }
  const source = {
    id: genId('src'),
    path: sourcePath.trim(),
    label: label || null,
    kind: kind || 'skill_dir',
    enabled: true,
    builtIn: false,
    createdAt: new Date().toISOString(),
  };
  try {
    store.insertDiscoverySource(source);
  } catch (err) {
    if (err instanceof store.DiscoverySourceConflictError) {
      return res.status(409).json({ error: 'a discovery source for this path already exists' });
    }
    throw err;
  }
  res.status(201).json({ ...source, exists: fs.existsSync(source.path) });
});

app.patch('/api/discovery/sources/:id', requireAdmin, (req, res) => {
  if (!store.findDiscoverySourceById(req.params.id)) {
    return res.status(404).json({ error: 'discovery source not found' });
  }
  const { path: sourcePath, label, enabled } = req.body || {};
  const patch = {};
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      return res.status(400).json({ error: 'path must be a non-empty string' });
    }
    patch.path = sourcePath.trim();
  }
  if (label !== undefined) patch.label = label || null;
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  let updated;
  try {
    updated = store.updateDiscoverySource(req.params.id, patch);
  } catch (err) {
    if (err instanceof store.DiscoverySourceConflictError) {
      return res.status(409).json({ error: 'a discovery source for this path already exists' });
    }
    throw err;
  }
  res.json({ ...updated, exists: fs.existsSync(updated.path) });
});

app.delete('/api/discovery/sources/:id', requireAdmin, (req, res) => {
  if (!store.deleteDiscoverySource(req.params.id)) {
    return res.status(404).json({ error: 'discovery source not found' });
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Skills — centralized management of SKILL.md files across every provider's skill directory.
// Skills are catalog-only (docs/design/skill-mcp-governance.md §0: no grants, no usage tracking),
// so this is purely a write path onto server/skills.js's provider targets; GET /api/capabilities
// (filtered to kind==='skill') is still the read side, same list the Catalog page already uses.
// All mutating — a skill written here lands on disk across however many providers were selected,
// same authority level as any other registry-adjacent write.
// ---------------------------------------------------------------------------

app.get('/api/skills/targets', (req, res) => {
  res.json(skills.listWriteTargets());
});

app.get('/api/skills/:name/presence', (req, res) => {
  res.json(skills.presenceByTarget(req.params.name));
});

app.post('/api/skills', requireAdmin, (req, res) => {
  const { name, description, targetIds } = req.body || {};
  let result;
  try {
    result = skills.createSkill({ name, description, targetIds });
  } catch (err) {
    if (err instanceof skills.InvalidSkillError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (result.written.length === 0) {
    return res.status(500).json({ error: 'could not write SKILL.md to any selected provider' });
  }
  // Register it in the catalog immediately, same as any other discovery pass, rather than making
  // the admin remember to click "Run discovery" after adding a skill here.
  const db = store.load();
  const discoveryResult = runDiscovery(db);
  store.save(db);
  refreshCapabilityCache(store);
  res.status(201).json({ ...result, discovery: discoveryResult });
});

app.delete('/api/skills/:name', requireAdmin, (req, res) => {
  const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : undefined;
  const result = skills.removeSkill({ name: req.params.name, targetIds });
  // Files are gone; re-run discovery so a skill removed from every provider goes stale on the next
  // scan the same way any other vanished SKILL.md would (server/discovery/merge.js), rather than
  // leaving a ghost row that still claims to be fresh.
  const db = store.load();
  const discoveryResult = runDiscovery(db);
  store.save(db);
  refreshCapabilityCache(store);
  res.json({ ...result, discovery: discoveryResult });
});

// ---------------------------------------------------------------------------
// Providers — discover/install the PreToolUse/PostToolUse hook wiring for each backend adapter
// (server/providers.js). Read is open to any authenticated caller (the Providers page needs it to
// render); install/uninstall write straight into a backend's own hook-config file on disk, so
// they're admin-scoped same as every other registry-adjacent mutation.
// ---------------------------------------------------------------------------

app.get('/api/providers', (req, res) => {
  res.json(listProviders());
});

// Read-only view of server/hookWatcher.js's poller state — when it last saw a backend's
// PreToolUse/PostToolUse wiring go missing from its own config file and whether it put it back.
// Same auth posture as GET /api/providers: any authenticated caller can read it, only mutating
// routes are admin-scoped.
app.get('/api/hook-integrity', (req, res) => {
  res.json(store.getHookIntegrity());
});

app.post('/api/providers/:id/install', requireAdmin, (req, res) => {
  let status;
  try {
    status = installProvider(req.params.id);
  } catch (err) {
    if (err instanceof ProviderNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ProviderUnsupportedError) return res.status(400).json({ error: err.message });
    throw err;
  }
  // Installing a provider's hooks and enabling its package are the same decision from the human's
  // side ("use this backend") — a provider package's id matches its adapter id 1:1
  // (server/packages.js), so this is what used to be a separate "enable, then remember to hit
  // sync" step on the old Provider packages section. findPackage guards the (currently
  // hypothetical) case of a provider adapter with no matching package defined yet.
  if (packages.findPackage(req.params.id)) {
    packages.setEnabled(req.params.id, true);
    packages.syncPackage(req.params.id);
  }
  res.json(status);
});

app.post('/api/providers/:id/uninstall', requireAdmin, (req, res) => {
  let status;
  try {
    status = uninstallProvider(req.params.id);
  } catch (err) {
    if (err instanceof ProviderNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ProviderUnsupportedError) return res.status(400).json({ error: err.message });
    throw err;
  }
  // Mirrors enable's "stops future auto-grants, doesn't revoke what's already granted" — same as
  // disabling any other package (POST /api/packages/:id/disable).
  if (packages.findPackage(req.params.id)) {
    packages.setEnabled(req.params.id, false);
  }
  res.json(status);
});

// ---------------------------------------------------------------------------
// Packages — docs/design/capability-packages.md. Bundles capabilities by owner (provider or
// integration) behind one enabled flag and a default grant policy, so a fresh server — or a new
// capability discovered under an already-enabled owner — gets sane defaults without a hand-edited
// addGrants() call. Sits alongside Providers (which installs the hook wiring a provider package
// needs); this endpoint answers "what does turning it on actually grant," Providers answers "is it
// even wired up."
// ---------------------------------------------------------------------------

app.get('/api/packages', (req, res) => {
  res.json(packages.listPackagesWithStatus());
});

app.post('/api/packages/:id/enable', requireAdmin, (req, res) => {
  if (!packages.findPackage(req.params.id)) {
    return res.status(404).json({ error: 'package not found' });
  }
  packages.setEnabled(req.params.id, true);
  const sync = packages.syncPackage(req.params.id);
  res.json({ package: packages.listPackagesWithStatus().find((p) => p.id === req.params.id), sync });
});

app.post('/api/packages/:id/disable', requireAdmin, (req, res) => {
  if (!packages.findPackage(req.params.id)) {
    return res.status(404).json({ error: 'package not found' });
  }
  // Disabling only stops *future* auto-grants (sync no longer runs it) — it does not revoke grants
  // already issued. Same reasoning as a discovery source being disabled: turning a switch off
  // shouldn't retroactively undo work an agent is mid-flight relying on.
  packages.setEnabled(req.params.id, false);
  res.json({ package: packages.listPackagesWithStatus().find((p) => p.id === req.params.id) });
});

app.post('/api/packages/:id/sync', requireAdmin, (req, res) => {
  if (!packages.findPackage(req.params.id)) {
    return res.status(404).json({ error: 'package not found' });
  }
  const sync = packages.syncPackage(req.params.id);
  res.json({ package: packages.listPackagesWithStatus().find((p) => p.id === req.params.id), sync });
});

app.post('/api/packages/:id/revoke', requireAdmin, (req, res) => {
  if (!packages.findPackage(req.params.id)) {
    return res.status(404).json({ error: 'package not found' });
  }
  // The explicit teardown /disable deliberately doesn't do — deletes every grant this package's
  // roles hold on capabilities it owns, whether policy-issued or added by hand. Doesn't touch the
  // enabled flag; call disable too if the intent is also "stop auto-granting going forward".
  const revoke = packages.revokePackage(req.params.id);
  res.json({ package: packages.listPackagesWithStatus().find((p) => p.id === req.params.id), revoke });
});

// ---------------------------------------------------------------------------
// Rollup — cross-workspace and standalone usage, docs/design/cross-field-and-standalone.md
// ---------------------------------------------------------------------------

app.get('/api/rollup/fields', (req, res) => {
  res.json(rollup.listFields());
});

app.get('/api/rollup/summary', (req, res) => {
  res.json(rollup.summary());
});

module.exports = app;
