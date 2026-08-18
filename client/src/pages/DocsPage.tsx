const ENTITIES: { name: string; what: string; example: string }[] = [
  { name: "Capability", what: "One skill or one MCP server/tool", example: "mcp__claude-design__write_files, skill code-review" },
  {
    name: "Principal",
    what: "Who is asking — an agent role (default grants) or a specific instance (a real running agent)",
    example: "role design-agent, instance claude-msqvb0zl-4",
  },
  { name: "Grant", what: "A principal's permission to use a capability, with optional constraints/expiry", example: "rate limit, expiry, read-only-only" },
  { name: "UsageEvent", what: "One invocation: who, what, when, outcome, latency", example: "denied, ok (240ms), error" },
];

const DESIGN_DOCS: { path: string; blurb: string }[] = [
  { path: "docs/design/skill-mcp-governance.md", blurb: "Why this exists, the data model, the broker sequence." },
  { path: "docs/design/api-contract.md", blurb: "Endpoints, store shape, auth, principal mapping." },
  { path: "docs/design/integration-todo.md", blurb: "The roadmap from hardcoded seed data to real enforcement, item by item." },
  { path: "docs/design/deployment-boundary-decision.md", blurb: "Why per-workspace, not one central server, for now." },
  { path: "docs/design/agy-adapter.md", blurb: "The second enforcement backend: Antigravity's own PreToolUse/PostToolUse hooks." },
  { path: "docs/design/cross-field-and-standalone.md", blurb: "Tracking usage across multiple workspaces (Fleet page) and standalone Claude/agy/codex usage outside any tracked agent runtime." },
  { path: "docs/design/governance-vulnerability-review.md", blurb: "Attack-surface review of the broker/hooks/API as currently built, ranked by severity." },
  { path: "docs/design/adding-a-provider.md", blurb: "Step-by-step workflow for wiring up a new backend adapter." },
  { path: "docs/design/unified-interception.md", blurb: "Whether there's a better interception point than per-provider hook JSON, and what's still manual today." },
];

const ENV_VARS: { name: string; purpose: string; fallback: string }[] = [
  { name: "SKILL_DIRS", purpose: "`;`-separated directories scanned for SKILL.md files", fallback: "this workspace's Claude Code + Antigravity skill dirs" },
  { name: "HOOK_INSTALL_PATHS", purpose: "JSON object overriding where each backend's hook config lives", fallback: "user-level settings.json (Claude), ~/.gemini/config/hooks.json (agy)" },
  { name: "PORT", purpose: "Port the combined server (API + built client) listens on", fallback: "4000" },
];

export function DocsPage() {
  return (
    <div className="page docs-page">
      <div className="page-header">
        <div>
          <h1>Documentation</h1>
          <p>What this system is, how it's built, and how to run it.</p>
        </div>
      </div>

      <div className="card docs-prose">
        <p>
          A registry + broker + usage-event log sitting between agents and the
          skills / MCP tools they call, so access is granted on purpose and every call leaves a
          record. Answers the question nothing else in your agent stack can: "who used the Gmail MCP
          last week."
        </p>
        <pre className="docs-diagram">
{`Agent -> wants to call a skill or MCP tool -> Capability Broker
Broker -> check -> Capability Registry
Broker -> allow -> Skill / MCP tool executes -> Usage Event Log
Broker -> deny / ask -> Blocked, or human asked   -> Usage Event Log
Usage Event Log -> Dashboard`}
        </pre>
      </div>

      <div className="card">
        <h2>The four things being tracked</h2>
        <table className="cap-table">
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "50%" }} />
            <col style={{ width: "34%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Entity</th>
              <th>What it is</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {ENTITIES.map((e) => (
              <tr key={e.name}>
                <td>
                  <strong>{e.name}</strong>
                </td>
                <td className="muted">{e.what}</td>
                <td className="muted">{e.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card docs-prose">
        <h2>Status</h2>
        <p>
          Real, not a demo: capabilities are discovered from this environment's actual
          skills/MCPs, principals map to this workspace's real agent roster, and enforcement is live —
          Claude Code's <code>PreToolUse</code>/<code>PostToolUse</code> hooks (
          <code>server/hooks/</code>) call the broker on every tool call and log the real outcome.
          Destructive-tier capabilities with no active grant surface Claude Code's native "ask"
          permission prompt instead of a silent deny, so the human answers inline where the agent is
          running.
        </p>
      </div>

      <div className="card docs-prose">
        <h2>Layout</h2>
        <pre className="docs-diagram">
{`server/            Express + SQLite API — registry, broker, usage log
  app.js             route wiring
  store.js           SQLite store (server/data/governance.db)
  auth.js            bearer-token check (server/data/api-token)
  config.js           discovery + hook-install paths, overridable via env var
  discovery/          scans skills + MCP config to build the capability catalog
  principals/          maps real agent-runtime identities to principals
  hooks/               PreToolUse/PostToolUse — the real enforcement point
  rollup/              cross-workspace usage rollup, read-only against other workspaces' db files (Fleet page)
  daemon/              Windows-service wrapper files (winsw), written by service:install
  seed.js             one-time bootstrap of capabilities/principals
  migrate-json-to-sqlite.js   one-time import from the old db.json store

client/             React + Vite dashboard
  src/pages/           Dashboard, Capability Catalog, Grants, Principals, Fleet, Docs
  src/components/       charts, stat tiles, invoke panel, and other shared UI
  src/api/             typed fetch client against the server API

docs/design/        design docs — read these for the "why", not just the "what"`}
        </pre>
      </div>

      <div className="card docs-prose">
        <h2>Setup</h2>
        <p>
          <strong>Prerequisites:</strong> Node.js 18+ and npm. Windows is only required for the
          service-install path below — the server and client themselves are plain Node/Vite and
          run fine in dev mode on any OS. There's no external database to provision; SQLite lives
          in a single file (<code>server/data/governance.db</code>) created on first run.
        </p>
        <pre className="docs-diagram">
{`git clone <this repo>
cd windrow
npm run install:all   # npm install in both server/ and client/, from the repo root

# terminal 1 — server (http://localhost:4000/api)
cd server
npm run seed     # first run only: bootstrap capabilities + principals from this environment
npm start

# terminal 2 — client (http://localhost:5173, proxies /api to :4000)
cd client
npm run dev`}
        </pre>
        <p>
          Open <code>http://localhost:5173</code> — the dashboard should load with the
          capabilities/principals <code>npm run seed</code> just created. The in-app{" "}
          <strong>Setup guide</strong> (top nav) walks through the same steps interactively if
          anything looks empty.
        </p>
        <p>
          What happens on that first run, in order: (1) <code>npm run seed</code> reads this
          environment's actual skills directories and MCP config to populate the capability
          catalog and creates default role principals — no fake/demo data; (2) <code>npm
          start</code> creates <code>governance.db</code> if it doesn't exist and generates a
          random API bearer token into <code>server/data/api-token</code> (gitignored) if that
          file is missing; (3) the Vite dev proxy reads the same token file automatically, so the
          client authenticates without manual config. Every request needs{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        <p>
          The dashboard and API work standalone, but nothing is actually <em>enforced</em> until
          the PreToolUse/PostToolUse hooks (<code>server/hooks/</code>) are wired into an agent
          backend's own hook config. That wiring is a separate step, done by the{" "}
          <code>deploy-capability-governance-server</code> skill rather than by <code>npm
          start</code> itself.
        </p>
      </div>

      <div className="card">
        <h2>Configuration</h2>
        <p className="muted">
          All optional — an unconfigured server behaves exactly as this workspace already does.
        </p>
        <table className="cap-table">
          <colgroup>
            <col style={{ width: "22%" }} />
            <col style={{ width: "45%" }} />
            <col style={{ width: "33%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Env var</th>
              <th>Purpose</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map((v) => (
              <tr key={v.name}>
                <td>
                  <code>{v.name}</code>
                </td>
                <td className="muted">{v.purpose}</td>
                <td className="muted">{v.fallback}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Design docs</h2>
        <table className="cap-table">
          <colgroup>
            <col style={{ width: "35%" }} />
            <col style={{ width: "65%" }} />
          </colgroup>
          <tbody>
            {DESIGN_DOCS.map((d) => (
              <tr key={d.path}>
                <td>
                  <code>{d.path}</code>
                </td>
                <td className="muted">{d.blurb}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
