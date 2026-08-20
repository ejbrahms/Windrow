'use strict';
// The enrollment API: how a caller gets a per-node credential in the first place.
//
// This is deliberately a mountable Express router rather than more routes in server/app.js. That
// file is 2000+ lines and is edited by several people at once; a self-contained router means this
// change needs a two-line mount there instead of a merge.
//
// THE TRUST BOOTSTRAP
// Enrollment is the one place where authority is created rather than checked, so it is worth being
// explicit about what authorises it. It is not a certificate — a caller enrolling does not have one
// yet, which is the whole point. It is a **single-use enrollment token**, minted by an existing
// admin, short-lived, and stored only as a SHA-256 hash so that reading the database yields nothing
// usable. Spending one is what turns "somebody on the network" into "node X with scope Y", and it
// is spent atomically so two callers racing the same token produce exactly one certificate.
//
// TWO STORES, ONE ROUTER. This file is mounted against the node's synchronous better-sqlite3 store
// (server/store.js) and against central's asynchronous Postgres one
// (server/central/enrollmentStore.js), because docs/design/setup-after-central.md §2 puts the CA on
// central: a node on a second machine must be able to obtain a certificate CENTRAL's listener
// trusts, and there is no second endpoint at which it could. So every store call below is awaited.
// `await` on a non-promise is a no-op that costs one microtask, so the node's synchronous store
// keeps working through this file completely unchanged — which is the point, since a router that
// needed a promise-returning store would have meant forking it and maintaining the security
// argument in two places.
//
// The first admin has nowhere to get a token from, so first run writes a bootstrap token to a file
// only its owner can read and logs that it did. That is the same shape the old admin bearer token
// used, with the difference that matters: this one is spendable exactly once, expires, and what it
// buys is a credential bound to a private key that never leaves the enrolling machine.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ca = require('./ca');
const { writeSecret } = require('./secretFile');

// Overridable for the same reason WINDROW_CA_DIR is: the end-to-end test performs a real bootstrap,
// and without this it would drop a spendable admin credential into the live install's server/data/
// every time the test ran.
const BOOTSTRAP_TOKEN_PATH = process.env.WINDROW_BOOTSTRAP_TOKEN_PATH
  || path.join(__dirname, '..', 'data', 'bootstrap-enrollment-token');
// Long enough that guessing is hopeless, short-lived so a forgotten one stops working. 24 hours is
// an OOBE-shaped window: long enough to survive "I'll finish setting this up tomorrow", short
// enough that a token left in a chat log is dead by the time anyone finds it.
const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Turn a rejected promise into a JSON error response.
 *
 * Needed the moment these handlers became `async`. Express 4 catches a SYNCHRONOUS throw out of a
 * handler and turns it into a 500; a rejected promise it does not see at all, so the request hangs
 * until the client times out and Node reports an unhandled rejection — which on a recent runtime
 * terminates the process. `registerNode` throwing NodeConflictError is a real path here, not a
 * hypothetical, so the failure would have been a central that dies when an operator re-enrolls a
 * revoked node. `status` is honoured so a store's refusal can still be a 409 rather than a 500.
 */
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || (err.name === 'NodeConflictError' ? 409 : 500);
  if (status >= 500) console.error('[enroll]', req.method, req.path, '—', err.stack || err.message);
  if (!res.headersSent) res.status(status).json({ error: err.message });
});

/**
 * Build the router. `store` is injected rather than required at module load so this file stays
 * testable without a database, and so a store that has not yet grown the enrollment tables fails
 * with a clear 503 instead of a TypeError on the first request.
 */
function createEnrollmentRouter(store) {
  const router = express.Router();
  const root = ca.loadOrCreateCa();

  /** The enrollment tables land with server/store.js's `nodes`/`enrollment_tokens` work. */
  function storeReady() {
    return ['createEnrollmentToken', 'findEnrollmentTokenByHash', 'consumeEnrollmentToken',
      'registerNode', 'findNodeByCertSerial', 'listNodes', 'revokeNode']
      .every((fn) => typeof store[fn] === 'function');
  }
  function requireStore(req, res, next) {
    if (!storeReady()) {
      return res.status(503).json({ error: 'enrollment is unavailable: the store has no enrollment tables yet' });
    }
    next();
  }

  /**
   * The CA certificate. Public by design and safe to serve unauthenticated: it is a public key with
   * a signature on it, it is what a client needs in order to *verify* this server, and withholding
   * it would only mean every client had to be handed the same file out of band. A caller who has it
   * still cannot authenticate — that needs a private key this never discloses.
   */
  router.get('/api/enroll/ca', (req, res) => {
    res.type('application/x-pem-file').send(root.certPem);
  });

  /**
   * Spend an enrollment token, receive a client certificate.
   *
   * Unauthenticated by necessity — the token in the body *is* the authentication. Note what is not
   * accepted here: the caller does not choose its own nodeId or its own scope. Both come from the
   * token the admin minted, because a caller that could name its own scope could enroll itself as
   * admin, and a caller that could name its own nodeId could enroll itself as somebody else's node
   * and forge that node's events — the exact failure §2.5 describes.
   */
  router.post('/api/enroll', requireStore, wrap(async (req, res) => {
    const { enrollmentToken, publicKey, label } = req.body || {};
    if (!enrollmentToken || typeof enrollmentToken !== 'string') {
      return res.status(400).json({ error: 'enrollmentToken is required' });
    }
    if (!publicKey || typeof publicKey !== 'string') {
      return res.status(400).json({ error: 'publicKey is required (base64 SPKI DER)' });
    }

    const row = await store.findEnrollmentTokenByHash(hashToken(enrollmentToken));
    // One message for every rejection: unknown, expired, revoked and already-spent are told apart
    // in the log but not in the response, so this endpoint cannot be used to probe which tokens
    // exist.
    const reject = (why) => {
      console.warn('[enroll] rejected an enrollment attempt:', why);
      return res.status(401).json({ error: 'unauthorized: invalid or expired enrollment token' });
    };
    if (!row) return reject('no such token');
    if (row.revokedAt) return reject(`token ${row.id} is revoked`);
    if (row.usedAt) return reject(`token ${row.id} was already spent`);
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return reject(`token ${row.id} expired`);

    // The identifier the certificate binds MUST be the one the usage-event hash chain keys on, or
    // the two halves of this change do not meet: a certificate proving "node X" is worthless if the
    // events it authorises are filed under some other id. For a `node`-scoped enrollment — the
    // machine enrolling itself — that identifier already exists, minted by server/store.js, so it
    // is reused rather than a second one invented. Other scopes are callers rather than nodes and
    // get a fresh id.
    let nodeId;
    if (row.scope === 'node' && typeof store.nodeId === 'function') {
      nodeId = store.nodeId();
      const already = await store.findNodeByNodeId(nodeId);
      if (already && !already.revokedAt) {
        return res.status(409).json({
          error: `this machine is already enrolled as ${nodeId}; revoke it before re-enrolling`,
        });
      }
    } else {
      nodeId = `node-${crypto.randomBytes(8).toString('hex')}`;
    }

    // Spend the token BEFORE issuing, and only proceed if this caller won the race. Doing it in the
    // other order would let two simultaneous requests both mint a certificate against one token.
    // Falsy, or an `{ok: false}` verdict: the two stores report a lost race differently — central
    // returns null, server/store.js returns an object carrying the reason it lost — and an object
    // is truthy, so checking only for falsiness here would read every loss as a win and issue the
    // second certificate the single-use gate exists to prevent.
    const claimed = await store.consumeEnrollmentToken(row.id, nodeId);
    if (!claimed || claimed.ok === false) {
      return reject(`token ${row.id} lost the race to another enrollment`);
    }

    let issued;
    try {
      issued = ca.issueClientCert(root, {
        nodeId,
        scope: row.scope,
        spkiDer: Buffer.from(publicKey, 'base64'),
      });
    } catch (err) {
      // The token is already spent and deliberately stays spent: a caller that can retry with a
      // fresh key on the same token gets unlimited attempts at the one step that creates authority.
      console.error('[enroll] issuing failed after the token was spent:', err.message);
      return res.status(400).json({ error: `could not issue a certificate: ${err.message}` });
    }

    await store.registerNode({
      nodeId,
      label: typeof label === 'string' && label.trim() ? label.trim() : row.label || nodeId,
      scope: row.scope,
      enrolledAt: new Date().toISOString(),
      publicKey,
      certSerial: issued.serial,
      certFingerprint: issued.fingerprint,
      certNotAfter: issued.notAfter,
    });

    console.log(`[enroll] issued a ${row.scope} certificate to ${nodeId} (serial ${issued.serial})`);
    res.status(201).json({
      nodeId,
      scope: row.scope,
      certificate: issued.certPem,
      caCertificate: root.certPem,
      notAfter: issued.notAfter,
    });
  }));

  return router;
}

/**
 * Admin-only enrollment management.
 *
 * `requireAdmin` is passed in rather than imported, for two reasons. This file deliberately does not
 * import server/auth.js — auth.js's revocation check requires the store, and a cycle between the two
 * would be a genuinely confusing thing to debug. And it is applied **per route** rather than by the
 * caller wrapping the whole router: mounting a guard across a router with `app.use(guard, router)`
 * gates every request that reaches that mount point, including ones meant for later routes, which
 * silently locked non-admin callers out of unrelated endpoints when this was first wired up.
 */
function createEnrollmentAdminRouter(store, requireAdmin) {
  const router = express.Router();
  const admin = typeof requireAdmin === 'function' ? requireAdmin : (req, res, next) => next();

  router.post('/api/enrollment-tokens', admin, wrap(async (req, res) => {
    const { label, scope, ttlMs } = req.body || {};
    if (!ca.SCOPES.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of: ${ca.SCOPES.join(', ')}` });
    }
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const created = await store.createEnrollmentToken({
      tokenHash: hashToken(token),
      label: typeof label === 'string' ? label.trim() : null,
      scope,
      expiresAt: new Date(Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS)).toISOString(),
      createdByScope: req.authScope || null,
    });
    // The only time the token itself is ever readable. It is not stored anywhere in plaintext, so
    // an admin who loses it mints another rather than recovering this one.
    res.status(201).json({ ...created, token });
  }));

  router.get('/api/enrollment-tokens', admin, wrap(async (req, res) => res.json(await store.listEnrollmentTokens())));

  router.delete('/api/enrollment-tokens/:id', admin, wrap(async (req, res) => {
    const revoked = await store.revokeEnrollmentToken(req.params.id);
    if (!revoked) return res.status(404).json({ error: 'no such enrollment token' });
    res.json(revoked);
  }));

  router.get('/api/nodes', admin, wrap(async (req, res) => res.json(await store.listNodes())));

  /**
   * Revoke a node. This takes effect on that node's very next request, because `requireAuth` looks
   * the certificate serial up per request — there is no CRL to publish and no cache to wait out.
   */
  router.delete('/api/nodes/:nodeId', admin, wrap(async (req, res) => {
    const revoked = await store.revokeNode(req.params.nodeId, (req.body && req.body.reason) || null);
    if (!revoked) return res.status(404).json({ error: 'no such node' });
    console.log(`[enroll] revoked ${req.params.nodeId}`);
    res.json(revoked);
  }));

  return router;
}

/**
 * First-run bootstrap: with no admin node enrolled there is nobody who can mint the first
 * enrollment token, so mint one here and write it where only the installing user can read it.
 * Idempotent — once an admin node exists this does nothing, so a restart never reopens the window.
 */
async function ensureBootstrapToken(store) {
  if (typeof store.listNodes !== 'function' || typeof store.createEnrollmentToken !== 'function') return null;
  const hasAdmin = (await store.listNodes()).some((n) => n.scope === 'admin' && !n.revokedAt);
  if (hasAdmin) {
    // Tidy up: leaving a spendable admin token on disk after enrollment succeeded would be a
    // second, weaker credential for the strongest scope.
    try { fs.unlinkSync(BOOTSTRAP_TOKEN_PATH); } catch { /* nothing to remove */ }
    return null;
  }
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  await store.createEnrollmentToken({
    tokenHash: hashToken(token),
    label: 'bootstrap admin enrollment',
    scope: 'admin',
    expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    createdByScope: 'bootstrap',
  });
  writeSecret(BOOTSTRAP_TOKEN_PATH, token);
  console.log(
    `[enroll] no admin node is enrolled yet. A single-use bootstrap enrollment token has been ` +
    `written to ${BOOTSTRAP_TOKEN_PATH} and expires in 24h.`);
  return token;
}

module.exports = {
  createEnrollmentRouter,
  createEnrollmentAdminRouter,
  ensureBootstrapToken,
  hashToken,
  BOOTSTRAP_TOKEN_PATH,
};
