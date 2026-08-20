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

const DEFAULT_DIR = process.env.WINDROW_CREDENTIAL_DIR || path.join(__dirname, '..', 'data', 'credentials');

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
 * Enroll, or reuse an existing valid credential.
 *
 * `enrollmentToken` is the single-use secret an admin minted. It is spent on the first call and is
 * useless afterwards, so a caller that already has a certificate never needs one again — which is
 * why `force` has to be asked for explicitly.
 */
async function enroll({ name, baseUrl, enrollmentToken, label, caPem, dir = DEFAULT_DIR, force = false }) {
  if (!force) {
    const existing = load(name, dir);
    if (existing) return existing;
  }
  if (!enrollmentToken) {
    throw new Error(`no credential for "${name}" and no enrollment token given — mint one with POST /api/enrollment-tokens`);
  }
  const rootPem = caPem || await get(`${baseUrl}/api/enroll/ca`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const result = await post(`${baseUrl}/api/enroll`, {
    enrollmentToken,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    label: label || name,
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

module.exports = { enroll, load, save, agentFor, paths, DEFAULT_DIR };
