#!/usr/bin/env node
'use strict';
// PostToolUse hook for the Antigravity ("agy") backend — mirrors server/hooks/post-tool-use.js,
// translated to Antigravity's hook input shape. See docs/design/agy-adapter.md.
//
// Antigravity's PostToolUse input carries a plain `error` string (empty/absent on success)
// instead of Claude's `tool_response` object with an `is_error`/`error` field — that's the only
// real difference from the Claude adapter. The correction logic itself lives once in
// `lib.runPostToolUse`, shared across all three backend adapters.

const { readHookInput, runPostToolUse, log } = require('./lib');

function toolFailedAgy(error) {
  return typeof error === 'string' && error.trim().length > 0;
}

async function main() {
  const input = await readHookInput();
  const toolCall = input.toolCall || {};
  const toolName = toolCall.name;
  const toolInput = toolCall.args;
  const sessionId = input.conversationId;

  // backendHint matches agy-pre-tool-use.js: a native-tool observation has no capability to infer
  // a backend from, so the adapter that already knows which one it is has to say so.
  await runPostToolUse({
    toolName,
    toolInput,
    sessionId,
    backendHint: 'antigravity',
    failed: toolFailedAgy(input.error),
  });
}

main()
  .catch((err) => log('unexpected error:', err && err.stack ? err.stack : err))
  .finally(() => process.exit(0)); // hooks are spawned fresh per call — always exit explicitly
