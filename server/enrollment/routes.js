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
  || path.join(require('../config').DATA_DIR, 'bootstrap-enrollment-token');
// Long enough that guessing is hopeless, short-lived so a forgotten one stops working. 24 hours is
// an OOBE-shaped window: long enough to survive "I'll finish setting this up tomorrow", short
// enough that a token left in a chat log is dead by the time anyone finds it.
const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// The ceiling on a join credential's use count. A number rather than "unlimited" because a token
// with no limit is a shared bearer secret, which is what per-node enrollment credentials replaced.
// Fifty is generous for a fleet being re-provisioned and small enough that a leaked token is a
// bounded incident an admin can reason about, alongside the TTL that was always there.
const MAX_JOIN_USES = Number(process.env.WINDROW_MAX_JOIN_USES) || 50;

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * What a nodeId is allowed to look like when a caller asks to keep one.
 *
 * Ids this server mints are `node-` plus sixteen hex characters, but ids in the field are not all
 * of that shape — a standalone install that joins a fleet brings the id its own `windrow.env`
 * minted, and refusing it would mean refusing the very history the id exists to keep together. So
 * this is a *safety* check, not a format check: printable, bounded, and free of anything that would
 * make an id ambiguous in a log line, a filename or a URL path.
 */
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/** The Common Name of a parsed certificate's subject. See client.js's copy on why this splits. */
function commonNameOf(parsed) {
  const line = String(parsed.subject || '')
    .split(/[\n\r/,]+/)
    .map((part) => part.trim())
    .find((part) => part.startsWith('CN='));
  return line ? line.slice(3).trim() || null : null;
}

/** The scope a certificate carries, encoded as the subject's OU by ./ca.js. */
function scopeOf(parsed) {
  const line = String(parsed.subject || '')
    .split(/[\n\r/,]+/)
    .map((part) => part.trim())
    .find((part) => part.startsWith('OU='));
  return line ? line.slice(3).trim() || null : null;
}

/**
 * VERIFY THAT THIS CALLER IS THE MACHINE ITS CERTIFICATE NAMES — the server half of
 * docs/design/disposable-nodes.md §2.1 and §2.2.
 *
 * Three checks, and all three are needed:
 *
 *   1. WE ISSUED IT. The presented certificate must chain to this CA. Without this a caller could
 *      present a self-signed certificate naming any node it liked.
 *   2. THE SIGNATURE VERIFIES against the presented certificate's public key. The certificate is
 *      public, so holding one proves nothing; only the private key does.
 *   3. IT IS OVER *THIS* ENROLMENT'S PUBLIC KEY. Signing anything else would let a proof captured
 *      off the wire be replayed to bind somebody else's key to this node's name.
 *
 * EXPIRY IS NOT CHECKED, deliberately. The case this exists for is a leaf that has run out, and a
 * renewal path that refused an expired certificate would be a renewal path that only works while
 * you do not need it. Expiry is a backstop for a node that stopped checking in; revocation is the
 * control, and the caller's roster row is checked for it before anything is issued.
 *
 * Returns `{ nodeId, scope, serial }`, or null for every failure — a caller is never told which of
 * the three checks it failed, for the same reason the token rejections are one message.
 */
function verifyRenewalProof(root, { currentCertificate, proof, spkiDer }) {
  if (!currentCertificate || !proof) return null;
  try {
    const presented = new crypto.X509Certificate(currentCertificate);
    const issuer = new crypto.X509Certificate(root.certPem);
    if (!presented.verify(issuer.publicKey)) return null;
    if (!crypto.verify(null, spkiDer, presented.publicKey, Buffer.from(proof, 'base64'))) return null;
    const nodeId = commonNameOf(presented);
    if (!nodeId || !NODE_ID_RE.test(nodeId)) return null;
    return { nodeId, scope: scopeOf(presented), serial: presented.serialNumber };
  } catch {
    return null;
  }
}

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
      'registerNode', 'findNodeByCertSerial', 'findNodeByNodeId', 'listNodes', 'revokeNode']
      .every((fn) => typeof store[fn] === 'function');
  }
  function requireStore(req, res, next) {
    if (!storeReady()) {
      return res.status(503).json({ error: 'enrollment is unavailable: the store has no enrollment tables yet' });
    }
    next();
  }

  /**
   * RENEWAL — a node trading a certificate it holds for a fresh one, spending nothing.
   *
   * docs/design/disposable-nodes.md §2.2: ./ca.js asserts renewal is automatic and it was not
   * implemented, so a year after install `client.load()` starts returning null, every caller reads
   * that as "no credential", and the node stops shipping and stops pulling **silently** while
   * enforcement runs on off a frozen replica until MAX_POLICY_AGE. This is the endpoint half of
   * closing that; server/enrollment/renewal.js is the loop that calls it in good time.
   *
   * Nothing here is a policy decision. The caller has already proved it is `proven.nodeId`; this
   * only checks that that node is still one this fleet recognises, and re-issues. Specifically it
   * does NOT let the caller change its scope: the scope comes off the ROSTER ROW, never off the
   * request and never off the presented certificate, so a renewal cannot be an escalation.
   */
  async function renew(req, res, { proven, spkiDer, publicKey, label }) {
    const known = await store.findNodeByNodeId(proven.nodeId);
    if (!known) {
      // The certificate verified, so this really is a machine this CA once knew — but there is no
      // roster row, which on central means an admin deleted it. Renewal is not a way back in.
      console.warn(`[enroll] refused a renewal for ${proven.nodeId}: no such node in the roster`);
      return res.status(401).json({ error: 'unauthorized: this node is not enrolled' });
    }
    if (known.revokedAt) {
      console.warn(`[enroll] refused a renewal for ${proven.nodeId}: revoked ${known.revokedAt}`);
      return res.status(403).json({ error: `node ${proven.nodeId} is revoked` });
    }

    const scope = known.scope || proven.scope || 'node';
    let issued;
    try {
      issued = ca.issueClientCert(root, { nodeId: proven.nodeId, scope, spkiDer });
    } catch (err) {
      return res.status(400).json({ error: `could not issue a certificate: ${err.message}` });
    }
    await store.registerNode({
      nodeId: proven.nodeId,
      label: typeof label === 'string' && label.trim() ? label.trim() : known.label || proven.nodeId,
      scope,
      enrolledAt: known.enrolledAt || new Date().toISOString(),
      publicKey,
      certSerial: issued.serial,
      certFingerprint: issued.fingerprint,
      certNotAfter: issued.notAfter,
    });
    console.log(`[enroll] renewed ${proven.nodeId} (${scope}): serial ${proven.serial} -> ${issued.serial}, valid to ${issued.notAfter}`);
    return res.status(201).json({
      nodeId: proven.nodeId,
      scope,
      certificate: issued.certPem,
      caCertificate: root.certPem,
      notAfter: issued.notAfter,
      renewed: true,
    });
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
    const { enrollmentToken, publicKey, label, nodeId: requestedNodeId, currentCertificate, proof } = req.body || {};
    if (!publicKey || typeof publicKey !== 'string') {
      return res.status(400).json({ error: 'publicKey is required (base64 SPKI DER)' });
    }
    const spkiDer = Buffer.from(publicKey, 'base64');
    // Who this caller can PROVE it is, before anything else is considered. Null on every ordinary
    // first enrolment, which is why the token path below is unchanged.
    const proven = verifyRenewalProof(root, { currentCertificate, proof, spkiDer });

    if (!enrollmentToken || typeof enrollmentToken !== 'string') {
      // RENEWAL WITHOUT A TOKEN — docs/design/disposable-nodes.md §2.2, and the only way a
      // year-long leaf can renew itself unattended. A token is an admin saying "somebody may become
      // a node"; a proof is this CA's own certificate plus its private key saying "I am already
      // that node", which is strictly the stronger statement. What it CANNOT do is change anything
      // about the node — not its scope, not its id, not its revocation — so a renewal grants
      // nothing that was not already granted.
      if (!proven) return res.status(400).json({ error: 'enrollmentToken is required' });
      return renew(req, res, { proven, spkiDer, publicKey, label });
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
    // `uses < maxUses` rather than "has it been used" — docs/design/dashboard-placement.md item 7.
    // A token minted without asking for more has maxUses 1 and behaves exactly as before; a join
    // credential an admin minted with a count and a TTL can re-provision that many machines inside
    // that window. This is only the log line's version of the check; `consumeEnrollmentToken` is
    // the one that counts, and it re-evaluates all of it atomically.
    if ((row.uses ?? 0) >= (row.maxUses ?? 1)) {
      return reject(`token ${row.id} has been spent ${row.uses} of ${row.maxUses} time(s)`);
    }
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return reject(`token ${row.id} expired`);

    // The identifier the certificate binds MUST be the one the usage-event hash chain keys on, or
    // the two halves of this change do not meet: a certificate proving "node X" is worthless if the
    // events it authorises are filed under some other id. For a `node`-scoped enrollment — the
    // machine enrolling itself — that identifier already exists, minted by server/store.js, so it
    // is reused rather than a second one invented. Other scopes are callers rather than nodes and
    // get a fresh id.
    // THE CLAIM, and the fix docs/design/disposable-nodes.md §2.1 calls the highest-value one in the
    // document. Three sources, strongest first:
    //
    //   1. `store.nodeId()` — this store IS the machine. Only ever true when a node issues to
    //      itself; central has no such method and deliberately never will
    //      (server/central/enrollmentStore.js's header says why).
    //   2. `proven.nodeId` — a certificate this CA issued, plus a signature by its key. Not a
    //      claim at all: an authenticated statement.
    //   3. `body.nodeId` — this machine saying which id it already answers to, out of its own
    //      `windrow.env` or an expired credential.
    //
    // Until (2) and (3) existed, central fell straight through to the random branch below on every
    // re-enrolment, so the roster grew a ghost row per rebuild and both halves of item 7 — a join
    // credential with a use count, an identity that lives outside the database — bought nothing.
    //
    // WHAT AUTHORISES (3), which is the only one of the three a caller could lie about. Claiming an
    // id NOBODY HOLDS is free and always allowed: no history is attached to it, and honouring it is
    // what lets a standalone node join a fleet without orphaning the chain it has already written.
    // Claiming an id that IS held requires a join credential — `maxUses > 1`, an admin's explicit
    // statement that these machines are expected to come and go — exactly as the re-provisioning
    // path already required. That is a real widening and it is stated rather than hidden: a holder
    // of an unspent join credential can re-provision *as* any un-revoked node in the fleet. Its
    // bounds are the token's TTL, its use count and its revocability; a fleet that wants the
    // stronger property should mint single-use tokens and let renewal (the proof path above) carry
    // the re-provisioning instead.
    const localNodeId = typeof store.nodeId === 'function' ? store.nodeId() : null;
    const claimedNodeId = localNodeId
      || (proven && proven.nodeId)
      || (typeof requestedNodeId === 'string' && NODE_ID_RE.test(requestedNodeId) ? requestedNodeId : null);

    let nodeId;
    if (row.scope === 'node' && claimedNodeId) {
      nodeId = claimedNodeId;
      const already = await store.findNodeByNodeId(nodeId);
      // A REVOKED NODE MAY NEVER BE RE-CLAIMED, and this is checked here as well as in
      // `registerNode` because here is where the id is *chosen*: falling through to the random
      // branch would silently hand a revoked machine a working certificate under a new name, which
      // is a revocation that revokes nothing.
      if (already && already.revokedAt) {
        return res.status(403).json({
          error: `node ${nodeId} is revoked and cannot re-enroll; an admin must clear the revocation first`,
        });
      }
      // RE-ENROLLING AN ALREADY-ENROLLED MACHINE IS ALLOWED WHEN THE TOKEN SAYS SO — item 7.
      //
      // This used to be a flat 409: enrol once, and to do it again an admin had to revoke the node
      // first. That is right for a machine somebody installs once and it is the specific thing
      // that makes a node undisposable — a rebuild would have to be a two-person operation, so
      // "reinstall rather than debug" stops being available exactly when it is most wanted.
      //
      // A JOIN CREDENTIAL IS WHAT AUTHORISES IT, not a relaxation of the rule. A single-use token
      // still gets the 409, because spending one on a machine that is already enrolled is much
      // more likely to be a mistake than a plan. A token an admin minted with `maxUses > 1` is an
      // explicit statement that these machines are expected to come and go, and re-provisioning is
      // what it is for.
      //
      // A REVOKED NODE IS STILL REFUSED, and that is checked below in `registerNode` as well as
      // here: re-enrolment must never be a way to clear a revocation, or revoking anything would
      // be pointless. That guard is unchanged and load-bearing.
      //
      // A PROOF PASSES THIS GATE TOO, and has to. A machine renewing its own certificate is
      // already enrolled by definition, so requiring a join credential for it would mean a fleet
      // could only stay alive by keeping a multi-use token permanently in circulation — which is
      // the shared bearer secret this whole mechanism replaced.
      const reprovisionable = (row.maxUses ?? 1) > 1;
      if (already && !already.revokedAt && !reprovisionable && !proven) {
        return res.status(409).json({
          error: `this machine is already enrolled as ${nodeId}; revoke it before re-enrolling, or `
            + 'use a join credential (POST /api/enrollment-tokens with maxUses > 1) if this node is '
            + 'expected to be rebuilt',
        });
      }
      if (already && !already.revokedAt) {
        console.log(
          `[enroll] re-provisioning ${nodeId} against ${proven ? 'its own certificate' : `join credential ${row.id}`}`
          + ' — issuing a new certificate.'
        );
      }
    } else {
      // Nothing to keep: a caller that has never had an identity, or a scope other than `node`
      // (those are callers rather than machines and file no events, so a fresh id costs nothing).
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
    const { label, scope, ttlMs, maxUses } = req.body || {};
    if (!ca.SCOPES.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of: ${ca.SCOPES.join(', ')}` });
    }
    // A JOIN CREDENTIAL IS A TOKEN WITH A COUNT — docs/design/dashboard-placement.md item 7.
    // Omitted means 1, which is the single-use token this endpoint has always minted, so nothing
    // an existing caller does changes. Ceilinged rather than unbounded on purpose: a token with no
    // limit is a shared bearer secret, and abolishing exactly that is what per-node credentials
    // were introduced for (§2.5 — one fleet-wide token means any node can forge any other node's
    // stream). A bounded count keeps the blast radius a number an admin chose and can look up.
    const uses = Number(maxUses);
    if (maxUses !== undefined && (!Number.isFinite(uses) || uses < 1 || uses > MAX_JOIN_USES)) {
      return res.status(400).json({ error: `maxUses must be between 1 and ${MAX_JOIN_USES}` });
    }
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const created = await store.createEnrollmentToken({
      tokenHash: hashToken(token),
      label: typeof label === 'string' ? label.trim() : null,
      scope,
      expiresAt: new Date(Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS)).toISOString(),
      createdByScope: req.authScope || null,
      maxUses: maxUses === undefined ? 1 : Math.trunc(uses),
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
