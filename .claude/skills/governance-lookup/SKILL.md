---
name: governance-lookup
description: Use when asked a question the capability-governance registry can answer directly — "who can use X", "what am I allowed to do", "what's stale/unused", "what happened this week", or to grant/revoke access — without opening the dashboard. Pairs with open-capabilities-dashboard for the visual view.
---

# Governance lookup

Answers registry questions inline, using the `governance` MCP server (`mcp/server.js`) instead of
`curl` or the dashboard. Use `open-capabilities-dashboard` instead when the ask is genuinely to
*see* something (charts, tables) rather than get a specific answer folded into the conversation.

## 1. Pick the tool for the question

| Question | Tool |
|---|---|
| "What can [role/agent] do?" / "what's granted to X" | `list_grants` with `principalId`, or `list_principals` first if you only have a name |
| "Who can use [capability]?" / "who has access to X" | `who_can_use` — resolves by name, includes role-inherited access |
| "What am I allowed to do right now?" (the calling agent itself) | `whoami`, then `list_grants` with the returned `principal.id` |
| "What capabilities exist?" / "what's destructive?" | `list_capabilities`, filter by `riskTier`/`kind`/`owner` |
| "What happened this week / today?" | `get_usage_summary` (set `windowMinutes`/`granularity`) |
| "What's been denied / who tried X and failed?" | `get_usage` filtered by `principalId`/`capabilityId`, look for `outcome: "denied"` |
| "What's stale or worth pruning?" | `get_drift` — unused grants (90d+), high-denial capabilities |
| "How's usage across workspaces, not just this one?" | `get_fleet_summary` — this server is shared across the machine |

If a question names a principal or capability by human name rather than id, resolve it first
(`list_principals`/`list_capabilities` with `search`/name filter) — every write tool and most read
tools take an id, not a display name.

## 2. Granting or revoking access

`grant_capability` and `revoke_grant` are mutating and **not** on the project's auto-allow list —
Claude Code will prompt for confirmation on the tool call itself. Still, narrate what's about to
happen before calling (principal, capability, risk tier) so the confirmation prompt isn't the
first the human hears of it — check the capability's `riskTier` via `list_capabilities` first, and
say so out loud if it's `destructive` (e.g. "this grants Zoe `wispfield_clear_field`, a destructive
capability — proceed?").

Don't grant/revoke on a guess: if the human said a name that doesn't resolve to exactly one
principal or capability, list the candidates and ask which one rather than picking the first match.

## 3. When to reach for the dashboard instead

Numbers alone don't always answer "why does this look off" — if a usage or drift question turns
into "show me the trend" or the human asks to *see* something, hand off to
`open-capabilities-dashboard` rather than trying to render a chart in text.
