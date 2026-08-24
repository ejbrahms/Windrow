'use strict';
// CONFIGURATION FROM THE NODE SIDE — docs/design/disposable-nodes.md §6, and the one file that
// knows which of this system's 77 configuration names central is allowed to have an opinion about.
//
// §6's measurement: 77 WINDROW_* names are read across the tree, central knows the value of NONE of
// them, and there is no config channel in either direction. So the split today is hybrid by
// accident. §6 makes it hybrid ON PURPOSE, split by WHO BEARS THE CONSEQUENCE:
//
//   BOOTSTRAP          how to FIND central — the URL, the join token, the ports. Node only, and
//                      kept as small as possible, because everything in this tier is something a
//                      rebuild has to be handed. You cannot fetch configuration from a place you do
//                      not know how to reach.
//   MACHINE FACTS      what is true about this box — skill directories, hook install paths,
//                      discovery sources, WINDROW_USER_HOME. Node authoritative, because central
//                      cannot know them and should not guess. Reported UP, because central should
//                      still be able to see them.
//   POLICY PARAMETERS  the numbers that decide whether governance holds. CENTRAL, pushed. This file
//                      is that tier, and nothing else belongs in it.
//
// THE SHARPEST EXAMPLE, quoted because it is the whole argument: WINDROW_MAX_POLICY_AGE_MS is the
// bound on how long a partitioned node keeps enforcing stale policy. It is a fleet security
// property, and it was an environment variable on the machine it constrains. This codebase already
// made exactly this argument once, for the enforcement pause — "a hook reading its own bypass flag
// out of the agent's environment would be a bypass every governed process could set for itself."
// The argument extends: a node choosing its own staleness bound is a node choosing when to stop
// being governed.
//
// ------------------------------------------------------------------------------------------------
// THE PRECEDENCE RULE: THE ENV VAR IS A FLOOR, NOT AN OVERRIDE.
// ------------------------------------------------------------------------------------------------
//
// Where central states a value, a local setting may only make it MORE RESTRICTIVE — a shorter
// MAX_POLICY_AGE, a tighter pause cap, a smaller set of pausable tiers. Never less. A local
// override that can only tighten is safe in an operator's hands; one that can loosen is a bypass
// wearing a config file's name.
//
// That is the same narrowing-only rule as §5's node profiles, and the repetition is the point: one
// principle, two surfaces. It is also why every parameter below has to declare a DIRECTION. "More
// restrictive" is not a property of a number — 15 minutes is tighter than 60 for a staleness bound
// and looser than 60 for nothing at all — so each entry says which way tightening goes, and the
// merge is mechanical from there. A parameter whose direction nobody can state does not belong in
// this tier; it belongs in the machine-facts tier, where the node simply reports what it is.
//
// ------------------------------------------------------------------------------------------------
// HOW IT TRAVELS: ON THE POLICY RESPONSE, BESIDE THE DENY-LIST.
// ------------------------------------------------------------------------------------------------
//
// No new endpoint, no new credential, no new failure mode. The deny-list already rides every
// /api/policy response in full because it is small and monotone; policy parameters are the same
// shape. They land in the same signed file the hook already reads, under the same staleness stamp —
// so a node that cannot reach central AGES OUT ITS PARAMETERS exactly as it ages out its policy,
// which is the correct behaviour and comes free.
//
// One consequence worth being explicit about: a node that has never reached central has no central
// values at all, so every parameter falls back to its local value. That is not a hole. Until the
// first successful pull there is nothing to be stale about, and server/app.js's /api/ready already
// refuses to serve a replica node that has never pulled.

const { envCompat } = require('../config');

/**
 * `lower` — a smaller number is more restrictive (a staleness bound, a pause ceiling).
 * `higher` — a larger number is more restrictive. Nothing uses it yet; it exists so that adding a
 *            floor-shaped parameter later is a table entry rather than a rewrite of `narrow`.
 * `subset` — a shorter list is more restrictive (which tiers a pause may cover).
 * `false`  — for a boolean, `false` is more restrictive (may this node pause at all).
 */
const LOWER = 'lower';
const HIGHER = 'higher';
const SUBSET = 'subset';
const FALSE = 'false';
// `tier` — a lower position on the risk scale is more restrictive. Not a number and not a set, so
// it needs its own rule: read_only ceiling ∩ destructive ceiling = read_only.
const TIER = 'tier';

/** The risk scale, least to most dangerous. The one ordering; server/store.js's ASSURANCE_TIERS is
 *  a different scale for a different thing and must not be confused with it. */
const TIER_ORDER = ['read_only', 'mutating', 'destructive'];

/**
 * THE POLICY-PARAMETER TIER, in full. Adding a row here is how a number moves from "each node's own
 * business" to "the fleet's business", and the four columns are the whole contract:
 *
 *   env        the name a node reads it under today, so this is a migration rather than a fork.
 *   direction  which way "more restrictive" points. See the header.
 *   parse      env values are strings; central's are already typed.
 *   fallback   what a node with neither uses. Deliberately the same default the reading module
 *              already had, so a fleet that never sets any of this behaves exactly as it does now.
 */
const PARAMETERS = {
  // How long a partitioned node keeps enforcing off a replica it cannot refresh. §6's headline
  // example, and the reason this file exists.
  maxPolicyAgeMs: {
    env: 'MAX_POLICY_AGE_MS', direction: LOWER, parse: num, fallback: 15 * 60_000,
  },
  // How quickly a revocation reaches this node when the SSE channel is down. Central's business
  // because it is central's revocation window, and because it prices central's own load.
  policyPollIntervalMs: {
    env: 'POLICY_POLL_INTERVAL_MS', direction: LOWER, parse: num, fallback: 30_000,
  },
  // ---- the enforcement pause: §5's "if central should be able to FORBID a pause rather than
  // merely learn of one, that also lives on the profile". These are how it does.
  allowPause: {
    env: 'ALLOW_ENFORCEMENT_PAUSE', direction: FALSE, parse: bool, fallback: true,
  },
  pauseMaxMs: {
    env: 'MAX_PAUSE_MS', direction: LOWER, parse: num, fallback: 30 * 60_000,
  },
  pauseDefaultMs: {
    env: 'DEFAULT_PAUSE_MS', direction: LOWER, parse: num, fallback: 15 * 60_000,
  },
  // Which risk tiers a pause on this node may ever cover. Narrowing this to ['read_only'] is how a
  // fleet says "you may debug on that laptop, but you may not turn off denials for anything that
  // writes".
  pauseTiers: {
    env: 'PAUSABLE_TIERS', direction: SUBSET, parse: list, fallback: ['read_only', 'mutating', 'destructive'],
  },
  // ---- the maintenance grace lease. Softens faults rather than overriding decisions, so it is
  // less dangerous than a pause and gets the same treatment anyway: it is still a node widening
  // itself, and §5's rule does not have an exception for "only a bit".
  leaseMaxMs: {
    env: 'MAX_LEASE_MS', direction: LOWER, parse: num, fallback: 60 * 60_000,
  },
  leaseTiers: {
    env: 'LEASABLE_TIERS', direction: SUBSET, parse: list, fallback: ['read_only', 'mutating'],
  },
  // ---- THE NODE PROFILE'S CEILING — docs/design/disposable-nodes.md §5's design call, and the two
  // dials it says a profile gets. Both narrow and neither can widen, which is what lets them be
  // ANDed onto the fleet-wide decision with no precedence rule: AND commutes.
  //
  // These arrive on the same channel as everything else here, and §5 §4 is explicit that shipping
  // the profile to the node rather than filtering the delta server-side is the right call:
  // filtering would be a confidentiality win and an ENFORCEMENT NO-OP, because a node that ignores
  // its own ceiling is a node that ignores its own deny-list — and it would cost the single global
  // monotonic policy_changes version that makes the delta stream and the `reset` rule work.
  //
  // "laptop may not host destructive at all." Null means no ceiling.
  maxTier: {
    env: 'MAX_RISK_TIER', direction: TIER, parse: tier, fallback: null,
  },
  // "the deploy MCP only on ci." Null means no allowlist — every capability the fleet allows. A
  // PRESENT but empty list means nothing is allowed, which is a real thing to be able to say.
  capabilityAllowlist: {
    env: 'CAPABILITY_ALLOWLIST', direction: SUBSET, parse: list, fallback: null,
  },
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function bool(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return null;
}
function tier(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  return TIER_ORDER.includes(text) ? text : null;
}
function list(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return null;
  return String(value).split(/[,;]/).map((v) => v.trim()).filter(Boolean);
}

/**
 * The merge, for one parameter. This is the whole of §6's precedence rule expressed once.
 *
 * Absent central value → the local one, or the fallback. Absent local value → central's. Both
 * present → whichever is MORE RESTRICTIVE, by the parameter's declared direction. There is no
 * branch in which the local value wins by being local: it wins only by being tighter.
 */
function narrow(direction, central, local) {
  if (central === null || central === undefined) return local;
  if (local === null || local === undefined) return central;
  switch (direction) {
    case LOWER: return Math.min(central, local);
    case HIGHER: return Math.max(central, local);
    case FALSE: return Boolean(central) && Boolean(local);
    case SUBSET: {
      const allowed = new Set(central);
      return local.filter((v) => allowed.has(v));
    }
    case TIER: {
      const a = TIER_ORDER.indexOf(central);
      const b = TIER_ORDER.indexOf(local);
      // An unrecognised tier on either side is treated as no ceiling from that side rather than as
      // the tightest one. Denying the whole fleet because central sent a word this build has not
      // heard of is the wrong direction to round for a value that arrives over the wire; the
      // capability's OWN tier is still checked, and an unknown tier there is already a hard deny
      // (server/hooks/lib.js).
      if (a === -1) return local;
      if (b === -1) return central;
      return TIER_ORDER[Math.min(a, b)];
    }
    default: return central;
  }
}

/**
 * Resolve every policy parameter for this process.
 *
 * `central` is the `nodeConfig` block off the last policy response — null on a standalone install
 * and on a node that has never pulled. `env` is taken rather than read so this is pure and the
 * tests can stage a fleet without editing the process's own environment.
 *
 * Returns `{ values, sources }`. `sources` says, per key, whether the answer came from central,
 * from the local floor, or from neither — which is what makes "why is this node's staleness bound
 * five minutes when I set it to sixty at central" an answerable question instead of an argument.
 */
function resolveNodeConfig(central = null, env = process.env) {
  const values = {};
  const sources = {};
  for (const [key, spec] of Object.entries(PARAMETERS)) {
    const raw = envCompat(spec.env, { env });
    const local = raw === undefined || raw === null || raw === '' ? null : spec.parse(raw);
    const fromCentral = central && Object.prototype.hasOwnProperty.call(central, key)
      ? spec.parse(central[key])
      : null;
    const merged = narrow(spec.direction, fromCentral, local);
    values[key] = merged === null || merged === undefined ? spec.fallback : merged;
    if (fromCentral === null && local === null) sources[key] = 'default';
    else if (fromCentral === null) sources[key] = 'local';
    else if (local === null) sources[key] = 'central';
    else sources[key] = sameValue(merged, fromCentral) ? 'central' : 'local-floor';
  }
  return { values, sources };
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/**
 * One parameter, resolved. The shape every reader uses, because a reader that resolved the whole
 * table to use one key would pay for eight parses on the hook's 20 ms budget.
 */
function nodeConfigValue(key, central = null, env = process.env) {
  const spec = PARAMETERS[key];
  if (!spec) throw new Error(`unknown node config parameter: ${key}`);
  const raw = envCompat(spec.env, { env });
  const local = raw === undefined || raw === null || raw === '' ? null : spec.parse(raw);
  const fromCentral = central && Object.prototype.hasOwnProperty.call(central, key)
    ? spec.parse(central[key])
    : null;
  const merged = narrow(spec.direction, fromCentral, local);
  return merged === null || merged === undefined ? spec.fallback : merged;
}

/** The keys central is allowed to state. Used at central to reject anything else outright, so a
 *  typo in a profile cannot quietly become a parameter nobody reads. */
const PARAMETER_KEYS = Object.keys(PARAMETERS);

/**
 * Is `riskTier` within `maxTier`? The one place the ceiling comparison is written, so a caller
 * cannot get the direction backwards.
 *
 * A null ceiling allows everything. An UNKNOWN tier on the capability is refused: `maxTier` is a
 * position on a scale, and a value that is not on the scale has no position to compare — the same
 * rule server/enforcementPause.js applies to a pause and an untyped denial, and for the same
 * reason.
 */
function withinTierCeiling(riskTier, maxTier) {
  if (!maxTier) return true;
  const ceiling = TIER_ORDER.indexOf(maxTier);
  const actual = TIER_ORDER.indexOf(riskTier);
  if (ceiling === -1) return true;
  if (actual === -1) return false;
  return actual <= ceiling;
}

module.exports = {
  PARAMETERS, PARAMETER_KEYS, resolveNodeConfig, nodeConfigValue, narrow, withinTierCeiling,
  TIER_ORDER, LOWER, HIGHER, SUBSET, FALSE, TIER,
};
