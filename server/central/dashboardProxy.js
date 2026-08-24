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

const http = require('http');

/**
 * Start the browser-facing reverse proxy.
 *
 * @param {object} opts
 * @param {number} opts.listenPort  the port to accept browser connections on
 * @param {number} opts.targetPort  the plaintext loopback listener to forward to (PLAIN_PORT)
 * @param {string} [opts.listenHost]  bind address; defaults to 0.0.0.0 so a Docker-published port
 *                                     can reach it. See the header on why wide-bind is not wide-open.
 * @param {string} [opts.targetHost]  where the plaintext listener lives; always loopback.
 * @returns {Promise<import('http').Server|false>}  the server if it came up, false if the listen
 *          failed (a port already in use) — the caller decides whether that is fatal.
 */
function startDashboardProxy({ listenPort, targetPort, listenHost = '0.0.0.0', targetHost = '127.0.0.1' }) {
  const server = http.createServer((clientReq, clientRes) => {
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

module.exports = { startDashboardProxy };
