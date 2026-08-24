'use strict';
// A NODE THAT IS REBUILT KEEPS ITS NAME — docs/design/disposable-nodes.md §2.1 and §2.2, tested
// against the topology those sections are about.
//
// The existing enrollment tests all run the router against server/store.js, which is a NODE: it has
// a `nodeId()`, so every one of them takes the stable-id branch and none of them can see the defect.
// The defect is on CENTRAL, whose store deliberately has no `nodeId()`
// (server/central/enrollmentStore.js's header says why), so the router fell through to
// `node-${randomBytes(8)}` on every single enrolment — and the roster grew a ghost row per rebuild
// while the re-provisioning path, the join credential's use count and `adoptNodeId` all sat
// unreachable.
//
// So the store here is CENTRAL-SHAPED — the same method names, async, and NO `nodeId()` — held in
// memory. That is the point of the file: it is not a smaller version of the integration test, it is
// the only place the central branch is exercised at all.
//
// Run: node server/enrollment/reprovision-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-reprov-'));
process.env.WINDROW_CA_DIR = path.join(dir, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(dir, 'bootstrap-enrollment-token');

const ca = require('./ca');
const { createEnrollmentRouter } = require('./routes');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); } else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------------------------
// A central-shaped store. Async everywhere, no nodeId(), and `registerNode` refuses a revoked node
// exactly as both real stores do — that refusal is load-bearing for one of the cases below.
// ---------------------------------------------------------------------------------------------
const tokens = new Map();
const nodes = new Map();
const store = {
  async createEnrollmentToken(row) { tokens.set(row.tokenHash, { id: `entok_${tokens.size}`, uses: 0, maxUses: 1, ...row }); return tokens.get(row.tokenHash); },
  async findEnrollmentTokenByHash(hash) { return tokens.get(hash) || null; },
  async consumeEnrollmentToken(id, nodeId) {
    for (const t of tokens.values()) {
      if (t.id !== id) continue;
      if (t.revokedAt || t.uses >= t.maxUses) return null;
      t.uses += 1; t.usedByNodeId = nodeId;
      return { ok: true, token: t };
    }
    return null;
  },
  async registerNode(row) {
    const existing = nodes.get(row.nodeId);
    if (existing && existing.revokedAt) throw Object.assign(new Error(`node ${row.nodeId} is revoked`), { name: 'NodeConflictError' });
    nodes.set(row.nodeId, { ...existing, ...row });
    return nodes.get(row.nodeId);
  },
  async findNodeByCertSerial(serial) { return [...nodes.values()].find((n) => n.certSerial === serial) || null; },
  async findNodeByNodeId(id) { return nodes.get(id) || null; },
  async listNodes() { return [...nodes.values()]; },
  async revokeNode(id, reason) {
    const n = nodes.get(id);
    if (!n || n.revokedAt) return null;
    n.revokedAt = new Date().toISOString(); n.revokedReason = reason;
    return n;
  },
};

const app = express();
app.use(express.json());
app.use(createEnrollmentRouter(store));
const server = http.createServer(app);
const root = ca.loadOrCreateCa();

function request(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/enroll',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let j; try { j = JSON.parse(text); } catch { j = { raw: text }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const hashToken = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

async function mintToken({ scope = 'node', maxUses = 1 } = {}) {
  const secret = crypto.randomBytes(16).toString('hex');
  await store.createEnrollmentToken({ tokenHash: hashToken(secret), scope, maxUses, label: null });
  return secret;
}

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, spkiDer: publicKey.export({ type: 'spki', format: 'der' }) };
}

/** The client's half of the proof, kept deliberately independent of client.js so this test would
 *  catch the two halves drifting apart rather than agreeing with itself. */
function proofFor(privateKeyPem, spkiDer) {
  return crypto.sign(null, Buffer.from(spkiDer), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('re-provisioning and renewal (central-shaped store, no nodeId())');

  // --- a first enrolment, with nothing to keep -------------------------------------------------
  const first = keypair();
  const firstRes = await request({
    enrollmentToken: await mintToken({ maxUses: 3 }),
    publicKey: first.spkiDer.toString('base64'),
  });
  const originalId = firstRes.body.nodeId;
  check('a machine with no identity is minted one', firstRes.status === 201 && /^node-[0-9a-f]{16}$/.test(originalId || ''), JSON.stringify(firstRes.body));

  // --- the whole point: a rebuild re-enrols and KEEPS ITS NAME ---------------------------------
  const rebuilt = keypair();
  const rebuiltRes = await request({
    enrollmentToken: await mintToken({ maxUses: 3 }),
    publicKey: rebuilt.spkiDer.toString('base64'),
    nodeId: originalId,
  });
  check('a rebuilt node re-enrolling on a join credential keeps its id', rebuiltRes.body.nodeId === originalId, JSON.stringify(rebuiltRes.body));
  check('and leaves exactly one roster row rather than a ghost', nodes.size === 1, `${nodes.size} rows`);
  check('the new certificate is a different one', rebuiltRes.body.certificate !== firstRes.body.certificate);

  // --- a single-use token is still not a re-provisioning credential -----------------------------
  const single = await request({
    enrollmentToken: await mintToken({ maxUses: 1 }),
    publicKey: keypair().spkiDer.toString('base64'),
    nodeId: originalId,
  });
  check('a SINGLE-use token claiming an enrolled id is still refused', single.status === 409, `status ${single.status}`);

  // --- claiming an id nobody holds is free ------------------------------------------------------
  const fresh = await request({
    enrollmentToken: await mintToken({ maxUses: 1 }),
    publicKey: keypair().spkiDer.toString('base64'),
    nodeId: 'node-brought-in-from-standalone',
  });
  check('an id nobody holds is granted on a single-use token', fresh.body.nodeId === 'node-brought-in-from-standalone', JSON.stringify(fresh.body));

  // --- a malformed claim falls back to a minted id rather than being honoured --------------------
  const nasty = await request({
    enrollmentToken: await mintToken({ maxUses: 1 }),
    publicKey: keypair().spkiDer.toString('base64'),
    nodeId: '../../etc/passwd',
  });
  check('a malformed id claim is ignored, not honoured', /^node-[0-9a-f]{16}$/.test(nasty.body.nodeId || ''), JSON.stringify(nasty.body));

  // --- RENEWAL: no token at all, proof of possession instead -------------------------------------
  const rosterBeforeRenewal = nodes.size;
  const renewed = keypair();
  const renewRes = await request({
    publicKey: renewed.spkiDer.toString('base64'),
    currentCertificate: rebuiltRes.body.certificate,
    proof: proofFor(rebuilt.privateKey.export({ type: 'pkcs8', format: 'pem' }), renewed.spkiDer),
  });
  check('a node renews with no enrollment token at all', renewRes.status === 201 && renewRes.body.renewed === true, JSON.stringify(renewRes.body));
  check('and the renewal keeps its id', renewRes.body.nodeId === originalId);
  check('and still leaves no extra roster row', nodes.size === rosterBeforeRenewal, `${nodes.size} rows, was ${rosterBeforeRenewal}`);

  // --- a renewal cannot be replayed onto somebody else's key -------------------------------------
  const attacker = keypair();
  const replay = await request({
    publicKey: attacker.spkiDer.toString('base64'),
    currentCertificate: rebuiltRes.body.certificate,
    // The signature from the legitimate renewal above, over a DIFFERENT public key.
    proof: proofFor(rebuilt.privateKey.export({ type: 'pkcs8', format: 'pem' }), renewed.spkiDer),
  });
  check('a proof captured off the wire cannot be replayed onto another key', replay.status === 400, `status ${replay.status}`);

  // --- a certificate we did not issue proves nothing ---------------------------------------------
  const rogueCa = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const x509 = require('./x509');
  const rogue = keypair();
  const rogueCert = x509.issue({
    subject: { commonName: originalId, organization: 'windrow', organizationalUnit: 'node' },
    publicKey: crypto.createPublicKey({ key: rogue.spkiDer, format: 'der', type: 'spki' }),
    issuerName: x509.name({ commonName: 'not our CA', organization: 'windrow' }),
    issuerKey: rogueCa.privateKey,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
  }).pem;
  const impostor = keypair();
  const rogueRes = await request({
    publicKey: impostor.spkiDer.toString('base64'),
    currentCertificate: rogueCert,
    proof: proofFor(rogue.privateKey.export({ type: 'pkcs8', format: 'pem' }), impostor.spkiDer),
  });
  check('a self-signed certificate naming an enrolled node is not a proof', rogueRes.status === 400, `status ${rogueRes.status}`);

  // --- revocation survives both paths ------------------------------------------------------------
  await store.revokeNode(originalId, 'decommissioned');
  const afterRevokeToken = await request({
    enrollmentToken: await mintToken({ maxUses: 3 }),
    publicKey: keypair().spkiDer.toString('base64'),
    nodeId: originalId,
  });
  check('a revoked node cannot re-claim its id with a join credential', afterRevokeToken.status === 403, `status ${afterRevokeToken.status}`);
  const postRevoke = keypair();
  const afterRevokeRenew = await request({
    publicKey: postRevoke.spkiDer.toString('base64'),
    currentCertificate: renewRes.body.certificate,
    proof: proofFor(renewed.privateKey.export({ type: 'pkcs8', format: 'pem' }), postRevoke.spkiDer),
  });
  check('a revoked node cannot renew either — its own key is not a way back in',
    afterRevokeRenew.status === 403, `status ${afterRevokeRenew.status}`);

  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  fs.rmSync(dir, { recursive: true, force: true });
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
