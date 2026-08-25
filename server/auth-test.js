// Verification for authentication — server/auth.js: who is calling and with what authority. Run it:
//   node server/auth-test.js   (npm run test:auth --prefix server)
//
// This is a security surface with no direct coverage: every registry-mutating route sits behind
// requireAuth + requireAdmin, and the loopback agent-token path is the one credential every hook
// process on the machine holds. A bug here either lets an unenrolled or revoked caller through, or
// locks a valid one out — neither shows up in a functional test of the routes themselves.
//
// No network and no TLS handshake: requireAuth reads how the connection was made from
// `req.socket.encrypted`/`authorized` and the peer certificate, all of which are plain fields, so
// the middleware is driven with fake req/res objects. The one thing that IS real is the revocation
// lookup — isRevoked hits the store — so a scratch database is stood up and nodes are registered
// and revoked through it, because "an unknown serial is refused" is exactly the property a stub
// would paper over.
//
// Properties:
//   1. isLoopback recognises the loopback forms and nothing else.
//   2. Token loading: the agent token is a real owner-only secret, distinct from the owner signing
//      key, and persisted to its file (so a second process reads the same one).
//   3. mTLS: an authorized enrolled cert sets its scope/nodeId; unauthorized, subject-less and
//      scope-less certs are all 401.
//   4. Revocation: an unknown serial is REFUSED (403), a revoked node is 403, an active one passes.
//   5. Loopback token: a correct agent token over loopback is 'agent' scope; a wrong token, and any
//      token from off-loopback, are 401.
//   6. requireAdmin / requireProposer gate exactly the scopes they name.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-auth-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_DATA_DIR = path.join(SCRATCH, 'data');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');
process.env.WINDROW_AGENT_TOKEN_PATH = path.join(SCRATCH, 'agent-api-token');
process.env.WINDROW_OWNER_SIGNING_KEY_PATH = path.join(SCRATCH, 'owner-signing-key');

const store = require('./store'); // opens the scratch db + runs migrations, so `nodes` exists
const auth = require('./auth');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// A fake response that records the terminal status/body, and a `next` that records it was called.
// requireAuth either calls next() (pass) or res.status().json() (reject) — never both.
function run(middleware, req) {
  const result = { status: null, body: null, nexted: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(obj) { result.body = obj; return this; },
  };
  middleware(req, res, () => { result.nexted = true; });
  return result;
}

function tlsReq({ authorized = true, subject, serialNumber = 'SERIAL', authorizationError } = {}) {
  return {
    socket: {
      encrypted: true,
      authorized,
      authorizationError,
      getPeerCertificate: () => (subject ? { subject, serialNumber } : {}),
    },
    get: () => '',
  };
}

function loopbackReq({ addr = '127.0.0.1', authorization = '' } = {}) {
  return {
    socket: { encrypted: false, remoteAddress: addr },
    get: (h) => (h.toLowerCase() === 'authorization' ? authorization : ''),
  };
}

// ---------------------------------------------------------------------------
// 1. isLoopback
// ---------------------------------------------------------------------------
check(auth.isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), '1 127.0.0.1 is loopback');
check(auth.isLoopback({ socket: { remoteAddress: '::1' } }), '1 ::1 is loopback');
check(auth.isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), '1 ipv4-mapped loopback is loopback');
check(!auth.isLoopback({ socket: { remoteAddress: '10.0.0.5' } }), '1 a LAN address is not loopback');

// ---------------------------------------------------------------------------
// 2. Token loading
// ---------------------------------------------------------------------------
check(typeof auth.AGENT_TOKEN === 'string' && /^[0-9a-f]{2,}$/.test(auth.AGENT_TOKEN), '2 the agent token is a hex secret', auth.AGENT_TOKEN.slice(0, 8) + '…');
check(auth.OWNER_SIGNING_KEY && auth.OWNER_SIGNING_KEY !== auth.AGENT_TOKEN, '2 the owner signing key is a distinct secret, not the agent token');
check(fs.readFileSync(auth.AGENT_TOKEN_PATH, 'utf8').trim() === auth.AGENT_TOKEN, '2 the agent token is persisted so a second process reads the same one');
check(fs.readFileSync(auth.OWNER_SIGNING_KEY_PATH, 'utf8').trim() === auth.OWNER_SIGNING_KEY, '2 the owner signing key is persisted too');

// ---------------------------------------------------------------------------
// 3. mTLS shapes
// ---------------------------------------------------------------------------
{
  const r = run(auth.requireAuth, tlsReq({ authorized: false, authorizationError: 'CERT_EXPIRED' }));
  check(r.status === 401 && !r.nexted, '3 an unauthorized certificate is 401', JSON.stringify(r.body));
}
{
  const r = run(auth.requireAuth, tlsReq({ subject: null }));
  check(r.status === 401 && !r.nexted, '3 an authorized connection with no peer subject is 401');
}
{
  const r = run(auth.requireAuth, tlsReq({ subject: { CN: 'node-x' } })); // OU (scope) missing
  check(r.status === 401 && !r.nexted, '3 a certificate missing its scope (OU) is 401');
}

// ---------------------------------------------------------------------------
// 4. Revocation lookup (the real store path)
// ---------------------------------------------------------------------------
store.registerNode({ nodeId: 'node-ok', scope: 'admin', certSerial: 'SERIAL-OK' });
store.registerNode({ nodeId: 'node-rev', scope: 'node', certSerial: 'SERIAL-REV' });
store.revokeNode('node-rev', 'test');

{
  const r = run(auth.requireAuth, tlsReq({ subject: { OU: 'node', CN: 'node-unknown' }, serialNumber: 'SERIAL-UNKNOWN' }));
  check(r.status === 403 && !r.nexted, '4 a certificate serial with no node row is refused (403), not allowed');
}
{
  const r = run(auth.requireAuth, tlsReq({ subject: { OU: 'node', CN: 'node-rev' }, serialNumber: 'SERIAL-REV' }));
  check(r.status === 403 && !r.nexted, '4 a revoked node is refused (403)');
}
{
  const req = tlsReq({ subject: { OU: 'admin', CN: 'node-ok' }, serialNumber: 'SERIAL-OK' });
  const r = run(auth.requireAuth, req);
  check(r.nexted && r.status === null, '4 an active enrolled certificate passes', JSON.stringify(r.body));
  check(req.authScope === 'admin' && req.nodeId === 'node-ok' && req.credential === 'mtls', '4 and its scope/nodeId/credential are set from the cert', `${req.authScope}/${req.nodeId}/${req.credential}`);
  check(req.tokenScope === 'admin', '4 tokenScope is kept as an alias of authScope for the audit rows');
}

// ---------------------------------------------------------------------------
// 5. Loopback agent token
// ---------------------------------------------------------------------------
{
  const req = loopbackReq({ authorization: `Bearer ${auth.AGENT_TOKEN}` });
  const r = run(auth.requireAuth, req);
  check(r.nexted && req.authScope === 'agent' && req.credential === 'agent-token', '5 a correct agent token over loopback is agent scope', `${req.authScope}/${req.credential}`);
  check(req.nodeId === null, '5 and it carries no nodeId (the hook token is not an enrolled node)');
}
{
  const r = run(auth.requireAuth, loopbackReq({ authorization: 'Bearer not-the-token' }));
  check(r.status === 401 && !r.nexted, '5 a wrong agent token over loopback is 401');
}
{
  const r = run(auth.requireAuth, { socket: { encrypted: false, remoteAddress: '10.0.0.5' }, get: () => `Bearer ${auth.AGENT_TOKEN}` });
  check(r.status === 401 && !r.nexted, '5 even the correct agent token is refused from off-loopback');
}

// ---------------------------------------------------------------------------
// 6. requireAdmin / requireProposer gate the scopes they name
// ---------------------------------------------------------------------------
for (const [scope, adminOk, proposerOk] of [['admin', true, true], ['proposer', false, true], ['agent', false, false], ['node', false, false]]) {
  const admin = run(auth.requireAdmin, { authScope: scope });
  check(admin.nexted === adminOk, `6 requireAdmin ${adminOk ? 'admits' : 'refuses'} scope "${scope}"`, JSON.stringify(admin.body));
  const proposer = run(auth.requireProposer, { authScope: scope });
  check(proposer.nexted === proposerOk, `6 requireProposer ${proposerOk ? 'admits' : 'refuses'} scope "${scope}"`, JSON.stringify(proposer.body));
}

console.log(failures === 0 ? '\nall auth checks passed' : `\n${failures} check(s) FAILED`);
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
process.exit(failures === 0 ? 0 : 1);
