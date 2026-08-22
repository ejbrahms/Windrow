'use strict';
// `npm run denials:off [duration] [reason...]` / `npm run denials:on` / `npm run denials:status`
//
// Turns policy denials off for a bounded window so you can debug or test without enforcement as a
// second variable in the experiment. See server/enforcementPause.js for what it does and does not
// suppress — in short: "you have no grant for this" is suppressed, "your access was revoked" and
// "you are shelling directly at the governance API" are not.
//
//   denials:off 20m "repro #412"   opens a 20-minute window (clamped into [5m, 30m])
//   denials:status                 how long is left, and on which tiers
//   denials:on                     closes it early; it expires on its own regardless
//
// Destructive capabilities are NOT covered unless you ask for them by name:
//
//   denials:off 10m --tiers=read_only,mutating,destructive "testing the delete path"
//
// This talks to the API rather than writing the pause file itself, and that is the security
// property, not an implementation detail: a pause is only ever signed by a server that is up and
// serving, so killing the API can never be a way to switch enforcement off. Running this with the
// server down fails loudly instead of pretending.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const enrollment = require('../server/enrollment/client');
const { envCompat } = require('../server/config');

// Admin-scoped routes, so this presents the per-node admin *certificate* over the mTLS listener —
// the same credential scripts/upgrade.js uses, and for the same reason. The plaintext loopback
// listener issues `agent` scope only, so pointing this at :4000 can never work.
const API_BASE = envCompat('API_BASE', { fallback: 'https://127.0.0.1:4443/api' });

const credential = enrollment.load('cli');
if (!credential) {
  console.error(
    'No admin credential found for the CLI.\n' +
    'Enroll one first — see "npm run enroll", or scripts/upgrade.js for the long form.'
  );
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
        // The credential is the TLS handshake, not a header. `servername` is fixed because the
        // certificate's SAN is `localhost` even when the connection is made to 127.0.0.1.
        ...(url.protocol === 'https:'
          ? { key: credential.key, cert: credential.cert, ca: credential.ca, servername: 'localhost' }
          : {}),
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
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
    // The API and the built client are one service, so a route the running build lacks answers with
    // index.html rather than a 404 body.
    throw new Error(
      `${what}: server answered ${res.status} with non-JSON. It is probably an older build without this route.`
    );
  }
}

/**
 * Split the argv tail into a duration, an optional --tiers list, and the free-text reason. The
 * duration is positional and optional, so `denials:off "repro #412"` works and does not silently
 * become a 0-minute window: a first argument that does not look like a duration is reason text.
 */
function parseArgs(argv) {
  const rest = [];
  let tiers;
  for (const arg of argv) {
    const m = /^--tiers=(.*)$/.exec(arg);
    if (m) {
      tiers = m[1].split(',').map((t) => t.trim()).filter(Boolean);
    } else {
      rest.push(arg);
    }
  }
  let duration;
  if (rest.length && /^\d+(\.\d+)?(ms|s|m|h)?$/i.test(rest[0])) duration = rest.shift();
  return { duration, tiers, reason: rest.join(' ') || undefined };
}

function describe(pause) {
  const mins = Math.ceil(Math.max(0, pause.until - Date.now()) / 60_000);
  return (
    `Enforcement pause ${pause.id} in force for ${mins} more minute${mins === 1 ? '' : 's'}, ` +
    `until ${new Date(pause.until).toLocaleTimeString()}, on [${pause.tolerate.join(', ')}].\n` +
    `Reason: "${pause.reason}"${pause.issuedBy ? ` (opened by ${pause.issuedBy})` : ''}`
  );
}

async function off() {
  const { duration, tiers, reason } = parseArgs(process.argv.slice(3));
  let res;
  try {
    res = await request('POST', '/enforcement/pause', {
      duration,
      reason: reason || 'debugging',
      tolerate: tiers,
    });
  } catch (err) {
    console.error(
      `Could not reach the governance API at ${API_BASE}: ${err.message}\n` +
        'An enforcement pause can only be signed by a HEALTHY server — that timing is the security\n' +
        'property, and there is no offline path that writes one. Start the server and try again.'
    );
    process.exit(1);
  }
  if (res.status !== 201) {
    console.error(`Refused (${res.status}): ${res.text}`);
    process.exit(1);
  }
  const pause = parse(res, 'enforcement pause');
  console.log(
    `${describe(pause)}\n\n` +
      'Denials on those tiers are now SUPPRESSED — a call with no grant will be allowed and logged.\n' +
      `Revocations and direct shell access to the governance API still deny.${
        pause.tolerate.includes('destructive') ? '' : '\nDestructive capabilities are NOT covered — pass --tiers=... to include them.'
      }\n` +
      'Every suppressed denial is written to server/data/hook-fault-journal.jsonl with this pause id on it.\n' +
      'It expires on its own. Run "npm run denials:on" to end it early.'
  );
}

async function status() {
  const res = await request('GET', '/enforcement/pause');
  if (res.status !== 200) {
    console.error(`Refused (${res.status}): ${res.text}`);
    process.exit(1);
  }
  const pause = parse(res, 'enforcement pause');
  if (!pause) {
    console.log('No enforcement pause. Denials are being enforced normally.');
    return;
  }
  console.log(describe(pause));
}

async function on() {
  const res = await request('DELETE', '/enforcement/pause');
  if (res.status !== 200) {
    console.error(`Refused (${res.status}): ${res.text}`);
    process.exit(1);
  }
  const { resumed } = parse(res, 'enforcement pause');
  console.log(
    resumed
      ? 'Enforcement pause ended. Denials are being enforced again.'
      : 'No pause was in force — denials were already being enforced.'
  );
}

const cmd = process.argv[2];
const run = { off, on, status }[cmd];
if (!run) {
  console.error('usage: node scripts/enforcement.js <off|on|status> [duration] [--tiers=a,b] [reason...]');
  process.exit(2);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
