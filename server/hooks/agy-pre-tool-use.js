#!/usr/bin/env node
'use strict';
// PreToolUse hook for the Antigravity ("agy") backend — the same enforcement point as
// server/hooks/pre-tool-use.js, wired to Antigravity's own hook contract instead of Claude
// Code's. See docs/design/agy-adapter.md for the schema this was built against and what's
// unverified.
//
// All the actual policy (capability lookup, principal resolution, grant check, fail-open/closed
// per risk tier) lives once in `lib.runPreToolUse`, shared with pre-tool-use.js and
// codex-pre-tool-use.js. Only the input/output translation is backend-specific here.

const { readHookInput, runPreToolUse, decideAgy, log } = require('./lib');

async function main() {
  const input = await readHookInput();
  // Antigravity's PreToolUse input shape (docs/design/agy-adapter.md):
  //   { toolCall: { name, args }, stepIdx, conversationId, workspacePaths, transcriptPath,
  //     artifactDirectoryPath, modelName }
  // conversationId is the session-boundary analogue of Claude's session_id.
  const toolCall = input.toolCall || {};
  const toolName = toolCall.name;
  const toolInput = toolCall.args;
  const sessionId = input.conversationId;

  // backendHint 'antigravity': if this isn't running under the platform either (bare
  // Antigravity CLI outside the platform), resolvePrincipal still attributes the standalone identity
  // to the right backend instead of guessing from env vars — see
  // docs/design/cross-field-and-standalone.md.
  //
  // Skills are catalog-only and never gated by normalizeToolCall on any backend (see
  // docs/design/agy-adapter.md and docs/design/integration-todo.md), so Antigravity skill calls
  // fall through to ungoverned pass-through, same as any other native tool.
  await runPreToolUse({ toolName, toolInput, sessionId, backendHint: 'antigravity', decideFn: decideAgy });
}

main().catch((err) => {
  log('unexpected error, failing open:', err && err.stack ? err.stack : err);
  decideAgy('allow', 'hook error — fail-open');
});
