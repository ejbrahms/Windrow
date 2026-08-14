const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { genId } = require('./id');
const store = require('./store');
const { requireAuth, requireAdmin } = require('./auth');
const { runDiscovery } = require('./discovery');
const { listProviders, installProvider, uninstallProvider, NotFoundError: ProviderNotFoundError, UnsupportedError: ProviderUnsupportedError } = require('./providers');
const rollup = require('./rollup');
const { refreshCapabilityCache, refreshPrincipalCache } = require('./cacheWarmer');

const RISK_TIERS = ['read_only', 'mutating', 'destructive'];

// Capability owners that are exempt from the grant system entirely: they're how a loom drives
// Wispfield itself (spawning/dispatching/reporting), not a third-party tool a human is choosing
// to expose — gating them behind a grant nobody has issued yet would just break the field, and
// there's no meaningful "revoke" case for a loom's own control surface. Every principal can
// always call them; see findActiveGrant below and GrantsPage.tsx, which hides them from the
// grant/revoke UI for the same reason (they're not something a human curates per-principal).
const AUTO_GRANT_OWNERS = new Set(['wispfield']);

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

// Instance principals mapped from a real Wispfield loom carry the human's actual name
// (server/principals/) — prefer that over the loom/role name, which is otherwise the only
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
  const { capabilityKind, riskTier, capabilityOwner, capabilitySource, excludeCapabilityOwner } = query;
  if (!capabilityKind && !riskTier && !capabilityOwner && !capabilitySource && !excludeCapabilityOwner) {
    return events;
  }
  const matchingIds = new Set(
    capabilities
      .filter(
        (c) =>
          (!capabilityKind || c.kind === capabilityKind) &&
          (!riskTier || c.riskTier === riskTier) &&
          (!capabilityOwner || c.owner === capabilityOwner) &&
          (!capabilitySource || c.source === capabilitySource) &&
          (!excludeCapabilityOwner || c.owner !== excludeCapabilityOwner)
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
 * AUTO_GRANT_OWNERS capabilities (Wispfield's own MCP tools) skip grant lookup entirely and
 * return a synthetic always-active grant — every principal can call them, unconditionally.
 */
function findActiveGrant(principal, capability, now) {
  if (capability && AUTO_GRANT_OWNERS.has(capability.owner)) {
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
  res.json(sortByName(store.listCapabilities()));
});

// Registry-mutating routes are admin-scoped only (docs/design/governance-vulnerability-review.md
// finding #1): the agent token every hook process carries can resolve capabilities and log
// invocations, but cannot register/retier a capability, create a principal, or issue/revoke a
// grant — closing the self-grant path where any tool call that could read the (formerly single)
// token off disk could escalate itself to anything, including destructive tiers.
app.post('/api/capabilities', requireAdmin, (req, res) => {
  const { kind, name, owner, riskTier, description } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!RISK_TIERS.includes(riskTier)) {
    return res.status(400).json({ error: `riskTier must be one of ${RISK_TIERS.join(', ')}` });
  }
  const capability = {
    id: genId('cap'),
    kind: kind || null,
    name,
    owner: owner || null,
    riskTier,
    description: description || null,
  };
  store.insertCapability(capability);
  // Push the new/changed capability into the hook-side cache immediately (see cacheWarmer.js)
  // instead of leaving the next hook call to either miss (a fresh loom's first invocation of
  // this capability) or wait out the warm timer.
  refreshCapabilityCache(store);
  res.status(201).json(capability);
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
  // Policy: a new principal's starting grants come from its parent. An instance principal
  // (parentRole set) inherits every grant already held by its parent role principal — mutating/
  // destructive included, not just read-only. A role principal has no parent to inherit from, so
  // it falls back to every read_only capability, the same baseline every role starts with.
  // Mirrors principals/registry.js's grantInherited for the load()/save() snapshot path.
  const parentRolePrincipal = principal.parentRole
    ? store.findPrincipalByKindName('role', principal.parentRole)
    : null;
  const sourceCapIds = parentRolePrincipal
    ? store.listGrants({ principalId: parentRolePrincipal.id }).map((g) => g.capabilityId)
    : store.listCapabilities().filter((c) => c.riskTier === 'read_only').map((c) => c.id);
  for (const capId of sourceCapIds) {
    store.insertGrant({
      id: genId('gr'),
      principalId: principal.id,
      capabilityId: capId,
      constraints: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    });
  }
  refreshPrincipalCache(store);
  res.status(201).json(principal);
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

app.get('/api/grants', (req, res) => {
  const { principalId, capabilityId } = req.query;
  res.json(store.listGrants({ principalId, capabilityId }));
});

app.post('/api/grants', requireAdmin, (req, res) => {
  const { principalId, capabilityId, constraints, expiresAt } = req.body || {};
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
  // The grants table's UNIQUE(principalId, capabilityId) constraint — not a pre-check against a
  // snapshot that could go stale between the check and the write — is what makes this race-safe.
  try {
    store.insertGrant(grant);
  } catch (err) {
    if (err instanceof store.GrantConflictError) {
      return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
    }
    throw err;
  }
  res.status(201).json(grant);
});

app.delete('/api/grants/:id', requireAdmin, (req, res) => {
  if (!store.deleteGrant(req.params.id)) {
    return res.status(404).json({ error: 'grant not found' });
  }
  res.status(204).end();
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
  store.insertUsageEvent(event);

  res.json({ allowed, event });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// PostToolUse hook correction: /invoke logs an event at grant-check time with simulated latency
// (no real tool ran yet behind it). Once the real tool call finishes, the hook PATCHes the same
// event with the actual outcome (ok/error, from what the tool returned) and real latency.
app.patch('/api/usage/:id', (req, res) => {
  const existing = store.findUsageEvent(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'usage event not found' });
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
  const event = store.patchUsageEvent(req.params.id, patch);
  res.json(event);
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

  // Group by *display name*, not principalId — a human with several loom instances (or an
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
// Discovery sources — manual configuration of the filesystem roots scan.js scans (this is the
// "capability sources" the discovery pass draws from; see server/discovery/scan.js and
// server/store.js's discovery_sources table). Read is open to any authenticated caller (the Sources
// page needs it to render); every mutation is admin-scoped, same as every other registry write.
// ---------------------------------------------------------------------------

app.get('/api/discovery/sources', (req, res) => {
  const sources = store.listDiscoverySources().map((s) => ({ ...s, exists: fs.existsSync(s.path) }));
  res.json(sources);
});

app.post('/api/discovery/sources', requireAdmin, (req, res) => {
  const { path: sourcePath, label } = req.body || {};
  if (!sourcePath || typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const source = {
    id: genId('src'),
    path: sourcePath.trim(),
    label: label || null,
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
// Providers — discover/install the PreToolUse/PostToolUse hook wiring for each backend adapter
// (server/providers.js). Read is open to any authenticated caller (the Providers page needs it to
// render); install/uninstall write straight into a backend's own hook-config file on disk, so
// they're admin-scoped same as every other registry-adjacent mutation.
// ---------------------------------------------------------------------------

app.get('/api/providers', (req, res) => {
  res.json(listProviders());
});

app.post('/api/providers/:id/install', requireAdmin, (req, res) => {
  try {
    res.json(installProvider(req.params.id));
  } catch (err) {
    if (err instanceof ProviderNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ProviderUnsupportedError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.post('/api/providers/:id/uninstall', requireAdmin, (req, res) => {
  try {
    res.json(uninstallProvider(req.params.id));
  } catch (err) {
    if (err instanceof ProviderNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ProviderUnsupportedError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Rollup — cross-field and standalone usage, docs/design/cross-field-and-standalone.md
// ---------------------------------------------------------------------------

app.get('/api/rollup/fields', (req, res) => {
  res.json(rollup.listFields());
});

app.get('/api/rollup/summary', (req, res) => {
  res.json(rollup.summary());
});

module.exports = app;
