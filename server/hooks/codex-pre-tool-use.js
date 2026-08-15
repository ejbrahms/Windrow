#!/usr/bin/env node
'use strict';
// PreToolUse hook for the Codex CLI backend — mirrors server/hooks/agy-pre-tool-use.js, wired to
// the same broker (server/hooks/lib.js). See "Codex adapter" in
// docs/design/cross-field-and-standalone.md: UNVERIFIED — no confirmed Codex CLI
// PreToolUse/PostToolUse hook contract was available to check this against. Written defensively
// (accepts several plausible stdin field-name variants rather than committing to one guessed
// shape) so the principal/broker wiring is real even before the exact input shape is confirmed
// against a live Codex session. Treat this the way agy-pre-tool-use.js was treated before its own
// first smoke test — wired, not yet proven.
//
// All the actual policy (capability lookup, principal resolution, grant check, fail-open/closed
// per risk tier) lives once in `lib.runPreToolUse`, shared with the other two backend adapters.

const { readHookInput, extractCodexToolCall, runPreToolUse, decideAgy, log } = require('./lib');

async function main() {
  const input = await readHookInput();
  const { toolName, toolInput, sessionId } = extractCodexToolCall(input);

  // backendHint 'codex': attributes standalone usage (bare Codex CLI, no platform agent) to the
  // right backend instead of guessing from env vars. See docs/design/cross-field-and-standalone.md.
  await runPreToolUse({ toolName, toolInput, sessionId, backendHint: 'codex', decideFn: decideAgy });
}

main().catch((err) => {
  log('unexpected error, failing open:', err && err.stack ? err.stack : err);
  decideAgy('allow', 'hook error — fail-open');
});
