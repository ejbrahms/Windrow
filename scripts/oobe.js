#!/usr/bin/env node
// Local dev workflow for exercising the OOBE (onboarding wizard) flow without touching real data.
//
// The wizard's steps aren't just UI — Providers installs real hook config, Sources/Discovery scan
// and register real skill directories (client/src/components/onboarding/*Step.tsx). Testing it
// against your actual machine would install hooks into your real ~/.claude/settings.json and seed
// your real catalog. Instead this points a whole dev session at a throwaway sandbox using the env
// vars server/config.js already supports for exactly this ("a real deployment" override):
//   WINDROW_DB_PATH      -> .oobe-sandbox/data/windrow.db      (fresh, empty, unseeded)
//   WINDROW_USER_HOME    -> .oobe-sandbox/home                 (fake ~/.claude, ~/.gemini, ...)
// Both default to the real paths when unset, so nothing here changes normal `npm run dev`.
//
// Usage:
//   node scripts/oobe.js reset    # wipe the sandbox back to a clean, never-onboarded state
//   node scripts/oobe.js dev      # reset, then start server + client against the sandbox
//   node scripts/oobe.js resume   # start against the sandbox WITHOUT resetting first
//
// Or via npm: npm run oobe:reset / npm run oobe:dev / npm run oobe:resume
//
// The wizard's own "have I been onboarded" flag lives client-side (localStorage, see
// client/src/hooks/useOnboarding.tsx) and can't be reset from Node. Open the client with
// `?resetOnboarding=1` (dev/dev:oobe prints the full URL) or use a private window to see it fresh.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SANDBOX_DIR = path.join(REPO_ROOT, ".oobe-sandbox");
const SANDBOX_HOME = path.join(SANDBOX_DIR, "home");
const SANDBOX_DATA = path.join(SANDBOX_DIR, "data");
const SANDBOX_DB = path.join(SANDBOX_DATA, "windrow.db");

const CLIENT_URL = "http://localhost:5173/?resetOnboarding=1";

const SAMPLE_SKILL = `---
name: sandbox-sample
description: Sample skill seeded into the OOBE sandbox so the wizard's discovery step has something to find.
---

This file only exists under .oobe-sandbox/ — it's here so "Run discovery" during onboarding
testing finds at least one real SKILL.md. Edit or delete it freely; \`npm run oobe:reset\` restores
this sandbox to exactly this state.
`;

function reset() {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_DATA, { recursive: true });
  const skillDir = path.join(SANDBOX_HOME, ".claude", "skills", "sandbox-sample");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), SAMPLE_SKILL);

  console.log(`OOBE sandbox reset: ${SANDBOX_DIR}`);
  console.log("  - fresh, empty windrow.db (no seed data, no providers, no sources)");
  console.log('  - sandbox "home" dir with one sample skill for the discovery step to find');
  console.log("  - your real ~/.claude, ~/.gemini, and repo skill dirs are untouched");
}

function sandboxEnv() {
  return {
    ...process.env,
    WINDROW_DB_PATH: SANDBOX_DB,
    WINDROW_USER_HOME: SANDBOX_HOME,
  };
}

function run(cmd, args, env) {
  // shell: true so this works with npm.cmd on Windows without hardcoding an extension.
  return spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: "inherit", shell: true });
}

function dev({ doReset }) {
  if (doReset || !fs.existsSync(SANDBOX_DIR)) reset();

  console.log("\nStarting server + client against the OOBE sandbox.");
  console.log(
    "The wizard's \"already onboarded\" flag lives in browser localStorage, not the server —",
  );
  console.log(`open ${CLIENT_URL} (or a private window) to see the wizard from a clean start.\n`);

  const env = sandboxEnv();
  const server = run("npm", ["run", "dev", "--prefix", "server"], env);
  const client = run("npm", ["run", "dev", "--prefix", "client"], env);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.kill();
    client.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("exit", shutdown);
  client.on("exit", shutdown);
}

const cmd = process.argv[2] || "dev";
switch (cmd) {
  case "reset":
    reset();
    break;
  case "dev":
    dev({ doReset: true });
    break;
  case "resume":
    dev({ doReset: false });
    break;
  default:
    console.error(`Unknown command "${cmd}". Use: reset | dev | resume`);
    process.exit(1);
}
