'use strict';
// `npm run restart` — bounce the backend WITHOUT dropping port 4000.
//
// This is the operator-facing half of server/supervisor.js. Stopping the Windows service, or
// killing the node process, takes the listener down with it: every hook that fires in the next ~10
// seconds gets ECONNREFUSED, which the hook classifies as FAULT.UNREACHABLE and — with no grace
// lease in force — denies every `mutating` call on the field
// (docs/design/upgrade-resilience.md §3.4). Going through the supervisor instead keeps :4000 bound
// the whole time, so those same requests park and are replayed against the new process.
//
//   npm run restart          bounce the backend, wait for /api/ready
//   npm run restart:status   what the supervisor thinks is running right now
//
// It authenticates with server/data/supervisor-token, a local owner-only file the supervisor
// generates on first boot. That guard is not ceremony: :4000 is the loopback listener that carries
// `agent` scope, so an unguarded restart route would hand the least-privileged caller on the
// machine a way to bounce the service at will.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const TOKEN_PATH = path.join(__dirname, '..', 'server', 'data', 'supervisor-token');

let token;
try {
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
} catch {
  console.error(
    `No supervisor credential at ${TOKEN_PATH}.\n` +
      `It is written on the supervisor's first boot — if it is missing, the thing listening on ` +
      `:${PORT} is probably server/index.js started directly, which owns the port itself and ` +
      `cannot be restarted without dropping it. Start it with "npm start" instead.`
  );
  process.exit(1);
}

function call(method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: route,
        headers: { 'x-windrow-supervisor-token': token },
        // A restart waits for the new process to open the database and answer /api/ready. The
        // supervisor caps that at 30 s itself; this just has to outlast it.
        timeout: 45_000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

function describe(body) {
  return (
    `supervisor pid ${body.supervisorPid}, backend pid ${body.backendPid}, ready=${body.ready}\n` +
    `:${body.publicPort} -> :${body.upstreamPort}, parking window ${body.parkMs} ms, ` +
    `${body.restarts} restart(s) since the last healthy start`
  );
}

async function main() {
  const wantsStatus = process.argv[2] === 'status';
  let res;
  try {
    res = wantsStatus
      ? await call('GET', '/api/supervisor/status')
      : await call('POST', '/api/supervisor/restart');
  } catch (err) {
    console.error(`Could not reach the supervisor on :${PORT} — ${err.message}`);
    process.exit(1);
  }
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    // The API and the built client are one service, so a request that reaches the BACKEND rather
    // than the supervisor comes back as index.html. That means the supervisor is not in front.
    console.error(
      `:${PORT} answered ${res.status} with non-JSON. Whatever is on that port is not the ` +
        `supervisor — most likely server/index.js started directly.`
    );
    process.exit(1);
  }
  if (res.status === 401) {
    console.error('The supervisor rejected the credential. Is server/data/supervisor-token stale?');
    process.exit(1);
  }
  if (wantsStatus) {
    console.log(describe(body));
    return;
  }
  console.log(describe(body));
  if (!body.ready) {
    console.error(
      '\nThe backend did not answer /api/ready within 30 s. Port 4000 is still held, so callers are ' +
        'being parked and then told 503 rather than refused — but something is wrong with the new ' +
        'build. Check the server log.'
    );
    process.exit(1);
  }
  console.log('\nBacked up and ready. Port 4000 was never released.');
}

main();
