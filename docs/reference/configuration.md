# Configuration reference

Every setting Windrow reads, what it does, and its default. All of it is optional — an
unconfigured server uses sane defaults for a single local workspace.

`npm run setup` writes what it decides into `windrow.env` at the repo root —
[`windrow.env.example`](../../windrow.env.example) is the annotated template of that file, showing
every variable below in the shape a real one holds it. It is a reference, not a config: run the
wizard rather than copying it, since the placeholder values configure nothing real.

> [!important]
> **A real environment variable always wins over a line in `windrow.env`.** A sandbox, a one-off
> `VAR=… npm start`, and the values captured onto a Windows service in `server/daemon/*.xml` all
> override it. Run `npm run setup -- --show` to print the effective configuration and where each
> value came from.

Every runtime read goes through `envCompat(name)` in `server/config.js`, which resolves the name
with the `WINDROW_` prefix — so `envCompat('SHIP_INTERVAL_MS')` is `WINDROW_SHIP_INTERVAL_MS`. The
`grep` at the bottom of this page is the authoritative list; the tables below are that list, named.

## Standalone — the base surface

| Env var | Purpose | Default |
|---|---|---|
| `PORT` | Port the supervisor listens on; hooks connect here | `4000` |
| `WINDROW_UPSTREAM_PORT` | Private port the supervisor runs the API child on | `4100` |
| `WINDROW_PARK_MS` | How long the supervisor parks a request across a backend restart | `5000` |
| `WINDROW_TLS_PORT` | Mutual-TLS listener for the dashboard and CLI | `4443` |
| `WINDROW_DB_PATH` | The SQLite registry | `server/data/windrow.db` |
| `WINDROW_DATA_DIR` | Where this node's on-disk state lives — the deny-list, signed caches, subject marker and fault journal. Point the host-side hook and a containerised service at the same volume with this | `server/data` |
| `WINDROW_ENV_FILE` | Path to the `KEY=value` file loaded before anything reads `process.env` | `windrow.env` at the repo root |
| `WINDROW_NO_ENV_FILE` | `1` skips loading `windrow.env` entirely — every value must then come from the real environment | off |
| `WINDROW_USER_HOME` | The real user's home, so a `LocalSystem` service reaches `~/.claude` | `os.homedir()` |
| `SKILL_DIRS` | `;`-separated directories scanned for `SKILL.md` files | this workspace's Claude Code + Antigravity skill dirs |
| `HOOK_INSTALL_PATHS` | JSON object overriding where each backend's hook config lives | user-level `settings.json` (Claude), `~/.gemini/config/hooks.json` (Antigravity) |
| `WINDROW_SHADOW_EVAL` | Evaluate the central verdict alongside the local one; `0` disables | on |
| `WINDROW_OBSERVE_NATIVE_TOOLS` | Record native (non-MCP) tool calls | on |
| `WINDROW_NATIVE_JOURNAL_MAX_BYTES` | Cap on the host-side native-tool spool the hook appends to before the service drains it | `16 MiB` |
| `WINDROW_CAPABILITY_CACHE_TTL_MS` | How long the hook and cache-warmer trust a cached capability list | `30000` |
| `WINDROW_CACHE_WARM_INTERVAL_MS` | How often the cache-warmer refreshes that list | `0.6 ×` the cache TTL |
| `WINDROW_AGENT_TOKEN_PATH` | The agent API bearer token this server issues and reads | `server/data/agent-api-token` |
| `WINDROW_OWNER_SIGNING_KEY_PATH` | The owner signing key used for owner-confirmation | `server/data/owner-signing-key` |

### Hook and MCP clients

The dial these clients use to reach the supervisor. Set them only when the API is not on the
default loopback port.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_API_BASE` | Base API URL the in-process hook client and the CLI tools (`enforcement`, `upgrade`) dial | `http://127.0.0.1:4000/api` for the hook; the CLI tools default to the mTLS `https://127.0.0.1:4443/api` |
| `WINDROW_API_URL` | Base API URL the MCP server dials | `https://localhost:4443/api` |

## A node in a fleet

Everything above, plus the variable that turns a standalone install into a fleet member.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_URL` | Where usage is shipped and policy pulled from. **Unset means standalone** — this single variable is what makes a machine part of a fleet | unset |
| `WINDROW_POLICY_AUTHORITY` | `node` or `central`. `central` is ignored unless `WINDROW_CENTRAL_URL` is also set, and the process says so at startup | `node` |
| `WINDROW_ROLLUP_SOURCE` | `auto`, `local`, or `central` — whether rollups are computed locally or fetched from central | `auto` |
| `WINDROW_CENTRAL_ROLLUP_PATH` | Path on central the rollup is fetched from | `/api/fleet/rollup` |
| `WINDROW_NODE_ID` | The id this node ships under; normally minted at enrollment | from the store |

### Enrollment and credential renewal

How a node joins a fleet and keeps its client certificate current.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CREDENTIAL_DIR` | Where the enrollment credential (key, cert, CA) lives | `server/data/credentials` |
| `WINDROW_CA_DIR` | The enrollment CA this node issues its own `:4443` certificate from | `server/data/ca` |
| `WINDROW_ENROLLMENT_TOKEN` | The join token used by `npm run enroll` when none is passed on the command line | unset |
| `WINDROW_SHIP_CREDENTIAL_NAME` | Name of the client certificate a node presents to central across every channel | `node-shipper` |
| `WINDROW_CREDENTIAL_CHECK_INTERVAL_MS` | How often the renewal loop checks whether the certificate is near expiry | `86400000` (1 day) |
| `WINDROW_CREDENTIAL_RENEW_AT_FRACTION` | Renew once this fraction of the certificate lifetime remains | `0.333` (a third) |

### Usage shipping — node → central

The outbox that drains governed usage events to central.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_INGEST_PATH` | Path on central usage batches are POSTed to | `/api/ingest/usage` |
| `WINDROW_SHIP_INTERVAL_MS` | How often the outbox drains | `5000` |
| `WINDROW_SHIP_BATCH_MAX` | Rows in one request | `500` |
| `WINDROW_SHIP_MAX_BATCHES` | Full batches one cycle chases before yielding to the timer | `20` |
| `WINDROW_SHIP_MAX_OUTBOX_ROWS` | Backstop: past this the oldest unshipped rows are dropped | `100000` |
| `WINDROW_SHIP_TIMEOUT_MS` | Per-request timeout | `15000` |
| `WINDROW_SHIP_BACKOFF_CAP_MS` | Ceiling on the doubling retry backoff when central is down | `300000` (5 min) |

### Native-tool observation — node → central

The higher-volume spool of non-MCP tool calls, drained locally then shipped.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_NATIVE_DRAIN_INTERVAL_MS` | How often the host-side spool is drained into the DB | `15000` |
| `WINDROW_NATIVE_RETENTION_DAYS` | Days of native observations kept before trimming | `14` |
| `WINDROW_NATIVE_DRAIN_MAX_LINES` | Lines one drain ingests before yielding | `20000` |
| `WINDROW_CENTRAL_NATIVE_INGEST_PATH` | Path on central native batches are POSTed to | `/api/ingest/native` |
| `WINDROW_NATIVE_SHIP_INTERVAL_MS` | How often native rows ship | `30000` |
| `WINDROW_NATIVE_SHIP_BATCH_MAX` | Rows in one request | `2000` |
| `WINDROW_NATIVE_SHIP_MAX_BATCHES` | Full batches one cycle chases | `10` |
| `WINDROW_NATIVE_MAX_UNSHIPPED` | Backstop: past this the oldest unshipped rows are dropped | `500000` |
| `WINDROW_NATIVE_SHIP_BACKOFF_CAP_MS` | Ceiling on the retry backoff | `300000` (5 min) |

### Node health reporting — node → central

The periodic report that lets central see a node is alive and its hook wiring intact.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_HEALTH_INGEST_PATH` | Path on central health reports are POSTed to | `/api/ingest/node-health` |
| `WINDROW_HEALTH_REPORT_INTERVAL_MS` | How often a report is sent | `300000` (5 min) |
| `WINDROW_HEALTH_JOURNAL_MAX_LINES` | Tamper-journal entries that travel with a report | `400` |
| `WINDROW_HEALTH_JOURNAL_MAX_BYTES` | Byte cap on that journal slice | `196608` (192 KiB) |

### Alerts — node

Local alert evaluation and the shipping of fired alerts to central.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_ALERT_DEBOUNCE_MS` | Debounce between alert re-evaluations | `1000` |
| `WINDROW_ALERT_MIN_INTERVAL_MS` | Floor between evaluations under sustained load | `5000` |
| `WINDROW_ALERT_SWEEP_INTERVAL_MS` | The unconditional periodic sweep | `60000` |
| `WINDROW_CENTRAL_ALERT_INGEST_PATH` | Path on central fired alerts are POSTed to | `/api/ingest/alerts` |
| `WINDROW_ALERT_SHIP_BATCH_MAX` | Alerts in one request | `200` |

### Policy client — node

The pull-and-subscribe channel that keeps a replica node's deny-list and policy parameters current.

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_POLICY_PATH` | Path the signed policy is pulled from | `/api/policy` |
| `WINDROW_CENTRAL_POLICY_EVENTS_PATH` | SSE endpoint for live policy changes | `/api/policy/events` |
| `WINDROW_POLICY_POLL_INTERVAL_MS` | How often policy is polled when the SSE channel is down | `30000` |
| `WINDROW_POLICY_TIMEOUT_MS` | Per-request timeout | `15000` |
| `WINDROW_POLICY_BACKOFF_CAP_MS` | Ceiling on the retry backoff | `300000` (5 min) |
| `WINDROW_POLICY_SSE_RECONNECT_MS` | Wait before re-opening a dropped SSE connection | `5000` |
| `WINDROW_POLICY_CREDENTIAL_NAME` | Client certificate the policy client presents | falls back to `WINDROW_SHIP_CREDENTIAL_NAME`, then `node-shipper` |
| `WINDROW_CENTRAL_RECONCILE_PATH` | Path the shadow-compare check POSTs its self-account to | `/api/ingest/reconcile` |

### Policy parameters — a floor, not an override

These eight numbers decide whether governance holds, so in a fleet **central states them and a
local value may only make them _more restrictive_, never less** (`server/policy/nodeConfig.js`). On
a standalone install, or before a node's first successful policy pull, the local value stands.

| Env var | Purpose | Default (also the fallback) |
|---|---|---|
| `WINDROW_MAX_POLICY_AGE_MS` | How long a partitioned node keeps enforcing stale policy. **Lower is tighter** | `900000` (15 min) |
| `WINDROW_ALLOW_ENFORCEMENT_PAUSE` | Whether this node may pause enforcement at all. **`false` is tighter** | `true` |
| `WINDROW_MAX_PAUSE_MS` | Ceiling on a single enforcement pause. **Lower is tighter** | `1800000` (30 min) |
| `WINDROW_DEFAULT_PAUSE_MS` | Length of a pause when none is given. **Lower is tighter** | `900000` (15 min) |
| `WINDROW_PAUSABLE_TIERS` | Risk tiers a pause may cover, comma/semicolon list. **Shorter is tighter** | `read_only,mutating,destructive` |
| `WINDROW_MAX_LEASE_MS` | Ceiling on a maintenance grace lease. **Lower is tighter** | `3600000` (60 min) |
| `WINDROW_LEASABLE_TIERS` | Risk tiers a lease may cover. **Shorter is tighter** | `read_only,mutating` |
| `WINDROW_MAX_RISK_TIER` | The node's ceiling risk tier — e.g. a laptop may not host `destructive`. **Lower on the scale is tighter** | none (no ceiling) |
| `WINDROW_CAPABILITY_ALLOWLIST` | Capabilities this node may run; a present-but-empty list allows nothing. **Shorter is tighter** | none (every capability the fleet allows) |

## The central host

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_DB_URL` | The Postgres. Also accepts `DATABASE_URL` or the `PG*` set | none — central refuses to start without one |
| `WINDROW_CENTRAL_DB_POOL_MAX` | Connection pool size | `10` |
| `WINDROW_CENTRAL_DB_CONNECT_TIMEOUT_MS` | How long a connect may hang before failing fast | `10000` |
| `WINDROW_CENTRAL_TLS_PORT` | The mutual-TLS listener nodes connect to | `5443` |
| `WINDROW_CENTRAL_PORT` | Loopback plaintext listener, only with the next variable | `5000` |
| `WINDROW_CENTRAL_ALLOW_INSECURE` | `1` opens that plaintext listener. **Development only** — a batch on it is attributed to whatever node id it claims. Set inside the container so the health check and the dashboard proxy can reach `/health` and `/api` on the container's own loopback | off |
| `WINDROW_CENTRAL_DASHBOARD_PORT` | The browser's door. `server/central/dashboardProxy.js` listens here and forwards to the plaintext listener over the container's loopback, so a browser reaches the dashboard with **no client certificate** — the thing `:5443` cannot offer. Published to the host's `127.0.0.1` only, because anything that reaches it has full admin. Empty turns the door off and goes back to mTLS-only | `5599` in the container; unset (off) otherwise |
| `WINDROW_CENTRAL_DASHBOARD_ORIGINS` | Extra origins a mutating dashboard request may come from, comma-separated, on top of the loopback names | none |
| `WINDROW_CENTRAL_DEMO_READONLY` | `1` puts central into the public read-only demo mode (`docs/design/vercel-supabase-demo.md`) — every mutating route is refused | off |
| `WINDROW_SERVER_SANS` | Hostnames/IPs baked into central's server certificate. **Add every name a node will actually dial** — a node dialling a name that is not a SAN fails verification. Changing it after first boot needs the old `server-cert.pem` deleted from the volume, because `ca.js` loads an existing cert rather than reissuing it | this host's hostname (`windrow-central,host.docker.internal` in the container) |
| `WINDROW_CENTRAL_RETENTION_MONTHS` | Months of usage to keep; unset keeps everything | keep everything |
| `WINDROW_CENTRAL_MAINTENANCE_INTERVAL_MS` | How often central runs retention/partition maintenance | `3600000` (1 hour) |
| `WINDROW_CENTRAL_ALERT_SWEEP_MS` | How often central's own alert engine sweeps | `60000` |
| `WINDROW_PROPAGATION_WINDOW_MS` | Window central holds a policy change open for delta subscribers | `90000` |
| `WINDROW_BOOTSTRAP_TOKEN_PATH` | Where the one-shot bootstrap enrollment token is written and read | `<data-dir>/bootstrap-enrollment-token` |
| `WINDROW_MAX_JOIN_USES` | How many nodes one join token may enrol before it is spent | `50` |

## The containerised central

Reads a second, smaller set — not through `config.js`, but by Docker Compose interpolating them
into `server/central/docker-compose.yml`. Set them in the shell (or a `.env` beside the compose
file) before `npm run central:up`; the `WINDROW_*` values above are set *inside* the container by
the compose file itself and are not what you tune here.

| Compose var | Purpose | Default |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials and name for the bundled Postgres, and the DSN central connects with | `windrow` / `windrow` / `windrow_central` |
| `POSTGRES_PORT` | Host port the Postgres container publishes | `5432` |
| `CENTRAL_TLS_PORT` | Host port mapped to central's `:5443` mTLS listener | `5443` |
| `CENTRAL_DASHBOARD_PORT` | Host port (bound to `127.0.0.1`) mapped to the `:5599` dashboard proxy | `5599` |
| `WINDROW_SERVER_SANS` | Passed through to the container's certificate SANs (above) | `windrow-central,host.docker.internal` |


## Keeping this honest

The authoritative list is the code:

```bash
grep -rn "envCompat(" server
```

`envCompat` resolves a name with the `WINDROW_` prefix and refuses the pre-rename `GOVERNANCE_`
spellings loudly rather than silently ignoring them — see `assertNoLegacyEnv` in
`server/config.js`. A handful of bootstrap and enrollment values (`WINDROW_DATA_DIR`,
`WINDROW_ENV_FILE`, `WINDROW_ENROLLMENT_TOKEN`, `WINDROW_BOOTSTRAP_TOKEN_PATH`, the credential-renew
knobs) are read straight from `process.env` because they are needed before `envCompat` is defined or
live outside the server process; `grep -rn "process.env.WINDROW_" server scripts` finds those.
