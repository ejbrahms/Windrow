'use strict';

// The browser's door into central.
//
// THE PROBLEM THIS EXISTS TO SOLVE. central serves the dashboard (central/routes.js, item 4 of
// docs/design/dashboard-placement.md) but only off the same listeners the API is on, and both of
// those turn a browser away:
//   - The mTLS listener (:5443) demands a client certificate. Chrome will only present one that has
//     been imported into the OS certificate store, and nothing in this system exports a PKCS#12
//     bundle — so a plain browser load gets a TLS alert, not the shell.
//   - The plaintext listener (:5000) grants full admin, but ONLY to a loopback source
//     (routes.js isLoopback). Publishing it with a compose `ports:` entry does not help: Docker's
//     userland proxy rewrites the source address to the bridge gateway, so the request arrives
//     looking non-loopback and every /api call 401s. That is why publishing 5000 was never an
//     option and why an operator ends up hand-running an external cert-presenting proxy — the
//     flaky moving part this module replaces.
//
// WHAT IT DOES. A dead-simple reverse proxy that forwards EVERYTHING — dashboard and /api alike —
// to the plaintext loopback listener at 127.0.0.1:PLAIN_PORT. Because that hop is a real connection
// to 127.0.0.1 from inside this container, routes.js's isLoopback sees loopback and grants the
// `insecure-loopback` scope, so the browser needs no certificate of its own. The dashboard's static
// files come back over the same hop, since that listener already serves them.
//
// docs/design/dashboard-placement.md §"Two things this buys" sanctions exactly this: "central's
// container can terminate TLS however it likes without touching the node's enforcement path." The
// node's :4000/:4443 are untouched; this is a front door on central only.
//
// THE SECURITY BOUNDARY IS THE PORT BINDING, and it has to be stated plainly because there is no
// second check behind it: anything that can reach this proxy gets full admin, exactly as the
// operator's external proxy did. So the container publishes it to the host's 127.0.0.1 only
// (docker-compose.yml), which on a single-operator host means the operator and no one else. It is
// bound to 0.0.0.0 INSIDE the container because Docker's published port forwards to the container's
// bridge interface, not its loopback — the bind is wide, the exposure is not. A header cannot widen
// it either: isLoopback reads the kernel socket address, never X-Forwarded-For, so a forwarded
// request cannot forge a loopback origin and reach admin through this hop.
//
// THE ONE THING THE PORT BINDING DOES NOT COVER IS THE OPERATOR'S OWN BROWSER. The proxy is on the
// host's 127.0.0.1, and so is every browser tab the operator has open. A page on any other site can
// therefore aim a request at http://127.0.0.1:5599/api/… and it leaves from a reachable source, so
// the socket boundary waves it through and it lands on full admin — a textbook CSRF, and DNS
// rebinding is the same hole reached a second way (attacker.example re-resolves to 127.0.0.1, the
// browser keeps sending Host: attacker.example). There is no auth to lean on, so the defence is an
// ORIGIN/HOST ALLOWLIST on the state-changing methods: a mutating request must carry a Host header
// this proxy answers to, and if it carries an Origin that Origin must be one too. A cross-site page
// cannot forge either — the browser sets both, and sets them to itself — so its POST is refused 403
// before it is forwarded. Safe methods (GET/HEAD/OPTIONS) are left alone: they read, and a
// cross-site read of an opaque admin response is not the exposure the mutating routes are.

const http = require('http');

// Requests that only read. A cross-site page can trigger these but cannot see the response (it is
// opaque to it), so they are not the CSRF surface — only the state-changing methods below are.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reduce an Origin, a Host header or a bare host:port to the `host:port` (or bare `host`) form the
 * allowlist stores, lowercased. Returns null for anything unparseable — which the caller treats as
 * "not allowed", so a malformed header fails closed rather than slipping through.
 */
function normalizeHostPort(value) {
  if (value === undefined || value === null) return null;
  let v = String(value).trim().toLowerCase();
  if (v === '' || v === 'null') return null; // Origin: null (sandboxed iframe, file://) is not us.
  if (v.includes('://')) {
    try {
      return new URL(v).host || null; // .host keeps the port and brackets IPv6 for us.
    } catch {
      return null;
    }
  }
  return v.split('/')[0] || null; // a Host header is already host[:port]; drop any stray path.
}

/**
 * The set of `host:port` strings a mutating request may claim. Always includes the loopback names an
 * operator reaches this proxy by on its own port; `extraOrigins` adds any others (e.g. an SSH-tunnel
 * hostname), given as origins or bare host:port and normalised the same way as the request headers.
 */
function buildAllowedHosts(listenPort, extraOrigins = []) {
  const hosts = new Set();
  for (const name of ['localhost', '127.0.0.1', '[::1]']) hosts.add(`${name}:${listenPort}`);
  for (const extra of extraOrigins) {
    const normalized = normalizeHostPort(extra);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

/**
 * Why a mutating request must be refused, or null if it is allowed. The Host header must be one this
 * proxy answers to (the DNS-rebinding check); and if an Origin is present it must be one too (the
 * CSRF check — a same-origin call sends its own Origin, a cross-site one sends the attacker's). An
 * absent Origin is left to the Host check alone: a non-browser client (curl, the CLI) sends no
 * Origin and is not a CSRF vector, while a browser always attaches one to a cross-site POST.
 */
function mutationDenialReason(headers, allowedHosts) {
  const host = normalizeHostPort(headers.host);
  if (!host || !allowedHosts.has(host)) {
    return `Host header ${headers.host || '(absent)'} is not an allowed dashboard origin`;
  }
  if (headers.origin) {
    const origin = normalizeHostPort(headers.origin);
    if (!origin || !allowedHosts.has(origin)) {
      return `Origin ${headers.origin} is not an allowed dashboard origin`;
    }
  }
  return null;
}

/**
 * Start the browser-facing reverse proxy.
 *
 * @param {object} opts
 * @param {number} opts.listenPort  the port to accept browser connections on
 * @param {number} opts.targetPort  the plaintext loopback listener to forward to (PLAIN_PORT)
 * @param {string} [opts.listenHost]  bind address; defaults to 0.0.0.0 so a Docker-published port
 *                                     can reach it. See the header on why wide-bind is not wide-open.
 * @param {string} [opts.targetHost]  where the plaintext listener lives; always loopback.
 * @param {string[]} [opts.allowedOrigins]  extra origins/host:port a mutating request may claim,
 *          on top of the loopback names on `listenPort`. See buildAllowedHosts.
 * @returns {Promise<import('http').Server|false>}  the server if it came up, false if the listen
 *          failed (a port already in use) — the caller decides whether that is fatal.
 */
function startDashboardProxy({ listenPort, targetPort, listenHost = '0.0.0.0', targetHost = '127.0.0.1', allowedOrigins = [] }) {
  const allowedHosts = buildAllowedHosts(listenPort, allowedOrigins);

  const server = http.createServer((clientReq, clientRes) => {
    // The CSRF/DNS-rebinding gate: a state-changing request from the operator's browser must prove,
    // by headers only the browser sets, that it came from this proxy's own origin. Read methods skip
    // it (see SAFE_METHODS). A refusal drains the body so the socket is not left half-read.
    if (!SAFE_METHODS.has((clientReq.method || 'GET').toUpperCase())) {
      const denial = mutationDenialReason(clientReq.headers, allowedHosts);
      if (denial) {
        clientRes.writeHead(403, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'forbidden', detail: denial }));
        clientReq.resume();
        return;
      }
    }

    // Forward method, path and headers verbatim. The plaintext listener authorises on the socket
    // being loopback, not on anything in here, so there is nothing to sanitise for privilege — the
    // only header worth overriding is Host, set to the upstream so the app sees a coherent origin.
    const upstream = http.request(
      {
        host: targetHost,
        port: targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: `${targetHost}:${targetPort}` },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    // The upstream is the plaintext listener in this same process; the case that reaches here is it
    // not being up (ALLOW_INSECURE off) or a mid-request reset. A 502 that names the cause beats a
    // hung socket the browser eventually times out on.
    upstream.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
      }
      clientRes.end(JSON.stringify({
        error: 'the central dashboard proxy could not reach the backend',
        detail: `no plaintext listener at ${targetHost}:${targetPort} (${err.code || err.message}). `
          + 'It requires WINDROW_CENTRAL_ALLOW_INSECURE=1, which the container sets.',
      }));
    });

    clientReq.pipe(upstream);
    // A browser that hangs up mid-request must not leave the upstream request dangling.
    clientReq.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.once('error', (err) => {
      console.error(`[central] could not start the dashboard proxy on port ${listenPort}: ${err.message}`);
      resolve(false);
    });
    server.listen(listenPort, listenHost, () => resolve(server));
  });
}

module.exports = { startDashboardProxy, buildAllowedHosts, mutationDenialReason, normalizeHostPort };
