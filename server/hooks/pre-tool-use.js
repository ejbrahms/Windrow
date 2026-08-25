#!/usr/bin/env node
'use strict';
// PreToolUse hook: calls the governance API before a skill or MCP tool runs, and translates the
// allow/deny into the hook's permission decision. Native harness tools (Bash, Read, Edit, ...)
// aren't in the capability registry at all, so they pass straight through untouched.
//
// All the actual policy — capability lookup, principal resolution, the grant check, and the
// fail-open/fail-closed rules per risk tier (integration-todo.md step 3) — lives once in
// `lib.runPreToolUse`, shared with agy-pre-tool-use.js and codex-pre-tool-use.js. This file only
// translates Claude Code's own stdin/stdout hook shapes.

const { readHookInput, runPreToolUse, decide, log, resolveHookDeadlineMs } = require('./lib');

// Claude Code's default PreToolUse hook budget is 60s — claudeInstall (server/providers.js) sets no
// explicit `timeout`, so the harness default applies. The watchdog fails closed inside that budget.
const CLAUDE_HARNESS_BUDGET_MS = 60000;

async function main() {
  const input = await readHookInput();
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = input;

  await runPreToolUse({
    toolName,
    toolInput,
    sessionId,
    decideFn: decide,
    deadlineMs: resolveHookDeadlineMs(CLAUDE_HARNESS_BUDGET_MS),
  });
}

main().catch((err) => {
  // Never let a bug in the hook itself block real work.
  log('unexpected error, failing open:', err && err.stack ? err.stack : err);
  decide('allow', 'hook error — fail-open');
});
