'use strict';
// THE STATEFUL HALF of per-principal rate limiting: the bucket store and the one function the broker
// calls. server/policy/tokenBucket.js is the pure math; this holds the tokens between calls and
// wires the `velocity` constraint (server/policy/constraints.js) to it.
//
// WHY IN-PROCESS MEMORY, not the SQLite store. A bucket's whole value is on the hot path of every
// governed call — /invoke is the one place a decision is blocked on (server/hooks/lib.js measures it
// as grantCheckMs), and a disk read+write per call to count calls would cost more than the loop it
// contains. The state is also cheap to lose: a restart refills every bucket to full, which errs
// toward allowing rather than denying — the safe direction, and bounded anyway by `burst`, so the
// worst a restart buys a looping agent is one more burst before the sustained rate reasserts itself.
// A fleet-wide rate limit (the same subject across many nodes) is server/central's job, keyed the
// way its alert engine already keys the fleet; this is the node-local throttle, the enforcing twin
// of server/alerts/rules.js's node-scoped `destructive-burst`.
//
// KEYED ON THE CALLING PRINCIPAL, not the grant's. A shared role grant can carry a velocity, and
// findActiveGrant hands the same role grant to every instance under that role — but the point of
// loop containment is to throttle the ONE agent that is looping without touching its siblings. So
// the bucket key is (the instance that made the call, the capability), and each agent draws down its
// own bucket even though they read the limit off one shared grant row.

const { parseConstraints } = require('./constraints');
const { parseVelocity, tryConsume } = require('./tokenBucket');

// (principalId|capabilityId) -> { tokens, updatedAtMs }. See pruning below for the growth backstop.
const buckets = new Map();

// A ceiling on distinct buckets held at once, so a machine that sees a very large number of
// (principal, capability) pairs cannot grow this map without bound. Full buckets carry no state
// worth keeping — a bucket at capacity is indistinguishable from one that never existed — so when
// the cap is hit those are dropped first. The number is generous: a real node has far fewer live
// agent×capability pairs than this, and hitting it at all means something is spraying identities.
const MAX_BUCKETS = 10_000;

function bucketKey(principalId, capabilityId) {
  return `${principalId}|${capabilityId}`;
}

/**
 * Drop refilled-to-full buckets when the map is over its cap. Called only on insert of a NEW key, so
 * it costs nothing on the common path (an existing bucket being updated). A bucket at `burst` holds
 * no information the null state does not, so removing it changes no future decision.
 */
function pruneIfNeeded(velocity, nowMs) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, state] of buckets) {
    if (state.tokens >= velocity.burst - 1e-9 && nowMs - state.updatedAtMs > 0) buckets.delete(key);
  }
}

/**
 * Decide, and record, whether this call is within the principal's velocity limit for this capability.
 *
 * Returns one of:
 *   { limited: false }                             — no velocity constraint on the grant, nothing to do
 *   { limited: false, velocity, tokens }           — within the limit; a token was spent
 *   { limited: true, velocity, retryAfterMs, ... } — over the limit; NO token spent, deny the call
 *   { limited: true, malformed: true, reason }     — the constraint itself will not parse; fail closed
 *
 * HAS A SIDE EFFECT — it spends a token — so it must be called exactly once per governed call, and
 * only when the grant actually authorized it (a call already denied for lack of a grant never
 * reaches here, so a denied loop does not also drain the bucket). server/app.js's /invoke is the one
 * caller and guards it on `allowed`.
 *
 * The malformed case fails CLOSED, unlike the inert numeric ceilings: velocity is a new opt-in key,
 * no live grant carries it, so a broken value cannot be denying calls that work today — and a rate
 * limit that silently evaluates to "no limit" because of a typo is the decoration
 * grant-resolution-semantics.md §2.1 exists to forbid.
 */
function checkVelocity({ principalId, capabilityId, constraints, now = Date.now() }) {
  const parsed = parseConstraints(constraints);
  if (!parsed.ok || !parsed.constraints || parsed.constraints.velocity == null) {
    return { limited: false };
  }
  const v = parseVelocity(parsed.constraints.velocity);
  if (!v.ok) {
    return { limited: true, malformed: true, reason: v.reason };
  }

  const key = bucketKey(principalId, capabilityId);
  const state = buckets.get(key) || null;
  const result = tryConsume(state, v.velocity, now);
  if (!buckets.has(key)) pruneIfNeeded(v.velocity, now);
  buckets.set(key, result.state);

  if (result.allowed) return { limited: false, velocity: v.velocity, tokens: result.tokens };
  return { limited: true, velocity: v.velocity, retryAfterMs: result.retryAfterMs, tokens: result.tokens };
}

/**
 * A human-readable reason for a velocity denial, in the vocabulary the hook already speaks
 * (server/hooks/lib.js's policyReason). Named "rate limit" so an agent — and a dashboard filtering
 * usage_events.reason — can tell a throttle apart from a missing grant: the remedy is to slow down
 * and retry, not to ask for access.
 */
function velocityDenialReason(result, capabilityLabel) {
  if (result.malformed) {
    return `rate limit misconfigured for ${capabilityLabel}: ${result.reason}`;
  }
  const { velocity, retryAfterMs } = result;
  const retry = retryAfterMs ? `, retry in ${Math.ceil(retryAfterMs / 1000)}s` : '';
  return `rate limit exceeded for ${capabilityLabel}: ${velocity.ratePerMin}/min, burst ${velocity.burst}${retry}`;
}

/** Test seam: forget all buckets. Not used on any live path. */
function _resetBuckets() {
  buckets.clear();
}

module.exports = { checkVelocity, velocityDenialReason, bucketKey, MAX_BUCKETS, _resetBuckets };
