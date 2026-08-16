// Central configuration for paths the governance server reads from or writes into on disk.
// Two concerns live here:
//   - discoveryPaths: real filesystem roots scanned for SKILL.md files (server/discovery/scan.js).
//   - hookInstallPaths: where each backend's own hook wiring config lives, i.e. the file
//     `deploy-capability-governance-server` writes PreToolUse/PostToolUse entries into.
// Both are overridable via env var for a real deployment (see
// docs/design/deployment-boundary-decision.md); defaults are pre-populated with the paths this
// workspace already uses, so an unconfigured server behaves exactly as it does today.
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

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

module.exports = { REPO_ROOT, discoverySourceDefaults, discoveryPaths, hookInstallPaths, userHomeDir };
