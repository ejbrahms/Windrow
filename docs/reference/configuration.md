# Configuration reference

Every setting Windrow reads, what it does, and its default. All of it is optional — an
unconfigured server uses sane defaults for a single local workspace.

`npm run setup` writes what it decides into `windrow.env` at the repo root.

> [!important]
> **A real environment variable always wins over a line in `windrow.env`.** A sandbox, a one-off
> `VAR=… npm start`, and the values captured onto a Windows service in `server/daemon/*.xml` all
> override it. Run `npm run setup -- --show` to print the effective configuration and where each
> value came from.

| Env var | Purpose | Default |
|---|---|---|
| `PORT` | Port the supervisor listens on; hooks connect here | `4000` |
| `WINDROW_UPSTREAM_PORT` | Private port the supervisor runs the API child on | `4100` |
| `WINDROW_PARK_MS` | How long the supervisor parks a request across a backend restart | `5000` |
| `WINDROW_TLS_PORT` | Mutual-TLS listener for the dashboard and CLI | `4443` |
| `WINDROW_DB_PATH` | The SQLite registry | `server/data/windrow.db` |
| `WINDROW_USER_HOME` | The real user's home, so a `LocalSystem` service reaches `~/.claude` | `os.homedir()` |
| `SKILL_DIRS` | `;`-separated directories scanned for `SKILL.md` files | this workspace's Claude Code + Antigravity skill dirs |
| `HOOK_INSTALL_PATHS` | JSON object overriding where each backend's hook config lives | user-level `settings.json` (Claude), `~/.gemini/config/hooks.json` (Antigravity) |
| `WINDROW_SHADOW_EVAL` | Evaluate the central verdict alongside the local one; `0` disables | on |
| `WINDROW_OBSERVE_NATIVE_TOOLS` | Record native (non-MCP) tool calls | off |

**A node in a fleet** — everything above, plus:

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_URL` | Where usage is shipped and policy pulled from. **Unset means standalone** — this single variable is what makes a machine part of a fleet | unset |
| `WINDROW_POLICY_AUTHORITY` | `node` or `central`. `central` is ignored unless `WINDROW_CENTRAL_URL` is also set, and the process says so at startup | `node` |
| `WINDROW_CREDENTIAL_DIR` | Where the enrollment credential (key, cert, CA) lives | `server/data/credentials` |
| `WINDROW_CA_DIR` | The enrollment CA this node issues its own `:4443` certificate from | `server/data/ca` |
| `WINDROW_NODE_ID` | The id this node ships under; normally minted at enrollment | from the store |
| `WINDROW_SHIP_INTERVAL_MS` | How often the usage outbox drains to central | see `server/usageShipper.js` |
| `WINDROW_ROLLUP_SOURCE` | Whether rollups are computed locally or fetched from central | local |

**The central host:**

| Env var | Purpose | Default |
|---|---|---|
| `WINDROW_CENTRAL_DB_URL` | The Postgres. Also accepts `DATABASE_URL` or the `PG*` set | none — central refuses to start without one |
| `WINDROW_CENTRAL_TLS_PORT` | The mutual-TLS listener nodes connect to | `5443` |
| `WINDROW_CENTRAL_PORT` | Loopback plaintext listener, only with the next variable | `5000` |
| `WINDROW_CENTRAL_ALLOW_INSECURE` | `1` opens that plaintext listener. **Development only** — a batch on it is attributed to whatever node id it claims | off |
| `WINDROW_SERVER_SANS` | Hostnames/IPs baked into central's server certificate | this host's hostname |
| `WINDROW_CENTRAL_RETENTION_MONTHS` | Months of usage to keep; unset keeps everything | keep everything |
| `WINDROW_CENTRAL_DB_POOL_MAX` | Connection pool size | `10` |

The full surface is larger than this table; `grep -rn "envCompat(" server` is the authoritative
list, and every name it produces is `WINDROW_` + the string passed in.


## Keeping this honest

The authoritative list is the code:

```bash
grep -rn "envCompat(" server
```

`envCompat` resolves a name with the `WINDROW_` prefix and refuses the pre-rename `GOVERNANCE_`
spellings loudly rather than silently ignoring them — see `assertNoLegacyEnv` in
`server/config.js`.
