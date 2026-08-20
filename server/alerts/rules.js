'use strict';
// The half of the alert engine that BOTH ends run — docs/design/global-identity-and-central-db.md
// §2.3, "Evaluate alerts at both ends":
//
//   "A node-local rule engine catches 'this user just ran 40 destructive calls' while the WAN is
//    down; central catches 'this user is on five PCs and the total crossed the threshold'. Dedupe
//    on a stable alert key (ruleId, subjectId, window) so a breach seen from both sides fires once."
//
// Two engines evaluating the same breach only fire once if they compute the same KEY, and they only
// compute the same key if the rule list, the window arithmetic and the subject fallback are one
// piece of code rather than two readings of one paragraph. That is what this file is. It holds no
// database handle, no clock of its own and no I/O: every function takes what it needs and returns
// a value, so the node engine (./nodeEngine.js, SQLite over this node's usage_events) and the
// central engine (../central/alertEngine.js, Postgres over the fleet aggregate) can share it
// without sharing a driver.
//
// ============================================================================================
// WHY THE WINDOW HAS TO BE SNAPPED, AND WHAT IT IS SNAPPED TO
// ============================================================================================
//
// "Window" in the dedup key is doing more work than it looks. The obvious implementation of an
// alert rule is a SLIDING window — "count the last five minutes, every time an event lands" — and
// a sliding window has NO STABLE IDENTITY. The node evaluates at 12:04:07 and covers
// [11:59:07, 12:04:07); central evaluates at 12:04:31 over the same breach and covers
// [11:59:31, 12:04:31). Different windows, different keys, two alerts for one burst — which is the
// exact failure the key exists to prevent. Worse, the node would re-key on every single event, so
// one 40-call burst would fire forty times before central ever saw it.
//
// So the window is SNAPPED to a grid both ends can compute from the rule alone plus a wall clock:
//
//     windowEnd   = (floor(atMs / strideMs) + 1) * strideMs      -- the open bucket containing atMs
//     windowStart = windowEnd - windowMs
//
// Two independent evaluations land on the same window whenever they happen inside the same stride
// bucket, without talking to each other. `windowStart` is what goes in the key, and `windowMs` is
// fixed per rule, so the pair is recoverable from it.
//
// STRIDE IS SEPARATE FROM WINDOW because making them equal — tumbling windows — has a real hole in
// it: a burst that straddles a boundary is split between two buckets and neither one reaches the
// threshold. Twenty destructive calls at 12:04 and twenty at 12:06 is forty in any five minutes a
// human would name, and zero alerts under a tumbling 5-minute window. A stride shorter than the
// window (hopping windows) means overlapping windows cover every straddle: with a 5-minute window
// on a 1-minute stride, some window contains the whole burst.
//
// The cost of overlap is that ONE breach can satisfy several consecutive windows, and each of them
// is a distinct key that the dedup table will happily let through. That is what `cooldownMs` is
// for, and it is deliberately a second mechanism rather than a tweak to the first: the key
// suppresses THE SAME window seen twice (the two-ends case, which is what §2.3 asks for), and the
// cooldown suppresses ADJACENT windows describing one continuing breach (the overlap case, which
// hopping windows create). Collapsing them into one would mean choosing between missing straddled
// bursts and alert storms.
//
// ============================================================================================
// WHY `scopeId` IS IN THE KEY ALONGSIDE THE THREE §2.3 NAMES
// ============================================================================================
//
// §2.3's key is (ruleId, subjectId, window), and for the rules it describes centrally — "this user
// is on five PCs and the total crossed the threshold" — those three are complete: the aggregate has
// exactly one answer per subject per window, so a fourth column would only ever hold one value.
//
// A NODE-SCOPED rule is a different statement. "This user just ran 40 destructive calls" is a claim
// about a burst on one machine, and the same user doing it on two PCs in the same window is TWO
// bursts on two machines — two things an operator has to look at, in two places. Keyed on the three
// columns alone the second one would be silently swallowed as a duplicate of the first, and the
// dedup that exists to stop double-reporting would be suppressing a genuine second incident.
//
// So the key carries `scopeId`: the nodeId for a `node`-scoped rule, the literal `'fleet'` for a
// `fleet`-scoped one. For fleet rules that is a constant and the key is §2.3's exactly; for node
// rules it is the machine the burst happened on. `alertKey()` is the only place the four are
// assembled, on both ends, so the string is identical or the bug is in one function.
//
// ============================================================================================
// WHY BOTH ENDS EVALUATE NODE-SCOPED RULES, RATHER THAN THE NODE OWNING THEM
// ============================================================================================
//
// It would be tidier to say node rules are the node's job and fleet rules are central's, and never
// have two engines look at one rule. It would also mean a node whose disk is full, whose service
// was stopped, or which was rebuilt between the burst and the alert never reports the burst at all
// — while the events sat at central the whole time. Central re-deriving node-scoped rules over the
// same node's shipped rows is the backstop for a node that stopped evaluating, and it is nearly
// free: it lands on the same key, so when the node did its job central's copy is a no-op insert.
//
// The reverse does not hold. Central cannot be the only evaluator of a node-scoped rule, because
// the WAN being down is precisely the condition §2.3 names — the events have not arrived.

/** Rule `scope`. Decides which side of the key `scopeId` comes from, and what each end counts. */
const NODE = 'node';
const FLEET = 'fleet';
const SCOPES = new Set([NODE, FLEET]);

/** What a rule counts over its window. */
const METRICS = new Set([
  'count', // rows matching the filter
  'distinctCapabilities', // how many DIFFERENT capabilities — breadth, not volume
  'distinctNodes', // how many machines — only meaningful fleet-scoped
]);

const SEVERITIES = new Set(['info', 'warning', 'critical']);

/** The subject a row with no resolved subject is counted under. Both ends must agree on this
 *  string, or the same rows would be grouped under two different subjects and neither would reach
 *  a threshold the two together cross. See `subjectSql` in each engine. */
const UNKNOWN_SUBJECT = 'unknown';

/** Which end wrote an alert row first. */
const FIRED_BY_NODE = 'node';
const FIRED_BY_CENTRAL = 'central';

/**
 * The rules this build ships with.
 *
 * They are code rather than a table on purpose, for now: a rule that only exists on some nodes
 * cannot be deduped against central, because central has no way to know which key a node it never
 * heard from would have computed. Making rules configurable is a control-plane change — it belongs
 * in the policy replica of §2.2, distributed the way grants are, and doing it before that exists
 * would be a second policy channel with its own skew. `loadRules()` is the seam that will take
 * them from there.
 *
 * The first two are §2.3's own examples, one per scope, so both halves of the design are exercised
 * from the first build.
 */
const DEFAULT_RULES = Object.freeze([
  {
    id: 'destructive-burst',
    title: 'Destructive-call burst on one machine',
    description:
      'A subject ran an unusual number of destructive-tier calls on a single PC inside five minutes. '
      + "§2.3's node-local example — the one a partitioned machine has to catch for itself, because "
      + 'while the WAN is down central has not seen a single one of these events.',
    scope: NODE,
    match: { riskTier: 'destructive' },
    metric: 'count',
    threshold: 40,
    windowMs: 5 * 60_000,
    strideMs: 60_000,
    cooldownMs: 5 * 60_000,
    severity: 'critical',
    enabled: true,
  },
  {
    id: 'denial-storm',
    title: 'Denials across the fleet',
    description:
      'A subject is being denied repeatedly. Fleet-scoped: the case §2.3 names is a subject active on '
      + 'five PCs where no single machine crosses the threshold but the total does, which only the '
      + 'aggregate can see.',
    scope: FLEET,
    match: { outcome: 'denied' },
    metric: 'count',
    threshold: 25,
    windowMs: 10 * 60_000,
    strideMs: 2 * 60_000,
    cooldownMs: 10 * 60_000,
    severity: 'warning',
    enabled: true,
  },
  {
    id: 'subject-fanout',
    title: 'One subject active on many machines at once',
    description:
      'The same subject made governed calls from an unusual number of PCs inside ten minutes. Not a '
      + 'volume rule — the signal is breadth, and it is the shape a shared or stolen identity makes. '
      + 'Unreachable from any single node by construction.',
    scope: FLEET,
    match: {},
    metric: 'distinctNodes',
    threshold: 5,
    windowMs: 10 * 60_000,
    strideMs: 2 * 60_000,
    cooldownMs: 30 * 60_000,
    severity: 'warning',
    enabled: true,
  },
]);

/** The `match` filters this build understands. A rule naming one it does not is refused — see
 *  `normalizeRule` for why that direction, rather than ignoring the filter. */
const MATCH_FILTERS = ['outcome', 'riskTier', 'capabilityId', 'capabilityKind'];

/**
 * Check one rule and fill in its optional fields, or say why it cannot be used.
 *
 * Returns `{ ok, rule, reason }` rather than throwing: a malformed rule must disable ITSELF and
 * leave every other rule running. An engine that refuses to start over one bad rule is an engine
 * that stops catching the burst it was installed for, which is strictly worse than one rule being
 * loudly skipped.
 */
function normalizeRule(raw) {
  const bad = (reason) => ({ ok: false, rule: null, reason });
  if (!raw || typeof raw !== 'object') return bad('rule is not an object');
  if (typeof raw.id !== 'string' || !raw.id.trim()) return bad('rule has no id');
  const id = raw.id.trim();
  // The id is half the dedup key and reaches both stores as a primary-key component. Keeping it to
  // a slug means the key never needs escaping and never needs a collation argument between SQLite
  // and Postgres.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return bad(`rule ${id}: id must be a lowercase slug (a-z, 0-9, -)`);

  const scope = raw.scope || NODE;
  if (!SCOPES.has(scope)) return bad(`rule ${id}: unknown scope "${scope}"`);
  const metric = raw.metric || 'count';
  if (!METRICS.has(metric)) return bad(`rule ${id}: unknown metric "${metric}"`);

  const windowMs = Number(raw.windowMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return bad(`rule ${id}: windowMs must be a positive number`);
  const threshold = Number(raw.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return bad(`rule ${id}: threshold must be a positive number`);

  // Stride defaults to the window (tumbling). A stride LONGER than the window would leave uncovered
  // time between windows — events no window ever counts — which is a rule that silently ignores
  // some of its own input, so it is refused rather than clamped.
  const strideMs = raw.strideMs == null ? windowMs : Number(raw.strideMs);
  if (!Number.isFinite(strideMs) || strideMs <= 0) return bad(`rule ${id}: strideMs must be a positive number`);
  if (strideMs > windowMs) {
    return bad(`rule ${id}: strideMs (${strideMs}) exceeds windowMs (${windowMs}) — the gap between windows would go uncounted`);
  }

  // `distinctNodes` at node scope can only ever answer 1. Not a crash, but always a mistake, and it
  // would sit there looking like a rule that simply never trips.
  if (metric === 'distinctNodes' && scope === NODE) {
    return bad(`rule ${id}: metric distinctNodes is meaningless at node scope — one node counts one node`);
  }

  const severity = raw.severity || 'warning';
  if (!SEVERITIES.has(severity)) return bad(`rule ${id}: unknown severity "${severity}"`);

  const match = raw.match && typeof raw.match === 'object' ? raw.match : {};
  const unknownMatch = Object.keys(match).filter((k) => !MATCH_FILTERS.includes(k));
  if (unknownMatch.length) {
    // Refused rather than ignored: a filter this build does not understand makes the rule MATCH
    // MORE than its author meant, so quietly dropping it converts a narrow rule into a broad one
    // that fires on the wrong thing. Under-matching would be safe to ignore; over-matching is not.
    return bad(`rule ${id}: match names filter(s) this build does not understand (${unknownMatch.join(', ')})`);
  }

  return {
    ok: true,
    reason: null,
    rule: Object.freeze({
      id,
      title: raw.title || id,
      description: raw.description || '',
      scope,
      match: Object.freeze({ ...match }),
      metric,
      threshold,
      windowMs,
      strideMs,
      // Cooldown defaults to one window: long enough that a continuing breach reports once per
      // window rather than once per stride, short enough that a genuinely new breach in the next
      // window is not swallowed.
      cooldownMs: raw.cooldownMs == null ? windowMs : Math.max(0, Number(raw.cooldownMs) || 0),
      severity,
      enabled: raw.enabled !== false,
    }),
  };
}

/**
 * The rule list an engine should run, with anything malformed dropped and reported.
 *
 * Returns `{ rules, skipped }`. Callers log `skipped` once at start rather than per evaluation — a
 * bad rule is a static fact about the build, and repeating it every cycle would bury the alerts the
 * engine exists to surface.
 */
function loadRules(raw = DEFAULT_RULES) {
  const rules = [];
  const skipped = [];
  const seen = new Set();
  for (const candidate of raw) {
    const { ok, rule, reason } = normalizeRule(candidate);
    if (!ok) {
      skipped.push({ id: (candidate && candidate.id) || null, reason });
      continue;
    }
    // A duplicate id is the one error that corrupts the dedup key itself: two different rules
    // sharing an id means one silently suppresses the other's alerts as duplicates of its own.
    if (seen.has(rule.id)) {
      skipped.push({ id: rule.id, reason: `duplicate rule id "${rule.id}"` });
      continue;
    }
    seen.add(rule.id);
    if (!rule.enabled) continue;
    rules.push(rule);
  }
  return { rules, skipped };
}

/**
 * The window a rule is currently evaluating, given a wall clock.
 *
 * `atMs` lands in the stride bucket `[floor(atMs/stride)*stride, +stride)`, and the window is the
 * one that CLOSES at the end of that bucket. Taking the end of the bucket rather than its start is
 * what makes an event that just arrived fall inside the window it triggered: with `windowEnd` set
 * to the floor, an event at exactly a stride boundary would sit one millisecond past the end of the
 * window its own arrival caused to be evaluated.
 *
 * Both engines call this with their own clock. They agree whenever those clocks are inside the same
 * stride bucket — which is this design's tolerance for skew between a node and central, and the
 * reason `strideMs` is minutes rather than seconds. §2.3's note is the standing warning: trust node
 * clocks for nothing. Where the two disagree by more than a stride the same breach fires twice
 * under two adjacent window keys — a visible duplicate, which is the failure worth having, rather
 * than a missed alert.
 */
function windowFor(rule, atMs) {
  const stride = rule.strideMs;
  const windowEnd = (Math.floor(atMs / stride) + 1) * stride;
  return { windowStart: windowEnd - rule.windowMs, windowEnd };
}

/** The window key as it is stored and compared: an ISO instant, not a number. Milliseconds since
 *  epoch would be identical information and unreadable in the one place this string is most often
 *  looked at — a human asking why two alerts did or did not collapse. */
function windowKey(ms) {
  return new Date(ms).toISOString();
}

/** A subject id safe to put in a key. A `|` in a subject would let one subject's key be forged into
 *  another's, and the subject derives from an OS username on a machine the user controls — so it is
 *  attacker-influenced in exactly the way a key separator must not be. */
function sanitizeSubject(subjectId) {
  const s = subjectId == null || subjectId === '' ? UNKNOWN_SUBJECT : String(subjectId);
  return s.replace(/\|/g, '%7C');
}

/**
 * §2.3's stable alert key. THE one function both ends call.
 *
 * The separator is `|`, and the parts are joined without escaping because none of them can contain
 * it: `ruleId` is slug-validated above, `windowStart` is an ISO instant, `scopeId` is a nodeId or
 * the literal 'fleet'. `subjectId` is the only part that comes from data, so it is the only one
 * sanitised.
 */
function alertKey({ ruleId, scopeId, subjectId, windowStart }) {
  return [ruleId, scopeId || FLEET, sanitizeSubject(subjectId), windowStart].join('|');
}

/** `scopeId` for a rule, given the node the engine is speaking for. */
function scopeIdFor(rule, nodeId) {
  return rule.scope === NODE ? nodeId : FLEET;
}

/**
 * Did this observation breach the rule? Pure, so the two engines' SQL may differ while their
 * VERDICT cannot.
 *
 * `>=`, not `>`: a threshold of 40 in a rule described as "40 destructive calls" fires at the 40th.
 */
function breaches(rule, value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= rule.threshold;
}

/**
 * Assemble the alert a breach produces.
 *
 * Deliberately carries the rule's own numbers alongside the observed one: the rule list is code and
 * will change, and an alert that recorded only "value 47" becomes unreadable the moment the
 * threshold it crossed is edited.
 *
 * `firedBy` is the end that saw it first — the field that answers "did the node catch this, or did
 * we only learn of it when the events arrived", which is the operational question a two-ended
 * design creates and the one thing neither end can reconstruct afterwards.
 */
function buildAlert({ rule, scopeId, subjectId, value, windowStartMs, firedBy, nodeId = null, firedAt = null, detail = null }) {
  const windowStart = windowKey(windowStartMs);
  return {
    key: alertKey({ ruleId: rule.id, scopeId, subjectId, windowStart }),
    ruleId: rule.id,
    scope: rule.scope,
    scopeId: scopeId || FLEET,
    subjectId: subjectId == null || subjectId === '' ? UNKNOWN_SUBJECT : String(subjectId),
    windowStart,
    windowEnd: windowKey(windowStartMs + rule.windowMs),
    windowMs: rule.windowMs,
    metric: rule.metric,
    threshold: rule.threshold,
    value: Number(value),
    severity: rule.severity,
    title: rule.title,
    firedBy,
    nodeId,
    firedAt,
    detail: detail == null ? null : JSON.stringify(detail),
  };
}

module.exports = {
  NODE,
  FLEET,
  SCOPES,
  METRICS,
  SEVERITIES,
  UNKNOWN_SUBJECT,
  FIRED_BY_NODE,
  FIRED_BY_CENTRAL,
  DEFAULT_RULES,
  MATCH_FILTERS,
  normalizeRule,
  loadRules,
  windowFor,
  windowKey,
  alertKey,
  sanitizeSubject,
  scopeIdFor,
  breaches,
  buildAlert,
};
