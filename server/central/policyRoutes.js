'use strict';

// Central's policy surface — phase 4 of docs/design/global-identity-and-central-db.md §2.7, and the
// route table ./routes.js's header used to say was "deliberately absent".
//
// It is absent no longer, and the sentence it replaces is worth keeping in view: phase 3 promised
// that "central cannot change any node's behaviour because there is no route by which it could".
// Everything below is that route. What keeps the change safe is not that central is powerless any
// more — it is that a node partitioned from central still enforces from its replica for
// MAX_POLICY_AGE (§2.8), and that the only thing central can do *quickly* is take permission away.
//
// THREE GROUPS OF ROUTE, and the scope each one needs is the design rather than an ACL:
//
//   READ — GET /api/policy, /api/policy/deny-list, /api/policy/events
//     A NODE certificate. This is the replication channel: the node pulls deltas, the deny-list
//     rides every response in full, and SSE pokes it to pull now. All three of §2.4's channels,
//     served from the authority instead of from the node's own tables. The payload is byte-for-byte
//     the shape server/policy/replica.js already applies, which is what makes phase 4 a change of
//     *which machine answers* rather than a rewrite of the client.
//
//   PROPOSE — POST /api/policy/capabilities/resolve, POST /api/policy/principals/resolve
//     A NODE certificate, and the two writes a node is allowed to cause. Both are §2.2's discovery
//     direction: "the node reports what it found, central owns the canonical capability row and its
//     id." A node can bring a row into existence; it cannot decide what that row is permitted to do.
//     A discovered capability lands at `read_only`, a first-sighted role lands `pending` with no
//     grants, and turning either into permission takes an admin.
//
//   DECIDE — everything else. An ADMIN certificate. Registering a capability with a stated tier,
//     issuing a grant, revoking one, approving a principal, retiering. This is the set that used to
//     be `requireAdmin` on each node's own express app, where "admin" meant a bearer token sitting
//     on the same disk as the agent token it was supposed to outrank.
//
// WHY A NODE CERTIFICATE CAN READ THE WHOLE POLICY. It replicates it — there is no smaller thing to
// give it. §2.8's last row states the exposure honestly and declines to pretend it is new: "users'
// PCs hold a full policy replica — already true; grants are readable in the local DB today."

const express = require('express');
const store = require('./store');
const policyStore = require('./policyStore');
const packages = require('./packages');

/** How long a held SSE connection may go quiet before a comment is written down it. Under the
 *  common 30s/60s proxy idle ceilings, for the reason server/policy/routes.js gives. */
const HEARTBEAT_MS = 25_000;

/**
 * Mount the policy routes on `app`.
 *
 * `requireCert` is injected from ./routes.js rather than re-implemented, so there is exactly one
 * definition of what an authenticated node is and one place the insecure-loopback carve-out lives.
 * A second copy would be the obvious place for the two to drift apart, and the direction it would
 * drift is the dangerous one — this file's routes are the ones that hand out policy.
 */
function mountPolicyRoutes(app, { requireCert, wrap }) {
  const node = requireCert(['node', 'admin']);
  const admin = requireCert(['admin']);
  const d = () => store.requireDriver();
  const json = express.json({ limit: '256kb' });

  // ------------------------------------------------------------------ read: the replica channel

  app.get('/api/policy', node, wrap(async (req, res) => {
    const raw = Number.parseInt(req.query.since, 10);
    const since = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || policyStore.MAX_CHANGES, policyStore.MAX_CHANGES);
    // `nodeId` comes off the CERTIFICATE, never a query parameter, for the same reason the pull
    // record below does — and here it matters more: it selects the profile whose ceiling this node
    // will be told to hold itself to (docs/design/disposable-nodes.md §5, §6). A node that could
    // name its own would be a node that could choose its own ceiling, which is not a ceiling.
    const delta = await policyStore.policyDelta(d(), since, { limit, nodeId: req.nodeId || null });
    // Recorded from the certificate, never from a query parameter: "which nodes are behind" is a
    // fleet-health number, and one a node could set for itself would be worth nothing. It is also
    // why this is best-effort — a failure to note the pull must not fail the pull.
    if (req.nodeId) {
      policyStore
        .noteNodePull(d(), req.nodeId, { replicaVersion: delta.version, schemaVersion: delta.schemaVersion, reset: delta.reset })
        .catch((err) => console.error('[central-policy] could not record the pull for', req.nodeId, '—', err.message));
    }
    // A node caches nothing about this by URL — `since` moves every time — and an intermediary that
    // did would be handing out a stale policy version, which is the one thing this channel exists
    // to prevent.
    res.set('Cache-Control', 'no-store');
    res.json(delta);
  }));

  // ------------------------------------------------------------- node profiles (admin → central)
  //
  // docs/design/disposable-nodes.md §5. A profile is a class label with a narrowing ceiling on it;
  // putting a node in one is how a fleet says "that box is a laptop" without writing per-machine
  // policy, which is the state disposability deletes.

  app.get('/api/policy/node-profiles', admin, wrap(async (req, res) => {
    res.json({ profiles: await policyStore.listNodeProfiles(d()) });
  }));

  app.put('/api/policy/node-profiles/:name', admin, json, wrap(async (req, res) => {
    const body = req.body || {};
    res.json(await policyStore.upsertNodeProfile(d(), {
      name: req.params.name,
      description: body.description,
      config: body.config || {},
      constraints: body.constraints ?? null,
    }));
  }));

  app.delete('/api/policy/node-profiles/:name', admin, wrap(async (req, res) => {
    res.json(await policyStore.deleteNodeProfile(d(), req.params.name));
  }));

  // Which profile a node is in. A PUT on the node rather than a list on the profile, because the
  // question an operator answers is "what kind of machine is this" and they answer it once, when
  // the machine appears.
  app.put('/api/policy/nodes/:nodeId/profile', admin, json, wrap(async (req, res) => {
    const profile = (req.body && req.body.profile) || null;
    res.json(await policyStore.setNodeProfile(d(), req.params.nodeId, profile));
  }));

  /**
   * The deny-list on its own.
   *
   * Redundant with the `denyList` on every /api/policy response, and that redundancy is the point:
   * this is what a node can still use once it has decided its delta stream is broken and is
   * refusing to apply what /api/policy sends. No version dependency, no state on either side.
   */
  app.get('/api/policy/deny-list', node, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ schemaVersion: policyStore.POLICY_SCHEMA_VERSION, ...(await policyStore.policyDenyList(d())) });
  }));

  /**
   * The push channel. Emits `{version}` on connect and after every policy mutation, and carries no
   * policy at all — a push that carried data would be a second, weaker copy of the pull with its
   * own ordering bugs.
   */
  app.get('/api/policy/events', node, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which for SSE means the poke arrives batched
      // with the next one — turning a sub-second channel into an unbounded one.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (version) => {
      try {
        res.write(`event: policy\ndata: ${JSON.stringify({ version })}\n\n`);
      } catch {
        /* the socket went away between the notify and the write — the close handler cleans up */
      }
    };

    res.write('retry: 5000\n\n');
    // On connect matters as much as on change: a node reconnecting after a dropped connection has
    // no idea whether anything happened while it was away, and an immediate version tells it
    // without a special "what did I miss" request. The event is idempotent — a node already at N
    // pulls nothing.
    policyStore.policyVersion(d()).then(send).catch(() => send(0));

    const unsubscribe = policyStore.onPolicyChange(send);
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* see above */ }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    // Both, not just 'close': a client that goes away mid-write emits 'error' and never 'close' on
    // some Node versions, and a leaked listener would keep a dead response in the notify set for
    // the life of the process.
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  // ------------------------------------------------------------------ propose: what a node may do

  /**
   * §2.2's discovery path. A node reports a (kind, name) it found on its own filesystem; central
   * answers with the canonical row, minting it if this is the first sighting anywhere in the fleet.
   *
   * The id in the response is the entire point. Before phase 4 each node minted its own, so two
   * machines running the same MCP server held two capability rows with two ids and a grant issued
   * against one was invisible to the other — a fleet registry that agreed on vocabulary and nothing
   * else.
   */
  app.post('/api/policy/capabilities/resolve', node, json, wrap(async (req, res) => {
    const { kind, name, riskTier, description, owner } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await policyStore.resolveCapability(d(), { kind, name, riskTier, description, owner });
    if (result.created) {
      await policyStore.recordAuditEntry(d(), {
        action: 'capability_discovered',
        actorScope: req.authScope,
        nodeId: req.nodeId,
        capabilityId: result.capability.id,
        after: result.capability,
        reason: 'reported by a node during discovery',
      });
    }
    res.status(result.created ? 201 : 200).json(result.capability);
  }));

  /**
   * The hook path's registration, moved to the authority. A node's `POST /api/principals/resolve`
   * (server/app.js) proxies here when authority is central, so the ids a hook caches are ids the
   * whole fleet agrees on.
   */
  app.post('/api/policy/principals/resolve', node, json, wrap(async (req, res) => {
    const identity = req.body || {};
    if (!identity.loomId || typeof identity.loomId !== 'string') {
      return res.status(400).json({ error: 'loomId is required' });
    }
    // Rejected rather than ignored, exactly as on the node: an unprefixed key is the one failure
    // mode the authority prefix exists to prevent — a bare `1001` from Windows and a bare `1001`
    // from Linux are different people who would land on the same UNIQUE row (§1.4). Fleet-wide,
    // that row is now shared by every machine, so the collision it prevents is worse here.
    if (identity.subjectId != null
      && (typeof identity.subjectId !== 'string' || !/^(win-sid|posix|env-user|federated):.+/.test(identity.subjectId))) {
      return res.status(400).json({ error: 'subjectId must be prefixed by its authority (win-sid:, posix:, env-user:, federated:)' });
    }
    const roleName = typeof identity.roleName === 'string' && identity.roleName ? identity.roleName : identity.agentType || 'unknown';
    const result = await policyStore.upsertPrincipalIdentity(d(), roleName, identity);
    if (result.identityDrift && result.identityDrift.length) {
      const changes = result.identityDrift.map((x) => `${x.field}: ${x.registered} -> ${x.observed}`).join(', ');
      console.warn('[central-policy] identity drift for', identity.loomId, 'from node', req.nodeId, '— keeping registered values —', changes);
    }
    res.json({ role: result.role, instance: result.instance, subject: result.subject || null });
  }));

  // ------------------------------------------------------------------ decide: admin only

  app.get('/api/policy/capabilities', node, wrap(async (req, res) => {
    res.json(await policyStore.listCapabilities(d()));
  }));

  app.post('/api/policy/capabilities', admin, json, wrap(async (req, res) => {
    try {
      const capability = await policyStore.insertCapability(d(), req.body || {});
      await policyStore.recordAuditEntry(d(), {
        action: 'capability_register',
        actorScope: req.authScope,
        nodeId: req.nodeId,
        capabilityId: capability.id,
        after: capability,
        reason: (req.body && req.body.reason) || null,
      });
      res.status(201).json(capability);
    } catch (err) {
      if (err instanceof policyStore.CapabilityConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }));

  app.patch('/api/policy/capabilities/:id/auto-grant', admin, json, wrap(async (req, res) => {
    const { autoGrant } = req.body || {};
    if (typeof autoGrant !== 'boolean') return res.status(400).json({ error: 'autoGrant must be a boolean' });
    const before = await policyStore.findCapabilityById(d(), req.params.id);
    if (!before) return res.status(404).json({ error: 'capability not found' });
    const after = await policyStore.setCapabilityAutoGrant(d(), req.params.id, autoGrant);
    await policyStore.recordAuditEntry(d(), {
      action: 'capability_auto_grant_set',
      actorScope: req.authScope,
      capabilityId: before.id,
      before,
      after,
    });
    res.json(after);
  }));

  // ------------------------------------------------------------------ skill distribution
  //
  // The provisioning axis (migration 14). Skills are catalog-only for enforcement, but the central
  // catalog's job is to hand skills OUT: an admin marks skills here and every node installs them
  // (server/skillDistribution.js). NODE scope on the read because the installer polls it with its
  // node certificate; ADMIN on the toggle because marking a skill for the whole fleet is a decision.

  app.get('/api/policy/skills', node, wrap(async (req, res) => {
    // No version dependency and no delta — the node installer reconciles the full desired set on
    // each poll, exactly as the deny-list rides every response rather than being diffed.
    res.set('Cache-Control', 'no-store');
    res.json({ skills: await policyStore.listSkills(d()) });
  }));

  app.patch('/api/policy/capabilities/:id/distribute', admin, json, wrap(async (req, res) => {
    const { distribute } = req.body || {};
    if (typeof distribute !== 'boolean') return res.status(400).json({ error: 'distribute must be a boolean' });
    const before = await policyStore.findCapabilityById(d(), req.params.id);
    if (!before) return res.status(404).json({ error: 'capability not found' });
    let after;
    try {
      after = await policyStore.setSkillDistribute(d(), req.params.id, distribute);
    } catch (err) {
      if (err && err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
    await policyStore.recordAuditEntry(d(), {
      action: distribute ? 'skill_distribute_on' : 'skill_distribute_off',
      actorScope: req.authScope,
      capabilityId: before.id,
      before,
      after,
      reason: (req.body && req.body.reason) || null,
    });
    res.json(after);
  }));

  app.get('/api/policy/principals', node, wrap(async (req, res) => {
    res.json(await policyStore.listPrincipals(d()));
  }));

  app.post('/api/policy/principals', admin, json, wrap(async (req, res) => {
    try {
      const principal = await policyStore.insertPrincipal(d(), req.body || {});
      res.status(201).json(principal);
    } catch (err) {
      if (err instanceof policyStore.PrincipalConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }));

  app.patch('/api/policy/principals/:id', admin, json, wrap(async (req, res) => {
    const after = await policyStore.updatePrincipal(d(), req.params.id, req.body || {});
    if (!after) return res.status(404).json({ error: 'principal not found' });
    await policyStore.recordAuditEntry(d(), {
      action: 'principal_update',
      actorScope: req.authScope,
      principalId: after.id,
      after,
      reason: (req.body && req.body.reason) || null,
    });
    res.json(after);
  }));

  app.get('/api/policy/grants', node, wrap(async (req, res) => {
    res.json(await policyStore.listGrants(d(), { principalId: req.query.principalId, capabilityId: req.query.capabilityId }));
  }));

  app.post('/api/policy/grants', admin, json, wrap(async (req, res) => {
    try {
      const grant = await policyStore.insertGrant(d(), req.body || {});
      await policyStore.recordAuditEntry(d(), {
        action: 'grant_issue',
        actorScope: req.authScope,
        principalId: grant.principalId,
        capabilityId: grant.capabilityId,
        grantId: grant.id,
        after: grant,
        reason: (req.body && req.body.reason) || null,
      });
      res.status(201).json(grant);
    } catch (err) {
      if (err instanceof policyStore.GrantConflictError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }));

  app.delete('/api/policy/grants/:id', admin, json, wrap(async (req, res) => {
    const before = await policyStore.findGrantById(d(), req.params.id);
    const revoked = before && !before.revokedAt ? await policyStore.revokeGrant(d(), req.params.id, req.authScope) : null;
    if (!revoked) return res.status(404).json({ error: 'grant not found' });
    await policyStore.recordAuditEntry(d(), {
      action: 'grant_revoke',
      actorScope: req.authScope,
      principalId: before.principalId,
      capabilityId: before.capabilityId,
      grantId: before.id,
      before,
      after: revoked,
      reason: (req.body && req.body.reason) || null,
    });
    // 200 with the row, not the node's 204: a revoke is the one write whose *arrival* a caller
    // wants to see, and the row carries the version-bearing `revokedAt` that says it landed.
    res.json(revoked);
  }));

  app.get('/api/policy/approvals', admin, wrap(async (req, res) => {
    res.json(await policyStore.listApprovals(d(), { status: req.query.status }));
  }));

  app.post('/api/policy/approvals', node, json, wrap(async (req, res) => {
    // A proposal, not a decision — this is the one write on this half a non-admin may make, and it
    // grants nothing on its own. See server/app.js's note on the confused-deputy chain the
    // proposer scope closes.
    const approval = await policyStore.insertApproval(d(), { ...(req.body || {}), requestedByScope: req.authScope });
    res.status(201).json(approval);
  }));

  app.post('/api/policy/approvals/:id/decide', admin, json, wrap(async (req, res) => {
    const { status, reason } = req.body || {};
    if (status !== 'approved' && status !== 'denied') {
      return res.status(400).json({ error: "status must be 'approved' or 'denied'" });
    }
    const approval = await policyStore.findApprovalById(d(), req.params.id);
    if (!approval) return res.status(404).json({ error: 'approval not found' });
    if (approval.status !== 'pending') return res.status(409).json({ error: `approval is already ${approval.status}` });

    // An approved grant proposal becomes a real grant HERE, in central, and the approval row
    // records which one. Doing it in two requests from the node would leave a window where the
    // approval is decided and the grant does not exist — recoverable, but only by someone noticing.
    let resultGrantId = null;
    if (status === 'approved' && approval.action === 'grant_capability') {
      try {
        const grant = await policyStore.insertGrant(d(), approval.payload || {});
        resultGrantId = grant.id;
        await policyStore.recordAuditEntry(d(), {
          action: 'grant_issue',
          actorScope: req.authScope,
          principalId: grant.principalId,
          capabilityId: grant.capabilityId,
          grantId: grant.id,
          after: grant,
          reason: reason || `approval ${approval.id}`,
        });
      } catch (err) {
        if (err instanceof policyStore.GrantConflictError) return res.status(409).json({ error: err.message });
        throw err;
      }
    }
    const decided = await policyStore.decideApproval(d(), req.params.id, {
      status,
      decidedByScope: req.authScope,
      reason: reason || null,
      resultGrantId,
    });
    res.json(decided);
  }));

  app.get('/api/policy/audit', admin, wrap(async (req, res) => {
    res.json({ entries: await policyStore.listAudit(d(), { limit: req.query.limit }) });
  }));

  /**
   * Who is behind, and by how much — the number §2.4's revocation window is actually measured by.
   *
   * Distinct from /api/fleet/shadow, which answers whether the *usage* streams agree. A node can
   * ship perfectly while its policy replica is frozen; telling those apart is the §2.6 skew
   * question, and before this route there was no way to ask it from central at all.
   */
  app.get('/api/fleet/policy', admin, wrap(async (req, res) => {
    res.json(await policyStore.nodePolicyState(d()));
  }));

  return app;
}

module.exports = { mountPolicyRoutes, HEARTBEAT_MS };
