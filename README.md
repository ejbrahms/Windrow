# Capability Governance

A registry + broker + usage-event log sitting between agents (Wispfield looms) and the skills /
MCP tools they call, so access is granted on purpose and every call leaves a record. Answers the
question nothing else on this field can: "who used the Gmail MCP last week."

```mermaid
flowchart LR
  Agent[Agent / loom] -->|wants to call a skill or MCP tool| Broker{Capability Broker}
  Broker -->|check| Registry[(Capability Registry)]
  Broker -->|allow| Tool[Skill / MCP tool executes]
  Broker -->|deny / ask| Blocked[Blocked, or human asked]
  Tool --> Events[(Usage Event Log)]
  Blocked --> Events
  Events --> Dash[Dashboard]
```

Full design rationale: [`docs/design/skill-mcp-governance.md`](docs/design/skill-mcp-governance.md).

## The four things being tracked

| Entity | What it is | Example |
|---|---|---|
| **Capability** | One skill or one MCP server/tool | `mcp__claude-design__write_files`, skill `code-review` |
| **Principal** | Who is asking — an agent *role* (default grants) or a specific *instance* (a real loom) | role `design-agent`, loom `claude-msqvb0zl-4` |
| **Grant** | A principal's permission to use a capability, with optional constraints/expiry | rate limit, expiry, read-only-only |
| **UsageEvent** | One invocation: who, what, when, outcome, latency | `denied`, `ok (240ms)`, `error` |

## Status

Real, not a demo: capabilities are discovered from this environment's actual skills/MCPs,
principals map to this field's real loom roster, and enforcement is live — Claude Code's
`PreToolUse`/`PostToolUse` hooks (`server/hooks/`) call the broker on every tool call and log the
real outcome. Destructive-tier capabilities with no active grant surface Claude Code's native
"ask" permission prompt instead of a silent deny, so the human answers on the loom's own card. A
second backend, Antigravity, is wired the same way (`server/hooks/agy-*.js`, see
[`docs/design/agy-adapter.md`](docs/design/agy-adapter.md)) — smoke-tested, not yet run against a
live Antigravity loom. A third, Codex CLI (`server/hooks/codex-*.js`), is scaffolded the same way
but unverified against Codex's real hook contract. See
[`docs/design/integration-todo.md`](docs/design/integration-todo.md)
for the full roadmap (items 1–8 done, item 9 — multi-backend — in progress) and
[`docs/design/deployment-boundary-decision.md`](docs/design/deployment-boundary-decision.md)
for the per-field-vs-shared tradeoff and this workspace's actual choice (shared — see below).

Usage that used to be invisible is now tracked too: any process with no Wispfield loom id (a bare
terminal running Claude Code, Antigravity, or Codex) resolves to a real "standalone" principal
instead of going ungoverned. See
[`docs/design/cross-field-and-standalone.md`](docs/design/cross-field-and-standalone.md) for that,
plus the **Fleet** dashboard page (per-field rollup + standalone breakdown) it's still useful for.

**This server is shared across every field on this machine**, not just `windrow` — other
fields (`infrastructure`) point their own hooks at this `server/hooks/*.js` by absolute path
instead of running their own copy, so all their governed usage lands in this same
`governance.db` too. See the `deploy-capability-governance-server` skill (user skills dir) to
wire up another field, or to see the per-field-isolation alternative this workspace didn't pick.

## Layout

```
server/            Express + SQLite API — registry, broker, usage log
  app.js             route wiring
  store.js           SQLite store (server/data/governance.db)
  auth.js            bearer-token check (server/data/api-token)
  config.js           discovery + hook-install paths, overridable via env var
  discovery/          scans skills + MCP config to build the capability catalog
  principals/          maps real Wispfield loom identities to principals
  hooks/               PreToolUse/PostToolUse — the real enforcement point
  rollup/              cross-field usage rollup, read-only against other fields' db files (Fleet page)
  daemon/              Windows-service wrapper files (winsw), written by service:install
  seed.js             one-time bootstrap of capabilities/principals (no fake usage events)
  migrate-json-to-sqlite.js   one-time import from the old db.json store
  backfill-inherited-grants.js   one-time backfill of inherited grants for pre-existing principals

client/             React + Vite dashboard
  src/pages/           Dashboard, Capability Catalog, Grants, Principals, Fleet, Docs
  src/components/       charts, stat tiles, invoke panel, and other shared UI
  src/api/             typed fetch client against the server API

mcp/                MCP server exposing the governance API as tools (mcp/README.md) — query and
                     manage capabilities/principals/grants/usage from inside a conversation
                     instead of curl or the dashboard. Registered project-wide via `.mcp.json`.

docs/design/        design docs — read these for the "why", not just the "what"
```

## Quality-of-life tools for agents on this field

Two things make working with this registry from inside Wispfield nicer than hitting the REST API
directly:

- **`governance` MCP server** (`mcp/`) — tools like `who_can_use`, `whoami`, `get_drift`,
  `get_usage_summary`, `grant_capability`/`revoke_grant`. See [`mcp/README.md`](mcp/README.md).
- **Skills** — `governance-lookup` (project skill, answers registry questions inline using the MCP
  tools above) and `open-capabilities-dashboard` (user skill, opens the real dashboard as a field
  card instead of a browser tab). Use the lookup skill for a specific answer folded into
  conversation; the dashboard skill when the ask is to actually *see* charts or tables.

## Running it

```bash
# server (http://localhost:4000/api)
cd server
npm install
npm run seed     # first run only: bootstrap capabilities + principals
npm start

# client (http://localhost:5173, proxies /api to :4000)
cd client
npm install
npm run dev
```

The API bearer token is generated on first server run into `server/data/api-token` (gitignored)
and read automatically by the Vite dev proxy and the governance hooks — no manual configuration
needed in dev. Every request needs `Authorization: Bearer <token>`; see
[`docs/design/api-contract.md`](docs/design/api-contract.md) for the full endpoint list, request/response
shapes, and the principal-mapping scheme.

### Running as a Windows service

Production deployment on this machine is the combined build (`npm run build` then `npm start` at
the repo root), registered as a Windows service so it starts on boot and restarts on crash instead
of only running in a terminal someone leaves open:

```bash
npm install                # once: pulls in node-windows
npm run build               # builds client/dist with the real API token baked in
npm run service:install      # from an ELEVATED (Run as Administrator) terminal
```

Or just double-click **`install-service.bat`** at the repo root — it re-launches itself elevated
(prompting for UAC) if it isn't already, then runs `npm run service:install` for you.
`uninstall-service.bat` does the same for removal.

`service:install` registers a service named `CapabilityGovernance` running `server/index.js`
(API + `client/dist` on `http://localhost:4000`) and starts it immediately. It must be run
elevated — the Windows Service Control Manager rejects service creation from a non-admin process,
which is why this repo can prepare the service scripts but can't register the service itself.
`npm run service:uninstall` (also elevated) removes it. Manage it afterwards like any other
Windows service — `services.msc`, or `sc query CapabilityGovernance` / `sc stop
CapabilityGovernance` from an admin shell.

## Design docs

- [`docs/design/skill-mcp-governance.md`](docs/design/skill-mcp-governance.md) — why this exists, the data model, the broker sequence.
- [`docs/design/api-contract.md`](docs/design/api-contract.md) — endpoints, store shape, auth, principal mapping.
- [`docs/design/integration-todo.md`](docs/design/integration-todo.md) — the roadmap from "hardcoded seed data" to real enforcement, item by item.
- [`docs/design/deployment-boundary-decision.md`](docs/design/deployment-boundary-decision.md) — why per-field, not one central server, for now.
- [`docs/design/agy-adapter.md`](docs/design/agy-adapter.md) — the second enforcement backend: Antigravity's own PreToolUse/PostToolUse hooks.
- [`docs/design/cross-field-and-standalone.md`](docs/design/cross-field-and-standalone.md) — tracking usage across multiple fields (Fleet page) and standalone usage outside Wispfield.
- [`docs/design/governance-vulnerability-review.md`](docs/design/governance-vulnerability-review.md) — attack-surface review of the broker/hooks/API as currently built, ranked by severity.
