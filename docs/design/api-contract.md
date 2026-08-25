# Decision record: the Windrow API contract

> [!important]
> **This is a design decision record, not the API reference.** The authoritative, code-derived
> list of every route — method, auth guard, request and response shape — now lives in
> [`docs/reference/api.md`](../reference/api.md), regenerated from the route files. That is what
> you read to *call* the API.
>
> This document is retained for the **why**: the shape decisions, the constraints they answer, and
> the rationale behind each endpoint and store field. Where an endpoint description here and the
> reference disagree, the reference (and the code behind it) wins — treat any drift here as history,
> not as a live contract.

Backend: Node + Express, SQLite store (`better-sqlite3`, `server/data/governance.db`) — replaced
the original JSON-file store (`server/data/db.json`), which had no real atomicity: a
load-whole-file/mutate/save-whole-file cycle meant two concurrent writes could silently lose one
of them. See `server/store.js`. A one-time migration (`npm run migrate`) imports an existing
`db.json` and renames it to `db.json.bak`.

Base URL: the governed API is served over mutual TLS at `https://localhost:4443/api`. A second,
plaintext listener bound to `127.0.0.1` only carries `http://localhost:4000/api` for hooks alone (see
below). The frontend dev server proxies `/api/*` to the mTLS listener, presenting a dev client
certificate on the browser's behalf.

## Auth

Caller identity is carried by a **per-node X.509 client certificate over mutual TLS**, not a bearer
token (`server/auth.js`, [per-node-enrollment-credentials](per-node-enrollment-credentials.md)). Each
caller generates a keypair on its own machine, spends a single-use enrollment token, and receives a
certificate whose Common Name is its `nodeId` and whose Organizational Unit is its **scope** — `admin`,
`proposer` or `node`. The private key never leaves the machine that generated it, so a credential is no
longer a shared secret that says "a caller" without saying *which* caller — the property
[global-identity-and-central-db.md](global-identity-and-central-db.md) §2.5 exists to establish. The
shared bearer tokens this replaced (and the `GOVERNANCE_API_TOKEN`/`WINDROW_API_TOKEN` env spellings)
are gone; there is no env-var override that could carry a credential between machines.

Two listeners, and the scope is read from the socket the request arrived on (`req.socket.encrypted`),
never asserted by the caller:

- **mTLS listener** (HTTPS, `:4443`) — carries `admin`, `proposer` and `node` scopes, by certificate.
  `requireAdmin` gates registry-mutating routes; `requireProposer` gates the two propose endpoints,
  the one place a non-admin may *initiate* a change (it only queues an `approvals` row a human decides).
- **loopback listener** (plaintext HTTP, `:4000`, bound to `127.0.0.1` only) — carries the `agent`
  scope alone, by bearer token, for `PreToolUse`/`PostToolUse` hooks. Hooks are a fresh process per
  tool call and cannot afford a TLS handshake, so they reach the local agent over loopback at ~2 ms;
  the token is machine-local (`server/data/agent-api-token`, no env override) and cannot reach an
  admin route. The Vite dev proxy and hooks (`server/hooks/lib.js`) need no manual token config in dev.

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
      "osUser": "<os-user>", "hostname": "<hostname>",
      "actorLoomId": "<loom-id>", "actorAgentType": "claude",
      "actorBackend": "claude", "actorField": "<field>",
      "subjectId": "win-sid:S-1-5-21-…-1001", "assuranceLevel": 2 }
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
| POST | `/principals` | `{kind,name,parentRole?,subjectId?,assuranceLevel?}` | created `Principal`, 201. `kind` is `role`, `instance` or `user`. A `user` **requires** `subjectId` with an authority prefix (`win-sid:`/`posix:`/`env-user:`/`federated:`) — it is that row's key, where `name` is only a label — and 409s if one already exists for it. `assuranceLevel` defaults to 1 (display only) and is never inferred from the prefix. |
| POST | `/principals/resolve` | `{loomId,humanName?,backend?,agentType?,field?,standalone?,subjectId?,assuranceLevel?,osUser?}` | `{role,instance,subject}` — the hook path's self-registration (`server/hooks/lib.js`'s `resolvePrincipal`). Upserts the identity's role (created `pending`, zero grants, on first sighting), its instance (zero grants of its own; inherits the role's dynamically), and its **subject** — the `user` principal for the OS account behind the call, keyed on `subjectId` (see "The subject key" below). The instance's identity attributes are write-once: NULLs are back-filled, a differing observation is logged as drift and *not* written (see "Id scheme" below). `subject` is null when the caller sends no `subjectId`; a `subjectId` without an authority prefix is a 400, not a silent accept. `osUser` is accepted only as the subject's initial display label. Reachable by the **agent** token, not just admin: it's the one registry write a hook legitimately makes, and it can't grant, approve or touch any other table. Narrow three-row transaction (`store.upsertPrincipalIdentity`) — it replaced an in-hook `store.load()`/`save()` whole-database rewrite that never passed `requireAuth`. See global-identity-and-central-db.md phase 0. |
| PATCH | `/principals/:id/name` | `{name, reason?}` | updated `Principal`. Renames the **display label**, admin only, audited as `principal_rename`. 409 for any kind but `user`: a `role`/`instance` row is still *found* by `name` (agentType / loom id), so renaming one orphans it from the identity that resolves to it. A `user` row is found by `subjectId`, and every grant, usage event and audit row references `principals.id`, so its rename re-attributes nothing. |
| GET | `/principals/owner-proposals` | query `?status=needs_review\|all` (default `needs_review`) | `{status, summary, proposals[]}` — who each agent instance probably belongs to, proposed from the modal non-null `usage_events.osUser` for that instance. See "Owner proposals" below. Computed per request and stored nowhere; readable without an admin token (it exposes no `osUser` that `GET /usage` doesn't). |
| POST | `/principals/:id/owner` | `{status?, osUser?, ownerPrincipalId?, proposedOsUser?, reason?}` | `{principal}` — the human's decision on a proposal, admin only, audited as `principal_owner_confirmed`/`_dismissed`/`_unassigned`. `status` defaults to `confirmed` and then **requires** `osUser`; `dismissed` records "a human looked and could not name an owner"; `unassigned` reopens. 409 for any kind but `instance`, and for an `ownerPrincipalId` that isn't a `user` principal. Changes no authorization decision. |

| GET | `/grants` | query `?principalId=&capabilityId=` | `Grant[]` |
| POST | `/grants` | `{principalId,capabilityId,constraints?,expiresAt?}` | created `Grant`, 201. 409 if a grant for that pair already exists |
| DELETE | `/grants/:id` | – | 204 |
| POST | `/invoke` | `{principalId,capabilityId,correlationId?,osUser?,hostname?,actorLoomId?,actorAgentType?,actorBackend?,actorField?,subjectId?,assuranceLevel?}` | `{allowed:boolean, event:UsageEvent}` — this **is** the broker: look up an active (non-expired) grant for the pair, log a `UsageEvent` with outcome `ok` (allowed) or `denied` (no grant), and return it. Latency is simulated (random 40–400ms) since there's no real tool behind it. `osUser`/`hostname` are the real computer account/machine that issued the call — forwarded by the PreToolUse hook (`server/hooks/lib.js`'s `resolvePrincipal`/`invoke`, sourced from `server/principals/fromEnv.js`'s `identityFromEnv`, itself live `os.userInfo()` falling back to `env.USERNAME`/`env.USER` — that order, so an agent that exports either var cannot choose the account recorded against its own calls); null when there's no hook behind the call, e.g. a manual invoke from the dashboard's own Invoke panel. The `actor*` fields come from the same hook-side `identityFromEnv` and record **the calling agent as a dimension of the call**: read those when attributing historical usage rather than joining `principalId` to a principal row, since that row is mutable (identity is back-filled over time, and an instance can be repointed at another role) so a join silently rewrites what past calls look like they came from. Null on events predating the columns, and never back-filled for them. `subjectId`/`assuranceLevel` record **who the call was accountable to and how strongly that was established, for this call** — see "Assurance level" below for why the event carries its own tier rather than deferring to the subject principal's. Both are validated leniently: a `subjectId` with no authority prefix, or an `assuranceLevel` outside 1–3, is stored as NULL rather than 400'd, because a hook is blocked on this response for its allow/deny decision and neither field authorizes anything. |
| GET | `/usage` | query `?principalId=&capabilityId=&limit=` (default 200) | `UsageEvent[]`, newest first |
| GET | `/usage/summary` | – | see below |
| GET | `/drift` | – | see below |
| GET | `/policy` | query `?since=<version>&limit=` (default/max 500) | `{schemaVersion, version, floor, since, servedAt, denyList, reset, changes[]|snapshot, complete}` — the policy delta channel. See "The policy distribution channel" below. |
| GET | `/policy/deny-list` | – | the always-full revocation list on its own, with no version dependency — what a node uses when it is refusing to apply deltas at all |
| GET | `/policy/events` | – | `text/event-stream`. One `event: policy` frame carrying `{version}` on connect and after every policy mutation; carries no policy, only a poke to pull now |
| GET | `/policy/status` | – | this node's own view of its channel: `{central, running, streamConnected, version, denyListAgeMs, revokedGrants, consecutiveFailures, lastError}` |

`GET /usage/summary` returns:
```json
{
  "totals": { "calls": 0, "denied": 0, "denialRate": 0, "avgLatencyMs": 0 },
  "byCapability": [ { "capabilityId": "...", "name": "...", "calls": 0, "denied": 0, "avgLatencyMs": 0 } ],
  "byPrincipal": [ { "principalId": "...", "name": "...", "agentName": "...", "calls": 0, "denied": 0 } ],
  "byDay": [ { "date": "YYYY-MM-DD", "calls": 0, "denied": 0 } ]
}
```
`byDay` covers the last 14 days including days with zero events.

`byPrincipal` is grouped on `principalId`, never on the display name. `name` is the principal's
`humanName` when it has one — a nickname the platform assigns from a fixed cast pack, so it is
neither unique across principals nor stable across respawns — falling back to the agent/role name.
`agentName` is the agent/role name itself (a loom id, for instances), so a client can tell two rows
apart when they carry the same nickname. See `docs/design/global-identity-and-central-db.md` §1.1.

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
1. `%USERPROFILE%\.wispfield\skills` — confirmed real, currently 7 skills under a `wispfield/` subdir.
2. `<repo>/.claude/skills` — project skills; doesn't exist yet, scan must skip silently, not error.
3. `%USERPROFILE%\.claude\skills` — **the "user skills" directory** flagged in the roadmap doc.
   Doesn't exist yet either; same silent-skip requirement, but it's a first-class scan root so
   skills placed there later are picked up with no code change.
4. `<repo>/.agents/skills` — Antigravity ("agy")'s workspace skills, the `.claude/skills` analog
   for the second backend `docs/design/agy-adapter.md` added enforcement for.
5. `%USERPROFILE%\.gemini\config\skills` — agy's user-level skills directory.
6. `%USERPROFILE%\.gemini\antigravity-cli\plugins` — agy's installed-plugins directory (bundles
   both tools and skills per plugin, the agy analog of the Claude marketplace clone scanned below).
   None of 4-6 exist on this machine yet; same silent-skip requirement as 2-3.

After that first seed, the table is the source of truth — a row a human deletes or disables there
stays gone across restarts, independent of `SKILL_DIRS`.

Always scanned in addition, not manually configurable (derived per-machine, not curated):
`%USERPROFILE%\.claude\plugins\marketplaces\*\plugins\*\skills\**\SKILL.md` and the sibling
`...\external_plugins\*\skills\**\SKILL.md` — the installed plugin marketplace clone. This
directory holds every plugin in the marketplace, not just the ones actually enabled for this
user, so treat everything found here as `source: "filesystem"` but don't assume it's active —
cross-reference with usage history (below) rather than claiming more than is known.

Frontmatter parsing: SKILL.md files here use plain, non-nested `key: value` lines between a pair
of `---` fences (see any file under the wispfield skills dir for the real shape) — a hand-rolled
line-by-line parser is enough, no YAML library needed. Pull `name` and `description`; if `name`
is missing, derive it from the containing directory name.

Real usage backfill: read `%USERPROFILE%\.claude.json`, JSON keys `.skillUsage` and
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
LOOM_FIELD_PATH e.g. "<workspace>/windrow"  -> `fieldPath`
CLAUDECODE=1 / CLAUDE_CODE_ENTRYPOINT       -> `agentType` "claudecode"
```

Two more come off the OS rather than the env, on *both* branches below, because they describe the
machine account the process actually runs as and not which agent (if any) wraps it: `osUser` from
`os.userInfo()` — env `USERNAME`/`USER` only as a last resort, since a hook inherits the agent's
environment and would otherwise let the agent choose the account recorded against its own calls —
and `hostname` from `COMPUTERNAME`/`HOSTNAME`/`os.hostname()`. `subjectId`/`assuranceLevel` are
derived the same way, via `server/principals/subject.js` (see "The subject key" below).

`LOOM_NODE_ID` absent means the process isn't running under the agent runtime at all — a bare
terminal, CI, or a backend the platform never wrapped. **`identityFromEnv()` never returns `null`.**
It used to, and the calling hook then went entirely ungoverned (no principal, no usage event,
nothing recorded); it now synthesizes a *standalone* identity instead so that usage is tracked too
(docs/design/cross-field-and-standalone.md):

```
loomId:    "standalone-<backend>-<hostname>-<osUser>"  // deterministic, not random: repeat
                                                        // invocations by the same OS user on the
                                                        // same machine reuse one principal
humanName: <osUser>
backend:   backendHint if the hook passed one, else sniffed — "claude" (CLAUDECODE=1 /
           CLAUDE_CODE_ENTRYPOINT), "codex" (CODEX_HOME / CODEX_SANDBOX*, best-effort, not
           verified against a real Codex process), else "unknown" rather than a wrong guess
agentType: "<backend>-standalone"
field / fieldPath: null
standalone: true
```

`opts.backendHint`, passed by a backend-specific hook entry point that already knows what it is
wired to (`server/hooks/agy-pre-tool-use.js`, the Codex equivalent), always beats env sniffing.
On the platform-backed branch, `agentType` is `"claudecode"` for Claude Code, `"antigravity"` for
the agy adapter, and `"<LOOM_PROVIDER>-unknown"` for a backend no kind has been mapped for yet.

### Principal field additions

```
subjectId:      string | null  // the stable key — `user` principals only, authority-prefixed; see
                               // "The subject key" below. NULL on role/instance rows.
assuranceLevel: number | null  // how that key was read: 3 server-verified, 2 OS-read, 1 env-derived
humanName: string | null   // the agent nickname the platform assigned, e.g. "Finn" — display only:
                            // it comes from a fixed cast pack, so it is neither unique across
                            // agents nor stable across respawns. Never group or key on it.
backend:   string | null   // LOOM_PROVIDER, e.g. "claude"
agentType: string | null   // the platform's own agent kind, e.g. "claudecode" — distinct from the
                            // pre-existing role names (`claude`, `general-purpose`, ...), which
                            // are Claude Code's Task-tool subagent types, not agent identities
field:     string | null   // LOOM_FIELD_NAME, e.g. "windrow" — always null when `standalone`
standalone: boolean        // synthesized outside any tracked agent runtime (bare terminal, CI).
                            // NOT NULL with a default in the schema, so it is written by the
                            // registry rather than merged in by `mergeObservedIdentity`.
```

Only `instance` principals carry the agent attributes (`humanName`/`backend`/`agentType`/`field`);
`role` principals stay identity-free (a role is a policy bucket, not a specific agent), and
`subjectId`/`assuranceLevel` are the reverse — `user` principals only, since a person is not an
agent and none of backend/agentType/field describe one.

### The subject key — `principals.subjectId` (`want-mszgwij4-17`)

A grant is held by a *person*; a call is made by an *agent on that person's behalf*. `loomId`
identifies the agent and nothing else — it is reissued on every respawn — so it cannot be what
accountability is keyed on. `principals.subjectId` is: an opaque OS identifier, `UNIQUE`, prefixed
by the authority that issued it so heterogeneous sources cannot collide.

```
win-sid:S-1-5-21-2963395615-2330981250-1484618637-1001   // the whole SID, never the RID alone
posix:1000@<hostname>                                    // uid 1000 exists on every Linux box
env-user:<username>@<hostname>                           // assurance tier 1 — display only
federated:<opaque>                                       // reserved (global-identity §1.3)
```

Read by `server/principals/subject.js`: `whoami /user` invoked by absolute path out of `%SystemRoot%`
on Windows (so the process being identified cannot substitute the binary that identifies it via
`PATH`), `process.getuid()` on POSIX, and the tier-1 `env-user:` key only when neither is readable.
`assuranceLevel` records which of those answered, and only ever ratchets upward on a row — see
"Assurance level" below, and note that `usage_events` carries its own per-call copy for the case
where the two disagree.

### Assurance level — on the principal *and* on every call

`assuranceLevel` answers "how was this identity established", in one vocabulary, in two places that
say deliberately different things:

```
3  server-verified over an authenticated channel   (no producer yet — global-identity §1.5)
2  OS-read identity, same machine                  (win-sid:, posix:)
1  env-derived username, display only              (env-user:)
```

| | `principals.assuranceLevel` | `usage_events.assuranceLevel` |
|---|---|---|
| Scope | the subject key, across its whole life | one call |
| Written | on the `user` row, at resolve | on every event, at `/invoke` |
| Changes | **ratchets up only** — never falls | fixed at insert; `PATCH /usage/:id` cannot touch it |
| Answers | how well has this person *ever* been identified | how well were they identified *here* |

The two can legitimately disagree, and that is the point. A run where `whoami /user` fails degrades
to the tier-1 `env-user:` key, so its events read 1 while the subject row — updated on some earlier
run that did read the SID — still reads 2. Auditing "which calls rest on a username the calling
process could have set itself" is a query over the event column; the principal column cannot answer
it, because ratcheting up is exactly what makes it unable to.

`usage_events.assuranceLevel` and `usage_events.subjectId` are part of the hash chain (see
`GET /usage/verify`), so a later rewrite of either is detectable. Neither is back-filled onto rows
that predate the columns: NULL reads honestly as "not recorded", which is a different claim from
tier 1. Same for the principal column — inventing a tier for an existing row would assert an
identity nobody read.

Both are self-asserted by the hook, like every other field on these routes. That is sound for a hook
talking to a service on its own machine and is **not** an identity proof; tier 3 exists in the
vocabulary from the start precisely so the authenticated-channel path in global-identity §1.5 slots a
value into an existing domain rather than widening an enum under live data.

Server side: `server/principals/subject.js` (`assuranceLabel`, `isAssuranceLevel`) is the one
definition; client side, `client/src/api/assurance.ts`. Shown on the Principals page (per subject)
and in the dashboard's Recent calls table (per call, filterable by tier word).

Carried by `kind: "user"` principals alone. Every loom on a machine shares one OS account, so a
subject on an `instance` row would make the UNIQUE index unsatisfiable; that is the model stated
correctly rather than an obstacle. `role`/`instance` rows leave it NULL.

**`principals.name` is demoted to a mutable display label by this change.** On a `user` row it is
seeded from the OS username, then owned by whoever edits it (`PATCH /principals/:id/name`) — a hook
resolve never overwrites it, or every tool call would undo the rename. It is safe to change because
nothing is attributed through it: grants, usage events and audit rows all reference `principals.id`,
and the row is found by `subjectId`. On `role`/`instance` rows `name` is still the lookup key until
the subject flip, which is why that route refuses them.

This is phase 1 of global-identity-and-central-db.md ("observe — record real OS identity, change no
decision"). **Nothing authorizes off a subject row yet**: `findActiveGrant` still resolves instance →
`parentRole`, unchanged, and the subject is created `pending` with zero grants. The hook self-asserts
its subject the same way it self-asserts everything else on `/principals/resolve` (§1.5) — sound for
a hook talking to a service on its own machine, and not an identity proof, which is precisely why the
tier is recorded rather than assumed.

### Owner proposals — instance principal to person (`global-identity-and-central-db.md` §1.6)

Nothing in the registry records which **person** an agent instance belongs to. The only trace is
`usage_events.osUser`, the OS account each call was made under, so the modal non-null value per
instance gives a *probable* owner. §1.6 is explicit about the limit on that: it is "a dashboard
suggestion for a human to confirm, never an automatic remap".

`GET /principals/owner-proposals` is that suggestion, and it is **computed on every read and
persisted nowhere** — there is no column holding a guess, so nothing downstream can mistake one for
a decision and changing the heuristic needs no backfill. Per instance it returns:

- `proposal` — the modal account (`osUser`, `hostnames`, `events`), its `share` of the instance's
  *identified* events, and the denominators that qualify it: `identifiedEvents`, `totalEvents`,
  `eventsWithoutOsUser`. A 3-of-3 modal name on an agent with 900 identity-less events is not the
  same claim as 3-of-3 overall, so both numbers travel with it. `null` when no event carries an
  `osUser` — the instance is still returned, since "nothing to go on" is worth showing.
- `weak` (fewer than 3 events behind the modal name) and `contested` (calls split across accounts,
  modal share < 0.8). Flagged, never filtered: a human often recognises a name the arithmetic
  can't justify, and a split is itself the finding — a shared machine, or a reused loom id.
- `matchedUser` / `matchBasis` — the existing `user` principal for that account, found either by
  the exact `env-user:<osUser>@<host>` subject key a hook on that machine would produce
  (`subject-key`) or by a case-insensitive display-label match (`label`, weaker: the label is
  mutable and repeats across machines). A tier-2 `win-sid:`/`posix:` subject is **not** reachable
  from a bare username — that is the unrecoverable part §1.6 names — so those proposals match
  nothing and confirming one records the account name alone.
- `candidates` — every account seen, most-used first, so a human can pick a non-modal one. Ties
  break on recency then name, so the same evidence always yields the same proposal.

`POST /principals/:id/owner` records the answer on the principal (`ownerStatus`, `ownerOsUser`,
`ownerPrincipalId`, `ownerConfirmedAt`, `ownerConfirmedBy`). Three things it deliberately does not
do:

- **It does not derive the owner itself.** `osUser` comes from the request body, so correcting a
  wrong proposal is the same call as accepting a right one, and the audit entry carries
  `proposedOsUser` — what the human was shown — so the decision stays readable after the heuristic
  changes.
- **It does not mint a subject.** `ownerPrincipalId` may name an existing `user` principal and is
  validated, but a bare username is not promoted to a `subjectId`: inventing one would assert an
  identity nobody verified, which is why the `subjectId` migration is not back-filled either.
  Confirmed-with-no-user-principal is a legitimate state.
- **It grants nothing.** `findActiveGrant` still resolves instance → `parentRole`. This records the
  mapping phase 5 will eventually flip the subject onto; an owner mapping that started granting
  things on confirmation would be precisely the automatic remap the design rules out.

`osUser` arrives on an unauthenticated request body (§1.5), so every value here is evidence about
what a machine reported, not an identity claim. That is the reason a human is in the loop rather
than a migration script.

### Shadow evaluation — the user-keyed decision, computed but never enforced

Phase 3 of global-identity-and-central-db.md (`want-mszgwlsi-20`). Every `/invoke` now decides
twice:

```
loom-keyed  (ENFORCED)   instance -> parentRole        -> usage_events.outcome
user-keyed  (OBSERVED)   user AND role, intersected    -> usage_events.shadowOutcome
```

The second changes nothing. It exists so the flip at phase 5 is argued from a measured count of the
calls it would break, not an estimate of them.

| Column | Values | Meaning |
|---|---|---|
| `shadowOutcome` | `allow` \| `deny` \| `unevaluated` \| `error` | the user-keyed decision |
| `shadowReason` | text | which leg of the intersection failed, named |
| `shadowPrincipalId` | id \| NULL | the `user` principal it resolved through |

`unevaluated` is a third answer, not a soft deny: a call carrying no subject key never had a
user-keyed decision to make, and counting it as denied would manufacture the divergence this is
supposed to measure. A subject key that resolves to *no* row is a real `deny` — that is what the
flip would do to it today.

**Do not compare `shadowOutcome` to `outcome` as strings.** `outcome` starts as the decision and is
then overwritten by what happened next — `ok` → `error` when the tool failed, `denied` → `approved`
when a human consented — so a string compare reads both corrections as divergence. `enforcedDecision()`
in `server/app.js` is the mapping that is correct, and it is what `GET /shadow-divergence` uses.

The shadow columns are part of the hash chain, like every other audit field.

- `GET /shadow-divergence?windowMinutes=&limit=` — `coverage` (evaluated / unevaluated / errored /
  notRecorded), `divergent`, `divergenceRate` (**null**, not 0, when nothing was evaluated —
  "no divergence" and "no evidence" must not read alike), `wouldBreak` (allowed today, denied by the
  user-keyed model — the number that decides the flip), `wouldNewlyAllow` (the opposite direction: a
  widening, not a breakage), `byCapability`, and `recent` examples.
- Each divergence also logs a `[shadow-divergence]` line at `console.error` when it happens, so a
  run that is not ready for phase 5 says so without anyone thinking to query for it.
- Off with `WINDROW_SHADOW_EVAL=0`. On by default: it runs after the response has gone out, so it
  is not on the latency the hook measures as `grantCheckMs`.

Settles `want-mszgwq5d-24` (union vs most-restrictive) **for the shadow only**, as
most-restrictive — the model §1.7 states, and the safe direction to be wrong in, since it
over-reports what a flip would break rather than under-reporting it.

### The node, and the per-node hash chain (`global-identity-and-central-db.md` §2.7 phase 1)

A **node** is one `governance.db` plus the server process that writes it. Its id lives in
`kv.node_id`, minted once on first use (`WINDROW_NODE_ID` overrides it for a deployment that mints
ids at enrollment) and read from there forever after — so it survives restarts, and a db copied to
another machine keeps the id its rows were written under.

`usage_events` gained three columns, all assigned by the store inside the insert transaction and
never taken from the caller:

| Column | What it is |
|---|---|
| `nodeId` | which node recorded the event |
| `seq` | its place in that node's own sequence — gapless from 1, unique per node |
| `observedAt` | when the **node** stamped the row, beside `ts`, which is when the **caller** said the call happened |

The hash chain is now keyed on `(nodeId, seq)` rather than on this db's rowid order. Rowid order is
a total order only while there is exactly one writer, and `server/rollup/index.js` already merges
`usage_events` out of every sibling workspace's db — so the merged log was presented as one ordered
audit trail that no single chain covered. Each node's chain is `prevHash = hash of that node's
seq - 1`, NULL at seq 1, and each node's tip is recorded in **`usage_chain_heads`** (one row per
node, written in the same transaction as the row that moved it).

`GET /usage/verify` (admin) returns `{nodeId, heads, ok, checked, nodes[]}` and reports three
distinct breaks per node: a hash that doesn't match the row's content (an edit), a gap or repeat in
`seq` (a splice), and a tail short of the recorded head (a **truncation** — the one attack a chain
read only out of the rows cannot see, since lopping off the last N leaves the rest verifying).

Two clocks, kept apart on purpose: `observedAt - ts` is the only measurable evidence of skew
between the machine that made a call and the one that recorded it, and `GET /rollup/summary` now
reports `totals.clockSkew` (`sampled`, `maxAheadMs`, `maxBehindMs`) computed from it. That merge
also dedupes on `(nodeId, seq)` and reports `totals.duplicatesSkipped`: under the shared-db
deployment, every workspace directory pointing at one db reached the same rows, and each workspace
added them to the totals again. `RollupFieldStatus.nodeId` is what makes that visible — two
workspaces reporting the same node are sharing a db, so their event counts are not additive.

Migration is guarded like every other column here. A db written before this has each existing row
assigned this node's id and a `seq` in rowid order — the same order its existing hashes were built
over — and is then re-chained, with the usual "did it verify under the form it was actually written
with" check first. `observedAt` is deliberately **not** back-filled: there is no honest value for
"when did we see it" after the fact, and NULL says exactly that.

### Id scheme: role-level defaults vs instance-level overrides

- **Role** (`kind: "role"`, one per `agentType`, e.g. `claudecode`): the default grants every
  agent of that kind gets. Auto-created the first time an identity with a new `agentType` is seen.
- **Instance** (`kind: "instance"`, one per `LOOM_NODE_ID`, `parentRole` set to its role): a
  specific agent's overrides on top of its role's defaults. Matched on `loomId`; its identity
  attributes (`humanName`/`backend`/`agentType`/`field`/`standalone`) are **write-once** — set when
  the principal is created and never replaced. They used to be refreshed in place on every call, so
  that the registry reflected the latest observation; that silently re-attributed every historical
  usage event to the agent's *current* attributes, since reports resolve an event's agent by joining
  out to this row (global-identity-and-central-db.md §1.2, `want-mszgwf94-14`). A NULL attribute is
  still back-filled — that attributes events that had nothing — and a *differing* observation is
  logged as identity drift and discarded, until `usage_events` carries the actor per call
  (`want-mszgwhfj-16`). The registered `parentRole` likewise wins over a drifting `agentType`, so a
  reused node id can't mint a phantom `pending` role.

This mirrors capability discovery's merge semantics (matched by a stable key, upserted, never
duplicated) but has no `stale` concept yet: an agent that's left the workspace simply stops generating
new usage events against its instance principal; nothing currently marks it gone. (`design-agent`/
`Explore`/`Plan`/etc. roles stay manually defined — a Task-tool subagent runs inside its parent
agent's process and has no `LOOM_NODE_ID` of its own to discover.)

### Module and CLI

`server/principals/`:
- `fromEnv.js` — `identityFromEnv(env, opts)`: reads the identity out of a process's env, plus the
  OS account/host it runs as. Never returns `null` — off-platform it synthesizes a deterministic
  standalone identity (see "Principal mapping (v1)"); `opts.backendHint` lets a backend-specific
  hook assert its backend instead of env sniffing.
- `registry.js` — `upsertPrincipalFromIdentity(db, identity)`: the merge/upsert described above,
  on an in-memory snapshot. Its `mergeObservedIdentity(existing, identity)` is the shared write-once
  rule, `require`d by `store.js` rather than reimplemented so the two paths can't drift apart. Batch/offline callers only (`seed.js`) since the hook path moved to
  `POST /api/principals/resolve`; `store.upsertPrincipalIdentity` is the live, transactional twin.
- `resolve-cli.js` (`npm run resolve-principal`) — resolves the *current* process's identity,
  registers it **via the API** (`POST /principals/resolve`, sharing `hooks/lib.js`'s
  `resolvePrincipal` and its cache), and prints `{identity, principalId}` as JSON. This is what a
  `PreToolUse`/`PostToolUse` hook (roadmap item 3) shells out to (or `require()`s directly, if the
  hook is Node) to get a real `principalId` for the agent it's running inside, self-registering on
  first use instead of needing the principal to already exist. It no longer touches the store: a
  hook process holds no direct database write path.

`server/seed.js` uses the same module to seed real agents (this workspace's actual roster at seed
time) instead of inventing instance names, while leaving the Task-tool-subagent roles manual.

### The policy distribution channel (`global-identity-and-central-db.md` §2.4)

How a node learns that policy changed, and what it does when it stops being able to find out.
§2.4's answer is three channels taken together, each degrading into the one below it:

| Channel | Endpoint | Revocation window | Survives |
|---|---|---|---|
| Poll | `GET /api/policy?since=<v>` on `WINDROW_POLICY_POLL_INTERVAL_MS` (30s) | ≤ the interval | SSE being dead |
| Push | `GET /api/policy/events` (SSE) — pokes an immediate pull | < 1s typical | nothing; it is the first thing a proxy closes |
| Deny-list | rides **every** `/api/policy` response, and `GET /api/policy/deny-list` alone | < 1s, and survives a stale replica | a delta stream the node is refusing to apply |

**The version.** `policy_changes` is an append-only log with an `INTEGER PRIMARY KEY AUTOINCREMENT`
`version`, and one row per *mutation* rather than per row — so replaying from any point reaches the
same state as replaying from zero. AUTOINCREMENT rather than a plain rowid because compaction must
not rewind the sequence: a reused version number would hand a node a change it had already applied
under that number, which is a silent divergence rather than a visible gap. Every policy mutator in
`server/store.js` appends (`recordPolicyChange`), and `server/policy/distribution-test.js` asserts
that per mutator — a mutator that forgets is a node that never hears about those rows, and nothing
else in the system would notice.

An install that predates the log gets a baseline at boot (`seedPolicyChangesOnce`, once, guarded by
a kv flag): without it, `policyVersion()` would be 0 on a database full of grants and a node asking
`since=0` would be told it was current while holding nothing.

**Deltas.** `GET /api/policy?since=<v>` returns everything after `v`, capped at 500 changes with
`complete: false` telling the node to ask again immediately rather than wait out its interval. A
`since` that cannot be caught up incrementally — older than the retained log, or *ahead* of central,
which means a restored backup or a different central — comes back `reset: true` with a full
snapshot, because replaying our deltas onto that node would merge two histories. An absent or
unparseable `since` reads as 0 rather than 400: the failure that produces one is a node whose local
state was lost, and a snapshot is something it can act on.

**The always-full deny-list.** Every response carries the complete set of revoked grant ids,
`principalId:capabilityId` pairs, and non-`active` principal ids — recomputed in full, never diffed.
That is the one guarantee whose correctness must not depend on the delta stream having worked, and
it is why it is a separate file on disk (`server/data/hook-policy-deny.json`) rather than a field on
the replica: a delta refused for schema skew, a gap or a rewind still leaves the deny-list written.
Revocations are monotone and narrow, so broadcasting them in full is cheap.

**Node side.** `server/policy/policyClient.js` holds the SSE connection, pulls on the poke and on the
timer, and writes two files: `policy-replica.json` (the applied delta state) and the deny-list. On a
node whose authority is central it **also** writes the rows into that node's own
`capabilities`/`principals`/`grants` tables — see the next section — and the mirror is written
*before* the JSON records the version as applied, because the JSON is what the next pull's `since`
comes from and a delta is only ever sent once. Per §2.6 it refuses to
*apply* a payload whose `schemaVersion` it does not understand, falling back to its last-good
replica rather than half-applying. A capped batch advances the replica to the last change **actually
applied**, not to the log head — taking the head would leave it claiming rows it does not hold and
the next pull would be told it was current.

**Fail-closed past `MAX_POLICY_AGE`.** `server/hooks/lib.js`'s `policyChannelGate` runs on every
governed call *before* the live grant check, because the local registry can be perfectly healthy and
perfectly out of date. A deny-list hit denies every tier including `read_only` — a revocation is
central saying stop — and is classified `[governance:denied]`, a real decision by a healthy
authority. Past `WINDROW_MAX_POLICY_AGE_MS` (default 15 minutes, i.e. thirty consecutive missed
30-second polls) the call goes down the existing degradation ladder as `FAULT.STALE_POLICY`:
`read_only` allows, `mutating` denies unless a signed maintenance lease is in force, `destructive`
asks under a lease and denies without one. That is §2.4's "extended from *cannot reach* to *cannot
trust*", and it is the same ladder rather than a second copy of it.

`fetchedAt` is stamped only on a **successful** fetch, so a node that cannot reach central genuinely
gets older instead of resetting its own clock. Two cases the file distinguishes that a missing file
could not: a standalone install writes `central: false` (`server/cacheWarmer.js`) because its own
database is the authority and age is not a meaningful claim about it, and a node that has a central
configured but has never reached it gets a `central: true, fetchedAt: null` marker at client
startup — so "never confirmed" arrives at the hook as a present file with no timestamp and fails
closed, rather than as an absent file the hook would have to guess about.

`GET /api/policy/status` reports the node's own view: version, deny-list age, whether the stream is
connected, the last error, and — on a replica node — `authority`, `mirrorVersion` and
`mirrorStampedAt`. The replica version and the mirror version move together on a healthy node and
come apart in exactly one case worth seeing: a delta that applied to the JSON but could not be
written into SQLite.

---

### Central as the policy authority (`global-identity-and-central-db.md` §2.7 phase 4)

**Who writes what.** With `WINDROW_POLICY_AUTHORITY=central` and a `WINDROW_CENTRAL_URL` (both
required — asking for the first without the second stays node-authoritative and logs why), central is
the single writer for policy and every node holds a read replica plus the deny-list.

| Plane | Writer | On the node |
|---|---|---|
| capabilities, principals, grants, approvals, control-plane audit | central only | read replica in the node's own SQLite, **locked** |
| usage events | that node only | outbox + local retention, shipped up (phases 1 and 3) |
| discovery sources, packages state, hook integrity, enrollment | that node only | authoritative — they describe this machine's filesystem |

**Ids are minted centrally.** `POST /api/policy/capabilities` returns the row with its `cap_…` id;
the caller does not supply one. Two nodes reporting the same tool through
`POST /api/policy/capabilities/resolve` are handed the **same** id, which is the difference between a
fleet registry and N registries that agree on vocabulary. `UNIQUE(COALESCE(kind,''), name)` on
capabilities and `UNIQUE(kind, name)` on principals are fleet-wide, so `role/claude` is one row,
approved once, everywhere.

**Central's policy surface**, all under `/api/policy` on the same origin as ingest and fleet:

| Route | Cert scope | Notes |
|---|---|---|
| `GET /api/policy?since=<v>` | node | the delta pull; records the caller's replica version in `node_policy_state` from the **certificate CN**, never from a query parameter |
| `GET /api/policy/deny-list` | node | the always-full list, with no version dependency on either side |
| `GET /api/policy/events` | node | SSE; carries a version and no policy |
| `POST /api/policy/capabilities/resolve` | node | discovery: propose a `(kind, name)`, receive the canonical row. **Cannot retier an existing one**, and an untiered proposal lands `read_only` |
| `POST /api/policy/principals/resolve` | node | the hook path's registration; a first-sighted role is created `pending` with zero grants |
| `POST /api/policy/capabilities`, `PATCH …/auto-grant` | admin | registering with a stated tier, and the auto-grant switch (never on a `destructive` row) |
| `POST /api/policy/principals`, `PATCH /api/policy/principals/:id` | admin | status, name, owner — one route, because centrally they are one operation |
| `POST /api/policy/grants`, `DELETE /api/policy/grants/:id` | admin | the revoke answers **200 with the row**, not 204 — its `revokedAt` is the evidence it landed |
| `POST /api/policy/approvals`, `POST …/:id/decide` | node / admin | an approved grant proposal becomes the grant in the same transaction as the decision |
| `GET /api/fleet/policy` | admin | every node's replica version against central's head — who is behind, and by how much |

A node certificate can read the whole policy because it *replicates* it; there is no smaller thing to
give it, and §2.8 states that exposure honestly rather than pretending it is new. What a node cannot
do is decide what any of it permits.

**The node's own `/api/policy` is not mounted on a replica.** Its `policy_changes` log stops being a
history of anything, so serving deltas from it would hand a caller a version number meaning something
entirely different from central's.

**Nothing local may write policy.** `server/store.js` refuses every policy mutator with
`PolicyReadOnlyError` — from any caller, not only from ones that go through the seam — and
`applyPolicyReplica` is the single way in. It also displaces locally-minted rows that collide with
central's on the natural key, which every node upgraded from phase 3 will have. A refusal is an error
and never a silent no-op: a dropped policy write would leave the caller believing the grant exists.

**Discovery proposes rather than writes.** `POST /api/discovery/run` (and the two skill routes that
re-run it) no longer call `store.save()` on a replica — that wholesale replace is behind the lock,
because it reaches around every guarded export. Instead each discovered `(kind, name)` goes to
`POST /api/policy/capabilities/resolve` and comes back with central’s id, and only the machine-local
columns — `source`, `discoveredAt`, `lastSeenAt`, `stale`, `realUsage` — are written here. A proposal
that cannot reach central is counted and logged rather than swallowed: a run that half-reported leaves
some machines’ tools registered and some not, which is invisible unless it is said out loud.

**The hot path is unchanged.** The mirror is the same tables with the same indexes, so
`findActiveGrant` is two prepared statements and no governed tool call touches the network. The WAN is
on the write path only — which is why every policy-mutating route in `server/app.js` is now `async`,
and why a rejected handler promise is turned into a response rather than a hung request.

**What `/invoke` now returns.** Every response — and the `principal not found` / `capability not
found` 404s — carries `policy: {authority, version, ageMs}`. `authority` is `'node'` or `'central'`,
`version` is the mirror version the decision was made at, and `ageMs` is how long since the policy
channel last confirmed anything. A denial an agent receives now says whose policy denied it, because
asking the admin of one replica out of forty does not help.

**The one hook-contract change.** "This capability is not in the registry" used to be a complete
answer. On a replica it is two answers: genuinely ungoverned, or not replicated yet. The hook reads
the deny-list's new `authority` field — written by whoever writes that file, since a hook runs in the
agent's environment and cannot see the server's configuration — and decides on freshness:

| Replica state | An unknown capability is |
|---|---|
| current, or node-authoritative | allowed, ungoverned — exactly as before phase 4 |
| stale (past `MAX_POLICY_AGE`, or never confirmed) | denied as `[governance:fault/not-replicated]` |

The degradation ladder cannot be used here, and that is not an oversight: it branches on `riskTier`,
and the tier is precisely what is missing — the same reason the existing tier-unknown branch is a hard
deny. Failing an unknown tool closed costs a call; treating an unreplicated `destructive` capability as
ungoverned costs the guarantee.

**Revocation is unchanged, and that is the point.** It does not travel through any of the above: it
rides the always-full deny-list on every poll, so it lands on a node whose delta stream is broken,
whose replica is frozen for schema skew, and whose SSE connection a proxy closed an hour ago. Past
`MAX_POLICY_AGE` the node fails closed for `mutating`/`destructive` and open for `read_only`.

**Verification.** `npm run test:authority --prefix server` (the node half, no network — the lock per
mutator, the collision, a revoke replicating as a row, a reset removing what central dropped, and both
directions of the unknown-capability rule). `npm run smoke:central-policy --prefix server` (central
against a real Postgres, including that its delta is applied *unmodified* by the node's own
`server/policy/replica.js`). `npm run e2e:authority --prefix server` (a live node against a live
central, following one grant out and back). The last two **skip loudly** rather than passing when
there is nothing to talk to.

---

### Central ingest and the fleet view (`global-identity-and-central-db.md` §2.7 phase 3)

**A separate process, a separate database, and a separate entry point.** `npm run central --prefix
server` (`server/central/index.js`) is not a mode of the node server — it is the other half of §2.2's
topology, and folding them into one entry would put the `pg` dependency and the central code on every
node PC and make one an accident away from becoming the other. It speaks to PostgreSQL 16 and serves
exactly two families of route.

| Method | Path | Certificate scope | Body / query | Response |
|---|---|---|---|---|
| POST | `/api/ingest/usage` | `node` (or `admin`) | `application/x-ndjson` — one `{nodeId, seq, kind, event}` envelope per line | `{ok, accepted, duplicates, corrections, rejected, rejections[], malformed, unknownFields, legacyEnvelopes}` |
| POST | `/api/ingest/reconcile` | `node` (or `admin`) | `{eventCount, chainSeq, chainHash, outboxPending, schemaVersion}` | `{nodeId, checkedAt, verdict, detail, node, central}` |
| GET | `/api/fleet/summary` | `admin` | `?hours=` (default 24) | totals, `byOutcome[]`, `byNode[]` |
| GET | `/api/fleet/nodes` | `admin` | — | the roster, with `silentForMs` and `lastClockSkewMs` per node |
| GET | `/api/fleet/nodes/:nodeId/stream` | `admin` | — | `{events, shipments, minSeq, maxSeq, gaps[]}` |
| GET | `/api/fleet/nodes/:nodeId/verify` | `admin` | — | chain linkage over central's copy: `{checked, ok, breaks[], head}` |
| GET | `/api/fleet/usage` | `admin` | `?by=<dimension>&hours=&limit=` | usage grouped by `subjectId`, `principalId`, `actorBackend`, … |
| GET | `/api/fleet/events` | `admin` | `?limit=&nodeId=` | the live tail |
| GET | `/api/fleet/shadow` | `admin` | `?hours=` | latest verdict per node, the verdict tally, `everyNodeAgrees` |
| GET | `/api/fleet/shadow/history` | `admin` | `?nodeId=&limit=` | the reconciliation ledger |
| GET | `/api/fleet/storage` | `admin` | — | per-partition sizes and `defaultPartitionRows` |
| GET | `/health` | none | — | `{ok, mode: "shadow", defaultPartitionRows}` |

**What is deliberately absent is the contract.** There is no `/api/policy`, no `/api/grants` and no
`/api/capabilities` here. §2.7 promises phase 3 is "reversible by configuration", and the way that
promise is kept is that central has nothing to say a node would listen to: stop this process and
every node enforces exactly as before, having lost only the fleet view. A `node`-scoped certificate
reaches ingest and is refused by every `/api/fleet` route.

**The envelope now carries its shipment number.** `server/store.js`'s `enqueueOutbox` writes
`{nodeId, seq, kind, event}`, where `seq` is the *shipment* number and `event.seq` is the event's
*chain* seq. §2.3 keys idempotent ingest on `(nodeId, seq)` and only the shipment number can carry
that key: a correction re-ships an event that already went up, with the same chain seq and different
contents, so keying on the chain seq would silently discard every consent correction as a redelivery
of the row it corrects. Idempotency is enforced in `usage_shipments` — one narrow unpartitioned row
per shipment, `PRIMARY KEY (nodeId, seq, kind)` — and not by a unique index on `usage_events`,
because Postgres requires a partitioned table's unique index to contain the partition key, and the
partition key is assigned at arrival: a redelivery is a second arrival, so the constraint would look
right and catch nothing.

**`observedAt` is the partition key, and it is central's clock.** `usage_events` is `PARTITION BY
RANGE ("observedAt")` with one partition per UTC month, kept three months ahead and one behind by
`server/central/partitions.js` on an hourly timer, plus a DEFAULT partition so a lapse in maintenance
degrades to a diagnostic rather than a fleet-wide ingest outage. The node's `ts` cannot be the key:
it is nullable per §2.6 (and Postgres requires the key NOT NULL), and it is a clock on a user's own
PC — partitioning on it would let any node bury a month of its own denials in a partition nobody
queries. The node's `ts` and its own `observedAt` are both stored, unmodified, because the latter is
inside the node's hash chain; the delta lands in `clockSkewMs`.

**The comparison is the deliverable.** `npm run shadow:compare --prefix server` runs *on a node*,
reads that node's own database, and POSTs its account of itself — the node reports rather than being
interrogated, so no inbound channel into a user's PC is created for phase 4's authority to arrive
through later. Central compares, stores the verdict in `shadow_reconciliations` and returns it:

| Verdict | Means | Exit code |
|---|---|---|
| `match` | central holds exactly what the node holds | 0 |
| `lagging` | central is behind by no more than the node's outbox depth — the 5-second timer, not a fault | 0 |
| `gap` | shipments central will never receive; the node trimmed them. **The verdict that blocks phase 4** | 1 |
| `divergent` | counts or chain links disagree in a way no lost shipment explains | 1 |

A gap and a chain break are usually one fault seen twice, so a known shipment gap *explains* a
missing link and only an unexplained break reads as `divergent` — otherwise every ordinary trimmed
outbox would report as divergence and the verdict would stop being read.

**Verification.** `npm run smoke:central --prefix server` asserts all of the above against a real
Postgres (51 checks) and **skips** with an explanation when none is configured, so a node developer
has no red gate for a dependency they do not have. `server/central/docker-compose.yml` brings a
scratch one up. The schema is owned by `server/schema/migrator.js` — the same ledger and the same
`SchemaTooNewError` as the node's, through `migrateAsync`, which exists because there is no
synchronous PostgreSQL client for Node and making the one runner async would put a promise on the
node's per-hook boot path.
