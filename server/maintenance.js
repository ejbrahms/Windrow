'use strict';
// The maintenance grace lease (docs/design/upgrade-resilience.md §3.2).
//
// The problem it solves: `runPreToolUse` branches on `capability.riskTier` alone, so "this
// principal has no grant" and "I could not reach the server to find out" both come out as `deny`.
// During a planned upgrade the second one is the operator's own doing, and it denied every
// `mutating` call on the field (2026-08-19 — the working tree gained POST /principals/resolve and
// the running service did not have it).
//
// Why a *lease*, rather than a flag the hook sets for itself: fail-closed exists to stop an
// attacker who can kill the API from converting that into write access
// That property has to survive. So
// the permission to degrade is minted by the server *while it is still healthy*, HMAC-signed with
// the agent token, and time-boxed:
//
//   - an attacker who stops the server cannot mint one (the signer is gone);
//   - an attacker who can forge one already holds AGENT_TOKEN, which is the same trust boundary
//     finding #4 already accepts as given for the signed hook caches;
//   - an expired lease is no lease, so a forgotten `upgrade:begin` re-tightens on its own.
//
// The lease is consulted ONLY on a fault. It never overrides a real `deny` from the registry, and
// it never lets a `destructive` call through unattended — at best that becomes `ask`, which puts a
// human in the loop rather than a cache.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AGENT_TOKEN } = require('./auth');

const DATA_DIR = path.join(__dirname, 'data');
const GRACE_LEASE_PATH = path.join(DATA_DIR, 'hook-grace-lease.json');

// A lease is a promise to stay degraded for a bounded time, so an unbounded one is a
// contradiction: past this, re-run `upgrade:begin`. Long enough for a db migration plus a
// smoke test, short enough that forgetting to revoke costs an hour and not a week.
const MAX_LEASE_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 15 * 60_000;

// Tiers a lease is ever allowed to name. `destructive` is deliberately absent — see the file
// header. A caller asking for it is refused rather than quietly downgraded, because silently
// granting less than asked is how an operator ends up believing a window is covered when it is not.
const LEASABLE_TIERS = ['read_only', 'mutating'];

/**
 * Same `{payload, sig}` envelope as hooks/lib.js's signed caches, and deliberately so: the lease
 * lives in the same directory, under the same threat model, and is read by the same hook process.
 * Kept here rather than imported from hooks/lib.js because the *server* writes it and hooks/lib.js
 * requires ../auth for its own reasons — a require cycle between the two would be the only thing
 * sharing that helper bought.
 */
function sign(payload) {
  return crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
}

function writeSigned(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(data);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payload, sig: sign(payload) }));
  fs.renameSync(tmp, filePath); // write-then-rename: a hook reading mid-write never sees a partial body
}

function readSigned(filePath) {
  const { payload, sig } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // tampered or written under another token
  return JSON.parse(payload);
}

/**
 * The active lease, or `null`. Never throws — a missing, malformed, tampered or expired lease all
 * mean the same thing to every caller (no lease → today's fail-closed behaviour), and a lease
 * whose file is unreadable must not be the reason a tool call dies.
 */
function readGraceLease(now = Date.now()) {
  let lease;
  try {
    lease = readSigned(GRACE_LEASE_PATH);
  } catch {
    return null; // absent, or unparseable
  }
  if (!lease || typeof lease.until !== 'number') return null;
  if (lease.until <= now) return null; // expired — an expired lease is no lease
  const tolerate = Array.isArray(lease.tolerate) ? lease.tolerate.filter((t) => LEASABLE_TIERS.includes(t)) : [];
  if (!tolerate.length) return null;
  return { ...lease, tolerate };
}

/** True when a lease is in force AND names this risk tier. The only question the hook asks. */
function leaseCovers(lease, riskTier) {
  return Boolean(lease && lease.tolerate.includes(riskTier));
}

/**
 * Mints a lease. Called by the server while it is still serving — that timing IS the security
 * property, so there is no offline/CLI path that writes one without a healthy server having
 * agreed to it.
 */
function beginGrace({ durationMs = DEFAULT_LEASE_MS, reason = 'maintenance', tolerate = LEASABLE_TIERS } = {}) {
  const requested = Array.isArray(tolerate) ? tolerate : LEASABLE_TIERS;
  const rejected = requested.filter((t) => !LEASABLE_TIERS.includes(t));
  if (rejected.length) {
    const err = new Error(`a grace lease cannot cover: ${rejected.join(', ')} (allowed: ${LEASABLE_TIERS.join(', ')})`);
    err.status = 400;
    throw err;
  }
  // An explicit empty list is refused rather than treated as "unspecified": defaulting it to every
  // leasable tier would hand back MORE than was asked for, which is the one direction this must
  // never round. A caller that wants no window simply does not open one.
  if (Array.isArray(tolerate) && !requested.length) {
    const err = new Error(`a grace lease must name at least one tier (allowed: ${LEASABLE_TIERS.join(', ')})`);
    err.status = 400;
    throw err;
  }
  const ms = Math.min(Math.max(Number(durationMs) || DEFAULT_LEASE_MS, 60_000), MAX_LEASE_MS);
  const lease = {
    id: crypto.randomBytes(6).toString('hex'),
    issuedAt: Date.now(),
    until: Date.now() + ms,
    tolerate: requested,
    reason: String(reason).slice(0, 200),
  };
  writeSigned(GRACE_LEASE_PATH, lease);
  return lease;
}

/** Ends the window early. Idempotent — revoking a lease that isn't there is a no-op, not an error. */
function endGrace() {
  try {
    fs.unlinkSync(GRACE_LEASE_PATH);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  GRACE_LEASE_PATH,
  MAX_LEASE_MS,
  DEFAULT_LEASE_MS,
  LEASABLE_TIERS,
  readGraceLease,
  leaseCovers,
  beginGrace,
  endGrace,
};
