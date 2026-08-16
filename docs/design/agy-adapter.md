# The Antigravity ("agy") enforcement adapter

> Extends `docs/design/skill-mcp-governance.md` item 3 (real enforcement) to a second backend.
> Everything in that doc about the registry/broker/usage-log stays true unchanged — this only
> adds a second edge that calls the same broker.

## Why this was needed

`server/hooks/pre-tool-use.js` / `post-tool-use.js` are written against **Claude Code's own**
`PreToolUse`/`PostToolUse` hook contract — the JSON shape it feeds a hook process on stdin and
expects back on stdout. That contract is Claude Code's, not the broker's. An agent whose `backend`
is `antigravity` (`LOOM_PROVIDER=antigravity`, set by the platform — see
`server/principals/fromEnv.js`) was a correctly-attributed principal but had **no enforcement
path at all**: nothing ever called the broker for its tool calls. Ungoverned, not denied — an
invisible gap, not a safe default.

Antigravity CLI turns out to have its own `PreToolUse`/`PostToolUse` hook mechanism, close enough
in shape (stdin JSON in, stdout JSON decision out, `allow`/`deny`/`ask` vocabulary) that the same
broker logic reuses almost unchanged — only the edges differ.

Sources: [Antigravity hooks docs](https://antigravity.google/docs/hooks) (JSON schema below),
[atamel.dev — where agy looks for hooks](https://atamel.dev/posts/2026/07-16_where_agy_hooks/)
(config file locations).

## What's shared vs. what's per-backend

```mermaid
flowchart LR
  subgraph Claude adapter
    CPre[pre-tool-use.js] --> Core
    CPost[post-tool-use.js] --> Core
  end
  subgraph Antigravity adapter
    APre[agy-pre-tool-use.js] --> Core
    APost[agy-post-tool-use.js] --> Core
  end
  Core[server/hooks/lib.js\nfindCapability / resolvePrincipal / invoke\nfail-open/closed policy] --> API[Governance API]
```

`server/hooks/lib.js` already didn't know about Claude Code except in two spots:
- `decide()` — prints Claude's `{hookSpecificOutput: {hookEventName, permissionDecision, ...}}`
  envelope. Left untouched; added a sibling `decideAgy()` for Antigravity's flatter
  `{decision, reason}` shape.
- `readHookInput()`, `normalizeToolCall()`, `findCapability()`, `resolvePrincipal()`, `invoke()`,
  `patchUsageEvent()`, `pendingKey()` — all backend-agnostic already (they operate on plain
  strings/objects the caller extracts, or on the platform's own env vars, which are backend-neutral
  by construction). Reused as-is by both adapters.

So the new files are thin: `server/hooks/agy-pre-tool-use.js` / `agy-post-tool-use.js` just pull
`toolName`/`toolInput`/`sessionId` out of Antigravity's differently-shaped input and hand them to
the same core functions the Claude adapter calls.

## Antigravity's hook contract (as used here)

Config (`~/.gemini/config/hooks.json`, user-level — moved off the project-local
`.agents/hooks.json` once a confirmed global equivalent turned up, same reasoning as the Claude
adapter's move to a user-level `settings.json`; see
[plugin docs](https://antigravity.google/docs/cli/plugins) and
[atamel.dev](https://atamel.dev/posts/2026/07-16_where_agy_hooks/)):

```json
{
  "capability-governance": {
    "enabled": true,
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:\\...\\windrow\\server\\hooks\\agy-pre-tool-use.js\"" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:\\...\\windrow\\server\\hooks\\agy-post-tool-use.js\"" }] }]
  }
}
```

PreToolUse stdin:
```json
{ "toolCall": { "name": "...", "args": {} }, "stepIdx": 5, "conversationId": "uuid",
  "workspacePaths": ["..."], "transcriptPath": "...", "modelName": "..." }
```
PreToolUse stdout: `{ "decision": "allow|deny|ask|force_ask|deny_unless_prior_grant", "reason": "..." }`
— the adapter only ever emits `allow`/`deny`/`ask`, matching the Claude adapter's vocabulary;
`force_ask`/`deny_unless_prior_grant` have no equivalent in the broker's model and aren't used.

PostToolUse stdin adds `error` (a string, empty/absent on success) in place of Claude's
`tool_response` object — that's the one real shape difference `agy-post-tool-use.js` accounts for.

`conversationId` stands in for Claude's `session_id` as the task/turn correlation boundary;
`correlationId` construction (agent name + node id, both platform-set env vars, backend-neutral)
is unchanged from the Claude adapter.

## Principal mapping

`server/principals/fromEnv.js`'s `deriveAgentType()` previously fell back to
`` `${LOOM_PROVIDER}-unknown` `` for any backend it hadn't mapped. Added an explicit case:
`LOOM_PROVIDER === 'antigravity'` → `agentType: 'antigravity'`. `backend` was already correctly
populated for every agent regardless of this mapping — this only fixes the `agentType` grouping the
dashboard/drift views use.

## Open questions / unverified

- **Skill-call shape — moot, not open.** `normalizeToolCall()`'s `toolName === 'Skill'` branch (a
  Claude Code convention; the `Skill` tool took a `{skill: "..."}` arg) predated the skills/tools
  split documented in `docs/design/skill-mcp-governance.md` §0: skills have no per-call
  `PreToolUse` choke point on any backend, so they're never granted or logged regardless of
  whether a given backend's skill-call shape matches this branch. Whether Antigravity even
  surfaces a distinct skill tool call was never confirmed, and now doesn't need to be — there's no
  cross-backend skill-call shape left to verify. The `Skill` branch itself has since been removed
  from `server/hooks/lib.js` as dead code.
- **MCP tool naming** (`mcp__<server>__<tool>`) is assumed unchanged across backends since it's
  an MCP-protocol convention, not a Claude Code one — confirmed by matching the Claude adapter's
  existing regex logic, not independently verified against a live Antigravity MCP call.
- **Env vars available to the hook process.** Antigravity's own docs don't list what env vars a
  hook process inherits beyond stdin; this adapter relies entirely on the platform's own
  `LOOM_NODE_ID`/`LOOM_AGENT_NAME`/`LOOM_PROVIDER` (set on the agent process itself, inherited by
  any child it spawns) rather than anything Antigravity-specific, so this should hold regardless.

## Smoke-tested (not yet run against a live Antigravity agent)

Ran `agy-pre-tool-use.js`/`agy-post-tool-use.js` directly with simulated stdin against the real
running governance API (`server/index.js` on `localhost:4000`), with `LOOM_PROVIDER=antigravity`
env set: confirmed real capability lookup, real principal creation (`backend: antigravity`), real
deny for an ungranted mutating capability, real `ask` for an ungranted destructive one, real allow
+ usage-event outcome patch for a granted read-only MCP tool, and silent pass-through for an
unregistered native tool (`run_command`). (The "skill" case originally exercised here used the
now-legacy `Skill` branch — see "Skill-call shape" above; skills aren't governed, so that part of
the smoke test no longer represents a real enforcement path.) Not yet exercised by an actual
Antigravity CLI process — the `.agents/hooks.json` wiring is unverified against the real harness
invoking it.
