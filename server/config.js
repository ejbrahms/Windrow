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
 * The configurable skill-scan roots, in priority order (first occurrence of a name wins).
 * Overridable via SKILL_DIRS (';'-separated) — matches the env var server/discovery/scan.js has
 * always read, so this doesn't fork behavior, just gives it one shared home.
 *
 * Includes Antigravity ("agy")'s own directories alongside Claude Code's, so a workspace running
 * agy agents gets its skills/tools discovered without an admin having to add them by hand on the
 * Sources page — same "unconfigured server behaves exactly as it does today" guarantee this
 * function already gives Claude Code, extended to the second backend `docs/design/agy-adapter.md`
 * added enforcement for. Paths per [atamel.dev — where agy looks for hooks]
 * (https://atamel.dev/posts/2026/07-16_where_agy_hooks/), the same source `.agents/hooks.json`
 * (server/hooks/agy-pre-tool-use.js's config path, see `hookInstallPaths` below) was confirmed
 * against.
 */
function discoveryPaths(repoRoot = REPO_ROOT) {
  if (process.env.SKILL_DIRS) {
    return process.env.SKILL_DIRS.split(';').filter(Boolean);
  }
  const home = os.homedir();
  return [
    path.join(home, '.wispfield', 'skills'),
    path.join(repoRoot, '.claude', 'skills'),
    path.join(home, '.claude', 'skills'), // the "user skills" directory
    path.join(repoRoot, '.agents', 'skills'), // agy workspace-local skills
    path.join(home, '.gemini', 'config', 'skills'), // agy user-level skills
    path.join(home, '.gemini', 'antigravity-cli', 'plugins'), // agy installed plugins (tool + skill bundles)
  ];
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
    claude: path.join(os.homedir(), '.claude', 'settings.json'),
    agy: path.join(os.homedir(), '.gemini', 'config', 'hooks.json'),
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

module.exports = { REPO_ROOT, discoveryPaths, hookInstallPaths };
