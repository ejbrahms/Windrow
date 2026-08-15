// Reads the real identity of the process we're running in — the same env vars a
// PreToolUse/PostToolUse hook sees, since a hook runs as a child process of the loom and
// inherits its environment. Verified against this actual machine (2026-08-13):
//   LOOM_NODE_ID=claude-msri1c9v-43   LOOM_AGENT_NAME=Finn   LOOM_PROVIDER=claude
//   LOOM_FIELD_NAME=windrow           LOOM_FIELD_PATH=C:\Projects\windrow   CLAUDECODE=1
// This is the piece roadmap item 3 (real enforcement) needs: a hook shells out to
// `resolve-cli.js` (or requires this module directly, if the hook itself is Node) to turn "the
// process I'm running as" into a stable principal id, instead of the hook having to know or
// invent one.
//
// Standalone usage (docs/design/cross-field-and-standalone.md): when LOOM_NODE_ID is absent —
// a bare terminal, CI, or any backend Wispfield never wrapped — this used to return `null` and
// the calling hook went ungoverned (no principal, no usage event, nothing recorded). It now
// synthesizes a real, stable "standalone" identity instead, so that usage is tracked too.

const os = require('os');

/**
 * `agentType` groups principals the way Wispfield itself groups looms (its `kind` field in
 * wispfield_get_field_status, e.g. "claudecode", "browser") — distinct from the pre-existing
 * `claude`/`general-purpose`/`Explore`/... roles, which model Claude Code's own Task-tool
 * subagent types *within* a loom, not the loom's identity on the field. A loom is a `claudecode`
 * principal; a Task-tool subagent it spawns is a `claude` (or `Explore`, `Plan`, ...) principal.
 * Both are real, they're just answering different questions ("which loom made this call" vs
 * "which subagent role was it acting as").
 */
function deriveAgentType(env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claudecode';
  if (env.LOOM_PROVIDER === 'antigravity') return 'antigravity'; // agy adapter — see server/hooks/agy-pre-tool-use.js
  if (env.LOOM_PROVIDER) return `${env.LOOM_PROVIDER}-unknown`; // a backend we haven't mapped a kind for yet
  return null;
}

/**
 * Best-effort backend detection for a process with no Wispfield loom id at all. `backendHint`
 * (passed by a backend-specific hook entry point, e.g. `agy-pre-tool-use.js` or
 * `codex-pre-tool-use.js` — the script itself already knows which backend it's wired to) always
 * wins over sniffing env vars. Falls back to `unknown` rather than guessing wrong — see
 * docs/design/cross-field-and-standalone.md for what's confirmed vs. best-effort here.
 */
function detectStandaloneBackend(env, backendHint) {
  if (backendHint) return backendHint;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  // Codex CLI: no confirmed distinguishing env var found for this session — these are the names
  // its docs/community most commonly reference, checked defensively, not verified against a
  // real Codex process. See "Codex adapter" in docs/design/cross-field-and-standalone.md.
  if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'codex';
  return 'unknown';
}

/**
 * Deterministic (not random) so repeated standalone invocations on the same machine, by the same
 * OS user, for the same backend, all land on one principal instead of minting a new one per
 * process — there's no LOOM_NODE_ID to key off outside Wispfield, so stable OS identity is the
 * closest real equivalent.
 */
function standaloneLoomId(backend, env) {
  return `standalone-${backend}-${currentHostname(env)}-${currentOsUser(env)}`;
}

/**
 * The real computer account this process is running as — env vars first (cheapest, and what a
 * hook child process actually inherits), falling back to `os.userInfo()` for the live value when
 * neither is set. Used both to key the standalone loom id above (unchanged) and, per the ask that
 * added this function, attached to *every* identity (loom-backed or standalone) so a usage event
 * can record which OS user issued the call, not just which agent/principal did.
 */
function currentOsUser(env) {
  const fromEnv = env.USERNAME || env.USER;
  if (fromEnv) return fromEnv;
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown-user';
  }
}

function currentHostname(env) {
  return env.COMPUTERNAME || env.HOSTNAME || os.hostname() || 'unknown-host';
}

/**
 * Returns the current process's real identity. Never returns `null`: a Wispfield loom (
 * `LOOM_NODE_ID` set) maps to a real loom instance; anything else maps to a deterministic
 * "standalone" instance instead of going ungoverned. `opts.backendHint` lets a backend-specific
 * hook (agy, codex) assert its own backend rather than relying on env sniffing.
 */
function identityFromEnv(env = process.env, opts = {}) {
  const loomId = env.LOOM_NODE_ID;
  // osUser/hostname are the *real* computer account and machine, independent of loomId/backend —
  // a Wispfield loom and a standalone process both run as some actual OS user, so both branches
  // carry it (previously only baked into the standalone loom id string above, unavailable to a
  // Wispfield-backed principal at all).
  const osUser = currentOsUser(env);
  const hostname = currentHostname(env);
  if (loomId) {
    return {
      loomId,
      humanName: env.LOOM_AGENT_NAME || null,
      backend: env.LOOM_PROVIDER || null,
      agentType: deriveAgentType(env),
      field: env.LOOM_FIELD_NAME || null,
      fieldPath: env.LOOM_FIELD_PATH || null,
      standalone: false,
      osUser,
      hostname,
    };
  }

  const backend = detectStandaloneBackend(env, opts.backendHint);
  return {
    loomId: standaloneLoomId(backend, env),
    humanName: null,
    backend,
    agentType: `${backend}-standalone`,
    field: null,
    fieldPath: null,
    standalone: true,
    osUser,
    hostname,
  };
}

module.exports = { identityFromEnv, deriveAgentType, detectStandaloneBackend };
