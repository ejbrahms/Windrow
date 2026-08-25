'use strict';
// PER-PRINCIPAL RATE LIMITING, the enforced half of loop containment.
//
// server/alerts/rules.js catches a loop AFTER it has happened: `destructive-burst` fires once a
// subject has already run 40 destructive calls in five minutes. That is detection — an alert an
// operator reads — and detection alone cannot stop a runaway agent, which is exactly the shape a
// stuck tool-calling loop makes (the same call, over and over, faster than a human notices). This
// module is the enforcing half: a token bucket per (principal, capability) that DENIES the call
// that would cross the rate rather than merely noting it crossed.
//
// It is expressed as a `velocity` constraint (server/policy/constraints.js) so it composes with the
// rest of grant resolution instead of being a second, parallel policy channel: a grant, a role or a
// node profile can each state one, and the merge takes the most restrictive on every axis — the
// same "silence is not permission, tighter always wins" rule the numeric ceilings already follow
// (docs/design/grant-resolution-semantics.md §2.1).
//
// WHY A TOKEN BUCKET rather than a fixed window counter. A fixed window ("N per minute") has the
// same straddle hole server/alerts/rules.js §"STRIDE IS SEPARATE FROM WINDOW" describes: N calls at
// 12:00:59 and N at 12:01:00 is 2N in one second and zero denials. A token bucket has no window
// boundary to straddle — it refills continuously, so a burst is bounded by `burst` at every instant
// and the sustained rate is bounded by `ratePerMin` over any interval. The two numbers separate the
// two questions an operator actually has: how fast may it go in a spike (`burst`), and how fast may
// it go forever (`ratePerMin`).
//
// EVERYTHING HERE IS PURE. State is a plain `{ tokens, updatedAtMs }` value that the caller owns and
// the caller stores (server/policy/velocity.js keeps the map, server/app.js consumes on /invoke).
// No clock of its own, no I/O — the same discipline server/alerts/rules.js holds to, and for the
// same reason: a decision this small has to be assertable directly in a test, not only observed
// through a live broker.

/**
 * Read a `velocity` constraint value into `{ ratePerMin, burst }`, or say why it cannot be used.
 *
 * Two spellings are accepted, because the shorthand is the one an operator reaches for first:
 *
 *   velocity: 10                      -> { ratePerMin: 10, burst: 10 }   (bar of one minute's worth)
 *   velocity: { ratePerMin: 10 }      -> { ratePerMin: 10, burst: 10 }   (burst defaults to the rate)
 *   velocity: { ratePerMin: 10, burst: 40 }
 *
 * `burst` defaults to `ratePerMin` — one minute of sustained traffic — because a bucket smaller than
 * a second's worth of the sustained rate would deny calls the sustained rate is supposed to permit,
 * and a caller who has not thought about bursts almost always means "let a minute's worth through at
 * once". It is floored at 1: a capacity below a single token is a rate limit that denies the very
 * first call, which is a misconfiguration, not a policy.
 *
 * Returns `{ ok, velocity, reason }` rather than throwing, matching normalizeRule/parseConstraints:
 * a malformed value is a fact the caller decides what to do about, not a crash.
 */
function parseVelocity(raw) {
  const bad = (reason) => ({ ok: false, velocity: null, reason });

  let ratePerMin;
  let burst;
  if (typeof raw === 'number') {
    ratePerMin = raw;
    burst = raw;
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    ratePerMin = Number(raw.ratePerMin);
    burst = raw.burst == null ? ratePerMin : Number(raw.burst);
  } else {
    return bad(`velocity must be a number or an object with ratePerMin, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }

  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) return bad('velocity.ratePerMin must be a positive number');
  if (!Number.isFinite(burst) || burst <= 0) return bad('velocity.burst must be a positive number');
  // A capacity below one token denies the first call, so it is clamped up rather than honoured — the
  // author meant "small", not "nothing gets through".
  burst = Math.max(1, burst);

  return { ok: true, velocity: { ratePerMin, burst }, reason: null };
}

/** Tokens added per millisecond at a rate of `ratePerMin` per minute. */
function refillPerMs(velocity) {
  return velocity.ratePerMin / 60_000;
}

/**
 * Bring a bucket up to date to `nowMs` without consuming anything.
 *
 * A `null` state is a bucket that has never been touched, and it starts FULL — a principal's first
 * call is never the one a rate limit denies, and a fresh bucket that started empty would be exactly
 * that. Clock going backwards (a state stamped in the future, e.g. after an NTP correction) refills
 * nothing rather than draining, because `elapsed` is floored at zero: time never removes tokens.
 */
function refill(state, velocity, nowMs) {
  if (!state) return { tokens: velocity.burst, updatedAtMs: nowMs };
  const elapsed = Math.max(0, nowMs - state.updatedAtMs);
  const tokens = Math.min(velocity.burst, state.tokens + elapsed * refillPerMs(velocity));
  return { tokens, updatedAtMs: nowMs };
}

/**
 * Try to spend `cost` tokens.
 *
 * Returns `{ allowed, state, tokens, retryAfterMs }`:
 *   - `state` is always the bucket AS IT NOW STANDS and the caller must store it — refilled either
 *     way, and decremented only when the call was allowed.
 *   - a denied call spends NOTHING, so a throttled loop does not dig its own bucket deeper and
 *     recovery is a clean function of elapsed time.
 *   - `retryAfterMs` on a denial is when the bucket will next hold `cost` tokens — a real number the
 *     caller can hand back to the agent instead of "try again later".
 *
 * The `1e-9` slack absorbs floating-point refill error so a bucket that should read exactly `cost`
 * (e.g. one token, one second after a one-per-second rate emptied it) is not denied by a rounding
 * ulp — the failure mode a naive `tokens >= cost` has and the reason it is written this way.
 */
function tryConsume(state, velocity, nowMs, cost = 1) {
  const refilled = refill(state, velocity, nowMs);
  if (refilled.tokens + 1e-9 >= cost) {
    return {
      allowed: true,
      state: { tokens: refilled.tokens - cost, updatedAtMs: nowMs },
      tokens: refilled.tokens - cost,
      retryAfterMs: 0,
    };
  }
  const deficit = cost - refilled.tokens;
  return {
    allowed: false,
    state: refilled,
    tokens: refilled.tokens,
    retryAfterMs: Math.ceil(deficit / refillPerMs(velocity)),
  };
}

/**
 * The most-restrictive merge of two velocity constraints, for the constraint intersection
 * (server/policy/constraints.js). Tighter wins on EACH axis independently — the lower sustained rate
 * and the lower burst — because a leg that says "slow forever" and a leg that says "no big spikes"
 * are two different restrictions and intersection keeps both, exactly as the numeric-ceiling row of
 * §2.1's table takes the lower of two `maxPerHour`s. Taking the lower rate's burst wholesale would
 * silently drop the other leg's spike limit, which is the "silence is not permission" mistake.
 */
function combineVelocity(a, b) {
  return {
    ratePerMin: Math.min(a.ratePerMin, b.ratePerMin),
    burst: Math.min(a.burst, b.burst),
  };
}

module.exports = { parseVelocity, refill, tryConsume, combineVelocity, refillPerMs };
