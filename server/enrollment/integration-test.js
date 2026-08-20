'use strict';
// The same flow as e2e-test.js, but against the REAL server/store.js on a throwaway database
// rather than an in-memory stand-in. e2e-test.js states the contract; this one proves store.js
// actually implements it — including the two things a mock cannot check: that the SQLite
// single-use UPDATE is genuinely atomic, and that the id the certificate binds is the same id the
// usage-event hash chain keys on.
//
// Run: node server/enrollment/integration-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const https = require('https');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-int-'));
process.env.WINDROW_CA_DIR = path.join(dir, 'ca');
process.env.WINDROW_AGENT_TOKEN_PATH = path.join(dir, 'agent-api-token');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(dir, 'bootstrap-enrollment-token');
// Point the real store at a throwaway file. Both names are set because the governance->windrow
// rename is in flight and store.js may read either.
process.env.WINDROW_DB_PATH = path.join(dir, 'test.db');
process.env.WINDROW_DB_PATH = path.join(dir, 'test.db');

const store = require('../store');
const ca = require('./ca');
const { createEnrollmentRouter, createEnrollmentAdminRouter, ensureBootstrapToken } = require('./routes');
const auth = require('../auth');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); } else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const app = express();
app.use(express.json());
app.use(createEnrollmentRouter(store));
app.use(auth.requireAuth);
app.use(createEnrollmentAdminRouter(store, auth.requireAdmin));
app.get('/api/whoami', (req, res) => res.json({ scope: req.authScope, nodeId: req.nodeId }));

const root = ca.loadOrCreateCa();
const srv = ca.loadOrCreateServerCert(root);
const server = https.createServer(
  { key: srv.key, cert: srv.cert, ca: root.certPem, requestCert: true, rejectUnauthorized: false }, app);

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: '127.0.0.1', port: server.address().port, servername: 'localhost',
      headers: { 'content-type': 'application/json' }, ...opts,
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
  const res = await request({ method: 'POST', path: '/api/enroll', ca: root.certPem }, {
    enrollmentToken: token,
    publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  });
  return { res, key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('enrollment integration test (real store.js)');

  const bootstrap = await ensureBootstrapToken(store);
  const admin = await enrollWith(bootstrap);
  check('bootstrap enrollment issues an admin certificate against the real store',
    admin.res.status === 201, JSON.stringify(admin.res.body));
  const asAdmin = { ca: root.certPem, key: admin.key, cert: admin.res.body.certificate };

  const who = await request({ method: 'GET', path: '/api/whoami', ...asAdmin });
  check('the real store authenticates that certificate and names its node',
    who.status === 200 && who.body.nodeId === admin.res.body.nodeId, JSON.stringify(who.body));

  const persisted = store.findNodeByCertSerial(
    new crypto.X509Certificate(admin.res.body.certificate).serialNumber);
  check('the node row persisted with its certificate serial', !!persisted && !persisted.revokedAt);

  // The claim a mock cannot test: SQLite's conditional UPDATE must make single-use real.
  const raceToken = (await request({ method: 'POST', path: '/api/enrollment-tokens', ...asAdmin },
    { scope: 'proposer' })).body.token;
  const raced = await Promise.all([enrollWith(raceToken), enrollWith(raceToken), enrollWith(raceToken), enrollWith(raceToken)]);
  const issued = raced.filter((r) => r.res.status === 201).length;
  check('four concurrent enrollments on one token yield exactly one certificate (real SQLite)',
    issued === 1, `got ${issued}`);

  // The claim that makes the two halves of this change meet.
  const nodeToken = (await request({ method: 'POST', path: '/api/enrollment-tokens', ...asAdmin },
    { scope: 'node' })).body.token;
  const nodeEnrolled = await enrollWith(nodeToken);
  check('a node-scoped certificate binds the SAME id the usage-event chain keys on',
    nodeEnrolled.res.status === 201 && nodeEnrolled.res.body.nodeId === store.nodeId(),
    `cert=${nodeEnrolled.res.body.nodeId} chain=${store.nodeId()}`);

  const reNodeToken = (await request({ method: 'POST', path: '/api/enrollment-tokens', ...asAdmin },
    { scope: 'node' })).body.token;
  const dup = await enrollWith(reNodeToken);
  check('re-enrolling an already-enrolled machine is refused rather than duplicating it',
    dup.res.status === 409, `got ${dup.res.status}`);

  // Revocation against the real indexed lookup.
  const asNode = { ca: root.certPem, key: nodeEnrolled.key, cert: nodeEnrolled.res.body.certificate };
  check('the node certificate works before revocation',
    (await request({ method: 'GET', path: '/api/whoami', ...asNode })).status === 200);
  store.revokeNode(nodeEnrolled.res.body.nodeId, 'integration test');
  check('a revoked node is refused on its next request via the real store lookup',
    (await request({ method: 'GET', path: '/api/whoami', ...asNode })).status === 403);
  check('revoking one node leaves the admin working',
    (await request({ method: 'GET', path: '/api/whoami', ...asAdmin })).status === 200);

  // The database must not be a source of usable credentials.
  const raw = fs.readFileSync(process.env.WINDROW_DB_PATH);
  check('no enrollment token is recoverable from the database file',
    !raw.includes(Buffer.from(bootstrap)) && !raw.includes(Buffer.from(raceToken)));

  server.close();
  try { store.close && store.close(); } catch { /* not all stores expose close */ }
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('harness error:', err); process.exit(1); });
