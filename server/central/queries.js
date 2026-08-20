'use strict';

// What central is FOR, in phase 3: the fleet view, and the comparison that says whether it can be
// believed. docs/design/global-identity-and-central-db.md §2.7 — "a real fleet dashboard at zero
// risk".
//
// Everything here is a read except `recordReconciliation`, and that one writes only central's own
// ledger of comparisons. Nothing in this file can influence a decision on any node.
//
// WHY THE COMPARISON IS THE FEATURE. It would be easy to read "shadow mode" as "central quietly
// collects things", ship the dashboard, and call the phase done. But the dashboard is the *reward*
// for shadow mode; the *point* of it is arriving at phase 4 able to say how often central's copy
// of the fleet's usage matched each node's own, and how far behind it ran when it did not. §2.8
// lists "central becomes a fleet-wide single point of failure" as the risk phase 3 exists to
// retire, and the only thing that retires it is a measured record.
//
// FOUR VERDICTS, and the distinction between them is the whole value:
//
//   match      central holds exactly what the node holds, and the node's queue is empty.
//   lagging    central is behind, and the node's own outbox explains the difference. Normal — the
//              shipper runs on a 5-second timer. Not a fault.
//   gap        central is missing shipments the node no longer has to give. Permanent data loss in
//              central's copy, and the shipper says when it causes one (an over-long outbox
//              trimmed). This is the number that must stay at zero for phase 4 to be safe.
//   divergent  central and the node hold a different number of events for the same shipments, or
//              disagree about the node's chain head. Nothing routine produces this. It means one
//              of the two copies has been written by something other than this pipeline.

const partitions = require('./partitions');

/** One row per node central has heard from, with how stale each is. The fleet roster. */
async function nodeRoster(driver, { now = new Date() } = {}) {
  return driver.all(`
    SELECT
      n."nodeId",
      n.hostname,
      n."osUser",
      n."certSubject",
      n."firstSeenAt",
      n."lastSeenAt",
      n."lastSeq",
      n."eventCount",
      n."lastClockSkewMs",
      EXTRACT(EPOCH FROM ($1::timestamptz - n."lastSeenAt")) * 1000 AS "silentForMs",
      (SELECT COUNT(*)::BIGINT FROM usage_shipments s WHERE s."nodeId" = n."nodeId") AS "shipmentCount"
    FROM nodes n
    ORDER BY n."lastSeenAt" DESC
  `, [now.toISOString()]);
}

/**
 * The headline numbers, over a window.
 *
 * The window is on `observedAt` — central's clock, the partition key — and not on `ts`, so it is
 * both index-friendly (partition pruning does the work) and honest: "what did central see in the
 * last 24 hours" is a question central can answer, where "what happened in the last 24 hours"
 * depends on N node clocks §2.3 says to trust for nothing.
 */
async function fleetSummary(driver, { sinceMs = 24 * 3600 * 1000, now = new Date() } = {}) {
  const since = new Date(now.getTime() - sinceMs).toISOString();
  const totals = await driver.get(`
    SELECT
      COUNT(*)::BIGINT                                                   AS events,
      COUNT(DISTINCT "nodeId")::BIGINT                                   AS nodes,
      COUNT(DISTINCT "principalId")::BIGINT                              AS principals,
      COUNT(DISTINCT "subjectId")::BIGINT                                AS subjects,
      COUNT(DISTINCT "capabilityId")::BIGINT                             AS capabilities,
      COUNT(*) FILTER (WHERE outcome = 'denied')::BIGINT                 AS denied,
      COUNT(*) FILTER (WHERE outcome = 'error')::BIGINT                  AS errored,
      COUNT(*) FILTER (WHERE outcome = 'approved')::BIGINT               AS approved,
      -- §2.6: a field an unfamiliar build did not send reads as "not recorded", never as a value.
      -- So the count of rows with no outcome at all is reported rather than folded into 'ok' —
      -- a fleet-wide skew showing up as healthy traffic is the exact failure that column comment
      -- exists to prevent.
      COUNT(*) FILTER (WHERE outcome IS NULL)::BIGINT                    AS "outcomeUnrecorded",
      COUNT(*) FILTER (WHERE extra IS NOT NULL)::BIGINT                  AS "withUnknownFields",
      AVG("latencyMs")::NUMERIC(12,2)                                    AS "avgLatencyMs",
      MAX(ABS("clockSkewMs"))::BIGINT                                    AS "worstClockSkewMs"
    FROM usage_events
    WHERE "observedAt" >= $1
  `, [since]);
  const byOutcome = await driver.all(`
    SELECT COALESCE(outcome, '(unrecorded)') AS outcome, COUNT(*)::BIGINT AS n
    FROM usage_events WHERE "observedAt" >= $1 GROUP BY 1 ORDER BY n DESC
  `, [since]);
  const byNode = await driver.all(`
    SELECT "nodeId", COUNT(*)::BIGINT AS n,
           COUNT(*) FILTER (WHERE outcome = 'denied')::BIGINT AS denied
    FROM usage_events WHERE "observedAt" >= $1 GROUP BY 1 ORDER BY n DESC
  `, [since]);
  return { since, totals, byOutcome, byNode };
}

/**
 * Usage grouped by whichever dimension the caller asks for.
 *
 * The allow-list is not paranoia about SQL injection alone — it is Part 1's model made explicit.
 * `subjectId` is the person, `principalId` is the registry row, and the four `actor*` columns are
 * the agent as a *dimension of the call*, snapshotted at call time rather than looked up through a
 * mutable principal row. Offering exactly these is what makes "usage by human" and "usage by
 * backend" the same query rather than two hand-written ones that drift.
 */
const GROUPABLE = new Set([
  'nodeId', 'principalId', 'subjectId', 'capabilityId', 'outcome',
  'actorAgentType', 'actorBackend', 'actorField', 'actorLoomId', 'hostname', 'osUser',
]);

async function usageBy(driver, dimension, { sinceMs = 24 * 3600 * 1000, now = new Date(), limit = 50 } = {}) {
  if (!GROUPABLE.has(dimension)) {
    throw new Error(`cannot group usage by "${dimension}" — known dimensions: ${[...GROUPABLE].sort().join(', ')}`);
  }
  const since = new Date(now.getTime() - sinceMs).toISOString();
  return driver.all(`
    SELECT COALESCE("${dimension}", '(unrecorded)') AS key,
           COUNT(*)::BIGINT AS calls,
           COUNT(*) FILTER (WHERE outcome = 'denied')::BIGINT AS denied,
           AVG("latencyMs")::NUMERIC(12,2) AS "avgLatencyMs",
           MAX("observedAt") AS "lastSeenAt"
    FROM usage_events
    WHERE "observedAt" >= $1
    GROUP BY 1
    ORDER BY calls DESC
    LIMIT $2
  `, [since, Math.min(Math.max(Number(limit) || 50, 1), 1000)]);
}

/** The most recent events, for the dashboard's live tail. */
async function recentEvents(driver, { limit = 100, nodeId = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  if (nodeId) {
    return driver.all(
      'SELECT * FROM usage_events WHERE "nodeId" = $1 ORDER BY "observedAt" DESC LIMIT $2',
      [nodeId, capped]
    );
  }
  return driver.all('SELECT * FROM usage_events ORDER BY "observedAt" DESC LIMIT $1', [capped]);
}

/**
 * What central holds for one node's stream, including the holes.
 *
 * `gaps` is computed with a window function over the shipment ledger rather than inferred from
 * `MAX(seq) - COUNT(*)`: that subtraction gives the *size* of the loss but never its location, and
 * an operator asked to explain a gap needs to know which shipments went missing and roughly when,
 * so the log around that moment can be read. This is the query that makes the shipper's warning —
 * "central's copy of this node's stream now has a gap" — checkable from central rather than only
 * confessable from the node.
 */
async function nodeStream(driver, nodeId) {
  const ledger = await driver.get(`
    SELECT COUNT(*)::BIGINT AS shipments, MIN(seq)::BIGINT AS "minSeq", MAX(seq)::BIGINT AS "maxSeq",
           MAX("receivedAt") AS "lastReceivedAt"
    FROM usage_shipments WHERE "nodeId" = $1
  `, [nodeId]);
  const events = await driver.get(`
    SELECT COUNT(*)::BIGINT AS events, MAX("seq")::BIGINT AS "maxChainSeq", MAX("observedAt") AS "lastObservedAt"
    FROM usage_events WHERE "nodeId" = $1
  `, [nodeId]);
  const gaps = await driver.all(`
    SELECT prev + 1 AS "from", seq - 1 AS "to", (seq - prev - 1)::BIGINT AS missing
    FROM (
      SELECT seq, LAG(seq) OVER (ORDER BY seq) AS prev
      FROM (SELECT DISTINCT seq FROM usage_shipments WHERE "nodeId" = $1) s
    ) w
    WHERE prev IS NOT NULL AND seq > prev + 1
    ORDER BY "from"
    LIMIT 100
  `, [nodeId]);
  return { nodeId, ...ledger, ...events, gaps };
}

/**
 * Re-verify one node's hash chain from what central received.
 *
 * §2.7 phase 1 made the chain `(nodeId, seq)`, and the reason central can check it at all is that
 * the envelope carries each event's own `seq`/`prevHash`/`hash` — so this reads the shipped stream
 * rather than the order shipments happened to arrive in. It does NOT recompute the hashes: central
 * does not hold the node's canonicalisation, and duplicating it here would be a second
 * implementation free to disagree with the first. It checks *linkage* — that each row's `prevHash`
 * is the previous row's `hash`, and that the sequence is dense — which is what detects a row
 * removed, reordered or inserted in the copy central holds.
 */
async function verifyNodeChain(driver, nodeId, { limit = 100000 } = {}) {
  const rows = await driver.all(`
    SELECT "seq", "prevHash", "hash", "id"
    FROM usage_events WHERE "nodeId" = $1 AND "seq" IS NOT NULL
    ORDER BY "seq" ASC LIMIT $2
  `, [nodeId, limit]);
  const breaks = [];
  for (let i = 1; i < rows.length; i += 1) {
    // Number() rather than trusting the driver: ./pgDriver.js makes BIGINT come back as a number,
    // and this comparison is the one place where being handed a string instead would fail silently
    // in the wrong direction — "2" !== "11" reports a break in a chain that has none, so an intact
    // stream would alarm and nobody would keep reading the alarms.
    if (Number(rows[i].seq) !== Number(rows[i - 1].seq) + 1) {
      breaks.push({ at: rows[i].seq, kind: 'missing', detail: `seq jumps from ${rows[i - 1].seq}` });
      continue; // a hole makes the next prevHash comparison meaningless, not a second fault
    }
    if (rows[i].prevHash !== rows[i - 1].hash) {
      breaks.push({ at: rows[i].seq, kind: 'unlinked', detail: `prevHash does not match seq ${rows[i - 1].seq}` });
    }
  }
  const head = rows.length ? rows[rows.length - 1] : null;
  return {
    nodeId,
    checked: rows.length,
    ok: breaks.length === 0,
    breaks: breaks.slice(0, 50),
    breakCount: breaks.length,
    head: head ? { seq: head.seq, hash: head.hash } : null,
  };
}

/**
 * Compare one node's own account of itself against what central holds, and record the verdict.
 *
 * `report` is what the node said — see scripts/shadow-compare.js, which is the thing that produces
 * it. Central does not go and ask; the node reports, because the node is the authority in this
 * phase and a central that reached into a node to check up on it would be the beginning of the
 * arrangement phase 3 exists to avoid.
 */
async function reconcile(driver, nodeId, report = {}, { now = new Date() } = {}) {
  const stream = await nodeStream(driver, nodeId);
  const chain = await verifyNodeChain(driver, nodeId);

  const nodeEvents = num(report.eventCount);
  const centralEvents = num(stream.events);
  const pending = num(report.outboxPending);
  const behind = nodeEvents === null ? null : nodeEvents - centralEvents;

  let verdict = 'match';
  let detail = 'central holds every event this node has.';

  // ORDER MATTERS, and it is not the order the verdicts are listed in at the top of this file.
  //
  // A shipment that never arrived leaves TWO marks: a hole in the shipment ledger, and — because
  // the chain seq is dense on the node — a hole in the chain reconstructed from what did arrive.
  // They are one fault seen twice. Checking the chain first would report every ordinary trimmed
  // outbox as `divergent`, which is the verdict reserved for "one of these two copies was written
  // by something other than this pipeline" — and burying a real one under a pile of false ones is
  // how a verdict stops being read.
  //
  // So a known gap explains a missing link, and only a break that a gap does NOT explain is
  // divergence. An `unlinked` break is never explained by a gap: it means two rows central holds
  // *adjacently* disagree about what came before, which no amount of lost shipments can produce.
  const unexplained = stream.gaps.length
    ? chain.breaks.filter((b) => b.kind === 'unlinked')
    : chain.breaks;

  if (stream.gaps.length) {
    const missing = stream.gaps.reduce((a, g) => a + Number(g.missing), 0);
    verdict = 'gap';
    detail = `${missing} shipment(s) never arrived, in ${stream.gaps.length} run(s) starting at ${stream.gaps[0].from}. `
      + 'Those events exist on the node and will never reach central — the node trimmed them out of its outbox.';
    if (unexplained.length) {
      verdict = 'divergent';
      detail += ` On top of that, ${unexplained.length} chain link(s) do not match, which a lost shipment cannot cause.`;
    }
  } else if (chain.breakCount > 0) {
    verdict = 'divergent';
    detail = `central's copy of this node's chain has ${chain.breakCount} break(s); first at seq ${chain.breaks[0].at} `
      + `(${chain.breaks[0].kind}), and the shipment ledger is complete — so nothing was lost in transit.`;
  } else if (behind !== null && behind > 0) {
    // Behind, but the node still holds the difference in its queue: that is the 5-second timer,
    // not a fault. Behind by MORE than the queue explains is a fault, and the two are worth
    // telling apart out loud rather than both reading as "lagging".
    verdict = behind <= pending ? 'lagging' : 'divergent';
    detail = behind <= pending
      ? `central is ${behind} event(s) behind, and the node has ${pending} queued — the shipper has not caught up yet.`
      : `central is ${behind} event(s) behind but the node only has ${pending} queued: ${behind - pending} event(s) are unaccounted for.`;
  } else if (behind !== null && behind < 0) {
    verdict = 'divergent';
    detail = `central holds ${-behind} event(s) MORE than the node does. Either the node's database was `
      + 'restored from a backup taken before those events, or two nodes are shipping under one id.';
  } else if (report.chainHash && chain.head && report.chainHash !== chain.head.hash) {
    verdict = 'divergent';
    detail = `the node's chain head hash does not match central's copy at seq ${chain.head.seq}.`;
  }

  await driver.query(`
    INSERT INTO shadow_reconciliations
      ("nodeId", "checkedAt", "nodeEventCount", "nodeChainSeq", "nodeChainHash", "nodeOutboxPending",
       "centralEventCount", "centralMaxSeq", "centralChainHash", "centralShipmentCount", verdict, detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [
    nodeId, now.toISOString(), nodeEvents, num(report.chainSeq), report.chainHash || null, pending,
    centralEvents, num(stream.maxSeq), chain.head ? chain.head.hash : null, num(stream.shipments),
    verdict, detail,
  ]);

  return { nodeId, checkedAt: now.toISOString(), verdict, detail, node: report, central: { ...stream, chain } };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The record phase 4's go/no-go is argued from: how each node's comparisons have run over time. */
async function reconciliationHistory(driver, { nodeId = null, limit = 100 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  if (nodeId) {
    return driver.all(
      'SELECT * FROM shadow_reconciliations WHERE "nodeId" = $1 ORDER BY "checkedAt" DESC LIMIT $2',
      [nodeId, capped]
    );
  }
  return driver.all('SELECT * FROM shadow_reconciliations ORDER BY "checkedAt" DESC LIMIT $1', [capped]);
}

/** The shape a "can we flip authority yet" panel reads: the latest verdict per node, plus how the
 *  verdicts have run. A single `gap` in the window is the thing that says no. */
async function shadowStatus(driver, { sinceMs = 7 * 24 * 3600 * 1000, now = new Date() } = {}) {
  const since = new Date(now.getTime() - sinceMs).toISOString();
  const latest = await driver.all(`
    SELECT DISTINCT ON ("nodeId") "nodeId", "checkedAt", verdict, detail,
           "nodeEventCount", "centralEventCount", "nodeOutboxPending"
    FROM shadow_reconciliations
    ORDER BY "nodeId", "checkedAt" DESC
  `);
  const tally = await driver.all(`
    SELECT verdict, COUNT(*)::BIGINT AS n FROM shadow_reconciliations
    WHERE "checkedAt" >= $1 GROUP BY 1 ORDER BY n DESC
  `, [since]);
  const clean = latest.length > 0 && latest.every((r) => r.verdict === 'match' || r.verdict === 'lagging');
  return {
    since,
    latest,
    tally,
    // Deliberately not a boolean called `ready`: shadow mode measures agreement, and the decision
    // to move authority is a human one that also weighs how long the window is and how many nodes
    // are in it. This says what was measured, not what to do about it.
    everyNodeAgrees: clean,
  };
}

/** Storage, straight off the partition catalogue — the panel that says whether monthly
 *  partitioning is doing its job and whether retention is running. */
async function storage(driver) {
  const parts = await partitions.listPartitions(driver);
  const stranded = await partitions.defaultPartitionRows(driver);
  return {
    partitions: parts,
    defaultPartitionRows: stranded,
    totalBytes: parts.reduce((a, p) => a + Number(p.bytes || 0), 0),
  };
}

/**
 * THE CROSS-FIELD ROLLUP, AS ONE QUERY — §2.7 phase 5.
 *
 * This replaces what `server/rollup/index.js` does by walking every sibling workspace directory
 * under the workspace root and opening each one's `windrow.db` read-only. That scan was the right
 * answer when there was no shared store: no network, no auth surface, no write path. What it could
 * never be is *correct beyond one machine* — it sees the fields whose directories happen to sit
 * next to this one, so a fleet is as many disjoint rollups as it has PCs — and it carried three
 * costs the scan itself made unavoidable:
 *
 *   - N file opens per request, each one a db another server is writing;
 *   - a schema-tolerance layer, because a sibling migrates on its own schedule and this reader can
 *     neither migrate it nor assume its shape;
 *   - de-duplication in JavaScript, because two workspace directories can point at one db.
 *
 * Central has none of those problems by construction. Every node ships into one table whose shape
 * central owns, ingest is idempotent on `(nodeId, seq)` through `usage_shipments`, and the actor
 * columns (§1.2) mean the workspace a call belongs to is a column ON THE EVENT rather than
 * something inferred from which file it was read out of. So `duplicatesSkipped` is absent here
 * rather than zero: it is not a count that came out low, it is a count with nothing to count.
 *
 * WHAT IS DELIBERATELY NOT THE SAME. The scan reports a per-field `fieldPath`/`dbPath` and a
 * `reachable` flag, because it was reading files and a file can be missing. Central knows about
 * events and principals, not about any node's disk, so those are null here and `reachable` is not
 * reported at all — a field that has ever reported is present, and one that has not does not exist
 * as far as the fleet is concerned. The node keeps the local scan as its fallback
 * (server/rollup/index.js) precisely so the disk-level view is still available where it is the only
 * view there is.
 *
 * `sinceMs` is null by default — all time — matching the scan, which had no window. A caller with a
 * large fleet should pass one: the window is on `observedAt`, the partition key, so it is the one
 * filter that prunes rather than scans.
 */
async function rollup(driver, { nodeIds = null, sinceMs = null, now = new Date(), limit = 500 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  // Both filters are built as fragments over one shared parameter list rather than interpolated,
  // and `= ANY($n)` rather than a generated IN-list, so a hundred-node fleet is one plan.
  const params = [];
  const where = [];
  if (sinceMs != null) {
    params.push(new Date(now.getTime() - Number(sinceMs)).toISOString());
    where.push('e."observedAt" >= $' + params.length);
  }
  if (nodeIds && nodeIds.length) {
    params.push([...nodeIds]);
    where.push('e."nodeId" = ANY($' + params.length + '::text[])');
  }
  const eventWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const and = (extra) => (where.length ? 'WHERE ' + where.join(' AND ') + ' AND ' + extra : 'WHERE ' + extra);

  // The event's own `actorField` first, the principal row second — the same precedence the scan
  // applies and for the same reason: `actorField` is what the hook saw at call time, so a principal
  // later back-filled or repointed does not retroactively move its old calls into another workspace.
  const FIELD_OF = 'COALESCE(e."actorField", p."field")';
  const IS_STANDALONE = 'COALESCE(p."standalone", FALSE)';
  const JOIN = 'FROM usage_events e LEFT JOIN principals p ON p."id" = e."principalId"';

  const totals = await driver.get(`
    SELECT
      COUNT(*)::BIGINT                                                 AS calls,
      COUNT(*) FILTER (WHERE e.outcome = 'denied')::BIGINT             AS denied,
      -- An event whose workspace cannot be established at all: no actorField, and either no
      -- principal row or one with no field. The scan hid these by falling back to the directory it
      -- read them from, which named a workspace that had nothing to do with the call. Reported
      -- rather than attributed, so a byField total that does not add up to "calls" says why.
      COUNT(*) FILTER (WHERE NOT ${IS_STANDALONE} AND ${FIELD_OF} IS NULL)::BIGINT
                                                                       AS "unattributedCalls",
      COUNT(*) FILTER (WHERE e."clockSkewMs" IS NOT NULL)::BIGINT      AS "skewSampled",
      MAX(e."clockSkewMs") FILTER (WHERE e."clockSkewMs" >= 0)::BIGINT AS "maxAheadMs",
      MAX(-e."clockSkewMs") FILTER (WHERE e."clockSkewMs" < 0)::BIGINT AS "maxBehindMs",
      MAX(e."ts")                                                      AS "lastEventAt",
      COUNT(DISTINCT e."nodeId")::BIGINT                               AS nodes
    ${JOIN}
    ${eventWhere}
  `, params);

  const byFieldRows = await driver.all(`
    SELECT ${FIELD_OF} AS field,
           COUNT(*)::BIGINT AS calls,
           COUNT(*) FILTER (WHERE e.outcome = 'denied')::BIGINT AS denied,
           MAX(e."ts") AS "lastEventAt",
           COUNT(DISTINCT e."nodeId")::BIGINT AS nodes
    ${JOIN}
    ${and('NOT ' + IS_STANDALONE + ' AND ' + FIELD_OF + ' IS NOT NULL')}
    GROUP BY 1
    ORDER BY calls DESC
    LIMIT ${capped}
  `, params);

  // Registered principals per workspace, from the registry rather than from usage — a workspace
  // with principals and no calls yet is a real workspace, and the scan seeded its buckets the same
  // way. `user` rows are excluded: a subject is a person, not an agent in a workspace (§1.4), and
  // counting one here would inflate every field's number the moment subject rows appear.
  const principalCounts = await driver.all(`
    SELECT "field", COUNT(*)::BIGINT AS "principalCount"
    FROM principals
    WHERE "standalone" = FALSE AND "field" IS NOT NULL AND "kind" <> 'user'
    GROUP BY 1
  `);
  const countByField = new Map(principalCounts.map((r) => [r.field, num(r.principalCount)]));

  const byPrincipalRows = await driver.all(`
    SELECT e."principalId"                                              AS "principalId",
           CASE WHEN ${IS_STANDALONE} THEN NULL ELSE ${FIELD_OF} END    AS field,
           ${IS_STANDALONE}                                             AS standalone,
           -- The nickname is a label; the key is the id. Grouping on a display name merges two
           -- humans who drew the same cast-pack name and splits one across respawns (§1.1).
           MAX(p."humanName")                                           AS "humanName",
           MAX(p."name")                                                AS "agentName",
           CASE WHEN ${IS_STANDALONE}
                THEN COALESCE(MAX(e."actorBackend"), MAX(p."backend"), 'unknown')
                ELSE NULL END                                           AS backend,
           COUNT(*)::BIGINT                                             AS calls,
           COUNT(*) FILTER (WHERE e.outcome = 'denied')::BIGINT         AS denied
    ${JOIN}
    ${eventWhere}
    GROUP BY 1, 2, 3
    ORDER BY calls DESC
    LIMIT ${capped}
  `, params);

  const standaloneRows = await driver.all(`
    SELECT COALESCE(e."actorBackend", p."backend", 'unknown') AS backend,
           COUNT(*)::BIGINT AS calls,
           COUNT(*) FILTER (WHERE e.outcome = 'denied')::BIGINT AS denied
    ${JOIN}
    ${and(IS_STANDALONE)}
    GROUP BY 1
    ORDER BY calls DESC
  `, params);

  const seenFields = new Set(byFieldRows.map((r) => r.field));
  const byField = byFieldRows.map((r) => ({
    field: r.field,
    fieldPath: null,
    calls: num(r.calls),
    denied: num(r.denied),
    principalCount: countByField.get(r.field) || 0,
    lastEventAt: r.lastEventAt || null,
    nodes: num(r.nodes),
  }));
  // A workspace whose principals are registered and whose calls are all still sitting on their
  // node's outbox: present with zero calls rather than invisible until the first shipment lands.
  for (const [field, principalCount] of countByField) {
    if (seenFields.has(field)) continue;
    byField.push({ field, fieldPath: null, calls: 0, denied: 0, principalCount, lastEventAt: null, nodes: 0 });
  }

  const standaloneCalls = standaloneRows.reduce((sum, b) => sum + num(b.calls), 0);
  const standaloneDenied = standaloneRows.reduce((sum, b) => sum + num(b.denied), 0);
  const calls = num(totals && totals.calls);
  const denied = num(totals && totals.denied);

  return {
    source: 'central',
    // Which slice of the fleet this answer covers. Null means every node central has heard from;
    // a list means the caller's certificate scoped it (see server/central/routes.js), and a
    // dashboard that renders "the fleet" from a scoped answer would be claiming more than it read.
    scope: { nodeIds: nodeIds && nodeIds.length ? [...nodeIds] : null },
    since: sinceMs == null ? null : new Date(now.getTime() - Number(sinceMs)).toISOString(),
    totals: {
      calls,
      denied,
      denialRate: calls === 0 ? 0 : denied / calls,
      unattributedCalls: num(totals && totals.unattributedCalls),
      nodes: num(totals && totals.nodes),
      lastEventAt: (totals && totals.lastEventAt) || null,
      // The same three numbers the scan computed in JS from observedAt - ts, read here off the
      // column central already stamps at ingest. A `sampled` small beside `calls` means "not yet
      // measurable" — rows written before that column existed carry only the caller's clock.
      clockSkew: {
        sampled: num(totals && totals.skewSampled),
        maxAheadMs: totals && totals.maxAheadMs != null ? num(totals.maxAheadMs) : null,
        maxBehindMs: totals && totals.maxBehindMs != null ? num(totals.maxBehindMs) : null,
      },
    },
    byField: byField.sort((a, b) => b.calls - a.calls),
    byPrincipal: byPrincipalRows.map((r) => ({
      principalId: r.principalId,
      name: r.humanName || r.agentName || r.principalId,
      agentName: r.agentName || null,
      field: r.field || null,
      standalone: Boolean(r.standalone),
      backend: r.backend || null,
      calls: num(r.calls),
      denied: num(r.denied),
    })),
    standalone: {
      calls: standaloneCalls,
      denied: standaloneDenied,
      byBackend: standaloneRows.map((r) => ({ backend: r.backend, calls: num(r.calls), denied: num(r.denied) })),
    },
  };
}

module.exports = {
  nodeRoster,
  rollup,
  fleetSummary,
  usageBy,
  recentEvents,
  nodeStream,
  verifyNodeChain,
  reconcile,
  reconciliationHistory,
  shadowStatus,
  storage,
  GROUPABLE,
};
