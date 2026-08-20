#!/usr/bin/env node
// Throwaway server instance for exercising schema and hook changes without touching the live
// :4000 service the whole field depends on.
//
// `npm run oobe:dev` already gives you a sandbox, but a *fresh, empty* one — right for testing
// onboarding, useless for testing a migration or a hook change, which need real rows to run
// against. This boots the same server on an alternate port over a **copy of the live database**:
//
//   PORT                 -> 4099                            (the live service keeps :4000)
//   WINDROW_DB_PATH      -> .sandbox/data/windrow.db         (a copy, made fresh on each boot)
//   WINDROW_API_BASE     -> http://127.0.0.1:4099/api        (so hooks/CLIs under it hit the copy)
//   WINDROW_USER_HOME    -> .sandbox/home                    (fake ~/.claude, ~/.gemini, ...)
//   WINDROW_SANDBOX      -> 1                                (see server/index.js)
//
// That last one matters more than it looks. The server's two background writers reach *outside*
// the database: cacheWarmer.js rewrites server/data/hook-*-cache.json, which the live hooks read
// on every tool call, and hookWatcher.js restores PreToolUse/PostToolUse entries into the real
// ~/.claude/settings.json. A sandbox that ran either would quietly reach back into the live
// deployment from a copy of its data — so server/index.js skips both when WINDROW_SANDBOX is set.
//
// Usage:
//   node scripts/sandbox.js            # copy the live db, boot the sandbox server on :4099
//   node scripts/sandbox.js --keep     # boot against the EXISTING copy (don't re-copy)
//   node scripts/sandbox.js --port N   # some other port
//   node scripts/sandbox.js --env      # just print the env vars to point a shell at it, then exit
//
// Or via npm: npm run sandbox / npm run sandbox:keep / npm run sandbox:env
//
// To drive it from a worktree — hooks, scripts/upgrade.js, curl, anything reading
// WINDROW_API_BASE — run `npm run sandbox:env` and export what it prints. Nothing here writes
// to server/data or to the live db, so a `git worktree` checkout can run its own :4099 against a
// snapshot of production data while the field keeps using :4000.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { envCompat } = require('../server/config');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const SANDBOX_DIR = path.join(REPO_ROOT, '.sandbox');
const SANDBOX_DATA = path.join(SANDBOX_DIR, 'data');
const SANDBOX_HOME = path.join(SANDBOX_DIR, 'home');
const SANDBOX_DB = path.join(SANDBOX_DATA, 'windrow.db');

// The db this instance is a copy OF. Honours WINDROW_DB_PATH so that if the live service was
// itself pointed somewhere non-default, the sandbox copies *that* rather than a stale default.
// The GOVERNANCE_DB_PATH spelling is gone (tier 4) and now throws rather than being ignored.
// The fallback resolves the pre-rename `governance.db` when it is still what is on disk: the
// file only moves when the live service next boots (tier 2, server/store.js), and until that
// elevated restart happens a sandbox that insisted on the new name would find nothing to copy.
const LIVE_DB = envCompat('DB_PATH', {
  fallback: (() => {
    const renamed = path.join(SERVER_DIR, 'data', 'windrow.db');
    const legacy = path.join(SERVER_DIR, 'data', 'governance.db');
    return !fs.existsSync(renamed) && fs.existsSync(legacy) ? legacy : renamed;
  })(),
});

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const flagValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const PORT = flagValue('port') || process.env.SANDBOX_PORT || '4099';
const API_BASE = `http://127.0.0.1:${PORT}/api`;

function sandboxEnv() {
  return {
    ...process.env,
    PORT,
    WINDROW_DB_PATH: SANDBOX_DB,
    WINDROW_API_BASE: API_BASE,
    WINDROW_USER_HOME: SANDBOX_HOME,
    WINDROW_SANDBOX: '1',
  };
}

function printEnv() {
  const vars = {
    PORT,
    WINDROW_DB_PATH: SANDBOX_DB,
    WINDROW_API_BASE: API_BASE,
    WINDROW_USER_HOME: SANDBOX_HOME,
    WINDROW_SANDBOX: '1',
  };
  console.log('# PowerShell');
  for (const [k, v] of Object.entries(vars)) console.log(`$env:${k} = "${v}"`);
  console.log('\n# bash');
  for (const [k, v] of Object.entries(vars)) console.log(`export ${k}="${v}"`);
}

function portInUse(port) {
  // Same netstat probe scripts/start.js uses — a plain "already listening" check, no killing:
  // whatever holds this port isn't ours to stop.
  let out;
  try {
    out = execSync('netstat -ano', { encoding: 'utf8' });
  } catch {
    return false;
  }
  return new RegExp(`^\s*TCP\s+\S*:${port}\s+\S+\s+LISTENING\s+\d+\s*$`, 'im').test(out);
}

// A live database is in WAL mode, so `windrow.db` on its own is NOT the current state — the
// most recent commits are still sitting in `windrow.db-wal`. Copying the one file with
// fs.copyFileSync gives you a snapshot that silently predates them (and copying all three by hand
// while the server is mid-checkpoint can give you a torn one). SQLite's own online-backup API
// takes a consistent snapshot of a database that's being written to, which is exactly this case.
async function copyLiveDb() {
  if (!fs.existsSync(LIVE_DB)) {
    console.error(`No database to copy at ${LIVE_DB}.`);
    console.error('Start the real service once (npm start) so it gets created, or set WINDROW_DB_PATH.');
    process.exit(1);
  }
  let Database;
  try {
    Database = require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  } catch {
    console.error('server/node_modules/better-sqlite3 not found — run `npm run install:all` first.');
    process.exit(1);
  }
  fs.rmSync(SANDBOX_DATA, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_DATA, { recursive: true });
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });

  const src = new Database(LIVE_DB, { readonly: true });
  try {
    await src.backup(SANDBOX_DB);
  } finally {
    src.close();
  }
  const mb = (fs.statSync(SANDBOX_DB).size / 1024 / 1024).toFixed(1);
  console.log(`Copied ${LIVE_DB}\n     -> ${SANDBOX_DB} (${mb} MB)`);
}

function boot() {
  console.log(`\nStarting sandbox server on ${API_BASE}`);
  console.log('  - writes only to .sandbox/ and this copy; the live :4000 service is untouched');
  console.log('  - cache warmer and hook watcher are OFF (WINDROW_SANDBOX=1)');
  console.log(`  - point other processes at it: npm run sandbox:env\n`);

  const child = spawn('node', [path.join(SERVER_DIR, 'index.js')], {
    cwd: REPO_ROOT,
    env: sandboxEnv(),
    stdio: 'inherit',
    shell: true,
  });
  const shutdown = () => child.kill();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  if (hasFlag('env')) {
    printEnv();
    return;
  }
  if (portInUse(PORT)) {
    console.error(`Port ${PORT} is already in use — another sandbox is probably still running.`);
    console.error(`Stop it, or pick another port: node scripts/sandbox.js --port 4098`);
    process.exit(1);
  }
  if (hasFlag('keep')) {
    if (!fs.existsSync(SANDBOX_DB)) {
      console.error(`No existing sandbox db at ${SANDBOX_DB} — run \`npm run sandbox\` first to make one.`);
      process.exit(1);
    }
    console.log(`Reusing the existing sandbox db at ${SANDBOX_DB} (--keep: not re-copied).`);
  } else {
    await copyLiveDb();
  }
  boot();
}

main();
