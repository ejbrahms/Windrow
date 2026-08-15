// One-click startup: builds the client if needed and starts the combined backend+frontend
// service (server/index.js) on PORT (default 4000). If something is already listening on that
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

function startServer() {
  ensureClientBuilt();
  console.log(`Starting server on http://localhost:${PORT} ...`);
  const child = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
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
