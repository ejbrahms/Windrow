'use strict';
// Self-test for the enrollment CA and the hand-rolled DER encoder (server/enrollment/der.js
// explains why that encoder exists). Run: node server/enrollment/selftest.js
//
// This is a real test rather than a smoke check because the encoder is the one place in the
// codebase where a subtle bug produces a *silently weaker* credential rather than a crash. It
// asserts three things a certificate has to get right: that OpenSSL inside Node's TLS stack
// completes a mutual handshake with what we mint, that a certificate from any other issuer is
// refused, and that the scope/nodeId a route will authorise on survive the round trip.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-ca-'));
process.env.WINDROW_CA_DIR = dir;

const ca = require('./ca');
const x509 = require('./x509');
const { isOwnerOnly } = require('./secretFile');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label} — ${err.message}`);
  }
}
function rejects(label, fn) {
  check(label, () => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert.ok(threw, 'expected a rejection, got none');
  });
}

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spkiOf = (kp) => kp.publicKey.export({ type: 'spki', format: 'der' });

console.log('enrollment CA self-test');

const root = ca.loadOrCreateCa();

check('CA is stable across loads (does not remint)', () => {
  assert.strictEqual(ca.loadOrCreateCa().cert.fingerprint256, root.cert.fingerprint256);
});
check('CA certificate is a CA', () => assert.strictEqual(root.cert.ca, true));
// The CA private key is the whole root of trust: anyone who can read it mints certificates for
// any nodeId and any scope. `{ mode: 0o600 }` alone does not achieve that on Windows, which is
// what server/enrollment/secretFile.js exists to fix — so assert the real ACL, not the mode bits.
check('CA private key is readable only by its owner', () => {
  assert.ok(isOwnerOnly(ca.CA_KEY_PATH), 'other accounts on this machine can read the CA key');
});
check('server private key is readable only by its owner', () => {
  ca.loadOrCreateServerCert(root);
  assert.ok(isOwnerOnly(ca.SERVER_KEY_PATH), 'other accounts on this machine can read the server key');
});

const clientKey = newKey();
const issued = ca.issueClientCert(root, { nodeId: 'node-7f3a', scope: 'admin', spkiDer: spkiOf(clientKey) });

check('issued cert carries nodeId as CN and scope as OU', () => {
  const c = new crypto.X509Certificate(issued.certPem);
  assert.match(c.subject, /CN=node-7f3a/);
  assert.match(c.subject, /OU=admin/);
});
check('issued cert is not a CA', () => {
  assert.strictEqual(new crypto.X509Certificate(issued.certPem).ca, false);
});
check('issued cert verifies against the CA key', () => {
  assert.ok(new crypto.X509Certificate(issued.certPem).verify(root.cert.publicKey));
});
check('issued cert reports a serial and expiry for the nodes table', () => {
  assert.ok(/^[0-9A-F]+$/i.test(issued.serial), 'serial not hex');
  assert.ok(Date.parse(issued.notAfter) > Date.now(), 'already expired');
});

rejects('a scope outside SCOPES', () => ca.issueClientCert(root, { nodeId: 'x', scope: 'root', spkiDer: spkiOf(clientKey) }));
rejects('a malformed public key', () => ca.issueClientCert(root, { nodeId: 'x', scope: 'admin', spkiDer: Buffer.from('garbage') }));
rejects('an empty nodeId', () => ca.issueClientCert(root, { nodeId: '', scope: 'admin', spkiDer: spkiOf(clientKey) }));
rejects('a non-EC (RSA) public key', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  ca.issueClientCert(root, { nodeId: 'x', scope: 'admin', spkiDer: rsa.publicKey.export({ type: 'spki', format: 'der' }) });
});

// The handshake is the assertion that matters: everything above checks our own encoding against
// our own reader, and only a real TLS negotiation checks it against OpenSSL's.
const server = loadServer();
function loadServer() {
  const srv = ca.loadOrCreateServerCert(root);
  return https.createServer(
    { key: srv.key, cert: srv.cert, ca: root.certPem, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      res.end(JSON.stringify({ cn: peer.subject.CN, ou: peer.subject.OU, authorized: req.socket.authorized }));
    });
}

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', servername: 'localhost', path: '/', ...opts }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const keyPem = clientKey.privateKey.export({ type: 'pkcs8', format: 'pem' });

  await (async () => {
    try {
      const body = await request({ port, ca: root.certPem, key: keyPem, cert: issued.certPem });
      const got = JSON.parse(body);
      check('mutual TLS handshake succeeds and the server sees CN/OU', () => {
        assert.strictEqual(got.authorized, true);
        assert.strictEqual(got.cn, 'node-7f3a');
        assert.strictEqual(got.ou, 'admin');
      });
    } catch (err) {
      failures++;
      console.log(`  FAIL mutual TLS handshake — ${err.message}`);
    }
  })();

  // A certificate minted by a different CA must not be accepted, however well-formed it is. This
  // is the property that makes a credential per-node rather than fleet-wide: holding a valid-
  // looking certificate is not enough, it has to be one *this* CA issued.
  const rogueKey = newKey();
  const rogue = x509.issue({
    subject: { commonName: 'node-7f3a', organization: 'windrow', organizationalUnit: 'admin' },
    publicKey: rogueKey.publicKey,
    issuerName: x509.name({ commonName: 'rogue CA', organization: 'windrow' }),
    issuerKey: rogueKey.privateKey,
    notBefore: new Date(Date.now() - 60000),
    notAfter: new Date(Date.now() + 86400000),
    extKeyUsage: [x509.OID.clientAuth],
  });
  try {
    await request({ port, ca: root.certPem, key: rogueKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: rogue.pem });
    failures++;
    console.log('  FAIL a certificate from an unenrolled CA was accepted');
  } catch {
    console.log('  ok   a certificate from an unenrolled CA is refused');
  }

  // And a client presenting no certificate at all.
  try {
    await request({ port, ca: root.certPem });
    failures++;
    console.log('  FAIL a client with no certificate was accepted');
  } catch {
    console.log('  ok   a client presenting no certificate is refused');
  }

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
});
