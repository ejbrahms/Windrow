'use strict';
// The request-parking supervisor — docs/design/upgrade-resilience.md §3.4, the one row of that
// design's status table that was still "not built".
//
// THE PROBLEM IT REMOVES
// A PreToolUse hook is a fresh Node process that lives ~20 ms and dies (docs/design/
// latency-breakdown.md). It has no retry loop, no connection pool and nowhere to wait. So when the
// backend restarts, every hook that happens to fire inside that ~10-second window gets ECONNREFUSED
// on 127.0.0.1:4000, which `runPreToolUse` classifies as FAULT.UNREACHABLE and — absent a grace
// lease — turns into a `deny` on every `mutating` call on the field. That is the 2026-08-19
// incident's shape: a healthy database, valid grants, and a fleet-wide denial caused by nothing but
// a socket that wasn't there for a few seconds.
//
// The fix is not to make the restart faster. It is to make the *port* outlive the process behind
// it. This supervisor owns :4000 permanently and runs the real server as a child on a private
// upstream port. While that child is down it does not refuse the connection — it HOLDS it, up to
// PARK_MS, and replays the request the moment the new child answers /api/ready. A restart stops
// being a fault and becomes latency, which is a thing a hook can survive without a policy decision
// being invented for it.
//
//   before:  hook -> :4000  ECONNREFUSED      -> FAULT -> deny
//   after:   hook -> :4000  [parked 1.4 s]    -> 200   -> real decision
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It is not a load balancer and holds no policy. It never inspects or rewrites a body, never
//     decides anything, and adds no authority: the upstream still sees the same request with the
//     same bearer token and answers it the same way. The security model is untouched, which matters
//     because §4 of the design is explicit that nothing may relax on an unsigned local condition —
//     parking relaxes nothing, it only defers.
//   - It fronts the PLAINTEXT hook listener only. The mTLS listener (:4443) is bound by the child
//     itself and is not proxied: admin authority travels over a client certificate, and terminating
//     or forwarding that here would either break the credential or make this process a party to it.
//     A restart is visible on :4443 as a brief refusal, which is correct — the dashboard and the CLI
//     both have somewhere to wait, and hooks do not. That asymmetry is the entire justification for
//     this file existing, so it is also the reason not to generalise it.
//   - It does not park forever. PARK_MS is 5 s because a hook's caller is a human waiting on a tool
//     call; past that the honest answer is a 503 that classifies as FAULT.UNREACHABLE, exactly as
//     today, and the grace lease does its job. Parking shrinks the fault window, it does not abolish
//     it, and a supervisor that hid a backend which never came back would be worse than the outage.
//
// RUN IT
//   node server/supervisor.js        (this is what `npm start` and the Windows service now launch)
//   PORT=4000  WINDROW_UPSTREAM_PORT=4100  WINDROW_PARK_MS=5000

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { writeSecret, isOwnerOnly } = require('./enrollment/secretFile');

const PUBLIC_PORT = Number(process.env.PORT) || 4000;
// The child's plaintext listener. Loopback-only like the port it stands behind, and deliberately
// not 4001 — scripts/sandbox.js and the alt-port test-instance workflow in §3.4's tip use the low
// 40xx range for whole throwaway instances, and a supervisor upstream colliding with one of those
// would look exactly like the stale-build skew this whole document is about.
const UPSTREAM_PORT = Number(process.env.WINDROW_UPSTREAM_PORT) || 4100;
const PARK_MS = Number(process.env.WINDROW_PARK_MS) || 5000;

const ENTRY = path.join(__dirname, 'index.js');
const CONTROL_TOKEN_PATH = path.join(__dirname, 'data', 'supervisor-token');

// How much of a request body is held in memory so it can be REPLAYED after a failed attempt.
// Everything a hook sends is a few kilobytes of JSON, so in practice every hook call is replayable;
// the cap exists for the dashboard's larger writes (a skill body, a package payload), which spill
// to a straight stream and simply lose the retry — they are interactive calls with a human able to
// press the button again, which is the property hooks lack.
const REPLAY_BODY_CAP = 1024 * 1024;

// ---------------------------------------------------------------------------
// Child lifecycle
//
// `ready` is not "the process exists" — it is "/api/ready answered". Those differ by the several
// seconds better-sqlite3 spends opening the database and the CA spends loading, and forwarding into
// that gap would produce ECONNREFUSED from inside the supervisor: the same fault, moved.
let child = null;
let ready = false;
let readyWaiters = [];
let probeTimer = null;
let stopping = false;
// Set while `stopChild` is deliberately taking the backend down. Without it the child's own `exit`
// handler races the caller: `onChildExit` would queue an automatic restart at the same instant the
// restart route spawns its replacement, and the two would fight over :4100 and the mTLS listener on
// :4443. The loser dies with EADDRINUSE, which looks exactly like a crash loop and is not one.
let intentionalStop = false;
let restarts = 0;
let childStartedAt = 0;

function now() {
  return Date.now();
}

function log(...args) {
  console.log('[supervisor]', ...args);
}

function markReady() {
  if (ready) return;
  ready = true;
  restarts = 0; // the child got all the way up; a later crash starts its backoff from zero again
  log(`upstream ready on :${UPSTREAM_PORT} (pid ${child && child.pid}) — releasing parked requests`);
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const w of waiters) w(true);
}

function markDown(why) {
  if (!ready) return;
  ready = false;
  log(`upstream down (${why}) — parking incoming requests for up to ${PARK_MS} ms`);
  scheduleProbe(0);
}

/**
 * Poll /api/ready until it answers. Only runs while `ready` is false, so a healthy field pays
 * nothing for this: the steady state is zero probes, and a proxy attempt failing with ECONNREFUSED
 * is what flips the flag back and restarts the polling.
 */
function scheduleProbe(delay = 150) {
  if (probeTimer || ready || stopping) return;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    const req = http.request(
      { host: '127.0.0.1', port: UPSTREAM_PORT, path: '/api/ready', method: 'GET', timeout: 2000 },
      (res) => {
        // Drain, or the socket is held open and the next probe starts a second connection.
        res.resume();
        if (res.statusCode === 200) markReady();
        else scheduleProbe();
      }
    );
    req.on('timeout', () => req.destroy(new Error('probe timed out')));
    req.on('error', () => scheduleProbe());
    req.end();
  }, delay);
  if (probeTimer.unref) probeTimer.unref();
}

function spawnChild() {
  if (stopping) return;
  // One backend at a time, always. The child owns the mTLS listener as well as the upstream port,
  // so a second one is not a spare — it is an EADDRINUSE crash whose cause is three layers away.
  if (child) return;
  childStartedAt = now();
  ready = false;
  child = spawn(process.execPath, [ENTRY], {
    // stdio inherited so the child's own logging still reaches the service log files
    // (server/daemon/windrow.out.log) exactly as it did when it was the top-level process.
    stdio: 'inherit',
    env: {
      ...process.env,
      // The child binds the private upstream port; the supervisor holds the public one. Everything
      // else — TLS_PORT, WINDROW_USER_HOME, the central URL — is passed through untouched.
      PORT: String(UPSTREAM_PORT),
      // Lets the child (and anything reading its environment) tell "I am behind the supervisor"
      // from "I am the whole service", without having to infer it from a port number.
      WINDROW_SUPERVISED: '1',
    },
  });
  log(`started backend pid ${child.pid} on :${UPSTREAM_PORT}`);
  child.on('exit', (code, signal) => onChildExit(code, signal));
  child.on('error', (err) => {
    console.error('[supervisor] could not start the backend:', err.message);
    onChildExit(null, null);
  });
  scheduleProbe(0);
}

function onChildExit(code, signal) {
  const wasReady = ready;
  ready = false;
  child = null;
  if (stopping) return;
  if (intentionalStop) {
    // A supervised restart. Whoever asked for it spawns the replacement once the exit has landed,
    // so auto-restarting here would produce a second backend, not a faster one.
    log(`backend stopped on request after ${now() - childStartedAt} ms`);
    return;
  }
  const uptime = now() - childStartedAt;
  log(`backend exited (code ${code}, signal ${signal}) after ${uptime} ms${wasReady ? '' : ' — before it ever became ready'}`);

  // Backoff, but a gentle one. The first restart is immediate because that is the case this file
  // exists for: an operator killed the backend to load new code, requests are parked RIGHT NOW, and
  // every millisecond of delay is spent inside somebody's PARK_MS budget. Only a child that keeps
  // dying earns a wait.
  restarts += 1;
  const delay = restarts <= 1 ? 0 : Math.min(250 * 2 ** (restarts - 2), 5000);
  if (restarts > 1) log(`restarting in ${delay} ms (attempt ${restarts})`);
  setTimeout(spawnChild, delay);
}

// ---------------------------------------------------------------------------
// Parking

/**
 * Resolve true once the upstream is ready, or false at the deadline. A client that hangs up while
 * parked is dropped from the list by its own caller — see `handle`.
 */
function waitForReady(deadlineMs) {
  if (ready) return Promise.resolve(true);
  scheduleProbe(0);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((w) => w !== done);
      done(false);
    }, Math.max(0, deadlineMs - now()));
    if (timer.unref) timer.unref();
    readyWaiters.push(done);
  });
}

// Hop-by-hop headers belong to the single connection they arrived on and must not be forwarded
// (RFC 9110 §7.6.1). `connection` is the one that actually bites here: Node sets its own on the
// upstream request, and forwarding a client's `close` would tear down the keep-alive socket the
// supervisor is trying to reuse.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardHeaders(req, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  // The body is re-sent from a buffer, so the framing is ours to state, not the client's.
  if (bodyLength !== null) {
    delete out['transfer-encoding'];
    out['content-length'] = String(bodyLength);
  }
  // Named so an upstream log line can tell a parked-and-replayed call from a direct one.
  out['x-windrow-via'] = 'supervisor';
  return out;
}

/**
 * Read the body into memory so a failed attempt can be replayed. Resolves as soon as the request
 * ends, or as soon as it exceeds the cap — in the second case the request stream is left PAUSED and
 * `overflow` is set, and the caller pipes the remainder straight through with no retry available.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > REPLAY_BODY_CAP) {
        req.pause();
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', reject);
        resolve({ body: Buffer.concat(chunks), overflow: true });
      }
    };
    const onEnd = () => resolve({ body: Buffer.concat(chunks), overflow: false });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);

function unavailable(res, req, detail) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify({
    error: 'backend-unavailable',
    detail,
    parkedMs: PARK_MS,
    // Says plainly which of the two "no"s this is. The hook's own taxonomy will land on
    // FAULT.UNREACHABLE for a non-2xx with no parseable contract, which is the right class — this
    // header just makes it legible to a human reading a log or a curl.
    kind: 'fault',
  });
  res.writeHead(503, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-windrow-fault': 'backend-unavailable',
    // A restart is measured in seconds; tell a client that honours it to come back after one.
    'retry-after': '1',
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

async function handle(req, res) {
  const deadline = now() + PARK_MS;

  // Drop a parked request whose client already gave up, rather than waking the upstream for it.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  let read;
  try {
    read = await readBody(req);
  } catch {
    if (!res.headersSent) res.writeHead(400).end();
    return;
  }
  if (aborted) return;

  const canReplay = !read.overflow;

  const attempt = (isRetry) =>
    new Promise((resolve) => {
      const proxyReq = http.request(
        {
          host: '127.0.0.1',
          port: UPSTREAM_PORT,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req, canReplay ? read.body.length : null),
        },
        (proxyRes) => {
          if (aborted) {
            proxyRes.destroy();
            resolve({ ok: true });
            return;
          }
          const headers = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
          }
          if (isRetry) headers['x-windrow-parked'] = 'replayed';
          res.writeHead(proxyRes.statusCode, headers);
          // Piped, never buffered: /api/policy/events is an SSE stream that must reach its client
          // event by event, and a supervisor that collected the response first would convert a
          // push channel into a connection that never completes.
          proxyRes.pipe(res);
          proxyRes.on('error', () => res.destroy());
          resolve({ ok: true });
        }
      );

      proxyReq.on('error', (err) => {
        // ECONNREFUSED is the whole reason this file exists and is unambiguous: the connection was
        // never established, so the upstream cannot have acted on the request. Safe to replay
        // whatever the method.
        //
        // A reset AFTER the request was written is not safe the same way — the backend may have
        // applied a POST and died before answering, and replaying it would double-apply a grant or
        // a usage event. So a non-idempotent call in that state gets an honest 503 rather than a
        // silent duplicate. Refusing to guess here is the difference between latency and
        // corruption.
        const refused = err.code === 'ECONNREFUSED' || (err.code === 'ECONNRESET' && !proxyReq.writableFinished);
        markDown(err.code || err.message);
        resolve({
          ok: false,
          retryable: canReplay && !res.headersSent && (refused || IDEMPOTENT.has(req.method)),
          detail: err.code || err.message,
        });
      });

      if (canReplay) {
        proxyReq.end(read.body);
      } else {
        // Over the replay cap: hand over what was buffered, then let the rest stream.
        proxyReq.write(read.body);
        req.resume();
        req.pipe(proxyReq);
      }
    });

  // Park BEFORE the first attempt when we already know the upstream is down, so a request arriving
  // mid-restart never spends one of its attempts on a socket that certainly isn't there.
  if (!ready && !(await waitForReady(deadline))) {
    if (!aborted) unavailable(res, req, 'the backend did not become ready within the parking window');
    return;
  }

  let result = await attempt(false);
  while (!result.ok && result.retryable && !aborted) {
    if (!(await waitForReady(deadline))) {
      if (!aborted) unavailable(res, req, `backend unavailable (${result.detail}) throughout the parking window`);
      return;
    }
    result = await attempt(true);
  }
  if (!result.ok && !aborted && !res.headersSent) {
    unavailable(res, req, result.detail);
  }
}

// ---------------------------------------------------------------------------
// Control surface
//
// A restart that goes through here is the good kind: the supervisor never lets go of :4000, so the
// requests that arrive during it park instead of failing. Killing the backend by PID works too and
// is handled identically by `onChildExit` — this just saves an operator from having to find it.
//
// Guarded by a local secret file rather than being open, because :4000 is the loopback listener
// that carries `agent` scope, and "any hook can bounce the service" is a denial-of-service handed
// to the least-privileged caller on the box. It is a separate secret from the hook credential for
// the same reason: a skill that reads one should not thereby get the other.
function loadOrCreateControlToken() {
  try {
    const existing = fs.readFileSync(CONTROL_TOKEN_PATH, 'utf8').trim();
    if (existing) {
      if (!isOwnerOnly(CONTROL_TOKEN_PATH)) writeSecret(CONTROL_TOKEN_PATH, existing);
      return existing;
    }
  } catch {
    // not created yet
  }
  const value = crypto.randomBytes(24).toString('hex');
  writeSecret(CONTROL_TOKEN_PATH, value);
  return value;
}

const CONTROL_TOKEN = loadOrCreateControlToken();

function controlAuthorised(req) {
  const presented = String(req.headers['x-windrow-supervisor-token'] || '');
  const a = Buffer.from(presented);
  const b = Buffer.from(CONTROL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function statusPayload() {
  return {
    supervisorPid: process.pid,
    backendPid: child ? child.pid : null,
    ready,
    publicPort: PUBLIC_PORT,
    upstreamPort: UPSTREAM_PORT,
    parkMs: PARK_MS,
    restarts,
    backendUptimeMs: child ? now() - childStartedAt : 0,
  };
}

/** SIGTERM, then SIGKILL if it will not go. Resolves once the process is actually gone. */
function stopChild(timeoutMs = 10_000) {
  return new Promise((resolve) => {
    if (!child) return resolve();
    intentionalStop = true;
    const dying = child;
    const kill = setTimeout(() => {
      // On Windows SIGTERM is not a signal the child can handle — `kill` terminates it outright —
      // so this path is really only reached on POSIX, where a wedged shutdown is possible.
      try { dying.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    if (kill.unref) kill.unref();
    dying.once('exit', () => {
      clearTimeout(kill);
      intentionalStop = false;
      resolve();
    });
    try { dying.kill('SIGTERM'); } catch { intentionalStop = false; resolve(); }
  });
}

async function handleControl(req, res) {
  const send = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (!controlAuthorised(req)) {
    return send(401, { error: 'supervisor control requires the token in server/data/supervisor-token' });
  }
  const route = req.url.split('?')[0];
  if (route === '/api/supervisor/status' && req.method === 'GET') {
    return send(200, statusPayload());
  }
  if (route === '/api/supervisor/restart' && req.method === 'POST') {
    log('restart requested — the port stays bound, so requests park rather than fail');
    // The old child must be fully gone before the new one starts: it also owns the mTLS listener on
    // :4443, and two of them overlapping is an EADDRINUSE that would look like a crash loop.
    await stopChild();
    spawnChild();
    const became = await waitForReady(now() + 30_000);
    return send(became ? 200 : 504, { restarted: true, ready: became, ...statusPayload() });
  }
  return send(404, { error: `no supervisor route ${req.method} ${route}` });
}

// ---------------------------------------------------------------------------
// Listener

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/supervisor/')) {
    handleControl(req, res).catch((err) => {
      console.error('[supervisor] control error:', err.message);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  handle(req, res).catch((err) => {
    console.error('[supervisor] proxy error:', err.stack || err.message);
    if (!res.headersSent) unavailable(res, req, err.message);
  });
});

// A parked request is a request that is deliberately taking a long time. Node's default 5 s
// headers timeout and 0 request timeout are both wrong for that: the first would kill a parked
// connection a fifth of a second before PARK_MS even expires.
server.headersTimeout = PARK_MS + 30_000;
server.requestTimeout = 0; // SSE responses on /api/policy/events are open-ended by design
server.keepAliveTimeout = 30_000;

// No 'upgrade' handler: nothing in this service speaks WebSocket over :4000 (the only push channel
// is SSE on /api/policy/events, which is a plain response and pipes through above). An upgrade
// request therefore gets Node's default — the socket is closed — which is the same answer the
// backend alone would have given.

server.listen(PUBLIC_PORT, '127.0.0.1', () => {
  log(
    `holding http://127.0.0.1:${PUBLIC_PORT} across restarts; backend on :${UPSTREAM_PORT}, ` +
      `parking window ${PARK_MS} ms`
  );
  spawnChild();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[supervisor] port ${PUBLIC_PORT} is already held by another process.\n` +
        `If that is an older Windrow started without the supervisor, stop it first — the point of ` +
        `this process is that it, and not the backend, owns the port.`
    );
    process.exit(1);
  }
  throw err;
});

// Take the child with us. Without this, stopping the service leaves an orphan holding :4100 and
// :4443, and the next start fails in a way that looks nothing like its cause.
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} — stopping backend and releasing :${PUBLIC_PORT}`);
  server.close();
  await stopChild();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  if (!child) return;
  try { child.kill(); } catch { /* already gone */ }
});
