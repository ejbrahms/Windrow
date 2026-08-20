# Governance MCP server

An MCP server that exposes the capability-governance API (registry + broker + usage-event log,
see [`../docs/design/skill-mcp-governance.md`](../docs/design/skill-mcp-governance.md)) as tools,
so an agent can ask the registry a question or make a change directly
from a conversation, instead of shelling out to `curl` or context-switching to the dashboard.

It's a companion to the `open-capabilities-dashboard` skill, not a replacement: that skill is for
*looking* (opens the real charts/tables as a live view); this is for *asking and acting* inline
— "who can use `wispfield_clear_field`", "what's my own principal's access", "grant Zoe the
`dataviz` skill", "what's denied a lot lately."

## Setup

Registered project-wide via `.mcp.json` at the repo root — nothing to install per agent beyond
`npm install` in this directory (already done for this checkout):

```json
{ "mcpServers": { "governance": { "command": "node", "args": ["mcp/server.js"] } } }
```

It talks to the governance API at `http://localhost:4000/api` using the **admin** token
(`server/data/api-token`, gitignored, generated on first `npm start` in `server/`) — same trust
boundary as the dashboard build. `grant_capability`/`revoke_grant` are the exception: they use the
separate **proposer** token (`server/data/proposer-api-token`) instead, which can only queue a
pending-approval request, not write a grant directly (see below). Override with env vars if needed:

- `WINDROW_API_URL` — point at a different host/port (e.g. a shared instance on another machine)
- `WINDROW_API_TOKEN` — use a specific token instead of reading the admin token file
- `WINDROW_PROPOSER_TOKEN` — use a specific token instead of reading the proposer token file

The governance server must be running (`npm start` in `server/`, or the `CapabilityGovernance`
Windows service) — every tool call fails with a clear "is the server running?" error otherwise,
not a silent hang.

## Tools

| Tool | What it answers | Mutates? |
|---|---|---|
| `list_capabilities` | What could an agent do (filter by kind/riskTier/owner) | no |
| `list_principals` | Who's in the registry — roles and real agent instances | no |
| `whoami` | What am I (the calling process), and do I have a principal yet | no |
| `list_grants` | Who's allowed what (filter by principal/capability) | no |
| `who_can_use` | "Who has access to X" by capability name or id, incl. role-inherited access | no |
| `get_usage` | Recent invocation log, filterable | no |
| `get_usage_summary` | Totals/by-capability/by-principal/by-time-bucket over a window | no |
| `get_drift` | Unused grants (90d+) and high-denial capabilities | no |
| `get_fleet_summary` | Cross-workspace + standalone rollup (this server is shared across workspaces) | no |
| `grant_capability` | Proposes a grant — queues a pending approval, grants nothing itself | **yes** — confirm first |
| `revoke_grant` | Proposes revoking a grant — queues a pending approval, revokes nothing itself | **yes** — confirm first |

`grant_capability`/`revoke_grant` are tiered `destructive` and left off every package's default
include-list (`server/packages.js`) — no role gets them for free, and even a role that does hold a
grant for one can only *propose* a change (`docs/design/governance-review-2026-08-16.md`, F1). A
human clears the request from the dashboard's **Approvals** page before it becomes a real grant or
revoke; nothing this MCP server calls writes to the `grants` table directly. They're also
intentionally left off the project's Bash/tool allowlist (`.claude/settings.json`) so they prompt
for confirmation like any other destructive action.

## Manual smoke test

```bash
cd mcp && node smoke-test.js
```

Spawns the server over stdio via the MCP SDK's own client, lists tools, and calls a couple of
read-only ones against whatever `governance.db` is live. Not part of the server's runtime — a dev
sanity check, safe to delete.
