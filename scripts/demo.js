#!/usr/bin/env node
'use strict';

// `npm run demo` — see the dashboard in a browser without Docker, without touching your live install.
//
// The dashboard is a Vite SPA that reads the governance API over a mutual-TLS proxy
// (client/vite.config.ts). That is three things a casual "just let me look at it" does not have:
// a running node, a client certificate the browser's proxy can present, and seed data worth
// looking at. This script stands all three up against a THROWAWAY node and opens the page:
//
//   1. an isolated data dir (.demo/) so nothing here reads or writes the live server/data/ —
//      its own SQLite db, its own CA, its own credentials, its own bootstrap token;
//   2. `server/seed.js` populates that db with the starter capability/principal/grant dataset;
//   3. `server/index.js` boots on demo-only ports (plaintext :4400 loopback, mTLS :4543) with
//      WINDROW_SANDBOX=1, so none of the central-facing shippers/watchers run;
//   4. we spend the first-run bootstrap enrollment token to mint a `dev` credential into
//      .demo/data/credentials — the exact files client/vite.config.ts presents on the browser's
//      behalf, only pointed at the demo dir and the demo port;
//   5. `vite` serves the SPA on :5173 and proxies /api to the demo node;
//   6. the browser opens on the SPA.
//
// Everything is scoped by env vars the config layer already honours (WINDROW_DATA_DIR relocates the
// db, CA, credentials and bootstrap token in one move — server/config.js). WINDROW_NO_ENV_FILE=1 is
// deliberate: a real install's windrow.env may point at central and set WINDROW_POLICY_AUTHORITY,
// which would make the seed a read-only-store error and the node a replica of somebody else's fleet.
// The demo is always a standalone, node-authoritative install.
//
// Ctrl-C tears both children down. The .demo/ dir is left on disk (gitignored) and re-seeded fresh
// on the next run; pass --keep to reuse the existing db instead of re-seeding.
//
// THE THREE DEMO SCRIPTS, AND WHICH IS WHICH — they share a word, not a purpose:
//   scripts/demo.js        this file — a THROWAWAY LOCAL NODE + Vite, SQLite, no Postgres, no
//                          Docker. What to run to look at the dashboard on your own machine.
//   scripts/demo-local.js  the PUBLIC read-only demo's serverless entry (api/index.js) run
//                          locally in front of a Postgres, to check it before deploying.
//   scripts/seed-demo.js   provisions and seeds the Supabase database that public demo reads.
// The last two are the Vercel deployment (docs/design/vercel-supabase-demo.md); this one is not.
//

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DEMO_DIR = path.join(REPO_ROOT, '.demo');
const DATA_DIR = path.join(DEMO_DIR, 'data');
const HOME_DIR = path.join(DEMO_DIR, 'home');
const CRED_DIR = path.join(DATA_DIR, 'credentials');
const BOOTSTRAP_TOKEN_PATH = path.join(DATA_DIR, 'bootstrap-enrollment-token');

const HTTP_PORT = process.env.WINDROW_DEMO_PORT || '4400'; // plaintext loopback: enroll + /api/ready
const TLS_PORT = process.env.WINDROW_DEMO_TLS_PORT || '4543'; // mTLS: what the vite proxy dials
const VITE_PORT = process.env.WINDROW_DEMO_VITE_PORT || '5173';
const KEEP = process.argv.includes('--keep');

// The whole point is isolation from server/data/. Set these BEFORE anything requires ../server/*,
// because server/config.js reads them at module-load time.
const demoEnv = {
  ...process.env,
  WINDROW_DATA_DIR: DATA_DIR,
  WINDROW_USER_HOME: HOME_DIR,
  WINDROW_SANDBOX: '1',
  // NO_ENV_FILE=1 skips READING a real install's windrow.env (which may set central authority and
  // turn the seed into a read-only-store error). WINDROW_ENV_FILE isolates the WRITE side too: the
  // node mints an id on first boot and records it via store.adoptNodeId, which writes to ENV_FILE —
  // point that at the demo dir so it never clobbers the live node's WINDROW_NODE_ID.
  WINDROW_NO_ENV_FILE: '1',
  WINDROW_ENV_FILE: path.join(DEMO_DIR, 'windrow.env'),
  PORT: HTTP_PORT,
  WINDROW_TLS_PORT: TLS_PORT,
};
Object.assign(process.env, demoEnv);

const children = [];
let shuttingDown = false;

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

/** Poll the plaintext /api/ready until the freshly booted node answers, or give up. */
function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(HTTP_PORT), path: '/api/ready', method: 'GET', timeout: 2000 },
        (res) => {
          res.resume();
          // Any HTTP answer means the listener is up. /api/ready is public on the node, but even a
          // 401/503 proves the process is serving, which is all we need before enrolling.
          if (res.statusCode && res.statusCode < 500) return resolve();
          retry();
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', retry);
      req.end();
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`node did not answer /api/ready on :${HTTP_PORT} within ${timeoutMs} ms`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** Mint the `dev` credential the vite proxy presents, by spending the first-run bootstrap token. */
async function enrollDevCredential() {
  // Required lazily and only after WINDROW_DATA_DIR is set, so its DEFAULT_DIR resolves under .demo/.
  // eslint-disable-next-line global-require
  const { enroll } = require('../server/enrollment/client');
  if (!fs.existsSync(BOOTSTRAP_TOKEN_PATH)) {
    throw new Error(
      `no bootstrap enrollment token at ${BOOTSTRAP_TOKEN_PATH} — the node writes one on first boot ` +
      'when no admin is enrolled. Delete .demo/ and re-run to force a fresh bootstrap.'
    );
  }
  const enrollmentToken = fs.readFileSync(BOOTSTRAP_TOKEN_PATH, 'utf8').trim();
  await enroll({
    name: 'dev',
    baseUrl: `http://127.0.0.1:${HTTP_PORT}`,
    enrollmentToken,
    label: 'demo dashboard',
    dir: CRED_DIR,
    force: true,
  });
  say(`Enrolled a demo "dev" credential into ${CRED_DIR}.`);
}

function openBrowser(url) {
  // Best-effort: a demo that could not pop a browser is still a demo whose URL we printed.
  try {
    if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    /* URL is printed below regardless */
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  process.exit(code);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });

  // 1. Seed the isolated db. Fresh each run unless --keep, so the demo always looks the same.
  const dbPath = path.join(DATA_DIR, 'windrow.db');
  if (KEEP && fs.existsSync(dbPath)) {
    say(`Reusing the existing demo db at ${dbPath} (--keep).`);
  } else {
    say('Seeding a throwaway demo node …');
    const seed = spawnSync('node', [path.join(REPO_ROOT, 'server', 'seed.js')], {
      cwd: REPO_ROOT,
      env: demoEnv,
      stdio: 'inherit',
    });
    if (seed.status !== 0) throw new Error('seeding failed — see the output above');
  }

  // 2. Boot the demo node (both listeners; sandbox mode = no central-facing workers).
  say(`Starting the demo node (http://127.0.0.1:${HTTP_PORT}, https://localhost:${TLS_PORT}) …`);
  const server = spawn('node', [path.join(REPO_ROOT, 'server', 'index.js')], {
    cwd: REPO_ROOT,
    env: demoEnv,
    stdio: 'inherit',
  });
  children.push(server);
  server.on('exit', (c) => { if (!shuttingDown) { say(`Demo node exited (${c}).`); shutdown(c ?? 1); } });

  await waitForReady();

  // 3. Mint the credential the browser's proxy will present.
  await enrollDevCredential();

  // 4. Serve the SPA and proxy /api to the demo node's mTLS listener with the demo credential.
  say(`Starting the dashboard (vite) on http://localhost:${VITE_PORT} …`);
  const vite = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--port', VITE_PORT, '--strictPort'],
    {
      cwd: path.join(REPO_ROOT, 'client'),
      env: {
        ...demoEnv,
        WINDROW_DEV_PROXY_TARGET: `https://localhost:${TLS_PORT}`,
        WINDROW_CREDENTIAL_DIR: CRED_DIR,
      },
      stdio: 'inherit',
    }
  );
  children.push(vite);
  vite.on('exit', (c) => { if (!shuttingDown) { say(`Vite exited (${c}).`); shutdown(c ?? 1); } });

  const url = `http://localhost:${VITE_PORT}`;
  // Vite needs a moment to bind before the page will load; the open is best-effort anyway.
  setTimeout(() => {
    say(`\n  Dashboard: ${url}\n  (Ctrl-C to stop the demo node and vite.)\n`);
    openBrowser(url);
  }, 1500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`\ndemo failed: ${err.message}`);
  shutdown(1);
});
