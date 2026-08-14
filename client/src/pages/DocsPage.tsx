const ENTITIES: { name: string; what: string; example: string }[] = [
  { name: "Capability", what: "One skill or one MCP server/tool", example: "mcp__claude-design__write_files, skill code-review" },
  {
    name: "Principal",
    what: "Who is asking — an agent role (default grants) or a specific instance (a real loom)",
    example: "role design-agent, loom claude-msqvb0zl-4",
  },
  { name: "Grant", what: "A principal's permission to use a capability, with optional constraints/expiry", example: "rate limit, expiry, read-only-only" },
  { name: "UsageEvent", what: "One invocation: who, what, when, outcome, latency", example: "denied, ok (240ms), error" },
];

const DESIGN_DOCS: { path: string; blurb: string }[] = [
  { path: "docs/design/skill-mcp-governance.md", blurb: "Why this exists, the data model, the broker sequence." },
  { path: "docs/design/api-contract.md", blurb: "Endpoints, store shape, auth, principal mapping." },
  { path: "docs/design/integration-todo.md", blurb: "The roadmap from hardcoded seed data to real enforcement, item by item." },
  { path: "docs/design/deployment-boundary-decision.md", blurb: "Why per-field, not one central server, for now." },
  { path: "docs/design/agy-adapter.md", blurb: "The second enforcement backend: Antigravity's own PreToolUse/PostToolUse hooks." },
  { path: "docs/design/cross-field-and-standalone.md", blurb: "Tracking usage across multiple fields (Fleet page) and standalone Claude/agy/codex usage outside Wispfield." },
  { path: "docs/design/governance-vulnerability-review.md", blurb: "Attack-surface review of the broker/hooks/API as currently built, ranked by severity." },
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
          A registry + broker + usage-event log sitting between agents (Wispfield looms) and the
          skills / MCP tools they call, so access is granted on purpose and every call leaves a
          record. Answers the question nothing else on this field can: "who used the Gmail MCP
          last week."
        </p>
        <pre className="docs-diagram">
{`Agent / loom -> wants to call a skill or MCP tool -> Capability Broker
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
          skills/MCPs, principals map to this field's real loom roster, and enforcement is live —
          Claude Code's <code>PreToolUse</code>/<code>PostToolUse</code> hooks (
          <code>server/hooks/</code>) call the broker on every tool call and log the real outcome.
          Destructive-tier capabilities with no active grant surface Claude Code's native "ask"
          permission prompt instead of a silent deny, so the human answers on the loom's own card.
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
  principals/          maps real Wispfield loom identities to principals
  hooks/               PreToolUse/PostToolUse — the real enforcement point
  rollup/              cross-field usage rollup, read-only against other fields' db files (Fleet page)
  daemon/              Windows-service wrapper files (winsw), written by service:install
  seed.js             one-time bootstrap of capabilities/principals
  migrate-json-to-sqlite.js   one-time import from the old db.json store
  backfill-inherited-grants.js   one-time backfill of inherited grants for pre-existing principals

client/             React + Vite dashboard
  src/pages/           Dashboard, Capability Catalog, Grants, Principals, Fleet, Docs
  src/components/       charts, stat tiles, invoke panel, and other shared UI
  src/api/             typed fetch client against the server API

docs/design/        design docs — read these for the "why", not just the "what"`}
        </pre>
      </div>

      <div className="card docs-prose">
        <h2>Running it</h2>
        <pre className="docs-diagram">
{`# server (http://localhost:4000/api)
cd server
npm install
npm run seed     # first run only: bootstrap capabilities + principals
npm start

# client (http://localhost:5173, proxies /api to :4000)
cd client
npm install
npm run dev`}
        </pre>
        <p>
          The API bearer token is generated on first server run into{" "}
          <code>server/data/api-token</code> (gitignored) and read automatically by the Vite dev
          proxy and the governance hooks — no manual configuration needed in dev. Every request
          needs <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
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
