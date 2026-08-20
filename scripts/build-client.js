// Builds the client, so `npm run build` at the repo root produces a `client/dist` the combined
// service (server/app.js) can serve standalone.
//
// This used to bake the server's admin bearer token into the bundle via VITE_WINDROW_API_TOKEN,
// and must not any more. The API authenticates callers with per-node mTLS client certificates
// (docs/design/per-node-enrollment-credentials.md), so identity rides the TLS handshake rather than
// a header the bundle carries. That also closes something the old build never really justified:
// compiling a fleet-wide admin credential into shipped JavaScript meant anyone who could read the
// bundle held it. The browser presents its own certificate instead, and this script needs no secret
// at all — which is why it no longer fails when one is missing.
const path = require('path');
const { spawnSync } = require('child_process');

const result = spawnSync('npm', ['run', 'build'], {
  cwd: path.join(__dirname, '..', 'client'),
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
