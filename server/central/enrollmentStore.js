'use strict';

// Central's enrollment store — the Postgres half of the store interface ../enrollment/routes.js
// drives, and the piece that makes docs/design/setup-after-central.md §2 go away.
//
// WHY THIS FILE EXISTS AT ALL, given ../store.js already has every one of these functions. It has
// them against `better-sqlite3`, on a node, keyed by a `nodes` table that lives on that node's
// disk. §2's measurement is that a node enrolled there holds a certificate signed by a CA central
// has never heard of. Moving enrollment to central is not "run the node's code on the central
// host" — central has no SQLite, no `id` column on `nodes`, and no nodeId of its own — it is
// re-implementing the same ten questions against the store central actually has. The router does
// not change; what it is handed does.
//
// THE INTERFACE IS THE ROUTER'S, NOT THIS FILE'S. Every method name and every return shape here is
// dictated by ../enrollment/routes.js, which checks for exactly these functions before it will
// serve a request (its `storeReady`). Two shapes are load-bearing and easy to get subtly wrong:
//
//   consumeEnrollmentToken   truthy when THIS caller won the token, falsy when it lost. The
//                            router's spend-before-issue depends on being able to tell those
//                            apart, and the atomicity that makes the answer meaningful is in the
//                            UPDATE's WHERE clause, not in this process.
//   listEnrollmentTokens     rows WITHOUT `tokenHash`, with a `tokenHashPrefix` in its place —
//                            the hash is not a spendable secret but it is the verifier for one,
//                            and an operator list has no use for it.
//
// WHAT CENTRAL DOES NOT HAVE: `nodeId()`. On a node that method answers "which machine am I", and
// ../enrollment/routes.js uses it so that a `node`-scoped certificate binds the SAME id the
// usage-event hash chain keys on — a certificate proving "node X" is worthless if the events it
// authorises are filed under some other id. Central is not a node and never files events under its
// own name, so it deliberately omits the method and the router takes its other branch: a
// `node`-scoped enrollment at central mints a FRESH id, which the enrolling machine then adopts
// (../store.js's adoptNodeId) as the key for its own chain. Adding a `nodeId()` here would make
// every node in the fleet enroll as central.

const crypto = require('crypto');
const { genId } = require('../id');
const store = require('./store');

/** Raised when an enrolment would launder an identity. Mirrors ../store.js's error of the same
 *  name so the router's 409 path behaves identically on both stores. */
class NodeConflictError extends Error {}

/** The driver is fetched per call rather than captured at construction, because ./store.js's
 *  `open()` is what creates it and this module is required before that happens — a captured
 *  reference would be null for the life of the process. */
const d = () => store.requireDriver();

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// enrollment tokens
// ---------------------------------------------------------------------------------------------

/**
 * Mint a token row. `tokenHash` is SHA-256 of a secret this module never sees and could not
 * reconstruct; the plaintext exists exactly once, in the response that created it.
 */
async function createEnrollmentToken({ tokenHash, label, scope, expiresAt, createdByScope, maxUses = 1 }) {
  if (!tokenHash || typeof tokenHash !== 'string') throw new TypeError('tokenHash is required');
  if (!scope || typeof scope !== 'string') throw new TypeError('scope is required');
  const rows = await d().all(
    `INSERT INTO enrollment_tokens
       (id, "tokenHash", label, scope, "createdAt", "createdByScope", "expiresAt", "maxUses", "uses")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
     RETURNING *`,
    [genId('entok'), tokenHash, label ?? null, scope, nowIso(), createdByScope ?? null, expiresAt ?? null,
      Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Math.trunc(Number(maxUses)) : 1]
  );
  return rows[0];
}

/** The lookup an enrolling request makes. A row coming back means the hash is KNOWN, not that it
 *  is still spendable — the router checks revoked/used/expired for its log line, and
 *  consumeEnrollmentToken re-checks all three as the only answer that counts. */
async function findEnrollmentTokenByHash(tokenHash) {
  if (!tokenHash) return null;
  const row = await d().get('SELECT * FROM enrollment_tokens WHERE "tokenHash" = $1', [tokenHash]);
  return row || null;
}

async function findEnrollmentTokenById(id) {
  const row = await d().get('SELECT * FROM enrollment_tokens WHERE id = $1', [id]);
  return row || null;
}

/** Newest first, and stripped: see the header on why `tokenHash` does not leave this file. */
async function listEnrollmentTokens() {
  const rows = await d().all('SELECT * FROM enrollment_tokens ORDER BY "createdAt" DESC');
  return rows.map(({ tokenHash, ...rest }) => ({
    ...rest,
    tokenHashPrefix: tokenHash ? tokenHash.slice(0, 8) : null,
  }));
}

/**
 * THE USE GATE, and the reason it is one statement rather than a read followed by a write.
 *
 * Bounded-use since docs/design/dashboard-placement.md item 7: `"usedAt" IS NULL` became
 * `"uses" < "maxUses"`, which is single-use for every token minted without asking for more (the
 * column defaults to 1) and a re-provisionable join credential for one that did. Nothing else about
 * the argument below changes — a ceiling of N is still N races that must produce exactly N
 * certificates, which is the same property as 1 producing exactly 1.
 *
 * Every condition that makes a token spendable is in the WHERE clause, so Postgres evaluates and
 * applies them under one row lock: two enrolments racing this see one row returned and zero, and
 * there is no window between the check and the claim for the second to squeeze into. A
 * SELECT-then-UPDATE would leave that window wide open, and what fits through it is a second
 * certificate issued against a token an admin minted once — the exact failure the token exists to
 * prevent.
 *
 * The expiry comparison is lexicographic on TEXT, which is correct for the ISO-8601 UTC strings
 * this schema stores and would be wrong for anything else. See migration 5 on why they are TEXT.
 *
 * Returns `{ ok: true, token }` to the winner and `null` to everyone else. The loser is told it
 * lost by the falsy return rather than by a reason code, because the router turns every rejection
 * into one indistinguishable message anyway — telling an unauthenticated caller *why* its token
 * failed is how an endpoint becomes a probe for which tokens exist.
 */
async function consumeEnrollmentToken(id, nodeId) {
  if (!nodeId || typeof nodeId !== 'string') throw new TypeError('nodeId is required to consume an enrollment token');
  const now = nowIso();
  const rows = await d().all(
    `UPDATE enrollment_tokens
        SET "usedAt" = $1, "usedByNodeId" = $2, "uses" = "uses" + 1
      WHERE id = $3 AND "uses" < "maxUses" AND "revokedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > $4)
      RETURNING *`,
    [now, nodeId, id, now]
  );
  if (!rows.length) return null;
  return { ok: true, token: rows[0] };
}

/** Kill an unspent token. Null when it does not exist or was already revoked — a double-revoke is
 *  a no-op, not an error. Allowed on an already-*used* token too: revoking one is how an operator
 *  says "that enrolment should not have happened", and the node it produced is revoked separately
 *  by revokeNode. */
async function revokeEnrollmentToken(id) {
  const rows = await d().all(
    'UPDATE enrollment_tokens SET "revokedAt" = $1 WHERE id = $2 AND "revokedAt" IS NULL RETURNING *',
    [nowIso(), id]
  );
  return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------------------------

/**
 * Record an enrolled node and the certificate it will present.
 *
 * AN UPSERT, NOT AN INSERT, and that is forced by central's `nodes` being an ingest roster before
 * it is a credential register. A machine that shipped a batch on the developer loopback path — or
 * one whose row survives a re-enrollment after revocation was lifted — already has a row keyed on
 * this nodeId, created by ./store.js's per-batch upsert, and an INSERT would fail on the primary
 * key. The conflict clause names only the enrollment columns, so the ingest half of the row
 * (firstSeenAt, lastSeq, eventCount, the rolling measures) is carried through untouched. The
 * mirror-image care is taken on the other side: ./store.js's upsert names only ingest columns in
 * its DO UPDATE SET, so a batch never clobbers a certificate identity.
 *
 * `firstSeenAt`/`lastSeenAt` are NOT NULL on that table and are supplied here for the
 * enrollment-first case — a node that enrolls before it has ever shipped. They are the roster's
 * columns, so on a row that already exists they are left exactly as ingest last wrote them.
 *
 * Throws NodeConflictError when the write would launder an identity:
 *   - the node is revoked — re-enrolment must not be a way to clear a revocation, or revoking
 *     anything would be pointless
 *   - the certificate serial already belongs to a different node — that is a CA duplicate, and
 *     since the serial is what every request authorises against, one node would be silently
 *     authorised as another
 */
async function registerNode({ nodeId, label, scope, publicKey, certSerial, certFingerprint, certNotAfter }) {
  if (!nodeId || typeof nodeId !== 'string') throw new TypeError('nodeId is required');
  const existing = await findNodeByNodeId(nodeId);
  if (existing && existing.revokedAt) {
    throw new NodeConflictError(`node ${nodeId} is revoked and cannot re-enroll`);
  }
  if (certSerial) {
    const bySerial = await findNodeByCertSerial(certSerial);
    if (bySerial && bySerial.nodeId !== nodeId) {
      throw new NodeConflictError(`certificate serial ${certSerial} is already registered to node ${bySerial.nodeId}`);
    }
  }
  const now = nowIso();
  // `enrolledAt` deliberately keeps saying when this node FIRST joined: a renewal changes the
  // credential, not the node, so COALESCE keeps the original rather than restamping it.
  //
  // The three timestamp parameters carry the same VALUE and are three separate placeholders with
  // explicit casts, which looks redundant and is not: `firstSeenAt`/`lastSeenAt` are TIMESTAMPTZ
  // (the ingest roster's own columns, migration 1) and `enrolledAt` is TEXT (migration 5, mirroring
  // the node's SQLite). Reusing one placeholder across both makes Postgres try to deduce a single
  // type for it and refuse the statement outright — "inconsistent types deduced for parameter $2".
  const rows = await d().all(
    `INSERT INTO nodes ("nodeId", "firstSeenAt", "lastSeenAt", label, scope, "enrolledAt",
                        "publicKey", "certSerial", "certFingerprint", "certNotAfter")
     VALUES ($1, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, $4, $5, $6::TEXT, $7, $8, $9, $10)
     ON CONFLICT ("nodeId") DO UPDATE SET
       label = EXCLUDED.label,
       scope = EXCLUDED.scope,
       "enrolledAt" = COALESCE(nodes."enrolledAt", EXCLUDED."enrolledAt"),
       "publicKey" = EXCLUDED."publicKey",
       "certSerial" = EXCLUDED."certSerial",
       "certFingerprint" = EXCLUDED."certFingerprint",
       "certNotAfter" = EXCLUDED."certNotAfter"
     RETURNING *`,
    [nodeId, now, now, label ?? null, scope ?? null, now, publicKey ?? null,
      certSerial ?? null, certFingerprint ?? null, certNotAfter ?? null]
  );
  return rows[0];
}

/** The request-path lookup: one indexed equality hit (nodes_certSerial_idx). Returns the row
 *  INCLUDING `revokedAt` rather than filtering revoked nodes out — "no such certificate" and "that
 *  certificate is revoked" are different answers and the caller has to be able to tell them
 *  apart. */
async function findNodeByCertSerial(certSerial) {
  if (!certSerial) return null;
  const row = await d().get('SELECT * FROM nodes WHERE "certSerial" = $1', [certSerial]);
  return row || null;
}

async function findNodeByNodeId(nodeId) {
  if (!nodeId) return null;
  const row = await d().get('SELECT * FROM nodes WHERE "nodeId" = $1', [nodeId]);
  return row || null;
}

/** Enrolled nodes, newest first. Rows that have only ever shipped — roster rows with no
 *  `enrolledAt` — are excluded: this list answers "who holds a credential", and a machine central
 *  merely received bytes from does not. The fleet roster is ./queries.js's nodeRoster. */
async function listNodes() {
  return d().all('SELECT * FROM nodes WHERE "enrolledAt" IS NOT NULL ORDER BY "enrolledAt" DESC');
}

/** Refuse a node from its next request onward — the whole revocation story, in place of CRL/OCSP.
 *  Null when the node is unknown or already revoked. */
async function revokeNode(nodeId, reason) {
  const rows = await d().all(
    `UPDATE nodes SET "revokedAt" = $1, "revokedReason" = $2
      WHERE "nodeId" = $3 AND "revokedAt" IS NULL AND "enrolledAt" IS NOT NULL
      RETURNING *`,
    [nowIso(), reason ?? null, nodeId]
  );
  return rows.length ? rows[0] : null;
}

/** Exported for the same reason ../enrollment/routes.js hashes with its own copy: the hash is the
 *  lookup key, and a second definition of it that disagreed by one byte would fail every
 *  enrollment with "no such token". Kept here so a caller of this store never has to import the
 *  router to talk to it. */
const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

module.exports = {
  createEnrollmentToken,
  findEnrollmentTokenByHash,
  findEnrollmentTokenById,
  listEnrollmentTokens,
  revokeEnrollmentToken,
  consumeEnrollmentToken,
  registerNode,
  findNodeByCertSerial,
  findNodeByNodeId,
  listNodes,
  revokeNode,
  hashToken,
  NodeConflictError,
};
