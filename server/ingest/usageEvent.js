'use strict';
// Forward-compatible usage-event ingest — docs/design/global-identity-and-central-db.md §2.6,
// first rule: "an unknown field on an event is stored, never rejected; a missing field is null,
// never fatal. An old node must keep reporting to a new central."
//
// WHY THIS IS A FILE AND NOT A FEW `?? null`s AT THE INSERT. There are two ingest points, and they
// have to agree:
//
//   today   server/store.js's insertUsageEvent, fed by POST /api/invoke on this node
//   phase 3 central's /api/ingest/usage, fed by server/usageShipper.js from N nodes at N versions
//
// The second is where the rule earns its keep — a fleet on user PCs updates at N different times,
// so central is permanently reading events written by builds both older and newer than its own.
// Adopting it only at central would mean the rule was never exercised until the moment it had to
// work. Adopting it at the node's own insert means every event that has ever been written went
// through it, and the phase-3 endpoint is a caller of this file rather than a second reading of
// the same paragraph.
//
// THE TWO HALVES, AND WHAT EACH ONE BUYS
//
//   missing -> null      Every column-backed field is present in the returned row whether or not
//                        the caller sent it. That is what makes an OLD node's event land on a NEW
//                        central: the columns it has never heard of read as "not recorded", which
//                        is the truth, rather than making the insert fail or the row absent.
//
//   unknown -> `extra`   Anything the caller sent that has no column is collected into one JSON
//                        object stored in usage_events.extra. That is what makes a NEW node's
//                        event land on an OLD central: the field survives the round trip and is
//                        still there after central upgrades and grows the column. Dropping it
//                        instead — which an explicit @field INSERT list does silently — would make
//                        the upgrade unable to recover data that was, briefly, right there.
//
// `extra` is part of the hash chain (server/store.js's canonicalizeUsageEvent), which is the whole
// reason it is one column of canonical JSON rather than a side table: an unknown field is evidence
// like any other, and evidence outside the chain is evidence that can be edited without breaking
// anything.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never invents a value. A missing `outcome` is null, not
// 'unknown'; a missing `latencyMs` is null, not 0. Those five columns were NOT NULL until §2.6 was
// adopted (schema migration 15 relaxed them) precisely so this file would not have to choose
// between a lie and a throw. A reader that cannot tell "denied" from "not recorded" is a reader
// that will eventually report a fleet-wide outage as a clean bill of health.

/**
 * The column-backed fields a caller may supply, with the type each column holds.
 *
 * Ordered as the table is (server/schema/nodeMigrations.js), so a column added there and forgotten
 * here shows up as a diff of one list against another rather than as a field that silently starts
 * landing in `extra`. `nodeId`/`seq`/`observedAt`/`prevHash`/`hash` are NOT here: they are assigned
 * by the writer inside the insert transaction and a caller-supplied value for any of them would be
 * a claim about someone else's chain. They arrive as unknown fields and are dropped as such below.
 */
const EVENT_FIELDS = {
  id: 'text',
  principalId: 'text',
  capabilityId: 'text',
  ts: 'text',
  outcome: 'text',
  latencyMs: 'int',
  correlationId: 'text',
  reason: 'text',
  capabilityLookupMs: 'int',
  principalResolveMs: 'int',
  brokerMs: 'int',
  grantCheckMs: 'int',
  osUser: 'text',
  hostname: 'text',
  actorLoomId: 'text',
  actorAgentType: 'text',
  actorBackend: 'text',
  actorField: 'text',
  subjectId: 'text',
  assuranceLevel: 'int',
  shadowOutcome: 'text',
  shadowReason: 'text',
  shadowPrincipalId: 'text',
  correctedAt: 'text',
};

/** Assigned by the writer, never by the caller — see EVENT_FIELDS. Named so that a caller that
 *  sends one gets it ignored rather than quietly filed under `extra` as if it were news.
 *
 *  `extra` is not in here and must not be: a re-ingested row carries one already (a shipped event
 *  arriving at central, a snapshot being restored), and treating it as a caller-supplied unknown
 *  would nest it — while ignoring it would drop, at the exact hop the rule exists for, the fields
 *  the rule exists to keep. It is merged instead; see normalizeUsageEvent. */
const WRITER_ASSIGNED = new Set(['nodeId', 'seq', 'observedAt', 'prevHash', 'hash']);

/**
 * Coerce one value to what its column holds, or report that it does not fit.
 *
 * A value that does not fit is not an error and is not discarded: the column reads null and the
 * original goes to `extra` untouched, so the two guarantees compose — nothing is fatal and nothing
 * is lost. Objects and arrays never fit a TEXT column meaningfully (SQLite would store
 * "[object Object]"), which is exactly the case worth preserving verbatim: a scalar field that
 * became a structured one in a later build is the commonest shape of forward skew there is.
 */
function coerce(value, type) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (type === 'int') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: Math.trunc(value) };
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return { ok: true, value: Math.trunc(Number(value)) };
    }
    return { ok: false };
  }
  if (typeof value === 'string') return { ok: true, value };
  // Booleans and numbers have one obvious text form and no information is lost writing it, so
  // they are accepted rather than exiled to `extra` over a type mismatch that isn't one.
  if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
  return { ok: false };
}

/**
 * One raw event -> `{ ok, row, extra, unknownKeys, coercedKeys, promotedKeys }`.
 *
 * Pure: no clock, no database, no id generation. `row` holds exactly the EVENT_FIELDS keys plus
 * `extra` (a canonical JSON string, or null when there is nothing unknown), which is what
 * server/store.js's prepared INSERT binds. `unknownKeys` is what the caller sent that this build
 * has no column for — the number a fleet-skew dashboard wants, and the reason it is returned
 * separately rather than left for someone to re-derive by parsing `extra` back.
 *
 * There is exactly one thing this refuses, and `id` is it: it is the row's primary key and the
 * handle a correcting PATCH and an at-least-once redelivery both arrive with. Minting one here
 * would turn every retry of the same event into a new row, so an event with no usable id is
 * reported as unusable rather than made up. Everything else about it can be missing.
 */
function normalizeUsageEvent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const row = {};
  const unknownKeys = [];
  const coercedKeys = [];
  // Seeded with whatever the row already carried, so a re-ingest is idempotent rather than
  // lossy — an event shipped from a node to central, or restored from a snapshot, arrives with
  // the fields *its* writer could not place, and this is the hop where losing them would exactly
  // undo the rule. Layered under the loop below, so a field that has since gained a real column is
  // promoted out of `extra` into it (see the `promoted` handling there) rather than kept in both.
  const carried = readExtra(source.extra);
  const extra = carried ? { ...carried } : {};
  const promotedKeys = [];

  for (const [field, type] of Object.entries(EVENT_FIELDS)) {
    // A field the row carries in `extra` but not at top level is one an EARLIER build had no
    // column for and this one does — the upgrade case the column was kept for. Promote it, and
    // take it out of `extra` so the value does not exist in two places free to disagree.
    let value = source[field];
    if ((value === undefined || value === null) && field in extra) {
      const promoted = coerce(extra[field], type);
      if (promoted.ok && promoted.value !== null) {
        value = extra[field];
        delete extra[field];
        promotedKeys.push(field);
      }
    }
    const fit = coerce(value, type);
    if (fit.ok) {
      row[field] = fit.value;
    } else {
      // Did not fit its column: null there, verbatim in `extra`, and named in `coercedKeys` so the
      // caller can say so out loud instead of the mismatch reading as a field nobody sent.
      row[field] = null;
      extra[field] = value;
      coercedKeys.push(field);
    }
  }

  for (const key of Object.keys(source)) {
    if (key in EVENT_FIELDS || WRITER_ASSIGNED.has(key) || key === 'extra') continue;
    if (source[key] === undefined) continue;
    extra[key] = source[key];
    unknownKeys.push(key);
  }

  // Sorted keys: `extra` is hashed as part of the row, so two ingests of the same event must
  // produce the same string regardless of the order the fields arrived in. JSON.stringify follows
  // insertion order, which for an HTTP body is whatever order the sender happened to serialise in.
  const keys = Object.keys(extra).sort();
  let encoded = null;
  if (keys.length) {
    const ordered = {};
    for (const k of keys) ordered[k] = extra[k];
    try {
      encoded = JSON.stringify(ordered);
    } catch {
      // A cycle or a BigInt. Losing the values is better than losing the event, and recording that
      // it happened is better than either — the count stays true even when the payload cannot be.
      encoded = JSON.stringify({ _unserializable: keys });
    }
  }
  row.extra = encoded;

  if (typeof row.id !== 'string' || row.id === '') {
    return {
      ok: false,
      reason: 'event has no id — refusing to mint one, since the id is the key an at-least-once redelivery arrives with',
      row,
      extra: encoded,
      unknownKeys,
      coercedKeys,
      promotedKeys,
    };
  }
  return { ok: true, row, extra: encoded, unknownKeys, coercedKeys, promotedKeys };
}

/** Parse an `extra` column back to an object. Never throws: the column is written by this module
 *  but read from a database that other builds, backups and a rollup merge have all touched. */
function readExtra(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { EVENT_FIELDS, WRITER_ASSIGNED, normalizeUsageEvent, readExtra };
