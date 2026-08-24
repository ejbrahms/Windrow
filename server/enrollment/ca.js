'use strict';
// The per-install enrollment CA: the root of trust that replaces the fleet-wide shared bearer
// tokens (docs/design/global-identity-and-central-db.md §2.5).
//
// The property being bought is the one §2.5's warning block names. A shared `WINDROW_AGENT_TOKEN`
// says only "a caller", so a central ingest endpoint accepting it cannot tell one node from
// another and any node can forge any other node's usage events and any user's attribution. A
// certificate issued here says *which* node — the nodeId is the certificate's Common Name, bound
// to a private key that never leaves the machine it was generated on, because enrollment ships a
// public key and gets a certificate back.
//
// What this CA deliberately does NOT have is a CRL or an OCSP responder. Both are real
// infrastructure and neither is needed: every caller already reaches this server on every request,
// so revocation is a `nodes` table lookup on the presented certificate's serial (server/auth.js),
// which is the sub-second revocation window §2.4 asks for at none of the cost. Certificate expiry
// is the backstop for a node that stops checking in, not the revocation mechanism.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const x509 = require('./x509');
const { writeSecret } = require('./secretFile');

const { DATA_DIR } = require('../config');

const CA_DIR = process.env.WINDROW_CA_DIR || path.join(DATA_DIR, 'ca');
const CA_KEY_PATH = path.join(CA_DIR, 'ca-key.pem');
const CA_CERT_PATH = path.join(CA_DIR, 'ca-cert.pem');
const SERVER_KEY_PATH = path.join(CA_DIR, 'server-key.pem');
const SERVER_CERT_PATH = path.join(CA_DIR, 'server-cert.pem');

const ORG = 'windrow';
const CA_CN = 'windrow enrollment CA';
// Ten years for the root, one for a leaf. The root's lifetime is a reinstall-scale number because
// rotating it means re-enrolling every node by hand; the leaf's is short because renewal is
// automatic (a node re-enrolls against its own current certificate) and a stale leaf is cheap.
const CA_DAYS = 3650;
const LEAF_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Certificates are checked against wall-clock time by OpenSSL during the handshake, and a machine
// whose clock is behind the issuer's would reject a brand-new certificate as not-yet-valid. Five
// minutes of backdating costs nothing and removes that class of "works on my machine" failure.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The scopes a certificate can carry. Encoded as the subject's OU; read back in server/auth.js. */
const SCOPES = ['admin', 'proposer', 'node'];

function caName() {
  return x509.name({ commonName: CA_CN, organization: ORG });
}

/**
 * Load the root CA, creating it on first run — the same load-or-create shape the bearer tokens
 * used, so an install still needs no manual setup step. The private key never leaves this
 * directory and is never served by any route.
 */
function loadOrCreateCa() {
  try {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(CA_KEY_PATH, 'utf8'));
    const certPem = fs.readFileSync(CA_CERT_PATH, 'utf8');
    return { privateKey, certPem, cert: new crypto.X509Certificate(certPem) };
  } catch {
    // no CA yet — mint one below
  }
  const { privateKey, publicKey } = x509.createKeyPair();
  const now = new Date();
  const { pem } = x509.issue({
    subject: { commonName: CA_CN, organization: ORG },
    publicKey,
    issuerName: caName(),
    issuerKey: privateKey,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + CA_DAYS * DAY_MS),
    isCa: true,
  });
  writeSecret(CA_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeSecret(CA_CERT_PATH, pem);
  return { privateKey, certPem: pem, cert: new crypto.X509Certificate(pem) };
}

/**
 * The HTTPS listener's own certificate. Issued by the same CA, so a client that trusts the CA
 * trusts the server too and the connection is mutually authenticated rather than merely encrypted.
 * SANs cover the loopback names the dashboard and the MCP server actually dial; a deployment that
 * terminates elsewhere sets WINDROW_SERVER_SANS.
 */
function loadOrCreateServerCert(ca) {
  try {
    const key = fs.readFileSync(SERVER_KEY_PATH, 'utf8');
    const cert = fs.readFileSync(SERVER_CERT_PATH, 'utf8');
    const parsed = new crypto.X509Certificate(cert);
    // Reissue rather than serve an expired certificate: the failure mode otherwise is a handshake
    // error on every request with nothing in the logs pointing at the cause.
    if (new Date(parsed.validTo).getTime() > Date.now()) return { key, cert };
  } catch {
    // no server cert yet, or it is unreadable — mint one below
  }
  const extra = (process.env.WINDROW_SERVER_SANS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((v) => ({ type: /^\d+\.\d+\.\d+\.\d+$/.test(v) ? 'ip' : 'dns', value: v }));
  const { privateKey, publicKey } = x509.createKeyPair();
  const now = new Date();
  const { pem } = x509.issue({
    subject: { commonName: 'localhost', organization: ORG },
    publicKey,
    issuerName: caName(),
    issuerKey: ca.privateKey,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + CA_DAYS * DAY_MS),
    extKeyUsage: [x509.OID.serverAuth],
    sans: [
      { type: 'dns', value: 'localhost' },
      { type: 'ip', value: '127.0.0.1' },
      ...extra,
    ],
  });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeSecret(SERVER_KEY_PATH, keyPem);
  writeSecret(SERVER_CERT_PATH, pem);
  return { key: keyPem, cert: pem };
}

/**
 * Issue one client certificate for an enrolling caller.
 *
 * `spkiDer` is the caller's public key, generated on the caller's machine. Enrollment takes a bare
 * SPKI rather than a PKCS#10 CSR so that no attacker-supplied ASN.1 is parsed by our code — the
 * only thing that reads this buffer is `crypto.createPublicKey`, i.e. OpenSSL. The usual thing a
 * CSR adds is proof that the requester holds the matching private key, and losing it is harmless
 * here: submitting somebody else's public key yields a certificate the submitter cannot use, at
 * the cost of burning their own single-use enrollment token.
 */
function issueClientCert(ca, { nodeId, scope, spkiDer, days = LEAF_DAYS }) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`);
  if (!nodeId || typeof nodeId !== 'string') throw new Error('nodeId is required');
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch (err) {
    throw new Error(`invalid public key: ${err.message}`);
  }
  if (publicKey.asymmetricKeyType !== 'ec') {
    throw new Error('public key must be EC P-256');
  }
  const now = new Date();
  const result = x509.issue({
    subject: { commonName: nodeId, organization: ORG, organizationalUnit: scope },
    publicKey,
    issuerName: caName(),
    issuerKey: ca.privateKey,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + days * DAY_MS),
    extKeyUsage: [x509.OID.clientAuth],
  });
  const parsed = new crypto.X509Certificate(result.pem);
  return {
    certPem: result.pem,
    serial: parsed.serialNumber,
    fingerprint: parsed.fingerprint256,
    notAfter: new Date(parsed.validTo).toISOString(),
  };
}

module.exports = {
  loadOrCreateCa, loadOrCreateServerCert, issueClientCert,
  SCOPES, CA_DIR, CA_CERT_PATH, CA_KEY_PATH, SERVER_CERT_PATH, SERVER_KEY_PATH, LEAF_DAYS,
};
