'use strict';
// End-to-end test of the credential change: enrollment, both listeners, scope separation and
// revocation, wired together the way server/index.js will wire them.
// Run: node server/enrollment/e2e-test.js
//
// It runs against an in-memory store implementing exactly the interface server/store.js is growing
// (`nodes` + `enrollment_tokens`), so it doubles as an executable statement of that contract and
// does not need the real database — which matters, because this must be runnable while store.js is
// mid-change by someone else.
//
// What it is really asserting is the security claim in docs/design/global-identity-and-central-db.md
// §2.5: that a credential now names *which* node, that one node's credential cannot be used to act
// as another, and that the hook token can never reach an admin route.

const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-e2e-'));
process.env.WINDROW_CA_DIR = path.join(dir, 'ca');
process.env.WINDROW_AGENT_TOKEN_PATH = path.join(dir, 'agent-api-token');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(dir, 'bootstrap-enrollment-token');

const ca = require('./ca');
const { createEnrollmentRouter, createEnrollmentAdminRouter, ensureBootstrapToken, hashToken } = require('./routes');
const auth = require('../auth');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); } else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------------------------
// The store contract, in memory. Mirrors what server/store.js is growing.
// ---------------------------------------------------------------------------------------------
function makeStore() {
  const nodes = [];
  const tokens = [];
  const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
  return {
    createEnrollmentToken(row) {
      const created = { id: id('et'), createdAt: new Date().toISOString(), usedAt: null, usedByNodeId: null, revokedAt: null, ...row };
      tokens.push(created);
      return created;
    },
    findEnrollmentTokenByHash: (h) => tokens.find((t) => t.tokenHash === h) || null,
    // The atomicity that matters: single-use is enforced by this check-and-set, and because Node
    // runs this synchronously it is genuinely a transaction here. server/store.js must achieve the
    // same with a conditional UPDATE, not a read followed by a write.
    consumeEnrollmentToken(tokenId, nodeId) {
      const t = tokens.find((x) => x.id === tokenId);
      if (!t || t.usedAt || t.revokedAt) return null;
      if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return null;
      t.usedAt = new Date().toISOString();
      t.usedByNodeId = nodeId;
      return t;
    },
    listEnrollmentTokens: () => tokens.map(({ tokenHash, ...rest }) => rest),
    revokeEnrollmentToken(tokenId) {
      const t = tokens.find((x) => x.id === tokenId);
      if (!t) return null;
      t.revokedAt = new Date().toISOString();
      return t;
    },
    registerNode(row) {
      const created = { id: id('nd'), revokedAt: null, ...row };
      nodes.push(created);
      return created;
    },
    findNodeByCertSerial: (s) => nodes.find((n) => n.certSerial === s) || null,
    findNodeByNodeId: (n) => nodes.find((x) => x.nodeId === n) || null,
    listNodes: () => nodes.slice(),
    revokeNode(nodeId, reason) {
      const n = nodes.find((x) => x.nodeId === nodeId);
      if (!n) return null;
      n.revokedAt = new Date().toISOString();
      n.revokedReason = reason;
      return n;
    },
  };
}

const store = makeStore();
require.cache[require.resolve('../store')] = { id: '../store', filename: '../store', loaded: true, exports: store };

// ---------------------------------------------------------------------------------------------
// The app, mounted the way server/index.js will mount it.
// ---------------------------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(createEnrollmentRouter(store));                       // unauthenticated: enrollment only
app.use(auth.requireAuth);                                    // everything past here is identified
app.use(createEnrollmentAdminRouter(store, auth.requireAdmin));
app.get('/api/whoami', (req, res) => res.json({ scope: req.authScope, nodeId: req.nodeId, credential: req.credential }));
app.post('/api/grants', auth.requireAdmin, (req, res) => res.json({ ok: true }));
app.post('/api/invoke', (req, res) => res.json({ allowed: true, by: req.authScope }));

const root = ca.loadOrCreateCa();
const srv = ca.loadOrCreateServerCert(root);
// requestCert with rejectUnauthorized:false so an unauthenticated caller reaches requireAuth and
// gets a JSON 401 explaining itself, rather than a bare TLS alert with no diagnosis.
const tlsServer = https.createServer({ key: srv.key, cert: srv.cert, ca: root.certPem, requestCert: true, rejectUnauthorized: false }, app);
const plainServer = http.createServer(app);

function request(server, opts, body) {
  return new Promise((resolve, reject) => {
    const isTls = server === tlsServer;
    const mod = isTls ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request({
      host: '127.0.0.1', port: server.address().port, servername: 'localhost',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let j; try { j = JSON.parse(text); } catch { j = { raw: text }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function enrollWith(token) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const res = await request(tlsServer, { method: 'POST', path: '/api/enroll', ca: root.certPem }, {
    enrollmentToken: token,
    publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  });
  return { res, key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

(async () => {
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => plainServer.listen(0, '127.0.0.1', r));
  console.log('enrollment end-to-end test');

  // -- bootstrap -------------------------------------------------------------------------------
  const bootstrap = await ensureBootstrapToken(store);
  check('first run mints a bootstrap admin enrollment token', typeof bootstrap === 'string' && bootstrap.length > 20);
  check('the bootstrap token is stored only as a hash',
    store.listEnrollmentTokens().every((t) => t.tokenHash === undefined) &&
    !JSON.stringify(store.listEnrollmentTokens()).includes(bootstrap));

  // -- enrollment ------------------------------------------------------------------------------
  const admin = await enrollWith(bootstrap);
  check('spending the bootstrap token issues an admin certificate', admin.res.status === 201, JSON.stringify(admin.res.body));
  const adminCert = admin.res.body.certificate;
  const adminId = admin.res.body.nodeId;
  check('the certificate binds the server-assigned nodeId', adminId && adminCert.includes('BEGIN CERTIFICATE'));

  const replay = await enrollWith(bootstrap);
  check('the same enrollment token cannot be spent twice', replay.res.status === 401, `got ${replay.res.status}`);

  // -- the credential actually authenticates ---------------------------------------------------
  const asAdmin = { ca: root.certPem, key: admin.key, cert: adminCert };
  const who = await request(tlsServer, { method: 'GET', path: '/api/whoami', ...asAdmin });
  check('an enrolled admin certificate authenticates and names its node',
    who.status === 200 && who.body.scope === 'admin' && who.body.nodeId === adminId && who.body.credential === 'mtls',
    JSON.stringify(who.body));

  const noCert = await request(tlsServer, { method: 'GET', path: '/api/whoami', ca: root.certPem });
  check('no certificate is refused on the mTLS listener', noCert.status === 401);

  // -- scope separation ------------------------------------------------------------------------
  const mint = await request(tlsServer, { method: 'POST', path: '/api/enrollment-tokens', ...asAdmin },
    { scope: 'proposer', label: 'mcp server' });
  check('an admin can mint a scoped enrollment token', mint.status === 201 && typeof mint.body.token === 'string');

  const proposer = await enrollWith(mint.body.token);
  const asProposer = { ca: root.certPem, key: proposer.key, cert: proposer.res.body.certificate };
  const propWho = await request(tlsServer, { method: 'GET', path: '/api/whoami', ...asProposer });
  check('a proposer certificate authenticates with proposer scope', propWho.body.scope === 'proposer');

  const propEscalate = await request(tlsServer, { method: 'POST', path: '/api/grants', ...asProposer }, { x: 1 });
  check('a proposer certificate CANNOT reach an admin route', propEscalate.status === 403, `got ${propEscalate.status}`);

  const propMint = await request(tlsServer, { method: 'POST', path: '/api/enrollment-tokens', ...asProposer }, { scope: 'admin' });
  check('a proposer certificate cannot mint itself an admin enrollment token', propMint.status === 403);

  // -- the hook token: loopback only, agent only -----------------------------------------------
  const hookAuth = { headers: { authorization: `Bearer ${auth.AGENT_TOKEN}` } };
  const hookCall = await request(plainServer, { method: 'POST', path: '/api/invoke', ...hookAuth }, {});
  check('the hook token works on the plaintext loopback listener', hookCall.status === 200 && hookCall.body.by === 'agent');

  const hookEscalate = await request(plainServer, { method: 'POST', path: '/api/grants', ...hookAuth }, {});
  check('the hook token CANNOT reach an admin route', hookEscalate.status === 403, `got ${hookEscalate.status}`);

  const hookOnTls = await request(tlsServer, { method: 'GET', path: '/api/whoami', ca: root.certPem, ...hookAuth });
  check('the hook token is not accepted on the mTLS listener', hookOnTls.status === 401, `got ${hookOnTls.status}`);

  const badToken = await request(plainServer, { method: 'POST', path: '/api/invoke', headers: { authorization: 'Bearer wrong' } }, {});
  check('a wrong bearer token is refused', badToken.status === 401);

  // -- revocation ------------------------------------------------------------------------------
  const stillFine = await request(tlsServer, { method: 'GET', path: '/api/whoami', ...asProposer });
  check('the proposer works before revocation', stillFine.status === 200);
  store.revokeNode(propWho.body.nodeId, 'test');
  const afterRevoke = await request(tlsServer, { method: 'GET', path: '/api/whoami', ...asProposer });
  check('a revoked node is refused on its very next request (no CRL, no cache wait)',
    afterRevoke.status === 403, `got ${afterRevoke.status}`);
  const adminUnaffected = await request(tlsServer, { method: 'GET', path: '/api/whoami', ...asAdmin });
  check('revoking one node does not affect another', adminUnaffected.status === 200);

  // -- forgery: the property §2.5 is about ------------------------------------------------------
  // A caller mints a certificate claiming to be the admin node, signed by a CA of its own. If this
  // were accepted, one node could act as another — which is what a fleet-wide shared token allowed.
  const x509 = require('./x509');
  const rogueKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const forged = x509.issue({
    subject: { commonName: adminId, organization: 'windrow', organizationalUnit: 'admin' },
    publicKey: rogueKey.publicKey,
    issuerName: x509.name({ commonName: 'windrow enrollment CA', organization: 'windrow' }),
    issuerKey: rogueKey.privateKey,
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 86400000),
    extKeyUsage: [x509.OID.clientAuth],
  });
  const forgery = await request(tlsServer, {
    method: 'GET', path: '/api/whoami', ca: root.certPem,
    key: rogueKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: forged.pem,
  });
  check('a self-signed certificate impersonating an enrolled node is refused',
    forgery.status === 401, `got ${forgery.status}`);

  // A certificate this CA really did sign, but for a node with no row — e.g. enrollment that died
  // after issuing. Unknown must mean refused, or the registry stops being the source of truth.
  const orphanKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const orphan = ca.issueClientCert(root, {
    nodeId: 'node-never-registered', scope: 'admin',
    spkiDer: orphanKey.publicKey.export({ type: 'spki', format: 'der' }),
  });
  const orphanRes = await request(tlsServer, {
    method: 'GET', path: '/api/whoami', ca: root.certPem,
    key: orphanKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: orphan.certPem,
  });
  check('a CA-signed certificate with no enrolled node behind it is refused',
    orphanRes.status === 403, `got ${orphanRes.status}`);

  // -- concurrent enrollment on one token --------------------------------------------------------
  const raceToken = (await request(tlsServer, { method: 'POST', path: '/api/enrollment-tokens', ...asAdmin }, { scope: 'node' })).body.token;
  const raced = await Promise.all([enrollWith(raceToken), enrollWith(raceToken), enrollWith(raceToken)]);
  const issued = raced.filter((r) => r.res.status === 201).length;
  check('three concurrent enrollments on one token yield exactly one certificate', issued === 1, `got ${issued}`);

  tlsServer.close(); plainServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('test harness error:', err); process.exit(1); });
