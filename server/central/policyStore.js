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
  return { ...row, autoGrant: Boolean(row.autoGrant) };
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
async function policyDelta(driver, since = 0, { limit = MAX_CHANGES } = {}) {
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
    await tx.query('UPDATE capabilities SET "autoGrant" = $1 WHERE "id" = $2', [Boolean(autoGrant), id]);
    const after = await findCapabilityById(tx, id);
    await recordPolicyChange(tx, 'capability', id, 'upsert', after);
    scheduleNotify(driver);
    return after;
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
    if (!(await findCapabilityById(tx, grant.capabilityId))) throw notFound('capability not found');
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

  listCapabilities,
  findCapabilityById,
  findCapabilityByKindName,
  insertCapability,
  resolveCapability,
  setCapabilityAutoGrant,

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
