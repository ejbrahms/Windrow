# Windrow — API contract (v1)

Backend: Node + Express, SQLite store (`better-sqlite3`, `server/data/governance.db`) — replaced
the original JSON-file store (`server/data/db.json`), which had no real atomicity: a
load-whole-file/mutate/save-whole-file cycle meant two concurrent writes could silently lose one
of them. See `server/store.js`. A one-time migration (`npm run migrate`) imports an existing
`db.json` and renames it to `db.json.bak`.

Base URL: `http://localhost:4000/api`. Frontend dev server proxies `/api/*` to it.

## Auth

Every request requires `Authorization: Bearer <token>` (`server/auth.js`) — CORS alone (below)
only restricts which *browser origins* can call the API; it does nothing against a same-machine
process (curl, another local tool) hitting `:4000` directly, which is how "anything on localhost
can self-grant" happened. The token is generated on first run into `server/data/api-token`
(gitignored) or read from `GOVERNANCE_API_TOKEN`. The Vite dev proxy and the governance hooks
(`server/hooks/lib.js`) read the same on-disk token so nothing needs manual configuration in dev.

Store shape (conceptual — see `server/store.js` for the actual SQLite schema):

> [!note]
> `capabilities.kind` still carries `"skill"` as a value, but a `skill`-kind row is catalog-only —
> see `docs/design/skill-mcp-governance.md` §0. It's discovered and browsable like any other
> capability, but no `grants` or `usageEvents` row is ever created against it in practice, since
> there's no per-call hook to enforce or log a skill invocation. `riskTier` on a skill row is
> descriptive metadata for the catalog view, not an active grant policy.

```json
{
  "capabilities": [
    { "id": "cap_...", "kind": "skill|mcp_tool", "name": "code-review",
      "owner": "platform", "riskTier": "read_only|mutating|destructive",
      "description": "..." }
  ],
  "principals": [
    { "id": "pr_...", "kind": "role|instance", "name": "design-agent", "parentRole": null }
  ],
  "grants": [
    { "id": "gr_...", "principalId": "pr_...", "capabilityId": "cap_...",
      "constraints": null, "createdAt": "iso", "expiresAt": null }
  ],
  "usageEvents": [
    { "id": "ev_...", "principalId": "pr_...", "capabilityId": "cap_...",
      "ts": "iso", "outcome": "ok|denied|error", "latencyMs": 240,
      "correlationId": null, "reason": null,
      "osUser": "ejbra", "hostname": "DESKTOP-..." }
  ]
}
```

IDs: `<prefix>_<12 hex chars>`. All list endpoints return arrays sorted newest-first where a
timestamp exists, otherwise by name.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/capabilities` | – | `Capability[]` |
| POST | `/capabilities` | `{kind,name,owner,riskTier,description}` | created `Capability`, 201 |
| GET | `/principals` | – | `Principal[]` |
| POST | `/principals` | `{kind,name,parentRole?}` | created `Principal`, 201 |
| GET | `/grants` | query `?principalId=&capabilityId=` | `Grant[]` |
| POST | `/grants` | `{principalId,capabilityId,constraints?,expiresAt?}` | created `Grant`, 201. 409 if a grant for that pair already exists |
| DELETE | `/grants/:id` | – | 204 |
| POST | `/invoke` | `{principalId,capabilityId,correlationId?,osUser?,hostname?}` | `{allowed:boolean, event:UsageEvent}` — this **is** the broker: look up an active (non-expired) grant for the pair, log a `UsageEvent` with outcome `ok` (allowed) or `denied` (no grant), and return it. Latency is simulated (random 40–400ms) since there's no real tool behind it. `osUser`/`hostname` are the real computer account/machine that issued the call — forwarded by the PreToolUse hook (`server/hooks/lib.js`'s `resolvePrincipal`/`invoke`, sourced from `server/principals/fromEnv.js`'s `identityFromEnv`, itself `env.USERNAME`/`env.USER` falling back to live `os.userInfo()`); null when there's no hook behind the call, e.g. a manual invoke from the dashboard's own Invoke panel. |
| GET | `/usage` | query `?principalId=&capabilityId=&limit=` (default 200) | `UsageEvent[]`, newest first |
| GET | `/usage/summary` | – | see below |
| GET | `/drift` | – | see below |

`GET /usage/summary` returns:
```json
{
  "totals": { "calls": 0, "denied": 0, "denialRate": 0, "avgLatencyMs": 0 },
  "byCapability": [ { "capabilityId": "...", "name": "...", "calls": 0, "denied": 0, "avgLatencyMs": 0 } ],
  "byPrincipal": [ { "principalId": "...", "name": "...", "calls": 0, "denied": 0 } ],
  "byDay": [ { "date": "YYYY-MM-DD", "calls": 0, "denied": 0 } ]
}
```
`byDay` covers the last 14 days including days with zero events.

`GET /drift` returns:
```json
{
  "unusedGrants": [ { "grantId": "...", "principalName": "...", "capabilityName": "...", "grantedAt": "iso" } ],
  "highDenial": [ { "capabilityId": "...", "name": "...", "denialRate": 0.0, "calls": 0 } ]
}
```
`unusedGrants` = grants with zero matching `usageEvents`. `highDenial` = capabilities with ≥5 calls
and a denial rate ≥ 0.2, sorted worst first.

## Skills management (`server/skills.js`)

Skills are catalog-only (§0 of `docs/design/skill-mcp-governance.md`) — no grants, no usage
tracking — so they get their own write path instead of living under `/grants`. `GET
/capabilities` (filtered client-side to `kind==="skill"`) is still the read side.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/skills/targets` | – | `{id,label,path,exists}[]` — the provider skill directories a skill can be written into |
| GET | `/skills/:name/presence` | – | `{id,label,path,present}[]` — which targets currently have this skill's `SKILL.md` on disk |
| POST | `/skills` | `{name,description?,targetIds}` | `{slug,written,discovery}`, 201 — writes `SKILL.md` under `<target>/<slug>/` for each requested target, then re-runs discovery so it's in the catalog immediately |
| DELETE | `/skills/:name` | `{targetIds?}` (omit for "everywhere") | `{slug,removed,discovery}` — deletes `<target>/<slug>/`, then re-runs discovery so a skill removed everywhere goes stale on the next scan same as any other vanished `SKILL.md` |

## Risk tiers (validation)

`riskTier` is one of `read_only`, `mutating`, `destructive` — reject anything else with 400.
No other server-side policy is enforced on tier (the UI is where destructive grants get a
confirmation step); the server just stores and reports.

## CORS / dev

Enable CORS for `http://localhost:5173` (Vite default) so the frontend can be run standalone
during development even without the proxy.

## Seed data (`server/seed.js`, run via `npm run seed`)

Populate `capabilities` from the real skill/MCP surface of this environment (not placeholders):

- **Skills** (`kind: "skill"`, owner `platform`): `code-review` (mutating — can post/apply fixes),
  `simplify` (mutating), `security-review` (read_only), `dataviz` (read_only), `run` (mutating),
  `update-config` (mutating), `loop` (read_only), `schedule` (mutating), `init` (mutating).
  `riskTier` here is catalog metadata only — per the skills/tools split
  (`docs/design/skill-mcp-governance.md` §0), skill rows aren't gated by a grant, so the tier
  doesn't drive an actual policy the way it does for an MCP tool below.
- **MCP tools** (`kind: "mcp_tool"`), grouped by server:
  - `claude-design`: `read_file`/`list_files`/`list_projects` (read_only, owner `claude-design`),
    `write_files`/`delete_files`/`copy_files` (mutating/destructive respectively).
  - `wispfield`: `wispfield_view`/`wispfield_get_field_status`/`wispfield_recall` (read_only, owner
    `wispfield`), `wispfield_spawn_agent`/`wispfield_dispatch_command`/`wispfield_report_progress`
    (mutating), `wispfield_clear_field`/`wispfield_halt_agents`/`wispfield_close_loom` (destructive).
  - `claude_ai_Gmail`: `search_threads`/`get_message`/`list_labels` (read_only, owner `gmail`),
    `create_draft`/`label_message`/`create_label` (mutating), `trash_message`/`mark_message_spam`
    (destructive).
  - `claude_ai_Google_Drive`: `search_files`/`read_file_content`/`get_file_metadata` (read_only,
    owner `gdrive`), `create_file`/`copy_file` (mutating).

Populate `principals`:
- Roles (`kind: "role"`): `general-purpose`, `Explore`, `Plan`, `design-agent`, `claude`,
  `statusline-setup` (Claude Code's own Task-tool subagent types — manual, no platform identity
  of their own), plus `claudecode` (real top-level agents on the platform — see "Principal mapping (v1)"
  below).
- Instances (`kind: "instance"`, `parentRole` set): real agents from this workspace's actual roster at
  seed time, mapped through `server/principals/registry.js` rather than invented.

Populate `grants` following the design doc's default policy, **for MCP tool capabilities only**
(skills are never granted — see above): read-only capabilities auto-granted to every role that
plausibly needs them; mutating capabilities granted to the roles that do that kind of work
(`design-agent` gets `claude-design` write tools, `claude`/`general-purpose` get platform mutating
tools); destructive capabilities granted sparingly (e.g. only `claude` role gets
`wispfield_clear_field`/`wispfield_halt_agents`; nobody gets `delete_files` by default — leave it
ungranted so the drift/catalog view has something to show).

Populate ~150–300 `usageEvents` spread over the last 14 days across the granted pairs (mostly
`ok`, realistic latency 40–400ms), plus a deliberate handful of `denied` events for capabilities
that are *not* granted to some principal (simulating a principal trying and being blocked) so the
`highDenial` drift view has at least one entry, and leave at least 2–3 grants with zero usage
events so `unusedGrants` has content too.

## Run

```
server:  npm install && npm run seed && npm start   # listens on :4000
         (upgrading an existing checkout with data in server/data/db.json: npm run migrate first)
client:  npm install && npm run dev                  # :5173, proxies /api -> :4000
```

## Discovery (v1) — implements item 1 of docs/design/integration-todo.md

Replaces guessing at what capabilities exist with a real scan of this machine, plus real
historical usage backfilled from Claude Code's own local record. It is intentionally honest
about what it can and can't do yet: skills are discovered by reading actual `SKILL.md` files
on disk; MCP tools are **not** yet introspected live (that needs a `tools/list` JSON-RPC
handshake per server — roadmap item 3 territory) and instead come from a checked-in manifest of
the tools genuinely available in this session. Both are clearly tagged with `source` so nobody
mistakes one for the other.

### Capability field additions

```
source: "filesystem" | "usage-history-only" | "mcp-manifest" | "manual"
discoveredAt: iso   // first time this discovery pipeline saw it
lastSeenAt: iso      // most recent discovery run that saw it
stale: boolean        // true if a previous run found it but the latest run didn't (default false)
realUsage: { usageCount: number, lastUsedAt: iso } | null
  // backfilled from ~/.claude.json's real skillUsage/pluginUsage — Claude Code's own historical
  // record, not this system's UsageEvent log. Only set when a discovered skill name matches.
```

Existing capabilities from the original seed (no `source` field) are treated as `source: "manual"`
on the first discovery run — matched by `(kind, name)` and updated in place, never duplicated.

### Endpoints

| Method | Path | Returns |
|---|---|---|
| POST | `/api/discovery/run` | Runs the scan now. `{added: Capability[], updated: Capability[], staled: Capability[]}` |
| GET | `/api/discovery/last` | Same shape as the last run's result, plus `ranAt: iso` (404 if discovery has never run) |
| GET | `/api/discovery/sources` | `DiscoverySource[]`, each `{id, path, label, kind, enabled, builtIn, createdAt, exists}` — `exists` is computed via `fs.existsSync` at read time |
| POST | `/api/discovery/sources` | `{path, label?, kind?}` → `201 DiscoverySource` (admin-only; `409` on a duplicate path; `kind` is `"skill_dir"` (default) or `"mcp_manifest"`, `400` on anything else) |
| PATCH | `/api/discovery/sources/:id` | `{path?, label?, enabled?}` → updated `DiscoverySource` (admin-only) |
| DELETE | `/api/discovery/sources/:id` | `204` (admin-only) |

### What it scans, on this machine (real, verified paths)

`discovery_sources` rows carry a `kind`: `"skill_dir"` (the historical default — a filesystem root
scanned recursively for SKILL.md files) or `"mcp_manifest"` (a JSON file, same array-of-tool shape
as `server/discovery/known-mcp-tools.json`, that `server/discovery/mcpManifest.js` reads and merges
into the MCP tool list alongside the built-in manifest — see "MCP tools" below). Both kinds share
the same table, add/enable/disable/remove UI on the Sources page, and admin-only mutation
endpoints; `scan.js` only ever reads `kind = 'skill_dir'` rows, `mcpManifest.js` only ever reads
`kind = 'mcp_manifest'` rows.

Skill directories (recursive `**/SKILL.md`) are **manually configurable** from the Sources page in
the client (`server/store.js`'s `discovery_sources` table, `server/discovery/scan.js`'s
`defaultSkillDirs`) — an admin can add, disable, or remove scan roots there without redeploying.
The table is seeded once, the first time it's empty, from `server/config.js`'s `discoveryPaths()`
(env var `SKILL_DIRS`, semicolon-separated, if set), so an unconfigured server keeps scanning
exactly what it always has:
1. `C:\Users\ejbra\.wispfield\skills` — confirmed real, currently 7 skills under a `wispfield/` subdir.
2. `<repo>/.claude/skills` — project skills; doesn't exist yet, scan must skip silently, not error.
3. `C:\Users\ejbra\.claude\skills` — **the "user skills" directory** flagged in the roadmap doc.
   Doesn't exist yet either; same silent-skip requirement, but it's a first-class scan root so
   skills placed there later are picked up with no code change.
4. `<repo>/.agents/skills` — Antigravity ("agy")'s workspace skills, the `.claude/skills` analog
   for the second backend `docs/design/agy-adapter.md` added enforcement for.
5. `C:\Users\ejbra\.gemini\config\skills` — agy's user-level skills directory.
6. `C:\Users\ejbra\.gemini\antigravity-cli\plugins` — agy's installed-plugins directory (bundles
   both tools and skills per plugin, the agy analog of the Claude marketplace clone scanned below).
   None of 4-6 exist on this machine yet; same silent-skip requirement as 2-3.

After that first seed, the table is the source of truth — a row a human deletes or disables there
stays gone across restarts, independent of `SKILL_DIRS`.

Always scanned in addition, not manually configurable (derived per-machine, not curated):
`C:\Users\ejbra\.claude\plugins\marketplaces\*\plugins\*\skills\**\SKILL.md` and the sibling
`...\external_plugins\*\skills\**\SKILL.md` — the installed plugin marketplace clone. This
directory holds every plugin in the marketplace, not just the ones actually enabled for this
user, so treat everything found here as `source: "filesystem"` but don't assume it's active —
cross-reference with usage history (below) rather than claiming more than is known.

Frontmatter parsing: SKILL.md files here use plain, non-nested `key: value` lines between a pair
of `---` fences (see any file under the wispfield skills dir for the real shape) — a hand-rolled
line-by-line parser is enough, no YAML library needed. Pull `name` and `description`; if `name`
is missing, derive it from the containing directory name.

Real usage backfill: read `C:\Users\ejbra\.claude.json`, JSON keys `.skillUsage` and
`.pluginUsage` (both real, present on this machine today — `skillUsage` looks like
`{"dataviz": {"usageCount": 3, "lastUsedAt": 1786586748796}, ...}`, epoch-millis timestamps).
Match each entry to a discovered capability by name, stripping any `marketplace:` prefix (e.g.
`anthropic-skills:skill-creator` → match against `skill-creator`). Attach as `realUsage`. Any
`skillUsage` entry with **no** on-disk match still becomes its own capability with
`source: "usage-history-only"` — we know it exists and has real recorded usage even without a
`SKILL.md` to point to (this covers Claude Code's built-in skills, which aren't on disk).

MCP tools: `server/discovery/known-mcp-tools.json`, a checked-in manifest — real tool names for
the MCP servers actually connected in this environment (`claude-design`, `wispfield`,
`claude_ai_Gmail`, `claude_ai_Google_Drive`), not invented ones. Discovery upserts these with
`source: "mcp-manifest"`. Leave a prominent code comment marking this as the part that gets
replaced by a live `tools/list` handshake later, and that `stale` is exactly the mechanism that
will flag entries once that replacement makes the manifest obsolete.

**Custom MCP discovery sources:** an admin can register additional manifest files — e.g. a team's
own MCP servers this checked-in manifest doesn't know about — from the Sources page (kind
`"mcp_manifest"`, same table as the skill-dir sources above). Each is a JSON file holding an array
of `{kind: "mcp_tool", name, owner, riskTier, description}` objects, identical in shape to
`known-mcp-tools.json`. `mcpManifest.js` reads every enabled `mcp_manifest` source path in
addition to the built-in file and merges the results, deduping by `name` (the built-in manifest
wins any collision); a missing or malformed custom file is skipped, not a discovery-run failure.



### Diff semantics

A discovery run is idempotent: re-running with no filesystem changes produces `added: []`,
`updated: []` (unless `realUsage` numbers moved), `staled: []`. A capability found in a previous
run but not this one gets `stale: true` and is **not** deleted — grants and usage history against
it stay intact so nothing in the audit trail silently disappears.

## Principal mapping (v1) — implements item 2 of docs/design/integration-todo.md

Replaces invented instance names (`claude-msqvb0zl-4` as a made-up example, `design-loom-1`,
`explore-loom-2`) with real platform identities, pulled from the same env vars a `PreToolUse`/
`PostToolUse` hook sees (it's a child process of the agent, so it inherits them):

```
LOOM_NODE_ID    e.g. "claude-msri1c9v-43"   -> instance principal's `name` (its stable id)
LOOM_AGENT_NAME e.g. "Finn"                 -> `humanName`
LOOM_PROVIDER   e.g. "claude"               -> `backend`
LOOM_FIELD_NAME e.g. "windrow"              -> `field`
CLAUDECODE=1 / CLAUDE_CODE_ENTRYPOINT       -> `agentType` "claudecode"
```

`LOOM_NODE_ID` absent means the process isn't running under the agent runtime at all (bare terminal, CI)
— `identityFromEnv()` returns `null` in that case rather than fabricating an identity.

### Principal field additions

```
humanName: string | null   // the human-readable agent name the platform assigned, e.g. "Finn"
backend:   string | null   // LOOM_PROVIDER, e.g. "claude"
agentType: string | null   // the platform's own agent kind, e.g. "claudecode" — distinct from the
                            // pre-existing role names (`claude`, `general-purpose`, ...), which
                            // are Claude Code's Task-tool subagent types, not agent identities
field:     string | null   // LOOM_FIELD_NAME, e.g. "windrow"
```

Only `instance` principals carry these; `role` principals stay identity-free (a role is a policy
bucket, not a specific agent).

### Id scheme: role-level defaults vs instance-level overrides

- **Role** (`kind: "role"`, one per `agentType`, e.g. `claudecode`): the default grants every
  agent of that kind gets. Auto-created the first time an identity with a new `agentType` is seen.
- **Instance** (`kind: "instance"`, one per `LOOM_NODE_ID`, `parentRole` set to its role): a
  specific agent's overrides on top of its role's defaults. Matched and updated in place on every
  call — an agent's human name or workspace can change across a respawn on the same node id, so the
  registry reflects the latest observation rather than freezing the first one.

This mirrors capability discovery's merge semantics (matched by a stable key, upserted, never
duplicated) but has no `stale` concept yet: an agent that's left the workspace simply stops generating
new usage events against its instance principal; nothing currently marks it gone. (`design-agent`/
`Explore`/`Plan`/etc. roles stay manually defined — a Task-tool subagent runs inside its parent
agent's process and has no `LOOM_NODE_ID` of its own to discover.)

### Module and CLI

`server/principals/`:
- `fromEnv.js` — `identityFromEnv(env)`: reads the identity out of a process's env.
- `registry.js` — `upsertPrincipalFromIdentity(db, identity)`: the merge/upsert described above.
- `resolve-cli.js` (`npm run resolve-principal`) — resolves the *current* process's identity,
  upserts it, and prints `{identity, principalId}` as JSON. This is what a `PreToolUse`/
  `PostToolUse` hook (roadmap item 3) shells out to (or `require()`s directly, if the hook is
  Node) to get a real `principalId` for the agent it's running inside, self-registering on first
  use instead of needing the principal to already exist.

`server/seed.js` uses the same module to seed real agents (this workspace's actual roster at seed
time) instead of inventing instance names, while leaving the Task-tool-subagent roles manual.
