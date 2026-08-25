'use strict';
// @windrow/enforce — the in-process governance SDK.
//
// Until now the only way to enforce was a subprocess hook: server/hooks/pre-tool-use.js and its
// Antigravity/Codex siblings, each spawned fresh by a CLI harness (Claude Code, Antigravity,
// Codex) that hands the hook a tool call on stdin and reads its allow/deny back off stdout. That
// works because those harnesses run the model in one process and the tools in a hook subprocess.
//
// The in-process agent frameworks — LangChain, LlamaIndex, AutoGen, the Vercel AI SDK — cannot do
// that. They run the model AND the tools in the same Node process, and expose lifecycle callbacks
// (a LangChain "callback handler", a tool wrapper) rather than a subprocess hook contract. There
// is no stdin to write to and no process to spawn, so the entire hook-shaped integration is
// unreachable from them. Governance audit docs/design/governance-review-2026-08-24-repo-audit.md
// finding #9: "No in-process SDK — integration is hook-shaped only".
//
// This module is the missing surface. It does NOT re-implement any policy: capability lookup,
// principal resolution, the grant check, the fail-open/fail-closed ladder per risk tier, the
// enforcement-pause override and the native-call self-call block all live once in
// server/hooks/lib.js (runPreToolUse / runPostToolUse), already parameterized by a `decideFn` and
// a `backendHint` precisely so a new front end is a translator, not a fork. The three subprocess
// adapters translate a CLI's stdin/stdout; this one has none to translate.
//
// The ONE shape difference from a hook: a hook's decideFn writes the decision to stdout and calls
// process.exit — correct for a process spawned per call, fatal in a long-lived host process. Here
// the decideFn captures (decision, reason) into a value pre() returns, and nothing writes stdout
// or exits.

const { runPreToolUse, runPostToolUse } = require('../hooks/lib');

// The backend this SDK attributes standalone usage to when no platform agent identity is in the
// environment — the same role 'antigravity'/'codex' play for their adapters (see
// server/hooks/lib.js resolvePrincipal / docs/design/cross-field-and-standalone.md). A LangChain
// process running bare, with no LOOM_* identity, is attributed here.
const DEFAULT_BACKEND_HINT = 'in-process';

/**
 * Ask governance whether a tool call may proceed. This is the in-process equivalent of the
 * PreToolUse hook: same decision core, same vocabulary.
 *
 * @param {object}  call
 * @param {string}  call.toolName   The tool being called. Only `mcp__<server>__<tool>` names are in
 *                                  the capability registry; anything else is ungoverned and allowed
 *                                  (see normalizeToolCall in server/hooks/lib.js). A LangChain tool
 *                                  that fronts a governed MCP tool must carry that MCP name.
 * @param {object}  call.toolInput  The tool's arguments object.
 * @param {string} [call.sessionId] Correlates the pre/post pair and the usage event.
 * @param {string} [call.backendHint] Overrides the standalone attribution backend.
 * @returns {Promise<{decision: 'allow'|'deny'|'ask', reason: string|null}>}
 *          runPreToolUse calls its decideFn exactly once on every path, so this always resolves to a
 *          captured decision; the `allow` fallback is defensive only.
 */
async function pre({ toolName, toolInput, sessionId, backendHint = DEFAULT_BACKEND_HINT } = {}) {
  let captured = null;
  const decideFn = (decision, reason) => {
    captured = { decision, reason: reason === undefined ? null : reason };
  };
  await runPreToolUse({ toolName, toolInput, sessionId, backendHint, decideFn });
  return captured || { decision: 'allow', reason: null };
}

/**
 * Record that a tool call actually ran, correcting the usage event pre() logged with the real
 * outcome and latency. The in-process equivalent of the PostToolUse hook. A denied call never
 * reaches here (pre() returned 'deny' and the caller blocked it before running the tool), the same
 * contract the subprocess PostToolUse relies on.
 *
 * @param {object}  call
 * @param {string}  call.toolName
 * @param {object}  call.toolInput
 * @param {string} [call.sessionId]
 * @param {string} [call.backendHint]
 * @param {boolean} [call.failed]  Whether the tool call errored — the caller decides this from its
 *                                 own framework's outcome shape, exactly as each subprocess adapter
 *                                 does before calling runPostToolUse.
 * @returns {Promise<void>}
 */
async function post({ toolName, toolInput, sessionId, backendHint = DEFAULT_BACKEND_HINT, failed = false } = {}) {
  await runPostToolUse({ toolName, toolInput, sessionId, backendHint, failed });
}

/** True when a pre() decision lets the tool run. `ask` is a proceed with a human prompt upstream —
 * from this SDK's point of view the call is not blocked, so it counts as allowed here and the host
 * framework decides whether it can surface the prompt. Only `deny` blocks outright. */
function isAllowed(decision) {
  return decision === 'allow' || decision === 'ask';
}

module.exports = { pre, post, isAllowed, DEFAULT_BACKEND_HINT };
