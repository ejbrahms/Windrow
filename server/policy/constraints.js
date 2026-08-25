'use strict';
// MERGING `constraints` — docs/design/grant-resolution-semantics.md §2.1, implemented.
//
// That section opens by saying why it had to be written down before an evaluator landed:
// `constraints` is "stored, documented and never evaluated today". A restriction nobody enforces is
// decoration, and decoration in a governance model is worse than nothing, because it is read as a
// limit by everyone who looks at the row.
//
// docs/design/disposable-nodes.md §5 is what makes this urgent rather than tidy. Its answer to
// "how granular should a node's grants be" is a THIRD NARROWING LEG — a node profile — expressed in
// this vocabulary, and it says plainly: "Building the ceiling and building the merge is one job,
// not two." A ceiling with no merge rule is a leg that cannot be intersected with the other two.
//
// ------------------------------------------------------------------------------------------------
// THE RULE, from §2.1's table, in the order it is written there
// ------------------------------------------------------------------------------------------------
//
//   Time bound (expiresAt)        earlier of the two          30d ∩ 7d = 7d
//   Numeric ceiling               lower of the two            100/hr ∩ 10/hr = 10/hr
//   Allowlist                     set intersection            empty intersection = DENY
//   Boolean permission            AND of the RESTRICTIONS      either says read-only → read-only
//   Key present on one leg only   applies as written           a restriction is never dropped by
//                                                             the other leg's silence
//
// That last row is the one that is easy to get backwards and is the whole point of intersection: a
// leg that says nothing about paths is not a leg that permits every path. Silence is not permission.
//
// ------------------------------------------------------------------------------------------------
// AN UNRECOGNISED KEY DENIES, and §2.1's warning block is why
// ------------------------------------------------------------------------------------------------
//
// "A key with no evaluator is a restriction nobody enforced, and treating it as absent is how a
// documented limit silently becomes decoration." So a constraint naming a key this build has no
// rule for produces a merge result of `{ allowed: false }` rather than being skipped.
//
// AND THAT IS WHY THIS SHIPS INERT. §2.1 also states the migration cost: "Implementing this needs
// an inventory pass over live `grants.constraints` first, so the switch from 'inert' to
// 'fail-closed' does not deny calls that work now." So this module is a pure function with tests
// and no caller on the enforced path. It is wired into the SHADOW evaluator, where a disagreement
// is measured rather than enforced — exactly where grant-resolution-semantics.md §4 says the
// intersection lives until the §1.7 subject flip. `inventory()` below is the pass that gate needs.

const { parseVelocity, combineVelocity } = require('./tokenBucket');

/** Every key this build can actually evaluate. A constraint using anything else denies. */
const KNOWN_KEYS = new Set([
  'expiresAt',     // ISO-8601. Time bound: earlier wins.
  'maxPerHour',    // Numeric ceiling: lower wins.
  'maxPerDay',     // Numeric ceiling: lower wins.
  'maxSpend',      // Numeric ceiling: lower wins.
  'paths',         // Allowlist: intersection.
  'hosts',         // Allowlist: intersection.
  'models',        // Allowlist: intersection.
  'readOnly',      // Boolean restriction: OR of the restrictions (either says yes → yes).
  'velocity',      // Token-bucket rate limit: tighter rate AND tighter burst win. Unlike the numeric
                   // ceilings above (still inert, §2.1), this one IS enforced — server/app.js
                   // /invoke and server/policy/tokenBucket.js — because it is a new, opt-in key no
                   // live grant carries yet, so there is no inventory pass to clear first.
]);

const TIME_KEYS = new Set(['expiresAt']);
const NUMERIC_KEYS = new Set(['maxPerHour', 'maxPerDay', 'maxSpend']);
const ALLOWLIST_KEYS = new Set(['paths', 'hosts', 'models']);
const RESTRICTION_KEYS = new Set(['readOnly']);
// A compound restriction — {ratePerMin, burst} — rather than a scalar, so it has its own parse and
// its own combine (server/policy/tokenBucket.js) instead of the min() the numeric ceilings share.
const VELOCITY_KEYS = new Set(['velocity']);

/** Constraints as stored: a JSON object, a JSON string, or null. Anything else is not a constraint
 *  and is refused rather than coerced — a string that will not parse is a row somebody wrote wrong,
 *  and guessing at it is how a limit stops being one. */
function parseConstraints(value) {
  if (value === null || value === undefined || value === '') return { ok: true, constraints: null };
  if (typeof value === 'object' && !Array.isArray(value)) return { ok: true, constraints: value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, constraints: parsed };
      return { ok: false, reason: 'constraints must be a JSON object' };
    } catch (err) {
      return { ok: false, reason: `constraints is not valid JSON: ${err.message}` };
    }
  }
  return { ok: false, reason: `constraints must be an object, got ${typeof value}` };
}

/** Which keys in `constraints` this build has no evaluator for. The inventory pass §2.1 requires
 *  runs this over every live row before anyone turns the fail-closed switch on. */
function unknownKeys(constraints) {
  if (!constraints) return [];
  return Object.keys(constraints).filter((k) => !KNOWN_KEYS.has(k));
}

/**
 * Merge the constraint objects of every leg that ALLOWED.
 *
 * Takes an array of `{ leg, constraints }` — the leg name travels so a denial can say which pair of
 * legs produced an empty intersection, which is the difference between a diagnosable deny and a
 * mysterious one.
 *
 * Returns `{ allowed, constraints, reason, legs }`. `allowed: false` has exactly two causes and
 * both are stated in §2.1: an allowlist whose intersection is empty, and a key with no evaluator.
 */
function mergeConstraints(legs = []) {
  const merged = {};
  const contributing = [];

  for (const leg of legs) {
    const parsed = parseConstraints(leg && leg.constraints);
    if (!parsed.ok) {
      return { allowed: false, constraints: null, reason: `${leg.leg}: ${parsed.reason}`, legs: contributing };
    }
    const constraints = parsed.constraints;
    if (!constraints) continue; // a leg with no constraints restricts nothing and merges as identity
    contributing.push(leg.leg);

    const unknown = unknownKeys(constraints);
    if (unknown.length) {
      // §2.1's warning block, enforced. Not skipped, not logged and allowed — denied.
      return {
        allowed: false,
        constraints: null,
        reason: `${leg.leg} carries constraint key(s) this build cannot evaluate: ${unknown.join(', ')}`,
        legs: contributing,
      };
    }

    // A velocity value that will not parse is the same class of problem as an unknown key: a
    // restriction that reads like a limit but cannot be applied. Denied here, once, so `normalise`
    // and `combine` below can trust the shape — and so a typo in a rate limit fails closed and loud
    // rather than silently becoming no limit at all.
    if ('velocity' in constraints) {
      const v = parseVelocity(constraints.velocity);
      if (!v.ok) {
        return { allowed: false, constraints: null, reason: `${leg.leg}: ${v.reason}`, legs: contributing };
      }
    }

    for (const [key, value] of Object.entries(constraints)) {
      if (!(key in merged)) {
        // "Key present on one leg only — applies as written." A restriction is never dropped by
        // the other leg's silence.
        merged[key] = normalise(key, value);
        continue;
      }
      const combined = combine(key, merged[key], normalise(key, value));
      if (combined === EMPTY) {
        return {
          allowed: false,
          constraints: null,
          reason: `the ${key} allowlists of ${contributing.join(' and ')} have no value in common`,
          legs: contributing,
        };
      }
      merged[key] = combined;
    }
  }

  return {
    allowed: true,
    constraints: Object.keys(merged).length ? merged : null,
    reason: null,
    legs: contributing,
  };
}

/** Sentinel for an allowlist intersection that came out empty — distinct from `null`, which for an
 *  allowlist would read as "no restriction" and is the exact inversion this exists to avoid. */
const EMPTY = Symbol('empty-intersection');

function normalise(key, value) {
  if (ALLOWLIST_KEYS.has(key)) {
    return Array.isArray(value) ? value.map(String) : [String(value)];
  }
  if (VELOCITY_KEYS.has(key)) {
    // Safe to assert `.ok`: mergeConstraints validated every velocity value before reaching here.
    return parseVelocity(value).velocity;
  }
  return value;
}

function combine(key, a, b) {
  if (TIME_KEYS.has(key)) {
    // Earlier of the two. Compared as timestamps, so a malformed date does not silently sort as a
    // string — an unparseable bound is treated as the other leg's, because a bound nobody can read
    // is not a bound and the other leg's IS one.
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isFinite(ta)) return b;
    if (!Number.isFinite(tb)) return a;
    return ta <= tb ? a : b;
  }
  if (NUMERIC_KEYS.has(key)) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isFinite(na)) return b;
    if (!Number.isFinite(nb)) return a;
    return Math.min(na, nb);
  }
  if (ALLOWLIST_KEYS.has(key)) {
    const set = new Set(b);
    const intersection = a.filter((v) => set.has(v));
    return intersection.length ? intersection : EMPTY;
  }
  if (RESTRICTION_KEYS.has(key)) {
    // "Logical AND of the RESTRICTIONS" — i.e. either leg asserting the restriction makes it
    // apply. Written as an OR of the booleans precisely because the value names the restriction
    // (`readOnly: true` restricts) rather than the permission.
    return Boolean(a) || Boolean(b);
  }
  if (VELOCITY_KEYS.has(key)) {
    // Tighter rate AND tighter burst — the compound analogue of the numeric ceiling's min().
    return combineVelocity(a, b);
  }
  return b;
}

/**
 * The inventory §2.1 requires before this can be enforced: every distinct constraint key in a set
 * of rows, and which of them have no evaluator.
 *
 * Run it over live `grants.constraints` — `node -e` against either store — and the switch from
 * inert to fail-closed is safe exactly when `unknown` comes back empty.
 */
function inventory(rows = []) {
  const counts = new Map();
  let unparseable = 0;
  for (const row of rows) {
    const parsed = parseConstraints(row && row.constraints);
    if (!parsed.ok) { unparseable += 1; continue; }
    if (!parsed.constraints) continue;
    for (const key of Object.keys(parsed.constraints)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  return {
    rows: rows.length,
    unparseable,
    keys,
    unknown: keys.filter((k) => !KNOWN_KEYS.has(k.key)),
    safeToEnforce: unparseable === 0 && keys.every((k) => KNOWN_KEYS.has(k.key)),
  };
}

module.exports = { mergeConstraints, parseConstraints, unknownKeys, inventory, KNOWN_KEYS };
