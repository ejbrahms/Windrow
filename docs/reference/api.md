# API reference

Every HTTP route Windrow serves, its auth guard, what it reads, and what it returns.

> [!note]
> Generated from the route files (`server/app.js`, `server/policy/routes.js`,
> `server/enrollment/routes.js`, `server/central/routes.js`, `server/central/policyRoutes.js`).
> This is the code-derived reference; for the design rationale behind these endpoints see
> [`docs/design/api-contract.md`](../design/api-contract.md). Where the two disagree, the code
> wins — this file is regenerated from it.

## The two servers

Windrow is two Express processes, each with its own listener set and its own auth model.

**The node** (`server/app.js`) is an enforcement point and API. It runs on every governed machine
and listens on two ports:

- **mTLS** `https://localhost:4443/api` — carries `admin`, `proposer` and `node` scopes, read from
  the client certificate. This is the only listener that can authenticate a dashboard or a CLI.
- **loopback** `http://localhost:4000/api` (bound to `127.0.0.1`) — carries the `agent` scope
  alone, by a machine-local bearer token, for `PreToolUse`/`PostToolUse` hooks. A hook is a fresh
  process per tool call and cannot afford a TLS handshake, so it reaches the local server over
  loopback at ~2 ms.

**The central host** (`server/central/index.js`) is a separate process against PostgreSQL 16, the
fleet's one data sink and — under `WINDROW_POLICY_AUTHORITY=central` — the single writer of policy.
It listens on an mTLS port (default `:5443`) that accepts the same node/admin certificates, plus an
optional loopback plaintext door for the dashboard proxy.

## Auth model

Caller identity rides a **per-node X.509 client certificate over mutual TLS** — never a bearer
token on the mTLS path. Each caller generates a keypair on its own machine, spends a single-use
enrollment token, and receives a certificate whose **Common Name is its `nodeId`** and whose
**Organizational Unit is its scope**: `admin`, `proposer`, `node` (or, on the loopback listener
only, the `agent` bearer token). The private key never leaves the machine it was generated on.

The guards below are the vocabulary used in the tables:

| Guard | Node server | Central server |
|---|---|---|
| **public** | registered ahead of `requireAuth` — no credential needed | mounted without `requireCert` |
| **any** | `requireAuth` — any enrolled certificate or the agent token | — |
| **agent** | `requireAuth`, but specifically reachable by the loopback agent token (the one registry write/read a hook makes) | — |
| **proposer** | `requireProposer` — the `proposer` scope, the only non-admin write | — |
| **admin** | `requireAdmin` — the `admin` scope | `requireCert(['admin'])` |
| **node-cert** | — | `requireCert(['node','admin'])` |

Scope is read from the socket the request arrived on (`req.socket.encrypted` / the peer
certificate's OU), never asserted in the request body.

**IDs** are `<prefix>_<12 hex chars>` — `cap_…` capabilities, `pr_…` principals, `gr_…` grants,
`ev_…` usage events, `src_…` discovery sources. Node ids are `node-` + 16 hex (or a kept id a
standalone install brought with it). List endpoints return arrays sorted newest-first where a
timestamp exists, otherwise by name.

---

# The node API (`server/app.js` + mounted routers)

## Readiness / health

Registered **ahead of `requireAuth`**, so an upgrade script can ask "are you back?" without a token.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/ready` | public | – | `{ready, pid, startedAt, contract}` plus, per state, `warning`/`capabilities`/`reason`/`detail`. **200** when ready, **503** when a central-authority node has never completed a policy pull (`reason:"policy-never-pulled"`). |

`ready` reports the *build*, not just liveness — `contract` is `{version, routes[]}`, the hook-facing
route set an upgrade compares against instead of trusting a 200. A `GET` for any non-`/api/` path
returns **404** with an explainer (`this node serves no dashboard`), not the SPA.

## Capabilities

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/capabilities` | any | – | `Capability[]`, name-sorted, each with an `autoGranted` mirror of the stored `autoGrant` flag |
| POST | `/api/capabilities` | admin | `{kind?, name, owner?, riskTier, description?, autoGrant?}` | created `Capability`, **201**. **400** if `name` missing / `riskTier` not one of `read_only`/`mutating`/`destructive` / `autoGrant` on a `destructive` row; **409** on a duplicate `(kind,name)`. No id is minted here — the bound policy adapter (local or central) issues it. |
| PATCH | `/api/capabilities/:id/auto-grant` | admin | `{autoGrant: boolean}` | updated row with `autoGranted`. **400** non-boolean, or `true` on a `destructive` row; **404** unknown id. Audited `capability_auto_grant_set`. |

`autoGrant=true` exempts a capability from the grant table entirely (every principal may call it) —
never permitted on a `destructive` row, enforced on both write sites above.

## Principals

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/principals` | any | – | `Principal[]`, name-sorted |
| POST | `/api/principals` | admin | `{kind, name, parentRole?, subjectId?, assuranceLevel?}` | created `Principal`, **201**. `kind` ∈ `role`/`instance`/`user`. A `user` **requires** `subjectId` prefixed `win-sid:`/`posix:`/`env-user:`/`federated:` (**400** otherwise, **409** if one already exists). **400** missing name / bad kind. A new `role` gets the read-only baseline of grants. |
| POST | `/api/principals/resolve` | agent | `{loomId, humanName?, backend?, agentType?, field?, standalone?, subjectId?, assuranceLevel?, osUser?}` | `{role, instance, subject}` — the hook path's self-registration. **400** missing `loomId` or an unprefixed `subjectId`. On a replica node this proxies to central; **503** when central is unreachable, **500** otherwise. |
| PATCH | `/api/principals/:id/name` | admin | `{name, reason?}` | updated `Principal`. **404** unknown, **400** empty name, **409** for any kind but `user` (role/instance are keyed on name). Audited `principal_rename`. |
| POST | `/api/principals/:id/approve` | admin | `{reason?}` | updated `Principal` (`status:"active"`). **404** unknown, **409** if not `pending`. Applies the read-only baseline to `role`/`user` kinds. |
| POST | `/api/principals/:id/deny` | admin | `{reason?}` | updated `Principal` (`status:"denied"`, zero grants, row kept). **404**/**409** as above. |
| GET | `/api/principals/owner-proposals` | any | `?status=needs_review\|all` | `{status, summary, proposals[]}` — probable owner per instance, computed per request, persisted nowhere. See shape below. |
| POST | `/api/principals/:id/owner` | admin | `{status?, osUser?, ownerPrincipalId?, proposedOsUser?, reason?}` | `{principal}`. `status` defaults `confirmed` (then `osUser` **required**), or `dismissed`/`unassigned`. **404** unknown / unknown `ownerPrincipalId`; **409** for any kind but `instance`, or an `ownerPrincipalId` that is not a `user`; **400** bad status / missing `osUser`. Changes no authorization decision. |

`GET /api/principals/owner-proposals` shape:

```json
{
  "status": "needs_review",
  "summary": { "instances": 0, "confirmed": 0, "dismissed": 0, "needsReview": 0, "noEvidence": 0 },
  "proposals": [{
    "principal": { "id": "pr_...", "kind": "instance" },
    "owner": { "status": "unassigned", "osUser": null, "principalId": null, "confirmedAt": null, "confirmedBy": null },
    "proposal": {
      "osUser": "...", "hostnames": ["..."], "events": 3, "identifiedEvents": 3,
      "totalEvents": 5, "eventsWithoutOsUser": 2, "share": 1.0,
      "firstSeenAt": "iso", "lastSeenAt": "iso",
      "weak": false, "contested": false,
      "matchedUser": { "id": "pr_...", "name": "...", "subjectId": null, "assuranceLevel": null },
      "matchBasis": "subject-key"
    },
    "candidates": [{ "osUser": "...", "events": 3, "hostnames": ["..."], "firstSeenAt": "iso", "lastSeenAt": "iso" }]
  }]
}
```

## Grants & approvals

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/grants` | any | `?principalId=&capabilityId=` | `Grant[]` |
| POST | `/api/grants` | admin | `{principalId, capabilityId, constraints?, expiresAt?, reason?}` | created `Grant`, **201**. **400** missing ids, **404** unknown principal/capability, **409** if an active grant for the pair exists. Audited `grant_issue`. |
| DELETE | `/api/grants/:id` | admin | `{reason?}` | **204** on success, **404** if not found / already revoked. Audited `grant_revoke`. |
| GET | `/api/approvals` | admin | `?status=` | `Approval[]` |
| GET | `/api/audit` | admin | `?grantId=` | `AuditEntry[]` |
| POST | `/api/grants/propose` | proposer | `{principalId, capabilityId, constraints?, expiresAt?}` | `{pending:true, approval}`, **202**. **400**/**404**/**409** as for a direct grant. Queues an `approvals` row; grants nothing. |
| POST | `/api/grants/:id/propose-revoke` | proposer | – | `{pending:true, approval}`, **202**. **404** unknown grant. |
| POST | `/api/approvals/:id/approve` | admin | – | `{approval, grant}` (grant action) or `{approval, revoked}` (revoke action). **404** unknown, **409** if already decided or the resulting grant conflicts. Executes the queued action. |
| POST | `/api/approvals/:id/deny` | admin | `{reason?}` | `{approval}`. **404**/**409**. |
| POST | `/api/approvals/:id/extend-grant` | admin | `{hours?}` (default 1) | `{approval, grant}` — turns a one-time `consent` approval into a real time-boxed grant. **400** non-consent / bad hours / missing pair, **404** unknown, **409** if not approved or already granted. |

`proposer` is the one non-admin write path (the governance MCP server holds it): it only ever
*queues* an `approvals` row — `POST /api/approvals/:id/approve`, admin-only, is the only thing that
executes one.

## Invoke — the broker

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/api/invoke` | agent | `{principalId, capabilityId, correlationId?, osUser?, hostname?, actorLoomId?, actorAgentType?, actorBackend?, actorField?, subjectId?, assuranceLevel?}` | `{allowed:boolean, event:UsageEvent, policy}`. **400** missing ids; **404** (with `policy`) unknown principal/capability. |

This **is** the broker: it looks up an active (non-expired) grant for the pair, returns `allowed`
with the `event` (outcome `ok`/`denied`), then persists the row and runs shadow evaluation *after*
the response so neither costs the latency the hook measures. `policy` is
`{authority:"node"|"central", version, ageMs}` — whose policy decided and how current the replica
was. Unknown body fields are carried into `usage_events.extra`; a caller can never set
`outcome`/`latencyMs`/`reason`/`nodeId`/`seq`.

## Usage & summary

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| PATCH | `/api/usage/:id` | agent | `{principalId, outcome?, latencyMs?, reason?, capabilityLookupMs?, principalResolveMs?, grantCheckMs?}` | corrected `UsageEvent`. **404** unknown, **403** if `principalId` ≠ the event's, **409** outside the 10-min window / already corrected / illegal outcome transition, **400** bad field. One-way `ok`→`ok`/`error` correction from PostToolUse. |
| POST | `/api/usage/:id/approve-consent` | agent | `{principalId, correlationId?}` | `{event, approval}` — moves a `denied` event a human approved to outcome `approved` and records a `consent` approval. **404**/**403**/**409** as above. |
| GET | `/api/usage/verify` | admin | – | `{nodeId, heads, ok, checked, nodes[]}` — hash-chain integrity per node. |
| GET | `/api/alerts` | admin | `?limit=&since=&severity=&ruleId=` | `{alerts[], engine}` — this node's own alert engine output. |
| GET | `/api/usage` | any | `?principalId=&capabilityId=&limit=` (default 200) | `UsageEvent[]`, newest first |
| GET | `/api/usage/summary` | any | `?granularity=minute\|hour\|day&windowMinutes=&capabilityKind=&riskTier=&capabilityOwner=&capabilitySource=` | aggregate — see shape below |
| GET | `/api/shadow-divergence` | any | `?windowMinutes=&limit=` (default 50) | phase-5 readiness aggregate — see shape below |

`GET /api/usage/summary` returns:

```json
{
  "totals": { "calls": 0, "denied": 0, "denialRate": 0, "avgLatencyMs": 0,
    "avgCapabilityLookupMs": null, "avgPrincipalResolveMs": null, "avgBrokerMs": null, "avgGrantCheckMs": null },
  "byCapability": [ { "capabilityId": "...", "name": "...", "calls": 0, "denied": 0, "avgLatencyMs": 0 } ],
  "byPrincipal": [ { "principalId": "...", "name": "...", "agentName": "...", "calls": 0, "denied": 0 } ],
  "byBucket": [ { "bucket": "iso", "calls": 0, "denied": 0, "avgLatencyMs": null,
    "avgCapabilityLookupMs": null, "avgPrincipalResolveMs": null, "avgBrokerMs": null, "avgGrantCheckMs": null } ],
  "granularity": "day", "windowMinutes": 20160
}
```

Per-phase averages are **null**, not 0, when no event in the window carries that phase. `byPrincipal`
is grouped on `principalId`, never the display `name`.

`GET /api/shadow-divergence` returns:

```json
{
  "enabled": true, "windowMinutes": null,
  "coverage": { "events": 0, "evaluated": 0, "unevaluated": 0, "errored": 0, "notRecorded": 0 },
  "divergent": 0, "divergenceRate": null,
  "wouldBreak": 0, "wouldNewlyAllow": 0,
  "byCapability": [ { "capabilityId": "...", "count": 0, "capability": "kind/name", "reasons": ["..."] } ],
  "recent": [ { "id": "ev_...", "ts": "iso", "capability": "kind/name", "enforced": "allow",
    "shadow": "deny", "shadowReason": "...", "shadowPrincipalId": null,
    "subjectId": null, "assuranceLevel": null, "actorAgentType": null } ]
}
```

`divergenceRate` is **null**, not 0, when nothing was evaluated — "no divergence" and "no evidence"
must not read alike. `wouldBreak` (allowed today, denied by the user-keyed model) is the number that
decides the phase-5 flip.

## Native tool calls — observation, not audit

Read side of native-tool observability: Read/Edit/Bash/Grep calls this system does not govern, kept
in a separate table so they never change the meaning of the `usage_events` audit log.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/native-calls` | any | `?principalId=&toolName=&since=&limit=` | `NativeToolEvent[]` |
| GET | `/api/native-calls/summary` | any | `?windowMinutes=` (default 1440) | `{total, errors, denied, observedFrom, observedTo, byTool[], byPrincipal[]}` |
| GET | `/api/native-calls/timeseries` | any | `?granularity=minute\|hour&windowMinutes=&toolName=` | `{byBucket[], granularity, windowMinutes, bucketMinutes}`, zero-filled |

## Drift

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/drift` | any | – | `{unusedGrants[], highDenial[]}` |

```json
{
  "unusedGrants": [ { "grantId": "...", "principalName": "...", "capabilityName": "...", "grantedAt": "iso", "lastUsedAt": "iso" } ],
  "highDenial": [ { "capabilityId": "...", "name": "...", "denialRate": 0.0, "calls": 0 } ]
}
```

`unusedGrants` = grants idle ≥ 90 days. `highDenial` = capabilities with ≥ 5 calls and a denial
rate ≥ 0.2, worst first.

## Discovery

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/api/discovery/run` | admin | – | scan result `{added, updated, staled, ...}` (plus `proposedToCentral`/`proposalFailures` on a replica) |
| GET | `/api/discovery/last` | any | – | the last run's result. **404** if discovery never ran. |
| GET | `/api/discovery/sources` | any | – | `DiscoverySource[]`, each `{id, path, label, kind, enabled, builtIn, createdAt, exists}` |
| GET | `/api/discovery/browse` | any | `?path=` | `{path, parent, entries[]}` — the server's own filesystem, for the "Browse…" picker. **404** missing path, **400** not a directory. |
| POST | `/api/discovery/sources` | admin | `{path, label?, kind?}` | created source, **201**. **400** missing path / bad `kind` (`skill_dir`\|`mcp_manifest`); **409** duplicate path. |
| PATCH | `/api/discovery/sources/:id` | admin | `{path?, label?, enabled?}` | updated source. **404** unknown, **400** empty path, **409** duplicate. |
| DELETE | `/api/discovery/sources/:id` | admin | – | **204**, **404** unknown |

## Skills

Catalog-only (no grants, no usage) — `GET /api/capabilities` filtered to `kind==="skill"` is the
read side.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/skills/targets` | any | – | `{id, label, path, exists}[]` — provider skill dirs a skill can be written into |
| GET | `/api/skills/:name/presence` | any | – | `{id, label, path, present}[]` — which targets hold this `SKILL.md` |
| POST | `/api/skills` | admin | `{name, description?, targetIds}` | `{slug, written, discovery}`, **201**. **400** invalid skill; **500** if no target could be written. Re-runs discovery. |
| DELETE | `/api/skills/:name` | admin | `{targetIds?}` (omit for everywhere) | `{slug, removed, discovery}`. Re-runs discovery. |

## Providers & packages

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/providers` | any | – | provider list (hook wiring per backend) |
| GET | `/api/hook-integrity` | any | – | the hook-watcher poller state |
| POST | `/api/providers/:id/install` | admin | – | install status. **404** unknown, **400** unsupported. Also enables + syncs the matching package. |
| POST | `/api/providers/:id/uninstall` | admin | – | uninstall status. **404**/**400** as above. Disables the matching package (does not revoke). |
| GET | `/api/packages` | any | – | packages with status |
| POST | `/api/packages/:id/enable` | admin | – | `{package, sync}`. **404** unknown. Enables and syncs. |
| POST | `/api/packages/:id/disable` | admin | – | `{package}`. **404**. Stops future auto-grants; does not revoke. |
| POST | `/api/packages/:id/sync` | admin | – | `{package, sync}`. **404**. |
| POST | `/api/packages/:id/revoke` | admin | – | `{package, revoke}`. **404**. Deletes every grant this package's roles hold on its capabilities. |

## Rollup

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/rollup/fields` | any | `?hours=&limit=` | cross-workspace field list (from central when configured, else a local scan) |
| GET | `/api/rollup/summary` | any | `?hours=&limit=` | cross-workspace usage summary, incl. `totals.clockSkew` and `totals.duplicatesSkipped` |

## Policy distribution channel (`server/policy/routes.js`)

Mounted **after `requireAuth`** and **not on a replica node** (under central authority the node's
own `policy_changes` log means nothing). Three of §2.4's channels, served from this node's own tables.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/policy` | any | `?since=<version>&limit=` (default/max 500) | `{schemaVersion, version, floor, since, servedAt, denyList, reset, changes[]\|snapshot, complete}` — the delta pull. **503** if the store predates the policy log. |
| GET | `/api/policy/deny-list` | any | – | `{schemaVersion, ...}` the always-full revocation list, no version dependency |
| GET | `/api/policy/events` | any | – | `text/event-stream` — one `event: policy` frame `{version}` on connect and after every mutation; carries no policy |
| GET | `/api/policy/status` | any | – | this node's channel view: `{central, running, streamConnected, version, denyListAgeMs, revokedGrants, consecutiveFailures, lastError}` (defined in `app.js`, always mounted) |

The delta channel returns **200** with `Cache-Control: no-store`; an absent/negative `since` reads
as 0 (a snapshot with `reset:true`), never a 400.

---

# Enrollment (`server/enrollment/routes.js`)

Mounted on **both** the node and central, **before `requireAuth`/`requireCert`** — a caller
enrolling has no certificate yet. Authorization is a single-use, admin-minted enrollment token
(stored only as a SHA-256 hash), or a renewal proof over a certificate this CA issued.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/enroll/ca` | public | – | the CA certificate, `application/x-pem-file` (a public key — safe to serve) |
| POST | `/api/enroll` | public (token/proof) | `{publicKey, enrollmentToken?, label?, nodeId?, currentCertificate?, proof?}` | `{nodeId, scope, certificate, caCertificate, notAfter, renewed?}`, **201**. **400** missing `publicKey`/token; **401** invalid or spent token; **403** revoked node; **409** already enrolled without a join credential; **503** if the store lacks enrollment tables. |
| POST | `/api/enrollment-tokens` | admin | `{label?, scope, ttlMs?, maxUses?}` | created token **with the plaintext `token`** (the only time it is readable), **201**. **400** bad scope / `maxUses` out of 1–50. |
| GET | `/api/enrollment-tokens` | admin | – | token list (hashes, never plaintext) |
| DELETE | `/api/enrollment-tokens/:id` | admin | – | revoked token. **404** unknown. |
| GET | `/api/nodes` | admin | – | the node roster |
| DELETE | `/api/nodes/:nodeId` | admin | `{reason?}` | revoked node (takes effect on its next request). **404** unknown. |

The caller never chooses its own `scope` (a would-be self-promotion to admin) — it comes off the
token. A `node`-scoped enrollment may keep its id via a proof or a join credential; other scopes get
a fresh random id.

---

# The central API (`server/central/routes.js`)

A separate process on PostgreSQL 16. Authenticated by certificate (`requireCert`), doing its own
check rather than importing the node's `server/auth.js`. Ingest accepts `node` **or** `admin`
certificates; every `/api/fleet` route is `admin`-only except the node-scoped rollup. The
enrollment routers above are also mounted here (skipped entirely under the read-only demo).

## Central ingest (node → central)

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| POST | `/api/ingest/usage` | node-cert | `application/x-ndjson`, one `{nodeId, seq, kind, event}` envelope per line (16 mb) | `{ok, traceId, accepted, duplicates, corrections, rejected, rejections[], malformed, deadLettered, unknownFields, legacyEnvelopes}` |
| POST | `/api/ingest/alerts` | node-cert | JSON (1 mb) node-fired alerts | `{ok, accepted, duplicates, rejected, rejections[]}` |
| POST | `/api/ingest/native` | node-cert | `application/x-ndjson` native observations | `{ok, accepted, duplicates, rejected, rejections[], malformed, unknownFields}` |
| POST | `/api/ingest/node-health` | node-cert | JSON (512 kb) hook integrity + fault journal | `{ok, ...}` |
| POST | `/api/ingest/reconcile` | node-cert | `{eventCount, chainSeq, chainHash, outboxPending, schemaVersion, nodeId?}` | `{nodeId, checkedAt, verdict, detail, node, central}`. **400** if no node id. |

A `node` certificate can only report **its own** machine — `scopeId`/`nodeId` are forced to the
authenticated CN and a claim about another node is refused.

## Central fleet (dashboard → central)

All `admin`-cert. `?hours=` defaults to 24 where a window applies.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/fleet/summary` | admin | `?hours=` | totals, `byOutcome[]`, `byNode[]` |
| GET | `/api/fleet/nodes` | admin | – | `{nodes[]}` roster, with `silentForMs`/`lastClockSkewMs` |
| GET | `/api/fleet/divergence` | admin | – | which nodes are not enforcing right now (live pauses only) |
| GET | `/api/fleet/nodes/:nodeId/journal` | admin | `?pauseId=&limit=` | the node's fault journal — what it decided without central |
| GET | `/api/fleet/nodes/:nodeId/facts` | admin | – | machine facts (discovery sources, adapters, packages) as last reported |
| GET | `/api/fleet/nodes/:nodeId/stream` | admin | – | `{events, shipments, minSeq, maxSeq, gaps[]}` |
| GET | `/api/fleet/nodes/:nodeId/verify` | admin | – | chain linkage over central's copy: `{checked, ok, breaks[], head}` |
| GET | `/api/fleet/usage` | admin | `?by=<dimension>&hours=&limit=` | `{by, rows[]}` grouped by `principalId`/`subjectId`/`actorBackend`/… |
| GET | `/api/fleet/events` | admin | `?limit=&nodeId=` | `{events[]}` the live tail |
| GET | `/api/fleet/usage/series` | admin | `?granularity=&windowMinutes=&nodeId=` | governed-decisions time series (bucketed on central's `observedAt`) |
| GET | `/api/fleet/dead-letters` | admin | `?status=quarantined\|all&traceId=&nodeId=&limit=` | packets central could not store |
| POST | `/api/fleet/dead-letters/replay` | admin | `{ids[]}` | replay result. **400** if `ids` empty. |
| POST | `/api/fleet/dead-letters/discard` | admin | `{ids[]}` | discard result (a marker, not a delete). **400** if empty. |
| GET | `/api/fleet/shadow` | admin | `?hours=` | latest verdict per node, tally, `everyNodeAgrees` (window ×7) |
| GET | `/api/fleet/shadow/history` | admin | `?nodeId=&limit=` | `{checks[]}` the reconciliation ledger |
| GET | `/api/fleet/alerts` | admin | `?limit=&since=&severity=&ruleId=&nodeId=&subjectId=` | `{alerts[], engine}`, from either end (`firedBy`) |
| GET | `/api/fleet/storage` | admin | – | per-partition sizes and `defaultPartitionRows` |
| GET | `/api/fleet/settings` | admin | – | `{mode, security, bundleBuilt, storage, parameters[], profiles[]}` — central's posture and the fleet policy parameters |
| GET | `/api/fleet/integrations` | admin | – | `{mode, writable, nodes, integrations[]}` — per-package fleet decision + per-node adoption |
| POST | `/api/fleet/integrations/:id/enable` | admin | – | `{integration, sync}`. **404** unknown; **409** in shadow mode (needs authority). |
| POST | `/api/fleet/integrations/:id/disable` | admin | – | `{integration}`. Records the decision only (no revoke). **404**/**409**. |
| POST | `/api/fleet/integrations/:id/sync` | admin | – | `{integration, sync}`. **404**/**409**. |
| POST | `/api/fleet/integrations/:id/revoke` | admin | – | `{integration, revoke}`. **404**/**409**. |
| GET | `/api/fleet/integrations/:id/detail` | admin | – | per-role grant matrix for one package. **404** unknown; **409** in shadow mode. |
| GET | `/api/fleet/native` | admin | `?hours=&nodeId=&limit=` | fleet native-observation summary |
| GET | `/api/fleet/native/series` | admin | `?granularity=&windowMinutes=&nodeId=&toolName=` | fleet native calls-over-time |
| GET | `/api/fleet/hooks` | admin | `?unhealthy=1` | `{nodes[]}` — which machines are not governed |
| GET | `/api/fleet/rollup` | node-cert | `?hours=&nodeId=&limit=` | the cross-field rollup. **A node cert is pinned to its own node id**; an admin cert may take the fleet. |
| GET | `/health` | public | – | `{ok, mode:"shadow"\|"authority", defaultPartitionRows, demo}`. `demo:true` on the public read-only demo (gates the dashboard's demo-only Sandbox). **503** if Postgres is unreachable. |

The dashboard SPA (`client/dist`) is served here, after every `/api/*` route and before a JSON
**404**; a missing bundle answers **503** naming `npm run build`.

## Central policy authority (`server/central/policyRoutes.js`)

Phase-4 control plane, mounted under `/api/policy` on the same origin. **READ** (the replica
channel) and **PROPOSE** (the two discovery writes a node may cause) take a `node` certificate;
**DECIDE** takes `admin`.

| Method | Path | Auth | Body/Query | Returns |
|---|---|---|---|---|
| GET | `/api/policy` | node-cert | `?since=<v>&limit=` | the delta pull; records the caller's replica version from the **certificate CN**, never a query param |
| GET | `/api/policy/deny-list` | node-cert | – | the always-full list, no version dependency |
| GET | `/api/policy/events` | node-cert | – | SSE `{version}`, carries no policy |
| POST | `/api/policy/capabilities/resolve` | node-cert | `{kind?, name, riskTier?, description?, owner?}` | the canonical capability row (**201** if newly minted, else **200**). **400** missing name. **Cannot retier** an existing row; an untiered proposal lands `read_only`. |
| POST | `/api/policy/principals/resolve` | node-cert | `{loomId, ...identity}` | `{role, instance, subject}` — the hook path's registration at the authority. **400** missing `loomId` / unprefixed `subjectId`. |
| GET | `/api/policy/capabilities` | node-cert | – | `Capability[]` |
| POST | `/api/policy/capabilities` | admin | `{kind?, name, owner?, riskTier, description?, ...}` | created row, **201**. **409** conflict. Audited `capability_register`. |
| PATCH | `/api/policy/capabilities/:id/auto-grant` | admin | `{autoGrant}` | updated row. **400** non-boolean, **404** unknown. |
| GET | `/api/policy/principals` | node-cert | – | `Principal[]` |
| POST | `/api/policy/principals` | admin | `{kind, name, ...}` | created, **201**. **409** conflict. |
| PATCH | `/api/policy/principals/:id` | admin | `{status?/name?/owner?, reason?}` | updated (status, name and owner are one operation centrally). **404** unknown. |
| GET | `/api/policy/grants` | node-cert | `?principalId=&capabilityId=` | `Grant[]` |
| POST | `/api/policy/grants` | admin | `{principalId, capabilityId, ...}` | created, **201**. **409** conflict. |
| DELETE | `/api/policy/grants/:id` | admin | `{reason?}` | **200 with the revoked row** (not 204) — its `revokedAt` is the evidence it landed. **404** unknown. |
| GET | `/api/policy/approvals` | admin | `?status=` | `Approval[]` |
| POST | `/api/policy/approvals` | node-cert | `{action, ...}` | created approval, **201** (a proposal, grants nothing). |
| POST | `/api/policy/approvals/:id/decide` | admin | `{status, reason?}` | decided approval — an approved `grant_capability` becomes the grant in the same transaction. **400** bad status; **404** unknown; **409** already decided / grant conflict. |
| GET | `/api/policy/audit` | admin | `?limit=` | `{entries[]}` control-plane audit |
| GET | `/api/fleet/policy` | admin | – | every node's replica version against central's head — who is behind, by how much |
| GET | `/api/policy/node-profiles` | admin | – | `{profiles[]}` |
| PUT | `/api/policy/node-profiles/:name` | admin | `{description?, config?, constraints?}` | upserted profile |
| DELETE | `/api/policy/node-profiles/:name` | admin | – | deletion result |
| PUT | `/api/policy/nodes/:nodeId/profile` | admin | `{profile}` | the node's assigned profile |

A `node` certificate can read the whole policy because it *replicates* it; what it cannot do is
decide what any of it permits.
