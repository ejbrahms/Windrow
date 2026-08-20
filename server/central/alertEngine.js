'use strict';
// The central end of docs/design/global-identity-and-central-db.md §2.3, "Evaluate alerts at both
// ends": "central catches 'this user is on five PCs and the total crossed the threshold'."
//
// WHAT ONLY THIS END CAN DO. Every node holds one machine's stream. A subject who runs eight
// denied calls on each of five PCs has run forty, and no node has seen more than eight — so a rule
// with a threshold of twenty-five is unreachable from any node, at any time, no matter how well it
// is working. That is not a latency argument or a redundancy argument; the aggregate is the only
// place the number exists.
//
// WHAT THIS END ALSO DOES, WHICH IS NOT OBVIOUS. It evaluates NODE-scoped rules too, over each
// node's own rows. That looks redundant — the node evaluates them itself and ships what it fired —
// and it is the backstop for the case that redundancy is for: a node whose service was stopped,
// whose disk filled, or which was rebuilt between the burst and the alert never evaluated anything,
// while its events shipped normally and are sitting right here. The cost of doing it anyway is
// nothing, because it lands on the same key: when the node did its job, central's insert is a
// no-op. See the header of ../alerts/rules.js.
//
// THE DIRECTION THAT DOES NOT WORK is central-only. §2.3's whole node-local case is a partitioned
// machine, and a partitioned machine's events are not here to count.
//
// WHY IT IS A TIMER AND NOT AN INGEST HOOK. Evaluating on every ingested batch would mean a fleet
// of N nodes running the aggregate query N times per shipping interval to produce, almost always,
// nothing — and doing it on the connection the ingest transaction is holding. The window is snapped
// to a stride of minutes (../alerts/rules.js), so an evaluation more often than once per stride
// cannot produce a key the previous one would not have produced.

const rules = require('../alerts/rules');
const { requireDriver } = require('./store');

// One sweep per interval. The default is a minute, which is the shortest stride any shipped rule
// uses; a sweep faster than the stride re-derives keys that already exist, and one slower than the
// stride can skip a window entirely — so this and the rules' strides are one number expressed
// twice, and a rule with a shorter stride than this is a rule whose windows go unevaluated.
const SWEEP_INTERVAL_MS = Number(process.env.WINDROW_CENTRAL_ALERT_SWEEP_MS) || 60_000;

let timer = null;
let active = [];
const stats = { sweeps: 0, fired: 0, deduped: 0, suppressed: 0, errors: 0 };

/** Central filters on ITS OWN `observedAt`, never on the node-supplied `ts` and never on the node's
 *  own observedAt — §2.3's note, "trust node clocks for nothing", and the same reason
 *  ./centralMigrations.js partitions on this column: a node that back-dates its events would
 *  otherwise slide a burst out of every window that would have caught it, on every machine in the
 *  fleet at once. The node engine makes the same choice against its own clock, which is why the two
 *  can disagree by the shipping lag — and why `peerValue` exists to record it when they do. */
const TIME_COLUMN = 'e."observedAt"';

/** The subject fallback, letter for letter the same as the node's `ALERT_SUBJECT_SQL` in
 *  ../store.js. If these two ever drift, the same rows are grouped under two different subjects and
 *  a breach that crosses a threshold in the aggregate crosses it in neither half. */
const SUBJECT_SQL = `COALESCE(NULLIF(e."subjectId", ''), 'principal:' || e."principalId", 'unknown')`;

/** A rule's `match` as a WHERE fragment. Mirrors ../store.js's `alertMatchSql` — same filters, same
 *  INNER join for the capability-borne ones (an event whose capability was deleted has no tier, and
 *  counting it as a match would fire a destructive-tier rule on ordinary calls). */
function matchSql(rule, nextParam) {
  const where = [];
  const params = [];
  let i = nextParam;
  for (const [filter, value] of Object.entries(rule.match || {})) {
    if (filter === 'outcome') { where.push(`e.outcome = $${i++}`); params.push(value); continue; }
    if (filter === 'capabilityId') { where.push(`e."capabilityId" = $${i++}`); params.push(value); continue; }
    if (filter === 'riskTier') { where.push(`c."riskTier" = $${i++}`); params.push(value); continue; }
    if (filter === 'capabilityKind') { where.push(`c.kind = $${i++}`); params.push(value); continue; }
    throw new Error(`alert rule ${rule.id}: no SQL for match filter "${filter}"`);
  }
  const needsCapability = where.some((w) => w.startsWith('c.'));
  return {
    join: needsCapability ? 'JOIN capabilities c ON c.id = e."capabilityId"' : '',
    where: where.length ? ` AND ${where.join(' AND ')}` : '',
    params,
    nextParam: i,
  };
}

function metricSql(rule) {
  if (rule.metric === 'distinctCapabilities') return 'COUNT(DISTINCT e."capabilityId")';
  if (rule.metric === 'distinctNodes') return 'COUNT(DISTINCT e."nodeId")';
  return 'COUNT(*)';
}

/**
 * Every (scope, subject) that breaches `rule` in the window.
 *
 * Fleet-scoped rules group by subject alone — one row per subject across the whole fleet, which is
 * §2.3's "on five PCs and the total crossed the threshold". Node-scoped rules group by node AND
 * subject, so each machine's burst is counted, keyed and reported separately, matching exactly what
 * that node would have computed for itself.
 */
async function breachesFor(rule, windowStartIso, windowEndIso) {
  const d = requireDriver();
  const m = matchSql(rule, 3);
  const nodeScoped = rule.scope === rules.NODE;
  const groupCols = nodeScoped ? `e."nodeId" AS "scopeId", ${SUBJECT_SQL} AS "subjectId"` : `${SUBJECT_SQL} AS "subjectId"`;
  const groupBy = nodeScoped ? `e."nodeId", ${SUBJECT_SQL}` : SUBJECT_SQL;
  const sql = `
    SELECT ${groupCols}, ${metricSql(rule)}::double precision AS value
    FROM usage_events e
    ${m.join}
    WHERE ${TIME_COLUMN} >= $1 AND ${TIME_COLUMN} < $2${m.where}
    GROUP BY ${groupBy}
    HAVING ${metricSql(rule)} >= $${m.nextParam}
    ORDER BY value DESC`;
  return d.all(sql, [windowStartIso, windowEndIso, ...m.params, rule.threshold]);
}

/** When (rule, scope, subject) last fired here, for the cooldown. Reads the same table both ends
 *  write, so an alert a NODE fired also holds central's cooldown down — which is the intent: the
 *  breach has already been reported once, and by whom does not change that. */
async function lastFiredAt(ruleId, scopeId, subjectId) {
  const d = requireDriver();
  const row = await d.get(
    'SELECT "firedAt" FROM alerts WHERE "ruleId" = $1 AND "scopeId" = $2 AND "subjectId" = $3 ORDER BY "firedAt" DESC LIMIT 1',
    [ruleId, scopeId, subjectId]
  );
  return row ? row.firedAt : null;
}

/**
 * Insert one alert, or record that the other end got there first.
 *
 * THE ONE PLACE §2.3'S "fires once" IS ENFORCED CENTRALLY, and the shape is deliberate: the insert
 * is attempted unconditionally and the conflict is the answer. A SELECT-then-INSERT would leave a
 * window between the two in which a node's POST /api/ingest/alerts lands, and both writers would
 * believe they were first — which is precisely the double-report the key exists to prevent, made
 * rare enough to escape every test and still happen in production.
 *
 * On conflict the existing row is NOT overwritten. It keeps the first observation, because being
 * told about a burst is only useful at the earliest moment anyone knew. The loser's count is
 * recorded in `peerValue` instead: two ends disagreeing about one window is shipping lag, and the
 * size of that gap is a real number about how far behind the aggregate is. Discarding it would make
 * the disagreement permanently invisible. `peerValue` is only filled if it is still null, so the
 * first peer to arrive is kept and a redelivery cannot churn it.
 *
 * Returns `{ inserted, peer }`.
 */
async function upsertAlert(alert, { now = new Date() } = {}) {
  const d = requireDriver();
  const inserted = await d.all(
    `INSERT INTO alerts
       (key, "ruleId", scope, "scopeId", "subjectId", "windowStart", "windowEnd", "windowMs",
        metric, threshold, value, severity, title, "firedBy", "nodeId", "firedAt", "recordedAt", detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [
      alert.key, alert.ruleId, alert.scope, alert.scopeId, alert.subjectId,
      alert.windowStart, alert.windowEnd, alert.windowMs, alert.metric, alert.threshold,
      alert.value, alert.severity, alert.title, alert.firedBy, alert.nodeId,
      alert.firedAt || now.toISOString(), now.toISOString(),
      alert.detail == null ? null : alert.detail,
    ]
  );
  if (inserted.length) return { inserted: true, peer: false };

  await d.query(
    `UPDATE alerts
        SET "peerFiredBy" = $2, "peerValue" = $3, "peerSeenAt" = $4
      WHERE key = $1 AND "peerValue" IS NULL AND "firedBy" <> $2`,
    [alert.key, alert.firedBy, alert.value, now.toISOString()]
  );
  return { inserted: false, peer: true };
}

/**
 * Ingest a batch of alerts a node fired locally — the handler behind POST /api/ingest/alerts.
 *
 * `authenticatedNodeId` comes from the client certificate, and it OVERRIDES what the body claims,
 * with one refusal: a node-scoped alert whose `scopeId` names a different machine is rejected
 * outright rather than rewritten. Rewriting would silently re-attribute someone else's burst to the
 * poster; accepting it as-is would let any enrolled node forge an alert against any other, which is
 * the same forgery §2.5's per-node credentials exist to prevent, arriving through a smaller door.
 */
async function ingestNodeAlerts(payload, { authenticatedNodeId = null, now = new Date() } = {}) {
  const list = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  const result = { accepted: 0, duplicates: 0, rejected: [] };
  for (const raw of list) {
    const alert = normalizeIncoming(raw, authenticatedNodeId);
    if (!alert.ok) { result.rejected.push({ key: raw && raw.key, reason: alert.reason }); continue; }
    try {
      const { inserted } = await upsertAlert(alert.value, { now });
      if (inserted) result.accepted += 1;
      else result.duplicates += 1;
    } catch (err) {
      result.rejected.push({ key: alert.value.key, reason: err.message });
    }
  }
  return result;
}

/**
 * Check one incoming alert. Strict where the node cannot be trusted, tolerant everywhere else —
 * §2.6's rule that an old node must keep reporting to a new central applies here too, so an unknown
 * field is ignored rather than fatal.
 */
function normalizeIncoming(raw, authenticatedNodeId) {
  const bad = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object') return bad('alert is not an object');
  if (typeof raw.key !== 'string' || !raw.key) return bad('alert has no key');
  if (typeof raw.ruleId !== 'string' || !raw.ruleId) return bad('alert has no ruleId');
  if (!rules.SCOPES.has(raw.scope)) return bad(`unknown scope "${raw.scope}"`);
  const value = Number(raw.value);
  const threshold = Number(raw.threshold);
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return bad('alert has no numeric value/threshold');
  if (!raw.windowStart || !raw.windowEnd) return bad('alert has no window');

  const nodeId = authenticatedNodeId || raw.nodeId || null;
  if (raw.scope === rules.NODE) {
    if (!nodeId) return bad('node-scoped alert names no node');
    if (authenticatedNodeId && raw.scopeId && raw.scopeId !== authenticatedNodeId) {
      return bad(
        `node-scoped alert claims scope ${raw.scopeId} but was presented by node ${authenticatedNodeId} `
        + '— a node may only fire alerts about itself'
      );
    }
  }

  // The key is RECOMPUTED rather than trusted. It is the primary key of a table two writers race
  // on, so a node that computed it differently — an older build, a different rule list, or one
  // deliberately shifting a character — would land on a key central's own evaluation never
  // produces, and the breach would be reported twice rather than once. Recomputing means the node
  // supplies the observation and central supplies the identity.
  const scopeId = raw.scope === rules.NODE ? nodeId : rules.FLEET;
  const windowStart = new Date(raw.windowStart).toISOString();
  const key = rules.alertKey({ ruleId: raw.ruleId, scopeId, subjectId: raw.subjectId, windowStart });

  return {
    ok: true,
    value: {
      key,
      ruleId: raw.ruleId,
      scope: raw.scope,
      scopeId,
      subjectId: raw.subjectId == null || raw.subjectId === '' ? rules.UNKNOWN_SUBJECT : String(raw.subjectId),
      windowStart,
      windowEnd: new Date(raw.windowEnd).toISOString(),
      windowMs: Number(raw.windowMs) || (Date.parse(raw.windowEnd) - Date.parse(raw.windowStart)),
      metric: raw.metric || 'count',
      threshold,
      value,
      severity: rules.SEVERITIES.has(raw.severity) ? raw.severity : 'warning',
      title: raw.title || raw.ruleId,
      // Always 'node' for anything arriving here, whatever the body says: this endpoint is the node
      // channel by definition, and a body claiming 'central' would make the row lie about which end
      // detected the breach.
      firedBy: rules.FIRED_BY_NODE,
      nodeId,
      firedAt: raw.firedAt ? new Date(raw.firedAt).toISOString() : null,
      detail: typeof raw.detail === 'string' ? raw.detail : raw.detail == null ? null : JSON.stringify(raw.detail),
    },
  };
}

/** One sweep: every rule the engine was started with, against the window that is open now. */
async function sweep(atMs = Date.now()) {
  return sweepWith(active, atMs);
}

/** The same sweep against an explicit rule list — the seam ./alerts-smoke.js drives, so a test can
 *  use thresholds of its own instead of whichever numbers the shipped rules currently carry.
 *
 *  Returns the alerts CENTRAL FIRED FIRST — not the ones a node had already reported, which is the
 *  number that would make a deduped design look like it was firing twice. */
async function sweepWith(ruleList, atMs = Date.now()) {
  if (!ruleList || !ruleList.length) return [];
  stats.sweeps += 1;
  const fired = [];
  const now = new Date(atMs);

  for (const rule of ruleList) {
    const { windowStart, windowEnd } = rules.windowFor(rule, atMs);
    const windowStartIso = rules.windowKey(windowStart);
    const windowEndIso = rules.windowKey(windowEnd);
    let breaches;
    try {
      breaches = await breachesFor(rule, windowStartIso, windowEndIso);
    } catch (err) {
      // One rule failing must not end the sweep — the same reasoning as the node engine's per-rule
      // catch, and it matters more here because one bad rule would otherwise silence alerting for
      // an entire fleet rather than one PC.
      stats.errors += 1;
      console.error(`[central-alerts] rule ${rule.id} could not be evaluated: ${err.message}`);
      continue;
    }

    for (const breach of breaches) {
      const scopeId = rule.scope === rules.NODE ? breach.scopeId : rules.FLEET;
      if (rule.cooldownMs > 0) {
        const last = await lastFiredAt(rule.id, scopeId, breach.subjectId);
        if (last && atMs - new Date(last).getTime() < rule.cooldownMs) { stats.suppressed += 1; continue; }
      }

      const alert = rules.buildAlert({
        rule,
        scopeId,
        subjectId: breach.subjectId,
        value: breach.value,
        windowStartMs: windowStart,
        firedBy: rules.FIRED_BY_CENTRAL,
        nodeId: rule.scope === rules.NODE ? breach.scopeId : null,
        firedAt: now.toISOString(),
        detail: { match: rule.match, evaluatedOver: 'central aggregate' },
      });

      try {
        const { inserted } = await upsertAlert(alert, { now });
        if (!inserted) { stats.deduped += 1; continue; }
      } catch (err) {
        stats.errors += 1;
        console.error(`[central-alerts] could not record ${alert.key}: ${err.message}`);
        continue;
      }

      stats.fired += 1;
      fired.push(alert);
      console.warn(
        `[central-alerts] ${alert.severity.toUpperCase()} ${rule.id}: subject ${alert.subjectId} reached`,
        `${alert.value} (threshold ${alert.threshold}) in ${windowStartIso}..${windowEndIso}`,
        rule.scope === rules.NODE ? `on node ${scopeId} — the node itself did not report this.` : 'across the fleet.'
      );
    }
  }
  return fired;
}

/** Start the central sweep. Runs every rule, both scopes — see the header for why node-scoped rules
 *  are evaluated here as well as on the node. */
function startCentralAlertEngine({ ruleSet } = {}) {
  if (timer) return timer;
  const loaded = rules.loadRules(ruleSet);
  for (const skip of loaded.skipped) console.error(`[central-alerts] rule skipped — ${skip.reason}`);
  active = loaded.rules;
  if (!active.length) {
    console.log('[central-alerts] no rules to evaluate.');
    return null;
  }
  // A stride shorter than the sweep means windows this engine never looks at, which is a rule that
  // is enabled and silently unevaluated — the worst state for an alert to be in, so it is said out
  // loud rather than left to be inferred from an alert that never arrives.
  const tooFast = active.filter((r) => r.strideMs < SWEEP_INTERVAL_MS);
  if (tooFast.length) {
    console.warn(
      `[central-alerts] ${tooFast.map((r) => r.id).join(', ')} have a stride shorter than the ${SWEEP_INTERVAL_MS / 1000}s sweep`,
      '— some of their windows will not be evaluated centrally. Lower WINDROW_CENTRAL_ALERT_SWEEP_MS or raise the stride.'
    );
  }

  console.log(
    `[central-alerts] evaluating ${active.length} rule(s) over the fleet aggregate every ${SWEEP_INTERVAL_MS / 1000}s`,
    `(${active.map((r) => `${r.id}/${r.scope}`).join(', ')}).`
  );

  const run = () => sweep().catch((err) => {
    stats.errors += 1;
    console.error('[central-alerts] sweep failed:', err.stack || err.message);
  });
  setImmediate(run);
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopCentralAlertEngine() {
  if (timer) clearInterval(timer);
  timer = null;
  active = [];
}

/** Recent alerts, whichever end fired them. */
async function listAlerts({ limit = 100, since = null, severity = null, ruleId = null, nodeId = null, subjectId = null } = {}) {
  const d = requireDriver();
  const where = [];
  const params = [];
  const add = (frag, value) => { params.push(value); where.push(frag.replace('$?', `$${params.length}`)); };
  if (since) add('"firedAt" >= $?', since);
  if (severity) add('severity = $?', severity);
  if (ruleId) add('"ruleId" = $?', ruleId);
  if (nodeId) add('"nodeId" = $?', nodeId);
  if (subjectId) add('"subjectId" = $?', subjectId);
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  return d.all(
    `SELECT * FROM alerts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY "firedAt" DESC LIMIT $${params.length}`,
    params
  );
}

function centralAlertStats() {
  return { ...stats, rules: active.map((r) => ({ id: r.id, scope: r.scope })), running: Boolean(timer) };
}

module.exports = {
  startCentralAlertEngine,
  stopCentralAlertEngine,
  sweep,
  sweepWith,
  ingestNodeAlerts,
  normalizeIncoming,
  upsertAlert,
  listAlerts,
  centralAlertStats,
  SWEEP_INTERVAL_MS,
};
