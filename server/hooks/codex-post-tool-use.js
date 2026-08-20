#!/usr/bin/env node
'use strict';
// PostToolUse hook for the Codex CLI backend — mirrors server/hooks/agy-post-tool-use.js. Same
// unverified-shape caveat as codex-pre-tool-use.js: tries several plausible field names for the
// tool call and its outcome rather than assuming one. The correction logic itself lives once in
// `lib.runPostToolUse`, shared across all three backend adapters.

const { readHookInput, extractCodexToolCall, runPostToolUse, log } = require('./lib');

/** Accepts Claude's `tool_response.is_error`/`.error`, Antigravity's plain `error` string, or a
 * top-level `success: false` — whichever this backend turns out to actually send. */
function toolFailed(input) {
  const toolResponse = input.tool_response || input.toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    if (toolResponse.is_error === true || toolResponse.error) return true;
  }
  if (typeof input.error === 'string' && input.error.trim().length > 0) return true;
  if (input.success === false) return true;
  return false;
}

async function main() {
  const input = await readHookInput();
  const { toolName, toolInput, sessionId } = extractCodexToolCall(input);

  // backendHint matches codex-pre-tool-use.js: a native-tool observation has no capability to
  // infer a backend from, so the adapter that already knows which one it is has to say so.
  await runPostToolUse({ toolName, toolInput, sessionId, backendHint: 'codex', failed: toolFailed(input) });
}

main()
  .catch((err) => log('unexpected error:', err && err.stack ? err.stack : err))
  .finally(() => process.exit(0)); // hooks are spawned fresh per call — always exit explicitly
