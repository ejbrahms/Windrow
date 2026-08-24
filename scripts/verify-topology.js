'use strict';

// `node scripts/verify-topology.js` — is this host actually wired up the way its configuration
// claims?
//
// WHY THIS EXISTS. Windrow is two deployments now (docs/design/global-identity-and-central-db.md
// §2.2): a NODE is a Windows service on a user's PC, CENTRAL is one host with a Postgres behind it,
// and a node joins a fleet by setting two environment variables. Every one of the ways that goes
// wrong is SILENT. A node with no WINDROW_CENTRAL_URL ships nothing and looks perfectly healthy —
// gap #7 in docs/design/setup-after-central.md §4, "it reads as a working install". A node enrolled
// against its own CA presents a certificate central's CA never signed, and the only symptom is a
// 401 in a log file on the other machine. WINDROW_POLICY_AUTHORITY=central without a central URL is
// downgraded to node-authoritative by ../server/policy/authority.js and the operator is never in a
// position to notice. None of those is visible from inside any single process, which is why the
// check is a script that looks at all three halves from outside and prints one table.
//
// THE ONE DIAGNOSIS THIS FILE EXISTS FOR is UNABLE_TO_VERIFY_LEAF_SIGNATURE. That is what the audit
// actually measured against a live central, and as a raw TLS error it tells an operator nothing
// except that TLS failed. It means exactly one thing here — this node enrolled against a different
// CA than central trusts — and it has exactly one fix, so the check says both in words rather than
// forwarding the error code and hoping.
//
// NOTHING HERE MAY THROW. A verifier that dies on its third check has told you less than one that
// runs none of them, because it looks like a failure of the thing being checked. Every check is
// wrapped: an exception becomes a `fail` row carrying its message, and a check that cannot apply on
// this host reports `skipped` with the reason it was skipped. The exit code is 1 if anything
// checked came back `fail`, 0 otherwise — a `skip` is not a failure, since "this host is not
// central" is a correct answer, not a broken one.
//
// USAGE
//   node scripts/verify-topology.js            table
//   node scripts/verify-topology.js --json     the same result as JSON
//
// The wizard's final step calls this; so should anyone who has just changed windrow.env.

// ../server/config first, and before anything reads process.env: it is what loads `windrow.env`,
// and the variables this whole script is about (WINDROW_CENTRAL_URL, WINDROW_POLICY_AUTHORITY,
// WINDROW_CENTRAL_DB_URL) very often live there rather than in the shell that invoked us. Reading
// them before the file is loaded would report a fleet node as a standalone one — the exact
// misdiagnosis this script exists to prevent.
require('../server/config');

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');

const AS_JSON = process.argv.includes('--json');
const TIMEOUT_MS = Number(process.env.WINDROW_VERIFY_TIMEOUT_MS) || 4000;

/** A certificate inside this window is reported as a warning rather than an ok. Two weeks is long
 *  enough that `node scripts/enroll.js --force` can be scheduled rather than done in a panic, and
 *  short enough that it is not noise for a year-long certificate. */
const EXPIRY_WARN_DAYS = 14;

const checks = [];
const ok = (name, detail) => checks.push({ name, status: 'ok', detail });
const warn = (name, detail) => checks.push({ name, status: 'warn', detail });
const fail = (name, detail) => checks.push({ name, status: 'fail', detail });
const skip = (name, why) => checks.push({ name, status: 'skipped', detail: why });

/**
 * Run one check, and swallow anything it throws into a `fail` row.
 *
 * This is the whole of the never-throws guarantee, in one place rather than a try/catch per check —
 * which is what makes it a property of the script instead of a discipline every future check has to
 * remember.
 */
async function guard(name, fn) {
  try {
    await fn();
  } catch (err) {
    fail(name, `check itself errored: ${err && err.message ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// transport helpers — all of them resolve rather than reject, for the reason above
// ---------------------------------------------------------------------------

/** GET a URL. Resolves `{status, body, json}` or `{error, code}`; never rejects. */
function get(url, { agent, ca, rejectUnauthorized } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (err) { return resolve({ error: `not a URL: ${err.message}` }); }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: TIMEOUT_MS,
      ...(agent ? { agent } : {}),
      ...(ca ? { ca } : {}),
      ...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }),
      // Enrollment issues certificates for `localhost` (../server/enrollment/ca.js), so a central
      // reached by hostname or IP would fail hostname verification for a reason that has nothing to
      // do with trust. `servername` matches what ../server/enrollment/client.js's agentFor sends.
      ...(target.protocol === 'https:' ? { servername: 'localhost' } : {}),
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON; the raw text is still useful */ }
        resolve({ status: res.statusCode, body: text, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `no response within ${TIMEOUT_MS}ms`, code: 'ETIMEDOUT' }); });
    req.on('error', (err) => resolve({ error: err.message, code: err.code }));
    req.end();
  });
}

/** Is something listening, and does it speak TLS? Resolves `{listening, tls, error, code}`. */
function probeTls(host, port) {
  return new Promise((resolve) => {
    // rejectUnauthorized: false on purpose. The question is "is the mTLS listener up", not "do I
    // trust it" — this socket presents no client certificate, so a trust verdict taken here would
    // be about the wrong direction of the handshake entirely.
    const socket = tls.connect({ host, port, rejectUnauthorized: false, timeout: TIMEOUT_MS, servername: 'localhost' }, () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      resolve({ listening: true, tls: true, peerSubject: peer && peer.subject ? peer.subject.CN : null });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ listening: false, error: `no TLS handshake within ${TIMEOUT_MS}ms`, code: 'ETIMEDOUT' }); });
    socket.on('error', (err) => { socket.destroy(); resolve({ listening: false, error: err.message, code: err.code }); });
  });
}

/** Plain TCP reachability, for telling "nothing is listening" apart from "it is listening but not
 *  in the protocol I expected" — two very different repairs. */
function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS }, () => { socket.destroy(); resolve({ listening: true }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ listening: false, code: 'ETIMEDOUT' }); });
    socket.on('error', (err) => { socket.destroy(); resolve({ listening: false, code: err.code }); });
  });
}

// ---------------------------------------------------------------------------
// what this host is
// ---------------------------------------------------------------------------

/**
 * Read the host's role off the environment, and say which variables decided it.
 *
 * "and why" is not decoration. The three roles differ by which variables are set and nothing else,
 * so an operator reading "node" when they expected "node-in-fleet" needs the variable list in the
 * same breath to see that WINDROW_CENTRAL_URL is missing rather than wrong.
 */
function describeRole(env = process.env) {
  const set = (name) => (env[name] === undefined || env[name] === '' ? null : env[name]);
  const centralUrl = set('WINDROW_CENTRAL_URL');
  const dbUrl = set('WINDROW_CENTRAL_DB_URL') || set('DATABASE_URL');
  const pgPieces = set('PGHOST') || set('PGDATABASE');
  const authority = (set('WINDROW_POLICY_AUTHORITY') || 'node').toLowerCase();

  const why = [];
  if (dbUrl) why.push(`WINDROW_CENTRAL_DB_URL=${redactDsn(dbUrl)}`);
  else if (pgPieces) why.push(`PGHOST/PGDATABASE=${set('PGHOST') || '?'}/${set('PGDATABASE') || '?'}`);
  if (centralUrl) why.push(`WINDROW_CENTRAL_URL=${centralUrl}`);
  why.push(`WINDROW_POLICY_AUTHORITY=${authority}`);
  if (set('WINDROW_NODE_ID')) why.push(`WINDROW_NODE_ID=${set('WINDROW_NODE_ID')}`);

  let role;
  if (dbUrl || pgPieces) role = centralUrl ? 'central + node-in-fleet' : 'central';
  else if (centralUrl) role = 'node-in-fleet';
  else role = 'node (standalone)';

  // Whether the NODE half applies here. A host with a database and no central URL is central and
  // nothing else, so "server/index.js is not listening" is the correct state rather than a failure —
  // reporting it as a failure is how a verifier trains an operator to ignore its output. A box that
  // is genuinely both (the single-machine fleet phase 3 was developed on) sets WINDROW_CENTRAL_URL
  // and is caught by the `central + node-in-fleet` case; WINDROW_VERIFY_NODE=1 forces the checks on
  // for the rarer shape that is central plus a *standalone* node.
  const nodeHost = role !== 'central' || env.WINDROW_VERIFY_NODE === '1';

  return { role, why, centralUrl, dbUrl: dbUrl || null, pgPieces: Boolean(pgPieces), authority, nodeHost };
}

/** A DSN with its password removed. Printed configuration ends up in bug reports and screenshots. */
function redactDsn(dsn) {
  return String(dsn).replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

// ---------------------------------------------------------------------------
// node half
// ---------------------------------------------------------------------------

const CREDENTIAL_DIR = process.env.WINDROW_CREDENTIAL_DIR
  || path.join(__dirname, '..', 'server', 'data', 'credentials');
// The name the shipper and the policy client actually load, so this checks the credential the node
// will really present rather than whichever one happens to be on disk.
const CREDENTIAL_NAME = process.env.WINDROW_SHIP_CREDENTIAL_NAME || 'node-shipper';

/** The node's credential as files, parsed. Returns `{present:false, why}` rather than throwing, and
 *  deliberately does NOT go through ../server/enrollment/client.js's `load`, which treats an expired
 *  certificate as absent — "expired" is precisely the diagnosis this check is here to deliver. */
function readCredential() {
  const base = path.join(CREDENTIAL_DIR, CREDENTIAL_NAME);
  const files = { key: `${base}-key.pem`, cert: `${base}-cert.pem`, ca: `${base}-ca.pem`, meta: `${base}.json` };
  if (!fs.existsSync(files.cert)) {
    return { present: false, why: `no certificate at ${files.cert}`, files };
  }
  const cert = fs.readFileSync(files.cert, 'utf8');
  const parsed = new crypto.X509Certificate(cert);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')); } catch { /* older credential, no meta */ }
  return {
    present: true,
    files,
    cert,
    key: fs.existsSync(files.key) ? fs.readFileSync(files.key, 'utf8') : null,
    ca: fs.existsSync(files.ca) ? fs.readFileSync(files.ca, 'utf8') : null,
    subject: parsed.subject,
    validTo: new Date(parsed.validTo),
    meta,
  };
}

async function checkNodeHalf(role) {
  const supervisorPort = Number(process.env.PORT) || 4000;
  const tlsPort = Number(process.env.WINDROW_TLS_PORT) || 4443;

  const READY_CHECK = `node :${supervisorPort} /api/ready`;

  if (!role.nodeHost) {
    const why = 'this host is central — a database is configured and no WINDROW_CENTRAL_URL is, so '
      + 'server/index.js does not run here (WINDROW_VERIFY_NODE=1 checks anyway)';
    skip(READY_CHECK, why);
    skip(`node :${tlsPort} (mTLS)`, why);
    skip('node credential', why);
    skip('node id', why);
    return null;
  }

  await guard(READY_CHECK, async () => {
    const res = await get(`http://127.0.0.1:${supervisorPort}/api/ready`);
    if (res.error) {
      // The supervisor is what binds :4000 and parks requests across a backend restart
      // (docs/design/upgrade-resilience.md §3.4), so nothing answering here means the service is
      // down, not that the API is merely restarting.
      return fail(READY_CHECK, `${res.error} — the supervisor is not serving on :${supervisorPort}`);
    }
    // 503 with a reason is the cold-start park, not a broken server: a node under central
    // authority holds the door shut until its first policy pull lands
    // (docs/design/dashboard-placement.md item 8). Naming it is the difference between "wait a
    // few seconds" and an operator restarting a service that was working correctly.
    if (res.status === 503 && res.json && res.json.ready === false) {
      return fail(READY_CHECK, `${res.json.reason || 'not ready'} — ${res.json.detail || res.body.slice(0, 200)}`);
    }
    if (res.status !== 200) return fail(READY_CHECK, `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    const contract = res.json && res.json.contract;
    const routes = contract && typeof contract === 'object' ? Object.keys(contract).length : 0;
    return ok(READY_CHECK, `ready, pid ${res.json && res.json.pid}${routes ? `, ${routes} hook contract entries` : ''}`);
  });

  await guard(`node :${tlsPort} (mTLS)`, async () => {
    const probe = await probeTls('127.0.0.1', tlsPort);
    if (probe.listening) return ok(`node :${tlsPort} (mTLS)`, `TLS listener up${probe.peerSubject ? `, server CN=${probe.peerSubject}` : ''}`);
    const tcp = await probeTcp('127.0.0.1', tlsPort);
    if (tcp.listening) return fail(`node :${tlsPort} (mTLS)`, `port is open but the TLS handshake failed: ${probe.error}`);
    return fail(`node :${tlsPort} (mTLS)`, `nothing listening (${probe.code || probe.error}) — server/index.js did not bind its TLS listener`);
  });

  let credential = null;
  await guard('node credential', async () => {
    credential = readCredential();
    if (!credential.present) {
      // Not a failure on a standalone node: nothing on a box with no central needs a credential to
      // present to anybody. It is a failure the moment a fleet is configured.
      const msg = `${credential.why} — enroll with \`node scripts/enroll.js\``;
      return role.centralUrl ? fail('node credential', msg) : skip('node credential', `${credential.why} (a standalone node presents a credential to nobody)`);
    }
    const days = Math.floor((credential.validTo.getTime() - Date.now()) / 86400000);
    const nodeId = (credential.meta && credential.meta.nodeId) || null;
    const scope = (credential.meta && credential.meta.scope) || 'unknown scope';
    const who = `${CREDENTIAL_NAME}: nodeId ${nodeId || '(none recorded)'}, scope ${scope}`;
    if (days < 0) return fail('node credential', `${who} — EXPIRED ${-days} days ago (${credential.validTo.toISOString()}); re-enroll with \`node scripts/enroll.js --force\``);
    if (days <= EXPIRY_WARN_DAYS) return warn('node credential', `${who} — expires in ${days} days (${credential.validTo.toISOString()})`);
    if (!credential.key) return fail('node credential', `${who} — certificate present but ${credential.files.key} is missing, so nothing can present it`);
    return ok('node credential', `${who}, valid ${days} more days`);
  });

  await guard('node id', async () => {
    const override = process.env.WINDROW_NODE_ID;
    const fromCert = credential && credential.meta && credential.meta.nodeId;
    if (override && fromCert && override !== fromCert) {
      // ../server/store.js refuses to adopt a node id that disagrees with the override, so this is
      // a configuration that never converges: the certificate says one thing, every shipped
      // envelope says another, and ../server/central/store.js rejects the batch whole with
      // NODE_IDENTITY_MISMATCH.
      return fail('node id', `WINDROW_NODE_ID=${override} but the credential was issued to ${fromCert} — central rejects every batch from this node`);
    }
    if (override) return ok('node id', `${override} (WINDROW_NODE_ID override)`);
    if (fromCert) return ok('node id', `${fromCert} (from the enrollment credential)`);
    return skip('node id', 'no WINDROW_NODE_ID and no credential to read one from; the node mints its own on first use');
  });

  return credential;
}

// ---------------------------------------------------------------------------
// fleet half — only when a central is named
// ---------------------------------------------------------------------------

/**
 * The mTLS diagnosis, which is the reason this script was written.
 *
 * Two directions fail and they are not the same problem, so they do not get the same message:
 *   - the CLIENT cannot verify CENTRAL's certificate — a Node-level error code on the socket
 *   - CENTRAL cannot verify OUR certificate — a JSON 401 whose `detail` is the socket's
 *     `authorizationError`, because ../server/central/routes.js takes `rejectUnauthorized: false`
 *     precisely so an unauthenticated caller gets an explanation instead of a bare TLS alert
 *
 * Both come back as UNABLE_TO_VERIFY_LEAF_SIGNATURE and both mean "two CAs where there should be
 * one" (docs/design/setup-after-central.md §2), which is why the wording names the cause rather
 * than the code.
 */
/**
 * The error codes that all mean "two CAs where there should be one".
 *
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE is the one the audit measured and the one central reports back in
 * a 401 `detail`, but which of these OpenSSL picks depends on where in the chain the break is —
 * a self-signed root that is simply not trusted comes back as SELF_SIGNED_CERT_IN_CHAIN, and a
 * bare leaf with no chain at all as DEPTH_ZERO_SELF_SIGNED_CERT. They have one cause and one fix
 * here, so matching only the famous one would leave the other two reported as raw TLS noise —
 * exactly the failure this diagnosis exists to replace.
 */
const TWO_CA_CODES = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
];

/** True for a code or for a message that contains one — central sends the latter, as a string in
 *  the 401 body's `detail`. */
function isTwoCaFailure(codeOrDetail) {
  if (!codeOrDetail) return false;
  const text = String(codeOrDetail).toUpperCase();
  return TWO_CA_CODES.some((c) => text.includes(c));
}

const TWO_CA_EXPLANATION = 'this node was enrolled against a DIFFERENT certificate authority than central trusts. '
  + 'A node enrolling against its own server gets a certificate signed by its own CA; central verifies against '
  + 'its own. On one machine those are the same directory, on two they are two roots and every batch is rejected '
  + 'at the TLS layer. Re-enroll against central: `node scripts/enroll.js`';

async function checkFleetHalf(role, credential) {
  if (!role.centralUrl) {
    skip('central /health', 'WINDROW_CENTRAL_URL is not set — this host is not in a fleet');
    skip('central mTLS handshake', 'WINDROW_CENTRAL_URL is not set');
    return;
  }
  const base = role.centralUrl.replace(/\/+$/, '');

  await guard('central /health', async () => {
    // /health takes no certificate by design (a load balancer has none), so this reaches it with
    // the node's CA when there is one and without verification when there is not — the point of
    // this check is liveness and `mode`, and a trust verdict is the next check's job.
    const res = await get(`${base}/health`, credential && credential.ca
      ? { ca: credential.ca }
      : { rejectUnauthorized: false });
    if (res.error) {
      if (isTwoCaFailure(res.code)) return fail('central /health', `${res.code}: ${TWO_CA_EXPLANATION}`);
      return fail('central /health', `${base} unreachable: ${res.error}${res.code ? ` (${res.code})` : ''}`);
    }
    if (res.status !== 200) return fail('central /health', `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    const h = res.json || {};
    // `mode` is read off the schema, not off an environment variable: 'authority' means migration 3
    // is applied and central owns grants and capabilities; 'shadow' means it is a phase-3 observer.
    // A node asking for WINDROW_POLICY_AUTHORITY=central against a shadow central is a node waiting
    // for a policy stream that will never carry anything.
    const mode = h.mode || 'unknown';
    const stranded = h.defaultPartitionRows;
    const detail = `ok=${h.ok}, mode=${mode}${stranded ? `, ${stranded} rows stranded in the default partition` : ''}`;
    if (role.authority === 'central' && mode === 'shadow') {
      return fail('central /health', `${detail} — this node asks central for policy, but central is in SHADOW mode `
        + '(migration 3 is not applied), so there is no policy to replicate');
    }
    return mode === 'unknown' ? warn('central /health', detail) : ok('central /health', detail);
  });

  await guard('central mTLS handshake', async () => {
    if (!credential || !credential.present || !credential.key) {
      return skip('central mTLS handshake', 'no local credential to present — see the node credential check above');
    }
    const agent = new https.Agent({
      key: credential.key,
      cert: credential.cert,
      ca: credential.ca,
      servername: 'localhost',
    });
    // A node-scoped route, not an admin one: this is the credential the shipper presents, and the
    // question is whether central accepts *it*. Any non-auth status means the handshake succeeded
    // and the certificate was accepted, which is the whole of what is being asked here.
    const res = await get(`${base}/api/fleet/rollup`, { agent });
    if (res.error) {
      if (isTwoCaFailure(res.code)) return fail('central mTLS handshake', `${res.code}: ${TWO_CA_EXPLANATION}`);
      return fail('central mTLS handshake', `${res.error}${res.code ? ` (${res.code})` : ''}`);
    }
    if (res.status === 401 || res.status === 403) {
      const detail = (res.json && res.json.detail) || '';
      if (isTwoCaFailure(detail)) return fail('central mTLS handshake', `central rejected this node's certificate (${detail}): ${TWO_CA_EXPLANATION}`);
      if (/CERT_HAS_EXPIRED/i.test(detail)) return fail('central mTLS handshake', 'central rejected this node\'s certificate as expired — re-enroll with `node scripts/enroll.js --force`');
      return fail('central mTLS handshake', `central refused the credential: HTTP ${res.status} ${(res.json && res.json.error) || res.body.slice(0, 160)}${detail ? ` [${detail}]` : ''}`);
    }
    return ok('central mTLS handshake', `accepted (HTTP ${res.status} from /api/fleet/rollup)`);
  });
}

// ---------------------------------------------------------------------------
// central half — only when a database is configured
// ---------------------------------------------------------------------------

async function checkCentralHalf(role) {
  if (!role.dbUrl && !role.pgPieces) {
    skip('central database', 'neither WINDROW_CENTRAL_DB_URL nor PGHOST/PGDATABASE is set — this host is not central');
    return;
  }

  let pool = null;
  await guard('central database', async () => {
    let driver;
    try {
      // Required lazily, exactly as ../server/central/pgDriver.js requires `pg` lazily: a node that
      // never installed the central dependencies must still be able to run this script, and "pg is
      // not installed" is a finding rather than a crash.
      // eslint-disable-next-line global-require
      const { openPool, pgDriver } = require('../server/central/pgDriver');
      pool = openPool();
      driver = pgDriver(pool);
    } catch (err) {
      return fail('central database', err.message);
    }

    const one = await driver.get('SELECT 1 AS ok').catch((err) => ({ __err: err }));
    if (!one || one.__err) {
      return fail('central database', `cannot query: ${one && one.__err ? one.__err.message : 'no result'}`);
    }
    ok('central database', `connected (${redactDsn(role.dbUrl || `${process.env.PGHOST}/${process.env.PGDATABASE}`)})`);

    // The ledger, read directly rather than by running the migrator: this script must never
    // migrate anything. Verifying a host is not a licence to change it, and a verifier that
    // silently applied migration 3 would be the one thing worse than a central that is behind.
    await guard('central schema version', async () => {
      const has = await driver.ddl.hasTable('schema_migrations');
      if (!has) return fail('central schema version', 'no schema_migrations table — this database has never been migrated; start server/central/index.js once');
      const row = await driver.get('SELECT MAX(version) AS v FROM schema_migrations');
      const version = row && row.v != null ? Number(row.v) : 0;
      const authority = await driver.ddl.hasTable('policy_changes');
      const mode = authority ? 'authority (phase 4)' : 'shadow (phase 3)';
      if (role.authority === 'central' && !authority) {
        return fail('central schema version', `version ${version}, ${mode} — WINDROW_POLICY_AUTHORITY=central needs migration 3`);
      }
      return ok('central schema version', `version ${version}, ${mode}`);
    });

    await guard('fleet roster', async () => {
      if (!(await driver.ddl.hasTable('nodes'))) return skip('fleet roster', 'no `nodes` table — migration 1 has not run');
      const row = await driver.get('SELECT COUNT(*)::BIGINT AS n FROM nodes');
      const n = row ? Number(row.n) : 0;
      if (n === 0) return warn('fleet roster', '0 nodes have ever shipped to this central — nothing has enrolled and shipped yet');
      const recent = await driver.get('SELECT COUNT(*)::BIGINT AS n FROM nodes WHERE "lastSeenAt" > now() - interval \'24 hours\'');
      return ok('fleet roster', `${n} node(s) on the roster, ${recent ? Number(recent.n) : 0} seen in the last 24h`);
    });

    await guard('stranded usage rows', async () => {
      if (!(await driver.ddl.hasTable('usage_events_default'))) return skip('stranded usage rows', 'no default partition — migration 1 has not run');
      const row = await driver.get('SELECT COUNT(*)::BIGINT AS n FROM usage_events_default');
      const n = row ? Number(row.n) : 0;
      // A non-empty default partition is never routine: server/central/partitions.js creates
      // partitions an hour ahead, so a row landing here means maintenance did not run.
      if (n > 0) return warn('stranded usage rows', `${n} row(s) in usage_events_default — partition maintenance has lapsed; server/central/partitions.js runMaintenance moves them`);
      return ok('stranded usage rows', '0 — every event landed in a real monthly partition');
    });
  });

  if (pool) await pool.end().catch(() => {});
}

// ---------------------------------------------------------------------------
// the authority-vs-URL trap, which no single check above owns
// ---------------------------------------------------------------------------

function checkAuthorityConsistency(role) {
  if (role.authority !== 'central') {
    return ok('policy authority', `${role.authority} — this node enforces from its own tables`);
  }
  if (!role.centralUrl) {
    // ../server/policy/authority.js downgrades this to node-authoritative and logs it once at boot.
    // On a service that boot log is in a file nobody opens, so it is a `fail` here.
    return fail('policy authority', 'WINDROW_POLICY_AUTHORITY=central but WINDROW_CENTRAL_URL is not set — '
      + 'server/policy/authority.js silently falls back to node-authoritative, so this node enforces its own tables '
      + 'while looking like a replica');
  }
  return ok('policy authority', `central via ${role.centralUrl} — this node is a read replica plus the deny-list`);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const GLYPH = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skipped: '--  ' };

function render(role) {
  const width = checks.reduce((w, c) => Math.max(w, c.name.length), 0);
  console.log('');
  console.log(`  this host: ${role.role}`);
  for (const why of role.why) console.log(`             ${why}`);
  console.log('');
  for (const c of checks) {
    console.log(`  [${GLYPH[c.status]}] ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  console.log('');
  console.log(`  ${checks.length - skipped} checked, ${failed} failed, ${warned} warning(s), ${skipped} not applicable here`);
  console.log('');
}

async function main() {
  const role = describeRole();
  const credential = await checkNodeHalf(role);
  checkAuthorityConsistency(role);
  await checkFleetHalf(role, credential);
  await checkCentralHalf(role);

  const failed = checks.filter((c) => c.status === 'fail');
  if (AS_JSON) console.log(JSON.stringify({ role: role.role, why: role.why, checks, healthy: failed.length === 0 }, null, 2));
  else render(role);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

if (require.main === module) {
  // Even main() is wrapped. The contract this script offers callers — the wizard among them — is
  // that it always prints a verdict and always exits 0 or 1, and an unhandled rejection here would
  // exit with a stack trace and a code neither branch chose.
  main().catch((err) => {
    console.error(`[verify-topology] the verifier itself failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

module.exports = { describeRole, main };
