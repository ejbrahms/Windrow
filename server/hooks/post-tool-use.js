#!/usr/bin/env node
'use strict';
// PostToolUse hook: the tool has now actually run. Correct the UsageEvent that PreToolUse logged
// (which had simulated latency and only knew "grant existed", not whether the call itself
// succeeded) with the real outcome and real latency.
//
// Denied calls never reach here — PreToolUse blocked them before the tool ran, and their event
// already carries the correct terminal outcome ("denied"). This hook only ever moves an event
// from provisional "ok" to either confirmed "ok" or "error".
//
// The actual correction logic lives once in `lib.runPostToolUse`, shared with
// agy-post-tool-use.js and codex-post-tool-use.js. Only outcome detection (this hook's
// `toolFailed`) and input extraction are backend-specific.

const { readHookInput, runPostToolUse, log } = require('./lib');

function toolFailed(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse === 'object') {
    if (toolResponse.is_error === true) return true;
    if (toolResponse.error) return true;
  }
  return false;
}

async function main() {
  const input = await readHookInput();
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput, tool_response: toolResponse } = input;

  await runPostToolUse({ toolName, toolInput, sessionId, failed: toolFailed(toolResponse) });
}

main()
  .catch((err) => log('unexpected error:', err && err.stack ? err.stack : err))
  .finally(() => process.exit(0)); // hooks are spawned fresh per call — always exit explicitly
