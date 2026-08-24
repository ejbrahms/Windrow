'use strict';

// The central store — phase 3 of docs/design/global-identity-and-central-db.md §2.7.
//
// WHAT SHADOW MODE MEANS, precisely, because the word is doing a lot of work:
//
//   The node stays authoritative. Nothing in this file is consulted by any allow/deny decision,
//   and there is no code path from here back to a hook. A node whose central is unreachable, or
//   deleted, or lying, enforces exactly as it does today — §2.8's first row, "it is never on the
//   hot path". What central adds is a second copy of the usage stream, a fleet-wide view of it,
//   and a comparison against what each node says it holds. That comparison is the deliverable:
//   phase 4 flips authority, and this phase exists so that flip is made against measured agreement
//   rather than a hope of it.
//
// So this file reads and writes usage, and nothing else. There is no `grants` table here to
// accidentally start believing (see ./centralMigrations.js's header).
//
// WHAT CENTRAL DECIDES AND WHAT IT ONLY RECORDS. Everything a node says about itself is a claim;
// everything about *the receipt of* that claim is central's own. The split is not cosmetic — §2.5
// exists because a fleet-wide shared token would let any node write any other node's stream:
//
//   central decides   observedAt (arrival), clockSkewMs, receivedAt, which node this batch is
//                     from when the connection is authenticated (the certificate CN, not the
//                     envelope's `nodeId`)
//   node claims       everything else, including its own ts, its chain seq/prevHash/hash, and its
//                     own idea of which node it is
//
// A mismatch between the two `nodeId`s is refused rather than reconciled: the whole batch is
// rejected with a 403 naming both. It is the one thing here that fails a request outright, and the
// reason is that the alternative — trusting whichever one you happen to prefer — is the forgery
// the per-node credential was introduced to make impossible.

const crypto = require('crypto');
const { migrateAsync } = require('../schema/migrator');
const { pgDriver, openPool, centralDbConfig } = require('./pgDriver');
const { migrations, EVENT_COLUMN_NAMES } = require('./centralMigrations');
const partitions = require('./partitions');
const { normalizeUsageEvent } = require('../ingest/usageEvent');

let pool = null;
let driver = null;

/** Open the pool and bring the schema up. Idempotent — a second call returns the same driver. */
async function open(config = centralDbConfig()) {
  if (driver) return driver;
  pool = openPool(config);
  driver = pgDriver(pool);
  await migrateAsync({ driver, migrations, label: 'central' });
  // Before the first insert, not on a timer that has not fired yet: a central that has just been
  // created has no partitions at all, so the very first shipment would land in the default. ALL
  // partitioned tables, not just usage_events — since docs/design/dashboard-placement.md item 1
  // there are two, and a native batch arriving before the timer first fired would strand rows in
  // a default partition that then cannot be attached without an exclusive-lock scan.
  await partitions.ensureAllPartitions(driver);
  return driver;
}

async function close() {
  if (pool) await pool.end();
  pool = null;
  driver = null;
}

function requireDriver() {
  if (!driver) throw new Error('central store is not open — call open() first');
  return driver;
}

/**
 * The idempotency key for one envelope, and the §2.6 fallback for one that predates it.
 *
 * A current node stamps its shipment number into the envelope (server/store.js `enqueueOutbox`).
 * An older one does not, and the rule is that an old node must keep reporting to a new central —
 * so its event's chain seq stands in, paired with `kind` in the ledger's key so a correction is
 * not mistaken for a redelivery of what it corrects. `legacy` is returned rather than logged here
 * so the caller can count it: "how much of the fleet is on the old envelope" is a §2.6 skew
 * question, and a number beats a log line nobody greps.
 */
function shipmentKeyFor(envelope, event) {
  if (Number.isFinite(Number(envelope.seq))) return { seq: Number(envelope.seq), legacy: false };
  if (Number.isFinite(Number(event && event.seq))) return { seq: Number(event.seq), legacy: true };
  return { seq: null, legacy: true };
}

/** ts - observedAt, in ms, or null when the node sent no usable ts. §2.3: keep the delta. */
function clockSkewMs(nodeTs, observedAt) {
  if (!nodeTs) return null;
  const t = Date.parse(nodeTs);
  if (!Number.isFinite(t)) return null;
  return t - observedAt.getTime();
}

/** Parse one NDJSON body into envelopes, keeping the line number so a bad line can be named.
 *  A malformed line is skipped, not fatal — §2.6's tolerance rule applied to the transport as
 *  well as to the fields, since one unparseable line must not cost the other 499 their delivery.
 *
 *  The `raw` text of a bad line is kept on the malformed entry, not only its line number: it is
 *  what `ingestBatch` quarantines in `ingest_dead_letter` so the packet can be inspected and
 *  replayed rather than merely counted (docs/design/ingest-data-resilience.md). A parsed envelope
 *  keeps no raw copy — it re-serializes to canonical JSON if it later has to be dead-lettered,
 *  which is enough to replay it. */
function parseNdjson(body) {
  const envelopes = [];
  const malformed = [];
  const lines = String(body).split('\n');
  lines.forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') envelopes.push(parsed);
      else malformed.push({ line: i + 1, reason: 'not an object', raw: text });
    } catch (err) {
      malformed.push({ line: i + 1, reason: err.message, raw: text });
    }
  });
  return { envelopes, malformed };
}

/**
 * The dead-letter dedupe id — a hash of the node, the failure kind and the packet itself, so a
 * redelivery of the same unstorable packet collapses onto one row rather than multiplying them.
 * See migration 12: this is the failure-path analogue of the usage_shipments idempotency key.
 */
function deadLetterId(nodeId, kind, payload) {
  return crypto.createHash('sha256').update(`${nodeId || ''}|${kind}|${payload}`).digest('hex');
}

/** A stable trace id for one ingest request, used when the node sent no `x-windrow-trace-id`
 *  header. Prefixed so a central-minted id is distinguishable from a node-minted one in a log. */
function newTraceId() {
  return `ctr_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Quarantine one packet central could not store — docs/design/ingest-data-resilience.md.
 *
 * Called only from inside `ingestBatch`'s transaction, so a batch that rolls back dead-letters
 * nothing and a batch that commits loses nothing. Idempotent on `deadLetterId`: a redelivered bad
 * packet bumps `occurrences` and `lastSeenAt` and keeps the FIRST trace id — the sighting worth
 * tracing back to — rather than adding a row or overwriting the trail.
 */
async function deadLetter(tx, { nodeId, certSubject, traceId, kind, reason, eventId, seq, payload, now }) {
  const id = deadLetterId(nodeId, kind, payload);
  const iso = now.toISOString();
  await tx.query(
    `INSERT INTO ingest_dead_letter
       ("id", "nodeId", "certSubject", "traceId", "kind", "reason", "eventId", "seq",
        "payload", "firstSeenAt", "lastSeenAt", "occurrences", "status")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 1, 'quarantined')
     ON CONFLICT ("id") DO UPDATE SET
       "lastSeenAt" = EXCLUDED."lastSeenAt",
       "occurrences" = ingest_dead_letter."occurrences" + 1`,
    [id, nodeId || null, certSubject || null, traceId, kind, reason,
      eventId || null, Number.isFinite(Number(seq)) ? Number(seq) : null, payload, iso]
  );
  return id;
}

/**
 * Ingest one batch.
 *
 * `authenticatedNodeId` is who the *connection* says it is — the certificate CN. Null is allowed
 * only because a developer standing up central on loopback has nothing to issue certificates with
 * yet (the same carve-out server/usageShipper.js makes for plaintext http to 127.0.0.1); when it
 * is present it wins over the envelope, and a disagreement rejects the batch.
 *
 * The whole batch is one transaction. Not for performance — for the property that a node's ack
 * means either all of it landed or none did. At-least-once with a partial commit would leave rows
 * central has and the node has already deleted, with no way for either to know which.
 *
 * Returns `{ accepted, duplicates, corrections, rejected, malformed, legacyEnvelopes, nodes }`.
 * `duplicates` is the field server/usageShipper.js already logs, and it is not an error: it is the
 * at-least-once contract working.
 */
async function ingestBatch(body, { authenticatedNodeId = null, certSubject = null, now = new Date(), traceId = null } = {}) {
  const d = requireDriver();
  const { envelopes, malformed } = parseNdjson(body);
  // The batch trace id — the node's x-windrow-trace-id header, or one minted here — stamped on
  // every dead-letter row and returned in the ack so a quarantined packet ties back to this exact
  // request. docs/design/ingest-data-resilience.md.
  const trace = traceId || newTraceId();

  if (authenticatedNodeId) {
    const impostor = envelopes.find((e) => e.nodeId && e.nodeId !== authenticatedNodeId);
    if (impostor) {
      const err = new Error(
        `batch presented certificate for node ${authenticatedNodeId} but carries events claiming node `
          + `${impostor.nodeId} — refusing the whole batch. A credential directory has been copied `
          + 'between machines, or one node is forging another\'s stream.'
      );
      err.status = 403;
      err.code = 'NODE_IDENTITY_MISMATCH';
      // Deliberately NOT dead-lettered: this is a forgery signal, not a malformed packet, and the
      // whole batch stays on the node's outbox to be retried. Quarantining it would both lose the
      // "keep the rows" property and quietly swallow the one refusal that must stay loud.
      throw err;
    }
  }

  const result = {
    accepted: 0, duplicates: 0, corrections: 0, rejected: [], malformed,
    legacyEnvelopes: 0, unknownFields: 0, nodes: [], deadLettered: 0, traceId: trace,
  };
  // Nothing to store AND nothing to quarantine — the ordinary empty flush, or a keep-alive.
  if (!envelopes.length && !malformed.length) return result;

  await d.withTransaction(async (tx) => {
    const touched = new Map();

    // A line the transport itself could not parse. Quarantined verbatim before the good events are
    // stored, so it survives the drop the node's ack is about to make — see the table comment.
    for (const bad of malformed) {
      await deadLetter(tx, {
        nodeId: authenticatedNodeId, certSubject, traceId: trace, kind: 'malformed_line',
        reason: `line ${bad.line}: ${bad.reason}`, payload: bad.raw, now,
      });
      result.deadLettered += 1;
    }

    for (const envelope of envelopes) {
      const event = envelope.event && typeof envelope.event === 'object' ? envelope.event : null;
      const nodeId = authenticatedNodeId || envelope.nodeId || (event && event.nodeId) || null;
      const kind = envelope.kind || 'usage_event';

      // The raw packet, for the quarantine: the envelope re-serialized to canonical JSON so a
      // replay feeds ingest the same bytes it saw here. Computed lazily at each rejection point.
      const rawEnvelope = () => JSON.stringify(envelope);

      if (!nodeId) {
        result.rejected.push({ reason: 'envelope names no node', eventId: event && event.id });
        await deadLetter(tx, {
          nodeId: null, certSubject, traceId: trace, kind: 'rejected_event',
          reason: 'envelope names no node', eventId: event && event.id, payload: rawEnvelope(), now,
        });
        result.deadLettered += 1;
        continue;
      }
      if (!event) {
        result.rejected.push({ reason: 'envelope carries no event', nodeId });
        await deadLetter(tx, {
          nodeId, certSubject, traceId: trace, kind: 'rejected_event',
          reason: 'envelope carries no event', payload: rawEnvelope(), now,
        });
        result.deadLettered += 1;
        continue;
      }

      // §2.6's normalizer, the same one the node's own insert goes through — which is the point of
      // it being a file rather than a few `?? null`s at each insert. Column-backed fields land in
      // their columns; anything this build has no column for is kept in `extra`, inside the hash.
      const normalized = normalizeUsageEvent(event);
      if (!normalized.ok) {
        // The one refusal the normalizer makes: no usable id. Minting one would turn every
        // redelivery of this event into a new row.
        result.rejected.push({ reason: normalized.reason, nodeId, seq: event.seq });
        await deadLetter(tx, {
          nodeId, certSubject, traceId: trace, kind: 'rejected_event',
          reason: normalized.reason, seq: event.seq, payload: rawEnvelope(), now,
        });
        result.deadLettered += 1;
        continue;
      }
      result.unknownFields += normalized.unknownKeys.length;

      const { seq, legacy } = shipmentKeyFor(envelope, event);
      if (legacy) result.legacyEnvelopes += 1;
      if (seq === null) {
        result.rejected.push({ reason: 'shipment carries no sequence number', nodeId, eventId: normalized.row.id });
        await deadLetter(tx, {
          nodeId, certSubject, traceId: trace, kind: 'rejected_event',
          reason: 'shipment carries no sequence number', eventId: normalized.row.id, payload: rawEnvelope(), now,
        });
        result.deadLettered += 1;
        continue;
      }

      // The idempotency gate, ahead of the event write and in the same transaction as it. An
      // insert that reports no row is a redelivery: the event is already here, and writing it
      // again would double-count it in every fleet total.
      // WHICH LIFETIME OF THE NODE SHIPPED THIS — migration 7, and the reason the ledger key
      // widened. The shipment counter restarts when a node is rebuilt, so on the old key a
      // rebuilt node's first shipment collided with one the previous incarnation already sent and
      // was discarded as a redelivery — silently, and for every shipment that node made again.
      //
      // 'inc_0' for a node predating incarnations, matching the sentinel the migration backfilled
      // with. Not NULL: Postgres treats NULLs as distinct in a unique constraint, so a null here
      // would mean the ledger deduplicated nothing at all for those nodes.
      const shipIncarnation = (typeof envelope.incarnation === 'string' && envelope.incarnation) || 'inc_0';
      const claimed = await tx.all(
        `INSERT INTO usage_shipments ("nodeId", "incarnation", seq, kind, "eventId", "receivedAt")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("nodeId", "incarnation", seq, kind) DO NOTHING
         RETURNING seq`,
        [nodeId, shipIncarnation, seq, kind, normalized.row.id, now.toISOString()]
      );
      if (!claimed.length) {
        result.duplicates += 1;
        continue;
      }

      const observedAt = now;
      const nodeClaimed = {
        nodeId,
        // The EVENT's own incarnation, which is not necessarily the shipment's: a correction is
        // shipped by whichever lifetime is running now, for an event an earlier one wrote. Kept
        // verbatim because it is inside the node's hash chain — see the column comment.
        incarnation: typeof event.incarnation === 'string' ? event.incarnation : null,
        seq: Number.isFinite(Number(event.seq)) ? Number(event.seq) : null,
        prevHash: typeof event.prevHash === 'string' ? event.prevHash : null,
        hash: typeof event.hash === 'string' ? event.hash : null,
        // The node's own observedAt, kept verbatim because it is inside the node's hash chain.
        // Central's arrival time is a different column and never overwrites it.
        nodeObservedAt: typeof event.observedAt === 'string' ? event.observedAt : null,
      };

      if (kind === 'usage_event_correction') {
        // A correction updates the row already here rather than adding a second one. It is found
        // by (nodeId, id) across every partition — the row keeps the `observedAt` it first
        // arrived with, so it does not move between partitions and the update is in place.
        //
        // A correction for an event central never received is not an error and not dropped: it is
        // inserted as the event, which is the only copy that will ever exist of it. That is the
        // shape a node trimming an over-long outbox produces, and losing the *corrected* version
        // because the original was lost would compound one gap into two.
        const n = correctableColumns().length;
        const updated = await tx.all(
          `UPDATE usage_events SET ${correctableAssignments()}
           WHERE "nodeId" = $${n + 1} AND "id" = $${n + 2}
           RETURNING "id"`,
          [...correctionValues(normalized.row, nodeClaimed), nodeId, normalized.row.id]
        );
        if (updated.length) {
          result.corrections += 1;
          trackNode(touched, nodeId, event, observedAt, seq, certSubject, 0);
          continue;
        }
      }

      await tx.query(insertSql(), insertValues(normalized.row, nodeClaimed, {
        observedAt,
        clockSkewMs: clockSkewMs(normalized.row.ts, observedAt),
        shipmentSeq: seq,
        ingestKind: kind,
      }));
      result.accepted += 1;
      trackNode(touched, nodeId, event, observedAt, seq, certSubject, 1);
    }

    // Ordered by incarnation so the roster's `lastIncarnation` ends on the newest lifetime in the
    // batch rather than on whichever the iteration happened to reach last, and so the counter
    // increments once per lifetime in the order they actually happened.
    const lifetimes = [...touched.values()].sort((a, b) => String(a.incarnation).localeCompare(String(b.incarnation)));
    for (const stats of lifetimes) {
      const { nodeId } = stats;
      await tx.query(
        `INSERT INTO nodes ("nodeId", "firstSeenAt", "lastSeenAt", "lastSeq", "eventCount",
                            hostname, "osUser", "certSubject", "lastClockSkewMs", "lastEventTs",
                            "lastIncarnation", "incarnationCount", "lastIncarnationAt")
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 CASE WHEN $10::text IS NULL THEN 0 ELSE 1 END, $2)
         ON CONFLICT ("nodeId") DO UPDATE SET
           "lastSeenAt" = EXCLUDED."lastSeenAt",
           "lastSeq" = GREATEST(nodes."lastSeq", EXCLUDED."lastSeq"),
           "eventCount" = nodes."eventCount" + EXCLUDED."eventCount",
           hostname = COALESCE(EXCLUDED.hostname, nodes.hostname),
           "osUser" = COALESCE(EXCLUDED."osUser", nodes."osUser"),
           "certSubject" = COALESCE(EXCLUDED."certSubject", nodes."certSubject"),
           "lastClockSkewMs" = COALESCE(EXCLUDED."lastClockSkewMs", nodes."lastClockSkewMs"),
           "lastEventTs" = COALESCE(EXCLUDED."lastEventTs", nodes."lastEventTs"),
           "lastIncarnation" = COALESCE(EXCLUDED."lastIncarnation", nodes."lastIncarnation"),
           -- Counted, not derived. "How many times has this node been rebuilt" is the number a
           -- disposable fleet is actually operated by, and deriving it later would mean a
           -- COUNT(DISTINCT) over the whole partitioned event log every time anyone asked. Only
           -- increments when the incarnation CHANGES, so a node shipping a thousand batches in
           -- one lifetime still reads as one lifetime.
           "incarnationCount" = nodes."incarnationCount" + CASE
             WHEN EXCLUDED."lastIncarnation" IS NOT NULL
              AND EXCLUDED."lastIncarnation" IS DISTINCT FROM nodes."lastIncarnation" THEN 1 ELSE 0 END,
           "lastIncarnationAt" = CASE
             WHEN EXCLUDED."lastIncarnation" IS DISTINCT FROM nodes."lastIncarnation"
             THEN EXCLUDED."lastIncarnationAt" ELSE nodes."lastIncarnationAt" END`,
        [nodeId, now.toISOString(), stats.lastSeq, stats.inserted, stats.hostname, stats.osUser,
          stats.certSubject, stats.clockSkewMs, stats.lastEventTs, stats.incarnation]
      );
      if (!result.nodes.includes(nodeId)) result.nodes.push(nodeId);
    }
  });

  return result;
}

/**
 * Replay quarantined packets back through ingest — docs/design/ingest-data-resilience.md, the
 * recovery half of the dead-letter queue.
 *
 * The intended use is a packet dead-lettered because of a TRANSIENT central fault (a bug since
 * fixed, a schema that has since caught up): its raw payload is fed back through `ingestBatch`, and
 * on success the row is marked `replayed`. A STRUCTURAL failure — an event that genuinely has no id
 * — replays to the same refusal and stays `quarantined` with `replayResult` explaining why, which
 * is honest rather than a silent no-op. Nothing is deleted here: `discardDeadLetters` is how an
 * operator retires garbage, so a replay can never lose the packet it was trying to recover.
 */
async function replayDeadLetters(driver, { ids = [] } = {}) {
  const d = driver || requireDriver();
  const out = { replayed: 0, stillFailing: 0, notFound: 0, results: [] };
  for (const id of [].concat(ids)) {
    const row = await d.get('SELECT * FROM ingest_dead_letter WHERE "id" = $1', [id]);
    if (!row) {
      out.notFound += 1;
      out.results.push({ id, outcome: 'not_found' });
      continue;
    }
    // The stored payload is one NDJSON line; ingestBatch splits on newlines, so a trailing one is
    // all it needs to see a single-shipment body. authenticatedNodeId is the row's own node — this
    // is an admin action replaying a packet central already received, not a fresh network claim.
    const res = await ingestBatch(`${row.payload}\n`, {
      authenticatedNodeId: row.nodeId || null,
      certSubject: row.certSubject || null,
      traceId: `replay_${row.traceId}`,
    });
    const stored = res.accepted > 0 || res.duplicates > 0 || res.corrections > 0;
    const summary = `accepted=${res.accepted} duplicates=${res.duplicates} corrections=${res.corrections} `
      + `rejected=${res.rejected.length} malformed=${res.malformed.length}`;
    if (stored) {
      await d.query(
        `UPDATE ingest_dead_letter SET "status" = 'replayed', "replayedAt" = $2, "replayResult" = $3 WHERE "id" = $1`,
        [id, new Date().toISOString(), summary]
      );
      out.replayed += 1;
      out.results.push({ id, outcome: 'replayed', detail: summary });
    } else {
      await d.query(
        'UPDATE ingest_dead_letter SET "replayResult" = $2 WHERE "id" = $1',
        [id, `still unstorable: ${summary}`]
      );
      out.stillFailing += 1;
      out.results.push({ id, outcome: 'still_unstorable', detail: summary });
    }
  }
  return out;
}

/**
 * Retire quarantined packets an operator has decided are unrecoverable — a marker, not a delete, so
 * the record that a packet arrived and could not be stored survives the decision to stop trying.
 */
async function discardDeadLetters(driver, { ids = [] } = {}) {
  const d = driver || requireDriver();
  const list = [].concat(ids);
  if (!list.length) return { discarded: 0 };
  const params = list.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await d.all(
    `UPDATE ingest_dead_letter SET "status" = 'discarded' WHERE "id" IN (${params}) RETURNING "id"`,
    list
  );
  return { discarded: rows.length };
}

/**
 * Accumulate one node-lifetime's contribution to the roster.
 *
 * KEYED ON (nodeId, incarnation), NOT nodeId — and that is not bookkeeping neatness. A batch can
 * legitimately span two lifetimes: `server/store.js listOutboxBatch` reads the queue across every
 * incarnation, oldest first, precisely so a node that restarted with shipments outstanding still
 * delivers what the previous lifetime owed. Keyed on nodeId alone, those six events would collapse
 * into one upsert carrying whichever incarnation happened to be last, and `incarnationCount` — the
 * number that says how many times a machine has been rebuilt — would under-count by exactly the
 * rebuilds that happened while a queue was backed up. Which is to say: by the interesting ones.
 */
function trackNode(map, nodeId, event, observedAt, seq, certSubject, inserted) {
  const incarnation = event.incarnation || null;
  const key = `${nodeId}|${incarnation || ''}`;
  const prior = map.get(key) || {
    nodeId,
    lastSeq: 0, inserted: 0, hostname: null, osUser: null, certSubject,
    clockSkewMs: null, lastEventTs: null, incarnation,
  };
  map.set(key, {
    nodeId,
    lastSeq: Math.max(prior.lastSeq, seq),
    inserted: prior.inserted + inserted,
    hostname: event.hostname || prior.hostname,
    osUser: event.osUser || prior.osUser,
    certSubject: certSubject || prior.certSubject,
    clockSkewMs: clockSkewMs(event.ts, observedAt) ?? prior.clockSkewMs,
    lastEventTs: event.ts || prior.lastEventTs,
    incarnation,
  });
}

/** The INSERT, built once from the shared column list so a column added to
 *  ./centralMigrations.js reaches the insert without a second edit here. */
let cachedInsert = null;
function insertSql() {
  if (cachedInsert) return cachedInsert;
  const cols = EVENT_COLUMN_NAMES.map((c) => `"${c}"`).join(', ');
  const params = EVENT_COLUMN_NAMES.map((_, i) => `$${i + 1}`).join(', ');
  // ON CONFLICT on the physical key: two shipments carrying the same event that both got past the
  // shipment ledger (a node whose outbox seq counter was reset by a restored snapshot) must not
  // fail the whole batch. The ledger is the real guard; this is the belt.
  cachedInsert = `INSERT INTO usage_events (${cols}) VALUES (${params}) `
    + 'ON CONFLICT ("observedAt", "nodeId", "id") DO NOTHING';
  return cachedInsert;
}

function insertValues(row, nodeClaimed, central) {
  const merged = { ...row, ...nodeClaimed, ...central };
  return EVENT_COLUMN_NAMES.map((c) => (merged[c] === undefined ? null : merged[c]));
}

/** A correction rewrites what the node re-sent and nothing central assigned: the row keeps its
 *  arrival time (and therefore its partition), its shipment number and its first `ingestKind`. */
const UNCORRECTABLE = new Set(['observedAt', 'shipmentSeq', 'ingestKind', 'id', 'nodeId']);
function correctableColumns() {
  return EVENT_COLUMN_NAMES.filter((c) => !UNCORRECTABLE.has(c));
}
function correctableAssignments() {
  return correctableColumns().map((c, i) => `"${c}" = $${i + 1}`).join(', ');
}
function correctionValues(row, nodeClaimed) {
  const merged = { ...row, ...nodeClaimed };
  return correctableColumns().map((c) => (merged[c] === undefined ? null : merged[c]));
}

// ---------------------------------------------------------------------------------------------
// NATIVE TOOL OBSERVATIONS — docs/design/dashboard-placement.md item 1.
//
// A SEPARATE PATH FROM `ingestBatch` ABOVE, ON PURPOSE. The design note is explicit that the
// separation ../nativeObservations.js argues for "must survive" the move to central, and this is
// where surviving it means writing a second function rather than a second `kind` on the first one.
// Everything the usage path does — the shipment ledger, the chain columns, the correction UPDATE,
// the node roster's event counters — is machinery for a record that claims to be COMPLETE and
// TAMPER-EVIDENT. A native observation claims neither. Running it through that machinery would
// have to disable each piece in turn, and every disabled piece would be a place a future reader
// could re-enable by accident.
//
// So this shares only what is genuinely shared: the identity check, the transaction, and the
// clock-skew measure.
// ---------------------------------------------------------------------------------------------

const NATIVE_COLUMNS = [
  'id', 'nodeId', 'incarnation', 'principalId', 'toolName', 'detail', 'ts', 'outcome', 'reason',
  'sessionId', 'actorLoomId', 'actorHumanName', 'actorAgentType', 'actorBackend', 'actorField',
  'osUser', 'hostname', 'observedAt', 'clockSkewMs',
];

let cachedNativeInsert = null;
function nativeInsertSql() {
  if (cachedNativeInsert) return cachedNativeInsert;
  const cols = NATIVE_COLUMNS.map((c) => `"${c}"`).join(', ');
  const params = NATIVE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
  cachedNativeInsert = `INSERT INTO native_tool_events (${cols}) VALUES (${params}) `
    + 'ON CONFLICT ("observedAt", "nodeId", "id") DO NOTHING';
  return cachedNativeInsert;
}

/** What a node is allowed to say about one observation. Anything else on the wire is dropped
 *  rather than stored: unlike `usage_events`, this table has no `extra` column and no hash over
 *  it, so there is nothing an unknown field could be kept *inside*. Dropping it silently would be
 *  the §2.6 failure, so the count comes back in the ack. */
function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof raw.id !== 'string' || !raw.id) return { ok: false, reason: 'observation carries no id' };
  if (typeof raw.toolName !== 'string' || !raw.toolName) {
    return { ok: false, reason: 'observation names no tool', id: raw.id };
  }
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const known = new Set([...NATIVE_COLUMNS, 'nodeId', 'incarnation']);
  const unknownKeys = Object.keys(raw).filter((k) => !known.has(k));
  return {
    ok: true,
    unknownKeys,
    row: {
      id: raw.id,
      incarnation: str(raw.incarnation),
      principalId: str(raw.principalId),
      toolName: raw.toolName,
      detail: str(raw.detail),
      ts: str(raw.ts),
      outcome: str(raw.outcome),
      reason: str(raw.reason),
      sessionId: str(raw.sessionId),
      actorLoomId: str(raw.actorLoomId),
      actorHumanName: str(raw.actorHumanName),
      actorAgentType: str(raw.actorAgentType),
      actorBackend: str(raw.actorBackend),
      actorField: str(raw.actorField),
      osUser: str(raw.osUser),
      hostname: str(raw.hostname),
    },
  };
}

/**
 * Ingest a batch of native observations, as NDJSON, one observation per line.
 *
 * IDEMPOTENCY WITHOUT A LEDGER. `id` is a SHA-256 of the spool line the node parsed, so the same
 * observation redelivered is the same id — but the physical primary key has to carry `observedAt`
 * (Postgres requires the partition key inside every unique index), and a redelivery gets a new
 * `observedAt` by definition. So the dedup is an explicit lookup against the `id` index inside the
 * same transaction as the insert, and `ON CONFLICT DO NOTHING` on the physical key is the belt
 * under it. That lookup is one indexed probe per row and it is the price of partitioning a table
 * whose identity is content rather than arrival.
 *
 * A LOST BATCH IS NOT A HOLE IN AN AUDIT LOG. Rejections are counted and reported, never thrown:
 * these rows are observation, they are already best-effort on the node, and taking a 500 over one
 * malformed line would cost the other 4,999 their delivery for nothing.
 */
async function ingestNativeBatch(body, { authenticatedNodeId = null, now = new Date() } = {}) {
  const d = requireDriver();
  const { envelopes, malformed } = parseNdjson(body);

  if (authenticatedNodeId) {
    const impostor = envelopes.find((e) => e.nodeId && e.nodeId !== authenticatedNodeId);
    if (impostor) {
      // The same refusal `ingestBatch` makes, for the same reason and with no softening for these
      // being "only" observations: filing one machine's activity under another's name is a
      // misattribution whether or not the rows are in a chain.
      const err = new Error(
        `batch presented certificate for node ${authenticatedNodeId} but carries observations claiming `
          + `node ${impostor.nodeId} — refusing the whole batch.`
      );
      err.status = 403;
      err.code = 'NODE_IDENTITY_MISMATCH';
      throw err;
    }
  }

  const result = { accepted: 0, duplicates: 0, rejected: [], malformed, unknownFields: 0, nodes: [] };
  if (!envelopes.length) return result;

  await d.withTransaction(async (tx) => {
    const touched = new Set();
    for (const envelope of envelopes) {
      const nodeId = authenticatedNodeId || envelope.nodeId || null;
      if (!nodeId) {
        result.rejected.push({ reason: 'observation names no node', id: envelope.id });
        continue;
      }
      const normalized = normalizeObservation(envelope);
      if (!normalized.ok) {
        result.rejected.push({ reason: normalized.reason, nodeId, id: normalized.id });
        continue;
      }
      result.unknownFields += normalized.unknownKeys.length;

      const seen = await tx.all(
        'SELECT 1 FROM native_tool_events WHERE "id" = $1 AND "nodeId" = $2 LIMIT 1',
        [normalized.row.id, nodeId]
      );
      if (seen.length) {
        result.duplicates += 1;
        continue;
      }

      const merged = {
        ...normalized.row,
        nodeId,
        observedAt: now,
        clockSkewMs: clockSkewMs(normalized.row.ts, now),
      };
      await tx.query(nativeInsertSql(), NATIVE_COLUMNS.map((c) => (merged[c] === undefined ? null : merged[c])));
      result.accepted += 1;
      touched.add(nodeId);
    }

    // The roster learns the node is alive and when it last sent observations — and NOTHING ELSE.
    // Deliberately not `eventCount` or `lastSeq`: those are the audit stream's counters, and
    // adding native volume to them would make every fleet number mean "governed decisions, plus
    // however many files somebody read", which is exactly the blurring the separate table exists
    // to prevent.
    for (const nodeId of touched) {
      await tx.query(
        `INSERT INTO nodes ("nodeId", "firstSeenAt", "lastSeenAt", "nativeLastSeenAt")
         VALUES ($1, $2, $2, $2)
         ON CONFLICT ("nodeId") DO UPDATE SET
           "lastSeenAt" = GREATEST(nodes."lastSeenAt", EXCLUDED."lastSeenAt"),
           "nativeLastSeenAt" = EXCLUDED."nativeLastSeenAt"`,
        [nodeId, now.toISOString()]
      );
      result.nodes.push(nodeId);
    }
  });

  return result;
}

// ---------------------------------------------------------------------------------------------
// NODE HEALTH — docs/design/dashboard-placement.md item 2.
//
// Current state, last-write-wins, no history. See ../nodeHealth.js's header for why this is not an
// event and must not be queued like one. The one thing central adds is `hookReportedAt`, its own
// arrival clock, so a row that stopped being refreshed is distinguishable from one that is being
// refreshed with the same answer.
// ---------------------------------------------------------------------------------------------

/**
 * Record one node's hook-integrity report.
 *
 * `authenticatedNodeId` wins over the body for the reason it does everywhere else here: a node may
 * report on itself and on nothing else. A report naming another machine is not reconciled, it is
 * refused — an operator sent to fix the wrong PC is worse than an operator sent nowhere.
 */
async function ingestNodeHealth(report, { authenticatedNodeId = null, now = new Date() } = {}) {
  const d = requireDriver();
  const claimed = report && typeof report.nodeId === 'string' ? report.nodeId : null;
  if (authenticatedNodeId && claimed && claimed !== authenticatedNodeId) {
    const err = new Error(
      `report presented certificate for node ${authenticatedNodeId} but describes node ${claimed} — refusing it.`
    );
    err.status = 403;
    err.code = 'NODE_IDENTITY_MISMATCH';
    throw err;
  }
  const nodeId = authenticatedNodeId || claimed;
  if (!nodeId) {
    const err = new Error('no node id — send one in the body, or present a node certificate');
    err.status = 400;
    throw err;
  }
  const hooks = (report && report.hooks && typeof report.hooks === 'object') ? report.hooks : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const status = typeof hooks.status === 'string' ? hooks.status : 'unknown';

  // LOCAL DIVERGENCE — docs/design/disposable-nodes.md §5. The two levers a node holds that widen
  // what it allows, landing on the roster beside everything else that is currently true about it.
  //
  // Every field is read defensively and written even when ABSENT, and that second half is the one
  // that matters: a report with no pause must CLEAR the columns, or a pause that lapsed thirty
  // minutes ago stays on the fleet view forever and the one signal this adds becomes noise. So
  // `divergence` missing entirely is read as "not reported" (leave the columns alone) while
  // `divergence.pause === null` is read as "no pause" (clear them) — an older node that does not
  // send the block at all must not have its history erased by a schema it has never heard of.
  const divergence = (report && report.divergence && typeof report.divergence === 'object') ? report.divergence : null;
  const pause = divergence && divergence.pause && typeof divergence.pause === 'object' ? divergence.pause : null;
  const lease = divergence && divergence.lease && typeof divergence.lease === 'object' ? divergence.lease : null;
  const credential = (report && report.credential && typeof report.credential === 'object') ? report.credential : null;
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  const tiers = (v) => (Array.isArray(v) ? v.join(',') : null);

  const journalResult = await ingestFaultJournal(d, nodeId, report && report.journal, now);

  // THE MACHINE-FACT TIER — docs/design/disposable-nodes.md §6, and two of §3's four leaks landing
  // somewhere other than one machine's disk for the first time. Stored whole as JSON rather than
  // shredded into columns: central RECORDS these, it does not query them by field and it never
  // pushes them back (the node is authoritative for this tier by design), so a column apiece would
  // be schema churn for a value that is only ever read as a page about one node.
  const facts = (report && report.facts && typeof report.facts === 'object') ? report.facts : null;

  await d.query(
    `INSERT INTO nodes ("nodeId", "firstSeenAt", "lastSeenAt", "hookStatus", "hookInstalledCount",
                        "hookInstallableCount", "hookBrokenCount", "hookTamperCount",
                        "hookLastTamperAt", "hookDetail", "hookCheckedAt", "hookReportedAt",
                        "pauseId", "pauseUntil", "pauseTiers", "pauseReason", "pauseIssuedBy",
                        "leaseUntil", "leaseTiers", "enforcing",
                        "credentialState", "credentialNotAfter", "facts", "factsReportedAt")
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $2,
             $11, $12::TIMESTAMPTZ, $13, $14, $15,
             $16::TIMESTAMPTZ, $17, $18,
             $19, $20::TIMESTAMPTZ, $21::JSONB, CASE WHEN $21 IS NULL THEN NULL ELSE $2::TIMESTAMPTZ END)
     ON CONFLICT ("nodeId") DO UPDATE SET
       "lastSeenAt" = GREATEST(nodes."lastSeenAt", EXCLUDED."lastSeenAt"),
       "hookStatus" = EXCLUDED."hookStatus",
       "hookInstalledCount" = EXCLUDED."hookInstalledCount",
       "hookInstallableCount" = EXCLUDED."hookInstallableCount",
       "hookBrokenCount" = EXCLUDED."hookBrokenCount",
       "hookTamperCount" = EXCLUDED."hookTamperCount",
       "hookLastTamperAt" = EXCLUDED."hookLastTamperAt",
       "hookDetail" = EXCLUDED."hookDetail",
       "hookCheckedAt" = EXCLUDED."hookCheckedAt",
       "hookReportedAt" = EXCLUDED."hookReportedAt",
       -- COALESCE on the RIGHT of the comparison, not the left: when this report carried no
       -- divergence block at all, $18 (enforcing) is NULL and every pause/lease column keeps
       -- whatever it held. When it carried one with no pause, $18 is TRUE and the columns are
       -- overwritten with the NULLs that say "not paused".
       "pauseId" = CASE WHEN $18 IS NULL THEN nodes."pauseId" ELSE EXCLUDED."pauseId" END,
       "pauseUntil" = CASE WHEN $18 IS NULL THEN nodes."pauseUntil" ELSE EXCLUDED."pauseUntil" END,
       "pauseTiers" = CASE WHEN $18 IS NULL THEN nodes."pauseTiers" ELSE EXCLUDED."pauseTiers" END,
       "pauseReason" = CASE WHEN $18 IS NULL THEN nodes."pauseReason" ELSE EXCLUDED."pauseReason" END,
       "pauseIssuedBy" = CASE WHEN $18 IS NULL THEN nodes."pauseIssuedBy" ELSE EXCLUDED."pauseIssuedBy" END,
       "leaseUntil" = CASE WHEN $18 IS NULL THEN nodes."leaseUntil" ELSE EXCLUDED."leaseUntil" END,
       "leaseTiers" = CASE WHEN $18 IS NULL THEN nodes."leaseTiers" ELSE EXCLUDED."leaseTiers" END,
       "enforcing" = COALESCE(EXCLUDED."enforcing", nodes."enforcing"),
       "credentialState" = COALESCE(EXCLUDED."credentialState", nodes."credentialState"),
       "credentialNotAfter" = COALESCE(EXCLUDED."credentialNotAfter", nodes."credentialNotAfter"),
       -- COALESCE, so a report that carried no facts block leaves the last one standing rather than
       -- erasing it. The facts are slow-moving and expensive to lose; the last known answer beats
       -- nothing at all.
       "facts" = COALESCE(EXCLUDED."facts", nodes."facts"),
       "factsReportedAt" = COALESCE(EXCLUDED."factsReportedAt", nodes."factsReportedAt")`,
    [
      nodeId,
      now.toISOString(),
      status,
      num(hooks.installedCount),
      num(hooks.installableCount),
      num(hooks.brokenCount),
      num(hooks.tamperCount),
      typeof hooks.lastTamperAt === 'string' ? hooks.lastTamperAt : null,
      JSON.stringify(hooks),
      typeof report.reportedAt === 'string' ? report.reportedAt : now.toISOString(),
      pause ? String(pause.id || '').slice(0, 64) || null : null,
      pause ? iso(pause.until) : null,
      pause ? tiers(pause.tolerate) : null,
      pause ? String(pause.reason || '').slice(0, 200) || null : null,
      pause ? String(pause.issuedBy || '').slice(0, 120) || null : null,
      lease ? iso(lease.until) : null,
      lease ? tiers(lease.tolerate) : null,
      divergence ? divergence.enforcing !== false : null,
      credential && typeof credential.state === 'string' ? credential.state : null,
      credential ? iso(credential.notAfter) : null,
      facts ? JSON.stringify(facts) : null,
    ]
  );

  if (journalResult.accepted) {
    // Counters rather than a recomputed aggregate: this runs on every report from every node, and
    // a COUNT(*) over a table whose whole purpose is to grow during an incident is the wrong thing
    // to do during that incident.
    await d.query(
      `UPDATE nodes SET "journalEntries" = "journalEntries" + $2,
                        "journalBytes" = $3,
                        "journalLastAt" = $4
       WHERE "nodeId" = $1`,
      [nodeId, journalResult.accepted, journalResult.throughByte, now.toISOString()]
    );
  }

  return {
    nodeId,
    status,
    enforcing: divergence ? divergence.enforcing !== false : null,
    journalAccepted: journalResult.accepted,
  };
}

/**
 * Take a slice of a node's fault journal — docs/design/disposable-nodes.md §3 and §5.
 *
 * IDEMPOTENT BY THE ROW'S OWN ID, which the node derived from the line's bytes. That is what lets
 * the node's cursor be a best-effort mark rather than a durable one: a rebuilt node re-ships from
 * zero, every line it re-sends hits ON CONFLICT DO NOTHING, and nothing is duplicated or lost.
 *
 * Returns `{ accepted, throughByte }`. `accepted` is what the node's ack checks before it advances
 * its cursor — see ../nodeHealth.js reportNow — so returning a number here is a contract, not a
 * statistic.
 */
async function ingestFaultJournal(d, nodeId, journal, now) {
  const entries = journal && Array.isArray(journal.entries) ? journal.entries : [];
  // How far into its own journal the node says this slice reaches. Recorded on the roster so that
  // "central has taken 84 kB of that node's journal and it has stopped climbing" is answerable.
  const throughByte = Number.isFinite(Number(journal && journal.throughByte)) ? Number(journal.throughByte) : 0;
  if (!entries.length) return { accepted: 0, throughByte };

  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
  const bigint = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  let accepted = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    // `id` is the node's content hash of the line. It is checked for shape rather than recomputed:
    // recomputing would require the exact bytes, which is not what arrived — and a node that lies
    // about its own journal's hashes can equally lie about the journal, so there is nothing here
    // for a check to buy.
    const res = await d.query(
      `INSERT INTO node_fault_journal
         ("id", "nodeId", "ts", "receivedAt", "fault", "denialKind", "tier", "capability",
          "principalId", "outcome", "why", "pauseId", "policyAgeMs", "policyVersion", "raw")
       VALUES ($1, $2, $3::TIMESTAMPTZ, $4::TIMESTAMPTZ, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::JSONB)
       ON CONFLICT ("id") DO NOTHING`,
      [
        entry.id.slice(0, 64),
        nodeId,
        iso(entry.ts),
        now.toISOString(),
        text(entry.fault, 64),
        text(entry.denialKind, 32),
        text(entry.tier, 32),
        text(entry.capability, 256),
        text(entry.principalId, 128),
        text(entry.outcome, 32),
        text(entry.why, 256),
        text(entry.pauseId, 64),
        bigint(entry.policyAgeMs),
        bigint(entry.policyVersion),
        JSON.stringify(entry),
      ]
    );
    accepted += (res && typeof res.rowCount === 'number') ? res.rowCount : 1;
  }
  return { accepted, throughByte };
}

module.exports = {
  open,
  close,
  requireDriver,
  ingestBatch,
  ingestNativeBatch,
  ingestNodeHealth,
  replayDeadLetters,
  discardDeadLetters,
  deadLetterId,
  normalizeObservation,
  parseNdjson,
  shipmentKeyFor,
  clockSkewMs,
  correctableColumns,
  NATIVE_COLUMNS,
  get driver() { return driver; },
};
