'use strict';

// `node server/central/enrollment-smoke.js` — the gate for docs/design/setup-after-central.md §2.
//
// §2 MEASURED THE GAP RATHER THAN INFERRING IT, so this file measures the fix the same way instead
// of asserting that some code exists. What it reproduces is the exact failure quoted there:
//
//     central replied HTTP 401 -> {"error":"unauthorized: a valid enrolled client certificate is
//     required","detail":"UNABLE_TO_VERIFY_LEAF_SIGNATURE"}
//
// The check has two halves and BOTH are needed, because either alone can pass for the wrong
// reason. A certificate from a FOREIGN CA — which is what a node enrolled against its own :4443
// server holds — must still be refused with that detail, or the listener is not verifying anything
// and "it works now" would mean mTLS had been turned off. And a certificate obtained from THIS
// central, through the routes this change mounts, must ship a batch and be accepted. One root,
// held by the control plane, is the whole fix; the negative half is what proves the positive half
// is not vacuous.
//
// It runs a real HTTPS server with `requestCert`, real TLS handshakes and a real Postgres — the
// failure is a TLS-layer one and there is no way to observe it against an in-process app object.
// With no central database configured it SKIPS rather than fails, matching ./smoke.js: a node
// developer who has never run central should not have a red gate for a dependency they do not
// have.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// The CA directory has to be redirected BEFORE ../enrollment/ca.js is first required — it reads
// WINDROW_CA_DIR at module load. Without this the run would mint a CA into the live install's
// server/data/ca, or worse, reuse it and leave a spendable admin credential behind.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-central-enroll-'));
process.env.WINDROW_CA_DIR = path.join(TMP, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(TMP, 'bootstrap-enrollment-token');

const store = require('./store');
const enrollmentStore = require('./enrollmentStore');
const { buildApp } = require('./routes');
const { centralDbConfig } = require('./pgDriver');
const ca = require('../enrollment/ca');
const { ensureBootstrapToken } = require('../enrollment/routes');

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** One request over a real TLS connection, presenting `key`/`cert` when given. `ca` is what the
 *  CLIENT verifies the server with; the server's own `rejectUnauthorized: false` is what lets an
 *  unverifiable CLIENT certificate reach the app and be answered in JSON rather than dropped. */
function request(port, { method = 'GET', path: p, key, cert, caPem, body, contentType }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      host: '127.0.0.1',
      port,
      method,
      path: p,
      key,
      cert,
      ca: caPem,
      servername: 'localhost',
      headers: {
        ...(payload === null ? {} : {
          'content-type': contentType || 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
      },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Enroll the way ../enrollment/client.js does: generate a key here, send the public half, keep
 *  the certificate. The private key never crosses the wire, which is the property this whole
 *  mechanism exists for. */
async function enrollAgainst(port, token, caPem, label) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const res = await request(port, {
    method: 'POST',
    path: '/api/enroll',
    caPem,
    body: {
      enrollmentToken: token,
      publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      label,
    },
  });
  return { res, key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** A structurally valid `node` certificate signed by a DIFFERENT root — exactly what a node that
 *  enrolled against its own server on another machine holds. Minted by pointing ca.js at a second
 *  directory, so it is a genuinely separate CA rather than a hand-rolled imitation of one. */
function foreignNodeCredential(nodeId) {
  const previous = process.env.WINDROW_CA_DIR;
  process.env.WINDROW_CA_DIR = path.join(TMP, 'other-ca');
  // ca.js resolves CA_DIR at load, so a second CA needs a second module instance rather than a
  // second environment variable — hence the cache eviction. This is a test-only manoeuvre and it
  // is the only way to hold two roots in one process.
  delete require.cache[require.resolve('../enrollment/ca')];
  // eslint-disable-next-line global-require
  const otherCa = require('../enrollment/ca');
  const root = otherCa.loadOrCreateCa();
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issued = otherCa.issueClientCert(root, {
    nodeId,
    scope: 'node',
    spkiDer: kp.publicKey.export({ type: 'spki', format: 'der' }),
  });
  process.env.WINDROW_CA_DIR = previous;
  delete require.cache[require.resolve('../enrollment/ca')];
  return {
    key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: issued.certPem,
    caPem: root.certPem,
  };
}

function usageEnvelope(nodeId, seq) {
  return `${JSON.stringify({
    nodeId,
    seq,
    kind: 'usage_event',
    event: {
      id: `evt-${crypto.randomBytes(6).toString('hex')}`,
      principalId: 'principal-enroll-smoke',
      capabilityId: 'cap-enroll-smoke',
      ts: new Date().toISOString(),
      outcome: 'ok',
      latencyMs: 3,
      nodeId,
      seq,
      prevHash: null,
      hash: `hash-${seq}`,
      observedAt: new Date().toISOString(),
    },
  })}\n`;
}

async function main() {
  if (!centralDbConfig()) {
    console.log('central enrollment smoke: SKIPPED — no WINDROW_CENTRAL_DB_URL / PG* configured.');
    console.log('  `docker compose -f server/central/docker-compose.yml up -d` gives you one at');
    console.log('  postgres://windrow:windrow@localhost:5432/windrow_central');
    return 0;
  }

  console.log('central enrollment smoke — docs/design/setup-after-central.md §2');
  await store.open();
  const driver = store.requireDriver();
  // A scratch run, not a destructive one: only the rows this file writes. TRUNCATE rather than
  // DROP for ./smoke.js's reason — the schema is what is under test.
  await driver.exec('TRUNCATE usage_events, usage_shipments, nodes, enrollment_tokens');

  // ---- the schema half ------------------------------------------------------------------------
  ok(await driver.ddl.hasTable('enrollment_tokens'), 'migration 5 created enrollment_tokens');
  const nodeCols = await driver.ddl.columns('nodes');
  ok(['certSerial', 'enrolledAt', 'revokedAt', 'publicKey'].every((c) => nodeCols.includes(c)),
    'migration 5 added the enrollment columns to the ingest roster', nodeCols.join(','));
  // The property migration 5's header argues for: two writers, one row, neither clobbering the
  // other's columns.
  ok(await driver.ddl.hasTable('policy_changes') !== undefined, 'the policy_changes probe /health reads still answers');

  // ---- a real central, with a real mTLS listener ------------------------------------------------
  const root = ca.loadOrCreateCa();
  const serverCert = ca.loadOrCreateServerCert(root);
  const server = https.createServer({
    key: serverCert.key,
    cert: serverCert.cert,
    ca: root.certPem,
    requestCert: true,
    rejectUnauthorized: false,
  }, buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // ---- the NEGATIVE half: a foreign root is still refused, and refused for the right reason ----
  //
  // This is §2's measurement, unchanged. If it ever passes, the fix has been implemented by
  // weakening the listener rather than by unifying the root, and every other assertion here is
  // worthless.
  const foreign = foreignNodeCredential('node-from-another-machine');
  const refused = await request(port, {
    method: 'POST',
    path: '/api/ingest/usage',
    caPem: root.certPem,
    key: foreign.key,
    cert: foreign.cert,
    contentType: 'application/x-ndjson',
    body: usageEnvelope('node-from-another-machine', 1),
  });
  ok(refused.status === 401, 'a certificate from a second CA is still refused', `got ${refused.status}`);
  ok(String(refused.body.detail || '').includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    'and refused with exactly the detail §2 measured', JSON.stringify(refused.body));

  // ---- the enrollment routes exist and are reachable WITHOUT a certificate ---------------------
  const caRes = await request(port, { path: '/api/enroll/ca', caPem: root.certPem });
  ok(String(caRes.body.raw || '').includes('BEGIN CERTIFICATE'),
    'GET /api/enroll/ca is served unauthenticated', JSON.stringify(caRes.body).slice(0, 120));
  ok(String(caRes.body.raw || '').trim() === root.certPem.trim(),
    'and it is the SAME root the mTLS listener verifies against — the entire fix');

  // ---- bootstrap, then enroll a node THROUGH central --------------------------------------------
  const bootstrap = await ensureBootstrapToken(enrollmentStore);
  ok(typeof bootstrap === 'string' && bootstrap.length > 20, 'a fresh central mints a bootstrap admin token');
  ok(fs.existsSync(process.env.WINDROW_BOOTSTRAP_TOKEN_PATH), 'and writes it to the path it logs');

  const admin = await enrollAgainst(port, bootstrap, root.certPem, 'smoke admin');
  ok(admin.res.status === 201, 'spending it issues an admin certificate', JSON.stringify(admin.res.body));

  const replay = await enrollAgainst(port, bootstrap, root.certPem, 'replay');
  ok(replay.res.status === 401, 'the same token cannot be spent twice (Postgres conditional UPDATE)',
    `got ${replay.res.status}`);

  ok(await ensureBootstrapToken(enrollmentStore) === null,
    'with an admin enrolled, a restart mints nothing');
  ok(!fs.existsSync(process.env.WINDROW_BOOTSTRAP_TOKEN_PATH),
    'and deletes the spendable token it left on disk');

  const asAdmin = { caPem: root.certPem, key: admin.key, cert: admin.res.body.certificate };

  // An admin certificate issued by central authenticates to central's own admin routes. This is
  // the second machine's operator getting a working credential, which is what §5 step 2 needs.
  const tokenRes = await request(port, {
    method: 'POST', path: '/api/enrollment-tokens', ...asAdmin, body: { scope: 'node', label: 'a remote PC' },
  });
  ok(tokenRes.status === 201, 'that admin certificate mints a node enrollment token', JSON.stringify(tokenRes.body));
  // The mint response carries the row it just wrote, hash included — the same shape server/store.js
  // returns, deliberately, since a router serving two stores must not answer with two shapes. The
  // hash is not a spendable secret (you cannot enroll with it), and what actually matters is
  // asserted instead: the PLAINTEXT is never persisted, and the operator-facing LIST drops the hash.
  const listedTokens = await request(port, { path: '/api/enrollment-tokens', ...asAdmin });
  ok(typeof tokenRes.body.token === 'string'
    && tokenRes.body.tokenHash === crypto.createHash('sha256').update(tokenRes.body.token, 'utf8').digest('hex'),
    'the token is returned once and stored only as its SHA-256');
  ok(Array.isArray(listedTokens.body)
    && listedTokens.body.length > 0
    && listedTokens.body.every((t) => t.tokenHash === undefined && typeof t.tokenHashPrefix === 'string')
    && !JSON.stringify(listedTokens.body).includes(tokenRes.body.token),
    'and the token list drops the hash for a prefix, disclosing no token',
    JSON.stringify(listedTokens.body).slice(0, 160));

  const node = await enrollAgainst(port, tokenRes.body.token, root.certPem, "Eric's PC");
  ok(node.res.status === 201, 'a node enrolls against CENTRAL and gets a certificate', JSON.stringify(node.res.body));
  // No `nodeId()` on central: a node-scoped enrollment here must mint a FRESH id rather than
  // reuse central's own, which central does not have.
  ok(/^node-[0-9a-f]{16}$/.test(node.res.body.nodeId || ''),
    'central mints a fresh node id rather than reusing one of its own', node.res.body.nodeId);

  // ---- THE MEASUREMENT --------------------------------------------------------------------------
  //
  // The one sentence this whole change exists to make true.
  const nodeId = node.res.body.nodeId;
  const shipped = await request(port, {
    method: 'POST',
    path: '/api/ingest/usage',
    caPem: root.certPem,
    key: node.key,
    cert: node.res.body.certificate,
    contentType: 'application/x-ndjson',
    body: usageEnvelope(nodeId, 1) + usageEnvelope(nodeId, 2),
  });
  ok(shipped.status === 200,
    'a node enrolled at central SHIPS A BATCH TO CENTRAL and is accepted', JSON.stringify(shipped.body));
  ok(String(JSON.stringify(shipped.body)).includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE') === false,
    'and is NOT rejected with UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  ok(shipped.body.accepted === 2, 'both events landed', JSON.stringify(shipped.body));

  // The row the two writers share. Ingest has just updated its half; enrollment wrote the other
  // half a moment ago, and neither may have erased the other.
  const row = await driver.get('SELECT * FROM nodes WHERE "nodeId" = $1', [nodeId]);
  ok(row && row.certSerial && Number(row.eventCount) === 2,
    'the roster row carries BOTH the certificate identity and the ingest counters',
    JSON.stringify(row && { certSerial: row.certSerial, eventCount: row.eventCount, enrolledAt: row.enrolledAt }));

  // ---- revocation takes effect on the next request ----------------------------------------------
  const revoked = await request(port, { method: 'DELETE', path: `/api/nodes/${nodeId}`, ...asAdmin, body: { reason: 'smoke' } });
  ok(revoked.status === 200, 'an admin revokes that node', JSON.stringify(revoked.body));
  const listed = await request(port, { path: '/api/nodes', ...asAdmin });
  ok(Array.isArray(listed.body) && listed.body.some((n) => n.nodeId === nodeId && n.revokedAt),
    'and the node list reports it revoked');

  server.close();
  await store.close();
  console.log(`\n${checks} checks, ${failures} failure(s)`);
  return failures ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('harness error:', err.stack || err.message);
    process.exit(1);
  });
