'use strict';
// `npm run upgrade:begin` / `npm run upgrade:end` / `npm run upgrade:status`
// (docs/design/upgrade-resilience.md §3.2, §5).
//
// The window this opens is the difference between an upgrade that costs agents some latency and
// one that denies every mutating call on the field until someone notices (2026-08-19).
//
// Order matters and is the whole point:
//
//   begin  -> the server is STILL UP and signs the lease. Do this BEFORE stopping anything.
//   ...     stop the service, migrate, start the new build
//   status -> confirms the new build answers /api/ready with the contract the hooks expect
//   end    -> revokes the lease early; otherwise it expires on its own
//
// Running `begin` after the server is down is the one way to hold this wrong, and it fails loudly
// rather than pretending: there is no offline path that writes a lease, by design.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const enrollment = require('../server/enrollment/client');
const { envCompat } = require('../server/config');

// This script used to present the shared admin bearer token. It now presents a per-node admin
// *certificate* (docs/design/per-node-enrollment-credentials.md): the routes it calls are
// requireAdmin, and admin authority only travels over the mTLS listener now — the plaintext
// loopback listener issues `agent` scope and nothing else, so pointing this at :4000 can never
// work however the credential is supplied.
const API_BASE = envCompat('API_BASE', { fallback: 'https://127.0.0.1:4443/api' });
const EXPECTED_CONTRACT_VERSION = 1;

// Loaded once rather than per request: an upgrade makes several calls and re-reading the key each
// time would be pure noise. A missing credential is fatal here and says how to fix itself — this
// runs during an upgrade, where a vague 401 is the worst possible failure mode.
const credential = enrollment.load('cli');
if (!credential) {
  console.error(
    'No admin credential found for the CLI.\n' +
    'Enroll one first:\n' +
    '  1. mint a token:  POST /api/enrollment-tokens {"scope":"admin"}  (or use the bootstrap token\n' +
    '     written to server/data/bootstrap-enrollment-token on first run)\n' +
    '  2. enroll:        node -e "require(\'./server/enrollment/client\').enroll({name:\'cli\',' +
    'baseUrl:process.env.WINDROW_API_BASE||\'https://127.0.0.1:4443\',enrollmentToken:process.argv[1]})" <token>');
  process.exit(1);
}

function request(method, pathname, body) {
  const url = new URL(`${API_BASE}${pathname}`);
  const mod = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        timeout: 10_000,
        // The credential is the TLS handshake, not a header — there is no Authorization line any
        // more. `ca` is our own enrollment root, so this verifies the server as well as proving
        // who we are; `servername` is fixed because the certificate's SAN is `localhost` even when
        // the connection is made to 127.0.0.1.
        ...(url.protocol === 'https:'
          ? { key: credential.key, cert: credential.cert, ca: credential.ca, servername: 'localhost' }
          : {}),
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function parse(res, what) {
  try {
    return JSON.parse(res.text);
  } catch {
    // The API and the built client are one service, so a route the running build lacks answers
    // with index.html rather than a 404 body — the exact failure that started all this.
    throw new Error(
      `${what}: server answered ${res.status} with non-JSON. It is probably an older build without this route.`
    );
  }
}

async function begin() {
  const durationMs = Number(process.env.UPGRADE_GRACE_MS) || 15 * 60_000;
  const reason = process.argv.slice(3).join(' ') || 'manual upgrade';
  let res;
  try {
    res = await request('POST', '/maintenance/grace', { durationMs, reason });
  } catch (err) {
    console.error(
      `Could not reach the governance API at ${API_BASE}: ${err.message}\n` +
        `A grace lease can only be issued by a HEALTHY server — that timing is the security property.\n` +
        `If the server is already down, start it, run this, and only then stop it again.`
    );
    process.exit(1);
  }
  if (res.status !== 201) {
    console.error(`Refused (${res.status}): ${res.text}`);
    process.exit(1);
  }
  const lease = parse(res, 'grace');
  console.log(
    `Grace lease ${lease.id} in force until ${new Date(lease.until).toLocaleTimeString()} ` +
      `for [${lease.tolerate.join(', ')}].\n` +
      `Faults on those tiers now fall back to the local grant replica instead of denying.\n` +
      `Destructive calls will ask a human. Nothing is auto-allowed that has no grant.\n\n` +
      `You may now stop the service and migrate. Run "npm run upgrade:status" once it is back.`
  );
}

async function status() {
  let res;
  try {
    res = await request('GET', '/ready');
  } catch (err) {
    console.error(`NOT READY — ${API_BASE} is unreachable (${err.message}). The grace lease is doing the work.`);
    process.exit(1);
  }
  const ready = parse(res, 'ready');
  const ok = ready.contract && ready.contract.version === EXPECTED_CONTRACT_VERSION;
  console.log(`ready=${ready.ready} pid=${ready.pid} startedAt=${ready.startedAt}`);
  console.log(`hook contract v${ready.contract && ready.contract.version} (expected v${EXPECTED_CONTRACT_VERSION})`);
  if (!ok) {
    console.error(
      `\nCONTRACT MISMATCH — the running build does not speak the hook contract this checkout expects.\n` +
        `Do NOT revoke the grace lease: the hooks would start failing closed. Restart the correct build first.`
    );
    process.exit(1);
  }
  console.log('\nOK — safe to run "npm run upgrade:end".');
}

async function end() {
  const res = await request('DELETE', '/maintenance/grace');
  if (res.status !== 200) {
    console.error(`Refused (${res.status}): ${res.text}`);
    process.exit(1);
  }
  console.log('Grace lease revoked. Normal fail-closed policy is back in force.');
}

const cmd = process.argv[2];
const run = { begin, end, status }[cmd];
if (!run) {
  console.error('usage: node scripts/upgrade.js <begin|status|end> [reason...]');
  process.exit(2);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
