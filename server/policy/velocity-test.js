'use strict';
// PER-PRINCIPAL RATE LIMITING — the token bucket, the velocity constraint, and the merge.
// Run: node server/policy/velocity-test.js
//
// What it asserts, in order:
//   1. parseVelocity accepts the shorthand and the object form, and refuses nonsense.
//   2. A fresh bucket starts FULL — a principal's first call is never the one a limit denies.
//   3. The burst is a hard ceiling; the sustained rate refills continuously and caps at the burst.
//   4. A denied call spends NO token, so recovery is a clean function of elapsed time.
//   5. retryAfterMs is the real time until the next token, not a guess.
//   6. The velocity constraint merges most-restrictively — tighter rate AND tighter burst win.
//   7. A malformed velocity constraint DENIES rather than evaluating to no limit.
//   8. checkVelocity keys buckets on (principal, capability): siblings under one grant don't share.

const assert = require('assert');
const { parseVelocity, refill, tryConsume, combineVelocity } = require('./tokenBucket');
const { mergeConstraints } = require('./constraints');
const { checkVelocity, velocityDenialReason, _resetBuckets } = require('./velocity');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

console.log('parseVelocity');
{
  check('a bare number is shorthand for ratePerMin, burst equal to it',
    JSON.stringify(parseVelocity(10).velocity) === JSON.stringify({ ratePerMin: 10, burst: 10 }));
  check('burst defaults to the rate when omitted',
    JSON.stringify(parseVelocity({ ratePerMin: 6 }).velocity) === JSON.stringify({ ratePerMin: 6, burst: 6 }));
  check('an explicit burst is kept',
    JSON.stringify(parseVelocity({ ratePerMin: 6, burst: 30 }).velocity) === JSON.stringify({ ratePerMin: 6, burst: 30 }));
  check('a burst below one token is clamped up to one', parseVelocity({ ratePerMin: 6, burst: 0.2 }).velocity.burst === 1);
  check('a zero rate is refused', parseVelocity(0).ok === false);
  check('a negative rate is refused', parseVelocity(-5).ok === false);
  check('a non-numeric rate is refused', parseVelocity({ ratePerMin: 'fast' }).ok === false);
  check('an array is refused', parseVelocity([10]).ok === false);
  check('null is refused', parseVelocity(null).ok === false);
}

console.log('\nthe token bucket');
{
  const v = { ratePerMin: 60, burst: 10 }; // 1 token/sec, capacity 10
  const start = 1_000_000;

  // A fresh (null) bucket is full.
  let r = tryConsume(null, v, start);
  check('a fresh bucket allows the first call', r.allowed === true);
  check('and it started full — 10, now 9 after one spend', Math.abs(r.tokens - 9) < 1e-9, r.tokens);

  // Drain the remaining 9 at the same instant: 9 more allowed, the 10th denied.
  let state = r.state;
  let allowedCount = 1;
  for (let i = 0; i < 12; i += 1) {
    const step = tryConsume(state, v, start);
    state = step.state;
    if (step.allowed) allowedCount += 1;
  }
  check('the burst is a hard ceiling — exactly 10 calls at one instant', allowedCount === 10, allowedCount);

  // The 11th at the same instant is denied and spends nothing.
  const denied = tryConsume(state, v, start);
  check('the 11th instantaneous call is denied', denied.allowed === false);
  check('a denied call spends no token (still ~0)', denied.tokens < 1e-9, denied.tokens);
  check('retryAfterMs is ~1s at 1 token/sec', Math.abs(denied.retryAfterMs - 1000) <= 1, denied.retryAfterMs);

  // One second later, exactly one token is back.
  const later = tryConsume(denied.state, v, start + 1000);
  check('one second later exactly one call gets through', later.allowed === true);
  check('and the bucket is empty again after it', later.tokens < 1e-9, later.tokens);

  // Refill caps at burst no matter how long we wait.
  const capped = refill({ tokens: 0, updatedAtMs: start }, v, start + 3_600_000);
  check('refill never exceeds the burst capacity', Math.abs(capped.tokens - v.burst) < 1e-9, capped.tokens);

  // Clock going backwards refills nothing rather than draining.
  const backwards = refill({ tokens: 5, updatedAtMs: start }, v, start - 5000);
  check('a clock moving backwards removes no tokens', Math.abs(backwards.tokens - 5) < 1e-9, backwards.tokens);
}

console.log('\ncombineVelocity — tighter on each axis');
{
  const c = combineVelocity({ ratePerMin: 10, burst: 40 }, { ratePerMin: 60, burst: 5 });
  check('the lower rate and the lower burst both win', c.ratePerMin === 10 && c.burst === 5, c);
}

console.log('\nthe velocity constraint through mergeConstraints');
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { velocity: { ratePerMin: 10, burst: 40 } } },
    { leg: 'role', constraints: { velocity: 5 } },
  ]);
  check('two velocity legs intersect to the tightest of each',
    r.allowed && r.constraints.velocity.ratePerMin === 5 && r.constraints.velocity.burst === 5, r.constraints);
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { paths: ['/repo'] } },
    { leg: 'role', constraints: { velocity: 3 } },
  ]);
  check('a velocity on one leg only applies as written',
    r.allowed && JSON.stringify(r.constraints.velocity) === JSON.stringify({ ratePerMin: 3, burst: 3 }), r.constraints);
}
{
  const r = mergeConstraints([{ leg: 'user', constraints: { velocity: { burst: 5 } } }]);
  check('a velocity missing ratePerMin DENIES rather than becoming no limit', r.allowed === false, r);
  check('and the denial names the leg', /user/.test(r.reason || ''), r.reason);
}
{
  const clean = require('./constraints').inventory([{ constraints: { velocity: 10 } }]);
  check('a registry using velocity is safe to enforce (it is a known key)', clean.safeToEnforce === true, clean);
}

console.log('\ncheckVelocity — the stateful per-principal enforcer');
{
  _resetBuckets();
  const constraints = { velocity: { ratePerMin: 60, burst: 3 } };
  const t0 = 2_000_000;

  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    runs.push(checkVelocity({ principalId: 'inst_a', capabilityId: 'cap_x', constraints, now: t0 }));
  }
  const allowed = runs.filter((r) => !r.limited).length;
  check('a burst of 3 lets 3 through and throttles the rest', allowed === 3, runs.map((r) => r.limited));
  check('the throttled call carries a retryAfterMs', runs[3].retryAfterMs > 0, runs[3]);

  // A different capability for the same principal has its own bucket.
  const otherCap = checkVelocity({ principalId: 'inst_a', capabilityId: 'cap_y', constraints, now: t0 });
  check('a different capability draws its own bucket', otherCap.limited === false, otherCap);

  // A sibling instance under the same (shared) grant has its own bucket — one looping agent does not
  // throttle another.
  const sibling = checkVelocity({ principalId: 'inst_b', capabilityId: 'cap_x', constraints, now: t0 });
  check('a sibling principal is not throttled by the first one looping', sibling.limited === false, sibling);

  // One second later, cap_x for inst_a has one token back.
  const recovered = checkVelocity({ principalId: 'inst_a', capabilityId: 'cap_x', constraints, now: t0 + 1000 });
  check('the bucket recovers with elapsed time', recovered.limited === false, recovered);
}
{
  _resetBuckets();
  // No velocity on the grant → never limited, no bucket state at all.
  const none = checkVelocity({ principalId: 'inst_a', capabilityId: 'cap_x', constraints: { paths: ['/x'] }, now: 3_000_000 });
  check('a grant with no velocity constraint is never rate-limited', none.limited === false, none);

  // A malformed velocity fails closed.
  const bad = checkVelocity({ principalId: 'inst_a', capabilityId: 'cap_z', constraints: { velocity: { burst: 5 } }, now: 3_000_000 });
  check('a malformed velocity constraint fails closed', bad.limited === true && bad.malformed === true, bad);
  check('and its reason reads as a misconfiguration', /misconfigured/.test(velocityDenialReason(bad, 'mcp_tool/x')), bad);
}
{
  // The denial reason for a real throttle reads as a rate limit, not a missing grant.
  const reason = velocityDenialReason(
    { limited: true, velocity: { ratePerMin: 10, burst: 3 }, retryAfterMs: 2000 },
    'mcp_tool/deploy'
  );
  check('a throttle reason says "rate limit exceeded" and the retry', /rate limit exceeded/.test(reason) && /retry in 2s/.test(reason), reason);
}

// A parse-JSON-string constraints value works the same (grants store constraints as JSON text).
{
  _resetBuckets();
  const r = checkVelocity({ principalId: 'p', capabilityId: 'c', constraints: '{"velocity": 1}', now: 4_000_000 });
  assert.strictEqual(r.limited, false);
  const r2 = checkVelocity({ principalId: 'p', capabilityId: 'c', constraints: '{"velocity": 1}', now: 4_000_000 });
  check('a JSON-string constraints value is parsed and enforced', r2.limited === true, r2);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
