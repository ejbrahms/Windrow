'use strict';
// THE YEAR FUSE — docs/design/disposable-nodes.md §2.2.
//
// Two things are proved here, and the second is the one that was actually missing from the product:
//
//   1. `credentialStatus` can tell an expired credential from an absent one. `client.load()`
//      cannot — it returns null for both — which is why an expiry presented as "this node was
//      never enrolled" and nothing anywhere said otherwise.
//   2. A node whose certificate has already run out RENEWS ITSELF, against a real enrollment
//      endpoint, with no enrollment token and no admin. That is the whole mechanism ./ca.js
//      claimed in a comment and the tree did not have.
//
// Run: node server/enrollment/renewal-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-renew-'));
process.env.WINDROW_CA_DIR = path.join(dir, 'ca');
process.env.WINDROW_CREDENTIAL_DIR = path.join(dir, 'credentials');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(dir, 'bootstrap-enrollment-token');
process.env.WINDROW_SHIP_CREDENTIAL_NAME = 'node-shipper';

const ca = require('./ca');
const client = require('./client');
const { createEnrollmentRouter } = require('./routes');
const renewal = require('./renewal');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); } else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const tokens = new Map();
const nodes = new Map();
const store = {
  async createEnrollmentToken(row) { const t = { id: `entok_${tokens.size}`, uses: 0, maxUses: 1, ...row }; tokens.set(row.tokenHash, t); return t; },
  async findEnrollmentTokenByHash(hash) { return tokens.get(hash) || null; },
  async consumeEnrollmentToken(id, nodeId) {
    for (const t of tokens.values()) {
      if (t.id !== id) continue;
      if (t.uses >= t.maxUses) return null;
      t.uses += 1; t.usedByNodeId = nodeId; return { ok: true, token: t };
    }
    return null;
  },
  async registerNode(row) { nodes.set(row.nodeId, { ...nodes.get(row.nodeId), ...row }); return nodes.get(row.nodeId); },
  async findNodeByCertSerial(s) { return [...nodes.values()].find((n) => n.certSerial === s) || null; },
  async findNodeByNodeId(id) { return nodes.get(id) || null; },
  async listNodes() { return [...nodes.values()]; },
  async revokeNode() { return null; },
};

const app = express();
app.use(express.json());
app.use(createEnrollmentRouter(store));
const server = http.createServer(app);

const root = ca.loadOrCreateCa();
const NAME = 'node-shipper';

/** Write a credential for `nodeId` whose certificate expires `days` from now. A negative `days`
 *  produces one that ran out in the past — the state this whole file is about. */
function plantCredential(nodeId, days) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const issued = ca.issueClientCert(root, {
    nodeId, scope: 'node', spkiDer: publicKey.export({ type: 'spki', format: 'der' }), days,
  });
  client.save(NAME, process.env.WINDROW_CREDENTIAL_DIR, {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: issued.certPem,
    ca: root.certPem,
    meta: { nodeId, scope: 'node', notAfter: issued.notAfter, enrolledAt: new Date().toISOString() },
  });
  nodes.set(nodeId, { nodeId, scope: 'node', label: nodeId, certSerial: issued.serial, enrolledAt: new Date().toISOString() });
  return issued;
}

function clearCredential() {
  for (const p of Object.values(client.paths(NAME, process.env.WINDROW_CREDENTIAL_DIR))) {
    try { fs.unlinkSync(p); } catch { /* not there */ }
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  console.log('credential renewal (§2.2 — the year fuse)');

  // --- classification ---------------------------------------------------------------------------
  clearCredential();
  check('no credential reads as absent, not as valid', renewal.credentialStatus().state === 'absent');

  plantCredential('node-fresh', ca.LEAF_DAYS);
  check('a freshly-issued credential reads as valid', renewal.credentialStatus().state === 'valid');

  plantCredential('node-soon', 30);
  const soon = renewal.credentialStatus();
  check('one inside the renewal window reads as expiring', soon.state === 'expiring', soon.state);
  check('and says how many days are left', soon.expiresInDays === 30, String(soon.expiresInDays));

  plantCredential('node-gone', -3);
  const gone = renewal.credentialStatus();
  check('an EXPIRED credential reads as expired, not absent', gone.state === 'expired', gone.state);
  check('and client.load() still cannot tell the difference — which is the bug', client.load(NAME) === null);
  check('while inspect() names the node anyway', client.inspect(NAME).meta.nodeId === 'node-gone');

  // --- the renewal itself -----------------------------------------------------------------------
  process.env.WINDROW_CENTRAL_URL = baseUrl;
  delete process.env.WINDROW_ENROLLMENT_TOKEN;
  const before = client.inspect(NAME);
  const result = await renewal.checkOnce();
  check('an expired node renews itself with no token and no admin', result.action === 'renewed', JSON.stringify(result));
  const after = client.inspect(NAME);
  check('and keeps its id across the renewal', after.meta.nodeId === 'node-gone', after.meta.nodeId);
  check('and the certificate really changed', after.cert !== before.cert);
  check('and is valid again', renewal.credentialStatus().state === 'valid', renewal.credentialStatus().state);
  check('leaving one roster row, not two', nodes.size === 3, `${nodes.size}`);

  // --- a healthy credential is left alone ---------------------------------------------------------
  const untouched = client.inspect(NAME).cert;
  const quiet = await renewal.checkOnce();
  check('a valid credential is not renewed on every tick', quiet.action === 'none', JSON.stringify(quiet));
  check('and is byte-for-byte the same file', client.inspect(NAME).cert === untouched);

  // --- joining from an injected token (§4: nothing populated WINDROW_ENROLLMENT_TOKEN) -------------
  clearCredential();
  const joinSecret = crypto.randomBytes(16).toString('hex');
  await store.createEnrollmentToken({
    tokenHash: crypto.createHash('sha256').update(joinSecret, 'utf8').digest('hex'), scope: 'node', maxUses: 5,
  });
  process.env.WINDROW_ENROLLMENT_TOKEN = joinSecret;
  // WINDROW_NODE_ID is how an orchestrator says which node this rebuilt container IS. Without it
  // the node would still enrol — it would just come up under a new name, which is the ghost roster.
  process.env.WINDROW_NODE_ID = 'node-gone';
  const joined = await renewal.checkOnce();
  check('a node with only a join token in its environment enrols itself', joined.action === 'renewed', JSON.stringify(joined));
  check('and comes back as the node the orchestrator said it was', joined.nodeId === 'node-gone', joined.nodeId);
  check('still without adding a roster row', nodes.size === 3, `${nodes.size}`);

  // --- a standalone install neither renews nor complains --------------------------------------------
  delete process.env.WINDROW_CENTRAL_URL;
  delete process.env.WINDROW_ENROLLMENT_TOKEN;
  clearCredential();
  const standalone = await renewal.checkOnce();
  check('a standalone install has nothing to renew and says nothing', standalone.state === 'not-applicable', JSON.stringify(standalone));

  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  fs.rmSync(dir, { recursive: true, force: true });
  return failures ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((err) => { console.error(err); process.exit(1); });
