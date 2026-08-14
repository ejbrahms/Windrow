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
 * The three configurable skill-scan roots, in priority order (first occurrence of a name wins).
 * Overridable via SKILL_DIRS (';'-separated) — matches the env var server/discovery/scan.js has
 * always read, so this doesn't fork behavior, just gives it one shared home.
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
  ];
}

/**
 * Where each backend's hook wiring config lives, one path per adapter under server/hooks/.
 * Overridable via HOOK_INSTALL_PATHS as a JSON object, e.g. '{"claude":"C:\\...\\settings.json"}'
 * — keys not present in the override fall back to the default for that backend.
 */
function hookInstallPaths(repoRoot = REPO_ROOT) {
  const defaults = {
    claude: path.join(repoRoot, '.claude', 'settings.json'),
    agy: path.join(repoRoot, '.agents', 'hooks.json'),
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
