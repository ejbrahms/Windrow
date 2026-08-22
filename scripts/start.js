// One-click startup: builds the client if needed and starts the combined backend+frontend
// service behind the request-parking supervisor (server/supervisor.js) on PORT (default 4000). If something is already listening on that
// port, prompts before killing it and restarting — so a stale/crashed instance from a previous
// run doesn't silently block this one, but a *live* instance doesn't get killed by accident either.
//
// Run with `npm start` (root) or double-click start.bat.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 4000;

function findListeningPid(port) {
  // `netstat -ano` lines look like:
  //   TCP    0.0.0.0:4000    0.0.0.0:0    LISTENING    12345
  let out;
  try {
    out = execSync('netstat -ano', { encoding: 'utf8' });
  } catch (err) {
    console.warn(`Could not run netstat (${err.message}); skipping running-process check.`);
    return null;
  }
  const re = new RegExp(`^\\s*TCP\\s+\\S*:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'im');
  const match = out.match(re);
  return match ? match[1] : null;
}

function describePid(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim();
    // "node.exe","12345","Console","1","45,000 K"
    const name = out.split(',')[0]?.replace(/"/g, '');
    return name || 'unknown process';
  } catch {
    return 'unknown process';
  }
}

function killPid(pid) {
  console.log(`Stopping PID ${pid}...`);
  const result = spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Failed to stop PID ${pid} (exit ${result.status}). Aborting.`);
    process.exit(1);
  }
}

function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function ensureDepsInstalled(label, cwd) {
  if (fs.existsSync(path.join(cwd, 'node_modules'))) return;
  console.log(`${label}/node_modules not found — running npm install...`);
  const result = spawnSync('npm', ['install'], { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`npm install failed in ${label}. Aborting startup.`);
    process.exit(1);
  }
}

function ensureApiToken() {
  // build-client.js bakes server/data/api-token into the built client JS, so it must exist
  // before the build runs. Requiring server/auth.js generates it (and the agent token) as a
  // side effect if it isn't there yet — the same thing that happens on first `npm start`.
  const tokenPath = path.join(ROOT, 'server', 'data', 'api-token');
  if (fs.existsSync(tokenPath)) return;
  console.log('server/data/api-token not found — generating it...');
  const result = spawnSync('node', ['-e', "require('./server/auth.js')"], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0 || !fs.existsSync(tokenPath)) {
    console.error('Could not generate server/data/api-token. Aborting startup.');
    process.exit(1);
  }
}

function ensurePrereqs() {
  ensureDepsInstalled('server', path.join(ROOT, 'server'));
  ensureDepsInstalled('client', path.join(ROOT, 'client'));
  ensureApiToken();
}

function ensureClientBuilt() {
  const distIndex = path.join(ROOT, 'client', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) return;
  console.log('client/dist not found — building client...');
  ensurePrereqs();
  const result = spawnSync('node', [path.join(ROOT, 'scripts', 'build-client.js')], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.error('Client build failed. Aborting startup.');
    process.exit(1);
  }
}

/**
 * Say where the dashboard actually is, which is not the port this script binds.
 *
 * PORT carries the **plaintext** listener, and server/auth.js grants exactly one scope there:
 * `agent`, by bearer token, for hooks. A browser holds no such token, so the SPA shell loads from
 * this port and then every `/api/*` call it makes comes back
 * `401 unauthorized: missing or invalid agent token` — a dashboard that renders its own chrome and
 * no data. Printing this URL on its own was the whole of that bug report: nothing here is broken,
 * it is simply not the address the dashboard can be used at.
 *
 * The dashboard authenticates by client certificate on the mTLS listener
 * (docs/design/per-node-enrollment-credentials.md). In development the Vite proxy presents that
 * certificate on the browser's behalf, which is what makes :5173 the working address; a production
 * browser needs the certificate in its own OS store, and that step has not landed yet — the same
 * document's "Not yet landed" section is the current status.
 */
function reportDashboardUrl() {
  const credentialDir = process.env.WINDROW_CREDENTIAL_DIR
    || path.join(ROOT, 'server', 'data', 'credentials');
  const hasDevCredential = fs.existsSync(path.join(credentialDir, 'dev-cert.pem'));
  console.log('');
  console.log(`  API and hooks   http://localhost:${PORT}  (agent scope, bearer token, hooks only)`);
  console.log(`  Dashboard       http://localhost:5173      — run \`npm run dev:client\``);
  if (hasDevCredential) {
    console.log('                  The dev proxy presents the credential in');
    console.log(`                  ${credentialDir} for you.`);
  } else {
    console.log('                  First enroll the credential the dev proxy presents:');
    console.log('                    node scripts/enroll.js --url https://localhost:4443 \\');
    console.log('                      --token <t> --name dev --ca server/data/ca/ca-cert.pem');
    console.log('                  With no credential there, every /api call through the proxy 401s.');
  }
  console.log('');
  console.log(`  Opening http://localhost:${PORT} in a browser loads the dashboard shell but no data:`);
  console.log('  that listener only honours the hook token, which a browser does not hold.');
  console.log('');
}

function startServer() {
  ensureClientBuilt();
  console.log(`Starting server on http://localhost:${PORT} ...`);
  reportDashboardUrl();
  // The supervisor, not server/index.js — it binds PORT itself and runs the backend as a child on a
  // private upstream port, so a backend restart parks requests instead of refusing them
  // (server/supervisor.js, docs/design/upgrade-resilience.md §3.4). Once it is up, restarting the
  // backend no longer means stopping this process: `npm run restart` bounces the child while the
  // port stays bound.
  const child = spawn('node', [path.join(ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const pid = findListeningPid(PORT);
  if (pid) {
    const proc = describePid(pid);
    const kill = await askYesNo(
      `Something (${proc}, PID ${pid}) is already listening on port ${PORT}. ` +
        `Kill it and restart? [y/N] `
    );
    if (!kill) {
      console.log('Leaving the existing process running. Nothing started.');
      process.exit(0);
    }
    killPid(pid);
  }
  startServer();
}

main();
