const fs = require('fs');
const p = 'docs/design/api-contract.md';
let s = fs.readFileSync(p, 'utf8');
const crlf = s.includes('\r\n');
const fix = (t) => (crlf ? t.replace(/\n/g, '\r\n') : t);
let n = 0;
function rep(rawA, rawB) {
  const a = fix(rawA); const b = fix(rawB);
  if (!s.includes(a)) { console.error('MISS >>>\n' + rawA.slice(0, 220) + '\n<<<'); process.exit(1); }
  if (s.split(a).length > 2) { console.error('AMBIGUOUS >>>\n' + rawA.slice(0, 90)); process.exit(1); }
  s = s.replace(a, b); n += 1;
}

rep(
`**Node side.** \`server/policy/policyClient.js\` holds the SSE connection, pulls on the poke and on the
timer, and writes two files: \`policy-replica.json\` (the applied delta state — what phase 4 flips
authority onto; nothing on the hot path reads it yet) and the deny-list.`,
`**Node side.** \`server/policy/policyClient.js\` holds the SSE connection, pulls on the poke and on the
timer, and writes two files: \`policy-replica.json\` (the applied delta state) and the deny-list. On a
node whose authority is central it **also** writes the rows into that node's own
\`capabilities\`/\`principals\`/\`grants\` tables — see the next section — and the mirror is written
*before* the JSON records the version as applied, because the JSON is what the next pull's \`since\`
comes from and a delta is only sent once.`);

rep(
`\`GET /api/policy/status\` reports the node's own view: version, deny-list age, whether the stream is
connected, and the last error.

---`,
`\`GET /api/policy/status\` reports the node's own view: version, deny-list age, whether the stream is
connected, the last error, and — on a replica node — \`authority\`, \`mirrorVersion\` and
\`mirrorStampedAt\`. The replica version and the mirror version move together on a healthy node and
come apart in exactly one case worth seeing: a delta that applied to the JSON but could not be
written into SQLite.

---

### Central as the policy authority (\`global-identity-and-central-db.md\` §2.7 phase 4)

**Who writes what.** With \`WINDROW_POLICY_AUTHORITY=central\` and a \`WINDROW_CENTRAL_URL\` (both
required; asking for the first without the second stays node-authoritative and logs why), central is
the single writer for policy and every node holds a read replica plus the deny-list.

| Plane | Writer | On the node |
|---|---|---|
| capabilities, principals, grants, approvals, control-plane audit | central only | read replica in the node's own SQLite, **locked** |
| usage events | that node only | outbox + local retention, shipped up (phase 1/3) |
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
| `POST /api/policy/principals`, `PATCH /api/policy/principals/:id` | admin | |
| `POST /api/policy/grants`, `DELETE /api/policy/grants/:id` | admin | the revoke answers **200 with the row**, not 204 — its `revokedAt` is the evidence it landed |
| `POST /api/policy/approvals`, `POST …/:id/decide` | node / admin | an approved grant proposal becomes the grant in the same transaction as the decision |
| `GET /api/fleet/policy` | admin | every node's replica version against central's head — who is behind, and by how much |

A node certificate can read the whole policy because it *replicates* it; there is no smaller thing to
give it, and §2.8 states the exposure honestly rather than pretending it is new. What it cannot do is
decide what any of it permits.

**The node's own `/api/policy` is not mounted on a replica.** Its `policy_changes` log stops being a
history of anything, so serving deltas from it would hand a caller a version number meaning something
entirely different from central's.

**Nothing local may write policy.** `server/store.js` refuses every policy mutator with
`PolicyReadOnlyError` — from any caller, not only from ones that go through the seam — and
`applyPolicyReplica` is the single way in. It also displaces locally-minted rows that collide with
central's on the natural key, which every node upgraded from phase 3 will have. A refusal is an error
and never a silent no-op: a dropped policy write would leave the caller believing the grant exists.

**The hot path is unchanged.** The mirror is the same tables with the same indexes, so
`findActiveGrant` is two prepared statements and no governed tool call touches the network. The WAN is
on the write path only, which is why every policy-mutating route in `server/app.js` is now `async` and
why a rejected handler promise is turned into a response rather than a hung request.

**What `/invoke` now returns.** Every response — and the `principal not found` / `capability not
found` 404s — carries `policy: {authority, version, ageMs}`. `authority` is `'node'` or `'central'`,
`version` is the mirror version the decision was made at, and `ageMs` is how long since the policy
channel last confirmed anything. A denial an agent receives says whose policy denied it, because
asking the admin of one replica out of forty does not help.

**The one hook-contract change.** "This capability is not in the registry" used to be a complete
answer. On a replica it is two answers: genuinely ungoverned, or not replicated yet. The hook reads
the deny-list's new `authority` field (written by whoever writes that file, since a hook runs in the
agent's environment and cannot see the server's configuration) and decides on freshness:

| Replica state | Unknown capability |
|---|---|
| current, or node-authoritative | allowed, ungoverned — exactly as before phase 4 |
| stale (past `MAX_POLICY_AGE`, or never confirmed) | denied as `[governance:fault/not-replicated]` |

The degradation ladder cannot be used here and that is not an oversight: it branches on `riskTier`,
and the tier is precisely what is missing — the same reason the existing tier-unknown branch is a hard
deny. Failing an unknown tool closed costs a call; treating an unreplicated `destructive` capability as
ungoverned costs the guarantee.

**Revocation is unchanged and that is the point.** It does not travel through any of the above: it
rides the always-full deny-list on every poll, so it lands on a node whose delta stream is broken,
whose replica is frozen for schema skew, and whose SSE connection a proxy closed an hour ago. Past
`MAX_POLICY_AGE` the node fails closed for `mutating`/`destructive` and open for `read_only`.

**Verification.** `npm run test:authority --prefix server` (node half, no network — the lock per
mutator, the collision, a revoke replicating as a row, a reset removing what central dropped, and both
directions of the unknown-capability rule). `npm run smoke:central-policy --prefix server` (central
against a real Postgres, including that its delta is applied *unmodified* by the node's own
`server/policy/replica.js`). `npm run e2e:authority --prefix server` (a live node against a live
central, following one grant out and back). The last two **skip loudly** rather than passing when
there is nothing to talk to.

---`);

fs.writeFileSync(p, s);
console.log('patched', n, 'sites');
