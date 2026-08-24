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
const fs = require('fs');
const path = require('path');
const store = require('./store');
const queries = require('./queries');
const partitions = require('./partitions');
const alertEngine = require('./alertEngine');
const policyStore = require('./policyStore');
const centralPackages = require('./packages');
const { PACKAGES } = require('../packageDefs');
const { PARAMETERS } = require('../policy/nodeConfig');
const { mountPolicyRoutes } = require('./policyRoutes');
const enrollmentStore = require('./enrollmentStore');
const { createEnrollmentRouter, createEnrollmentAdminRouter } = require('../enrollment/routes');
const { envCompat } = require('../config');

/** The loopback carve-out, matching server/usageShipper.js's on the sending side: a developer
 *  standing up central on their own machine has no CA to issue certificates with yet. It is a
 *  *developer* affordance and it says so — `WINDROW_CENTRAL_ALLOW_INSECURE=1`, off by default, so
 *  the way to run central without mTLS is to have deliberately asked for it. */
const ALLOW_INSECURE = envCompat('CENTRAL_ALLOW_INSECURE') === '1';

/** The public read-only demo (docs/design/vercel-supabase-demo.md, ../../api/index.js). When set,
 *  a certificate-less GET is granted the admin fleet scope so the dashboard's read-only Fleet pages
 *  render against a pooled Supabase behind Vercel — where there is no mTLS and no client to present
 *  a certificate. It is deliberately a SEPARATE switch from ALLOW_INSECURE, which is loopback-only:
 *  this one accepts requests off the public internet, so it grants nothing but GET and the entry in
 *  ../../api/index.js refuses every other method before a request ever reaches a route. */
const DEMO_READONLY = envCompat('CENTRAL_DEMO_READONLY') === '1';

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
      // The public read-only demo: no certificate exists to read a scope off, so a GET to a route
      // that admits an admin is granted the admin fleet scope and nothing else. A non-GET is refused
      // here as a second line behind the blanket guard in ../../api/index.js — belt and braces, so a
      // mutating route can never be reached whichever way it is mounted.
      if (DEMO_READONLY) {
        if (req.method === 'GET' && allowed.has('admin')) {
          req.authScope = 'admin';
          req.nodeId = null;
          req.certSubject = null;
          return next();
        }
        return res.status(405).json({ error: 'this is a read-only public demo — only fleet reads are served' });
      }
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
  // Enrollment issues node certificates, which means loading (and, first time, CREATING) the CA on
  // disk. The public read-only demo (../../api/index.js) runs on a read-only serverless filesystem
  // and serves no enrollment at all — every mutating method is 405'd before it reaches a route — so
  // constructing this router would only fail an mkdir at boot, or waste a cold start minting a CA
  // nobody can use. Skip the whole enrollment surface when DEMO_READONLY is set; real central (the
  // flag unset) is unchanged.
  if (!DEMO_READONLY) {
    const enrollJson = express.json({ limit: '64kb' });
    app.use('/api/enroll', enrollJson);
    app.use('/api/enrollment-tokens', enrollJson);
    app.use('/api/nodes', enrollJson);
    app.use(createEnrollmentRouter(enrollmentStore));
  }

  // ------------------------------------------------------------------ ingest (node → central)

  // The NDJSON body arrives as text; `express.json` would reject it and `express.raw` would hand
  // over a Buffer for no gain. The limit is generous because server/usageShipper.js caps a batch
  // at 500 shipments and a shipment is one usage event — but a node draining a week's backlog
  // sends those batches back to back, so the ceiling that matters is per request, not per node.
  const ndjson = express.text({ type: ['application/x-ndjson', 'text/plain'], limit: '16mb' });

  app.post('/api/ingest/usage', requireCert(['node', 'admin']), ndjson, wrap(async (req, res) => {
    // The batch trace id. The node stamps it into `x-windrow-trace-id` so both ends log the same
    // handle; a caller that sends none gets one minted in the store. docs/design/ingest-data-resilience.md.
    const traceHeader = typeof req.headers['x-windrow-trace-id'] === 'string' ? req.headers['x-windrow-trace-id'] : null;
    const result = await store.ingestBatch(req.body || '', {
      authenticatedNodeId: req.nodeId,
      certSubject: req.certSubject,
      traceId: traceHeader,
    });
    // A packet central could NOT store is now quarantined rather than dropped — but a node that
    // keeps producing them is still a fault, so it is logged here with the trace id an operator can
    // grep the dead-letter table by. Not an error-level line for a stray one; a batch that is mostly
    // garbage is the operator's problem.
    if (result.deadLettered) {
      const say = result.deadLettered >= result.accepted ? console.error : console.warn;
      say(
        `[central] ingest quarantined ${result.deadLettered} unstorable packet(s) from node ${req.nodeId || '(loopback)'}`,
        `— trace ${result.traceId}. Inspect: GET /api/fleet/dead-letters?traceId=${result.traceId}`
      );
    }
    // `duplicates` is the field server/usageShipper.js reads off this response and logs. It is not
    // an error — it is the at-least-once contract working, and reporting the number is what lets a
    // node whose acks are being lost see that rather than infer it.
    res.json({
      ok: true,
      // Echoed so the node logs the same handle central did, and so a lost-ack redelivery can be
      // tied to its first arrival.
      traceId: result.traceId,
      accepted: result.accepted,
      duplicates: result.duplicates,
      corrections: result.corrections,
      rejected: result.rejected.length,
      rejections: result.rejected.slice(0, 20),
      malformed: result.malformed.length,
      // How many packets were quarantined. The node reads this and logs it, so a silent drop
      // becomes a visible one on both ends — the property docs/design/ingest-data-resilience.md exists for.
      deadLettered: result.deadLettered,
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

  /**
   * Native tool observations — docs/design/dashboard-placement.md item 1, and the route that makes
   * "central is the data sink" true rather than aspirational.
   *
   * A SEPARATE PATH FROM `/api/ingest/usage`, and the separation is the design rather than an
   * accident of routing. `server/nativeObservations.js` puts native calls in their own table on the
   * node because they are unenforced, best-effort, out of order and one to two orders of magnitude
   * more numerous than governed ones — "so every drift number, usage summary and denial rate
   * computed off `usage_events` would silently change meaning". That argument does not weaken by
   * crossing a network; it is the reason this is a second route into a second table rather than a
   * second `kind` on the first one.
   *
   * NDJSON, like usage, and for the same reason: a node draining a fortnight of observations sends
   * hundreds of thousands of rows, and one array would be a body neither end can stream.
   */
  app.post('/api/ingest/native', requireCert(['node', 'admin']), ndjson, wrap(async (req, res) => {
    const result = await store.ingestNativeBatch(req.body || '', { authenticatedNodeId: req.nodeId });
    res.json({
      ok: true,
      accepted: result.accepted,
      // Not an error. The node's ids are content-derived, so a redelivery after a lost ack is the
      // at-least-once contract working — and reporting the number is what lets a node whose acks
      // are being dropped see that rather than infer it.
      duplicates: result.duplicates,
      rejected: result.rejected.length,
      rejections: result.rejected.slice(0, 20),
      malformed: result.malformed.length,
      // §2.6 skew: this table has no `extra` column, so a field central has no column for is
      // genuinely dropped. Counting it in the ack is what stops that being silent.
      unknownFields: result.unknownFields,
    });
  }));

  /**
   * Hook integrity as node health — item 2.
   *
   * Turns "is governance actually wired on that box" from a per-machine visit into a fleet query.
   * A node certificate is enough and is also the limit: `ingestNodeHealth` refuses a report that
   * describes a machine other than the one that presented the certificate.
   */
  // 512kb rather than 256: since docs/design/disposable-nodes.md §5 this report also carries a
  // bounded slice of the node's fault journal (../nodeHealth.js JOURNAL_MAX_BYTES, 192 kB) beside
  // the hook detail it always carried. The node's own ceiling is the real bound; this one is the
  // backstop that keeps a misconfigured node from posting a gigabyte.
  app.post('/api/ingest/node-health', requireCert(['node', 'admin']), express.json({ limit: '512kb' }), wrap(async (req, res) => {
    const result = await store.ingestNodeHealth(req.body || {}, { authenticatedNodeId: req.nodeId });
    res.json({ ok: true, ...result });
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

  // WHICH BOXES ARE NOT ENFORCING RIGHT NOW — docs/design/disposable-nodes.md §5.
  //
  // A separate endpoint from the roster rather than a filter on it, because it is the question an
  // operator asks when something has gone wrong and they want the short list, not the fleet with a
  // column to squint at. Expired pauses are excluded in SQL: a pause is over the moment its `until`
  // passes, and a row that keeps showing a lapsed one is how a real signal turns into noise.
  app.get('/api/fleet/divergence', admin, wrap(async (req, res) => {
    res.json(await queries.fleetDivergence(d()));
  }));

  // WHAT A NODE DECIDED WITHOUT US, and what a pause let through. `?pauseId=` narrows it to one
  // window, which is the query §5 says the pause id exists to make answerable.
  app.get('/api/fleet/nodes/:nodeId/journal', admin, wrap(async (req, res) => {
    res.json(await queries.nodeFaultJournal(d(), req.params.nodeId, {
      pauseId: req.query.pauseId || null,
      limit: req.query.limit,
    }));
  }));

  // What that machine is, as it last described itself — discovery sources, which adapters it ever
  // turned on, which packages it runs. docs/design/disposable-nodes.md §6's machine-fact tier.
  app.get('/api/fleet/nodes/:nodeId/facts', admin, wrap(async (req, res) => {
    res.json(await queries.nodeFacts(d(), req.params.nodeId));
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

  // ------------------------------------------------------------------ dead-letter queue
  //
  // docs/design/ingest-data-resilience.md. A packet central could not store is quarantined in
  // `ingest_dead_letter` rather than dropped; these three routes are its inspect and recovery
  // surface. Admin-scoped, like the rest of /api/fleet: a node may cause a dead-letter but must not
  // read another node's, and only an operator replays or discards one.

  // WHAT COULD NOT BE STORED. Defaults to `?status=quarantined` — the ones still awaiting a
  // decision; `?status=all` includes replayed and discarded history, and `?traceId=` narrows to one
  // batch, which is the query the ingest warning line points an operator at.
  app.get('/api/fleet/dead-letters', admin, wrap(async (req, res) => {
    res.json(await queries.deadLetters(d(), {
      limit: req.query.limit,
      nodeId: req.query.nodeId || null,
      status: req.query.status || 'quarantined',
      traceId: req.query.traceId || null,
    }));
  }));

  // REPLAY selected packets back through ingest. The one worth running after a transient central
  // fault is fixed; a structurally-broken packet replays to the same refusal and stays quarantined
  // with the reason recorded, so a replay never loses what it was trying to recover.
  app.post('/api/fleet/dead-letters/replay', admin, express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'send { ids: [...] } — the dead-letter ids to replay' });
    }
    res.json(await store.replayDeadLetters(d(), { ids }));
  }));

  // DISCARD selected packets — a marker, not a delete, so the record that a packet arrived and could
  // not be stored survives the decision to stop trying to recover it.
  app.post('/api/fleet/dead-letters/discard', admin, express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'send { ids: [...] } — the dead-letter ids to discard' });
    }
    res.json(await store.discardDeadLetters(d(), { ids }));
  }));

  /**
   * Governed decisions over time — the calls-over-time chart and latency breakdown the events page
   * draws above its tail.
   *
   * A SEPARATE ROUTE FROM `/api/fleet/events`, for `/api/fleet/native/series`'s reason: the tail is
   * a fixed page of rows, this is up to 400 buckets a chart re-fetches on every granularity change,
   * and folding them would make the events page pay for a series when all it wanted was the table.
   * Bucketed on `observedAt` (central's clock, the partition key), never summed with the native
   * series — usage is a decision, a native call is a sighting.
   */
  app.get('/api/fleet/usage/series', admin, wrap(async (req, res) => {
    res.json(await queries.usageSeries(d(), {
      granularity: req.query.granularity,
      windowMinutes: req.query.windowMinutes,
      nodeId: req.query.nodeId || null,
    }));
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
   * CENTRAL'S OWN CONFIGURATION — the settings surface the node dashboard used to carry and central
   * never did (docs/design/dashboard-placement.md item 4). Two genuinely-central things:
   *
   *   - its deployment posture: authority vs shadow, whether client certificates are enforced, and
   *     whether partition maintenance is keeping the default partition empty.
   *   - THE FLEET-WIDE POLICY PARAMETERS it distributes — ../policy/nodeConfig.js's PARAMETERS, the
   *     dials a node profile may tighten (§6). These have had a full admin API since §5 and no UI at
   *     all; this is the read side of it. The fallbacks are the fleet-wide baseline a node with no
   *     profile uses, and each profile below states the subset it narrows.
   *
   * Read-only and admin-scoped like every other fleet route. Editing a profile stays on
   * /api/policy/node-profiles, which is where the write path already lives.
   */
  app.get('/api/fleet/settings', admin, wrap(async (req, res) => {
    const authority = await d().ddl.hasTable('policy_changes');
    const stranded = await partitions.defaultPartitionRows(d());
    const profiles = await policyStore.listNodeProfiles(d());
    // How many nodes each profile actually governs. A profile with no members is a ceiling nobody
    // is under — worth seeing rather than inferring from an empty roster column.
    const counts = await d().all(
      'SELECT profile, COUNT(*)::int AS n FROM nodes WHERE profile IS NOT NULL GROUP BY profile',
    );
    const nodeCountFor = Object.fromEntries(counts.map((r) => [r.profile, r.n]));
    res.json({
      mode: authority ? 'authority' : 'shadow',
      // `mtls` is the inverse of the developer carve-out: central enforces client certificates
      // unless WINDROW_CENTRAL_ALLOW_INSECURE=1 was deliberately set, which is a posture worth
      // surfacing because it is the one that would let an unauthenticated loopback caller in.
      security: { mtls: !ALLOW_INSECURE, insecureLoopback: ALLOW_INSECURE },
      bundleBuilt,
      storage: { defaultPartitionRows: stranded },
      parameters: Object.entries(PARAMETERS).map(([key, spec]) => ({
        key,
        env: spec.env,
        direction: spec.direction,
        fallback: spec.fallback,
      })),
      profiles: profiles.map((p) => ({ ...p, nodeCount: nodeCountFor[p.name] ?? 0 })),
    });
  }));

  /**
   * FLEET INTEGRATIONS — view what each integration is set to fleet-wide, which boxes actually run
   * it, and turn it on or off for the whole fleet in one place (docs/design/capability-packages.md,
   * ./packages.js). Two axes, deliberately kept apart:
   *
   *   - the fleet DECISION: central's `package_state` row for the package, and — under authority —
   *     the grants it produced (`coverage`). Enabling here writes central's tables, so the grants
   *     replicate to every node on the delta stream ./policyRoutes.js already serves. Nothing new
   *     ships the decision; the grants ARE the decision.
   *   - per-node ADOPTION: what each machine last reported its own `packages_enabled` to be
   *     (queries.integrationAdoption, off the machine-facts tier). A node whose local toggle
   *     disagrees with the fleet decision is drift worth seeing, so it is surfaced, not reconciled
   *     away — the node is authoritative for its own tier (docs/design/disposable-nodes.md §6).
   *
   * The write routes require policy AUTHORITY: enabling a package is issuing grants, and grants only
   * live centrally once central holds the policy tables. In shadow mode the read still answers (the
   * adoption axis needs no policy tables), and the writes 409 with why.
   */
  const integrationStatus = async (id) => {
    const list = await centralPackages.listPackagesWithStatus(d());
    return list.find((p) => p.id === id) || null;
  };

  app.get('/api/fleet/integrations', admin, wrap(async (req, res) => {
    const authority = await d().ddl.hasTable('policy_changes');
    // Under authority the full status (coverage against real grants) is available; in shadow only
    // the on/off decision is, since coverage is a claim about grants that do not exist here yet.
    let statusList;
    if (authority) {
      statusList = await centralPackages.listPackagesWithStatus(d());
    } else {
      const enabledMap = await centralPackages.getEnabledMap(d());
      statusList = PACKAGES.map((pkg) => ({
        id: pkg.id,
        kind: pkg.kind,
        label: pkg.label,
        description: pkg.description,
        owners: pkg.owners,
        roles: pkg.roles,
        enabled: enabledMap[pkg.id],
        capabilityCount: null,
        coverage: null,
      }));
    }
    const adoption = await queries.integrationAdoption(d());
    const reporting = adoption.length;
    const integrations = statusList.map((pkg) => {
      const def = centralPackages.findPackage(pkg.id);
      const dflt = def ? Boolean(def.enabledByDefault) : false;
      const nodes = adoption.map((n) => {
        // No key for this package means the node never overrode it — so it runs the package's own
        // default, which only the defs know. That is why resolution happens here and not in the query.
        const explicit = Object.prototype.hasOwnProperty.call(n.packagesEnabled, pkg.id);
        return {
          nodeId: n.nodeId,
          label: n.label,
          enabled: explicit ? Boolean(n.packagesEnabled[pkg.id]) : dflt,
          explicit,
          factsReportedAt: n.factsReportedAt,
        };
      });
      const enabledCount = nodes.filter((n) => n.enabled).length;
      return {
        ...pkg,
        enabledByDefault: dflt,
        adoption: {
          reporting,
          enabled: enabledCount,
          disabled: reporting - enabledCount,
          // Nodes whose effective local state disagrees with the fleet decision. Meaningful under
          // authority (where the decision reaches them as grants); a plain fact in shadow.
          diverged: nodes.filter((n) => n.enabled !== pkg.enabled).length,
          nodes,
        },
      };
    });
    res.json({ mode: authority ? 'authority' : 'shadow', writable: authority, nodes: { reporting }, integrations });
  }));

  const requireAuthorityForWrite = async (res) => {
    if (await d().ddl.hasTable('policy_changes')) return true;
    res.status(409).json({
      error: 'central is in shadow mode — integrations are enabled fleet-wide only once central holds the policy tables (authority)',
    });
    return false;
  };

  app.post('/api/fleet/integrations/:id/enable', admin, wrap(async (req, res) => {
    if (!centralPackages.findPackage(req.params.id)) return res.status(404).json({ error: `unknown integration "${req.params.id}"` });
    if (!(await requireAuthorityForWrite(res))) return;
    await centralPackages.setEnabled(d(), req.params.id, true, 'admin');
    // Enable and sync are one action here, as they are on the node (server/app.js): turning a package
    // on that grants nothing until synced would be a toggle that does nothing until you remember a
    // second step.
    const sync = await centralPackages.syncPackage(d(), req.params.id, { actorScope: 'admin' });
    res.json({ integration: await integrationStatus(req.params.id), sync });
  }));

  app.post('/api/fleet/integrations/:id/disable', admin, wrap(async (req, res) => {
    if (!centralPackages.findPackage(req.params.id)) return res.status(404).json({ error: `unknown integration "${req.params.id}"` });
    if (!(await requireAuthorityForWrite(res))) return;
    // Disable records the decision only — it does NOT revoke, on purpose (see ./packages.js
    // revokePackage): a config toggle must not cut an in-flight agent off. Revoke is the explicit
    // "actually take it back".
    await centralPackages.setEnabled(d(), req.params.id, false, 'admin');
    res.json({ integration: await integrationStatus(req.params.id) });
  }));

  app.post('/api/fleet/integrations/:id/sync', admin, wrap(async (req, res) => {
    if (!centralPackages.findPackage(req.params.id)) return res.status(404).json({ error: `unknown integration "${req.params.id}"` });
    if (!(await requireAuthorityForWrite(res))) return;
    const sync = await centralPackages.syncPackage(d(), req.params.id, { actorScope: 'admin' });
    res.json({ integration: await integrationStatus(req.params.id), sync });
  }));

  app.post('/api/fleet/integrations/:id/revoke', admin, wrap(async (req, res) => {
    if (!centralPackages.findPackage(req.params.id)) return res.status(404).json({ error: `unknown integration "${req.params.id}"` });
    if (!(await requireAuthorityForWrite(res))) return;
    const revoke = await centralPackages.revokePackage(d(), req.params.id, { actorScope: 'admin' });
    res.json({ integration: await integrationStatus(req.params.id), revoke });
  }));

  /**
   * ONE INTEGRATION OR PROVIDER, IN FULL — the drill-down behind a card on the list above.
   *
   * The list route answers "how much of each package is granted"; this answers the question the
   * aggregate cannot — every capability the package owns, grouped by tier, crossed with the roles
   * its policy targets, with the live grant beside each pair (./packages.js packageDetail). The
   * page it backs turns each pair into a toggle, and those toggles are the ordinary
   * /api/policy/grants create/revoke — so this is READ-ONLY and the grant state it reports is the
   * same one those writes replicate.
   *
   * Authority-only, unlike the list read. The list's adoption axis needs no policy tables, so it
   * still answers in shadow; a per-role grant matrix is entirely a claim about grants that do not
   * live centrally until authority, so in shadow there is nothing true to return and it 409s with
   * the same reason the writes give.
   */
  app.get('/api/fleet/integrations/:id/detail', admin, wrap(async (req, res) => {
    if (!centralPackages.findPackage(req.params.id)) return res.status(404).json({ error: `unknown integration "${req.params.id}"` });
    if (!(await requireAuthorityForWrite(res))) return;
    res.json(await centralPackages.packageDetail(d(), req.params.id));
  }));

  /**
   * What the fleet's agents actually DID, as against what they were governed for — the read side
   * of item 1.
   *
   * Deliberately a `/api/fleet/native` of its own rather than a flag on `/api/fleet/usage`. The two
   * answer different questions and must not be summed: usage is decisions this system made, this is
   * observation. A caller that wanted "all activity" would be asking for a number with no meaning.
   */
  app.get('/api/fleet/native', admin, wrap(async (req, res) => {
    res.json(await queries.nativeSummary(d(), {
      sinceMs: windowMs(req),
      nodeId: req.query.nodeId || null,
      limit: req.query.limit,
    }));
  }));

  /**
   * The fleet's calls-over-time series — the chart the node used to draw for itself.
   *
   * A SEPARATE ROUTE FROM `/api/fleet/native`, because the two have different natural windows and
   * different costs. The summary is a handful of rollups a page loads once; this is up to 400
   * buckets that a chart re-fetches whenever someone changes the granularity, and folding it into
   * the summary would make every load pay for a series most callers are not looking at.
   */
  app.get('/api/fleet/native/series', admin, wrap(async (req, res) => {
    res.json(await queries.nativeSeries(d(), {
      granularity: req.query.granularity,
      windowMinutes: req.query.windowMinutes,
      nodeId: req.query.nodeId || null,
      toolName: req.query.toolName || null,
    }));
  }));

  /** Which machines are not governed. The one-line answer item 2 exists to make possible. */
  app.get('/api/fleet/hooks', admin, wrap(async (req, res) => {
    res.json({ nodes: await queries.hookIntegrity(d(), { onlyUnhealthy: req.query.unhealthy === '1' }) });
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
  if (!DEMO_READONLY) app.use(createEnrollmentAdminRouter(enrollmentStore, requireCert(['admin'])));

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

  // ------------------------------------------------------------------- the dashboard
  //
  // docs/design/dashboard-placement.md item 4: `client/dist` is served HERE, and only here. The
  // node's static mount is gone, so this is the fleet's one console.
  //
  // MOUNTED LAST, AFTER EVERY `/api/*` ROUTE AND BEFORE THE 404. Order is the whole of the
  // correctness here: `express.static` mounted earlier would answer an API path that happened to
  // collide with a filename, and the SPA fallback mounted earlier would swallow every unknown API
  // route into an HTML page — which is precisely the failure docs/design/upgrade-resilience.md
  // records for 2026-08-19, a server answering every request perfectly while missing the route the
  // callers needed. The fallback's own regex excludes `/api/` for the same reason, belt and braces.
  //
  // WITHOUT `requireCert`, deliberately, and it is the same call server/app.js used to make: a cold
  // page load has to get the shell rather than a 401, or the browser has no way to render the error
  // that explains itself. Nothing is authorised by receiving HTML — every `/api/*` route above
  // checks the certificate for itself, so an unauthenticated browser gets the app and no data.
  //
  // A MISSING BUNDLE IS NOT AN ERROR HERE. `npm run build` is a separate step and a central running
  // without it is a perfectly good API; saying so beats an ENOENT stack on every page load, and it
  // names the command rather than leaving an operator to guess.
  const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
  const INDEX_HTML = path.join(CLIENT_DIST, 'index.html');
  const bundleBuilt = fs.existsSync(INDEX_HTML);
  if (bundleBuilt) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(INDEX_HTML));
  } else {
    app.get(/^\/(?!api\/).*/, (req, res) => res.status(503).json({
      error: 'the dashboard bundle has not been built',
      detail: `no ${INDEX_HTML}. Run "npm run build" at the repo root, or rebuild the container image `
        + '— server/central/Dockerfile copies client/dist in. The API on this process is unaffected.',
    }));
  }

  app.use((req, res) => res.status(404).json({
    error: `no such route ${req.method} ${req.path}`,
    detail: 'central issues node credentials under /api/enroll, accepts usage under /api/ingest, answers '
      + 'fleet queries under /api/fleet, and serves the control plane under /api/policy '
      + '(docs/design/global-identity-and-central-db.md §2.7 phase 4; docs/design/setup-after-central.md §2).',
  }));

  return app;
}

module.exports = { buildApp, requireCert, rollupScopeFor, ALLOW_INSECURE };
