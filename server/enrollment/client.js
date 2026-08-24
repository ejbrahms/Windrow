'use strict';
// The enrolling side: how a caller obtains and then uses a per-node credential.
//
// Used by the MCP server, the CLI entry points and OOBE. The shape is the same everywhere and the
// important part is what it does NOT do: the private key is generated here, on this machine, and
// never sent anywhere. Enrollment uploads a public key and downloads a certificate. That is the
// difference between this and the shared bearer tokens it replaces — a token had to be copied to
// every caller that needed it, so possessing one proved nothing about who you were
// (docs/design/global-identity-and-central-db.md §2.5).

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { writeSecret, isOwnerOnly } = require('./secretFile');

const { DATA_DIR } = require('../config');

const DEFAULT_DIR = process.env.WINDROW_CREDENTIAL_DIR || path.join(DATA_DIR, 'credentials');

/** Where one caller's credential lives. Separate directories keep two callers' keys distinct. */
function paths(name, dir = DEFAULT_DIR) {
  return {
    key: path.join(dir, `${name}-key.pem`),
    cert: path.join(dir, `${name}-cert.pem`),
    ca: path.join(dir, `${name}-ca.pem`),
    meta: path.join(dir, `${name}.json`),
  };
}

function load(name, dir) {
  const p = paths(name, dir);
  try {
    const cert = fs.readFileSync(p.cert, 'utf8');
    const parsed = new crypto.X509Certificate(cert);
    // An expired certificate is treated as absent so the caller re-enrolls rather than failing
    // every request with a handshake error that says nothing about the cause.
    //
    // "Absent" IS THE PROBLEM, not the fix, and docs/design/disposable-nodes.md §2.2 measures it:
    // every caller reads null as "never enrolled", so at expiry the node stops shipping and stops
    // pulling with nothing anywhere saying why. `load` keeps this shape because a hundred call
    // sites depend on it — `inspect()` below is the loud version, and server/enrollment/renewal.js
    // is what makes sure nobody reaches this line in the first place.
    if (new Date(parsed.validTo).getTime() <= Date.now()) return null;
    const key = fs.readFileSync(p.key, 'utf8');
    if (!isOwnerOnly(p.key)) {
      console.warn(`[enroll] ${p.key} is readable by other accounts on this machine`);
    }
    return {
      key,
      cert,
      ca: fs.readFileSync(p.ca, 'utf8'),
      meta: JSON.parse(fs.readFileSync(p.meta, 'utf8')),
    };
  } catch {
    return null;
  }
}

/** The Common Name out of a parsed certificate's subject — the nodeId enrollment bound to it. */
function commonNameOf(parsed) {
  // Split rather than matched: node renders a subject as newline-separated `KEY=value` pairs on
  // some versions and slash-separated on others, and a regex that assumed one silently returned
  // null on the other — which reads as "this machine has no identity" at exactly the wrong moment.
  const line = String(parsed.subject || '')
    .split(/[\n\r/,]+/)
    .map((part) => part.trim())
    .find((part) => part.startsWith('CN='));
  return line ? line.slice(3).trim() || null : null;
}

/**
 * What is on disk for `name`, EXPIRY AND ALL — the answer `load` cannot give because it collapses
 * "expired" into "absent" (docs/design/disposable-nodes.md §2.2).
 *
 * Returns null only when there is genuinely nothing there. Otherwise `{ meta, notAfter, expired,
 * expiresInMs, cert, key, ca }`, so a renewal loop can act on "eleven days left" and a health
 * report can say "expired six days ago" instead of the silence that costs a fleet a node.
 */
function inspect(name, dir) {
  const p = paths(name, dir);
  let cert;
  try {
    cert = fs.readFileSync(p.cert, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = new crypto.X509Certificate(cert);
  } catch (err) {
    // A credential file that will not parse is a fault, not an absence, and it is reported as one.
    return { meta: null, notAfter: null, expired: true, expiresInMs: null, unreadable: err.message, cert, key: null, ca: null };
  }
  const notAfterMs = new Date(parsed.validTo).getTime();
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch { /* the certificate is the record that counts */ }
  let key = null;
  try { key = fs.readFileSync(p.key, 'utf8'); } catch { /* a certificate with no key is unusable but still identifying */ }
  let ca = null;
  try { ca = fs.readFileSync(p.ca, 'utf8'); } catch { /* fetched again if missing */ }
  return {
    // The meta file is a convenience; the certificate's Common Name is the identity itself, so a
    // lost or corrupt .json does not lose this machine's name.
    meta: meta || { nodeId: commonNameOf(parsed) },
    notAfter: new Date(notAfterMs).toISOString(),
    expired: notAfterMs <= Date.now(),
    expiresInMs: notAfterMs - Date.now(),
    cert,
    key,
    ca,
  };
}

/**
 * THE IDENTITY THIS MACHINE ALREADY ANSWERS TO, in the order that decides it, and the reason a
 * rebuild can keep its name (docs/design/disposable-nodes.md §2.1).
 *
 *   1. WINDROW_NODE_ID — the override, whether real or lifted out of `windrow.env`.
 *   2. the credential on disk, EXPIRED OR NOT — an expired certificate has stopped being an
 *      authenticator but it has not stopped saying who this box is, and re-enrolment is exactly
 *      when that distinction matters.
 *
 * Null means this machine has never had an identity, which is the one case where central minting a
 * fresh one is right.
 */
function currentNodeId(name, dir) {
  if (process.env.WINDROW_NODE_ID) return process.env.WINDROW_NODE_ID;
  const found = inspect(name || process.env.WINDROW_SHIP_CREDENTIAL_NAME || 'node-shipper', dir);
  return (found && found.meta && found.meta.nodeId) || null;
}

function save(name, dir, { key, cert, ca, meta }) {
  const p = paths(name, dir);
  writeSecret(p.key, key);
  // The certificate and the CA are public; only the key is a secret. They are still written
  // through the same helper so the whole credential directory has one consistent owner.
  writeSecret(p.cert, cert);
  writeSecret(p.ca, ca);
  writeSecret(p.meta, JSON.stringify(meta, null, 2));
}

function post(url, body, caPem) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      // During enrollment we do not have a client certificate yet — that is what we are here for —
      // but we do verify the server, so a caller cannot be talked into enrolling with an impostor
      // that would then hold its public key and a nodeId it chose.
      ...(caPem ? { ca: caPem } : {}),
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
        if (res.statusCode >= 400) return reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    // The CA certificate is fetched before we have anything to verify it against, so this one hop
    // is trust-on-first-use. That is acceptable only because it runs on the same machine as the
    // server during OOBE; a remote enrollment should be handed the CA file out of band instead,
    // which is why `enroll()` accepts one.
    // The fields are named rather than spread from `target`. A URL's properties live on its
    // prototype as getters, so `{...new URL(u)}` is an EMPTY object — http.request then fell back to
    // its defaults and dialled localhost:443 whatever URL it was handed, which is invisible on the
    // loopback OOBE path only because nothing there ever reached this function with a caPem absent
    // and a port that mattered. docs/design/setup-after-central.md §2's remote enrollment reaches it
    // on every run.
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search || ''}`,
      method: 'GET',
      rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(text)));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Prove this caller is the machine its existing certificate names — the credential half of
 * docs/design/disposable-nodes.md §2.1 and §2.2.
 *
 * A certificate is public. Presenting one proves nothing, so what is sent is a SIGNATURE over the
 * new enrolment's public key, made with the private key the old certificate attests. That binds
 * three things together in one artefact: *who* (the CN central will read off the presented
 * certificate), *what is being asked for* (this exact new key, so the signature cannot be replayed
 * onto somebody else's enrolment), and *proof* (only the holder of the old key could have made it).
 *
 * Expiry is deliberately NOT checked here. Renewing a certificate that expired yesterday is the
 * case this exists for; central decides how much grace to give, because central is the side that
 * can be wrong about the clock without anybody noticing.
 */
function renewalProof(existing, newSpkiDer) {
  try {
    const signature = crypto.sign(null, Buffer.from(newSpkiDer), crypto.createPrivateKey(existing.key));
    return { currentCertificate: existing.cert, proof: signature.toString('base64') };
  } catch {
    // A key that will not sign is a broken credential, not a reason to fail the enrolment: fall
    // back to the token path, which is what an operator running this by hand already expects.
    return {};
  }
}

/**
 * Enroll, or reuse an existing valid credential.
 *
 * `enrollmentToken` is the single-use secret an admin minted. It is spent on the first call and is
 * useless afterwards, so a caller that already has a certificate never needs one again — which is
 * why `force` has to be asked for explicitly.
 *
 * IT IS ALSO OPTIONAL NOW, in exactly one case: a caller holding a credential this CA issued can
 * renew without a token, because `renewalProof` proves who it is at least as well as a token an
 * admin minted for anybody. That is what makes §2.2's renewal loop possible at all — a year-long
 * leaf that needed a fresh admin-minted secret to renew would need an admin awake once a year per
 * node, which is not a renewal mechanism.
 */
async function enroll({
  name, baseUrl, enrollmentToken, label, caPem, dir = DEFAULT_DIR, force = false, nodeId = undefined,
}) {
  if (!force) {
    const existing = load(name, dir);
    if (existing) return existing;
  }
  const existingCert = inspect(name, dir);
  // THE ID THIS MACHINE IS ASKING TO KEEP. Central cannot work it out — it has no `nodeId()` and
  // never will (server/central/enrollmentStore.js's header says why) — so until this field existed
  // it minted a random one on every re-enrolment and the roster grew a ghost per rebuild
  // (docs/design/disposable-nodes.md §2.1). It is a REQUEST, not an assertion: central honours it
  // only for an id nobody holds, or for one this caller proves it already holds, and the proof is
  // `currentCertificate` below.
  const claimedNodeId = nodeId !== undefined ? nodeId : currentNodeId(name, dir);
  if (!enrollmentToken && !(existingCert && existingCert.cert && existingCert.key)) {
    throw new Error(`no credential for "${name}" and no enrollment token given — mint one with POST /api/enrollment-tokens`);
  }
  const rootPem = caPem || (existingCert && existingCert.ca) || await get(`${baseUrl}/api/enroll/ca`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const result = await post(`${baseUrl}/api/enroll`, {
    enrollmentToken,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    label: label || name,
    ...(claimedNodeId ? { nodeId: claimedNodeId } : {}),
    // PROOF OF POSSESSION, and the whole reason a renewal needs no token at all. The certificate is
    // public, so presenting it proves nothing by itself; the signature over the enrolment's own
    // public key, made with the key that certificate attests, is what proves this caller is the
    // machine the certificate names. See `renewalProof` and routes.js's `verifyRenewalProof`.
    ...(existingCert && existingCert.cert && existingCert.key
      ? renewalProof(existingCert, publicKey.export({ type: 'spki', format: 'der' }))
      : {}),
  }, rootPem);

  const credential = {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: result.certificate,
    ca: result.caCertificate || rootPem,
    meta: { nodeId: result.nodeId, scope: result.scope, notAfter: result.notAfter, enrolledAt: new Date().toISOString() },
  };
  save(name, dir, credential);
  return credential;
}

/**
 * An https.Agent that presents this credential. Keep-alive is on because, unlike a hook, every
 * caller of this function is a long-lived process that will make many requests — which is exactly
 * why those callers can afford mTLS and hooks cannot (see the header of server/auth.js).
 */
function agentFor(credential) {
  return new https.Agent({
    key: credential.key,
    cert: credential.cert,
    ca: credential.ca,
    keepAlive: true,
    servername: 'localhost',
  });
}

module.exports = { enroll, load, inspect, currentNodeId, save, agentFor, paths, DEFAULT_DIR };
