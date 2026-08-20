'use strict';
// Cross-workspace usage rollup — docs/design/cross-field-and-standalone.md. Reads other
// workspaces' windrow.db files directly, read-only, and merges them with this workspace's own
// live data. No shared write path, no network, no new auth surface: exactly the "ship a rollup,
// not a rewrite" migration docs/design/deployment-boundary-decision.md promised.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const store = require('../store');
const { principalDisplayName } = require('../principals/registry');

// Default root: the platform's workspace root, one level above this workspace's own directory
// (e.g. `<workspace-root>` is the parent of `<workspace-root>/<field>`). Override with
// WISPFIELD_FIELDS_ROOT for a non-default layout.
const THIS_FIELD_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = path.dirname(THIS_FIELD_DIR);
const FIELDS_ROOT = process.env.WISPFIELD_FIELDS_ROOT || DEFAULT_ROOT;
const THIS_FIELD_NAME = path.basename(THIS_FIELD_DIR);

/** Every sibling directory under the fields root that looks like a workspace running this same
 * governance system (has server/data/windrow.db, or a pre-rename governance.db), plus this workspace itself. Doesn't require
 * the other workspace's server to be running — only that its db file exists on disk. */
function discoverFieldDirs(root = FIELDS_ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  // Make sure this workspace itself is always included even if it's not literally one level under
  // `root` in some non-standard layout (e.g. WISPFIELD_FIELDS_ROOT overridden to something that
  // doesn't contain it).
  if (!dirs.includes(THIS_FIELD_DIR)) dirs.push(THIS_FIELD_DIR);
  return dirs.filter((dir) => fieldDbPath(dir) !== null);
}

// A sibling field is migrated by *its own* server on *its own* schedule, and tier 2 of
// docs/design/governance-to-windrow-rename.md renames the file at that server's next boot — so at
// any given moment some fields under the workspace root are on `windrow.db` and some are still on
// `governance.db`. Resolve whichever is actually there, preferring the new name, and return null
// when the directory holds neither (i.e. it isn't a field at all).
function fieldDbPath(fieldDir) {
  for (const name of ['windrow.db', 'governance.db']) {
    const candidate = path.join(fieldDir, 'server', 'data', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema tolerance. A sibling workspace's db is migrated by *its own* server on *its own*
// schedule (server/schema/nodeMigrations.js, applied at that server's startup), and this rollup
// opens those files `readonly` — so it can neither migrate them nor assume it is looking at the
// same shape this workspace is on. Both directions have to be survivable:
//
//   older than us  — `standalone`/`status`/`subjectId`/`assuranceLevel`/`owner*` and the
//                    `usage_events` actor columns are simply absent, and a `SELECT *` row comes
//                    back missing those keys rather than holding NULL. Every read below therefore
//                    goes through a normalizer that supplies exactly the default the
//                    corresponding migration would have applied, so a not-yet-migrated sibling
//                    reports the same numbers it will report after it migrates — not zeroes, and
//                    not `undefined` leaking into a comparison.
//   newer than us  — extra columns we have never heard of. `SELECT *` already carries them, so
//                    the normalizers spread the raw row first and override only the keys they own,
//                    leaving anything unrecognized intact for a later reader.
//
// A missing *table* is the same story one level up (a db created before `usage_events` existed, or
// one caught mid-creation by another server's first startup): each table is read independently and
// a failure on one leaves the field reachable with the other's rows, instead of blanking a
// workspace that has perfectly good principals because its event table isn't there yet.

/** One principal row in the shape the rest of this module reads, whatever schema produced it.
 * Defaults mirror server/schema/nodeMigrations.js's column defaults exactly — see the block
 * comment above. */
function normalizePrincipal(row) {
  return {
    ...row,
    id: row.id ?? null,
    kind: typeof row.kind === 'string' ? row.kind : null,
    name: row.name ?? null,
    humanName: row.humanName ?? null,
    backend: row.backend ?? null,
    agentType: row.agentType ?? null,
    parentRole: row.parentRole ?? null,
    field: row.field || null,
    // Pre-cross-field dbs have no column at all: those principals are all workspace-bound, which
    // is what `false` says (docs/design/cross-field-and-standalone.md).
    standalone: !!row.standalone,
    // Pre-F7 dbs: every existing row was provisioned under the old auto-grant policy, so 'active'
    // is what store.js's ALTER back-fills them to.
    status: row.status ?? 'active',
    subjectId: row.subjectId ?? null,
    assuranceLevel: Number.isInteger(row.assuranceLevel) ? row.assuranceLevel : null,
    ownerStatus: row.ownerStatus ?? 'unassigned',
    ownerOsUser: row.ownerOsUser ?? null,
    ownerPrincipalId: row.ownerPrincipalId ?? null,
    ownerConfirmedAt: row.ownerConfirmedAt ?? null,
    ownerConfirmedBy: row.ownerConfirmedBy ?? null,
  };
}

/** One usage event in the shape the rest of this module reads. `actorField`/`actorBackend` are the
 * later-added snapshot columns the attribution logic prefers; on a db that predates them they are
 * null here and every read site already falls back to the principal row. */
function normalizeUsageEvent(row) {
  return {
    ...row,
    principalId: row.principalId ?? null,
    ts: row.ts ?? null,
    outcome: row.outcome ?? null,
    actorField: row.actorField ?? null,
    actorBackend: row.actorBackend ?? null,
    // The writing node and this event's place in that node's chain
    // (docs/design/global-identity-and-central-db.md §2.7 phase 1). Null on a sibling that hasn't
    // migrated yet, which is why `eventKey()` below has a fallback rather than assuming them.
    nodeId: row.nodeId ?? null,
    seq: Number.isInteger(row.seq) ? row.seq : null,
    // When that node stamped the row, as against `ts` (when the caller said the call happened).
    // Kept through the merge because the gap between them is the only measurable evidence of
    // clock skew between two machines whose events this module puts in one list.
    observedAt: row.observedAt ?? null,
  };
}

/** The identity of an event *across dbs*. `(nodeId, seq)` is globally unique by construction —
 * that is what §2.7 phase 1 added it for — so two reads of the same physical db, or a sibling that
 * holds a copy of another node's rows, collapse onto one event rather than being counted twice.
 * Pre-migration rows have neither, and `dbPath` + `id` is the best available substitute: ids are
 * unique within a db, so it dedupes a db read twice and nothing else. */
function eventKey(event, dbPath) {
  if (event.nodeId && event.seq != null) return `n\u0000${event.nodeId}\u0000${event.seq}`;
  return `d\u0000${dbPath}\u0000${event.id}`;
}

/** How far this event's two clocks disagree, in ms — the node's stamp minus the caller's. Null
 * unless both are present and parse. Positive is the ordinary case (a node sees an event after the
 * caller made it, plus the hop); a large magnitude either way is machine clock skew, and a
 * *negative* value means the caller's clock is ahead of the node's, i.e. an event that claims to
 * have happened after it was recorded. */
function clockSkewMs(event) {
  if (!event.observedAt || !event.ts) return null;
  const observed = Date.parse(event.observedAt);
  const claimed = Date.parse(event.ts);
  if (!Number.isFinite(observed) || !Number.isFinite(claimed)) return null;
  return observed - claimed;
}

/** Newest first, nulls last. Done in JS rather than `ORDER BY ts` because `ts` is one more column
 * this module can't assume exists, and `usageEvents[0].ts` is read as "the latest event". */
function sortEventsNewestFirst(events) {
  return events.sort((a, b) => {
    if (a.ts === b.ts) return 0;
    if (!a.ts) return 1;
    if (!b.ts) return -1;
    return a.ts < b.ts ? 1 : -1;
  });
}

/** Reads one table, or reports why it couldn't. Never throws: a table that doesn't exist in this
 * db's schema version yet is an empty list plus a warning, not a dead field. */
function readTable(db, sql, normalize, warnings, label) {
  try {
    return db.prepare(sql).all().map(normalize);
  } catch (err) {
    warnings.push(`${label}: ${err.message}`);
    return [];
  }
}

/** Opens one workspace's db read-only and pulls the rows a rollup needs. Never throws — an
 * unreachable/locked/corrupt db is reported as `reachable: false` rather than aborting the whole
 * rollup for every other workspace. Tolerates a db on an older or newer schema than this
 * workspace's; see the block comment above. */
function readField(fieldDir) {
  const dbPath = fieldDbPath(fieldDir) || path.join(fieldDir, 'server', 'data', 'windrow.db');
  const fieldName = path.basename(fieldDir);
  const base = { field: fieldName, fieldPath: fieldDir, dbPath };

  // This workspace's own db may currently be open read-write by the running server (this very
  // process, in fact) — read it straight through the store module instead of opening a second
  // handle on the same file, which is both unnecessary and (on some platforms) contention-prone.
  // Normalized through the same functions even though this db is migrated by definition, so both
  // paths hand the rest of the module one shape.
  if (fieldDir === THIS_FIELD_DIR) {
    try {
      const principals = store.listPrincipals().map(normalizePrincipal);
      const usageEvents = sortEventsNewestFirst(store.listUsageEvents().map(normalizeUsageEvent));
      return { ...base, reachable: true, nodeId: store.nodeId(), principals, usageEvents, warnings: [] };
    } catch (err) {
      return { ...base, reachable: false, error: err.message, nodeId: null, principals: [], usageEvents: [], warnings: [] };
    }
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const warnings = [];
    const principals = readTable(db, 'SELECT * FROM principals', normalizePrincipal, warnings, 'principals');
    const usageEvents = sortEventsNewestFirst(
      readTable(db, 'SELECT * FROM usage_events', normalizeUsageEvent, warnings, 'usage_events')
    );
    // Read, never minted: this module opens sibling dbs read-only and a node id belongs to the
    // server that owns the file. A sibling that predates §2.7 phase 1 simply has no row here, and
    // reports null until its own server next starts and mints one.
    let nodeId = null;
    try {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('node_id');
      nodeId = row ? row.value : null;
    } catch (err) {
      warnings.push(`kv/node_id: ${err.message}`);
    }
    return { ...base, reachable: true, nodeId, principals, usageEvents, warnings };
  } catch (err) {
    return { ...base, reachable: false, error: err.message, nodeId: null, principals: [], usageEvents: [], warnings: [] };
  } finally {
    if (db) db.close();
  }
}

/** `GET /api/rollup/fields` payload: which workspaces were found and whether each was reachable.
 *
 * Directory discovery alone misses workspaces that only exist inside another workspace's shared
 * db (Mode B — see `docs/design/deploy-capability-governance-server` skill) and never had their
 * own `server/data/windrow.db` on disk. Those workspaces are real (their principals carry a
 * real `field` value, same as summary() now accounts for) but would otherwise not appear in this
 * list at all. Fold them in as `sharedOnly: true` rows so a workspace isn't invisible just because
 * it never got a directory of its own on this machine. */
function scanFields() {
  const dirs = discoverFieldDirs();
  const reads = dirs.map(readField);
  const fields = reads.map((r) => {
    const lastEventAt = r.usageEvents.length ? r.usageEvents[0].ts : null; // already newest-first
    return {
      field: r.field,
      fieldPath: r.fieldPath,
      dbPath: r.dbPath,
      reachable: r.reachable,
      error: r.error || null,
      // Which node owns this db. Two workspace directories pointing at one shared db (Mode B)
      // report the same nodeId, which is what makes the double-counting visible here rather than
      // only in summary()'s totals.
      nodeId: r.nodeId || null,
      // Reachable but partially read — typically a table this workspace's schema has and that
      // workspace's db hasn't migrated to yet. Surfaced rather than swallowed so a count that
      // looks low is explicable instead of just wrong.
      warnings: r.warnings && r.warnings.length ? r.warnings : [],
      // Agent-shaped rows only. A `user` principal is a *subject* — the OS account behind the
      // calls, one per person per machine (docs/design/global-identity-and-central-db.md §1.4) —
      // and counting it here would silently inflate every field's "principals" number the moment
      // the subject rows start appearing. It has no `field` of its own either, so every
      // per-workspace loop below already skips it.
      principalCount: r.principals.filter((p) => !p.standalone && p.kind !== 'user').length,
      eventCount: r.usageEvents.length,
      lastEventAt,
      sharedOnly: false,
    };
  });

  const knownFieldNames = new Set(fields.map((f) => f.field));
  const sharedOnly = new Map(); // workspace name -> { principalCount, eventCount, lastEventAt }
  for (const r of reads) {
    if (!r.reachable) continue;
    const principalsById = new Map(r.principals.map((p) => [p.id, p]));
    for (const p of r.principals) {
      if (p.standalone || !p.field || knownFieldNames.has(p.field)) continue;
      if (!sharedOnly.has(p.field)) {
        sharedOnly.set(p.field, { principalCount: 0, eventCount: 0, lastEventAt: null });
      }
      sharedOnly.get(p.field).principalCount += 1;
    }
    for (const e of r.usageEvents) {
      const principal = principalsById.get(e.principalId);
      if (principal && principal.standalone) continue;
      // The event's own actorField first — it's what the hook saw when the call was made, and
      // unlike the principal row it can't be back-filled or repointed afterwards. The principal
      // row is the fallback for events logged before that column existed.
      const eventField = e.actorField || (principal && principal.field);
      if (!eventField || knownFieldNames.has(eventField)) continue;
      const entry = sharedOnly.get(eventField);
      if (!entry) continue;
      entry.eventCount += 1;
      if (!entry.lastEventAt || e.ts > entry.lastEventAt) entry.lastEventAt = e.ts;
    }
  }
  for (const [field, entry] of sharedOnly) {
    fields.push({
      field,
      fieldPath: null,
      dbPath: null,
      reachable: true,
      error: null,
      warnings: [],
      principalCount: entry.principalCount,
      eventCount: entry.eventCount,
      lastEventAt: entry.lastEventAt,
      sharedOnly: true,
    });
  }

  return { root: FIELDS_ROOT, thisField: THIS_FIELD_NAME, fields };
}

/** `GET /api/rollup/summary` payload: merges usage across every reachable workspace, with
 * standalone usage (no workspace of its own by construction) broken out separately.
 *
 * A single db no longer implies a single workspace: under the shared-server deployment
 * (`docs/design/deployment-boundary-decision.md`'s "Status update: switched to shared"), one
 * `windrow.db` holds principals/events for every workspace whose hooks point at it, each
 * already tagged with its own real `field` column (`server/principals/fromEnv.js`). So the
 * workspace a call belongs to has to come from **the principal that made it**, not from which
 * directory's db happened to be read (`r.field`) — that was only ever correct under Mode A (one
 * db per workspace), where every principal in a workspace's db necessarily had that same
 * workspace. Without this, every non-standalone principal from a workspace other than the one
 * hosting the db got folded into `r.field` instead — indistinguishable in the UI from that
 * workspace's own principals, and easy to misread as "not attributed to any workspace", i.e.
 * standalone. Falling back to `r.field` still covers the genuine edge case of a usage event whose
 * principal row is missing entirely. */
function scanSummary() {
  const dirs = discoverFieldDirs();
  const reads = dirs.map(readField);

  const totals = { calls: 0, denied: 0 };
  // Every event this merge has already counted, keyed on (nodeId, seq) — see `eventKey()`. Without
  // it, the shared-db deployment counts one call once per workspace directory pointing at that db,
  // which is not a rounding error: it multiplies a whole node's usage by however many workspaces
  // share it. This is what §2.7 phase 1's nodeId/seq make possible — before them there was no key
  // that meant the same event across two reads.
  const seenEvents = new Set();
  let duplicatesSkipped = 0;
  // Clock skew, measured rather than assumed: observedAt (the node's stamp) minus ts (the
  // caller's), across every event that carries both. `behind` is the direction that should not
  // happen — a call claiming a time later than the node that recorded it — so it is reported
  // separately from an ordinary lag rather than folded into one magnitude.
  const skew = { sampled: 0, maxAheadMs: null, maxBehindMs: null };
  const byFieldMap = new Map();
  // key: principalId + workspace-or-standalone bucket. Never the display name — `humanName` is a
  // platform-assigned nickname from a fixed cast pack, so keying on it merges two different humans
  // who drew the same one and splits one human across respawns (see
  // docs/design/global-identity-and-central-db.md §1.1). The bucket stays in the key because the
  // same principal's calls are still reported per workspace.
  const byPrincipalMap = new Map();
  const standaloneByBackend = new Map();

  // Seed byFieldMap from every non-standalone principal's own `field`, not just workspaces that
  // had usage events — a workspace with registered principals but zero calls yet should still
  // show up with a real principalCount instead of being invisible until its first call.
  for (const r of reads) {
    if (!r.reachable) continue;
    for (const p of r.principals) {
      if (p.standalone || !p.field) continue;
      const bucket = byFieldMap.get(p.field) || {
        field: p.field,
        fieldPath: p.field === r.field ? r.fieldPath : null,
        calls: 0,
        denied: 0,
        principalCount: 0,
      };
      bucket.principalCount += 1;
      byFieldMap.set(p.field, bucket);
    }
  }

  for (const r of reads) {
    if (!r.reachable) continue;
    const principalsById = new Map(r.principals.map((p) => [p.id, p]));

    for (const e of r.usageEvents) {
      const dedupeKey = eventKey(e, r.dbPath);
      if (seenEvents.has(dedupeKey)) {
        duplicatesSkipped += 1;
        continue;
      }
      seenEvents.add(dedupeKey);

      const skewMs = clockSkewMs(e);
      if (skewMs != null) {
        skew.sampled += 1;
        if (skewMs >= 0) skew.maxAheadMs = skew.maxAheadMs == null ? skewMs : Math.max(skew.maxAheadMs, skewMs);
        else skew.maxBehindMs = skew.maxBehindMs == null ? -skewMs : Math.max(skew.maxBehindMs, -skewMs);
      }

      totals.calls += 1;
      const denied = e.outcome === 'denied';
      if (denied) totals.denied += 1;

      const principal = principalsById.get(e.principalId);
      const isStandalone = Boolean(principal && principal.standalone);
      // The event's real workspace: what the *call itself* recorded, not the db file it happened
      // to be read from (see the function comment above) and not a live read of the principal
      // row. `actorField` is a snapshot taken by the hook at call time, so a principal whose
      // identity was later back-filled or whose instance was repointed doesn't retroactively move
      // its old calls into a different workspace. The principal row, then `r.field`, remain as
      // fallbacks for events logged before the column existed.
      const eventField = isStandalone ? null : e.actorField || (principal && principal.field) || r.field;

      if (isStandalone) {
        const backend = e.actorBackend || principal.backend || 'unknown';
        const bucket = standaloneByBackend.get(backend) || { backend, calls: 0, denied: 0 };
        bucket.calls += 1;
        if (denied) bucket.denied += 1;
        standaloneByBackend.set(backend, bucket);
      } else {
        // The workspace's bucket was already seeded from principals above; a call from a
        // workspace with no registered (non-standalone) principal at all is the one case that
        // still needs creating one here.
        const fieldBucket = byFieldMap.get(eventField) || {
          field: eventField,
          fieldPath: eventField === r.field ? r.fieldPath : null,
          calls: 0,
          denied: 0,
          principalCount: 0,
        };
        fieldBucket.calls += 1;
        if (denied) fieldBucket.denied += 1;
        byFieldMap.set(eventField, fieldBucket);
      }

      const bucketLabel = isStandalone
        ? `standalone:${e.actorBackend || principal.backend || 'unknown'}`
        : eventField;
      const key = `${e.principalId}\u0000${bucketLabel}`;
      const entry = byPrincipalMap.get(key) || {
        principalId: e.principalId,
        name: principalDisplayName(principal, e.principalId),
        // Disambiguates two rows that drew the same nickname — see the byPrincipalMap comment.
        agentName: principal ? principal.name : null,
        field: isStandalone ? null : eventField,
        standalone: isStandalone,
        backend: isStandalone ? e.actorBackend || principal.backend || 'unknown' : null,
        calls: 0,
        denied: 0,
      };
      entry.calls += 1;
      if (denied) entry.denied += 1;
      byPrincipalMap.set(key, entry);
    }
  }

  const byField = [...byFieldMap.values()].sort((a, b) => b.calls - a.calls);
  const byPrincipal = [...byPrincipalMap.values()].sort((a, b) => b.calls - a.calls);
  const standaloneEntries = [...standaloneByBackend.values()].sort((a, b) => b.calls - a.calls);
  const standaloneCalls = standaloneEntries.reduce((sum, b) => sum + b.calls, 0);
  const standaloneDenied = standaloneEntries.reduce((sum, b) => sum + b.denied, 0);

  return {
    fields: reads.map((r) => ({
      field: r.field,
      fieldPath: r.fieldPath,
      nodeId: r.nodeId || null,
      reachable: r.reachable,
      error: r.error || null,
      warnings: r.warnings && r.warnings.length ? r.warnings : [],
    })),
    totals: {
      ...totals,
      denialRate: totals.calls === 0 ? 0 : totals.denied / totals.calls,
      // Reported, not silently dropped: a non-zero count is the signal that two of the workspaces
      // above share one db, and it is the difference between the old totals and these.
      duplicatesSkipped,
      // Two clocks, and how far apart they were found to be. `sampled` is how many events could be
      // measured at all — rows written before observedAt existed carry only the caller's clock, so
      // a small sample beside a large `calls` means "not yet measurable", not "no skew".
      clockSkew: skew,
    },
    byField,
    byPrincipal,
    standalone: { calls: standaloneCalls, denied: standaloneDenied, byBackend: standaloneEntries },
  };
}



// ---------------------------------------------------------------------------
// THE SOURCE SEAM — §2.7 phase 5.
//
// Everything above this line is the scan: N sibling workspace directories, N read-only SQLite
// handles, a schema-tolerance layer for each, and a de-duplication pass in JavaScript. It is kept,
// and it is no longer the only answer. Once usage lands centrally the same rollup is one query
// (server/central/queries.js `rollup`), over rows that were de-duplicated at ingest and that carry
// their workspace on the event itself — and, unlike the scan, it spans machines.
//
// So `listFields()` and `summary()` become a choice of source rather than the scan itself, and the
// scan stays reachable under its own name for the two cases that still need it: a node with no
// central, and a central that cannot be reached right now.
//
// THEY ARE NOW ASYNC. There is no synchronous HTTP in Node and there is no way around that; the two
// routes in server/app.js await them. Nothing on the hot path calls either — this is a dashboard
// read, where a human is waiting, not a decision path, where an agent is (§2.8's line, applied one
// more time).

const centralSource = require('./central');

/** Attach the scan's provenance to a scan-shaped payload. A reader that does not check `source`
 *  gets the same fields it always got; one that does can tell "this machine" from "the fleet". */
function localPayload(payload, centralError = null) {
  return { ...payload, source: 'local-scan', centralError, scope: { nodeIds: null }, since: null };
}

/**
 * Run `attempt` against central, and decide what a failure means.
 *
 * WINDROW_ROLLUP_SOURCE=central means central or nothing, and the error is thrown: falling back
 * would answer a fleet-wide question with one machine's rows under the same headings, which is a
 * wrong number that looks like a right one. In `auto` the fall back happens and the payload carries
 * `centralError`, because a Fleet page that fails entirely is worse than one that shows this
 * machine and says which it is showing.
 */
async function fromCentral(attempt, fallback) {
  if (!centralSource.enabled()) return localPayload(fallback());
  try {
    return await attempt();
  } catch (err) {
    if (centralSource.required()) throw err;
    console.warn('[rollup] central query failed, falling back to the local workspace scan:', err.message);
    return localPayload(fallback(), err.message);
  }
}

/** `GET /api/rollup/fields`. Central when there is one, this machine's directories otherwise. */
async function listFields(options = {}) {
  return fromCentral(
    async () => centralSource.toFields(await centralSource.fetchRollup(options), { thisField: THIS_FIELD_NAME }),
    scanFields
  );
}

/** `GET /api/rollup/summary`. Same choice, same fallback. */
async function summary(options = {}) {
  return fromCentral(
    async () => centralSource.toSummary(await centralSource.fetchRollup(options)),
    scanSummary
  );
}

module.exports = {
  FIELDS_ROOT,
  THIS_FIELD_NAME,
  discoverFieldDirs,
  readField,
  // The source-choosing entry points the routes call. Async — see the block comment above.
  listFields,
  summary,
  // The scan itself, still synchronous and still exactly what it was. Exported under its own name
  // so a caller that specifically wants THIS MACHINE'S DISK — a test, a diagnostic, the fallback
  // above — can ask for it without going through the seam.
  scanFields,
  scanSummary,
};
