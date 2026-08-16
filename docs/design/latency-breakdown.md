# Latency breakdown: where a governed tool call spends its time

Referenced from `server/hooks/lib.js`, `server/app.js`, and `server/store.js` — this is the doc
those comments point at. It exists to answer one recurring question ("why does a grant check take
N ms?") with real numbers instead of a guess, each time N changes.

## The phases

Each governed PreToolUse call passes through four phases, each timed independently and carried
through to the usage-event row (`usage_events.capabilityLookupMs` / `principalResolveMs` /
`grantCheckMs` / `brokerMs` — see `server/store.js`'s schema and `runPreToolUse` in
`server/hooks/lib.js`):

1. **capabilityLookupMs** — resolving the tool name to a registered capability. Cache-hit is a
   disk read; cache-miss is a `GET /api/capabilities` round trip (30s TTL — see
   `CAPABILITY_CACHE_TTL_MS`).
2. **principalResolveMs** — resolving the calling agent's identity. Cache-hit (the common case) is
   a disk read; cache-miss additionally pays `store.js`'s module-load cost (opens the SQLite db,
   runs schema checks) — historically ~40-50ms, one-time per agent instance.
3. **grantCheckMs** — the client-side view of `POST /api/invoke`: the full round trip the hook
   process experiences, not just the server's own work.
4. **brokerMs** — the server-side subset of that same call: just `findActiveGrant`'s DB lookup,
   isolated from Express/JSON/network overhead. Answers "is the grant lookup itself slow" with a
   real number instead of a guess (see `server/app.js`'s `/api/invoke` handler).

`grantCheckMs` minus `brokerMs` is everything *outside* the actual grant lookup — network, Express
routing, JSON (de)serialization, and (before the fix below) client-side HTTP stack setup.

## Two fixes so far

**1. `localhost` → `127.0.0.1`** (`server/hooks/lib.js`, `API_BASE`). Each hook invocation is a
brand-new Node process (one per tool call — see the file header), so nothing is warm to reuse.
Windows/Node's dual-stack ("happy eyeballs") resolution of `'localhost'` added tens of ms to a
first-ever request before settling on IPv4. A literal IP skips DNS/happy-eyeballs entirely.

**2. `fetch()` → `http.request()`** (`server/hooks/lib.js`, `apiFetch`). Node 18+ ships a global
`fetch`, built on undici, but undici lazily constructs its Agent/TLS machinery on the *first* call
in a process — and every hook invocation only ever makes one or two calls before exiting, so every
single call paid that setup cost in full, every time. Measured locally (fresh `node` process,
`127.0.0.1`, no DNS involved):

| client                          | first-call time to `GET /api/capabilities` |
|----------------------------------|---------------------------------------------|
| `fetch()` (global, undici)       | ~30-35ms                                     |
| `http.request()`                 | ~10-12ms                                     |
| `curl.exe` (separate process, for reference) | ~2ms                              |

The server side (`brokerMs`, Express routing, SQLite via `better-sqlite3`) was never the
bottleneck — `findActiveGrant` is a couple of prepared-statement lookups and consistently measured
under 1ms. The ~50ms `grantCheckMs` users were seeing was almost entirely undici's cold-start tax,
paid fresh by every hook process. `apiFetch` now builds requests on `http`/`https` directly (same
fetch()-shaped `{ok, status, text(), json()}` return value, so call sites didn't change) and
end-to-end `findCapability`/`invoke` round trips dropped from the ~50ms range to ~15-25ms.

## What's left

- `principalResolveMs` still pays the ~40-50ms `store.js` module-load cost on a cache miss (new
  agent instance). Not addressed here — see the comment above `PRINCIPAL_CACHE_PATH` in
  `server/hooks/lib.js`.
- Each hook invocation is still a brand-new Node process, so there's a fixed floor from Node
  startup + `require()`ing `lib.js` and its dependencies (`auth.js`, `crypto`, etc.) that no
  request-level change can remove — see the dashboard's per-phase averages
  (`GET /api/usage` — `server/app.js`) for what that floor looks like in practice.
