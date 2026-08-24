'use strict';
// THE NARROWING RULE, both surfaces — docs/design/disposable-nodes.md §5 and §6.
//
// Those two sections make the same argument twice, and say so: "one principle, two surfaces". A
// node may make itself MORE restrictive for free, and may never make itself less. §6 applies it to
// configuration ("the env var is a floor, not an override"); §5 applies it to policy (a node
// profile is a third intersection leg that can only narrow).
//
// So the property under test is one property, and every case below is an attempt to widen:
//
//   a local setting looser than central's                → central's wins
//   a local setting tighter than central's               → the LOCAL one wins
//   a profile tier ceiling above another's               → the lower one wins
//   a constraint present on one leg only                 → it still applies
//   two allowlists with nothing in common                → DENY, not "whichever"
//   a constraint key with no evaluator                   → DENY, not "ignore it"
//
// Run: node server/policy/narrowing-test.js

const { resolveNodeConfig, nodeConfigValue, withinTierCeiling } = require('./nodeConfig');
const { mergeConstraints, inventory } = require('./constraints');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const eq = (label, actual, expected) => check(label, JSON.stringify(actual) === JSON.stringify(expected), actual);

console.log('§6 — the env var is a floor, not an override');

// The headline case, and the one §6 names: a node choosing its own staleness bound is a node
// choosing when to stop being governed.
{
  const loose = resolveNodeConfig({ maxPolicyAgeMs: 15 * 60_000 }, { WINDROW_MAX_POLICY_AGE_MS: String(24 * 3600_000) });
  eq('a node cannot give itself a LONGER staleness bound than central states', loose.values.maxPolicyAgeMs, 15 * 60_000);
  eq('and the source says central decided it', loose.sources.maxPolicyAgeMs, 'central');

  const tight = resolveNodeConfig({ maxPolicyAgeMs: 15 * 60_000 }, { WINDROW_MAX_POLICY_AGE_MS: '60000' });
  eq('a node CAN give itself a shorter one', tight.values.maxPolicyAgeMs, 60_000);
  eq('and the source says the local floor did', tight.sources.maxPolicyAgeMs, 'local-floor');
}

{
  const none = resolveNodeConfig(null, {});
  eq('with no central and no local setting, the build default stands', none.values.maxPolicyAgeMs, 15 * 60_000);
  eq('and it is reported as a default rather than a decision', none.sources.maxPolicyAgeMs, 'default');

  const localOnly = resolveNodeConfig(null, { WINDROW_MAX_POLICY_AGE_MS: '120000' });
  eq('a standalone install still honours its own setting in full', localOnly.values.maxPolicyAgeMs, 120_000);
}

{
  // The pause: §5's "if central should be able to FORBID a pause rather than merely learn of one".
  eq('central can forbid pausing outright',
    nodeConfigValue('allowPause', { allowPause: false }, { WINDROW_ALLOW_ENFORCEMENT_PAUSE: 'true' }), false);
  eq('and a node can forbid it for itself when central has not',
    nodeConfigValue('allowPause', null, { WINDROW_ALLOW_ENFORCEMENT_PAUSE: 'false' }), false);
  eq('tiers intersect rather than replacing',
    nodeConfigValue('pauseTiers', { pauseTiers: ['read_only'] },
      { WINDROW_PAUSABLE_TIERS: 'read_only,mutating,destructive' }), ['read_only']);
  eq('and a node naming fewer than central allows keeps its own shorter list',
    nodeConfigValue('pauseTiers', { pauseTiers: ['read_only', 'mutating'] },
      { WINDROW_PAUSABLE_TIERS: 'read_only' }), ['read_only']);
}

console.log('\n§5 — the node profile ceiling, which can only narrow');

{
  eq('two tier ceilings intersect to the lower one',
    nodeConfigValue('maxTier', { maxTier: 'destructive' }, { WINDROW_MAX_RISK_TIER: 'read_only' }), 'read_only');
  eq('and it is the lower one whichever side states it',
    nodeConfigValue('maxTier', { maxTier: 'read_only' }, { WINDROW_MAX_RISK_TIER: 'destructive' }), 'read_only');
  check('a laptop profile capped at mutating refuses a destructive capability',
    withinTierCeiling('destructive', 'mutating') === false);
  check('and still allows a read_only one', withinTierCeiling('read_only', 'mutating') === true);
  check('a capability whose tier is UNKNOWN is refused by any ceiling',
    withinTierCeiling(undefined, 'destructive') === false);
  check('no ceiling allows everything', withinTierCeiling('destructive', null) === true);
}

console.log('\ngrant-resolution-semantics §2.1 — the constraint merge');

{
  const r = mergeConstraints([
    { leg: 'user', constraints: { expiresAt: '2026-12-01T00:00:00.000Z' } },
    { leg: 'role', constraints: { expiresAt: '2026-09-01T00:00:00.000Z' } },
  ]);
  eq('a time bound takes the EARLIER of the two', r.constraints.expiresAt, '2026-09-01T00:00:00.000Z');
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { maxPerHour: 100 } },
    { leg: 'role', constraints: { maxPerHour: 10 } },
  ]);
  eq('a numeric ceiling takes the LOWER of the two', r.constraints.maxPerHour, 10);
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { paths: ['/a', '/b', '/c'] } },
    { leg: 'role', constraints: { paths: ['/b', '/c', '/d'] } },
  ]);
  eq('an allowlist intersects', r.constraints.paths, ['/b', '/c']);
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { paths: ['/a'] } },
    { leg: 'role', constraints: { paths: ['/b'] } },
  ]);
  check('an EMPTY intersection denies rather than allowing either', r.allowed === false, r);
  check('and the denial names both legs', /user and role/.test(r.reason || ''), r.reason);
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { readOnly: false } },
    { leg: 'role', constraints: { readOnly: true } },
  ]);
  check('either leg asserting a restriction makes it apply', r.constraints.readOnly === true, r.constraints);
}
{
  // The row that is easiest to get backwards, and the reason intersection is not "whichever".
  const r = mergeConstraints([
    { leg: 'user', constraints: { paths: ['/repo'] } },
    { leg: 'role', constraints: { maxPerHour: 5 } },
  ]);
  eq('a key on one leg only applies as written — silence is not permission',
    r.constraints, { paths: ['/repo'], maxPerHour: 5 });
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { paths: ['/repo'] } },
    { leg: 'role', constraints: null },
    { leg: 'node profile "laptop"', constraints: { readOnly: true, maxPerHour: 2 } },
  ]);
  check('a third narrowing leg composes with the other two without a precedence rule', r.allowed === true, r);
  eq('and every restriction from every leg survives',
    r.constraints, { paths: ['/repo'], readOnly: true, maxPerHour: 2 });
}
{
  const r = mergeConstraints([
    { leg: 'user', constraints: { budgetInEuros: 40 } },
  ]);
  check('a constraint key with no evaluator DENIES rather than being ignored', r.allowed === false, r);
  check('and says which key', /budgetInEuros/.test(r.reason || ''), r.reason);
}
{
  const r = mergeConstraints([{ leg: 'user', constraints: '{"paths": ["/x"' }]);
  check('constraints that will not parse deny rather than being coerced', r.allowed === false, r);
}
{
  eq('no legs with constraints merges to no constraints', mergeConstraints([
    { leg: 'user', constraints: null }, { leg: 'role', constraints: undefined },
  ]).constraints, null);
}

console.log('\nthe inventory pass §2.1 requires before this can be enforced');
{
  const clean = inventory([{ constraints: { paths: ['/a'] } }, { constraints: '{"maxPerHour":3}' }]);
  check('a registry using only known keys is safe to enforce', clean.safeToEnforce === true, clean);
  const dirty = inventory([{ constraints: { paths: ['/a'] } }, { constraints: { seatCount: 3 } }]);
  check('one unknown key anywhere makes it unsafe', dirty.safeToEnforce === false, dirty);
  eq('and the pass names it', dirty.unknown.map((k) => k.key), ['seatCount']);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
