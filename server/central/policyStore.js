'use strict';

// CENTRAL IS THE AUTHORITY FOR POLICY — phase 4 of docs/design/global-identity-and-central-db.md
// §2.7. This file is where a capability, a principal and a grant now come into existence.
//
// It is the counterpart of the node's server/store.js policy half, and reading them side by side is
// the fastest way to see what moved: the SQL is the same shape, the change log is the same design,
// and the node's copy has been demoted to a mirror it is no longer allowed to write
// (server/store.js's PolicyReadOnlyError). Three things are genuinely new here rather than moved:
//
//   1. IDS ARE MINTED HERE. §2.2: "the node reports what it found, central owns the canonical
//      capability row and its id." A node that discovers `mcp/slack.post` on its filesystem sends
//      the (kind, name) pair to ./policyRoutes.js's resolve endpoint and is told which id it is.
//      Two nodes that discover the same tool get the same id, which is the whole difference between
//      a fleet registry and N registries that happen to share a vocabulary.
//   2. UNIQUENESS IS FLEET-WIDE. `capabilities (COALESCE(kind,''), name)` and `principals (kind,
//      name)` are unique across every machine, so `role/claude` is one row and a grant issued to it
//      applies everywhere. On the node these were per-machine, and nothing noticed because no two
//      machines could see each other.
//   3. EVERY MUTATION APPENDS TO `policy_changes` IN THE SAME TRANSACTION. That invariant is what
//      the whole replication story rests on: a row written without its change row is a row no node
//      will ever learn about, and it would be invisible rather than broken. ./policy-authority-test.js
//      asserts the coverage the way server/policy/distribution-test.js does on the node.
//
// ASYNC ALL THE WAY DOWN, unlike the node's synchronous better-sqlite3 half. There is no
// synchronous Postgres client for Node (./pgDriver.js's header), so every caller of this is a route
// on the central process, which has nothing blocked on it — the hook path never reaches this file
// and never can. That is §2.8's first row restated as a call graph rather than a promise.

const { genId } = require('../id');

/** Bumped when the SHAPE of a change row or a /api/policy response changes incompatibly. A node
 *  refuses to apply a payload whose version it does not know rather than half-applying it (§2.6),
 *  so this number is what makes a mixed-version fleet survivable. It starts at the value the node's
 *  server/store.js already serves, because a node upgraded to phase 4 must be able to read a delta
 *  from a central that has just replaced its old node-side authority — the payload is the same
 *  payload, only the writer moved. */
const POLICY_SCHEMA_VERSION = 1;

/** One response's ceiling on delta rows. The node loops on `complete: false`. */
const MAX_CHANGES = 500;

/**
 * THE PROPAGATION WINDOW — how recently a node must have pulled to count as "connected to central"
 * for auto-grant propagation (./packages.js).
 *
 * A node polls `GET /api/policy` on WINDROW_POLICY_POLL_INTERVAL_MS (30s by default) and holds an
 * SSE connection that central pokes on every mutation. Either way, a node that pulled inside this
 * window is one central can still reach *now* — the fresh grant lands on its next poll, which is
 * moments away, rather than being merely queued for whenever it next checks in. The default is a
 * small multiple of the poll cadence so a node that missed a single poll still counts as connected;
 * one silent for several is treated as offline and left to catch up lazily off the always-full delta
 * stream, which reaches it regardless.
 *
 * This decides who a new grant is reported as reaching *promptly*, never what any node is allowed to
 * do: a node outside the window is not denied the grant, only propagated to later. That is why it is
 * safe to set from an env var — a wrong value slows an observation, it does not weaken enforcement.
 */
const PROPAGATION_WINDOW_MS = Number(process.env.WINDROW_PROPAGATION_WINDOW_MS) || 90_000;

/** Risk tiers, duplicated from server/app.js rather than imported: app.js is the *node's* express
 *  app and requiring it here would pull better-sqlite3, the node's data directory and its whole
 *  route table into the central process. The list is three words and it is checked in both places
 *  on purpose — central because it is the authority, the node because it still validates what a
 *  human types before sending it on. */
const RISK_TIERS = ['read_only', 'mutating', 'destructive'];

// ---------------------------------------------------------------------------
// Errors the routes branch on. Named to match the node's server/store.js classes so that
// server/policy/centralPolicyStore.js can map an HTTP status back onto the same taxonomy the seam
// promises (server/policy/index.js) — a caller in server/app.js catching
// `policyStore.GrantConflictError` must not have to care which side of the WAN threw it.
// ---------------------------------------------------------------------------
class GrantConflictError extends Error {}
class CapabilityConflictError extends Error {}
class PrincipalConflictError extends Error {}

/** Postgres unique-violation. Mapped rather than string-matched. */
const UNIQUE_VIOLATION = '23505';

function isUnique(err) {
  return err && err.code === UNIQUE_VIOLATION;
}

// ---------------------------------------------------------------------------
// Row shaping
//
// The node writes what a delta hands it straight into its mirror, so a row's shape here is a wire
// contract, not an internal detail. `pg` returns BOOLEAN as a JS boolean and BIGINT as a number
// (./pgDriver.js coerces the latter), which already matches what the node's capOut/principalOut
// produce — so these functions exist to make that agreement explicit and to be the one place it
// changes, not to convert anything today.
// ---------------------------------------------------------------------------
function capOut(row) {
  if (!row) return null;
  // `distribute` is stripped here on purpose: it is a fleet-provisioning flag (see migration 14),
  // read only through listSkills/GET /api/policy/skills, and it must never ride the policy delta —
  // materialiseReplica's node-side upsert names a fixed column set, so an extra field is a binding
  // error. Everything that serialises a capability for replication or the catalog goes through here.
  const { distribute, ...rest } = row;
  return { ...rest, autoGrant: Boolean(row.autoGrant) };
}

function principalOut(row) {
  if (!row) return null;
  return { ...row, standalone: Boolean(row.standalone) };
}

function approvalOut(row) {
  if (!row) return null;
  return { ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload };
}

// ---------------------------------------------------------------------------
// The change log
// ---------------------------------------------------------------------------

/** Listeners woken after a change commits — ./policyRoutes.js turns these into SSE. In-process
 *  only, and that is a real limit worth naming rather than hiding: two central instances behind a
 *  load balancer would each only poke the nodes holding an SSE connection to *them*. The poll
 *  channel still bounds the window at POLICY_POLL_INTERVAL_MS for everyone else, which is why this
 *  is a latency limitation rather than a correctness one, and why the fix when it is needed is
 *  Postgres LISTEN/NOTIFY (§2.5 already picked Postgres partly for it) rather than a new component. */
const listeners = new Set();

function onPolicyChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let pendingNotify = false;

/**
 * Wake listeners once, on the next tick, with the version at that moment.
 *
 * Deferred and coalesced for the same two reasons the node's schedulePolicyNotify is: a mutation
 * runs inside a transaction, and announcing a version a ROLLBACK could still take away would tell
 * every node in the fleet to pull a row that never existed; and a transaction writing six rows is
 * one notification's worth of news, because the event carries a version rather than a row.
 */
function scheduleNotify(driver) {
  if (pendingNotify || listeners.size === 0) return;
  pendingNotify = true;
  setImmediate(async () => {
    pendingNotify = false;
    let version;
    try {
      version = await policyVersion(driver);
    } catch (err) {
      console.error('[central-policy] could not read the version to announce:', err.message);
      return;
    }
    for (const listener of listeners) {
      try {
        listener(version);
      } catch {
        /* a subscriber that throws must not take down the write path that told it */
      }
    }
  });
}

/**
 * Append one change and return its version.
 *
 * Called from every mutator below, inside that mutator's transaction. `driver` is the transaction's
 * own driver, not the pool — passing the pool here would put the change row on a different
 * connection from the row it describes, so a rollback would keep the announcement.
 */
async function recordPolicyChange(driver, entity, entityId, op, row) {
  const inserted = await driver.get(
    'INSERT INTO policy_changes ("entity", "entityId", "op", "row", "ts") VALUES ($1, $2, $3, $4, $5) RETURNING "version"',
    [entity, entityId, op, row === null || row === undefined ? null : JSON.stringify(row), new Date().toISOString()]
  );
  return Number(inserted.version);
}

/** The current policy version: 0 when nothing has ever been recorded. */
async function policyVersion(driver) {
  const row = await driver.get('SELECT COALESCE(MAX("version"), 0) AS version FROM policy_changes');
  return Number(row.version);
}

/** The oldest version still in the log. A `since` below this cannot be served as a delta. */
async function policyChangeFloor(driver) {
  const row = await driver.get('SELECT COALESCE(MIN("version"), 0) AS floor FROM policy_changes');
  return Number(row.floor);
}

/**
 * The always-full deny-list (§2.4).
 *
 * Recomputed in full on every response rather than diffed, because "a node whose delta stream broke
 * still denies correctly" is precisely a promise a delta cannot make. Both handles are carried:
 * a replica row knows the grant's id, while a hook that never saw the grant can still recognise the
 * principal+capability pair it would have needed.
 */
async function policyDenyList(driver) {
  const revoked = await driver.all('SELECT "id", "principalId", "capabilityId" FROM grants WHERE "revokedAt" IS NOT NULL');
  const blocked = await driver.all("SELECT \"id\" FROM principals WHERE \"status\" <> 'active'");
  return {
    version: await policyVersion(driver),
    grantIds: revoked.map((g) => g.id),
    pairs: revoked.map((g) => `${g.principalId}:${g.capabilityId}`),
    principals: blocked.map((p) => p.id),
    computedAt: new Date().toISOString(),
  };
}

/** Changes after `since`, capped. `limit` bounds one response, not the catch-up. */
async function listPolicyChanges(driver, since = 0, { limit = MAX_CHANGES } = {}) {
  const rows = await driver.all(
    'SELECT "version", "entity", "entityId", "op", "row", "ts" FROM policy_changes WHERE "version" > $1 ORDER BY "version" ASC LIMIT $2',
    [since, limit]
  );
  // `row` comes back as an object from JSONB, not a string — the node's SQLite half stores TEXT and
  // parses. Both ends land on the same JS object, which is the only part the wire contract fixes.
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

/**
 * One `GET /api/policy?since=<v>` answer — the same payload server/policy/replica.js's applyDelta
 * already knows how to consume, assembled from central's tables instead of a node's.
 *
 * That identity is deliberate and it is what makes the flip a configuration change rather than a
 * rewrite: a node upgraded to phase 4 runs the same client, applies the same deltas and refuses the
 * same skew. What changed is which machine is answering.
 *
 * `reset` means this caller cannot be caught up incrementally — its `since` predates the retained
 * log, or is *ahead* of ours, which means it is talking to a different central or one restored from
 * a backup, and replaying our deltas onto it would silently merge two histories.
 */
async function policyDelta(driver, since = 0, { limit = MAX_CHANGES, nodeId = null } = {}) {
  const version = await policyVersion(driver);
  const floor = await policyChangeFloor(driver);
  const asked = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
  const reset = asked > version || (asked > 0 && asked < floor - 1) || (asked === 0 && version > 0 && floor > 1);
  const base = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    version,
    floor,
    since: asked,
    servedAt: new Date().toISOString(),
    // Unconditional, on every response including a reset and including a no-op poll — the
    // "always-full" of §2.4, and the one part of this payload whose correctness must not depend on
    // the delta stream having worked.
    denyList: await policyDenyList(driver),
    // THE POLICY-PARAMETER TIER — docs/design/disposable-nodes.md §6, riding the channel that
    // already exists rather than one built for it. Unconditional and small, exactly like the
    // deny-list above and for the same reason: a node must never be in the position of holding
    // current policy and stale parameters, or of having to make a second request to find out how
    // long it is allowed to keep enforcing.
    //
    // `nodeId` is optional, because /api/policy is also read by tests and by an operator with an
    // admin certificate. Without one, this is the fleet default with no profile applied — which is
    // the right answer to "what would a node with no profile be told".
    ...(await nodeConfigFor(driver, nodeId)),
  };
  if (reset) {
    return {
      ...base,
      reset: true,
      snapshot: {
        capabilities: (await driver.all('SELECT * FROM capabilities')).map(capOut),
        principals: (await driver.all('SELECT * FROM principals')).map(principalOut),
        grants: await driver.all('SELECT * FROM grants'),
      },
      changes: [],
      complete: true,
    };
  }
  const changes = await listPolicyChanges(driver, asked, { limit });
  return { ...base, reset: false, changes, complete: changes.length < limit };
}

/**
 * Record what a node says it now holds.
 *
 * Best-effort by construction — a failure here must never fail the pull it is describing, because
 * the pull is the thing that keeps a node's policy fresh and this is only how we watch it. It is
 * also why `lastPulledAt` moves on every pull while `replicaVersion` only ever goes forward: a node
 * that is stuck reports the same version on a moving clock, which is exactly the shape §2.6 wants
 * "frozen" to have on a dashboard, as against "gone".
 */
async function noteNodePull(driver, nodeId, { replicaVersion, schemaVersion, reset }) {
  if (!nodeId) return;
  await driver.query(
    `INSERT INTO node_policy_state ("nodeId", "replicaVersion", "schemaVersion", "lastPulledAt", "lastResetAt")
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT ("nodeId") DO UPDATE SET
       "replicaVersion" = GREATEST(node_policy_state."replicaVersion", EXCLUDED."replicaVersion"),
       "schemaVersion" = EXCLUDED."schemaVersion",
       "lastPulledAt" = now(),
       "lastResetAt" = COALESCE(EXCLUDED."lastResetAt", node_policy_state."lastResetAt")`,
    [nodeId, Number(replicaVersion) || 0, schemaVersion ?? null, reset ? new Date() : null]
  );
}

/** Every node's replica version against central's own — "who is behind, and by how much". */
async function nodePolicyState(driver) {
  const version = await policyVersion(driver);
  const rows = await driver.all('SELECT * FROM node_policy_state ORDER BY "lastPulledAt" DESC');
  return {
    centralVersion: version,
    nodes: rows.map((r) => ({
      ...r,
      replicaVersion: Number(r.replicaVersion),
      behindBy: version - Number(r.replicaVersion),
    })),
  };
}

// ---------------------------------------------------------------------------
// Auto-grant propagation
//
// The nodes get every grant either way — it appends to `policy_changes` and rides the delta stream
// ./policyRoutes.js already serves, and the deny-list rides every response in full. What propagation
// adds is not a second delivery path but an ANSWER to "who has it now": the set of nodes central can
// still reach inside the propagation window, computed at the moment a grant is issued and recorded
// so a caller can surface it rather than trust that "it replicated".
// ---------------------------------------------------------------------------

/**
 * The nodes connected to central right now — those whose last policy pull landed inside `windowMs`.
 *
 * `node_policy_state.lastPulledAt` moves on every pull (see noteNodePull), so it is central's freshest
 * evidence a node is still checking in. `asOf` is injectable so a test can anchor the window to a
 * fixed clock rather than wall time.
 */
async function connectedNodes(driver, { windowMs = PROPAGATION_WINDOW_MS, asOf = null } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const rows = await driver.all(
    'SELECT "nodeId", "replicaVersion", "lastPulledAt" FROM node_policy_state WHERE "lastPulledAt" >= $1 ORDER BY "lastPulledAt" DESC',
    [cutoff]
  );
  return rows.map((r) => ({ nodeId: r.nodeId, replicaVersion: Number(r.replicaVersion), lastPulledAt: r.lastPulledAt }));
}

/**
 * Split a set of connected nodes against a target version into those already carrying it and those
 * the pull still has to reach. Pure, so it is the unit the partition logic is tested through — the
 * SQL window (connectedNodes) needs a database, this needs nothing.
 */
function classifyPropagation(nodes, targetVersion) {
  const target = Number(targetVersion) || 0;
  const current = [];
  const pending = [];
  for (const n of nodes) {
    (Number(n.replicaVersion) >= target ? current : pending).push(n.nodeId);
  }
  return { current, pending };
}

/**
 * Propagate policy up to `targetVersion` to every currently-connected node, and report who it lands
 * on.
 *
 * The propagation is a POKE, never a payload: the grant is already in `policy_changes`, so this fires
 * the same version-bearing SSE notify a mutation schedules — idempotent, so a node already at the
 * target pulls nothing and one behind pulls once. The value it returns is the point: `pending` are
 * the connected nodes the grant is newly reaching, `current` those that already had it, and
 * `connected` the size of the live set inside the window. Nodes outside the window are absent by
 * design — they are not gone, they catch the identical grant on their next pull, which is exactly
 * what the always-full delta stream guarantees.
 */
async function propagateToConnected(driver, targetVersion, { windowMs = PROPAGATION_WINDOW_MS, asOf = null } = {}) {
  const nodes = await connectedNodes(driver, { windowMs, asOf });
  // One poke after the batch, whatever fired mid-batch: scheduleNotify coalesces to a single wake on
  // the next tick, and re-arming it here means the connected nodes are told to pull once the whole
  // package sync has committed rather than after each grant inside it.
  scheduleNotify(driver);
  const { current, pending } = classifyPropagation(nodes, targetVersion);
  return { targetVersion: Number(targetVersion) || 0, windowMs, connected: nodes.length, pending, current };
}

// ---------------------------------------------------------------------------
// Capabilities — central mints the id (§2.2)
// ---------------------------------------------------------------------------

async function listCapabilities(driver) {
  return (await driver.all('SELECT * FROM capabilities')).map(capOut);
}

async function findCapabilityById(driver, id) {
  return capOut(await driver.get('SELECT * FROM capabilities WHERE "id" = $1', [id]));
}

async function findCapabilityByKindName(driver, kind, name) {
  return capOut(await driver.get(
    'SELECT * FROM capabilities WHERE COALESCE("kind", \'\') = COALESCE($1, \'\') AND "name" = $2',
    [kind ?? null, name]
  ));
}

/**
 * Register a capability and return it with the id central assigned.
 *
 * The caller does NOT supply an id, and that signature change is phase 4 in one line: server/app.js
 * used to `genId('cap')` locally and hand the row to the store. It cannot any more, because an id
 * minted on one node is an id no other node would recognise, and a grant referencing it would be a
 * grant only that machine could evaluate.
 */
async function insertCapability(driver, input) {
  if (!input || !input.name) throw badRequest('name is required');
  if (!RISK_TIERS.includes(input.riskTier)) throw badRequest(`riskTier must be one of ${RISK_TIERS.join(', ')}`);
  // autoGrant bypasses the grant table entirely (server/app.js's findActiveGrant), so it is never
  // permitted on a destructive row. Checked here as well as at every caller, because "the authority
  // refuses it" and "the UI does not offer it" are different guarantees and only the first survives
  // a caller written next year.
  if (input.autoGrant && input.riskTier === 'destructive') {
    throw badRequest('destructive capabilities cannot be auto-granted');
  }
  // Skills are catalog-only (docs/design/skill-mcp-governance.md §0) — no grant gates one, so a
  // skill can never carry autoGrant either.
  if (input.autoGrant && (input.kind || null) === 'skill') {
    throw badRequest('skills are catalog-only and cannot be auto-granted');
  }
  const capability = {
    id: genId('cap'),
    kind: input.kind ?? null,
    name: input.name,
    owner: input.owner ?? null,
    riskTier: input.riskTier,
    description: input.description ?? null,
    autoGrant: Boolean(input.autoGrant),
    createdAt: new Date().toISOString(),
  };
  return driver.withTransaction(async (tx) => {
    try {
      await tx.query(
        `INSERT INTO capabilities ("id", "kind", "name", "owner", "riskTier", "description", "autoGrant", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [capability.id, capability.kind, capability.name, capability.owner, capability.riskTier,
          capability.description, capability.autoGrant, capability.createdAt]
      );
    } catch (err) {
      if (isUnique(err)) throw new CapabilityConflictError('a capability with this kind+name already exists');
      throw err;
    }
    await recordPolicyChange(tx, 'capability', capability.id, 'upsert', capability);
    scheduleNotify(driver);
    return capability;
  });
}

/**
 * The discovery path of §2.2 — "the node reports what it found, central owns the canonical
 * capability row and its id, the node keeps the mapping."
 *
 * Idempotent by (kind, name) rather than by id, because the node has no id to offer: that is the
 * thing it is asking for. A second node reporting the same tool gets the first node's row back
 * untouched — including its tier, which is the property that matters. Letting a later report
 * *change* the tier would make retiering a capability a race between an admin and whichever machine
 * next rescanned its filesystem, so a proposal only ever creates.
 */
async function resolveCapability(driver, { kind, name, riskTier, description, owner }) {
  if (!name) throw badRequest('name is required');
  const existing = await findCapabilityByKindName(driver, kind, name);
  if (existing) return { capability: existing, created: false };
  try {
    const capability = await insertCapability(driver, {
      kind,
      name,
      owner: owner ?? null,
      // A discovered capability with no tier stated is `read_only` — the least it can be, not the
      // most. An unknown tool arriving at its most permissive default is how a discovery channel
      // becomes an escalation channel.
      riskTier: RISK_TIERS.includes(riskTier) ? riskTier : 'read_only',
      description: description ?? null,
      autoGrant: false,
    });
    return { capability, created: true };
  } catch (err) {
    // Two nodes discovering the same tool in the same second. The loser reads the winner's row,
    // which is the answer it wanted — a conflict here is agreement arriving out of order.
    if (err instanceof CapabilityConflictError) {
      return { capability: await findCapabilityByKindName(driver, kind, name), created: false };
    }
    throw err;
  }
}

async function setCapabilityAutoGrant(driver, id, autoGrant) {
  return driver.withTransaction(async (tx) => {
    const before = await findCapabilityById(tx, id);
    if (!before) return null;
    if (autoGrant && before.riskTier === 'destructive') {
      throw badRequest('destructive capabilities cannot be auto-granted');
    }
    if (autoGrant && before.kind === 'skill') {
      throw badRequest('skills are catalog-only and cannot be auto-granted');
    }
    await tx.query('UPDATE capabilities SET "autoGrant" = $1 WHERE "id" = $2', [Boolean(autoGrant), id]);
    const after = await findCapabilityById(tx, id);
    await recordPolicyChange(tx, 'capability', id, 'upsert', after);
    scheduleNotify(driver);
    return after;
  });
}

// ---------------------------------------------------------------------------
// Skill distribution — the provisioning axis (migration 14). Separate from grants/auto-grant, which
// are enforcement: a skill has no call-time choke point (docs/design/skill-mcp-governance.md §0), so
// none of the functions above ever touch a skill. These do, and only these: `distribute` is read
// through GET /api/policy/skills (the node installer polls it) and never rides the policy delta, so
// it is queried directly here rather than surfaced through capOut.
// ---------------------------------------------------------------------------

/** The catalog's skills, each with its `distribute` flag — what the central Skills page renders and
 *  what the node installer filters to `distribute = true`. Skills only; MCP tools are not
 *  distributed (they are governed, and installing an MCP server is a different act). */
async function listSkills(driver) {
  const rows = await driver.all(
    `SELECT "id", "kind", "name", "owner", "riskTier", "description", "distribute", "createdAt"
       FROM capabilities WHERE "kind" = 'skill' ORDER BY "name"`
  );
  return rows.map((r) => ({ ...r, distribute: Boolean(r.distribute) }));
}

/** Mark (or unmark) a skill for fleet-wide install. Skills only — a non-skill is refused rather than
 *  silently flagged, because distributing an MCP tool means nothing (there is no file to write) and
 *  the flag would only mislead. Records an audit entry but NO policy_change: distribution rides its
 *  own channel, not the version-bearing delta, so bumping the policy version here would make every
 *  node re-pull policy for a change no node reads from the delta. */
async function setSkillDistribute(driver, id, distribute) {
  return driver.withTransaction(async (tx) => {
    const before = await findCapabilityById(tx, id);
    if (!before) return null;
    if (before.kind !== 'skill') throw badRequest('only skills can be distributed to the fleet');
    await tx.query('UPDATE capabilities SET "distribute" = $1 WHERE "id" = $2', [Boolean(distribute), id]);
    const row = await tx.get(
      `SELECT "id", "kind", "name", "owner", "riskTier", "description", "distribute", "createdAt"
         FROM capabilities WHERE "id" = $1`,
      [id]
    );
    return { ...row, distribute: Boolean(row.distribute) };
  });
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

async function listPrincipals(driver) {
  return (await driver.all('SELECT * FROM principals')).map(principalOut);
}

async function findPrincipalById(driver, id) {
  return principalOut(await driver.get('SELECT * FROM principals WHERE "id" = $1', [id]));
}

async function findPrincipalByKindName(driver, kind, name) {
  return principalOut(await driver.get('SELECT * FROM principals WHERE "kind" = $1 AND "name" = $2', [kind, name]));
}

async function findPrincipalBySubjectId(driver, subjectId) {
  return principalOut(await driver.get('SELECT * FROM principals WHERE "subjectId" = $1', [subjectId]));
}

async function insertPrincipal(driver, input) {
  const principal = {
    id: genId('pr'),
    kind: input.kind,
    name: input.name,
    subjectId: input.subjectId ?? null,
    assuranceLevel: input.assuranceLevel ?? null,
    parentRole: input.parentRole ?? null,
    humanName: input.humanName ?? null,
    backend: input.backend ?? null,
    agentType: input.agentType ?? null,
    field: input.field ?? null,
    standalone: Boolean(input.standalone),
    status: input.status || 'active',
    owner: input.owner ?? null,
    createdAt: new Date().toISOString(),
  };
  return driver.withTransaction(async (tx) => {
    try {
      await tx.query(
        `INSERT INTO principals ("id", "kind", "name", "subjectId", "assuranceLevel", "parentRole", "humanName",
                                 "backend", "agentType", "field", "standalone", "status", "owner", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [principal.id, principal.kind, principal.name, principal.subjectId, principal.assuranceLevel,
          principal.parentRole, principal.humanName, principal.backend, principal.agentType, principal.field,
          principal.standalone, principal.status, principal.owner, principal.createdAt]
      );
    } catch (err) {
      if (isUnique(err)) throw new PrincipalConflictError('a principal with this kind+name (or subject) already exists');
      throw err;
    }
    await recordPolicyChange(tx, 'principal', principal.id, 'upsert', principal);
    scheduleNotify(driver);
    return principal;
  });
}

/** Narrow column updates. One helper rather than four near-identical functions, because every one
 *  of them is "set a column, re-read the row, log the change" and the interesting part — which
 *  columns a caller is allowed to touch — belongs at the caller, not repeated here. */
const PRINCIPAL_MUTABLE = new Set(['status', 'name', 'owner', 'humanName', 'parentRole', 'assuranceLevel']);

// The LIFECYCLE vocabulary, and the whole of it. Validated here rather than trusted from a caller
// because this column is not merely descriptive: `policyDenyList` blocks every principal whose
// status is not 'active', so a word this set does not contain is an agent that stops working
// fleet-wide, reported to it as "revoked". One caller did exactly that — the node's
// setPrincipalOwner sent the OWNER decision ('confirmed'), which is a different vocabulary for a
// different column (see server/policy/centralPolicyStore.js). That is fixed at the source; this
// makes it unwritable rather than merely un-sent, since the failure is silent, fleet-wide and
// indistinguishable from a revocation once it has happened.
const PRINCIPAL_STATUSES = new Set(['active', 'pending', 'denied']);

async function updatePrincipal(driver, id, patch) {
  const entries = Object.entries(patch).filter(([k]) => PRINCIPAL_MUTABLE.has(k));
  if (entries.length === 0) throw badRequest(`nothing updatable in ${Object.keys(patch).join(', ') || '(empty patch)'}`);
  const status = patch.status;
  if (status !== undefined && !PRINCIPAL_STATUSES.has(status)) {
    throw badRequest(
      `status must be one of ${[...PRINCIPAL_STATUSES].join(', ')} — got "${status}". `
        + 'A principal whose status is not "active" is on the always-full deny list and cannot make a governed call.'
    );
  }
  return driver.withTransaction(async (tx) => {
    const before = await findPrincipalById(tx, id);
    if (!before) return null;
    const set = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
    await tx.query(`UPDATE principals SET ${set} WHERE "id" = $1`, [id, ...entries.map(([, v]) => v)]);
    const after = await findPrincipalById(tx, id);
    await recordPolicyChange(tx, 'principal', id, 'upsert', after);
    scheduleNotify(driver);
    return after;
  });
}

/**
 * The hook path's one registry write, now fleet-wide: register the role and instance behind an
 * agent, and the user principal behind the OS account, in ONE transaction.
 *
 * The node's server/store.js has the same function and the same two-row shape. What changes at
 * central is what "already exists" means — a role row for `claude` created by a laptop in one
 * office is the row a workstation in another is handed, so an admin who approves it approves it
 * once. §1.4's identityDrift rule is unchanged and deliberately so: the REGISTERED values stand,
 * because overwriting them re-attributes every historical event to whoever reported last.
 */
async function upsertPrincipalIdentity(driver, roleName, identity) {
  return driver.withTransaction(async (tx) => {
    const out = { roleCreated: false, instanceCreated: false, identityFilled: false, identityDrift: [] };

    let role = await findPrincipalByKindName(tx, 'role', roleName);
    if (!role) {
      role = await insertPrincipalTx(tx, {
        kind: 'role',
        name: roleName,
        // A role minted by first sighting holds zero grants until a human approves it — the same rule,
        // and the reason a fleet-wide registry is safe to let a node write into at all.
        status: 'pending',
        backend: identity.backend ?? null,
        agentType: identity.agentType ?? null,
      });
      out.roleCreated = true;
    }
    out.role = role;

    let instance = await findPrincipalByKindName(tx, 'instance', identity.loomId);
    if (!instance) {
      instance = await insertPrincipalTx(tx, {
        kind: 'instance',
        name: identity.loomId,
        parentRole: roleName,
        humanName: identity.humanName ?? null,
        backend: identity.backend ?? null,
        agentType: identity.agentType ?? null,
        field: identity.field ?? null,
        standalone: Boolean(identity.standalone),
        status: 'active',
      });
      out.instanceCreated = true;
    } else {
      // Fill what was never recorded; never overwrite what was. The difference is the whole of
      // want-mszgwf94-14 — see the drift note below.
      const fill = {};
      for (const field of ['humanName', 'backend', 'agentType', 'field']) {
        const observed = identity[field] ?? null;
        if (observed == null) continue;
        if (instance[field] == null) fill[field] = observed;
        else if (instance[field] !== observed) out.identityDrift.push({ field, registered: instance[field], observed });
      }
      if (Object.keys(fill).length > 0) {
        const set = Object.keys(fill).map((k, i) => `"${k}" = $${i + 2}`).join(', ');
        await tx.query(`UPDATE principals SET ${set} WHERE "id" = $1`, [instance.id, ...Object.values(fill)]);
        instance = await findPrincipalById(tx, instance.id);
        await recordPolicyChange(tx, 'principal', instance.id, 'upsert', instance);
        out.identityFilled = true;
      }
    }
    out.instance = instance;

    // The subject (§1.4). Keyed on subjectId, which is why it is looked up by that and not by name:
    // an OS account gets renamed and the row should follow.
    if (identity.subjectId) {
      let subject = await findPrincipalBySubjectId(tx, identity.subjectId);
      if (!subject) {
        subject = await insertPrincipalTx(tx, {
          kind: 'user',
          name: identity.osUser || identity.subjectId,
          subjectId: identity.subjectId,
          assuranceLevel: identity.assuranceLevel ?? null,
          // `pending`, matching the role above and matching this function's own SQLite twin
          // (server/store.js `upsertSubjectPrincipalTx`). It used to be 'active' here and only
          // here, and the divergence was not cosmetic: `POST /api/principals/:id/approve` is what
          // issues a principal's read-only baseline, and it refuses anything that is not pending.
          // So on a fleet under central authority — the only deployment that reaches this file — a
          // person was born already-active, could never be approved, and therefore never received
          // the baseline that docs/design/grant-resolution-semantics.md makes half of every
          // decision. A subject with no grants denies every user-keyed evaluation, which is exactly
          // what the shadow numbers were reporting.
          //
          // This does put a newly-sighted person on the §2.4 deny-list until an admin approves
          // them, which is the same treatment a newly-sighted role gets and is that same rule. It denies
          // nothing today: server/hooks/lib.js `policyChannelGate` compares that list against the
          // *instance* principal it resolved, and never against the subject.
          status: 'pending',
        });
      } else if (
        // Assurance RATCHETS UP and never comes back down: it answers "how well has this person
        // ever been identified", and a single run whose SID read failed must not downgrade the row.
        Number.isFinite(identity.assuranceLevel)
        && identity.assuranceLevel > (subject.assuranceLevel ?? 0)
      ) {
        await tx.query('UPDATE principals SET "assuranceLevel" = $1 WHERE "id" = $2', [identity.assuranceLevel, subject.id]);
        subject = await findPrincipalById(tx, subject.id);
        await recordPolicyChange(tx, 'principal', subject.id, 'upsert', subject);
      }
      out.subject = subject;
    }

    scheduleNotify(driver);
    return out;
  });
}

/** insertPrincipal's body without its own transaction — for use inside one that is already open.
 *  ./pgDriver.js's `withTransaction` joins rather than nests when handed a client, so calling the
 *  public function here would work; this exists so the *intent* is visible at the call site rather
 *  than resting on that. */
async function insertPrincipalTx(tx, input) {
  const principal = {
    id: genId('pr'),
    kind: input.kind,
    name: input.name,
    subjectId: input.subjectId ?? null,
    assuranceLevel: input.assuranceLevel ?? null,
    parentRole: input.parentRole ?? null,
    humanName: input.humanName ?? null,
    backend: input.backend ?? null,
    agentType: input.agentType ?? null,
    field: input.field ?? null,
    standalone: Boolean(input.standalone),
    status: input.status || 'active',
    owner: input.owner ?? null,
    createdAt: new Date().toISOString(),
  };
  try {
    await tx.query(
      `INSERT INTO principals ("id", "kind", "name", "subjectId", "assuranceLevel", "parentRole", "humanName",
                               "backend", "agentType", "field", "standalone", "status", "owner", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [principal.id, principal.kind, principal.name, principal.subjectId, principal.assuranceLevel,
        principal.parentRole, principal.humanName, principal.backend, principal.agentType, principal.field,
        principal.standalone, principal.status, principal.owner, principal.createdAt]
    );
  } catch (err) {
    if (isUnique(err)) throw new PrincipalConflictError('a principal with this kind+name (or subject) already exists');
    throw err;
  }
  await recordPolicyChange(tx, 'principal', principal.id, 'upsert', principal);
  return principal;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

async function listGrants(driver, { principalId, capabilityId } = {}) {
  const where = [];
  const params = [];
  if (principalId) { params.push(principalId); where.push(`"principalId" = $${params.length}`); }
  if (capabilityId) { params.push(capabilityId); where.push(`"capabilityId" = $${params.length}`); }
  const sql = `SELECT * FROM grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  return driver.all(sql, params);
}

async function findGrantById(driver, id) {
  return driver.get('SELECT * FROM grants WHERE "id" = $1', [id]);
}

async function findGrant(driver, principalId, capabilityId) {
  return driver.get(
    'SELECT * FROM grants WHERE "principalId" = $1 AND "capabilityId" = $2 AND "revokedAt" IS NULL',
    [principalId, capabilityId]
  );
}

async function insertGrant(driver, input) {
  if (!input || !input.principalId || !input.capabilityId) throw badRequest('principalId and capabilityId are required');
  const grant = {
    id: genId('gr'),
    principalId: input.principalId,
    capabilityId: input.capabilityId,
    constraints: input.constraints ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    revokedBy: null,
  };
  return driver.withTransaction(async (tx) => {
    // Referential checks INSIDE the transaction and against central's own tables: a grant to a
    // principal or capability that does not exist here is a grant no node could ever evaluate,
    // and there is no foreign key doing it for us — the rows are written by the same process but
    // the ids arrive from callers.
    if (!(await findPrincipalById(tx, grant.principalId))) throw notFound('principal not found');
    const capability = await findCapabilityById(tx, grant.capabilityId);
    if (!capability) throw notFound('capability not found');
    // Skills are catalog-only (docs/design/skill-mcp-governance.md §0): there is no PreToolUse
    // choke point that could enforce a skill grant, so a grant row against one governs nothing and
    // only makes the Grants page imply a control that does not exist. Refused at the authority as
    // well as at every caller, so the invariant cannot be reached "the other way".
    if (capability.kind === 'skill') throw badRequest('skills are catalog-only and cannot be granted');
    try {
      await tx.query(
        `INSERT INTO grants ("id", "principalId", "capabilityId", "constraints", "createdAt", "expiresAt")
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [grant.id, grant.principalId, grant.capabilityId, grant.constraints, grant.createdAt, grant.expiresAt]
      );
    } catch (err) {
      // The partial unique index on live rows, not a pre-check against a snapshot that could go
      // stale between the read and the write — which is what makes two concurrent grants for the
      // same pair a 409 rather than two rows.
      if (isUnique(err)) throw new GrantConflictError('a grant for this principal+capability already exists');
      throw err;
    }
    await recordPolicyChange(tx, 'grant', grant.id, 'upsert', grant);
    scheduleNotify(driver);
    return grant;
  });
}

/**
 * Revoke — a soft delete, so "who had this and who took it away" survives.
 *
 * This is the write §2.4 is entirely about: the row's `revokedAt` is what puts it on the deny-list
 * that every node fetches in full on every poll, so a revoke lands on a node whose delta stream is
 * broken, whose replica is frozen for schema skew, and whose SSE connection a proxy closed an hour
 * ago. Nothing else in this file has that property and nothing else needs it.
 */
async function revokeGrant(driver, id, revokedBy) {
  return driver.withTransaction(async (tx) => {
    const result = await tx.query(
      'UPDATE grants SET "revokedAt" = $1, "revokedBy" = $2 WHERE "id" = $3 AND "revokedAt" IS NULL',
      [new Date().toISOString(), revokedBy ?? null, id]
    );
    if (!result.rowCount) return null;
    const grant = await findGrantById(tx, id);
    await recordPolicyChange(tx, 'grant', id, 'revoke', grant);
    scheduleNotify(driver);
    return grant;
  });
}

// ---------------------------------------------------------------------------
// Approvals — policy *proposals*, on the same side of the seam as the grants they decide into
// ---------------------------------------------------------------------------

async function listApprovals(driver, { status } = {}) {
  const rows = status
    ? await driver.all('SELECT * FROM approvals WHERE "status" = $1 ORDER BY "requestedAt" DESC', [status])
    : await driver.all('SELECT * FROM approvals ORDER BY "requestedAt" DESC');
  return rows.map(approvalOut);
}

async function findApprovalById(driver, id) {
  return approvalOut(await driver.get('SELECT * FROM approvals WHERE "id" = $1', [id]));
}

async function insertApproval(driver, input) {
  const approval = {
    id: genId('ap'),
    action: input.action,
    status: 'pending',
    principalId: input.principalId ?? null,
    capabilityId: input.capabilityId ?? null,
    payload: input.payload ?? {},
    requestedByScope: input.requestedByScope || 'proposer',
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    decidedByScope: null,
    reason: null,
    resultGrantId: null,
  };
  await driver.query(
    `INSERT INTO approvals ("id","action","status","principalId","capabilityId","payload","requestedByScope","requestedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [approval.id, approval.action, approval.status, approval.principalId, approval.capabilityId,
      JSON.stringify(approval.payload), approval.requestedByScope, approval.requestedAt]
  );
  // Deliberately NOT a policy change: an approval decides nothing until it is approved, and a node
  // that replicated the queue would be replicating a question. The grant it becomes is the change.
  return approval;
}

async function decideApproval(driver, id, { status, decidedByScope, reason, resultGrantId }) {
  const result = await driver.query(
    `UPDATE approvals SET "status" = $1, "decidedAt" = $2, "decidedByScope" = $3, "reason" = $4, "resultGrantId" = $5
     WHERE "id" = $6 AND "status" = 'pending'`,
    [status, new Date().toISOString(), decidedByScope ?? null, reason ?? null, resultGrantId ?? null, id]
  );
  if (!result.rowCount) return null;
  return findApprovalById(driver, id);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function recordAuditEntry(driver, entry) {
  const row = {
    id: genId('au'),
    action: entry.action,
    actorScope: entry.actorScope || 'unknown',
    osUser: entry.osUser ?? null,
    hostname: entry.hostname ?? null,
    nodeId: entry.nodeId ?? null,
    principalId: entry.principalId ?? null,
    capabilityId: entry.capabilityId ?? null,
    grantId: entry.grantId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    createdAt: new Date().toISOString(),
  };
  await driver.query(
    `INSERT INTO windrow_audit ("id","action","actorScope","osUser","hostname","nodeId","principalId","capabilityId","grantId","before","after","reason","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.id, row.action, row.actorScope, row.osUser, row.hostname, row.nodeId, row.principalId, row.capabilityId,
      row.grantId, row.before === null ? null : JSON.stringify(row.before),
      row.after === null ? null : JSON.stringify(row.after), row.reason, row.createdAt]
  );
  return row;
}

async function listAudit(driver, { limit = 200 } = {}) {
  return driver.all('SELECT * FROM windrow_audit ORDER BY "createdAt" DESC LIMIT $1', [Math.min(Number(limit) || 200, 1000)]);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NODE PROFILES — docs/design/disposable-nodes.md §5's design call, central's half.
//
// A profile is a CLASS LABEL with a ceiling attached: `laptop` may not host destructive, the deploy
// MCP only on `ci`. It is keyed on the label and never on a nodeId, because per-machine policy is
// per-machine state and per-machine state is the thing disposability deletes — a rebuilt node
// re-enrols INTO a profile rather than carrying one.
//
// EVERY DIAL CAN ONLY NARROW, and that is what makes this safe to AND onto the fleet-wide decision
// with no precedence rule. The set of dials is ../policy/nodeConfig.js's PARAMETERS, which is also
// where each one's merge direction is declared; a key outside that set is REFUSED here rather than
// stored, because a stored setting nobody reads is exactly the "documented limit that is actually
// decoration" failure this whole design is trying not to repeat.
// ---------------------------------------------------------------------------

const { PARAMETER_KEYS } = require('../policy/nodeConfig');

function profileOut(row) {
  if (!row) return null;
  return {
    name: row.name,
    description: row.description ?? null,
    config: row.config || {},
    constraints: row.constraints ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listNodeProfiles(driver) {
  return (await driver.all('SELECT * FROM node_profiles ORDER BY name ASC')).map(profileOut);
}

async function findNodeProfile(driver, name) {
  return profileOut(await driver.get('SELECT * FROM node_profiles WHERE name = $1', [name]));
}

/**
 * Create or replace a profile.
 *
 * `config` is validated against nodeConfig.js's key set BEFORE it is written. An unknown key is a
 * 400 naming it, not a stored value: a profile that says `maxTeir: 'read_only'` and is accepted
 * looks exactly like one that works, right up until the machine it was meant to constrain does
 * something destructive.
 *
 * Deliberately NOT recorded in `policy_changes`. That log is the delta stream's version history for
 * capabilities, principals and grants, and its single global monotonic version is what makes
 * `reset` work; a profile edit is not a policy row and inserting one would advance every node's
 * replica version for a change none of them can apply. Profiles reach nodes on the SAME response by
 * a different mechanism — ./policyStore.js nodeConfigFor recomputes the block on every pull — so a
 * profile change is live at the next poll without touching the change log at all.
 */
async function upsertNodeProfile(driver, { name, description = null, config = {}, constraints = null }) {
  const label = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(label)) {
    throw badRequest('a profile name is 2-32 characters of lowercase letters, digits, dot, dash or underscore');
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw badRequest('config must be an object of node-config parameters');
  }
  const unknown = Object.keys(config).filter((k) => !PARAMETER_KEYS.includes(k));
  if (unknown.length) {
    throw badRequest(
      `unknown node-config parameter(s): ${unknown.join(', ')}. Known: ${PARAMETER_KEYS.join(', ')}`
    );
  }
  const now = new Date().toISOString();
  const rows = await driver.all(
    `INSERT INTO node_profiles (name, description, config, constraints, "createdAt", "updatedAt")
     VALUES ($1, $2, $3::JSONB, $4::JSONB, $5, $5)
     ON CONFLICT (name) DO UPDATE SET
       description = EXCLUDED.description,
       config = EXCLUDED.config,
       constraints = EXCLUDED.constraints,
       "updatedAt" = EXCLUDED."updatedAt"
     RETURNING *`,
    [label, description, JSON.stringify(config), constraints ? JSON.stringify(constraints) : null, now]
  );
  return profileOut(rows[0]);
}

async function deleteNodeProfile(driver, name) {
  // The nodes in it are cleared rather than left pointing at nothing: a node whose profile has been
  // deleted holds no ceiling, and it should learn that on its next pull rather than keep enforcing
  // a ceiling nobody can see or edit any more.
  await driver.query('UPDATE nodes SET profile = NULL WHERE profile = $1', [name]);
  const res = await driver.query('DELETE FROM node_profiles WHERE name = $1', [name]);
  return { deleted: (res && res.rowCount) || 0 };
}

/** Put a node in a profile, or take it out with `null`. */
async function setNodeProfile(driver, nodeId, profile) {
  if (profile) {
    const found = await findNodeProfile(driver, profile);
    if (!found) throw notFound(`no such node profile: ${profile}`);
  }
  const res = await driver.query('UPDATE nodes SET profile = $2 WHERE "nodeId" = $1', [nodeId, profile || null]);
  if (!res || !res.rowCount) throw notFound(`no such node: ${nodeId}`);
  return { nodeId, profile: profile || null };
}

/**
 * THE BLOCK THAT RIDES EVERY POLICY RESPONSE — docs/design/disposable-nodes.md §6.
 *
 * It is this node's profile's `config`, and nothing else. Notably it is NOT central's own defaults
 * merged in: a parameter central has no opinion about must arrive ABSENT rather than as a value,
 * because ../policy/nodeConfig.js reads absent as "the node's own setting stands" and reads a value
 * as a ceiling. Sending central's default for every key would silently overwrite every local floor
 * in the fleet with a number nobody chose.
 *
 * A node with no profile, or a nodeId we do not recognise, gets null — the same answer a standalone
 * install computes for itself.
 */
async function nodeConfigFor(driver, nodeId) {
  if (!nodeId) return { nodeConfig: null, nodeProfile: null };
  const row = await driver.get(
    `SELECT p.name, p.config, p.constraints
       FROM nodes n JOIN node_profiles p ON p.name = n.profile
      WHERE n."nodeId" = $1`,
    [nodeId]
  );
  if (!row) return { nodeConfig: null, nodeProfile: null };
  return {
    nodeConfig: row.config && Object.keys(row.config).length ? row.config : null,
    // The constraint leg travels SEPARATELY from the parameters, and the split is not cosmetic.
    // `nodeConfig` is the policy-parameter tier — a flat map of dials whose merge rule
    // ../policy/nodeConfig.js declares per key, and which it validates the key set of. Constraints
    // are a different vocabulary with a different merge (grant-resolution-semantics.md §2.1) and a
    // different consumer (server/app.js's shadow evaluator). Folding them into one blob would mean
    // one of the two validators had to start ignoring keys it did not recognise, which is exactly
    // the failure both of them exist to prevent.
    nodeProfile: { name: row.name, constraints: row.constraints ?? null },
  };
}

/** A caller error, carried as a status so ./routes.js's `wrap` turns it into the right code rather
 *  than a 500 that reads as "central is broken" when the request was. */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  MAX_CHANGES,
  PROPAGATION_WINDOW_MS,
  RISK_TIERS,
  GrantConflictError,
  CapabilityConflictError,
  PrincipalConflictError,

  onPolicyChange,
  recordPolicyChange,
  policyVersion,
  policyChangeFloor,
  policyDenyList,
  listPolicyChanges,
  policyDelta,
  noteNodePull,
  nodePolicyState,
  connectedNodes,
  classifyPropagation,
  propagateToConnected,

  listNodeProfiles,
  findNodeProfile,
  upsertNodeProfile,
  deleteNodeProfile,
  setNodeProfile,
  nodeConfigFor,

  listCapabilities,
  findCapabilityById,
  findCapabilityByKindName,
  insertCapability,
  resolveCapability,
  setCapabilityAutoGrant,
  listSkills,
  setSkillDistribute,

  listPrincipals,
  findPrincipalById,
  findPrincipalByKindName,
  findPrincipalBySubjectId,
  insertPrincipal,
  updatePrincipal,
  upsertPrincipalIdentity,

  listGrants,
  findGrant,
  findGrantById,
  insertGrant,
  revokeGrant,

  listApprovals,
  findApprovalById,
  insertApproval,
  decideApproval,

  recordAuditEntry,
  listAudit,
};
