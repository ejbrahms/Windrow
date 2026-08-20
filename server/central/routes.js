'use strict';

// Central's HTTP surface — docs/design/global-identity-and-central-db.md §2.7, phases 3 and 4.
//
// THREE KINDS OF ROUTE:
//
//   POST /api/ingest/*   what nodes push up. Node-scoped certificate; the path
//                        server/usageShipper.js has been pointing at since phase 1 shipped.
//   GET  /api/fleet/*    what a dashboard reads. Admin-scoped certificate.
//   /api/policy*         the control plane — phase 4, in ./policyRoutes.js. Nodes read their
//                        replica and propose discoveries; admins decide.
//   /api/enroll*         how a node on a DIFFERENT MACHINE gets a certificate this process will
//                        accept — docs/design/setup-after-central.md §2, and the only one of the
//                        four that is unauthenticated. See the mount below.
//
// WHAT CHANGED AT PHASE 4, because this header used to promise the opposite. Phase 3's guarantee
// was that "central cannot change any node's behaviour because there is no route by which it
// could". ./policyRoutes.js is that route, and the guarantee it replaces the old one with is
// narrower and stated in §2.8: central is never on the hot path, so a node fully partitioned from
// it still enforces from its replica for MAX_POLICY_AGE, and the only thing central can do quickly
// is take permission away. A node that cannot reach this process keeps working; it does not keep
// working *forever*, and that bound is the security property phase 4 buys.
//
// AUTHENTICATION IS BY CERTIFICATE, and this file does its own rather than importing
// server/auth.js. That is not duplication for its own sake: `requireAuth` there consults the
// *node's* SQLite registry for the certificate-revocation check, and central has no such registry
// — importing it would open a node database on the central host, which in a real deployment is a
// different machine with no such file. The shape of the check is the same and the strictness is
// higher: a node-scoped certificate reaches ingest, its own replica, and the two discovery
// proposals — and nothing that decides what a grant permits.

const express = require('express');
const store = require('./store');
const queries = require('./queries');
const partitions = require('./partitions');
const alertEngine = require('./alertEngine');
const { mountPolicyRoutes } = require('./policyRoutes');
const enrollmentStore = require('./enrollmentStore');
const { createEnrollmentRouter, createEnrollmentAdminRouter } = require('../enrollment/routes');
const { envCompat } = require('../config');

/** The loopback carve-out, matching server/usageShipper.js's on the sending side: a developer
 *  standing up central on their own machine has no CA to issue certificates with yet. It is a
 *  *developer* affordance and it says so — `WINDROW_CENTRAL_ALLOW_INSECURE=1`, off by default, so
 *  the way to run central without mTLS is to have deliberately asked for it. */
const ALLOW_INSECURE = envCompat('CENTRAL_ALLOW_INSECURE') === '1';

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Establish who is calling. Sets `req.authScope`, `req.nodeId` and `req.certSubject`.
 *
 * `req.nodeId` from the certificate CN is the value ./store.js treats as authoritative over
 * anything the batch body claims — see its header. On the insecure loopback path it is null, and
 * the store falls back to the envelope, which is exactly as trustworthy as the connection is.
 */
function requireCert(scopes) {
  const allowed = new Set([].concat(scopes));
  return (req, res, next) => {
    if (!req.socket.encrypted) {
      if (ALLOW_INSECURE && isLoopback(req)) {
        req.authScope = 'insecure-loopback';
        req.nodeId = null;
        req.certSubject = null;
        return next();
      }
      return res.status(401).json({
        error: 'unauthorized: central requires a client certificate',
        detail: 'plaintext is accepted only from loopback and only with WINDROW_CENTRAL_ALLOW_INSECURE=1',
      });
    }
    if (!req.socket.authorized) {
      return res.status(401).json({
        error: 'unauthorized: a valid enrolled client certificate is required',
        detail: req.socket.authorizationError ? String(req.socket.authorizationError) : undefined,
      });
    }
    const peer = req.socket.getPeerCertificate();
    const scope = peer && peer.subject && peer.subject.OU;
    const nodeId = peer && peer.subject && peer.subject.CN;
    if (!scope || !nodeId) {
      return res.status(401).json({ error: 'unauthorized: client certificate is missing a scope or node id' });
    }
    if (!allowed.has(scope)) {
      return res.status(403).json({
        error: `forbidden: this endpoint requires a ${[...allowed].join(' or ')} certificate, not ${scope}`,
      });
    }
    req.authScope = scope;
    req.nodeId = nodeId;
    req.certSubject = `CN=${nodeId},OU=${scope}`;
    next();
  };
}

/** Wrap an async handler so a rejected promise becomes a 500 with a message instead of an
 *  unhandled rejection that takes the process down mid-batch. */
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[central]', req.method, req.path, '—', err.stack || err.message);
  res.status(status).json({ error: err.message, code: err.code });
});


/**
 * What a caller of `GET /api/fleet/rollup` is allowed to ask for. Pure and exported so the scoping
 * rule — the security-relevant half of that route — is assertable without a TLS handshake and a
 * pair of issued certificates (server/rollup/source-test.js).
 *
 * A node certificate is pinned to its own node id whatever it asked for. An admin certificate, and
 * the developer loopback path that has no certificate to read a node id off at all, may narrow to
 * a list or take the fleet.
 */
function rollupScopeFor(req) {
  const query = req.query || {};
  const hours = Number(query.hours);
  // No window by default, unlike the other fleet routes: the scan this replaces had none, and a
  // dashboard that silently started reporting 24 hours where it used to report all time would be a
  // number that changed without anyone changing anything.
  const sinceMs = Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : null;
  const mayReadFleet = req.authScope === 'admin' || req.authScope === 'insecure-loopback';
  const requested = query.nodeId ? [].concat(query.nodeId) : null;
  return { nodeIds: mayReadFleet ? requested : [req.nodeId], sinceMs, limit: query.limit };
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');

  // ------------------------------------------------------------------ enrollment (§2, setup-after-central)
  //
  // MOUNTED FIRST, AND WITHOUT `requireCert`, because a caller enrolling has no certificate — that
  // is the entire point of the route, and gating it would make the gap it closes unclosable. The
  // TLS listener in ./index.js already sets `rejectUnauthorized: false`, so an unauthenticated
  // handshake reaches the app rather than dying as a TLS alert; nothing is authorised by arriving,
  // and every route below still checks `socket.authorized` for itself.
  //
  // WHAT AUTHORISES IT INSTEAD is a single-use enrollment token an admin minted, checked inside the
  // router (../enrollment/routes.js). The caller does not choose its own scope or its own nodeId —
  // both come off the token — so the worst an anonymous caller on the network can do here is
  // present a string that is not a token and be told so.
  //
  // THE IDENTITY IS THE WHOLE FIX. The CA this router issues from is `ca.loadOrCreateCa()`,
  // WINDROW_CA_DIR — the SAME root ./index.js hands to the mTLS listener as its `ca`. That is not
  // an incidental sharing of a module: §2 measured a node enrolled against its own server being
  // rejected here with UNABLE_TO_VERIFY_LEAF_SIGNATURE, and the reason was two roots. One root,
  // living on the control plane and never copied to a node, is what makes a certificate issued by
  // this process one that this process will accept.
  //
  // The body parser is mounted here rather than globally, and rather than inside the router.
  // Globally would put JSON parsing in front of `/api/ingest/usage`, whose body is NDJSON and
  // whose limit is 16mb; inside the router would change how it behaves on the node, where
  // server/app.js already parses. Two mounts because `/api/enroll` and `/api/enrollment-tokens`
  // are different first segments as far as Express's prefix matching is concerned — the second is
  // not a child of the first.
  const enrollJson = express.json({ limit: '64kb' });
  app.use('/api/enroll', enrollJson);
  app.use('/api/enrollment-tokens', enrollJson);
  app.use('/api/nodes', enrollJson);
  app.use(createEnrollmentRouter(enrollmentStore));

  // ------------------------------------------------------------------ ingest (node → central)

  // The NDJSON body arrives as text; `express.json` would reject it and `express.raw` would hand
  // over a Buffer for no gain. The limit is generous because server/usageShipper.js caps a batch
  // at 500 shipments and a shipment is one usage event — but a node draining a week's backlog
  // sends those batches back to back, so the ceiling that matters is per request, not per node.
  const ndjson = express.text({ type: ['application/x-ndjson', 'text/plain'], limit: '16mb' });

  app.post('/api/ingest/usage', requireCert(['node', 'admin']), ndjson, wrap(async (req, res) => {
    const result = await store.ingestBatch(req.body || '', {
      authenticatedNodeId: req.nodeId,
      certSubject: req.certSubject,
    });
    // `duplicates` is the field server/usageShipper.js reads off this response and logs. It is not
    // an error — it is the at-least-once contract working, and reporting the number is what lets a
    // node whose acks are being lost see that rather than infer it.
    res.json({
      ok: true,
      accepted: result.accepted,
      duplicates: result.duplicates,
      corrections: result.corrections,
      rejected: result.rejected.length,
      rejections: result.rejected.slice(0, 20),
      malformed: result.malformed.length,
      // §2.6 skew telemetry: how many fields in this batch central had no column for, and how many
      // envelopes predate the shipment number. Both belong in the ack rather than only in
      // central's log, because the node is the one that can be upgraded to stop producing them.
      unknownFields: result.unknownFields,
      legacyEnvelopes: result.legacyEnvelopes,
    });
  }));

  /**
   * Alerts a node fired locally — docs/design/global-identity-and-central-db.md §2.3's node half
   * arriving at the shared dedup key. `server/alerts/nodeShipper.js` posts here.
   *
   * `duplicates` in the response means central had ALREADY derived that breach from the events
   * (or the node redelivered), which is §2.3's "fires once" working rather than an error — and it
   * is the one observable proof that the two ends compute the same key, so it is reported rather
   * than folded into `accepted`.
   *
   * A node certificate is enough, and it is also a limit: `ingestNodeAlerts` forces `scopeId` to
   * the authenticated node and refuses a node-scoped alert claiming another machine, so an
   * enrolled node can report its own bursts and nobody else's.
   */
  app.post('/api/ingest/alerts', requireCert(['node', 'admin']), express.json({ limit: '1mb' }), wrap(async (req, res) => {
    const result = await alertEngine.ingestNodeAlerts(req.body || {}, { authenticatedNodeId: req.nodeId });
    res.json({
      ok: true,
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: result.rejected.length,
      rejections: result.rejected.slice(0, 20),
    });
  }));

  // A node reporting its own account of itself, so central can compare. The node is authoritative
  // in this phase, so it reports rather than being interrogated — see queries.reconcile.
  app.post('/api/ingest/reconcile', requireCert(['node', 'admin']), express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const nodeId = req.nodeId || (req.body && req.body.nodeId);
    if (!nodeId) return res.status(400).json({ error: 'no node id — send one in the body, or present a node certificate' });
    res.json(await queries.reconcile(store.requireDriver(), nodeId, req.body || {}));
  }));

  // ------------------------------------------------------------------- fleet (dashboard → central)

  const admin = requireCert(['admin']);
  const d = () => store.requireDriver();
  const windowMs = (req) => {
    const hours = Number(req.query.hours);
    return Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : 24 * 3600 * 1000;
  };

  app.get('/api/fleet/summary', admin, wrap(async (req, res) => {
    res.json(await queries.fleetSummary(d(), { sinceMs: windowMs(req) }));
  }));

  app.get('/api/fleet/nodes', admin, wrap(async (req, res) => {
    res.json({ nodes: await queries.nodeRoster(d()) });
  }));

  app.get('/api/fleet/nodes/:nodeId/stream', admin, wrap(async (req, res) => {
    res.json(await queries.nodeStream(d(), req.params.nodeId));
  }));

  app.get('/api/fleet/nodes/:nodeId/verify', admin, wrap(async (req, res) => {
    res.json(await queries.verifyNodeChain(d(), req.params.nodeId));
  }));

  app.get('/api/fleet/usage', admin, wrap(async (req, res) => {
    const by = req.query.by || 'principalId';
    res.json({ by, rows: await queries.usageBy(d(), by, { sinceMs: windowMs(req), limit: req.query.limit }) });
  }));

  app.get('/api/fleet/events', admin, wrap(async (req, res) => {
    res.json({ events: await queries.recentEvents(d(), { limit: req.query.limit, nodeId: req.query.nodeId || null }) });
  }));

  // The panel phase 4's go/no-go is argued from.
  app.get('/api/fleet/shadow', admin, wrap(async (req, res) => {
    res.json(await queries.shadowStatus(d(), { sinceMs: windowMs(req) * 7 }));
  }));

  app.get('/api/fleet/shadow/history', admin, wrap(async (req, res) => {
    res.json({ checks: await queries.reconciliationHistory(d(), { nodeId: req.query.nodeId || null, limit: req.query.limit }) });
  }));

  /** What has fired, from either end. `firedBy` is the column worth reading first: 'node' means a
   *  machine caught the breach itself — possibly while it could not reach here at all — and
   *  'central' means nobody knew until the events landed. */
  app.get('/api/fleet/alerts', admin, wrap(async (req, res) => {
    res.json({
      alerts: await alertEngine.listAlerts({
        limit: req.query.limit,
        since: req.query.since || null,
        severity: req.query.severity || null,
        ruleId: req.query.ruleId || null,
        nodeId: req.query.nodeId || null,
        subjectId: req.query.subjectId || null,
      }),
      engine: alertEngine.centralAlertStats(),
    });
  }));

  app.get('/api/fleet/storage', admin, wrap(async (req, res) => {
    res.json(await queries.storage(d()));
  }));

  /**
   * The cross-field rollup — §2.7 phase 5, the query that retires server/rollup/index.js's scan of
   * sibling workspaces' `.db` files.
   *
   * THE ONLY FLEET ROUTE A NODE CERTIFICATE REACHES, AND IT IS SCOPED TO THAT NODE. Every other
   * `/api/fleet/*` route above is admin-only, and this one does not weaken that: a node
   * certificate gets `nodeIds: [its own]` forced on regardless of what it asked for, so what comes
   * back is a rollup over the events THAT NODE SHIPPED — the same rows it still holds in its own
   * SQLite, arranged by central instead of by a directory walk. That is a strict *narrowing* of
   * what it can see today, where the scan reads every sibling workspace's database off the disk
   * with no credential at all.
   *
   * An admin certificate gets the fleet, which is the half the scan could never do: a rollup
   * across machines rather than across one workspace root.
   *
   * Why not simply give node certificates the fleet and be done? Because the rollup names people's
   * workspaces, their agents and their call volumes, and "every node may read every other node's
   * usage" is the property §2.5 spent per-node enrollment credentials to avoid. A shared token
   * fleet-wide was the thing being replaced; a fleet-wide *read* reintroduces the disclosure half
   * of it.
   */
  app.get('/api/fleet/rollup', requireCert(['node', 'admin']), wrap(async (req, res) => {
    res.json(await queries.rollup(d(), rollupScopeFor(req)));
  }));

  // Managing enrollment — minting and revoking tokens, listing and revoking nodes — is admin-only,
  // and the guard is passed in rather than imported by the router so it is applied PER ROUTE. A
  // guard wrapped around the whole mount (`app.use(admin, router)`) would gate every request that
  // reached this point in the stack, including ones meant for the routes below it.
  app.use(createEnrollmentAdminRouter(enrollmentStore, requireCert(['admin'])));

  // ------------------------------------------------------------------- policy (phase 4)
  //
  // Mounted last among the authenticated routes and before the 404, so the control plane is a
  // module boundary rather than another two hundred lines here — the same call ./index.js's header
  // makes about keeping node and central separate, applied one level down. It takes `requireCert`
  // and `wrap` from this file so there is exactly one definition of what an authenticated node is.
  mountPolicyRoutes(app, { requireCert, wrap });

  // Liveness, with no certificate: a load balancer or a `docker healthcheck` has none, and there
  // is nothing here worth authenticating — it says whether the process can reach Postgres, and
  // that is a fact a caller who can already open the port could establish anyway.
  app.get('/health', wrap(async (req, res) => {
    try {
      const row = await store.requireDriver().get('SELECT 1 AS ok');
      const stranded = await partitions.defaultPartitionRows(store.requireDriver());
      // `mode` is read by operators and by ./smoke.js to tell a phase-3 central from a phase-4 one.
      // Derived from the schema rather than from an environment variable, because the question it
      // answers is "does this database hold the policy tables" and only the database knows.
      const authority = await store.requireDriver().ddl.hasTable('policy_changes');
      res.json({
        ok: Boolean(row && row.ok),
        mode: authority ? 'authority' : 'shadow',
        defaultPartitionRows: stranded,
      });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  }));

  app.use((req, res) => res.status(404).json({
    error: `no such route ${req.method} ${req.path}`,
    detail: 'central issues node credentials under /api/enroll, accepts usage under /api/ingest, answers '
      + 'fleet queries under /api/fleet, and serves the control plane under /api/policy '
      + '(docs/design/global-identity-and-central-db.md §2.7 phase 4; docs/design/setup-after-central.md §2).',
  }));

  return app;
}

module.exports = { buildApp, requireCert, rollupScopeFor, ALLOW_INSECURE };
