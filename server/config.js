// Central configuration for paths the governance server reads from or writes into on disk.
// Two concerns live here:
//   - discoveryPaths: real filesystem roots scanned for SKILL.md files (server/discovery/scan.js).
//   - hookInstallPaths: where each backend's own hook wiring config lives, i.e. the file
//     `deploy-capability-governance-server` writes PreToolUse/PostToolUse entries into.
// Both are overridable via env var for a real deployment (see
// docs/design/deployment-boundary-decision.md); defaults are pre-populated with the paths this
// workspace already uses, so an unconfigured server behaves exactly as it does today.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Fill in configuration from `windrow.env` before anything below reads process.env.
//
// This is the FIRST thing that happens in the first module every entry point requires, and it has
// to be, because the values it carries — WINDROW_CENTRAL_URL, WINDROW_POLICY_AUTHORITY,
// WINDROW_CENTRAL_DB_URL — decide what kind of host this process is. Anything that read them
// earlier would read them wrong. See server/envFile.js's header for why a real environment variable
// always wins over the file rather than the other way round; the short version is that the Windows
// service, the sandbox and `VAR=… npm start` all pass configuration in explicitly, and a file that
// beat them would silently redirect a throwaway instance at live data.
//
// Set WINDROW_ENV_FILE to point somewhere else, or WINDROW_NO_ENV_FILE=1 to skip it entirely.
//
// INLINE, not `require('./envFile')`, and that is a latency decision rather than a style one. A
// PreToolUse hook is a fresh Node process that lives ~20 ms (docs/design/latency-breakdown.md) and
// requires this file; measured here, pulling in a second module costs ~2 ms of compile — 10% of a
// hook's whole budget, paid on every governed tool call on the field, to read a file that is
// usually 200 bytes. So the twenty lines that a hook needs live here, and server/envFile.js — which
// the wizard uses to WRITE the file — imports `parseEnvFile` from this side rather than the other
// way round. One parser, and nothing extra on the hot path.

const ENV_FILE = process.env.WINDROW_ENV_FILE || path.join(REPO_ROOT, 'windrow.env');

/**
 * Parse KEY=value lines. Blank lines and `#` comments are skipped, whitespace around both sides is
 * trimmed, and a value may be wrapped in quotes to keep leading or trailing spaces. A line without
 * `=` is IGNORED rather than fatal: this runs inside every hook process, and a typo that threw here
 * would fail every hook closed, which is a fleet-wide denial caused by a stray character in a
 * config file.
 *
 * Deliberately not dotenv-compatible. No interpolation, no `export`, no multi-line values — a
 * format with no expansion rules cannot surprise anyone about what a Postgres password containing
 * `$` means, and passwords are exactly what goes in here.
 */
function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * Read the file without applying it. `{}` when it is not there.
 *
 * `existsSync` BEFORE the read, rather than simply catching ENOENT, and that is the hot path again:
 * the FIRST exception thrown in a Node process costs about 2 ms to initialise the stack-capture
 * machinery, and on a machine with no `windrow.env` — which is every standalone install — that
 * exception would be thrown once per hook invocation, on every governed tool call. A stat is
 * 0.06 ms. The try/catch stays for the permission errors and the races a stat cannot rule out.
 */
function readEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Apply it, filling in only what is unset. Returns the names actually set. */
function loadEnvFile({ file = ENV_FILE, env = process.env } = {}) {
  const applied = [];
  for (const [key, value] of Object.entries(readEnvFile(file))) {
    if (env[key] !== undefined) continue; // a real environment variable always wins
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Which names in `process.env` were filled in from `windrow.env` rather than passed to this
 * process by whoever started it.
 *
 * The distinction matters exactly once, and it is load-bearing: `server/store.js`'s `adoptNodeId`
 * refuses to record an identity this process would then ignore, because `WINDROW_NODE_ID` overrides
 * every other read. But "overrides" is only true of a REAL environment variable. A value this
 * module lifted out of `windrow.env` a moment ago is not an override at all — it is the previous
 * enrolment's answer, sitting in the very file the new one is about to rewrite. Refusing on it is
 * the second trap in docs/design/disposable-nodes.md §2.1: re-enrolling with the CLI leaves the old
 * id in place, it wins over the new credential, and every shipped batch is then rejected whole as
 * NODE_IDENTITY_MISMATCH.
 */
const ENV_FILE_APPLIED = new Set();

if (process.env.WINDROW_NO_ENV_FILE !== '1') for (const k of loadEnvFile()) ENV_FILE_APPLIED.add(k);

/** True when `name` in this process's environment came from `windrow.env`, not from its parent. */
function cameFromEnvFile(name) {
  return ENV_FILE_APPLIED.has(name);
}

/**
 * WHERE THIS NODE'S STATE LIVES — one definition, overridable, and the thing that has to be true
 * before a node can be a container at all (docs/design/disposable-nodes.md §2.3).
 *
 * Seven files computed `path.join(__dirname, 'data')` for themselves, and none of them could be
 * pointed anywhere else. That is the structural blocker §2.3 names, and it bites in the one place
 * containerisation cannot avoid: THE HOOK RUNS ON THE HOST. It has to — it is invoked by the agent
 * harness, which is a program on somebody's desktop — and it reads the deny-list, three signed
 * caches, the subject marker and the fault journal out of this directory. If the service is in a
 * container and this path is baked to a location inside the image, the hook and the service are
 * reading two different directories that happen to have the same name, and every signed cache the
 * hook checks is one the service never wrote.
 *
 * With an override, the shape §2.3 recommends becomes expressible: the service containerises, the
 * hook stays a host-side thin client, and both are handed the same WINDROW_DATA_DIR pointing at one
 * shared volume.
 *
 * `envCompat` is deliberately NOT used: it is defined below this point, and this constant is read
 * during module load by files that require it. A plain env read is also what every other bootstrap
 * value here does.
 */
const DATA_DIR = process.env.WINDROW_DATA_DIR
  ? path.resolve(process.env.WINDROW_DATA_DIR)
  : path.join(__dirname, 'data');

/**
 * THE FAULT JOURNAL — every decision this node made without the server, and every denial an
 * enforcement pause suppressed, with the pause id on it.
 *
 * Defined here rather than in server/hooks/lib.js, which writes it, because it now has a second
 * reader: server/nodeHealth.js ships it to central (docs/design/disposable-nodes.md §5). It is the
 * only record that a node stopped enforcing, and until that shipping existed it was also the only
 * COPY — §3 lists it first among the four things that never leave the machine, and calls it the
 * important one.
 */
const FAULT_JOURNAL_PATH = path.join(DATA_DIR, 'hook-fault-journal.jsonl');

/**
 * The real human's home directory — NOT `os.homedir()` directly, because this server runs as a
 * Windows service (server/daemon/windrow.xml) under the `LocalSystem` account, whose "home" is
 * `C:\WINDOWS\system32\config\systemprofile`. Every path below is meant to reach *the user's*
 * `~/.claude`, `~/.gemini`, etc., not the service account's, so every one of them must go through
 * this function instead of calling `os.homedir()` itself.
 *
 * `WINDROW_USER_HOME` is set on the service by scripts/service-install.js (captured at install
 * time, when the installer runs under the real user's own elevated session) and mirrored into
 * server/daemon/windrow.xml for the already-installed service. Running the server directly in a
 * normal user terminal (not as the service) never needs the override — `os.homedir()` already
 * resolves correctly there.
 */
function userHomeDir() {
  return process.env.WINDROW_USER_HOME || os.homedir();
}

/**
 * The single definition of the built-in skill-scan roots, in priority order (first occurrence of
 * a name wins). This is the one place that list is written down — `server/store.js`'s
 * `discovery_sources` table seeds itself from this once, on first boot, and every reader
 * afterward (server/discovery/scan.js via the DB, server/skills.js's write-target list via the
 * DB) goes through that table, not this function again, so there is nowhere else a second copy of
 * these paths can drift out of sync.
 *
 * Overridable via SKILL_DIRS (';'-separated) — matches the env var server/discovery/scan.js has
 * always read, so this doesn't fork behavior, just gives it one shared home. An override entry
 * gets no friendly label (the env var only carries paths) and is treated as writable, since there's
 * no way to tell a bundle directory from a skill directory from a bare path list.
 *
 * Includes Antigravity ("agy")'s own directories alongside Claude Code's, so a workspace running
 * agy agents gets its skills/tools discovered without an admin having to add them by hand on the
 * Sources page — same "unconfigured server behaves exactly as it does today" guarantee this
 * function already gives Claude Code, extended to the second backend `docs/design/agy-adapter.md`
 * added enforcement for. Paths per [atamel.dev — where agy looks for hooks]
 * (https://atamel.dev/posts/2026/07-16_where_agy_hooks/), the same source `.agents/hooks.json`
 * (server/hooks/agy-pre-tool-use.js's config path, see `hookInstallPaths` below) was confirmed
 * against.
 *
 * `writable: false` marks the one entry (agy's installed-plugins dir) that discovery should still
 * scan for SKILL.md files but that server/skills.js should never offer as a place to *write* a new
 * one — it holds whole marketplace plugin bundles (tools + skills together), not single
 * hand-authored SKILL.md files.
 */
function discoverySourceDefaults(repoRoot = REPO_ROOT) {
  if (process.env.SKILL_DIRS) {
    return process.env.SKILL_DIRS.split(';')
      .filter(Boolean)
      .map((p) => ({ path: p, label: null, writable: true }));
  }
  const home = userHomeDir();
  return [
    { path: path.join(home, '.wispfield', 'skills'), label: 'Wispfield', writable: true },
    { path: path.join(repoRoot, '.claude', 'skills'), label: 'Claude Code (this project)', writable: true },
    { path: path.join(home, '.claude', 'skills'), label: 'Claude Code (user, all projects)', writable: true },
    { path: path.join(repoRoot, '.agents', 'skills'), label: 'Antigravity (this workspace)', writable: true },
    { path: path.join(home, '.gemini', 'config', 'skills'), label: 'Antigravity (user, all workspaces)', writable: true },
    {
      path: path.join(home, '.gemini', 'antigravity-cli', 'plugins'),
      label: 'Antigravity (installed plugins)',
      writable: false, // bundle dir — see doc comment above
    },
  ];
}

/** Just the paths from discoverySourceDefaults() — kept for callers that don't need label/writable. */
function discoveryPaths(repoRoot = REPO_ROOT) {
  return discoverySourceDefaults(repoRoot).map((d) => d.path);
}

/**
 * Where each backend's hook wiring config lives, one path per adapter under server/hooks/.
 * Overridable via HOOK_INSTALL_PATHS as a JSON object, e.g. '{"claude":"C:\\...\\settings.json"}'
 * — keys not present in the override fall back to the default for that backend.
 *
 * `claude` defaults to the user-level settings file (`~/.claude/settings.json`), not a
 * project-local one, per `docs/design/deployment-boundary-decision.md`'s "consolidated to one
 * user-level hook instead": a project-local `.claude/settings.json` never reaches git worktrees
 * (each has its own, frozen at branch time), and hooks merge additively across scopes rather than
 * overriding, so leaving a project copy in place double-counts every call once the user-level one
 * exists. `agy` now defaults the same way, to `~/.gemini/config/hooks.json` — confirmed as
 * Antigravity's own global hook location (same source as the `discoveryPaths` agy entries above:
 * https://atamel.dev/posts/2026/07-16_where_agy_hooks/, "applied globally or per workspace...
 * saved to the following locations for all 3 flavours"), same double-count risk as Claude's case
 * once a per-project `.agents/hooks.json` also has the entry, and same worktree gap it closes.
 */
function hookInstallPaths(repoRoot = REPO_ROOT) {
  const defaults = {
    claude: path.join(userHomeDir(), '.claude', 'settings.json'),
    agy: path.join(userHomeDir(), '.gemini', 'config', 'hooks.json'),
    // codex-pre-tool-use.js / codex-post-tool-use.js exist, but no confirmed hook-config file
    // location yet — see docs/design/cross-field-and-standalone.md "Codex adapter is unverified".
    codex: null,
  };
  if (process.env.HOOK_INSTALL_PATHS) {
    try {
      return { ...defaults, ...JSON.parse(process.env.HOOK_INSTALL_PATHS) };
    } catch {
      return defaults; // malformed override — fall back rather than crash the server
    }
  }
  return defaults;
}


/* ---------------------------------------------------------------------------------------------
 * Env var names: WINDROW_* only. The GOVERNANCE_* spellings are gone.
 *
 * Tier 4 of docs/design/governance-to-windrow-rename.md. Tier 1 read both spellings for one
 * release and warned on the old one; this is the release after, so the fallback branch is deleted
 * and an old name is now a hard error naming its replacement rather than a value that is silently
 * honoured. Every runtime env read still goes through `envCompat` — the indirection is what kept
 * the rename to one edit, and it is what lets the old names be *detected* here rather than simply
 * ignored, which is the difference between a field that tells you why it stopped and one that
 * quietly falls back to a default.
 *
 * Failing rather than ignoring is the point. A field still setting GOVERNANCE_DB_PATH would
 * otherwise open the default database instead of the configured one — an empty registry that boots
 * clean, which is a far worse outcome than a refusal to start.
 *
 * The error goes through `throw`, not stderr: server/hooks/*.js write their hook verdict as JSON
 * on stdout, so a hook that throws fails closed, which is the correct verdict for a hook that
 * cannot resolve its own configuration.
 * ------------------------------------------------------------------------------------------- */

/** Message shared by the lazy per-read check and the eager startup scan. */
function legacyEnvMessage(name) {
  return `[windrow] GOVERNANCE_${name} is no longer read — rename it to WINDROW_${name}.`;
}

/**
 * Read `WINDROW_<name>`.
 *
 * Throws if the removed `GOVERNANCE_<name>` spelling is set and the new one is not, so a stale
 * configuration stops the process instead of being ignored.
 *
 * @param {string} name        env var suffix, e.g. 'API_BASE'
 * @param {object} [opts]
 * @param {*}      [opts.fallback]  returned when it is unset
 * @param {object} [opts.env]       env object to read (defaults to process.env; injectable for tests)
 * @returns {string|*} the raw string value, or `fallback`
 */
function envCompat(name, { fallback, env = process.env } = {}) {
  const value = env[`WINDROW_${name}`];
  if (value !== undefined) return value;
  if (env[`GOVERNANCE_${name}`] !== undefined) throw new Error(legacyEnvMessage(name));
  return fallback;
}

/**
 * Startup guard: reject *every* removed `GOVERNANCE_*` name at once.
 *
 * `envCompat` alone only catches a stale name at the moment something reads it, so a process that
 * takes a different code path would start and misbehave later. This scans the whole environment at
 * boot and names all the offenders in one message, rather than making an operator fix them one
 * restart at a time. Call it before anything reads configuration.
 *
 * Stricter than `envCompat` on purpose: this rejects a stale name even when the WINDROW_* one is
 * also set. `envCompat` returns the new value in that case because a *read* is unambiguous, but a
 * process left holding both names has a dead variable that will drift out of sync with the live
 * one and be believed by the next person who reads the config, so boot is where it gets removed.
 *
 * @param {object} [env] env object to scan (defaults to process.env; injectable for tests)
 */
function assertNoLegacyEnv(env = process.env) {
  const stale = Object.keys(env).filter((k) => k.startsWith('GOVERNANCE_')).sort();
  if (stale.length === 0) return;
  const nl = String.fromCharCode(10);
  throw new Error(stale.map((k) => legacyEnvMessage(k.slice('GOVERNANCE_'.length))).join(nl));
}

module.exports = {
  REPO_ROOT,
  envCompat,
  assertNoLegacyEnv,
  discoverySourceDefaults,
  discoveryPaths,
  hookInstallPaths,
  userHomeDir,
  ENV_FILE,
  DATA_DIR,
  FAULT_JOURNAL_PATH,
  parseEnvFile,
  readEnvFile,
  loadEnvFile,
  cameFromEnvFile,
  ENV_FILE_APPLIED,
};
