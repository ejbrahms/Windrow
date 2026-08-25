'use strict';
// Authentication: who is calling, and with what authority.
//
// WHAT CHANGED AND WHY
// This file used to hold three *shared* bearer tokens — admin, agent, proposer — and documented
// `WINDROW_AGENT_TOKEN` as the way to "share tokens across a fleet of hosts". That sentence was
// the vulnerability. docs/design/global-identity-and-central-db.md §2.5 states it plainly: a
// central ingest endpoint accepting one fleet-wide agent token means **any node can forge any
// other node's usage events and any user's attribution**, which is precisely the property Part 1
// exists to establish. A shared secret says "a caller"; it cannot say *which* caller. No amount of
// tightening what the hook self-asserts fixes that, because the assertion and the credential are
// equally unowned (§1.5).
//
// So credentials are now **per-node and enrollment-issued**. Each caller generates a keypair on
// its own machine, spends a single-use enrollment token, and receives an X.509 client certificate
// whose Common Name is its nodeId and whose Organizational Unit is its scope
// (server/enrollment/ca.js). The private key never leaves the machine that generated it, so a
// credential is no longer a bearer secret that can be copied out of a file and replayed by anyone
// who reads it.
//
// TWO LISTENERS, AND WHY THE HOOK IS EXEMPT
// Certificates authenticate the dashboard, the MCP server and the CLI over mutual TLS. Hooks are
// deliberately excluded, and that is a measurement, not a preference: a PreToolUse/PostToolUse
// hook is a *fresh Node process per tool call*, so it can never reuse a connection, and
// docs/design/latency-breakdown.md records ~20 ms lost merely to `fetch()` building its agent
// lazily in every process. A TLS handshake has the same shape and is worse. §2.2's own topology
// says the same thing: hooks reach the node agent over loopback at ~2 ms, and it is the *agent*
// that holds the mTLS credential to central.
//
// Hence:
//   - the **mTLS listener** (HTTPS) carries `admin`, `proposer` and `node` scopes, by certificate.
//   - the **loopback listener** (plaintext HTTP, bound to 127.0.0.1 only) carries `agent` scope,
//     by bearer token, for hooks alone.
// The listener a request arrived on is read from `req.socket.encrypted` rather than passed in, so
// no coordination with the listener setup is needed and the two can never be confused.
//
// The agent token survives, but the thing that made it dangerous does not: it is generated locally,
// stored in a file only its owner can read, and has **no environment-variable override**, so there
// is no longer any supported way to make one token valid on two machines. It is a machine-local
// credential by construction, not by convention. It also cannot reach a registry-mutating route
// (`requireAdmin` below), which was already true and remains the reason a compromised skill that
// reads the token file off disk still cannot grant itself anything.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeSecret, isOwnerOnly } = require('./enrollment/secretFile');
const { envCompat } = require('./config');

const AGENT_TOKEN_PATH = envCompat('AGENT_TOKEN_PATH', {
  fallback: path.join(__dirname, 'data', 'agent-api-token'),
});

// The OWNER SIGNING KEY — a second, owner-only HMAC secret, and deliberately NOT the agent token.
//
// Why a second key at all: the agent token is a BEARER credential. Every hook process holds it and
// puts it on the wire as `Authorization: Bearer` on every loopback API call, and the whole signed-
// file model already accepts that "a process that can read AGENT_TOKEN can forge a signed file"
// (server/hooks/lib.js, server/maintenance.js). That is tolerable for the tier-scoped artifacts it
// signs — until the all-tier enforcement pause, the one artifact that suppresses even destructive
// and unknown-tier denials (server/enforcementPause.js). Forging THAT with nothing but the token
// every hook already carries is too cheap.
//
// So the all-tier pause is signed a SECOND time with this key. It differs from the agent token in
// exactly the way that matters: it is never a bearer credential, never travels on any request, and
// is only ever used by the signing code (server, at mint time) and the verifying code (hooks, which
// only READ it to check the second signature — they never mint). The agent token that leaks off the
// wire, or that a compromised skill lifts because a hook was about to send it, is no longer enough
// on its own to forge the most dangerous pause there is.
//
// This is still symmetric HMAC, so a process that can read THIS file can still forge — the same
// local-filesystem trust boundary the rest of this system accepts. What the second key removes is
// narrower and real: the hook-readable, wire-travelling agent token is no longer sufficient by
// itself for an all-tier pause. Like the agent token, it has no env-var override that could carry
// it between machines.
const OWNER_SIGNING_KEY_PATH = envCompat('OWNER_SIGNING_KEY_PATH', {
  fallback: path.join(__dirname, 'data', 'owner-signing-key'),
});

/**
 * Load or create an owner-only secret. Shared shape for both the agent token and the owner signing
 * key: read it if present (repairing an ACL a backup/copy/unzip stripped, rather than trusting it
 * silently), otherwise mint fresh bytes owner-only.
 */
function loadOrCreateSecret(filePath, bytes = 24) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) {
      // A secret file that lost its ACL (restored from a backup, copied with xcopy, unzipped) is
      // readable by every account on the machine. Repair it rather than trusting it silently.
      if (!isOwnerOnly(filePath)) writeSecret(filePath, existing);
      return existing;
    }
  } catch {
    // no file yet — generate one below
  }
  const secret = crypto.randomBytes(bytes).toString('hex');
  writeSecret(filePath, secret);
  return secret;
}

/**
 * The hook credential. Deliberately has no env-var override that could carry it between machines —
 * see the header. `WINDROW_AGENT_TOKEN_PATH` still exists because relocating the file on one
 * machine is not the same thing as sharing one secret across many.
 */
function loadOrCreateAgentToken() {
  return loadOrCreateSecret(AGENT_TOKEN_PATH);
}

const AGENT_TOKEN = loadOrCreateAgentToken();
// Minted on first use by whichever process loads this module first (server or a hook), exactly as
// the agent token is — establishing the shared secret is not the same act as minting a pause with
// it, which stays server-side and admin-scoped.
const OWNER_SIGNING_KEY = loadOrCreateSecret(OWNER_SIGNING_KEY_PATH, 32);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Whether a request arrived over loopback. The agent token is only honoured here, so that even if
 * the plaintext listener were ever bound beyond 127.0.0.1 by mistake, the token still could not be
 * used from another machine — the property has two independent guards rather than one.
 */
function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

let warnedNoRevocationCheck = false;

/**
 * Reject a certificate belonging to a node that has been revoked.
 *
 * mTLS has no built-in revocation short of a CRL or an OCSP responder, and standing either up here
 * would be far more machinery than this earns. Every caller already reaches this server on every
 * request, so revocation is a `nodes` lookup on the presented serial — the sub-second window §2.4
 * asks for, at the cost of one indexed prepared statement.
 *
 * `store` is required lazily: this module is loaded by CLI entry points that never serve a request,
 * and it must not drag the database open behind them.
 */
function isRevoked(serial) {
  let store;
  try {
    store = require('./store');
  } catch {
    return false;
  }
  if (typeof store.findNodeByCertSerial !== 'function') {
    // The `nodes` table is not present yet. Nothing is being bypassed — with no table there are no
    // enrolled nodes and so no revocations to miss — but say so once, because a *silently* absent
    // revocation check is exactly the kind of thing that stays absent.
    if (!warnedNoRevocationCheck) {
      warnedNoRevocationCheck = true;
      console.warn('[auth] store.findNodeByCertSerial is unavailable — certificate revocation is not being checked');
    }
    return false;
  }
  const node = store.findNodeByCertSerial(serial);
  // An unknown serial is refused, not allowed. A certificate this CA signed but that no `nodes`
  // row claims is one whose enrollment did not complete, or whose row was deleted; either way it
  // has no node behind it and authorising it would recreate the "a caller, but which?" hole.
  if (!node) return true;
  return Boolean(node.revokedAt);
}

/**
 * Express middleware: establishes who is calling.
 *
 * On success it sets:
 *   - `req.authScope`  — 'admin' | 'proposer' | 'node' | 'agent'
 *   - `req.nodeId`     — the enrolled node's id, or null for the hook token
 *   - `req.credential` — 'mtls' | 'agent-token'
 *   - `req.tokenScope` — kept as an alias of `req.authScope`, because server/app.js records it on
 *                        audit and approval rows and those columns should not churn for a rename.
 */
function requireAuth(req, res, next) {
  // TLS listener: authenticate by certificate. `req.socket.encrypted` is set by Node's tls module,
  // so it reflects how the connection was actually made rather than anything a caller can assert.
  if (req.socket.encrypted) {
    if (!req.socket.authorized) {
      return res.status(401).json({
        error: 'unauthorized: a valid enrolled client certificate is required',
        detail: req.socket.authorizationError ? String(req.socket.authorizationError) : undefined,
      });
    }
    const peer = req.socket.getPeerCertificate();
    if (!peer || !peer.subject) {
      return res.status(401).json({ error: 'unauthorized: no client certificate presented' });
    }
    const scope = peer.subject.OU;
    const nodeId = peer.subject.CN;
    if (!scope || !nodeId) {
      return res.status(401).json({ error: 'unauthorized: client certificate is missing a scope or node id' });
    }
    if (isRevoked(peer.serialNumber)) {
      return res.status(403).json({ error: 'forbidden: this node\'s certificate has been revoked' });
    }
    req.authScope = scope;
    req.tokenScope = scope;
    req.nodeId = nodeId;
    req.credential = 'mtls';
    return next();
  }

  // Plaintext listener: hooks only, agent scope only, loopback only.
  if (!isLoopback(req)) {
    return res.status(401).json({ error: 'unauthorized: this endpoint requires a client certificate' });
  }
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value || !safeEqual(value, AGENT_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized: missing or invalid agent token' });
  }
  req.authScope = 'agent';
  req.tokenScope = 'agent';
  req.nodeId = null;
  req.credential = 'agent-token';
  return next();
}

/**
 * Express middleware: only an admin-scoped certificate may proceed. Chain after `requireAuth`.
 *
 * Note this is now unreachable from the plaintext listener by construction rather than by check:
 * that listener only ever issues `agent` scope, so a hook cannot present admin authority even if
 * it obtained an admin credential, because there is no route from that socket to this scope.
 */
function requireAdmin(req, res, next) {
  if (req.authScope !== 'admin') {
    return res.status(403).json({ error: 'forbidden: this endpoint requires an admin certificate' });
  }
  next();
}

/**
 * Express middleware: an admin or proposer certificate may proceed — the propose endpoints
 * (server/app.js's POST /api/grants/propose and POST /api/grants/:id/propose-revoke) are the one
 * place a non-admin caller may *initiate* a registry change, precisely because it cannot make that
 * change take effect on its own: they queue an `approvals` row and only admin can decide one, so a
 * human stays structurally in the loop. Chain after `requireAuth`.
 */
function requireProposer(req, res, next) {
  if (req.authScope !== 'admin' && req.authScope !== 'proposer') {
    return res.status(403).json({ error: 'forbidden: this endpoint requires an admin or proposer certificate' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireProposer,
  isLoopback,
  AGENT_TOKEN,
  AGENT_TOKEN_PATH,
  OWNER_SIGNING_KEY,
  OWNER_SIGNING_KEY_PATH,
};
