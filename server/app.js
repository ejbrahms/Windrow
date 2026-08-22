const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { genId } = require('./id');
const store = require('./store');
// The policyStore (read) / usageSink (write) seam — docs/design/global-identity-and-central-db.md
// §2.7 phase 2. Routes below go through these two objects for anything that is policy or usage;
// the direct `store` handle above survives only for node-local state (discovery sources, hook
// integrity) and for the load()/save() pair phase 0 is meant to delete. See server/policy/index.js.
const { policyStore, usageSink } = require('./policy');
const { requireAuth, requireAdmin, requireProposer } = require('./auth');
const { beginGrace, endGrace, readGraceLease } = require('./maintenance');
const {
  beginEnforcementPause,
  endEnforcementPause,
  readEnforcementPause,
  pauseRemainingMs,
  describePause,
} = require('./enforcementPause');
const {
  createEnrollmentRouter, createEnrollmentAdminRouter, ensureBootstrapToken,
} = require('./enrollment/routes');
const { createPolicyRouter } = require('./policy/routes');
const { policyClientStatus } = require('./policy/policyClient');
const { resolvePolicyAuthority, CENTRAL } = require('./policy/authority');

const STARTED_AT = new Date().toISOString();
/**
 * The hook-facing route contract, bumped whenever a route server/hooks/lib.js calls is added,
 * removed or changes shape. `scripts/upgrade.js` asserts on this after a restart, so a server
 * that came up healthy but *older than the hooks expect* is caught by the upgrade rather than by
 * the field going fail-closed (the 2026-08-19 failure mode).
 */
const HOOK_CONTRACT = {
  version: 1,
  routes: ['/api/capabilities', '/api/principals/resolve', '/api/invoke', '/api/usage/:id'],
};
const { runDiscovery } = require('./discovery');
// Which capability `source` values discovery owns. Imported rather than re-listed so "what counts
// as a discovered row" has one definition — the replica path below skips everything else, and a
// second copy of the set would quietly start proposing hand-registered capabilities to central.
const { DISCOVERED_SOURCES } = require('./discovery/merge');
const { listProviders, installProvider, uninstallProvider, NotFoundError: ProviderNotFoundError, UnsupportedError: ProviderUnsupportedError } = require('./providers');
const packages = require('./packages');
const rollup = require('./rollup');
const skills = require('./skills');
const { refreshCapabilityCache, refreshPrincipalCache } = require('./cacheWarmer');
const { nodeAlertStats } = require('./alerts/nodeEngine');
const { currentOsUser, currentHostname } = require('./principals/fromEnv');
const { principalRoleName, principalDisplayName } = require('./principals/registry');
const { isAssuranceLevel, ASSURANCE_ENV_DERIVED } = require('./principals/subject');
const { EVENT_FIELDS, WRITER_ASSIGNED } = require('./ingest/usageEvent');
const { envCompat } = require('./config');

// Actor identity attached to every windrow_audit row: admin/proposer requests all come from a
// local process (the dashboard, an admin
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
// This replaces the old owner-string AUTO_GRANT_OWNERS set, which bypassed *every* capability
// owned by 'wispfield', destructive tools
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
  const direct = policyStore.findGrant(principal.id, capability.id);
  if (direct && isGrantActive(direct, now)) return direct;
  if (principal.kind === 'instance' && principal.parentRole) {
    const rolePrincipal = policyStore.findPrincipalByKindName('role', principal.parentRole);
    if (rolePrincipal) {
      const roleGrant = policyStore.findGrant(rolePrincipal.id, capability.id);
      if (roleGrant && isGrantActive(roleGrant, now)) return roleGrant;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shadow evaluation (docs/design/global-identity-and-central-db.md §1.6 phase 3, want-mszgwlsi-20)
// ---------------------------------------------------------------------------
//
// findActiveGrant above is the LIVE decision and stays the only one that is enforced. Everything
// below computes, for the same call, what the decision would have been under §1.7's model — where
// the *user* (the subject principal, keyed on `subjectId`) says what a person may do and the role
// says what an agent shape may do — writes both onto the usage event, and shouts when they differ.
// Nothing here can allow or deny anything. The point is to arrive at phase 5 with a measured
// answer to "how many calls would flipping the key have broken", instead of an estimate.
//
// Off with WINDROW_SHADOW_EVAL=0. Default on: it is two indexed lookups, it runs after the
// response has already gone out (see /api/invoke), and a shadow mode nobody enabled measures
// nothing.
const SHADOW_EVAL_ENABLED = envCompat('SHADOW_EVAL') !== '0';

/**
 * The decision that was actually ENFORCED for an event, recovered from its outcome.
 *
 * `usage_events.outcome` starts as the decision ('ok'/'denied') and is then overwritten with what
 * happened next: PostToolUse PATCHes 'ok' -> 'error' when the tool failed, and the ask-consent path
 * moves 'denied' -> 'approved' when the human said yes to the harness prompt. So comparing
 * `outcome` to `shadowOutcome` as strings misreads both corrections as divergence — a failed but
 * fully-granted call, and a denied call a human approved, are exactly the events most likely to be
 * looked at. This mapping is total over the vocabulary and stable under both corrections.
 */
function enforcedDecision(outcome) {
  return outcome === 'denied' || outcome === 'approved' ? 'deny' : 'allow';
}

/**
 * The user-keyed decision for one call: **the intersection of what the person may do and what this
 * agent shape may do** (§1.7 — "an agent can never exceed its operator"). Returns
 * `{ outcome, reason, principalId }` where outcome is 'allow' | 'deny' | 'unevaluated', and
 * `principalId` is the subject principal the decision resolved through (null if it never got one).
 *
 * 'unevaluated' is a third answer on purpose, distinct from 'deny'. A call that carried no subject
 * key never had a user-keyed decision to make, and counting it as a denial would manufacture
 * divergence out of an old hook build — which is precisely the number this exists to measure
 * honestly. A subject key that resolves to no principal row *is* a real 'deny': that is what the
 * flip would do to it today.
 *
 * §1.7's open question (want-mszgwq5d-24: union vs most-restrictive, and whether negative grants
 * exist) is settled here as most-restrictive, because that is the model §1.7 states and because a
 * shadow that answers the *stricter* question is the safe direction to be wrong in — it over-
 * reports the calls a flip would break rather than under-reporting them.
 */
function evaluateUserKeyedGrant({ subjectId, actorAgentType, principal, capability, now }) {
  if (!SHADOW_EVAL_ENABLED) {
    return { outcome: 'unevaluated', reason: 'shadow evaluation disabled (WINDROW_SHADOW_EVAL=0)', principalId: null };
  }
  if (!subjectId) {
    return { outcome: 'unevaluated', reason: 'call carried no subject key', principalId: null };
  }

  // Capability-scoped and principal-independent, so it is the same answer in both models. Checked
  // before the subject lookup for the same reason findActiveGrant checks it first: an auto-granted
  // capability never consults a principal at all, and pretending otherwise would report a
  // divergence on every platform call made by a machine whose subject row doesn't exist yet.
  if (capability && capability.autoGrant) {
    return { outcome: 'allow', reason: 'capability is auto-granted', principalId: null };
  }

  const subject = policyStore.findPrincipalBySubjectId(subjectId);
  if (!subject) {
    return { outcome: 'deny', reason: `no user principal for subject ${subjectId}`, principalId: null };
  }

  const userGrant = policyStore.findGrant(subject.id, capability.id);
  const userAllows = Boolean(userGrant && isGrantActive(userGrant, now));

  // The role leg. `actorAgentType` is what the hook observed for *this call*; the live path
  // resolves through the instance row's registered `parentRole` instead, and the two can disagree
  // (that's the identity drift /principals/resolve logs). Prefer the observed value — it is the
  // agent shape that actually made the call, which is what §1.7's ceiling is about — and fall back
  // to the registered parentRole so a call from an older hook that forwards no agentType is
  // measured against the same role the live decision used, rather than reading as a phantom deny.
  const roleName = actorAgentType || (principal && principal.parentRole) || null;
  let roleAllows = false;
  let roleNote;
  if (!roleName) {
    roleNote = 'no agent shape recorded for this call';
  } else {
    const rolePrincipal = policyStore.findPrincipalByKindName('role', roleName);
    if (!rolePrincipal) {
      roleNote = `no role principal "${roleName}"`;
    } else {
      const roleGrant = policyStore.findGrant(rolePrincipal.id, capability.id);
      roleAllows = Boolean(roleGrant && isGrantActive(roleGrant, now));
      if (!roleAllows) roleNote = `role "${roleName}" has no active grant`;
    }
  }

  if (userAllows && roleAllows) {
    return { outcome: 'allow', reason: `user "${subject.name}" and role "${roleName}" both grant it`, principalId: subject.id };
  }
  // Name the leg that failed, and both when both did — "denied" on its own tells whoever reads the
  // divergence nothing about which grant they would have to create to make it go away.
  const legs = [];
  if (!userAllows) legs.push(`user "${subject.name}" has no active grant`);
  if (!roleAllows) legs.push(roleNote || `role "${roleName}" has no active grant`);
  return { outcome: 'deny', reason: legs.join('; '), principalId: subject.id };
}

// WHO OWNS POLICY ON THIS NODE (docs/design/global-identity-and-central-db.md §2.7 phase 4).
// Resolved once, at require time, because every route below branches on it and a value that could
// change mid-process would mean two requests in the same second enforcing under different rules.
// server/index.js binds the matching adapter and locks the store; this file only needs to know
// which world it is in, for three things: whether to serve its own policy channel, what to tell a
// caller when a write cannot reach the authority, and what to stamp on a decision.
const { authority: policyAuthority, centralUrl, error: authorityError } = resolvePolicyAuthority();
if (authorityError) console.error('[policy-authority]', authorityError);

const app = express();

// EVERY ASYNC HANDLER'S REJECTION BECOMES A RESPONSE.
//
// Phase 4 made the policy-mutating routes `async` — a write on a replica node is an HTTPS call to
// central, and there is no synchronous HTTP in Node. Express 4 does not await a handler, so a
// rejected promise is not a 500: it is an unhandled rejection and a request that never answers,
// which a caller experiences as a hang and an operator as nothing at all. That failure mode did not
// exist while every one of these was synchronous, so it arrives with this phase and is closed here
// rather than route by route — a route added later gets the same treatment without anyone
// remembering to ask for it.
for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
  const original = app[method].bind(app);
  app[method] = (...args) => original(...args.map((arg) => {
    if (typeof arg !== 'function' || arg.length > 3) return arg; // not a handler, or an error handler
    return (req, res, next) => {
      let out;
      try {
        out = arg(req, res, next);
      } catch (err) {
        return next(err);
      }
      // Only a thenable is chained, so a synchronous handler is untouched and pays nothing.
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    };
  }));
}

/**
 * Answer a policy write that the authority refused or could not be reached for.
 *
 * The distinction it draws is the one phase 4 introduces: before, a failed policy write meant a
 * SQLite error and something was badly wrong locally. Now it also means "central said no" (which
 * carries a status worth passing through) or "central is unreachable" (503, not 500 — the request
 * was fine, the authority is not). Getting that wrong would have an admin debugging their own JSON
 * while the real problem is a VPN.
 */
function sendPolicyError(res, err) {
  if (err && err.status && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  if (policyAuthority === CENTRAL && (!err || !err.status)) {
    return res.status(503).json({
      error: `central (${centralUrl}) owns policy on this node and could not be reached: ${err ? err.message : 'unknown error'}`,
      detail: 'this node keeps enforcing from its replica; no policy change was made anywhere',
    });
  }
  console.error('[policy] write failed:', (err && err.stack) || err);
  return res.status(500).json({ error: (err && err.message) || 'policy write failed' });
}
app.use(cors({ origin: 'http://localhost:5173' })); // still needed for `vite dev` (port 5173); a
// same-origin production build below never triggers CORS at all.
app.use(express.json());

// Serve the built client so backend and frontend ship and run as one process instead of two things
// that have to be started, restarted, and kept alive independently of each other. Static assets and
// the SPA shell are public and carry no credential of any kind: the bundle stopped embedding a
// bearer token when callers moved to per-node client certificates
// (docs/design/per-node-enrollment-credentials.md, "The client build no longer carries a
// credential"), because under mTLS identity rides the handshake and the browser needs to hold
// nothing. Only `/api/*` is gated, so this is registered before `requireAuth` below.
//
// WHICH LISTENER YOU LOADED THIS FROM DECIDES WHETHER IT WORKS. This app is served on both, and
// only the mTLS one can authenticate a dashboard: the plaintext listener grants `agent` scope by
// bearer token, for hooks (see server/auth.js), and a browser holds no such token. So the shell
// loads over plaintext and every `/api/*` call it makes returns 401 — the SPA renders with no data
// rather than failing to render. Keeping the shell public on both listeners is still right, since
// the alternative is a 401 on the HTML itself and no way to read the error; but it is the reason
// scripts/start.js has to name the mTLS address explicitly rather than print the port it binds.
/**
 * Readiness (docs/design/upgrade-resilience.md §3.4). Deliberately public and registered ahead of
 * `requireAuth`, for the same reason the SPA shell is: an upgrade script has to be able to ask
 * "are you back?" without holding a token, and a 401 is not a useful answer to that question.
 *
 * It reports the *build*, not just liveness — the 2026-08-19 outage was a server that answered
 * every request perfectly while missing the route the hooks needed, so "is the socket open" is
 * precisely the check that would have passed and told us nothing.
 */
app.get('/api/ready', (req, res) => {
  res.json({
    ready: true,
    pid: process.pid,
    startedAt: STARTED_AT,
    // The routes a hook depends on. An upgrade script compares this against what it expects
    // rather than trusting a 200.
    contract: HOOK_CONTRACT,
  });
});

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(CLIENT_DIST));
// SPA fallback: any other GET that isn't `/api/*` is a client-side route (react-router) — hand it
// index.html so the client can take over routing. Must stay ahead of `requireAuth` too, or a
// fresh page load on e.g. `/fleet` would 401 on the HTML shell itself.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

// Enrollment is mounted BEFORE `requireAuth`, and has to be: a caller enrolling does not have a
// credential yet — obtaining one is the entire point of the route. What authorises it instead is a
// single-use enrollment token an admin minted, checked inside the router
// (docs/design/per-node-enrollment-credentials.md). `GET /api/enroll/ca` is likewise public, because
// a client needs the CA certificate in order to *verify this server*, and it is a public key.
app.use(createEnrollmentRouter(store));
// First run has no admin who could mint that first token, so write one where only the installing
// user can read it. Idempotent: it does nothing once an admin node exists.
// Async since docs/design/setup-after-central.md §2 put the same router in front of central's
// Postgres store; against this synchronous SQLite one every `await` inside it resolves on the next
// microtask, so the token is written a tick after boot rather than during it. Nothing waits on it —
// it is a file an operator reads — but the rejection has to be handled or a first run with an
// unwritable data directory would take the process down instead of logging.
ensureBootstrapToken(store).catch((err) => {
  console.error('[enroll] could not mint the bootstrap enrollment token:', err.message);
});

// CORS above only restricts *browser* origins — it does nothing against a same-machine process
// (curl, another local tool) calling the API directly, which is exactly how "anything on
// localhost can self-grant" happened. Past this point every request carries an identity: an
// enrolled client certificate on the mTLS listener, or the loopback-only agent token a hook uses
// (server/auth.js explains why hooks are the one exemption).
app.use(requireAuth);

// Managing enrollment — minting and revoking tokens, listing and revoking nodes — is admin-only.
// The guard is passed in rather than imported by the router, which avoids a require cycle between
// auth.js and the store, and is applied per route rather than across the mount so it cannot gate
// unrelated endpoints that happen to come after it.
app.use(createEnrollmentAdminRouter(store, requireAdmin));

// The policy distribution channel (docs/design/global-identity-and-central-db.md §2.4). Mounted
// AFTER requireAuth: a node pulling policy has already enrolled and presents its client
// certificate, so unlike enrollment there is nothing to bootstrap here. Serving the full grant and
// principal set — which is what a delta is — to an unauthenticated caller would hand the whole
// registry to anything that could reach the port.
// NOT MOUNTED ON A REPLICA NODE. Under central authority the node's own `policy_changes` log stops
// being a history of anything — nothing writes to it, because nothing may write policy here — so
// serving deltas from it would hand a caller a version number that means something entirely
// different from central's. Two authorities answering the same route with the same field names and
// incompatible values is worse than one of them 404ing.
if (policyAuthority !== CENTRAL) app.use(createPolicyRouter(store));

// What this node's own policy channel is doing, for the dashboard and for an operator asking why a
// call failed closed. Reads no policy — only the client's state — so it is safe for any
// authenticated caller and answers on a node that is failing to pull, which is when it is asked.
app.get('/api/policy/status', (req, res) => {
  res.json(policyClientStatus());
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

app.get('/api/capabilities', (req, res) => {
  // `autoGranted` mirrors the stored `autoGrant` column under the name the client already reads —
  // a client that hides or disables toggling for these needs to know which ones, and findActiveGrant
  // (above) is what actually decides it, so this is just relaying that flag, not a second source of truth.
  const withAutoGranted = sortByName(policyStore.listCapabilities()).map((c) => ({
    ...c,
    autoGranted: c.autoGrant,
  }));
  res.json(withAutoGranted);
});

// Registry-mutating routes are admin-scoped only. The agent token every hook process carries can
// resolve capabilities and log
// invocations, but cannot register/retier a capability, create a principal, or issue/revoke a
// grant — closing the self-grant path where any tool call that could read the (formerly single)
// token off disk could escalate itself to anything, including destructive tiers.
/**
 * Maintenance grace lease (docs/design/upgrade-resilience.md §3.2). Admin-only, and only ever
 * mintable *here* — by a server that is up and serving. That timing is the security property: an
 * attacker who takes the API down to force a fail-open cannot sign a lease, because signing
 * requires the thing they just killed. Hooks read the lease off disk and only ever consult it on a
 * fault.
 */
app.post('/api/maintenance/grace', requireAdmin, (req, res) => {
  const { durationMs, reason, tolerate } = req.body || {};
  try {
    const lease = beginGrace({ durationMs, reason, tolerate });
    console.warn(
      `[maintenance] grace lease ${lease.id} issued until ${new Date(lease.until).toISOString()} ` +
        `for [${lease.tolerate.join(', ')}] — "${lease.reason}"`
    );
    res.status(201).json(lease);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/maintenance/grace', requireAuth, (req, res) => {
  res.json(readGraceLease() || null);
});

app.delete('/api/maintenance/grace', requireAdmin, (req, res) => {
  const had = endGrace();
  console.warn(`[maintenance] grace lease revoked${had ? '' : ' (none was in force)'}`);
  res.json({ revoked: had });
});

/**
 * THE ENFORCEMENT PAUSE — "turn off denials for X minutes" (server/enforcementPause.js).
 *
 * Admin-only for the reason every route in this block is: the agent token a hook carries must not
 * be able to switch off the thing checking it, or any governed call becomes a way to stop being
 * governed. Mintable only here, by a server that is up — the same timing property as the grace
 * lease above, and the reason there is no offline path that writes one.
 *
 * Unlike the lease, this one overrides real decisions, so it is logged at `error` level rather than
 * `warn`: opening it and closing it are the two lines an operator should be able to find in a log
 * without knowing what they are looking for.
 */
app.post('/api/enforcement/pause', requireAdmin, (req, res) => {
  const { durationMs, duration, reason, tolerate } = req.body || {};
  try {
    const pause = beginEnforcementPause({
      durationMs: durationMs === undefined ? duration : durationMs,
      reason,
      tolerate,
      // The enrolled node id off the client certificate (server/auth.js) — WHICH admin machine
      // opened the window, recorded on the pause so the fault-journal rows it produces trace back
      // to a person rather than to "an admin".
      issuedBy: req.nodeId || null,
    });
    console.error(`[enforcement] ${describePause(pause)}`);
    res.status(201).json(pause);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/enforcement/pause', requireAuth, (req, res) => {
  const pause = readEnforcementPause();
  res.json(pause ? { ...pause, remainingMs: pauseRemainingMs(pause) } : null);
});

app.delete('/api/enforcement/pause', requireAdmin, (req, res) => {
  const had = endEnforcementPause();
  console.error(
    `[enforcement] pause ended early — denials are being enforced again${had ? '' : ' (none was in force)'}`
  );
  res.json({ resumed: had });
});

app.post('/api/capabilities', requireAdmin, async (req, res) => {
  const { kind, name, owner, riskTier, description, autoGrant } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!RISK_TIERS.includes(riskTier)) {
    return res.status(400).json({ error: `riskTier must be one of ${RISK_TIERS.join(', ')}` });
  }
  // autoGrant bypasses the grant table entirely (findActiveGrant, above) — never on a
  // destructive row, checked here as well as on the PATCH below so it can't be set either way it
  // could be reached.
  if (autoGrant && riskTier === 'destructive') {
    return res.status(400).json({ error: 'destructive capabilities cannot be auto-granted' });
  }
  // NO id IS MINTED HERE any more. docs/design/global-identity-and-central-db.md §2.2 phase 4:
  // "central owns the canonical capability row and its id". Whichever adapter is bound behind the
  // seam decides it — locally on a standalone install, centrally on a replica node — and the row
  // that comes back is the authoritative one. A route that kept its own copy would, on a replica
  // node, be answering with an id central never issued.
  let capability;
  // capabilities has a UNIQUE(kind, name) constraint (finding #10) — not a pre-check against a
  // snapshot that could go stale between the check and the write — so a registration race can't
  // leave two rows for the same (kind, name) pair with resolution order deciding which one governs.
  try {
    capability = await policyStore.insertCapability({
      kind: kind || null,
      name,
      owner: owner || null,
      riskTier,
      description: description || null,
      autoGrant: !!autoGrant,
    });
  } catch (err) {
    if (err instanceof policyStore.CapabilityConflictError) {
      return res.status(409).json({ error: 'a capability with this kind+name already exists' });
    }
    return sendPolicyError(res, err);
  }
  // Push the new/changed capability into the hook-side cache immediately (see cacheWarmer.js)
  // instead of leaving the next hook call to either miss (a fresh agent's first invocation of
  // this capability) or wait out the warm timer.
  refreshCapabilityCache(store);
  res.status(201).json(capability);
});

// Toggles a capability's autoGrant flag (see the comment above findActiveGrant). Admin-
// scoped for the same self-escalation reason as every other registry-mutating route above: this is
// a strictly stronger switch than an ordinary grant (it can't be revoked per-principal, and it's
// invisible to grant lookups), so it needs the same gate a retier would.
app.patch('/api/capabilities/:id/auto-grant', requireAdmin, async (req, res) => {
  const { autoGrant } = req.body || {};
  if (typeof autoGrant !== 'boolean') {
    return res.status(400).json({ error: 'autoGrant must be a boolean' });
  }
  const before = policyStore.findCapabilityById(req.params.id);
  if (!before) {
    return res.status(404).json({ error: 'capability not found' });
  }
  if (autoGrant && before.riskTier === 'destructive') {
    return res.status(400).json({ error: 'destructive capabilities cannot be auto-granted' });
  }
  let after;
  try {
    after = await policyStore.setCapabilityAutoGrant(before.id, autoGrant);
  } catch (err) {
    return sendPolicyError(res, err);
  }
  usageSink.recordAuditEntry({
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
  res.json(sortByName(policyStore.listPrincipals()));
});

app.post('/api/principals', requireAdmin, async (req, res) => {
  const { kind, name, parentRole, subjectId, assuranceLevel } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (kind !== 'role' && kind !== 'instance' && kind !== 'user') {
    return res.status(400).json({ error: 'kind must be "role", "instance" or "user"' });
  }
  // A `user` principal is the one kind with a real key: `name` on it is a display label, so
  // without `subjectId` the row would be identified by nothing at all
  // (docs/design/global-identity-and-central-db.md §1.4). The authority prefix is required for the
  // same reason the column carries one — a bare SID and a bare uid are not comparable values.
  if (kind === 'user') {
    if (typeof subjectId !== 'string' || !/^(win-sid|posix|env-user|federated):.+/.test(subjectId)) {
      return res.status(400).json({
        error: 'a "user" principal requires a subjectId prefixed by its authority (win-sid:, posix:, env-user:, federated:)',
      });
    }
    if (policyStore.findPrincipalBySubjectId(subjectId)) {
      return res.status(409).json({ error: 'a principal already exists for that subjectId' });
    }
  }
  const draft = {
    kind,
    name,
    parentRole: parentRole || null,
    subjectId: kind === 'user' ? subjectId : null,
    // Hand-registered, so the tier is whatever the admin can vouch for and 1 (display only) is the
    // honest floor — never inferred upward from the prefix, which anyone can type.
    assuranceLevel: kind === 'user' ? (isAssuranceLevel(assuranceLevel) ? assuranceLevel : ASSURANCE_ENV_DERIVED) : null,
  };
  // principals has a UNIQUE(kind, name) index for every kind but `user` (migration 16, §2.1) — the
  // same reason capabilities has one above: `role`/`instance` rows are resolved by (kind, name) on
  // the hook path, so two rows for one pair would leave the scan order deciding which one's grants
  // govern a call. The `user` kind's duplicate check is the subjectId one above; its name is a
  // label and may repeat.
  let principal;
  try {
    principal = await policyStore.insertPrincipal(draft);
  } catch (err) {
    if (err instanceof policyStore.PrincipalConflictError) {
      return res.status(409).json({ error: `a ${kind} principal named "${name}" already exists` });
    }
    return sendPolicyError(res, err);
  }
  // Policy: a role principal's starting grants are every read_only capability — the same baseline
  // principals/registry.js's grantReadOnlyBaseline gives a freshly-sighted role. An instance
  // principal (parentRole set) gets no grants of its own here: it inherits its parent role's
  // grants dynamically, at authorization time (findActiveGrant, above). Earlier this materialized
  // a real per-instance copy of the role's grants at creation time instead, which then had its own
  // lifecycle independent of the role's — revoking the role's grant didn't touch instances that
  // already copied it. Dropped.
  if (kind === 'role') {
    const readOnlyCapIds = policyStore.listCapabilities().filter((c) => c.riskTier === 'read_only').map((c) => c.id);
    for (const capId of readOnlyCapIds) {
      // Sequential rather than Promise.all, and that is not timidity: on a replica node each of
      // these is a write to central followed by a pull, and firing N of them concurrently would
      // have N pulls racing to apply overlapping deltas into one SQLite mirror. The baseline is a
      // handful of capabilities on an admin route nobody is timing.
      // eslint-disable-next-line no-await-in-loop
      await policyStore.insertGrant({ principalId: principal.id, capabilityId: capId });
    }
  }
  refreshPrincipalCache(store);
  res.status(201).json(principal);
});

// The hook path's principal resolution (server/hooks/lib.js's resolvePrincipal). Every
// PreToolUse/PostToolUse hook process used to do this itself, in-process: `store.load()` →
// `upsertPrincipalFromIdentity` → `store.save()`, i.e. a **whole-database rewrite**
// (store.js's replaceAll) off a snapshot read microseconds earlier, from a process that never
// passed `requireAuth` at all. Two consequences, both real: any grant/capability/usage row
// written between that read and that save was silently lost, and the registry's own enforcement
// point was bypassable by anything that could require() the store — which is every hook, for
// every principal, including untrusted ones. See docs/design/global-identity-and-central-db.md,
// phase 0 ("close the hook write path").
//
// Now the hook posts its *identity* here and the server does the upsert, through the narrow
// two-row transaction in store.js (`upsertPrincipalIdentity`) rather than a table replace. This
// is deliberately reachable by the **agent** token, not just admin: it's the one registry write a
// hook legitimately has to make, and it is tightly bounded — it can create a `pending` role with
// zero grants and an instance that holds no grants of its own, and it can refresh identity
// metadata. It cannot grant anything, cannot approve a pending role, and cannot touch any other
// table. `hostname` is deliberately *not* accepted here: it describes the call, not the principal,
// and is already carried per-event on /api/invoke. `osUser` is accepted for one narrow purpose —
// it is the display *label* written on the subject principal below (`subjectId` is that row's
// actual key), so it names the person on the dashboard and identifies nothing.
//
// `subjectId`/`assuranceLevel` are self-asserted by the hook, like everything else on this route.
// That is sound for a hook talking to a service on its own machine and is *not* an identity proof
// (docs/design/global-identity-and-central-db.md §1.5) — which is exactly why the subject row this
// creates authorizes nothing yet, and why the assurance tier is recorded rather than assumed.
app.post('/api/principals/resolve', async (req, res) => {
  const identity = req.body || {};
  if (!identity.loomId || typeof identity.loomId !== 'string') {
    return res.status(400).json({ error: 'loomId is required' });
  }
  // Rejected rather than ignored: an unprefixed key is the one failure mode the authority prefix
  // exists to prevent — a bare `1001` from Windows and a bare `1001` from Linux are different
  // people who would land on the same UNIQUE row (§1.4).
  if (identity.subjectId != null) {
    if (typeof identity.subjectId !== 'string' || !/^(win-sid|posix|env-user|federated):.+/.test(identity.subjectId)) {
      return res.status(400).json({ error: 'subjectId must be prefixed by its authority (win-sid:, posix:, env-user:, federated:)' });
    }
  }
  const roleName = principalRoleName(identity);
  let result;
  try {
    result = await policyStore.upsertPrincipalIdentity(roleName, identity);
  } catch (err) {
    // On a replica node this is a WAN call, so "failed" now includes "central is unreachable" —
    // and that distinction reaches the agent, because server/hooks/lib.js turns a failed resolve
    // into FAULT.NO_PRINCIPAL and runs the degradation ladder (read_only open, mutating and
    // destructive closed) rather than emitting a permission denial. A 503 rather than a 500 is
    // what says "this is the service, not your request".
    console.error('[principals/resolve] upsert failed for', identity.loomId, err.message);
    const unreachable = policyAuthority === 'central' && !err.status;
    return res.status(unreachable ? 503 : 500).json({
      error: unreachable
        ? `failed to resolve principal: central (${centralUrl}) is unreachable, and it owns the registry on this node`
        : 'failed to resolve principal',
    });
  }
  // The identity a hook reports can disagree with the one this loomId was registered under — a
  // node id reused by a differently-named agent, most often. The registered value stands
  // (want-mszgwf94-14: overwriting it re-attributes every historical event to the newcomer), so
  // the observation has nowhere to go until `usage_events` carries the actor itself
  // (want-mszgwhfj-16). Log it rather than drop it silently — it's also the signal that node ids
  // are being reused, which is what makes want-16 urgent.
  if (result.identityDrift && result.identityDrift.length) {
    const changes = result.identityDrift.map((d) => `${d.field}: ${d.registered} -> ${d.observed}`).join(', ');
    console.warn('[principals/resolve] identity drift for', identity.loomId, '— keeping registered values —', changes);
  }
  // Only on an actual registry change — this route runs on every hook cache miss, and rewriting
  // both cache files on a no-op refresh would be pure churn.
  if (result.roleCreated || result.instanceCreated || result.identityFilled) refreshPrincipalCache(store);
  // `subject` is the OS account the call is accountable to (docs/design/global-identity-and-central-db.md
  // §1.4) — null when the hook is old enough not to send a `subjectId` at all. It is returned so a
  // caller can see what was recorded, and for nothing else yet: authorization still resolves
  // instance → parentRole, unchanged. Phase 1 observes; phase 5 flips.
  res.json({ role: result.role, instance: result.instance, subject: result.subject || null });
});

// The display label on a subject principal. `principals.name` is a *mutable* label
// (docs/design/global-identity-and-central-db.md §1.4) — an OS account gets renamed and the row
// should follow, which is safe precisely because a `user` row is keyed on `subjectId` and every
// grant, usage event and audit entry references `principals.id`. Nothing is re-attributed by a
// rename.
//
// Refused for `role` and `instance` kinds: their `name` is still the lookup key the hook path
// resolves through (`findPrincipalByKindName`), so renaming one silently orphans it — the next
// resolve for that loom id or agentType mints a fresh `pending` principal and the old row keeps
// the grants. That stops being true at phase 5, not before.
app.patch('/api/principals/:id/name', requireAdmin, async (req, res) => {
  const principal = policyStore.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (principal.kind !== 'user') {
    return res.status(409).json({
      error: `only a "user" principal has a renameable label; ${principal.kind} principals are keyed on name`,
    });
  }
  const updated = await policyStore.setPrincipalName(principal.id, name);
  usageSink.recordAuditEntry({
    action: 'principal_rename',
    ...auditActor(req),
    principalId: principal.id,
    before: { name: principal.name },
    after: { name: updated.name },
    reason: (req.body && req.body.reason) || null,
  });
  res.json(updated);
});

// A role principal minted by first sighting
// (server/principals/registry.js's upsertRole, run from the hook path for any agentType it hasn't
// seen before) lands `status: 'pending'` with zero grants instead of the old auto-provision. This
// is the only place the read-only baseline gets applied to one now — an admin has to actually look
// at the role first. Idempotent-safe against double-granting the same way grantReadOnlyBaseline is:
// insertGrant's active-grant unique index would 409 on a repeat, so this skips capabilities the
// role already holds a direct grant for rather than racing that.
app.post('/api/principals/:id/approve', requireAdmin, async (req, res) => {
  const principal = policyStore.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (principal.status !== 'pending') {
    return res.status(409).json({ error: `principal is ${principal.status}, not pending` });
  }
  // THE READ-ONLY BASELINE, AND WHY IT COVERS PEOPLE AS WELL AS ROLES.
  //
  // `role` was the only kind here until this change, and for `instance` that is still correct: an
  // instance inherits its parent role's grants dynamically (findActiveGrant above), so materialising
  // a per-instance copy would give it a set with its own lifecycle that revoking the role's grant no
  // longer reaches. That is the reason materialisation was removed in the first place.
  //
  // A `user` principal is the opposite case and was simply missed. It carries `parentRole: null` by
  // design — a person is not an agent, so there is nothing above it to inherit from — which means
  // the only grants it can ever hold are its own. It was created `pending` with zero, this route
  // skipped it, and docs/design/grant-resolution-semantics.md makes the *user leg* a mandatory half
  // of the effective decision ("an agent can never exceed its operator"). The result was a subject
  // that every user-keyed evaluation denied, for want of a grant nothing in the product issued.
  //
  // So approving a person now does what approving a role does, for the same stated reason:
  // read-only access needs no per-principal justification the way mutating and destructive access
  // does. It stays an explicit human act — this runs on approve, never on first sighting.
  if (principal.kind === 'role' || principal.kind === 'user') {
    const alreadyGranted = new Set(
      policyStore.listGrants({ principalId: principal.id }).map((g) => g.capabilityId)
    );
    const readOnlyCapIds = policyStore.listCapabilities().filter((c) => c.riskTier === 'read_only').map((c) => c.id);
    for (const capId of readOnlyCapIds) {
      if (alreadyGranted.has(capId)) continue;
      // eslint-disable-next-line no-await-in-loop
      const grant = await policyStore.insertGrant({ principalId: principal.id, capabilityId: capId });
      usageSink.recordAuditEntry({
        action: 'grant_issue',
        ...auditActor(req),
        principalId: principal.id,
        capabilityId: capId,
        grantId: grant.id,
        after: grant,
        reason: `read-only baseline on approving ${principal.kind} principal ${principal.id}`,
      });
    }
  }
  const updated = await policyStore.setPrincipalStatus(principal.id, 'active');
  usageSink.recordAuditEntry({
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
app.post('/api/principals/:id/deny', requireAdmin, async (req, res) => {
  const principal = policyStore.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (principal.status !== 'pending') {
    return res.status(409).json({ error: `principal is ${principal.status}, not pending` });
  }
  const updated = await policyStore.setPrincipalStatus(principal.id, 'denied');
  usageSink.recordAuditEntry({
    action: 'principal_deny',
    ...auditActor(req),
    principalId: principal.id,
    reason: (req.body && req.body.reason) || null,
  });
  refreshPrincipalCache(store);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Owner proposals (docs/design/global-identity-and-central-db.md §1.6, phase 4)
// ---------------------------------------------------------------------------
//
// "There is no recorded link from a loom instance to a human being. The closest thing is
// `usage_events.osUser`" — so the modal non-null osUser per instance gives a *probable* owner.
// The doc is explicit about what may be done with it: "a dashboard suggestion for a human to
// confirm, never an automatic remap." That constraint is what this section is shaped around:
//
//   - The proposal is computed on every read and stored nowhere. There is no column holding a
//     guess, so nothing downstream can mistake one for a decision, and correcting the heuristic
//     later needs no backfill.
//   - Only POST /api/principals/:id/owner writes, it is admin-only, and it records what the
//     *human* chose rather than what was proposed — a confirmation of a corrected username is
//     just as valid as accepting the modal one.
//   - Confirming changes no authorization decision. `findActiveGrant` still resolves instance →
//     parentRole; this records the mapping phase 5 will eventually flip onto. Saying so here is
//     the point — an owner mapping that silently started granting things would be exactly the
//     automatic remap the design forbids.
//
// Every value in a proposal comes from `usage_events.osUser`, which arrives on an unauthenticated
// request body (§1.5) and is a bare username with no SID or host qualifier. It is evidence about
// what a machine reported, not an identity claim, which is the whole reason a human is in the
// loop rather than a migration script.

// Below this the modal osUser is a coin toss dressed as a signal: with two events under one name
// and one under another, "most common" is noise. Proposals below it are still returned — with
// `weak: true` — because a human may recognise the name instantly where the arithmetic can't.
const OWNER_PROPOSAL_MIN_EVENTS = 3;
// A modal share below this means the instance's calls are split across accounts (a shared loom, a
// reused loom id, a machine with two people on it). Also flagged rather than hidden: the split
// itself is the thing worth showing.
const OWNER_PROPOSAL_CLEAR_SHARE = 0.8;

/**
 * The `user` principal for an OS account, if one already exists. Two ways in, strongest first:
 *
 *   - the subject key a hook on that machine would produce for the account, `env-user:<user>@<host>`
 *     — an exact key match, so it is the same subject the registry would resolve, not a guess;
 *   - the display label, case-insensitively. `principals.name` on a user row is seeded from the OS
 *     username, so this usually hits — but it is a *mutable label* (§1.4) that repeats across
 *     machines, so it is reported as the weaker basis and never silently applied. A human
 *     confirming the proposal is what decides whether the link is real.
 *
 * A tier-2 `win-sid:`/`posix:` subject cannot be reached from a bare username at all — that is the
 * unrecoverable part of the migration the doc calls out — so a machine whose hooks read real SIDs
 * has proposals with no matched user, and confirming one records the osUser alone.
 */
function matchOwnerUser(principals, osUser, hostname) {
  if (!osUser) return { user: null, basis: null };
  const host = String(hostname || '').toLowerCase();
  const users = principals.filter((p) => p.kind === 'user');
  if (host) {
    const key = `env-user:${osUser}@${host}`;
    const bySubject = users.find((p) => p.subjectId === key);
    if (bySubject) return { user: bySubject, basis: 'subject-key' };
  }
  const needle = osUser.toLowerCase();
  const byLabel = users.find((p) => (p.name || '').toLowerCase() === needle);
  return byLabel ? { user: byLabel, basis: 'label' } : { user: null, basis: null };
}

/**
 * One proposal per instance principal: the ranked OS accounts its calls were made under, the modal
 * one as the suggestion, and enough evidence beside it for a human to disagree — how many of the
 * instance's events carry any identity at all, which other accounts appear, and when each was last
 * seen. `proposal` is null when the instance has no identified event; the row still comes back so
 * the dashboard can say "nothing to go on" rather than silently omitting an agent.
 */
function buildOwnerProposals() {
  const principals = policyStore.listPrincipals();
  const { byPrincipal, totals } = policyStore.listOwnerEvidence();

  const totalsById = new Map(totals.map((t) => [t.principalId, t]));
  const evidenceById = new Map();
  for (const row of byPrincipal) {
    if (!evidenceById.has(row.principalId)) evidenceById.set(row.principalId, []);
    evidenceById.get(row.principalId).push(row);
  }

  return principals
    .filter((p) => p.kind === 'instance')
    .map((principal) => {
      const rows = evidenceById.get(principal.id) || [];
      const totalsRow = totalsById.get(principal.id) || { events: 0, eventsWithoutOsUser: 0 };

      // Collapse the (osUser, hostname) groups the query returns into one candidate per account:
      // the same person on the same machine can appear twice if `hostname` was ever null, and the
      // question being asked is "which account", not "which account on which host". The hosts are
      // kept beside it because "this name, but on a machine you don't recognise" is a reason to
      // reject a proposal.
      const byUser = new Map();
      for (const row of rows) {
        const existing = byUser.get(row.osUser);
        const hosts = row.hostname ? [row.hostname] : [];
        if (!existing) {
          byUser.set(row.osUser, {
            osUser: row.osUser,
            events: row.events,
            hostnames: hosts,
            firstSeenAt: row.firstSeenAt,
            lastSeenAt: row.lastSeenAt,
          });
          continue;
        }
        existing.events += row.events;
        for (const h of hosts) if (!existing.hostnames.includes(h)) existing.hostnames.push(h);
        if (row.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = row.firstSeenAt;
        if (row.lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = row.lastSeenAt;
      }
      // Ties broken by recency, then by name, so the same evidence always produces the same
      // proposal — a suggestion that reshuffles between two dashboard loads is one a human can't
      // act on.
      const candidates = [...byUser.values()].sort(
        (a, b) => b.events - a.events || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.osUser.localeCompare(b.osUser)
      );

      const owner = {
        status: principal.ownerStatus || 'unassigned',
        osUser: principal.ownerOsUser ?? null,
        principalId: principal.ownerPrincipalId ?? null,
        confirmedAt: principal.ownerConfirmedAt ?? null,
        confirmedBy: principal.ownerConfirmedBy ?? null,
      };

      const identifiedEvents = candidates.reduce((sum, c) => sum + c.events, 0);
      let proposal = null;
      if (candidates.length > 0) {
        const top = candidates[0];
        const share = identifiedEvents > 0 ? top.events / identifiedEvents : 0;
        const { user, basis } = matchOwnerUser(principals, top.osUser, top.hostnames[0]);
        proposal = {
          osUser: top.osUser,
          hostnames: top.hostnames,
          events: top.events,
          identifiedEvents,
          totalEvents: totalsRow.events,
          eventsWithoutOsUser: totalsRow.eventsWithoutOsUser,
          share,
          firstSeenAt: top.firstSeenAt,
          lastSeenAt: top.lastSeenAt,
          // Two independent reasons a suggestion deserves a second look, reported separately
          // because they mean different things: too little evidence, versus evidence that
          // disagrees with itself.
          weak: top.events < OWNER_PROPOSAL_MIN_EVENTS,
          contested: candidates.length > 1 && share < OWNER_PROPOSAL_CLEAR_SHARE,
          matchedUser: user
            ? { id: user.id, name: user.name, subjectId: user.subjectId ?? null, assuranceLevel: user.assuranceLevel ?? null }
            : null,
          matchBasis: basis,
        };
      }

      return { principal, owner, proposal, candidates };
    });
}

// Default view is the queue: instances nobody has decided on that have something to decide *from*.
// `status=all` returns every instance including confirmed/dismissed ones and those with no
// evidence, which is what the dashboard's "show everything" toggle and any audit of the mapping
// wants. Readable without an admin token, matching GET /api/principals and GET /api/usage — it
// exposes no osUser that isn't already on the usage feed — while every write below is admin-only.
app.get('/api/principals/owner-proposals', (req, res) => {
  const all = buildOwnerProposals();
  const summary = {
    instances: all.length,
    confirmed: all.filter((p) => p.owner.status === 'confirmed').length,
    dismissed: all.filter((p) => p.owner.status === 'dismissed').length,
    needsReview: all.filter((p) => p.owner.status === 'unassigned' && p.proposal).length,
    noEvidence: all.filter((p) => p.owner.status === 'unassigned' && !p.proposal).length,
  };
  const status = req.query.status === 'all' ? 'all' : 'needs_review';
  const proposals = status === 'all' ? all : all.filter((p) => p.owner.status === 'unassigned' && p.proposal);
  res.json({ status, summary, proposals });
});

/**
 * The human's decision. `status` is:
 *
 *   confirmed  — with `osUser`: this instance belongs to that OS account. The username is taken
 *                from the body, not re-derived from the events, so correcting a wrong proposal is
 *                the same operation as accepting a right one. `ownerPrincipalId` may name an
 *                existing `user` principal; it is validated but never invented, because minting a
 *                subject row from a bare username would assert an identity nobody verified (§1.4).
 *   dismissed  — a human looked and could not name an owner. Recorded, rather than left
 *                unassigned, so the same guess doesn't come back on every dashboard load.
 *   unassigned — reopen a decision, putting the instance back in the queue.
 *
 * Only `instance` principals have an owner in this sense: a role is an agent *shape* (many people)
 * and a user principal *is* the person. Refused rather than ignored for either.
 */
app.post('/api/principals/:id/owner', requireAdmin, async (req, res) => {
  const principal = policyStore.findPrincipalById(req.params.id);
  if (!principal) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (principal.kind !== 'instance') {
    return res.status(409).json({
      error: `only an "instance" principal has an owner to confirm; ${principal.kind} principals do not`,
    });
  }
  const body = req.body || {};
  const status = body.status || 'confirmed';
  if (status !== 'confirmed' && status !== 'dismissed' && status !== 'unassigned') {
    return res.status(400).json({ error: 'status must be one of "confirmed", "dismissed", "unassigned"' });
  }

  let osUser = null;
  let ownerPrincipalId = null;
  if (status === 'confirmed') {
    osUser = typeof body.osUser === 'string' ? body.osUser.trim() : '';
    if (!osUser) {
      return res.status(400).json({ error: 'osUser is required to confirm an owner' });
    }
    if (body.ownerPrincipalId) {
      const owner = policyStore.findPrincipalById(body.ownerPrincipalId);
      if (!owner) {
        return res.status(404).json({ error: 'ownerPrincipalId does not match a principal' });
      }
      if (owner.kind !== 'user') {
        return res.status(409).json({ error: `ownerPrincipalId must name a "user" principal, not a ${owner.kind}` });
      }
      ownerPrincipalId = owner.id;
    }
  }

  const updated = await policyStore.setPrincipalOwner(principal.id, {
    status,
    osUser,
    ownerPrincipalId,
    decidedByScope: req.tokenScope,
  });
  usageSink.recordAuditEntry({
    action: `principal_owner_${status}`,
    ...auditActor(req),
    principalId: principal.id,
    before: { ownerStatus: principal.ownerStatus || 'unassigned', ownerOsUser: principal.ownerOsUser ?? null, ownerPrincipalId: principal.ownerPrincipalId ?? null },
    after: { ownerStatus: updated.ownerStatus, ownerOsUser: updated.ownerOsUser, ownerPrincipalId: updated.ownerPrincipalId },
    // What the human was *shown* when they decided, so the audit row survives a later change to
    // the proposal heuristic — otherwise "why did they confirm that?" is unanswerable.
    reason: body.reason || (body.proposedOsUser ? `proposed ${body.proposedOsUser}` : null),
  });
  res.json({ principal: updated });
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

app.get('/api/grants', (req, res) => {
  const { principalId, capabilityId } = req.query;
  res.json(policyStore.listGrants({ principalId, capabilityId }));
});

app.post('/api/grants', requireAdmin, async (req, res) => {
  const { principalId, capabilityId, constraints, expiresAt, reason } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  if (!policyStore.findPrincipalById(principalId)) {
    return res.status(404).json({ error: 'principal not found' });
  }
  if (!policyStore.findCapabilityById(capabilityId)) {
    return res.status(404).json({ error: 'capability not found' });
  }
  // The active-grants partial unique index on (principalId, capabilityId) — not a pre-check
  // against a snapshot that could go stale between the check and the write — is what makes this
  // race-safe. On a replica node that index is central's, which is what makes it race-safe across
  // the fleet rather than only on this machine.
  let grant;
  try {
    grant = await policyStore.insertGrant({
      principalId,
      capabilityId,
      constraints: constraints || null,
      expiresAt: expiresAt || null,
    });
  } catch (err) {
    if (err instanceof policyStore.GrantConflictError) {
      return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
    }
    return sendPolicyError(res, err);
  }
  usageSink.recordAuditEntry({ action: 'grant_issue', ...auditActor(req), principalId, capabilityId, grantId: grant.id, after: grant, reason: reason || null });
  res.status(201).json(grant);
});

app.delete('/api/grants/:id', requireAdmin, async (req, res) => {
  const before = policyStore.findGrantById(req.params.id);
  let revoked = null;
  try {
    revoked = before && !before.revokedAt ? await policyStore.revokeGrant(req.params.id, req.tokenScope) : null;
  } catch (err) {
    // A revoke that cannot reach the authority is the failure this whole design is most careful
    // about, so it is reported rather than absorbed: the caller must not read a 500 as "probably
    // fine". What is NOT lost is the guarantee — once central has the row, every node learns it
    // through the always-full deny-list (§2.4) whether or not this request succeeded.
    return sendPolicyError(res, err);
  }
  if (!revoked) {
    return res.status(404).json({ error: 'grant not found' });
  }
  usageSink.recordAuditEntry({
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
// Pending approvals. The propose endpoints
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
  res.json(policyStore.listApprovals({ status }));
});

// Read side of the audit trail — admin-only, same as everything else that can see who did what.
app.get('/api/audit', requireAdmin, (req, res) => {
  const { grantId } = req.query;
  res.json(usageSink.listAuditEntries({ grantId }));
});

app.post('/api/grants/propose', requireProposer, async (req, res) => {
  const { principalId, capabilityId, constraints, expiresAt } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  if (!policyStore.findPrincipalById(principalId)) {
    return res.status(404).json({ error: 'principal not found' });
  }
  const capability = policyStore.findCapabilityById(capabilityId);
  if (!capability) {
    return res.status(404).json({ error: 'capability not found' });
  }
  if (policyStore.findGrant(principalId, capabilityId)) {
    return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
  }
  const approval = await policyStore.insertApproval({
    action: 'grant',
    principalId,
    capabilityId,
    payload: { principalId, capabilityId, constraints: constraints || null, expiresAt: expiresAt || null },
    requestedByScope: req.tokenScope,
  });
  res.status(202).json({ pending: true, approval });
});

app.post('/api/grants/:id/propose-revoke', requireProposer, async (req, res) => {
  const grant = policyStore.listGrants().find((g) => g.id === req.params.id);
  if (!grant) {
    return res.status(404).json({ error: 'grant not found' });
  }
  const approval = await policyStore.insertApproval({
    action: 'revoke',
    principalId: grant.principalId,
    capabilityId: grant.capabilityId,
    payload: { grantId: grant.id },
    requestedByScope: req.tokenScope,
  });
  res.status(202).json({ pending: true, approval });
});

app.post('/api/approvals/:id/approve', requireAdmin, async (req, res) => {
  const approval = policyStore.findApprovalById(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'approval not found' });
  }
  if (approval.status !== 'pending') {
    return res.status(409).json({ error: `approval already ${approval.status}` });
  }
  if (approval.action === 'grant') {
    const { principalId, capabilityId, constraints, expiresAt } = approval.payload;
    let grant;
    try {
      grant = await policyStore.insertGrant({ principalId, capabilityId, constraints, expiresAt });
    } catch (err) {
      if (err instanceof policyStore.GrantConflictError) {
        return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
      }
      return sendPolicyError(res, err);
    }
    usageSink.recordAuditEntry({
      action: 'grant_issue',
      ...auditActor(req),
      principalId,
      capabilityId,
      grantId: grant.id,
      after: grant,
      reason: `approved proposal ${approval.id}`,
    });
    const decided = await policyStore.decideApproval(approval.id, { status: 'approved', decidedByScope: req.tokenScope, resultGrantId: grant.id });
    return res.json({ approval: decided, grant });
  }
  // action === 'revoke'
  const before = policyStore.findGrantById(approval.payload.grantId);
  let revoked = null;
  try {
    revoked = before && !before.revokedAt ? await policyStore.revokeGrant(approval.payload.grantId, req.tokenScope) : null;
  } catch (err) {
    return sendPolicyError(res, err);
  }
  if (revoked) {
    usageSink.recordAuditEntry({
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
  const decided = await policyStore.decideApproval(approval.id, { status: 'approved', decidedByScope: req.tokenScope });
  res.json({ approval: decided, revoked: Boolean(revoked) });
});

app.post('/api/approvals/:id/deny', requireAdmin, async (req, res) => {
  const approval = policyStore.findApprovalById(req.params.id);
  if (!approval) {
    return res.status(404).json({ error: 'approval not found' });
  }
  if (approval.status !== 'pending') {
    return res.status(409).json({ error: `approval already ${approval.status}` });
  }
  const { reason } = req.body || {};
  const decided = await policyStore.decideApproval(approval.id, { status: 'denied', decidedByScope: req.tokenScope, reason: reason || null });
  res.json({ approval: decided });
});

// Default length of the real grant an admin issues when they extend a one-time consent approval
// into standing access (the "approve for an hour" option) — a body-supplied `hours` overrides it.
const CONSENT_EXTEND_DEFAULT_HOURS = 1;

// The ask-consent path (see POST
// /api/usage/:id/approve-consent below) only ever records a one-time approval — it has no channel
// back to the human mid-prompt to offer "approve for an hour" instead of "approve once", since the
// harness's own ask dialog is the only thing actually blocking on their answer. This is the second
// half of that choice: once the one-time approval is on record, an admin can retroactively turn it
// into a real time-boxed grant from the Approvals page, so the *next* call to the same
// principal+capability pair doesn't have to ask again for up to `hours`.
app.post('/api/approvals/:id/extend-grant', requireAdmin, async (req, res) => {
  const approval = policyStore.findApprovalById(req.params.id);
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
  let grant;
  try {
    grant = await policyStore.insertGrant({
      principalId: approval.principalId,
      capabilityId: approval.capabilityId,
      expiresAt,
    });
  } catch (err) {
    if (err instanceof policyStore.GrantConflictError) {
      return res.status(409).json({ error: 'a grant for this principal+capability already exists' });
    }
    return sendPolicyError(res, err);
  }
  usageSink.recordAuditEntry({
    action: 'grant_issue',
    ...auditActor(req),
    principalId: approval.principalId,
    capabilityId: approval.capabilityId,
    grantId: grant.id,
    after: grant,
    reason: `extended consent approval ${approval.id} to a ${hours}h grant`,
  });
  const decided = await policyStore.decideApproval(approval.id, {
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

/**
 * Whose policy this node just decided from, and how current that copy is.
 *
 * Stamped on every /invoke response and on the two 404s above — phase 4 of
 * docs/design/global-identity-and-central-db.md §2.7. Three fields, each answering a question that
 * did not exist while the node was its own authority:
 *
 *   authority  'node' (this machine's own tables are the registry) or 'central' (they are a mirror).
 *   version    which of central's versions the mirror holds. A number that stops moving while
 *              `fetchedAt` keeps moving is a frozen replica, which is §2.6's skew case.
 *   ageMs      how long since the policy channel last confirmed anything with central. This is the
 *              value MAX_POLICY_AGE is measured against in server/hooks/lib.js, reported here so an
 *              operator can see how close a node is to failing closed before it does.
 *
 * Cheap by construction: on a node-authoritative install it reads nothing and returns a constant,
 * because the hook is blocked on this response and the phase must not cost a governed call a
 * database read it did not previously make.
 */
function policyStamp() {
  if (policyAuthority !== CENTRAL) return { authority: 'node', version: null, ageMs: null };
  const status = policyClientStatus();
  return {
    authority: 'central',
    version: status.mirrorVersion ?? 0,
    ageMs: status.denyListAgeMs ?? null,
  };
}

app.post('/api/invoke', (req, res) => {
  const {
    principalId, capabilityId, correlationId, osUser, hostname,
    actorLoomId, actorAgentType, actorBackend, actorField,
    subjectId, assuranceLevel,
  } = req.body || {};
  if (!principalId || !capabilityId) {
    return res.status(400).json({ error: 'principalId and capabilityId are required' });
  }
  const principal = policyStore.findPrincipalById(principalId);
  if (!principal) {
    // 404 means "not in this node's registry", and under central authority that is ambiguous in a
    // way it never was before: the row may not exist anywhere, or it may exist centrally and not
    // have replicated here yet. `policy` on the body is what lets the hook tell those apart —
    // server/hooks/lib.js reads it and takes the fault ladder rather than emitting a denial when
    // the mirror is behind. Without it a replication lag would reach an agent as "you lack
    // permission", which is the exact misreading the fault taxonomy exists to prevent.
    return res.status(404).json({ error: 'principal not found', policy: policyStamp() });
  }
  const capability = policyStore.findCapabilityById(capabilityId);
  if (!capability) {
    return res.status(404).json({ error: 'capability not found', policy: policyStamp() });
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
    // Placeholders, and deliberately not filled in here: the node's coordinates and its own clock
    // reading are assigned by usageSink.recordUsageEvent inside the insert transaction
    // (docs/design/global-identity-and-central-db.md §2.7 phase 1), because `seq` has to be the
    // tip of this node's chain at the moment of the write. They are present-and-null rather than
    // absent so the object this route returns has the same shape as the row — the response is
    // sent before the insert runs, so this copy genuinely does not have them yet.
    nodeId: null,
    seq: null,
    observedAt: null,
    principalId,
    capabilityId,
    ts: now.toISOString(),
    outcome: allowed ? 'ok' : 'denied',
    latencyMs: randomInt(40, 400),
    correlationId: correlationId || null,
    reason: allowed
      ? null
      : (policyAuthority === CENTRAL
        // Named on the EVENT, not only in the response, because the event is what survives: an
        // audit six weeks later asking "why was this denied" gets "no grant in central's policy at
        // replica version N" rather than a bare sentence that could equally describe a node whose
        // replica had never synced.
        ? `no active grant for principal+capability in central policy (replica v${policyStamp().version})`
        : 'no active grant for principal+capability'),
    brokerMs,
    // Real computer account/machine that issued this call (server/principals/fromEnv.js's
    // identityFromEnv, forwarded by the hook — see server/hooks/lib.js's resolvePrincipal/invoke),
    // distinct from `principalId` which identifies the agent, not the human OS account behind it.
    osUser: osUser || null,
    hostname: hostname || null,
    // The calling agent as a dimension of this call. `principalId` is a *pointer* into a mutable
    // row — resolve the agent's type/backend/field through it later and you get whatever those
    // columns say then, not what the hook actually saw when the call happened. These are that
    // observation, copied onto the event (same source as osUser/hostname above: the hook's
    // identityFromEnv). Trusting the caller for them is the same trade already made for
    // osUser/hostname — the hook is the only process that can see the calling environment — and
    // they're covered by the usage_events hash chain, so a later rewrite is detectable.
    actorLoomId: actorLoomId || null,
    actorAgentType: actorAgentType || null,
    actorBackend: actorBackend || null,
    actorField: actorField || null,
    // Who this call is accountable to, and how strongly that was established *for this call*
    // (docs/design/global-identity-and-central-db.md §1.4). The subject principal's own
    // `assuranceLevel` ratchets up and never comes back down, so it answers "how well has this
    // person ever been identified", not "how well were they identified here" — a run whose SID
    // read failed degrades to an `env-user:` key at tier 1 while the principal row still reads 2.
    // Recording the tier per event is what lets an audit separate the calls that rest on an
    // OS-read identity from the ones resting on a username off the environment.
    //
    // Malformed input is nulled rather than 400'd: unlike POST /principals (an admin registering a
    // row, where a bad key is the whole request) this is a broker decision a hook is blocked on,
    // and failing a tool call over a dimension that authorizes nothing would trade a real outcome
    // for an audit nicety. "Not recorded" is the honest reading, and it is distinguishable from
    // every tier. Same caller-trust trade as osUser/actor* above — the hook is the only process
    // that can see its own environment — and it is covered by the usage_events hash chain.
    subjectId: typeof subjectId === 'string' && /^(win-sid|posix|env-user|federated):.+/.test(subjectId)
      ? subjectId
      : null,
    assuranceLevel: isAssuranceLevel(assuranceLevel) ? assuranceLevel : null,
  };

  // §2.6, first rule, at the one place a differently-versioned caller actually reaches this node: a
  // hook from a NEWER build sends dimensions this server has no column for, and everything above
  // is an explicit field list, so without this they are read off the body by nobody and gone. They
  // are carried onto the event instead and land in usage_events.extra
  // (server/ingest/usageEvent.js), recoverable once this server upgrades and grows the column.
  //
  // Every field this build DOES know is excluded, which is what stops this from being an injection
  // point: a caller cannot reach past the broker and set its own `outcome`, `latencyMs` or
  // `reason`, nor claim a `nodeId`/`seq`/`hash` on someone else's chain. Those names are decided
  // above and here, never by the body.
  for (const [key, value] of Object.entries(req.body || {})) {
    if (key in EVENT_FIELDS || WRITER_ASSIGNED.has(key) || key === 'extra') continue;
    if (value === undefined) continue;
    event[key] = value;
  }

  // The hook is blocked on this response for its allow/deny decision, but nothing needs the
  // audit-log row to be durable before that decision goes out — only the PATCH from
  // PostToolUse (and anyone reading /api/usage afterwards) does, and both happen strictly later.
  // Respond first, write after: this takes the insert (and, even at synchronous=NORMAL, its
  // small remaining commit cost) off the latency the hook actually measures as grantCheckMs.
  // event.id is generated above (genId), not by the insert, so the caller already has a valid
  // eventId to hand back to PostToolUse even though the row isn't written yet.
  //
  // `policy` is phase 4's addition to this response and the visible half of the hook-contract
  // change (§2.7). A decision is now made against a REPLICA of someone else's tables, so "allowed"
  // on its own is no longer the whole answer — what a caller needs alongside it is whose policy
  // decided and how current that copy was. It is what makes a denial explainable to the agent
  // receiving it ("central's policy, replicated 4s ago") instead of an assertion it has no way to
  // check, and it is what a later audit reads to ask whether a decision was made on fresh state.
  res.json({ allowed, event, policy: policyStamp() });
  setImmediate(() => {
    // Shadow evaluation runs HERE, after the response, and not beside findActiveGrant above — the
    // hook is blocked on that call and measures it as grantCheckMs, so a second decision computed
    // inline would make an observation-only feature show up as a latency regression on every
    // governed tool call. Nothing it produces is needed before the insert it feeds.
    try {
      const shadow = evaluateUserKeyedGrant({
        subjectId: event.subjectId,
        actorAgentType: event.actorAgentType,
        principal,
        capability,
        now,
      });
      event.shadowOutcome = shadow.outcome;
      event.shadowReason = shadow.reason;
      event.shadowPrincipalId = shadow.principalId;

      const enforced = allowed ? 'allow' : 'deny';
      if ((shadow.outcome === 'allow' || shadow.outcome === 'deny') && shadow.outcome !== enforced) {
        // The alarm. Divergence is the whole signal this phase exists to produce, so it is a
        // console.error rather than a warn or a debug line — a phase-3 run that logs a wall of
        // these is telling whoever is watching that phase 5 is not ready, and that has to be
        // visible without anyone thinking to query for it. The per-event columns are the durable
        // record (GET /api/shadow-divergence aggregates them); this is what makes it noticed.
        console.error(
          `[shadow-divergence] ${capability.kind}/${capability.name}: enforced ${enforced} (loom-keyed,`,
          `principal ${principal.name}) but user-keyed says ${shadow.outcome} — ${shadow.reason}.`,
          `subject=${event.subjectId || 'none'} assurance=${event.assuranceLevel ?? 'unknown'} event=${event.id}`
        );
      }
    } catch (err) {
      // Shadow evaluation authorizes nothing, so it may never take a call down with it — and by
      // this point the hook has its answer and the tool is already running, so the only thing left
      // to lose is the audit row. Record that the shadow failed, on the event, and still insert.
      event.shadowOutcome = 'error';
      event.shadowReason = `shadow evaluation failed: ${err.message}`;
      event.shadowPrincipalId = null;
      console.error('[shadow-eval] failed for event', event.id, err.message);
    }

    try {
      usageSink.recordUsageEvent(event);
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
// usageSink.patchUsageEvent() also rechains this row's hash (and everything after it) on every write,
// so even a bug in the checks above — or a write that reached the row some other way — leaves a
// verifiable trace (usageSink.verifyUsageEventChain()) instead of silently passing as legitimate.
app.patch('/api/usage/:id', (req, res) => {
  const existing = usageSink.findUsageEvent(req.params.id);
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
  const event = usageSink.patchUsageEvent(req.params.id, patch);
  res.json(event);
});

// The ask branch of runPreToolUse logs its
// /invoke-time event as `denied` (no active grant) and then asks the harness's own permission
// prompt, which the hook can't see the answer to — only whether the tool actually ran. If it did,
// a human said yes, and this is PostToolUse's counterpart correction for that branch: instead of
// the ok/error transition PATCH /api/usage/:id handles, a `denied` event that was really approved
// moves to the dedicated `approved` outcome, and a matching row lands in the append-only
// `approvals` table (action 'consent') so "who approved this destructive call, and when" has an
// answer for the first time. Kept as its own endpoint rather than folded into PATCH so the general
// one-way ok->ok/error transition there doesn't have to grow a second, unrelated legal move.
app.post('/api/usage/:id/approve-consent', async (req, res) => {
  const existing = usageSink.findUsageEvent(req.params.id);
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

  const event = usageSink.patchUsageEvent(req.params.id, {
    outcome: 'approved',
    correctedAt: new Date().toISOString(),
  });

  const approval = await policyStore.insertApproval({
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
  const decided = await policyStore.decideApproval(approval.id, {
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
  // `nodeId` and `heads` alongside the verdict: the chain is per node now
  // (docs/design/global-identity-and-central-db.md §2.7 phase 1), so "is the log intact" is
  // answered once per node, and which node is *this* one is what tells an operator whether a
  // reported break is theirs to investigate or a sibling db's. The heads are also what a node
  // publishes upward under §2.2, so this route is already the shape that read will take.
  res.json({ nodeId: usageSink.nodeId(), heads: usageSink.listChainHeads(), ...usageSink.verifyUsageEventChain() });
});

/**
 * What this machine's own alert engine has fired — docs/design/global-identity-and-central-db.md
 * §2.3, the node half of "evaluate alerts at both ends".
 *
 * THE POINT OF SERVING THIS FROM THE NODE, when central has a fleet-wide view of the same table:
 * a node that fired an alert while it could not reach central is the case the local engine exists
 * for, and on that machine this route is the only place the alert can be read at all. `syncedAt`
 * being null is not an error state — it is what a partitioned node correctly looks like — so it is
 * returned rather than hidden, and `engine.unsynced` counts it.
 *
 * Admin-scoped, like every other read that names people and their call volumes.
 */
app.get('/api/alerts', requireAdmin, (req, res) => {
  res.json({
    alerts: store.listAlerts({
      limit: req.query.limit,
      since: req.query.since || null,
      severity: req.query.severity || null,
      ruleId: req.query.ruleId || null,
    }),
    engine: { ...store.alertStats(), ...nodeAlertStats() },
  });
});

app.get('/api/usage', (req, res) => {
  const { principalId, capabilityId } = req.query;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
  let events = usageSink.listUsageEvents(); // already newest-first (ORDER BY ts DESC)
  if (principalId) events = events.filter((e) => e.principalId === principalId);
  if (capabilityId) events = events.filter((e) => e.capabilityId === capabilityId);
  events = events.slice(0, limit);
  res.json(events);
});

/**
 * "How ready is the phase-5 flip?" — the aggregate of the shadow decisions logged per event by
 * /api/invoke (docs/design/global-identity-and-central-db.md §1.6 phase 3).
 *
 * `coverage` comes first on purpose: a divergence rate computed over calls that were never
 * evaluated is meaningless, and the failure mode this endpoint has to make impossible is reading
 * "0 divergent" off a fleet where nothing was evaluated at all. `wouldBreak` is the number that
 * decides the flip — calls allowed today that the user-keyed model denies. `wouldNewlyAllow` is
 * the opposite direction and is not symmetric with it: it is a call the person is entitled to that
 * their agent shape is denied today, which is a widening, not a breakage.
 *
 * ?windowMinutes= limits how far back to look (default: everything).
 */
app.get('/api/shadow-divergence', (req, res) => {
  const windowMinutes = req.query.windowMinutes ? parseInt(req.query.windowMinutes, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  const cutoff = Number.isFinite(windowMinutes) && windowMinutes > 0
    ? Date.now() - windowMinutes * 60_000
    : null;

  let events = usageSink.listUsageEvents();
  if (cutoff !== null) events = events.filter((e) => new Date(e.ts).getTime() >= cutoff);

  const evaluated = events.filter((e) => e.shadowOutcome === 'allow' || e.shadowOutcome === 'deny');
  const divergent = evaluated.filter((e) => e.shadowOutcome !== enforcedDecision(e.outcome));

  // Grouped by capability rather than by principal: a divergence is almost always "this capability
  // is granted to a role and to nobody personally", so the capability is the axis an admin can act
  // on — one grant closes every row in the group.
  const byCapability = new Map();
  for (const e of divergent) {
    const entry = byCapability.get(e.capabilityId) || { capabilityId: e.capabilityId, count: 0, reasons: new Set() };
    entry.count += 1;
    if (e.shadowReason) entry.reasons.add(e.shadowReason);
    byCapability.set(e.capabilityId, entry);
  }
  const capabilities = policyStore.listCapabilities();
  const capName = (id) => {
    const c = capabilities.find((x) => x.id === id);
    return c ? `${c.kind}/${c.name}` : id;
  };

  res.json({
    enabled: SHADOW_EVAL_ENABLED,
    windowMinutes: cutoff !== null ? windowMinutes : null,
    coverage: {
      events: events.length,
      evaluated: evaluated.length,
      unevaluated: events.filter((e) => e.shadowOutcome === 'unevaluated').length,
      errored: events.filter((e) => e.shadowOutcome === 'error').length,
      // Events predating this feature, which carry no shadow column at all — distinct from an
      // event this build declined to evaluate, and not something a rate should be taken over.
      notRecorded: events.filter((e) => e.shadowOutcome == null).length,
    },
    divergent: divergent.length,
    // Null rather than 0 when nothing was evaluated: "no divergence" and "no evidence" are the two
    // readings this endpoint must never let anyone confuse.
    divergenceRate: evaluated.length ? divergent.length / evaluated.length : null,
    wouldBreak: divergent.filter((e) => enforcedDecision(e.outcome) === 'allow').length,
    wouldNewlyAllow: divergent.filter((e) => enforcedDecision(e.outcome) === 'deny').length,
    byCapability: [...byCapability.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({ ...entry, capability: capName(entry.capabilityId), reasons: [...entry.reasons] })),
    recent: divergent.slice(0, limit).map((e) => ({
      id: e.id,
      ts: e.ts,
      capability: capName(e.capabilityId),
      enforced: enforcedDecision(e.outcome),
      shadow: e.shadowOutcome,
      shadowReason: e.shadowReason,
      shadowPrincipalId: e.shadowPrincipalId,
      subjectId: e.subjectId,
      assuranceLevel: e.assuranceLevel,
      actorAgentType: e.actorAgentType,
    })),
  });
});

app.get('/api/usage/summary', (req, res) => {
  const capabilities = policyStore.listCapabilities();
  const principals = policyStore.listPrincipals();

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

  let events = filterEventsByCapabilityProps(usageSink.listUsageEvents(), capabilities, req.query);
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

  // Group by principalId, the stable key — never by display name. `humanName` is a nickname the
  // platform assigns from a fixed cast pack (docs/design/global-identity-and-central-db.md §1.1),
  // not a person: keying on it merged two different humans whose agents both drew "Finn" into one
  // row, and split one human respawned under a new agent id across rows that never rejoin. The
  // nickname is still what gets *shown*; it just no longer decides what counts as the same caller.
  const byPrincipalMap = new Map();
  for (const e of events) {
    if (!byPrincipalMap.has(e.principalId)) {
      const principal = principals.find((p) => p.id === e.principalId);
      byPrincipalMap.set(e.principalId, {
        principalId: e.principalId,
        name: principalDisplayName(principal, e.principalId),
        // The agent/role name (a loom id for instances) — the UI needs something to tell two rows
        // apart when they legitimately carry the same nickname.
        agentName: principal ? principal.name : null,
        evs: [],
      });
    }
    byPrincipalMap.get(e.principalId).evs.push(e);
  }
  const byPrincipal = [...byPrincipalMap.values()].map(({ principalId, name, agentName, evs }) => ({
    principalId,
    name,
    agentName,
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
// Native tool calls — observation, not audit
//
// Read side of docs/design/native-tool-observability.md. These are Read/Edit/Bash/Grep calls,
// which this system does not govern and does not intend to: they are recorded so that "what did
// this loom actually do" has an answer, having previously had none at all (normalizeToolCall
// returns null for a native tool, so no capability, so no /invoke, so no row).
//
// Kept off /api/usage deliberately. That route serves the hash-chained audit log, and folding a
// stream one to two orders of magnitude larger and categorically weaker into it would change what
// every existing consumer of that route is looking at without any of them asking. Two routes, two
// meanings.
//
// Readable without an admin token, matching GET /api/usage and GET /api/principals: this is the
// dashboard's own read, and it carries strictly less than the audit log already exposes.
// ---------------------------------------------------------------------------

// Window shared by both routes below. A day by default — long enough that a dashboard opened in
// the morning shows yesterday evening's work, short enough that the default query stays cheap on
// a table that grows a row per file read.
const NATIVE_DEFAULT_WINDOW_MINUTES = 1440;

function nativeWindowStart(req) {
  const raw = Number(req.query.windowMinutes);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : NATIVE_DEFAULT_WINDOW_MINUTES;
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

app.get('/api/native-calls', (req, res) => {
  const { principalId, toolName, since, limit } = req.query;
  res.json(usageSink.listNativeToolEvents({ principalId, toolName, since, limit }));
});

app.get('/api/native-calls/summary', (req, res) => {
  const since = nativeWindowStart(req);
  const totals = usageSink.summarizeNativeToolEvents(since);
  res.json({
    // COUNT/SUM over an empty window return NULL for the SUMs, not 0 — normalize here so the
    // client never has to decide whether `null` errors means "none" or "not recorded".
    total: totals.total || 0,
    errors: totals.errors || 0,
    denied: totals.denied || 0,
    // The real extent of what is retained, NOT the requested window: with a retention cutoff in
    // force an empty result has two different meanings ("nothing happened" vs "nothing happened
    // recently"), and these are what let the card tell a human which one it is showing.
    observedFrom: totals.observedFrom || null,
    observedTo: totals.observedTo || null,
    byTool: usageSink.summarizeNativeToolEventsByTool(since),
    byPrincipal: usageSink.summarizeNativeToolEventsByPrincipal(since),
  });
});

// Calls over time. Two grains only, because the question the chart answers has two forms — "what
// is happening right now" and "what did today look like" — and each has one bucket width that is
// legible: a minute over an hour (60 points), an hour over a day (24). A `day` grain would need a
// retention window longer than these observations get.
const NATIVE_BUCKETS = {
  minute: { format: '%Y-%m-%dT%H:%M:00.000Z', minutes: 1, defaultWindow: 60 },
  hour: { format: '%Y-%m-%dT%H:00:00.000Z', minutes: 60, defaultWindow: 1440 },
};
// A ceiling on points, not on time: it is what stops `?granularity=minute&windowMinutes=100000`
// from asking the server to build a hundred thousand buckets for a 640px-wide chart.
const NATIVE_MAX_BUCKETS = 400;

app.get('/api/native-calls/timeseries', (req, res) => {
  const granularity = req.query.granularity === 'minute' ? 'minute' : 'hour';
  const { format, minutes: bucketMinutes, defaultWindow } = NATIVE_BUCKETS[granularity];

  const raw = Number(req.query.windowMinutes);
  let windowMinutes = Number.isFinite(raw) && raw > 0 ? raw : defaultWindow;
  windowMinutes = Math.min(windowMinutes, bucketMinutes * NATIVE_MAX_BUCKETS);

  const bucketMs = bucketMinutes * 60_000;
  // Align the window to bucket boundaries so the last point is the bucket in progress rather than
  // a partial one that starts wherever the request happened to land — otherwise the newest column
  // is always short and reads as a drop in activity.
  const end = Math.floor(Date.now() / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil(windowMinutes / bucketMinutes) * bucketMs;

  const counts = new Map();
  for (const row of usageSink.bucketNativeToolEvents({
    since: new Date(start).toISOString(),
    toolName: req.query.toolName || null,
    format,
  })) {
    counts.set(row.bucket, row);
  }

  // Zero-fill: SQL returns only the buckets that have rows, and a chart drawn from those alone
  // would connect a busy minute straight to the next busy one and hide the quiet stretch between.
  // The key matches strftime's output exactly because `t` is already on a bucket boundary, so
  // toISOString() yields the same zeroed seconds/ms the format string writes.
  const byBucket = [];
  for (let t = start; t < end; t += bucketMs) {
    const row = counts.get(new Date(t).toISOString());
    byBucket.push({
      bucket: new Date(t).toISOString(),
      calls: row ? row.calls || 0 : 0,
      errors: row ? row.errors || 0 : 0,
      denied: row ? row.denied || 0 : 0,
    });
  }

  res.json({ byBucket, granularity, windowMinutes, bucketMinutes });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

app.get('/api/drift', (req, res) => {
  const capabilities = policyStore.listCapabilities();
  const principals = policyStore.listPrincipals();
  const grants = policyStore.listGrants();
  const usageEvents = usageSink.listUsageEvents();

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

/**
 * Run a discovery pass and persist it, by whichever route this node's authority allows.
 *
 * NODE AUTHORITY — unchanged: `store.save(db)`, the wholesale replace, exactly as before.
 *
 * CENTRAL AUTHORITY — the wholesale replace is refused (`store.save` is behind the replica lock),
 * and it has to be. `replaceAll` writes capabilities through its own prepared statements, so on a
 * replica one discovery run would replace central's rows with locally-discovered ones — and nothing
 * would correct it, because from central's point of view nothing changed. So the pass is split along
 * §2.2's own line:
 *
 *   the capability, and its id  →  PROPOSED to central, which answers with the canonical row. A row
 *                                  central already has comes back untouched, including its tier: a
 *                                  rescan cannot retier anything, or "what may this tool do" would
 *                                  be decided by whichever machine scanned last.
 *   where this machine found it →  written locally (store.setCapabilityDiscoveryState). Central holds
 *                                  no opinion about `source`/`discoveredAt`/`lastSeenAt`/`stale`,
 *                                  and shipping them would make the last node to rescan overwrite
 *                                  every other node's record of its own filesystem.
 *
 * Sequential rather than concurrent, for the reason the read-only baseline loop gives: each proposal
 * is a write to central followed by a pull, and firing N of them at once would have N pulls racing to
 * apply overlapping deltas into one SQLite mirror.
 */
async function runDiscoveryAndPersist() {
  const db = store.load();
  const result = runDiscovery(db);

  if (policyAuthority !== CENTRAL) {
    store.save(db);
    return result;
  }

  let proposed = 0;
  const failures = [];
  for (const cap of db.capabilities || []) {
    if (!DISCOVERED_SOURCES.has(cap.source)) continue; // manual rows are not discovery's to manage
    try {
      // eslint-disable-next-line no-await-in-loop
      const canonical = await policyStore.resolveCapability({
        kind: cap.kind, name: cap.name, riskTier: cap.riskTier, description: cap.description, owner: cap.owner,
      });
      proposed += 1;
      store.setCapabilityDiscoveryState(canonical.id, cap);
    } catch (err) {
      // One unreachable proposal must not lose the other four hundred sightings, and it must not be
      // silent either — a discovery run that half-reported is a fleet where some machines' tools are
      // registered and some are not, which is invisible unless it is said out loud.
      failures.push(`${cap.kind || ''}/${cap.name}: ${err.message}`);
    }
  }
  // Discovery state itself is node-local (§2.2's `discovery_sources` row) and is written whatever
  // happened above — it is this machine's record of when it last looked.
  store.setDiscovery(db.discovery);
  if (failures.length) {
    console.error(`[discovery] ${failures.length} capability proposal(s) did not reach central:`, failures.slice(0, 5).join('; '));
  }
  return { ...result, proposedToCentral: proposed, proposalFailures: failures.length };
}

// Admin-scoped too (finding #9): discovery writes attacker-influenceable SKILL.md frontmatter
// straight into the registry, so triggering a run needs the same authority as any other registry
// mutation, not just any token holder.
app.post('/api/discovery/run', requireAdmin, async (req, res) => {
  const result = await runDiscoveryAndPersist();
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

app.post('/api/skills', requireAdmin, async (req, res) => {
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
  const discoveryResult = await runDiscoveryAndPersist();
  refreshCapabilityCache(store);
  res.status(201).json({ ...result, discovery: discoveryResult });
});

app.delete('/api/skills/:name', requireAdmin, async (req, res) => {
  const targetIds = Array.isArray(req.body?.targetIds) ? req.body.targetIds : undefined;
  const result = skills.removeSkill({ name: req.params.name, targetIds });
  // Files are gone; re-run discovery so a skill removed from every provider goes stale on the next
  // scan the same way any other vanished SKILL.md would (server/discovery/merge.js), rather than
  // leaving a ghost row that still claims to be fresh.
  const discoveryResult = await runDiscoveryAndPersist();
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

// Async since §2.7 phase 5: these answer from central when there is one and from the local
// workspace scan when there is not, and there is no synchronous HTTP. A rejection is already a 500
// rather than a hang — see the wrapper at the top of this file. `?hours=` narrows the window on the
// central path only; the scan has never had one.
const rollupOptions = (req) => ({ hours: Number(req.query.hours) || null, limit: Number(req.query.limit) || null });

app.get('/api/rollup/fields', async (req, res) => {
  res.json(await rollup.listFields(rollupOptions(req)));
});

app.get('/api/rollup/summary', async (req, res) => {
  res.json(await rollup.summary(rollupOptions(req)));
});

module.exports = app;
