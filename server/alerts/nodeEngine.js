'use strict';
// The node end of docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both
// ends": "A node-local rule engine catches 'this user just ran 40 destructive calls' while the WAN
// is down."
//
// WHAT MAKES THIS NECESSARY RATHER THAN MERELY FASTER. Every other alerting design in this system
// could live at central, because central eventually receives everything. This one cannot, and the
// word in §2.3 is "while": the events that constitute the burst are sitting in `usage_outbox` on a
// machine that cannot reach the network, so for the whole duration of the partition central's
// aggregate contains none of them. An engine that only ran centrally would report the burst when
// the laptop rejoined the VPN — which, for the one class of event this rule exists to catch, is
// after the fact by however long the user stayed offline.
//
// WHAT THIS ENGINE WILL NOT EVALUATE, AND WHY THAT MATTERS MORE THAN WHAT IT WILL. It runs
// `scope: 'node'` rules only. A fleet-scoped rule counted over one node's rows would produce a
// partial answer — and, far worse, it would produce that answer under the FLEET key, whose scopeId
// is the constant 'fleet'. Central's own evaluation of the same rule and window computes the same
// key, hits the primary key, and is discarded as a duplicate of the node's partial count. The
// dedup that exists to make a breach fire once would be making the WRONG number the one that
// survives, and silently: the alert would be present, plausible, and understated. So the split is
// not an optimisation, it is a correctness boundary — a node may only key what it can fully count.
//
// See ./rules.js for the window arithmetic and the key, and the "Alerts" section of ../store.js
// for why the window is counted over `usage_events` while the outbox supplies the trigger and the
// "how much of this can central not see" number.

const { envCompat } = require('../config');
const rules = require('./rules');

// How long to wait after an event before evaluating. A 40-call burst arrives as 40 inserts in a
// few seconds; without this the engine would run its GROUP BY forty times to reach one alert, on
// the same process the hook API answers allow/deny from. Coalescing is free here because the
// window is snapped: every one of those evaluations would compute the same window key anyway.
const DEBOUNCE_MS = Number(envCompat('ALERT_DEBOUNCE_MS')) || 1_000;

// The floor between evaluations, whatever the traffic. Sustained load would otherwise turn the
// debounce into "evaluate every second forever".
const MIN_INTERVAL_MS = Number(envCompat('ALERT_MIN_INTERVAL_MS')) || 5_000;

// The unconditional sweep. Two jobs: it re-evaluates on a machine that has gone quiet since its
// last event (so a rule whose window is still open is still checked), and it is what drives the
// alert shipper's retry — a node that fired an alert while partitioned has nothing else that would
// notice the network came back.
const SWEEP_INTERVAL_MS = Number(envCompat('ALERT_SWEEP_INTERVAL_MS')) || 60_000;

let store = null;
let active = [];
let debounceTimer = null;
let sweepTimer = null;
let lastRunAt = 0;
let running = false;
let onFired = null;
let afterSweep = null;
const stats = { evaluations: 0, fired: 0, deduped: 0, suppressed: 0, errors: 0 };

/**
 * Evaluate every node-scoped rule against the window that is open right now.
 *
 * Returns the alerts that were genuinely NEW — not the ones the key or the cooldown swallowed.
 * Callers log on that, because "fired" counted before the dedup is the number that makes a deduped
 * design still shout twice.
 */
function evaluateNow(atMs = Date.now()) {
  if (!store || !active.length) return [];
  const nodeId = store.nodeId();
  const fired = [];
  stats.evaluations += 1;

  for (const rule of active) {
    let breaches;
    const { windowStart, windowEnd } = rules.windowFor(rule, atMs);
    const windowStartIso = rules.windowKey(windowStart);
    const windowEndIso = rules.windowKey(windowEnd);
    try {
      breaches = store.alertBreaches(rule, { windowStart: windowStartIso, windowEnd: windowEndIso, node: nodeId });
    } catch (err) {
      // One rule's SQL failing must not stop the others — the same reasoning as loadRules skipping
      // a malformed rule rather than refusing to start.
      stats.errors += 1;
      console.error(`[alerts] rule ${rule.id} could not be evaluated: ${err.message}`);
      continue;
    }

    for (const breach of breaches) {
      const scopeId = rules.scopeIdFor(rule, nodeId);

      // The cooldown, checked BEFORE the insert rather than after. Overlapping hopping windows mean
      // one continuing breach satisfies several consecutive window keys, each of them new, so the
      // primary key alone would let a five-minute burst produce one alert per stride. See the
      // header of ./rules.js for why these are two mechanisms and not one.
      if (rule.cooldownMs > 0) {
        const last = store.lastAlertFiredAt(rule.id, scopeId, breach.subjectId);
        if (last && atMs - Date.parse(last) < rule.cooldownMs) {
          stats.suppressed += 1;
          continue;
        }
      }

      // How much of this breach central cannot see. The number that distinguishes "the node caught
      // something central would have caught anyway, a few seconds sooner" from "the node caught
      // something central has no copy of" — which is the case §2.3 built this engine for, and the
      // one an operator reading the alert needs to be told about.
      let unshipped = 0;
      try {
        unshipped = store.countUnshippedMatches(rule, {
          windowStart: windowStartIso,
          windowEnd: windowEndIso,
          subjectId: breach.subjectId,
          node: nodeId,
        });
      } catch (err) {
        // Context, not evidence. A failure to compute it must not lose the alert.
        console.warn(`[alerts] could not measure unshipped events for ${rule.id}: ${err.message}`);
        unshipped = -1;
      }

      const alert = rules.buildAlert({
        rule,
        scopeId,
        subjectId: breach.subjectId,
        value: breach.value,
        windowStartMs: windowStart,
        firedBy: rules.FIRED_BY_NODE,
        nodeId,
        firedAt: new Date(atMs).toISOString(),
        detail: {
          unshippedInWindow: unshipped,
          outboxPending: safeOutboxPending(nodeId),
          match: rule.match,
        },
      });

      let isNew;
      try {
        isNew = store.recordAlert(alert);
      } catch (err) {
        stats.errors += 1;
        console.error(`[alerts] could not record ${alert.key}: ${err.message}`);
        continue;
      }
      if (!isNew) { stats.deduped += 1; continue; }

      stats.fired += 1;
      fired.push(alert);
      console.warn(
        `[alerts] ${alert.severity.toUpperCase()} ${rule.id}: subject ${alert.subjectId} reached`,
        `${alert.value} (threshold ${alert.threshold}) in ${windowStartIso}..${windowEndIso} on node ${nodeId}.`,
        unshipped > 0
          ? `${unshipped} of those events are still queued — central cannot see this yet.`
          : 'Central has received these events.'
      );
    }
  }

  lastRunAt = atMs;
  // Firing and shipping are separate acts, and the hook is called after the rows are durable: an
  // alert that exists locally but has not reached central is a correct state (that is what a
  // partitioned node looks like), whereas one that was posted but never recorded is not.
  if (fired.length && onFired) {
    try { onFired(fired); } catch (err) { console.error('[alerts] fire hook failed:', err.message); }
  }
  return fired;
}

/** The queue depth, as context on an alert. Wrapped because it is decoration: a store without an
 *  outbox enabled (no central configured) answers zero, and a throw here must not cost the alert. */
function safeOutboxPending(nodeId) {
  try { return store.usageOutboxStats(nodeId).pending; } catch { return null; }
}

/** Coalesce a burst of events into one evaluation. `urgent` — the denied / destructive / consent
 *  set §2.3 already singles out — skips the wait, since those are the events the rules are about. */
function schedule({ urgent = false } = {}) {
  if (!store) return;
  if (debounceTimer) return;
  const sinceLast = Date.now() - lastRunAt;
  const wait = urgent
    ? Math.max(0, MIN_INTERVAL_MS - sinceLast)
    : Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - sinceLast);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runGuarded();
  }, wait);
  if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
}

function runGuarded() {
  if (running) return;
  running = true;
  try {
    evaluateNow();
    // Every cycle, not only the ones that fired. This is what retries delivery of an alert that was
    // recorded while central was unreachable: the node that fired it has nothing else that would
    // notice the link came back, and the alert would otherwise sit `syncedAt IS NULL` forever on
    // the one machine that already knows about it.
    if (afterSweep) {
      try { afterSweep(); } catch (err) { console.error('[alerts] post-sweep hook failed:', err.message); }
    }
  } catch (err) {
    stats.errors += 1;
    // A throw from anywhere in a cycle must not kill the timer, or one bad cycle ends alerting for
    // the lifetime of the process — the same guard the usage shipper's drain has.
    console.error('[alerts] evaluation cycle failed:', err.stack || err.message);
  } finally {
    running = false;
  }
}

/**
 * Start the node-local engine.
 *
 * Unlike the usage shipper this runs whether or not a central is configured, and that is the point:
 * a machine with no central at all is the limit case of the partitioned machine, and it is the one
 * where a local alert is the only alert there will ever be.
 */
function startNodeAlertEngine(storeModule, { ruleSet, onFired: fireHook, afterSweep: sweepHook } = {}) {
  if (sweepTimer) return sweepTimer;
  const loaded = rules.loadRules(ruleSet);
  for (const skip of loaded.skipped) {
    // Once, at start, not per cycle: a bad rule is a static fact about the build, and repeating it
    // every minute would bury the alerts this engine exists to surface.
    console.error(`[alerts] rule skipped — ${skip.reason}`);
  }
  active = loaded.rules.filter((r) => r.scope === rules.NODE);
  const deferred = loaded.rules.length - active.length;
  if (!active.length) {
    console.log(`[alerts] no node-scoped rules to evaluate (${deferred} fleet-scoped rule(s) are central's).`);
    return null;
  }

  store = storeModule;
  onFired = typeof fireHook === 'function' ? fireHook : null;
  afterSweep = typeof sweepHook === 'function' ? sweepHook : null;
  store.onUsageEvent((_row, meta) => schedule({ urgent: meta && meta.urgent }));

  console.log(
    `[alerts] node-local engine watching ${active.length} rule(s) (${active.map((r) => r.id).join(', ')})`,
    `on node ${store.nodeId()}; ${deferred} fleet-scoped rule(s) are evaluated centrally.`
  );

  // Immediately: a node that was mid-burst when the process restarted has the events on disk and
  // an open window, and waiting a minute to look at them would lose the alert to the cooldown of a
  // window that has since slid past. Same reasoning as the shipper's catch-up tick.
  setImmediate(runGuarded);
  sweepTimer = setInterval(runGuarded, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref(); // background upkeep must not hold the process open
  return sweepTimer;
}

function stopNodeAlertEngine() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  sweepTimer = null;
  debounceTimer = null;
  if (store) store.onUsageEvent(null);
  store = null;
  active = [];
  onFired = null;
  afterSweep = null;
  lastRunAt = 0;
  running = false;
}

/** What the engine has done since start. `deduped` and `suppressed` are the two numbers that say
 *  the two-ended design is working: the first is breaches central had already reported, the second
 *  is adjacent windows of one continuing breach. Both being zero on a busy fleet means one of the
 *  two mechanisms is not wired up. */
function nodeAlertStats() {
  return { ...stats, rules: active.map((r) => r.id), running: Boolean(sweepTimer) };
}

module.exports = {
  startNodeAlertEngine,
  stopNodeAlertEngine,
  evaluateNow,
  nodeAlertStats,
  DEBOUNCE_MS,
  MIN_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
};
