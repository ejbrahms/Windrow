'use strict';
// Provider configuration — discovers whether each backend adapter's hook wiring
// (server/hooks/*.js, docs/design/agy-adapter.md, docs/design/integration-todo.md step 3/9) is
// actually installed into that backend's own config file, and installs/uninstalls it with a
// single call. This is the missing piece `hookInstallPaths` (server/config.js) was named for but
// nothing wrote to yet — until now, wiring a field's hooks meant hand-editing
// `.claude/settings.json` / `.agents/hooks.json`, same as the entries already checked into this
// repo were written.
//
// Each adapter below owns three things: how to tell whether *its* hook entries are present in an
// already-parsed config object, how to merge them in, and how to strip just them back out —
// everything else in that file (permissions, other hook groups, unrelated keys) is read, edited
// in place, and rewritten untouched so this never clobbers config a human hand-edited for other
// reasons.

const fs = require('fs');
const path = require('path');
const { REPO_ROOT, hookInstallPaths } = require('./config');

class NotFoundError extends Error {}
class UnsupportedError extends Error {}

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return raw.trim() ? JSON.parse(raw) : null;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Claude Code — `hooks.PreToolUse`/`PostToolUse` arrays of {matcher, hooks:[{type,command}]},
// alongside whatever else (e.g. `permissions`) already lives in settings.json.
// ---------------------------------------------------------------------------

const CLAUDE_PRE_CMD = 'node "$CLAUDE_PROJECT_DIR/server/hooks/pre-tool-use.js"';
const CLAUDE_POST_CMD = 'node "$CLAUDE_PROJECT_DIR/server/hooks/post-tool-use.js"';

function hasCommand(entries, needle) {
  return (
    Array.isArray(entries) &&
    entries.some((entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(needle)))
  );
}

function claudeInstalled(config) {
  if (!config || !config.hooks) return false;
  return hasCommand(config.hooks.PreToolUse, 'pre-tool-use.js') && hasCommand(config.hooks.PostToolUse, 'post-tool-use.js');
}

function claudeInstall(filePath) {
  const config = readJson(filePath) || {};
  config.hooks = config.hooks || {};
  const ensure = (eventName, command) => {
    const entries = (config.hooks[eventName] = config.hooks[eventName] || []);
    if (!hasCommand(entries, command)) {
      entries.push({ matcher: '*', hooks: [{ type: 'command', command }] });
    }
  };
  ensure('PreToolUse', CLAUDE_PRE_CMD);
  ensure('PostToolUse', CLAUDE_POST_CMD);
  writeJson(filePath, config);
}

function claudeUninstall(filePath) {
  const config = readJson(filePath);
  if (!config || !config.hooks) return;
  const strip = (eventName, needle) => {
    if (!Array.isArray(config.hooks[eventName])) return;
    config.hooks[eventName] = config.hooks[eventName]
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !(typeof h.command === 'string' && h.command.includes(needle))) }))
      .filter((entry) => entry.hooks.length > 0);
    if (config.hooks[eventName].length === 0) delete config.hooks[eventName];
  };
  strip('PreToolUse', 'pre-tool-use.js');
  strip('PostToolUse', 'post-tool-use.js');
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  writeJson(filePath, config);
}

// ---------------------------------------------------------------------------
// Antigravity ("agy") — a single `capability-governance` key alongside whatever other hook groups
// `.agents/hooks.json` already has. See docs/design/agy-adapter.md.
// ---------------------------------------------------------------------------

const AGY_KEY = 'capability-governance';
const AGY_PRE_CMD = 'node server/hooks/agy-pre-tool-use.js';
const AGY_POST_CMD = 'node server/hooks/agy-post-tool-use.js';

function agyInstalled(config) {
  const entry = config && config[AGY_KEY];
  if (!entry) return false;
  return hasCommand(entry.PreToolUse, 'agy-pre-tool-use.js') && hasCommand(entry.PostToolUse, 'agy-post-tool-use.js');
}

function agyInstall(filePath) {
  const config = readJson(filePath) || {};
  config[AGY_KEY] = {
    enabled: true,
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: AGY_PRE_CMD, timeout: 10 }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: AGY_POST_CMD, timeout: 10 }] }],
  };
  writeJson(filePath, config);
}

function agyUninstall(filePath) {
  const config = readJson(filePath);
  if (!config || !(AGY_KEY in config)) return;
  delete config[AGY_KEY];
  writeJson(filePath, config);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// codex-pre-tool-use.js / codex-post-tool-use.js exist (see server/hooks/lib.js's
// extractCodexToolCall), but Codex's own hook-config file location is still unconfirmed
// (docs/design/cross-field-and-standalone.md) — listed so it's visible as a known adapter with
// nothing to install yet, rather than missing from the page entirely.
const ADAPTERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    // Matches a key in client/src/components/ProviderIcon.tsx's ICONS map — see
    // docs/design/adding-a-provider.md step 5. Falls back to a generic "unknown" glyph client-side
    // if the two ever drift, so this is a convenience, not a contract either side enforces.
    icon: 'claude',
    hookFiles: ['server/hooks/pre-tool-use.js', 'server/hooks/post-tool-use.js'],
    detectInstalled: claudeInstalled,
    install: claudeInstall,
    uninstall: claudeUninstall,
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    icon: 'agy',
    hookFiles: ['server/hooks/agy-pre-tool-use.js', 'server/hooks/agy-post-tool-use.js'],
    detectInstalled: agyInstalled,
    install: agyInstall,
    uninstall: agyUninstall,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    icon: 'codex',
    hookFiles: ['server/hooks/codex-pre-tool-use.js', 'server/hooks/codex-post-tool-use.js'],
    detectInstalled: () => false,
    install: null,
    uninstall: null,
  },
};

function describe(adapter, repoRoot) {
  const configPath = hookInstallPaths(repoRoot)[adapter.id] || null;
  let installed = false;
  let configExists = false;
  let error = null;
  if (configPath) {
    configExists = fs.existsSync(configPath);
    try {
      installed = adapter.detectInstalled(readJson(configPath));
    } catch (err) {
      error = `config file exists but isn't valid JSON: ${err.message}`;
    }
  }
  return {
    id: adapter.id,
    label: adapter.label,
    icon: adapter.icon || null,
    configPath,
    configExists,
    installed,
    // Whether the "install"/"uninstall" buttons have anywhere to write — false for Codex (no
    // known config path yet) even though the hook scripts themselves already exist.
    installable: Boolean(adapter.install && configPath),
    hookFiles: adapter.hookFiles,
    error,
  };
}

function listProviders(repoRoot = REPO_ROOT) {
  return Object.values(ADAPTERS).map((adapter) => describe(adapter, repoRoot));
}

function installProvider(id, repoRoot = REPO_ROOT) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new NotFoundError(`unknown provider "${id}"`);
  const configPath = hookInstallPaths(repoRoot)[id];
  if (!configPath || !adapter.install) {
    throw new UnsupportedError(`provider "${id}" has no known hook-install location yet`);
  }
  adapter.install(configPath);
  return describe(adapter, repoRoot);
}

function uninstallProvider(id, repoRoot = REPO_ROOT) {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new NotFoundError(`unknown provider "${id}"`);
  const configPath = hookInstallPaths(repoRoot)[id];
  if (!configPath || !adapter.uninstall) {
    throw new UnsupportedError(`provider "${id}" has no known hook-install location yet`);
  }
  adapter.uninstall(configPath);
  return describe(adapter, repoRoot);
}

module.exports = { listProviders, installProvider, uninstallProvider, NotFoundError, UnsupportedError };
