# Windrow: managing and observing agent access to skills and MCPs

> [!important]
> Today, what a skill or MCP an agent can reach is whatever its config file happens to list, and nobody
> can answer "who used the Gmail MCP last week" without grepping transcripts. This design adds one
> layer — a **registry + broker + event log** — sitting between agents and their tools, so access is
> granted on purpose and every call leaves a record.

> [!note]
> **Skills and tools are conceptually separate, and this diagram is drawn for the tool half.**
> MCP tools are what the broker actually gates: every call passes through `PreToolUse`, gets
> checked against a grant, and lands in the usage log. Skills have no equivalent choke point —
> there's no `PreToolUse` hook that fires per skill invocation the way there is per MCP call — so
> skill usage isn't tracked, and by design doesn't need to be. Skills still live in the same
> **catalog** (discovered from `SKILL.md` files, browsable across providers so "what skills exist
> anywhere on this machine" is one query), but a skill entry is reference data, not a governed
> capability: no grants are issued against it and no usage event is ever logged for it. See
> "Skills vs. tools" below.

```mermaid
flowchart LR
  Agent[Agent] -->|wants to call an MCP tool| Broker{Capability Broker}
  Broker -->|check| Registry[(Capability Registry)]
  Broker -->|allow| Tool[MCP tool executes]
  Broker -->|deny| Blocked[Blocked + logged]
  Tool --> Events[(Usage Event Log)]
  Blocked --> Events
  Events --> Dash[Dashboard & Alerts]
```

## 0. Skills vs. tools

The registry holds two different kinds of entry, and only one of them is *governed*:

| | Skills | MCP tools |
|---|---|---|
| **What it is** | A `SKILL.md`-defined capability, invoked via the harness's own `Skill` tool | A tool exposed by an MCP server (`mcp__<server>__<tool>`) |
| **In the catalog?** | Yes — discovered from `SKILL.md` files across every configured skill directory, across providers | Yes — discovered from MCP config / a live `tools/list` |
| **Has a `PreToolUse` choke point?** | No — the harness doesn't route a skill invocation through a distinct, interceptable per-call hook the way it does an MCP call | Yes — every call passes through `PreToolUse`/`PostToolUse` |
| **Grants issued against it?** | No | Yes |
| **Usage tracked?** | No | Yes — every call logged with outcome/latency |
| **What the catalog entry is for** | Discoverability: "what skills exist, where, described how" — a centralized index across providers, nothing more | Discoverability **and** enforcement |

Skills therefore aren't a lesser-tracked version of a tool — they're not tracked at all, on purpose,
because there's nothing to intercept. Treat the catalog's skill entries the way you'd treat a
searchable index or README, not a permission boundary. Everywhere below that talks about grants,
enforcement, or usage events, read "capability" as "MCP tool" — skills stay out of that half of
the system entirely.

## 1. The four things being tracked

```stats
Capability: an MCP tool (skills are cataloged separately — see §0)
Principal: an agent role or a specific agent instance
Grant: a principal's permission to use a capability
Usage event: one call, logged win or lose
```

| Entity | What it is | Example |
|---|---|---|
| **Capability** | One MCP server/tool, versioned. (Skills are catalog-only — see §0 — and aren't a `Capability` in the grant/usage sense even though they share a catalog table.) | `mcp__claude-design__write_files` |
| **Principal** | Who is asking — an agent *role* (default grants) or a specific *instance* (instance id, session) | role `design-agent`, instance `claude-msqvb0zl-4` |
| **Grant** | A principal's permission to use a capability, with constraints | rate limit, expiry, "read-only MCP calls only" |
| **UsageEvent** | One invocation: who, what, when, outcome, latency | `denied`, `ok (240ms)`, `error` |

## 2. Enforcement: one broker, not scattered checks

The broker is the same choke point every tool call already passes through — the harness's
pre-tool-call hook (`PreToolUse` in Claude Code terms). It doesn't add a new interception layer;
it adds a policy decision *inside* the one that exists.

```mermaid
sequenceDiagram
  participant A as Agent runtime
  participant B as Capability Broker
  participant R as Registry
  participant T as MCP tool
  participant L as Event Log
  A->>B: invoke(capability, args)
  B->>R: lookup grant(principal, capability)
  alt granted
    B->>T: execute
    T-->>B: result
    B->>L: log(ok, latency, outcome)
    B-->>A: result
  else not granted
    B->>L: log(denied, reason)
    B-->>A: refused
  end
```

> [!note]
> Denials are logged with the same weight as successes. A spike in `denied` for one principal is
> either a misconfigured grant blocking real work, or an agent probing for access it shouldn't have —
> both are worth paging on, and neither shows up if only successes are recorded.

## 3. Data model

```mermaid
erDiagram
  PRINCIPAL ||--o{ GRANT : holds
  CAPABILITY ||--o{ GRANT : "granted via"
  PRINCIPAL ||--o{ USAGE_EVENT : performs
  CAPABILITY ||--o{ USAGE_EVENT : "invoked on"
  PRINCIPAL {
    string id
    string kind "role | instance"
    string parent_role
  }
  CAPABILITY {
    string id
    string kind "skill | mcp_tool"
    string owner
    string risk_tier
  }
  GRANT {
    string principal_id
    string capability_id
    string constraints
    datetime expires_at
  }
  USAGE_EVENT {
    string principal_id
    string capability_id
    datetime ts
    string outcome
    int latency_ms
    string correlation_id
  }
```

`kind` still carries `"skill"` as a value — the catalog table is shared, see §0 — but only
`mcp_tool` rows ever get a `GRANT` or a `USAGE_EVENT` in practice; a `skill`-kind row exists purely
for the catalog view.

`UsageEvent` never stores full call payloads by default — just capability id, outcome, latency, and
a correlation id (task/session). A verbose debug mode can capture redacted argument digests, with a
short retention window, for the rare case someone needs to reconstruct what an agent actually sent.

## 4. Risk tiers drive how a grant is issued

| Tier | Examples | Default policy |
|---|---|---|
| **Read-only** | `list_files`, `search_threads` | Auto-granted to any role that needs it |
| **Mutating** | `write_files`, `create_draft`, `trash_message` | Explicit grant per role, visible in registry |
| **Destructive / outward-facing** | `delete_files`, `wispfield_clear_field`, push/deploy tools | Explicit grant **plus** first-use notification to the owner |

Risk tiers apply to MCP tools only — skills have no grant to tier (§0). Grants are role-scoped by
default (all `design` agents get the same MCP set) with instance-level overrides for the rare
one-off — mirroring how `.claude/settings.json` permissions work today, just extended to MCP tools
instead of only bash commands.

## 5. What the dashboard shows

```bars
Granted, used weekly     42
Granted, used rarely      19
Granted, never used       11
```

Three views, all built from the same event log:

- **Catalog view** — every capability, which roles can reach it, risk tier, owner. This is the
  answer to "what could an agent do."
- **Usage view** — per capability: call volume over time, top principals, error/denial rate, p50/p99
  latency. This is the answer to "what did agents actually do, and by whom."
- **Drift view** — capabilities granted but unused in 90 days (prune candidates), and capabilities
  *denied* more than a threshold (either dead weight or a misconfigured principal). This is the
  answer to "what's stale or broken."

## 6. Rollout

| Phase | Delivers | Enforcement |
|---|---|---|
| 1 | Registry (scan skill dirs for the catalog + MCP configs for governed capabilities) + append-only JSONL event log per session | Log only, no denial |
| 2 | Central event store (SQLite/Postgres) + broker checks grants at call time + web dashboard | Deny on missing grant |
| 3 | Risk-tier approval workflow, unused-grant pruning report, alerting on denial spikes | Full policy engine |

> [!tip]
> Ship Phase 1 first and let it run for a couple of weeks before turning on enforcement — the
> unused/denied data from real traffic is what tells you whether the default grants you're about to
> lock in are actually right.
