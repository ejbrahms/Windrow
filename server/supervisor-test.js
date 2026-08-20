'use strict';
// Verification test 5 from docs/design/upgrade-resilience.md §6:
//
//   "Restart behind the supervisor under load -> zero denials, latency spike only."
//
// It runs the real server/supervisor.js against an isolated copy of the database on alternate
// ports, hammers the public port while the backend is killed underneath it, and asserts what the
// hooks actually care about: that not one request was REFUSED. A supervisor that quietly answered
// 503 instead of parking would pass a naive "did it stay up" check and fail the field, so the
// assertions distinguish the three outcomes the hook distinguishes — answered, parked-then-
// answered, and refused.
//
// Two instances, because there are two behaviours to prove:
//
//   A  PARK_MS = 5000 (production)  -> a hard kill of the backend costs latency and nothing else.
//   B  PARK_MS = 150  (deliberately
//      shorter than any real restart) -> the parking window EXPIRES, and what comes back is an
//                                      honest JSON 503 the hook classifies as FAULT.UNREACHABLE,
//                                      not a dropped socket. Parking shrinks the fault window; it
//                                      was never supposed to abolish it, and a test that only
//                                      proved the happy path would let a future change turn a
//                                      never-ready backend into an infinite hang.
//
// Run:  npm run test:supervisor      (nothing here touches the live :4000 service or its database)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_DIR = __dirname;
const SCRATCH = path.join(REPO_ROOT, '.sandbox', 'supervisor-test');
const LIVE_DB = process.env.WINDROW_DB_PATH || path.join(SERVER_DIR, 'data', 'windrow.db');
const CONTROL_TOKEN_PATH = path.join(SERVER_DIR, 'data', 'supervisor-token');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, classified the way a hook would classify it. `refused` is the outcome this whole
 * design exists to eliminate — it is what ECONNREFUSED looks like from the caller's side, and it is
 * indistinguishable from a policy denial by the time it reaches an agent.
 */
function get(port, route, headers) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers, timeout: 20_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, text, headers: res.headers, ms: Date.now() - startedAt })
      );
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ refused: true, code: err.code || err.message, ms: Date.now() - startedAt }));
    req.end();
  });
}

function post(port, route, body, headers) {
  const startedAt = Date.now();
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        timeout: 45_000,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, ms: Date.now() - startedAt }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ refused: true, code: err.code || err.message, ms: Date.now() - startedAt }));
    req.write(payload);
    req.end();
  });
}

function isolatedEnv({ port, upstream, tls, parkMs, name }) {
  const home = path.join(SCRATCH, name, 'home');
  const dataDir = path.join(SCRATCH, name, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const db = path.join(dataDir, 'windrow.db');
  // A COPY. The live service is on :4000 against the original and must not notice this run at all.
  if (fs.existsSync(LIVE_DB)) fs.copyFileSync(LIVE_DB, db);
  return {
    ...process.env,
    PORT: String(port),
    WINDROW_UPSTREAM_PORT: String(upstream),
    WINDROW_TLS_PORT: String(tls),
    WINDROW_PARK_MS: String(parkMs),
    WINDROW_DB_PATH: db,
    WINDROW_USER_HOME: home,
    // Disables the cache warmer, hook watcher, native-observation drain and usage shipper — every
    // one of which reaches OUTSIDE the copied database into the live deployment (server/index.js).
    WINDROW_SANDBOX: '1',
  };
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(port, '/api/ready');
    if (res.status === 200) return true;
    await sleep(200);
  }
  return false;
}

function startSupervisor(env) {
  const proc = spawn(process.execPath, [path.join(SERVER_DIR, 'supervisor.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const collect = (buf) => String(buf).split('\n').filter(Boolean).forEach((l) => lines.push(l));
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  return { proc, lines };
}

/** Fire a request every `everyMs` for `durationMs`, collecting every outcome. */
async function load(port, { everyMs, durationMs }) {
  const results = [];
  const deadline = Date.now() + durationMs;
  const inflight = [];
  while (Date.now() < deadline) {
    inflight.push(get(port, '/api/ready').then((r) => results.push(r)));
    await sleep(everyMs);
  }
  await Promise.all(inflight);
  return results;
}

async function controlToken() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const t = fs.readFileSync(CONTROL_TOKEN_PATH, 'utf8').trim();
      if (t) return t;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  return null;
}

// ---------------------------------------------------------------------------

async function instanceA() {
  console.log('\n--- A: production parking window (5 s), backend killed under load ---');
  const env = isolatedEnv({ port: 4200, upstream: 4210, tls: 4243, parkMs: 5000, name: 'a' });
  const { proc, lines } = startSupervisor(env);
  try {
    check(await waitForPort(4200), 'supervisor serves :4200 once the backend is ready');

    const token = await controlToken();
    check(!!token, 'supervisor wrote its owner-only control credential');

    const status = await get(4200, '/api/supervisor/status', { 'x-windrow-supervisor-token': token });
    const backendPid = JSON.parse(status.text).backendPid;
    check(status.status === 200 && backendPid > 0, 'control status names the backend pid', `pid ${backendPid}`);

    const unauth = await get(4200, '/api/supervisor/status');
    check(unauth.status === 401, 'control surface refuses an unauthenticated caller', `got ${unauth.status}`);

    // The event under test: a hard kill, i.e. what a deploy or a crash does. Not a graceful stop —
    // graceful is the easy case.
    const loading = load(4200, { everyMs: 25, durationMs: 14_000 });
    await sleep(1500);
    console.log(`    killing backend pid ${backendPid} under load...`);
    process.kill(backendPid);
    const results = await loading;

    const refused = results.filter((r) => r.refused);
    const failed = results.filter((r) => !r.refused && r.status !== 200);
    const parked = results.filter((r) => !r.refused && r.status === 200 && r.ms > 250);
    const slowest = results.reduce((m, r) => Math.max(m, r.ms), 0);

    check(refused.length === 0, `zero connections refused across ${results.length} requests`,
      refused.length ? `${refused.length}x ${refused[0].code}` : 'the port never went away');
    check(failed.length === 0, 'zero non-200 answers', failed.length ? `first was ${failed[0].status}` : '');
    check(parked.length > 0, 'at least one request was parked rather than answered instantly',
      `${parked.length} parked, slowest ${slowest} ms`);
    check(slowest < 5000, 'the longest park stayed inside the 5 s window', `${slowest} ms`);
    check(
      lines.some((l) => l.includes('releasing parked requests')),
      'the supervisor logged the release'
    );

    // The other half of "owns the port across restarts": a restart requested THROUGH the supervisor
    // never drops the listener either.
    const loading2 = load(4200, { everyMs: 25, durationMs: 12_000 });
    await sleep(500);
    console.log('    requesting a supervised restart under load...');
    const restarted = await post(4200, '/api/supervisor/restart', {}, { 'x-windrow-supervisor-token': token });
    const results2 = await loading2;
    const body = JSON.parse(restarted.text);
    check(restarted.status === 200 && body.ready, 'supervised restart came back ready', `backend pid ${body.backendPid}`);
    check(body.backendPid !== backendPid, 'it is genuinely a new backend process');
    check(results2.every((r) => !r.refused), `zero refusals across ${results2.length} requests during the restart`);
    check(results2.every((r) => r.status === 200), 'every request during the restart got a real answer');

    // A POST is the case a naive proxy gets wrong: replaying it requires having kept the body, and
    // a proxy that streamed it straight through has nothing left to send on the second attempt. The
    // route is deliberately one that does not exist — what is under test is that a POST issued while
    // the backend is DOWN reaches the backend at all, not what the backend says about it.
    const pid2 = JSON.parse(
      (await get(4200, '/api/supervisor/status', { 'x-windrow-supervisor-token': token })).text
    ).backendPid;
    process.kill(pid2);
    await sleep(60);
    const writeDuring = await post(4200, '/api/no-such-route', { hello: 'world' });
    check(!writeDuring.refused, 'a POST issued while the backend was down was not refused',
      writeDuring.refused ? writeDuring.code : `${writeDuring.status} after ${writeDuring.ms} ms`);
    check(writeDuring.status !== 503, 'that POST was parked and replayed against the new backend, not failed',
      `status ${writeDuring.status}`);
    check(writeDuring.headers['x-windrow-parked'] === 'replayed' || writeDuring.ms > 250,
      'and it visibly waited for the backend rather than being answered by the supervisor');
    check(await waitForPort(4200), 'the backend recovered after that kill too');
  } finally {
    proc.kill();
    await sleep(500);
  }
}

async function instanceB() {
  console.log('\n--- B: parking window shorter than the restart (150 ms) — the honest failure ---');
  const env = isolatedEnv({ port: 4300, upstream: 4310, tls: 4343, parkMs: 150, name: 'b' });
  const { proc } = startSupervisor(env);
  try {
    check(await waitForPort(4300), 'supervisor serves :4300 once the backend is ready');
    const token = await controlToken();
    const status = await get(4300, '/api/supervisor/status', { 'x-windrow-supervisor-token': token });
    const backendPid = JSON.parse(status.text).backendPid;

    process.kill(backendPid);
    await sleep(120); // inside the down window, past the point the supervisor has noticed
    const during = await get(4300, '/api/ready');

    check(!during.refused, 'the connection was still accepted, not refused', during.refused ? during.code : `${during.status}`);
    check(during.status === 503, 'an expired parking window answers 503', `got ${during.status}`);
    check(
      during.headers && during.headers['x-windrow-fault'] === 'backend-unavailable',
      'the 503 names itself a fault rather than a decision'
    );
    let parsed = null;
    try {
      parsed = JSON.parse(during.text);
    } catch {
      /* left null — asserted below */
    }
    check(parsed && parsed.kind === 'fault', 'the 503 body is JSON, so the hook classifies it rather than crashing on it');
    check(during.ms < 3000, 'it failed at the window, not after some longer hidden timeout', `${during.ms} ms`);

    check(await waitForPort(4300), 'the backend came back on its own after the crash');
  } finally {
    proc.kill();
    await sleep(500);
  }
}

async function main() {
  if (!fs.existsSync(LIVE_DB)) {
    console.log(`No database at ${LIVE_DB} — the test instances will create their own.`);
  }
  await instanceA();
  await instanceB();
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
