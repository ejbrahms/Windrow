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
  // created has no partitions at all, so the very first shipment would land in the default.
  await partitions.ensurePartitions(driver);
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
 *  well as to the fields, since one unparseable line must not cost the other 499 their delivery. */
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
      else malformed.push({ line: i + 1, reason: 'not an object' });
    } catch (err) {
      malformed.push({ line: i + 1, reason: err.message });
    }
  });
  return { envelopes, malformed };
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
async function ingestBatch(body, { authenticatedNodeId = null, certSubject = null, now = new Date() } = {}) {
  const d = requireDriver();
  const { envelopes, malformed } = parseNdjson(body);

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
      throw err;
    }
  }

  const result = {
    accepted: 0, duplicates: 0, corrections: 0, rejected: [], malformed,
    legacyEnvelopes: 0, unknownFields: 0, nodes: [],
  };
  if (!envelopes.length) return result;

  await d.withTransaction(async (tx) => {
    const touched = new Map();

    for (const envelope of envelopes) {
      const event = envelope.event && typeof envelope.event === 'object' ? envelope.event : null;
      const nodeId = authenticatedNodeId || envelope.nodeId || (event && event.nodeId) || null;
      const kind = envelope.kind || 'usage_event';

      if (!nodeId) {
        result.rejected.push({ reason: 'envelope names no node', eventId: event && event.id });
        continue;
      }
      if (!event) {
        result.rejected.push({ reason: 'envelope carries no event', nodeId });
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
        continue;
      }
      result.unknownFields += normalized.unknownKeys.length;

      const { seq, legacy } = shipmentKeyFor(envelope, event);
      if (legacy) result.legacyEnvelopes += 1;
      if (seq === null) {
        result.rejected.push({ reason: 'shipment carries no sequence number', nodeId, eventId: normalized.row.id });
        continue;
      }

      // The idempotency gate, ahead of the event write and in the same transaction as it. An
      // insert that reports no row is a redelivery: the event is already here, and writing it
      // again would double-count it in every fleet total.
      const claimed = await tx.all(
        `INSERT INTO usage_shipments ("nodeId", seq, kind, "eventId", "receivedAt")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("nodeId", seq, kind) DO NOTHING
         RETURNING seq`,
        [nodeId, seq, kind, normalized.row.id, now.toISOString()]
      );
      if (!claimed.length) {
        result.duplicates += 1;
        continue;
      }

      const observedAt = now;
      const nodeClaimed = {
        nodeId,
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

    for (const [nodeId, stats] of touched) {
      await tx.query(
        `INSERT INTO nodes ("nodeId", "firstSeenAt", "lastSeenAt", "lastSeq", "eventCount",
                            hostname, "osUser", "certSubject", "lastClockSkewMs", "lastEventTs")
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT ("nodeId") DO UPDATE SET
           "lastSeenAt" = EXCLUDED."lastSeenAt",
           "lastSeq" = GREATEST(nodes."lastSeq", EXCLUDED."lastSeq"),
           "eventCount" = nodes."eventCount" + EXCLUDED."eventCount",
           hostname = COALESCE(EXCLUDED.hostname, nodes.hostname),
           "osUser" = COALESCE(EXCLUDED."osUser", nodes."osUser"),
           "certSubject" = COALESCE(EXCLUDED."certSubject", nodes."certSubject"),
           "lastClockSkewMs" = COALESCE(EXCLUDED."lastClockSkewMs", nodes."lastClockSkewMs"),
           "lastEventTs" = COALESCE(EXCLUDED."lastEventTs", nodes."lastEventTs")`,
        [nodeId, now.toISOString(), stats.lastSeq, stats.inserted, stats.hostname, stats.osUser,
          stats.certSubject, stats.clockSkewMs, stats.lastEventTs]
      );
      result.nodes.push(nodeId);
    }
  });

  return result;
}

function trackNode(map, nodeId, event, observedAt, seq, certSubject, inserted) {
  const prior = map.get(nodeId) || { lastSeq: 0, inserted: 0, hostname: null, osUser: null, certSubject, clockSkewMs: null, lastEventTs: null };
  map.set(nodeId, {
    lastSeq: Math.max(prior.lastSeq, seq),
    inserted: prior.inserted + inserted,
    hostname: event.hostname || prior.hostname,
    osUser: event.osUser || prior.osUser,
    certSubject: certSubject || prior.certSubject,
    clockSkewMs: clockSkewMs(event.ts, observedAt) ?? prior.clockSkewMs,
    lastEventTs: event.ts || prior.lastEventTs,
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

module.exports = {
  open,
  close,
  requireDriver,
  ingestBatch,
  parseNdjson,
  shipmentKeyFor,
  clockSkewMs,
  correctableColumns,
  get driver() { return driver; },
};
