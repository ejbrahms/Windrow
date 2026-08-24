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
      -- Hook integrity, beside lastSeen where docs/design/dashboard-placement.md item 2 puts it:
      -- "is governance actually wired on that box" is a property of the roster row, not a second
      -- page. hookReportedAt travels with the status because a status nobody has refreshed for a
      -- week is not the same claim as one refreshed a minute ago, and on the status alone the two
      -- are indistinguishable.
      n."hookStatus",
      n."hookInstalledCount",
      n."hookInstallableCount",
      n."hookBrokenCount",
      n."hookTamperCount",
      n."hookLastTamperAt",
      n."hookReportedAt",
      n."nativeLastSeenAt",
      -- Which lifetime is shipping, and how many there have been. On a long-lived node
      -- incarnationCount is 1 forever and says nothing; on a disposable one it is the most
      -- operationally interesting number about that machine, because "this node has been rebuilt
      -- eleven times this week" is a question nobody could ask while every rebuild arrived as a
      -- different node (docs/design/dashboard-placement.md item 5).
      n."lastIncarnation",
      n."incarnationCount",
      n."lastIncarnationAt",
      -- LOCAL DIVERGENCE — docs/design/disposable-nodes.md §5. The two levers a node holds that
      -- widen what it allows, and until migration 9 there were zero columns anywhere at central
      -- that could show either. "enforcing" is the one to read: false means a node-minted pause is
      -- overriding real denials on that box right now.
      --
      -- The pause is filtered by its OWN expiry rather than trusted as reported, because a node
      -- that stops reporting stops clearing it: a machine that went offline mid-pause would
      -- otherwise sit on this list forever, which is exactly how an operator learns to ignore it.
      (n."pauseUntil" IS NOT NULL AND n."pauseUntil" > $1::timestamptz) AS "paused",
      CASE WHEN n."pauseUntil" > $1::timestamptz THEN n."pauseId" END AS "pauseId",
      CASE WHEN n."pauseUntil" > $1::timestamptz THEN n."pauseUntil" END AS "pauseUntil",
      CASE WHEN n."pauseUntil" > $1::timestamptz THEN n."pauseTiers" END AS "pauseTiers",
      CASE WHEN n."pauseUntil" > $1::timestamptz THEN n."pauseReason" END AS "pauseReason",
      CASE WHEN n."leaseUntil" > $1::timestamptz THEN n."leaseUntil" END AS "leaseUntil",
      CASE WHEN n."leaseUntil" > $1::timestamptz THEN n."leaseTiers" END AS "leaseTiers",
      -- §2.2's year fuse. "credentialNotAfter" on the roster is what turns "a node fell out of the
      -- fleet last Tuesday" into "three nodes will fall out next month unless something renews".
      n."credentialState",
      n."credentialNotAfter",
      n."journalEntries",
      n."journalLastAt",
      n.profile,
      n."factsReportedAt",
      -- ::BIGINT, and it is not cosmetic. EXTRACT(EPOCH …) returns numeric, and ./pgDriver.js
      -- registers a parser for BIGINT and nothing else — so without the cast this arrives in
      -- JavaScript as a STRING while every other number in this file arrives as a number. A caller
      -- doing silentForMs > threshold then compares a string to a number and silently gets the
      -- wrong answer; the fleet UI's first render of this route showed every node as "never seen"
      -- for exactly that reason. Cast at the source so there is one shape, not a cast per reader.
      (EXTRACT(EPOCH FROM ($1::timestamptz - n."lastSeenAt")) * 1000)::BIGINT AS "silentForMs",
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

/**
 * A HUMAN-READABLE LABEL FOR AN ID, and the rule for where one may come from.
 *
 * `pr_408b2603f1c1` and `cap_ad28cccf412a` are correct, stable and unreadable. A dashboard showing
 * them is technically honest and operationally useless — nobody knows which agent or which tool
 * that is. But resolving them has a trap, and this expression is shaped around it.
 *
 * THE KEY STAYS THE ID. §1.1: usage is grouped on `principalId`, never on a display name. A name is
 * mutable — an OS account is renamed, a loom is re-nicknamed — and grouping on one silently merges
 * two agents or splits one. So the id remains the grouping key and the label rides beside it.
 *
 * THE LABEL FALLS BACK, IN A DELIBERATE ORDER:
 *
 *   1. the registry row's name, when central holds it. Authoritative and current.
 *   2. what the EVENT recorded at call time — `actorLoomId`, the agent instance the hook saw. It is
 *      a snapshot on the row itself and is the reason this works at all on a fleet whose catalog
 *      central has not been given: the node denormalised it precisely so a label would survive
 *      without a join. Note `usage_events` carries no `actorHumanName` — that column exists only on
 *      `native_tool_events`, so a person's nickname is reachable here only through the registry.
 *   3. nothing, and the caller shows the id. An absent label must never be invented.
 *
 * Central's `principals`/`capabilities` are LEFT JOINed for the same reason: on a deployment where
 * the catalog was never seeded upward, an inner join would delete every row from this answer rather
 * than costing it a name. Losing the usage numbers to gain a label would be a bad trade.
 */
async function usageBy(driver, dimension, { sinceMs = 24 * 3600 * 1000, now = new Date(), limit = 50 } = {}) {
  if (!GROUPABLE.has(dimension)) {
    throw new Error(`cannot group usage by "${dimension}" — known dimensions: ${[...GROUPABLE].sort().join(', ')}`);
  }
  const since = new Date(now.getTime() - sinceMs).toISOString();
  // Only two dimensions are opaque ids needing resolution; the rest — outcome, hostname, the
  // actor* columns — are already the readable thing. A label column is still returned for every
  // dimension so the caller has one shape to render rather than a special case per dimension.
  const label = {
    principalId: `COALESCE(MAX(p."humanName"), MAX(p.name), MAX(e."actorLoomId"))`,
    capabilityId: `MAX(c.name)`,
    // A subject is a person, and its id is an OS security identifier — `win-sid:S-1-5-21-2963…`,
    // which is stable, correct and completely unreadable. `s.name` is the registry's label for that
    // person; `osUser` is the account the call actually ran as, recorded on the event itself, and
    // is the fallback that works on a fleet whose registry central was never given. Joined through
    // `principals.subjectId` rather than `principals.id` because a subject row is keyed on the SID.
    subjectId: `COALESCE(MAX(s.name), MAX(e."osUser"))`,
  }[dimension] || 'NULL';
  return driver.all(`
    SELECT COALESCE(e."${dimension}", '(unrecorded)') AS key,
           ${label} AS label,
           COUNT(*)::BIGINT AS calls,
           COUNT(*) FILTER (WHERE e.outcome = 'denied')::BIGINT AS denied,
           AVG(e."latencyMs")::NUMERIC(12,2) AS "avgLatencyMs",
           MAX(e."observedAt") AS "lastSeenAt"
    FROM usage_events e
    LEFT JOIN principals p ON p.id = e."principalId"
    LEFT JOIN capabilities c ON c.id = e."capabilityId"
    LEFT JOIN principals s ON s."subjectId" = e."subjectId"
    WHERE e."observedAt" >= $1
    GROUP BY 1
    ORDER BY calls DESC
    LIMIT $2
  `, [since, Math.min(Math.max(Number(limit) || 50, 1), 1000)]);
}

/** The most recent events, for the dashboard's live tail. */
/**
 * The live tail. Every column of the event, plus two resolved labels.
 *
 * `principalLabel` and `capabilityLabel` are ADDED, never substituted — the raw `principalId` and
 * `capabilityId` stay on the row untouched, because the id is what a reader copies into a query and
 * what every other view keys on. A tail that replaced the id with a name would be unusable for the
 * one thing a tail is for: taking a suspicious row and going to look it up.
 *
 * Null when central cannot resolve it and the event carried no snapshot of its own, so the client
 * shows the id rather than a fabricated name. See `usageBy` above for the full fallback order.
 */
async function recentEvents(driver, { limit = 100, nodeId = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const scope = nodeId ? 'WHERE e."nodeId" = $2' : '';
  const args = nodeId ? [capped, nodeId] : [capped];
  return driver.all(`
    SELECT e.*,
           COALESCE(p."humanName", p.name, e."actorLoomId") AS "principalLabel",
           c.name AS "capabilityLabel"
    FROM usage_events e
    LEFT JOIN principals p ON p.id = e."principalId"
    LEFT JOIN capabilities c ON c.id = e."capabilityId"
    ${scope}
    ORDER BY e."observedAt" DESC LIMIT $1
  `, args);
}

/**
 * Quarantined ingest packets — docs/design/ingest-data-resilience.md, the inspect half of the
 * dead-letter queue. Packets central could not store, kept verbatim with the reason and the batch
 * trace id, so "which node keeps sending garbage, and what does it look like" is a query rather
 * than a grep through a response body nobody saved.
 *
 * Defaults to `quarantined` only — the ones still awaiting a decision. Pass `status: 'all'` for the
 * full history including replayed and discarded rows.
 */
async function deadLetters(driver, { limit = 100, nodeId = null, status = 'quarantined', traceId = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const where = [];
  const args = [];
  if (nodeId) { args.push(nodeId); where.push(`"nodeId" = $${args.length}`); }
  if (traceId) { args.push(traceId); where.push(`"traceId" = $${args.length}`); }
  if (status && status !== 'all') { args.push(status); where.push(`"status" = $${args.length}`); }
  args.push(capped);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await driver.all(`
    SELECT "id", "nodeId", "certSubject", "traceId", "kind", "reason", "eventId", "seq",
           "payload", "firstSeenAt", "lastSeenAt", "occurrences", "status", "replayedAt", "replayResult"
    FROM ingest_dead_letter
    ${clause}
    ORDER BY "lastSeenAt" DESC LIMIT $${args.length}
  `, args);
  // The by-status tallies a dashboard leads with, so "are there any quarantined right now" is one
  // number rather than a count over the page it happened to fetch.
  const totals = await driver.all('SELECT "status", COUNT(*)::INT AS "count" FROM ingest_dead_letter GROUP BY "status"');
  const byStatus = {};
  for (const t of totals) byStatus[t.status] = t.count;
  return { rows, byStatus };
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
  // PARTITIONED BY INCARNATION — docs/design/dashboard-placement.md item 5.
  //
  // The shipment counter restarts when a node is rebuilt, so a fleet of disposable nodes would
  // otherwise produce a "gap" at every rebuild: shipments 1..900, then 1..40, read as one sequence
  // says 859 shipments went missing. Every one of those reports would be false, and a gap report
  // that is usually false is one nobody reads — which matters, because a real gap means audit
  // central will never receive.
  //
  // Density was always a claim about ONE WRITER's output, and a writer is a lifetime rather than a
  // machine. The window partition is that claim written down.
  const gaps = await driver.all(`
    SELECT incarnation, prev + 1 AS "from", seq - 1 AS "to", (seq - prev - 1)::BIGINT AS missing
    FROM (
      SELECT incarnation, seq, LAG(seq) OVER (PARTITION BY incarnation ORDER BY seq) AS prev
      FROM (SELECT DISTINCT "incarnation" AS incarnation, seq FROM usage_shipments WHERE "nodeId" = $1) s
    ) w
    WHERE prev IS NOT NULL AND seq > prev + 1
    ORDER BY incarnation, "from"
    LIMIT 100
  `, [nodeId]);
  const lifetimes = await driver.get(
    'SELECT COUNT(DISTINCT "incarnation")::BIGINT AS n FROM usage_shipments WHERE "nodeId" = $1',
    [nodeId]
  );
  return { nodeId, ...ledger, ...events, gaps, incarnations: Number((lifetimes && lifetimes.n) || 0) };
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
  // ONE CHAIN PER LIFETIME — docs/design/dashboard-placement.md item 5.
  //
  // A node's identity is now stable across a rebuild, which is what ended the ghost roster. Its
  // CHAIN is not, and must not be: a rebuilt node has an empty database, so it starts again at seq
  // 1 with a null prevHash. Walked as one sequence that is indistinguishable from a spliced log —
  // and it would happen on every single rebuild, so the detector would spend its whole life
  // reporting tampering that never occurred. An alarm that always rings gets switched off, and
  // then the real one is missed too.
  //
  // COALESCE to a single legacy bucket rather than treating NULL as its own value: a node
  // predating incarnations ships none, and NULLs compare unequal in the ORDER BY, which would
  // scatter one real chain across as many groups as it has rows.
  const rows = await driver.all(`
    SELECT COALESCE("incarnation", 'inc_0') AS incarnation, "seq", "prevHash", "hash", "id"
    FROM usage_events WHERE "nodeId" = $1 AND "seq" IS NOT NULL
    ORDER BY incarnation ASC, "seq" ASC LIMIT $2
  `, [nodeId, limit]);

  const breaks = [];
  const heads = [];
  let runStart = 0;
  for (let i = 0; i <= rows.length; i += 1) {
    const endOfRun = i === rows.length || rows[i].incarnation !== rows[runStart].incarnation;
    if (!endOfRun) continue;
    const run = rows.slice(runStart, i);
    for (let j = 1; j < run.length; j += 1) {
      // Number() rather than trusting the driver: ./pgDriver.js makes BIGINT come back as a
      // number, and this comparison is the one place where being handed a string instead would
      // fail silently in the wrong direction — "2" !== "11" reports a break in a chain that has
      // none, so an intact stream would alarm and nobody would keep reading the alarms.
      if (Number(run[j].seq) !== Number(run[j - 1].seq) + 1) {
        breaks.push({
          incarnation: run[j].incarnation, at: run[j].seq, kind: 'missing',
          detail: `seq jumps from ${run[j - 1].seq}`,
        });
        continue; // a hole makes the next prevHash comparison meaningless, not a second fault
      }
      if (run[j].prevHash !== run[j - 1].hash) {
        breaks.push({
          incarnation: run[j].incarnation, at: run[j].seq, kind: 'unlinked',
          detail: `prevHash does not match seq ${run[j - 1].seq}`,
        });
      }
    }
    if (run.length) {
      const tail = run[run.length - 1];
      heads.push({ incarnation: tail.incarnation, seq: tail.seq, hash: tail.hash });
    }
    if (i < rows.length) runStart = i;
  }

  return {
    nodeId,
    checked: rows.length,
    ok: breaks.length === 0,
    breaks: breaks.slice(0, 50),
    breakCount: breaks.length,
    // Every lifetime's tip, and the newest one flattened into `head` so the readers that predate
    // incarnations — ./shadow-compare.js, `reconcile` below — keep working unchanged.
    heads,
    incarnations: heads.length,
    head: heads.length ? { seq: heads[heads.length - 1].seq, hash: heads[heads.length - 1].hash } : null,
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
  // Every partitioned table, not just usage_events. Since docs/design/dashboard-placement.md item
  // 1 there are two, and the second is the larger by one to two orders of magnitude — a storage
  // panel that reported only the audit log would understate central's disk by most of it.
  const tables = {};
  for (const parent of partitions.PARTITIONED) {
    const rows = await partitions.listPartitions(driver, parent);
    tables[parent] = {
      partitions: rows,
      defaultPartitionRows: await partitions.defaultPartitionRows(driver, parent),
      totalBytes: rows.reduce((a, p) => a + Number(p.bytes || 0), 0),
    };
  }
  return {
    // The original three keys, unchanged and still usage_events: this route already has readers,
    // and moving them under `tables` would break those to no purpose.
    partitions: parts,
    defaultPartitionRows: stranded,
    totalBytes: parts.reduce((a, p) => a + Number(p.bytes || 0), 0),
    tables,
    fleetTotalBytes: Object.values(tables).reduce((a, t) => a + t.totalBytes, 0),
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

/**
 * Native tool observations over a window — docs/design/dashboard-placement.md item 1's read side.
 *
 * Windowed on `observedAt`, central's own clock and the partition key, for `fleetSummary`'s reason:
 * it prunes partitions, and it is a question central can answer without trusting N node clocks.
 *
 * THE TOTALS ARE NOT COMPARABLE WITH `fleetSummary`'S AND THE SHAPE SAYS SO. Nothing here is named
 * `calls` or `events` — the keys are `observations` and `observed`, because a native observation is
 * a sighting and a usage event is a decision, and a dashboard that put the two totals side by side
 * under one heading would be inviting exactly the arithmetic the separate table exists to prevent.
 */
async function nativeSummary(driver, { sinceMs = 24 * 3600 * 1000, now = new Date(), nodeId = null, limit = 20 } = {}) {
  const since = new Date(now.getTime() - sinceMs).toISOString();
  const scope = nodeId ? 'AND "nodeId" = $2' : '';
  const args = nodeId ? [since, nodeId] : [since];
  const totals = await driver.get(`
    SELECT
      COUNT(*)::BIGINT                                                    AS observations,
      COUNT(DISTINCT "nodeId")::BIGINT                                    AS nodes,
      COUNT(DISTINCT "principalId")::BIGINT                               AS principals,
      COUNT(*) FILTER (WHERE "outcome" = 'error')::BIGINT                 AS errors,
      COUNT(*) FILTER (WHERE "outcome" = 'denied')::BIGINT                AS denied,
      MIN("observedAt")                                                   AS "observedFrom",
      MAX("observedAt")                                                   AS "observedTo"
    FROM native_tool_events WHERE "observedAt" >= $1 ${scope}
  `, args);
  const byTool = await driver.all(`
    SELECT "toolName",
           COUNT(*)::BIGINT                                       AS observations,
           COUNT(*) FILTER (WHERE "outcome" = 'error')::BIGINT    AS errors,
           COUNT(*) FILTER (WHERE "outcome" = 'denied')::BIGINT   AS denied
    FROM native_tool_events WHERE "observedAt" >= $1 ${scope}
    GROUP BY "toolName" ORDER BY observations DESC LIMIT ${boundedLimit(limit)}
  `, args);
  const byNode = await driver.all(`
    SELECT "nodeId", COUNT(*)::BIGINT AS observations, MAX("observedAt") AS "lastObservedAt"
    FROM native_tool_events WHERE "observedAt" >= $1 ${scope}
    GROUP BY "nodeId" ORDER BY observations DESC LIMIT ${boundedLimit(limit)}
  `, args);
  // humanName before the loom id, for the reason server/store.js gives on the node's own version
  // of this rollup: an instance principal's name IS its loom id, so grouping by it alone produces
  // a list of `claude-mt05yzju-46`s on exactly the card whose question is "who has been busy".
  const byPrincipal = await driver.all(`
    SELECT COALESCE("principalId", 'unattributed')                      AS "principalId",
           COALESCE(MAX("actorHumanName"), MAX("actorLoomId"))          AS name,
           COUNT(*)::BIGINT                                             AS observations
    FROM native_tool_events WHERE "observedAt" >= $1 ${scope}
    GROUP BY 1 ORDER BY observations DESC LIMIT ${boundedLimit(limit)}
  `, args);
  return { since, nodeId, ...totals, byTool, byNode, byPrincipal };
}

/**
 * Native observations per time bucket — the fleet-wide calls-over-time series.
 *
 * WHY THIS EXISTS SEPARATELY FROM `nativeSummary`. The node has had this chart since native
 * observability shipped: `GET /api/native-calls/timeseries` on server/app.js, drawn by
 * client/src/components/NativeCallsChart.tsx. When docs/design/dashboard-placement.md item 4 took
 * the dashboard off the node, that chart lost the only host that could render it — and item 1's
 * read side never grew a bucketed series, so there was nothing at central to draw instead. The
 * chart was stranded rather than deleted. This is the missing half.
 *
 * THE SHAPE IS THE NODE'S, DELIBERATELY: `{ bucket, calls, errors, denied }`, zero-filled, bucket
 * boundaries aligned in UTC. The chart component already consumes exactly that, so restoring the
 * fleet version is a data source rather than a second chart — and two implementations of "calls
 * over time" that drew subtly different pictures would be worse than none.
 *
 * BUCKETED ON `observedAt`, central's own clock and the partition key. `ts` is what the node
 * claimed and §2.3 trusts node clocks for nothing — a machine with a skewed clock would otherwise
 * smear its calls across the wrong hours of everyone else's chart, or park them in a bucket
 * nobody looks at. `date_trunc` also lets the planner prune partitions, which on the largest table
 * here is the difference between an index scan and a fleet-wide seq scan.
 */
async function nativeSeries(driver, { granularity = 'hour', windowMinutes = null, now = new Date(), nodeId = null, toolName = null } = {}) {
  const grain = granularity === 'minute' ? 'minute' : 'hour';
  const bucketMinutes = grain === 'minute' ? 1 : 60;
  // The node's own ceiling, for the node's own reason: a window wide enough to need thousands of
  // buckets is a chart nobody can read and a response nobody should have to stream.
  const MAX_BUCKETS = 400;
  const requested = Number(windowMinutes);
  const wanted = Number.isFinite(requested) && requested > 0
    ? requested
    : (grain === 'minute' ? 120 : 24 * 60);
  const span = Math.min(wanted, bucketMinutes * MAX_BUCKETS);

  // Align to bucket boundaries so the newest column is the bucket in progress rather than a
  // partial one starting wherever the request happened to land — an unaligned tail always reads
  // as a drop in activity that is not there. Same reasoning as the node route's.
  const bucketMs = bucketMinutes * 60_000;
  const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil(span / bucketMinutes) * bucketMs;

  const filters = ['"observedAt" >= $1', '"observedAt" < $2'];
  const args = [new Date(start).toISOString(), new Date(end).toISOString()];
  if (nodeId) { args.push(nodeId); filters.push(`"nodeId" = $${args.length}`); }
  if (toolName) { args.push(toolName); filters.push(`"toolName" = $${args.length}`); }

  const rows = await driver.all(`
    SELECT date_trunc('${grain}', "observedAt") AS bucket,
           COUNT(*)::BIGINT                                      AS calls,
           COUNT(*) FILTER (WHERE "outcome" = 'error')::BIGINT   AS errors,
           COUNT(*) FILTER (WHERE "outcome" = 'denied')::BIGINT  AS denied
    FROM native_tool_events
    WHERE ${filters.join(' AND ')}
    GROUP BY 1 ORDER BY 1 ASC
  `, args);

  // Zero-fill. SQL returns only the buckets that have rows, and a chart drawn from those alone
  // connects a busy hour straight to the next busy one and hides the quiet stretch between — which
  // on an observability chart is the difference between "nothing happened" and "we stopped
  // recording", the two readings this whole feature exists to tell apart.
  const counts = new Map();
  for (const r of rows) counts.set(new Date(r.bucket).toISOString(), r);
  const byBucket = [];
  for (let t = start; t < end; t += bucketMs) {
    const key = new Date(t).toISOString();
    const r = counts.get(key);
    byBucket.push({
      bucket: key,
      calls: Number((r && r.calls) || 0),
      errors: Number((r && r.errors) || 0),
      denied: Number((r && r.denied) || 0),
    });
  }
  return { byBucket, granularity: grain, windowMinutes: span, bucketMinutes, nodeId, toolName };
}

/**
 * Governed decisions per time bucket — the fleet-wide calls-over-time series, and the latency
 * breakdown over the same buckets. The events page's chart and its latency insights read this.
 *
 * WHY THIS EXISTS SEPARATELY FROM `fleetSummary`. The summary is a handful of window totals a page
 * loads once; this is up to 400 buckets a chart re-fetches whenever the granularity changes. Same
 * split, and for the same reason, as `nativeSeries` beside `nativeSummary` — folding it into the
 * summary would make every page load pay for a series most callers are not looking at.
 *
 * IT IS THE NODE'S `UsageBucket` SHAPE, DELIBERATELY: `{ bucket, calls, denied, avgLatencyMs, and
 * the four phase averages }`, zero-filled on the counts and NULL-filled on the averages, boundaries
 * aligned in UTC. `client/src/components/LineChart.tsx` and `LatencyBreakdownChart.tsx` already
 * consume exactly that off the node's `/api/usage/summary` — so this is a data source for two
 * charts that already exist, not two more charts that would draw the same thing differently. This
 * is the governed-decision twin of `nativeSeries`: usage is a decision, a native call is a sighting
 * (§2.6), and the two series must never be summed — which is why they are two routes, not one.
 *
 * NULL, NOT 0, ON THE AVERAGES. An empty bucket has no latency, and a phase an older build never
 * recorded is absent rather than instantaneous — both are `null` so the chart leaves a gap instead
 * of drawing a misleading dip to zero. `AVG` over no non-null rows already returns NULL; the
 * zero-fill below only has to preserve that for buckets SQL returned no row for at all.
 *
 * BUCKETED ON `observedAt`, central's own clock and the partition key — `fleetSummary`'s reasoning:
 * `ts` is the node's claim and §2.3 trusts node clocks for nothing, so a skewed machine would
 * otherwise smear its decisions across everyone else's hours, and `date_trunc` on the partition key
 * lets the planner prune rather than scan the whole audit log.
 */
async function usageSeries(driver, { granularity = 'hour', windowMinutes = null, now = new Date(), nodeId = null } = {}) {
  const grain = granularity === 'minute' ? 'minute' : 'hour';
  const bucketMinutes = grain === 'minute' ? 1 : 60;
  // The same 400-bucket ceiling `nativeSeries` uses: a window wide enough to need thousands of
  // buckets is a chart nobody can read and a response nobody should stream.
  const MAX_BUCKETS = 400;
  const requested = Number(windowMinutes);
  const wanted = Number.isFinite(requested) && requested > 0
    ? requested
    : (grain === 'minute' ? 120 : 24 * 60);
  const span = Math.min(wanted, bucketMinutes * MAX_BUCKETS);

  // Align to bucket boundaries so the newest column is the bucket in progress rather than a partial
  // one starting wherever the request landed — an unaligned tail always reads as a drop that is not
  // there. Same reasoning as `nativeSeries`.
  const bucketMs = bucketMinutes * 60_000;
  const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
  const start = end - Math.ceil(span / bucketMinutes) * bucketMs;

  const filters = ['"observedAt" >= $1', '"observedAt" < $2'];
  const args = [new Date(start).toISOString(), new Date(end).toISOString()];
  if (nodeId) { args.push(nodeId); filters.push(`"nodeId" = $${args.length}`); }

  const rows = await driver.all(`
    SELECT date_trunc('${grain}', "observedAt")               AS bucket,
           COUNT(*)::BIGINT                                    AS calls,
           COUNT(*) FILTER (WHERE outcome = 'denied')::BIGINT  AS denied,
           AVG("latencyMs")::NUMERIC(12,2)                     AS "avgLatencyMs",
           AVG("capabilityLookupMs")::NUMERIC(12,2)            AS "avgCapabilityLookupMs",
           AVG("principalResolveMs")::NUMERIC(12,2)            AS "avgPrincipalResolveMs",
           AVG("brokerMs")::NUMERIC(12,2)                      AS "avgBrokerMs",
           AVG("grantCheckMs")::NUMERIC(12,2)                  AS "avgGrantCheckMs"
    FROM usage_events
    WHERE ${filters.join(' AND ')}
    GROUP BY 1 ORDER BY 1 ASC
  `, args);

  // Zero-fill the counts, NULL-fill the averages. SQL returns only the buckets that have rows, and
  // a chart drawn from those alone connects a busy hour straight to the next and hides the quiet
  // stretch between — the difference between "nothing happened" and "we stopped recording".
  const byKey = new Map();
  for (const r of rows) byKey.set(new Date(r.bucket).toISOString(), r);
  // `::NUMERIC` comes back a string through ./pgDriver.js (it parses BIGINT alone), so coerce here
  // rather than hand the client a `"12.34"` where it types a number — the same `num()` fix every
  // reader in client/src/api/fleet.ts applies, done once at the source.
  const avg = (v) => (v === null || v === undefined ? null : Number(v));
  const byBucket = [];
  for (let t = start; t < end; t += bucketMs) {
    const key = new Date(t).toISOString();
    const r = byKey.get(key);
    byBucket.push({
      bucket: key,
      calls: Number((r && r.calls) || 0),
      denied: Number((r && r.denied) || 0),
      avgLatencyMs: r ? avg(r.avgLatencyMs) : null,
      avgCapabilityLookupMs: r ? avg(r.avgCapabilityLookupMs) : null,
      avgPrincipalResolveMs: r ? avg(r.avgPrincipalResolveMs) : null,
      avgBrokerMs: r ? avg(r.avgBrokerMs) : null,
      avgGrantCheckMs: r ? avg(r.avgGrantCheckMs) : null,
    });
  }
  return { byBucket, granularity: grain, windowMinutes: span, bucketMinutes, nodeId };
}

/** A literal, not a bind, because it is a LIMIT — and therefore clamped here rather than trusted.
 *  This is the one table where an unbounded group-by is genuinely dangerous: it holds a row per
 *  file read, fleet-wide. */
function boundedLimit(limit) {
  return Math.min(Math.max(Number(limit) || 20, 1), 200);
}

/**
 * Hook integrity across the fleet — item 2's read side, and the query the whole item exists for.
 *
 * `hookReportedAt` is central's arrival clock and `hookCheckedAt` is the node's own claim, and both
 * come back: a node that stopped reporting looks identical to a healthy one on `hookStatus` alone,
 * which would be the worst possible failure mode for a check whose subject is "has governance been
 * switched off on that machine".
 */
async function hookIntegrity(driver, { onlyUnhealthy = false, now = new Date() } = {}) {
  const filter = onlyUnhealthy
    ? `WHERE "hookStatus" IS DISTINCT FROM 'installed'`
    : '';
  return driver.all(`
    SELECT "nodeId", hostname, "osUser", "hookStatus", "hookInstalledCount", "hookInstallableCount",
           "hookBrokenCount", "hookTamperCount", "hookLastTamperAt", "hookCheckedAt",
           "hookReportedAt", "hookDetail",
           -- ::BIGINT for the reason nodeRoster's silentForMs is cast: EXTRACT returns numeric,
           -- pgDriver parses only BIGINT, and an age that arrives as a string is an age every
           -- comparison against it gets wrong.
           (EXTRACT(EPOCH FROM ($1::timestamptz - "hookReportedAt")) * 1000)::BIGINT AS "reportAgeMs"
    FROM nodes
    ${filter}
    ORDER BY ("hookStatus" = 'installed'), "hookReportedAt" DESC NULLS FIRST
  `, [now.toISOString()]);
}

/**
 * THE SHORT LIST — every node that is currently not enforcing, or is degraded, or is about to lose
 * its credential. docs/design/disposable-nodes.md §5 and §2.2.
 *
 * One query rather than three, because the operator's question is one question: "which of my
 * machines is not doing what I think it is doing right now". `reason` says which of the three it
 * is, so the caller renders a list rather than three lists that have to be merged.
 */
async function fleetDivergence(driver, { now = new Date(), expiringWithinDays = 30 } = {}) {
  const rows = await driver.all(`
    SELECT
      n."nodeId",
      n.label,
      n."lastSeenAt",
      n."pauseId",
      n."pauseUntil",
      n."pauseTiers",
      n."pauseReason",
      n."pauseIssuedBy",
      n."leaseUntil",
      n."leaseTiers",
      n."credentialState",
      n."credentialNotAfter",
      n."journalEntries",
      n."journalLastAt",
      (n."pauseUntil" IS NOT NULL AND n."pauseUntil" > $1::timestamptz) AS "paused",
      (n."leaseUntil" IS NOT NULL AND n."leaseUntil" > $1::timestamptz) AS "leased",
      (n."credentialNotAfter" IS NOT NULL
        AND n."credentialNotAfter" < $1::timestamptz + ($2 || ' days')::interval) AS "credentialAtRisk",
      -- How many entries this node has shipped that a pause suppressed. THE number §5 is about:
      -- a pause is invisible while it runs, because nothing fails, so the count of what it let
      -- through is the only evidence it ever happened.
      (SELECT COUNT(*)::BIGINT FROM node_fault_journal j
        WHERE j."nodeId" = n."nodeId" AND j."pauseId" IS NOT NULL) AS "suppressedDenials"
    FROM nodes n
    WHERE (n."pauseUntil" IS NOT NULL AND n."pauseUntil" > $1::timestamptz)
       OR (n."leaseUntil" IS NOT NULL AND n."leaseUntil" > $1::timestamptz)
       OR (n."credentialNotAfter" IS NOT NULL
           AND n."credentialNotAfter" < $1::timestamptz + ($2 || ' days')::interval)
       OR n."credentialState" IN ('expired', 'unreadable')
    ORDER BY n."pauseUntil" DESC NULLS LAST, n."credentialNotAfter" ASC NULLS LAST
  `, [now.toISOString(), String(expiringWithinDays)]);
  return {
    now: now.toISOString(),
    nodes: rows.map((r) => ({
      ...r,
      reasons: [
        r.paused ? 'enforcement-paused' : null,
        r.leased ? 'grace-lease' : null,
        r.credentialState === 'expired' ? 'credential-expired'
          : (r.credentialAtRisk ? 'credential-expiring' : null),
        r.credentialState === 'unreadable' ? 'credential-unreadable' : null,
      ].filter(Boolean),
    })),
  };
}

/**
 * One node's fault journal — what it decided while it could not reach us, and what a pause let
 * through. docs/design/disposable-nodes.md §3: this file used to exist in exactly one copy, on the
 * machine, and a `docker rm` took it with the machine.
 *
 * Newest first, capped, and `pauseId` narrows it to a single window.
 */
async function nodeFaultJournal(driver, nodeId, { pauseId = null, limit = 200 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const rows = await driver.all(`
    SELECT "id", "ts", "receivedAt", "fault", "denialKind", "tier", "capability", "principalId",
           "outcome", "why", "pauseId", "policyAgeMs", "policyVersion", "raw"
    FROM node_fault_journal
    WHERE "nodeId" = $1
      AND ($2::text IS NULL OR "pauseId" = $2)
    ORDER BY "ts" DESC NULLS LAST, "receivedAt" DESC
    LIMIT $3
  `, [nodeId, pauseId, capped]);
  const totals = await driver.get(`
    SELECT COUNT(*)::BIGINT AS "total",
           COUNT(*) FILTER (WHERE "pauseId" IS NOT NULL)::BIGINT AS "suppressed",
           MIN("ts") AS "oldest",
           MAX("ts") AS "newest"
    FROM node_fault_journal WHERE "nodeId" = $1
  `, [nodeId]);
  return { nodeId, pauseId, entries: rows, ...(totals || {}) };
}

/**
 * WHAT IS TRUE ABOUT ONE BOX — docs/design/disposable-nodes.md §6's machine-fact tier, and §3's
 * record of what a rebuild would otherwise silently lose.
 *
 * Central records these and never pushes them back; the node is authoritative for this tier. What
 * this endpoint is FOR is the moment after a rebuild, when somebody needs to know which discovery
 * sources the old machine had that the defaults do not reproduce, and which adapters it had ever
 * turned on — the two things §3 measures as unrecoverable by a rescan.
 */
async function nodeFacts(driver, nodeId) {
  const row = await driver.get(
    `SELECT "nodeId", label, profile, "facts", "factsReportedAt", "lastSeenAt",
            "credentialState", "credentialNotAfter"
       FROM nodes WHERE "nodeId" = $1`,
    [nodeId]
  );
  if (!row) return { nodeId, facts: null, factsReportedAt: null };
  return row;
}

/**
 * WHICH INTEGRATIONS EACH BOX ACTUALLY RUNS — the per-node half of the fleet integrations view.
 *
 * The fleet-wide decision (enable Gmail for everyone) is a central `package_state` row that becomes
 * grants and replicates; that is what ./packages.js reports. This is the OTHER axis: what each node
 * itself last said its `packages_enabled` was, shipped up in the machine-facts tier
 * (server/nodeHealth.js `machineFacts`, docs/design/disposable-nodes.md §6). Central records it and
 * never pushes it back — the node is authoritative for this tier — so a node whose local toggle
 * disagrees with the fleet decision is real drift worth seeing, not an error to hide.
 *
 * Returns one row per node that has ever reported facts, each carrying its raw `packagesEnabled`
 * map. The route resolves an absent key against the package's own default rather than guessing here,
 * because "no row" means "this node uses the package default", which only the package defs know.
 */
async function integrationAdoption(driver) {
  const rows = await driver.all(
    `SELECT "nodeId", label, "facts", "factsReportedAt", "lastSeenAt"
       FROM nodes
      WHERE "facts" IS NOT NULL
      ORDER BY "nodeId"`
  );
  return rows.map((r) => {
    // node-postgres parses JSONB to an object (../central/pgDriver.js overrides only the BIGINT
    // parser), but a facts blob written by an unfamiliar path could arrive as text — parse
    // defensively rather than let one malformed row throw the whole roster.
    let facts = r.facts;
    if (typeof facts === 'string') {
      try { facts = JSON.parse(facts); } catch { facts = null; }
    }
    const enabled = facts && typeof facts.packagesEnabled === 'object' && facts.packagesEnabled
      ? facts.packagesEnabled
      : {};
    return {
      nodeId: r.nodeId,
      label: r.label ?? null,
      packagesEnabled: enabled,
      factsReportedAt: r.factsReportedAt ?? null,
      lastSeenAt: r.lastSeenAt ?? null,
    };
  });
}

module.exports = {
  nodeRoster,
  fleetDivergence,
  nodeFaultJournal,
  nodeFacts,
  integrationAdoption,
  nativeSummary,
  nativeSeries,
  usageSeries,
  hookIntegrity,
  rollup,
  fleetSummary,
  usageBy,
  recentEvents,
  deadLetters,
  nodeStream,
  verifyNodeChain,
  reconcile,
  reconciliationHistory,
  shadowStatus,
  storage,
  GROUPABLE,
};
