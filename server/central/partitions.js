'use strict';

// Monthly partition maintenance for central's `usage_events` — the operational half of
// docs/design/global-identity-and-central-db.md §2.5's "range-partitioned by month".
//
// Range partitioning is not a thing you declare once. A partitioned table with no partition
// covering a row rejects the INSERT, so "by month" means somebody has to create next month's
// partition before next month. This file is that somebody, and it runs on a timer inside the
// central process rather than as a cron job an operator has to remember, because the failure mode
// of forgetting is a fleet-wide ingest outage — the exact single-point-of-failure §2.8 says must
// never be reachable.
//
// TWO GUARDS, because "runs on a timer" is not a guarantee:
//
//   1. Partitions are created AHEAD, not on demand. `MONTHS_AHEAD` months of empty partitions sit
//      ready at all times, so ingest survives the maintenance loop being down for weeks rather
//      than until midnight on the 1st.
//   2. A DEFAULT partition catches anything that still misses. It should always be empty;
//      `defaultPartitionRows()` is the check that says whether it is, and a non-zero answer is
//      reported as a real number rather than left to be inferred from a quiet log.
//
// A NOTE ON THE DEFAULT PARTITION AND `ATTACH`. Postgres will not attach a new partition whose
// range overlaps rows sitting in the default partition without scanning it — and while that scan
// runs it holds an ACCESS EXCLUSIVE lock on the whole table, which stops ingest. That is only
// reachable if guard 1 already failed, but it is why `ensurePartitions` creates ranges strictly
// ahead of now and why a non-empty default is worth an operator's attention rather than a shrug:
// left alone, it converts a maintenance lapse into a lock-out later.

const PARENT = 'usage_events';
const DEFAULT_PARTITION = 'usage_events_default';

/** How far ahead to keep partitions. Three months is enough that maintenance can be broken for a
 *  full quarter without ingest noticing, and cheap: an empty partition is a catalogue row. */
const MONTHS_AHEAD = 3;

/** UTC, always. A partition boundary in local time would move under a DST change and — worse —
 *  mean two central instances in different time zones disagree about which month a row belongs to.
 *  The rows themselves carry a timestamptz, so nothing is lost by naming the boundaries in UTC. */
function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

/** `usage_events_2026_08`. The name encodes the range, so `\dt` on a psql prompt tells an operator
 *  what they are looking at without joining against pg_partitioned_table. */
function partitionName(monthStartDate) {
  const y = monthStartDate.getUTCFullYear();
  const m = String(monthStartDate.getUTCMonth() + 1).padStart(2, '0');
  return `${PARENT}_${y}_${m}`;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Create every monthly partition from `from` through `MONTHS_AHEAD` months out, skipping ones that
 * exist. Returns the names it actually created.
 *
 * Each `CREATE TABLE … PARTITION OF … FOR VALUES FROM (a) TO (b)` is its own statement rather than
 * one batch: a partition that already exists must not stop the rest from being created, and
 * `IF NOT EXISTS` on `PARTITION OF` gives exactly that per-statement skip.
 *
 * Bounds are `[start, nextMonthStart)` — half-open, which is Postgres's own convention for RANGE
 * and the only one that cannot leave a microsecond of the month belonging to no partition.
 */
async function ensurePartitions(driver, { now = new Date(), monthsAhead = MONTHS_AHEAD, monthsBehind = 1, log = console.log } = {}) {
  const created = [];
  // One month behind as well as ahead: an event can arrive for last month either because a node
  // was offline across the boundary and is draining its outbox now, or because central itself was
  // down when the month turned. Both are ordinary, and both would otherwise land in the default.
  const first = addMonths(monthStart(now), -monthsBehind);
  for (let i = 0; i <= monthsBehind + monthsAhead; i += 1) {
    const start = addMonths(first, i);
    const end = addMonths(start, 1);
    const name = partitionName(start);
    const existed = await driver.get('SELECT to_regclass($1) AS oid', [name]);
    if (existed && existed.oid) continue;
    await driver.exec(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${PARENT}" `
        + `FOR VALUES FROM ('${isoDay(start)}') TO ('${isoDay(end)}')`
    );
    created.push(name);
  }
  if (created.length) log(`[central-db] created usage_events partition(s): ${created.join(', ')}`);
  return created;
}

/** Every partition of usage_events with its range and row estimate, newest first. What a fleet
 *  dashboard's storage panel and an operator's "is retention working" question both read. */
async function listPartitions(driver) {
  return driver.all(`
    SELECT
      c.relname                                   AS name,
      pg_get_expr(c.relpartbound, c.oid)          AS bounds,
      pg_total_relation_size(c.oid)               AS bytes,
      c.reltuples::BIGINT                         AS "estimatedRows"
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = $1
    ORDER BY c.relname DESC
  `, [PARENT]);
}

/**
 * How many rows are sitting in the default partition. Should be zero forever.
 *
 * A real COUNT rather than `reltuples`, deliberately: this is the number that decides whether
 * someone gets paged, and the estimate is stale until an ANALYZE runs — which on a table that is
 * supposed to stay empty may be never. The table is supposed to be empty, so the count is cheap in
 * exactly the case that matters and expensive only when something is already wrong.
 */
async function defaultPartitionRows(driver) {
  const row = await driver.get(`SELECT COUNT(*)::BIGINT AS n FROM "${DEFAULT_PARTITION}"`);
  return Number((row && row.n) || 0);
}

/**
 * Drop partitions entirely older than `retentionMonths`.
 *
 * This is the reason to partition at all rather than to index a timestamp: expiring a month is a
 * `DROP TABLE` on one partition — a catalogue operation that reclaims the space at once — instead
 * of a `DELETE` that writes as much WAL as the rows it removes and leaves the space to a vacuum.
 *
 * Off unless a retention is configured. Central holding usage forever is a defensible default; the
 * indefensible one would be this file deciding for an operator that it should not.
 */
async function dropExpiredPartitions(driver, { retentionMonths, now = new Date(), log = console.log } = {}) {
  if (!retentionMonths || retentionMonths <= 0) return [];
  const cutoff = addMonths(monthStart(now), -retentionMonths);
  const dropped = [];
  for (const p of await listPartitions(driver)) {
    if (p.name === DEFAULT_PARTITION) continue;
    const match = /^usage_events_(\d{4})_(\d{2})$/.exec(p.name);
    if (!match) continue;
    const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    if (start >= cutoff) continue;
    await driver.exec(`DROP TABLE IF EXISTS "${p.name}"`);
    dropped.push(p.name);
  }
  if (dropped.length) {
    log(`[central-db] dropped usage_events partition(s) past ${retentionMonths}-month retention: ${dropped.join(', ')}`);
  }
  return dropped;
}

/**
 * One maintenance pass: create ahead, expire behind, and report a non-empty default.
 *
 * Order matters. Creating before dropping means a pass that fails half way has erred toward having
 * too many partitions rather than too few, and too many is free.
 */
async function runMaintenance(driver, options = {}) {
  const log = options.log || console.log;
  const created = await ensurePartitions(driver, options);
  const dropped = await dropExpiredPartitions(driver, options);
  const stranded = await defaultPartitionRows(driver);
  if (stranded) {
    console.error(
      `[central-db] ${stranded} row(s) are in ${DEFAULT_PARTITION} — a partition was missing when they arrived,`,
      'so partition maintenance had not run for at least a month. The rows are safe and queryable,',
      'but the month they belong to can no longer be attached without an exclusive-lock scan.',
      'Move them with server/central/partitions.js drainDefault() during a quiet window.'
    );
  }
  return { created, dropped, defaultRows: stranded };
}

/**
 * Move rows out of the default partition into the real ones, once those exist.
 *
 * Takes an exclusive lock on the default partition only, not on the parent, so ingest into the
 * current month keeps working while it runs. Deliberately manual: it is a repair for a lapse, and
 * running it automatically would hide how long the lapse lasted.
 */
async function drainDefault(driver, { now = new Date(), log = console.log } = {}) {
  const rows = await defaultPartitionRows(driver);
  if (!rows) return { moved: 0 };
  // Whatever months those rows fall in have to have partitions before the re-insert can land,
  // which is a wider range than the routine one — the rows are, by definition, outside it.
  const span = await driver.get(
    `SELECT MIN("observedAt") AS lo, MAX("observedAt") AS hi FROM "${DEFAULT_PARTITION}"`
  );
  const lo = monthStart(new Date(span.lo));
  const monthsBehind = Math.max(0, Math.round((monthStart(now) - lo) / (30 * 24 * 3600 * 1000)) + 1);
  await ensurePartitions(driver, { now, monthsBehind, log });
  // DELETE … RETURNING feeding an INSERT, in one statement and therefore one transaction: the rows
  // cannot exist in both places and cannot exist in neither.
  const moved = await driver.get(`
    WITH lifted AS (
      DELETE FROM "${DEFAULT_PARTITION}" RETURNING *
    ), replaced AS (
      INSERT INTO "${PARENT}" SELECT * FROM lifted RETURNING 1
    )
    SELECT COUNT(*)::BIGINT AS n FROM replaced
  `);
  const n = Number((moved && moved.n) || 0);
  log(`[central-db] drained ${n} row(s) out of ${DEFAULT_PARTITION} into their months.`);
  return { moved: n };
}

module.exports = {
  PARENT,
  DEFAULT_PARTITION,
  MONTHS_AHEAD,
  partitionName,
  monthStart,
  addMonths,
  ensurePartitions,
  listPartitions,
  defaultPartitionRows,
  dropExpiredPartitions,
  runMaintenance,
  drainDefault,
};
