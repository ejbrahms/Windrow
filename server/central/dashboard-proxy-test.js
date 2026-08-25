'use strict';

// `npm run test:dashboard-proxy --prefix server` — the CSRF/DNS-rebinding gate on the dashboard
// proxy (server/central/dashboardProxy.js). No database: it stands up a throwaway upstream that
// echoes what reached it and the real proxy in front of it, then fires the requests a browser and
// an attacker would and checks who gets through.
//
// EACH ASSERTION IS A CLAIM FROM THE HEADER ON dashboardProxy.js:
//   - a safe GET is never gated, whatever its Origin      SAFE_METHODS
//   - a mutating request with a foreign Host is refused    the DNS-rebinding check
//   - a mutating request with a foreign Origin is refused  the CSRF check
//   - a same-origin mutating request is forwarded whole    the browser sets Origin to itself
//   - a mutating request with no Origin rides on Host      curl/CLI are not a CSRF vector
//   - an operator-configured extra origin is allowed       allowedOrigins / WINDROW_CENTRAL_DASHBOARD_ORIGINS

const http = require('http');
const { startDashboardProxy, buildAllowedHosts, mutationDenialReason } = require('./dashboardProxy');

const allowedHostsFor = (port) => buildAllowedHosts(port, ['https://ops.example:8443']);

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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** A port that is free right now. The proxy's allowlist is built from the port it is told to bind,
 *  so the test must know that port up front rather than letting the OS pick one at listen time. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Fire one request at the proxy and resolve with { status, body }. A `body` is sent only when
 *  given — Node omits Content-Length for a bodied DELETE, which the upstream then can't frame, so
 *  the bodyless methods pass none and stay well-formed. */
function request({ port, method, path = '/api/thing', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  // A stand-in for the plaintext loopback listener: it answers 200 and marks that it was reached,
  // so a forwarded request is distinguishable from one the proxy refused on its own.
  const upstream = http.createServer((req, res) => {
    // Drain the body before replying — a response that ends on an unread request can reset the
    // socket, which would look like a proxy failure rather than the clean forward it is.
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reached-upstream');
    });
  });
  await listen(upstream, 0, '127.0.0.1');
  const targetPort = upstream.address().port;

  // The proxy under test. A known listenPort so its allowlist matches the port we then call; an
  // extra origin to prove operator-configured names are honoured.
  const port = await freePort();
  const proxy = await startDashboardProxy({
    listenPort: port,
    targetPort,
    allowedOrigins: ['https://ops.example:8443'],
  });
  const self = `127.0.0.1:${port}`;
  const forwarded = (r) => r.status === 200 && r.body === 'reached-upstream';
  const refused = (r) => r.status === 403;

  // Safe methods are never gated, even from a hostile Origin.
  ok(forwarded(await request({ port, method: 'GET', headers: { host: self, origin: 'https://evil.example' } })),
    'a GET with a foreign Origin is forwarded (safe method, not gated)');

  // DNS rebinding: the browser still sends the attacker's name — or the wrong port — as Host.
  ok(refused(await request({ port, method: 'POST', headers: { host: 'attacker.example' }, body: 'p' })),
    'a POST with a foreign Host is refused (DNS-rebinding check)');
  ok(refused(await request({ port, method: 'POST', headers: { host: '127.0.0.1:1' }, body: 'p' })),
    'a POST with the right IP but the wrong port is refused');

  // CSRF: a cross-site page reaches loopback but its Origin is its own.
  ok(refused(await request({ port, method: 'POST', headers: { host: self, origin: 'https://evil.example' }, body: 'p' })),
    'a POST with a foreign Origin is refused (CSRF check)');
  ok(refused(await request({ port, method: 'POST', headers: { host: self, origin: 'null' }, body: 'p' })),
    'a POST with Origin: null is refused (sandboxed iframe)');

  // The legitimate dashboard call: same-origin, so Host and Origin are both this proxy.
  ok(forwarded(await request({ port, method: 'POST', headers: { host: self, origin: `http://${self}` }, body: 'p' })),
    'a same-origin POST is forwarded');

  // A non-browser client (curl, the CLI) sends a valid Host and no Origin — not a CSRF vector.
  ok(forwarded(await request({ port, method: 'POST', headers: { host: self }, body: 'p' })),
    'a POST with a valid Host and no Origin is forwarded');
  ok(forwarded(await request({ port, method: 'DELETE', headers: { host: `localhost:${port}` } })),
    'a DELETE with the localhost name is forwarded');

  // The operator-configured extra origin is honoured for both Host and Origin.
  ok(forwarded(await request({ port, method: 'POST', headers: { host: 'ops.example:8443', origin: 'https://ops.example:8443' }, body: 'p' })),
    'a POST from a configured extra origin is forwarded');

  // The absent-Host path — which Node's client will not produce, since it always fills Host in — is
  // checked directly against the gate's own function, so the fail-closed branch is not left untested.
  ok(mutationDenialReason({}, allowedHostsFor(port)) !== null, 'a mutating request with no Host is refused (unit)');

  proxy.close();
  upstream.close();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
