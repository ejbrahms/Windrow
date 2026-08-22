'use strict';
// Turns the hook's native-tool spool (server/hooks/lib.js NATIVE_JOURNAL_PATH) into rows the
// dashboard can read. This is the server half of native-tool *observability* — the answer to
// "why can't I see this loom's Read/Edit/Bash calls anywhere", which until now was: because
// nothing ever recorded them (normalizeToolCall returns null for a native tool, so no capability,
// so no /invoke, so no row). See docs/design/native-tool-observability.md.
//
// Two decisions shape everything below, and both are deliberate:
//
// 1. NATIVE EVENTS LIVE IN THEIR OWN TABLE, not in `usage_events`. That table is hash-chained for
//    tamper evidence (store.js's canonicalizeUsageEvent/rechainFrom, verified by
//    GET /api/usage/verify), and every row in it is the record of a *decision this system made*:
//    a grant was checked, an outcome was produced, a principal was resolved at call time. A native
//    observation is none of those things. It is unenforced, best-effort, arrives late and out of
//    order after a drain, and can be dropped outright when the spool hits its cap. Chaining rows
//    with those properties into the audit log would weaken the one claim that log exists to make,
//    and would swamp it: native calls outnumber governed ones by one to two orders of magnitude,
//    so every drift number, usage summary and denial rate computed off `usage_events` would
//    silently change meaning. A separate table keeps "what was governed" and "what happened"
//    as two honest answers instead of one blurred one.
//
// 2. THE DRAIN RUNS HERE, NOT IN THE HOOK. A hook is a fresh process per tool call that ends in
//    `process.exit(0)`, so it cannot await an HTTP round trip without putting it on the hot path
//    of every file read. It writes a line; this reads them in batches.
//
// Nothing in this file authorizes, denies or influences anything. If it never ran, every tool
// call would behave exactly as it does today — the rows would just not exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { principalRoleName } = require('./principals/registry');
const { envCompat } = require('./config');

const DATA_DIR = path.join(__dirname, 'data');
const NATIVE_JOURNAL_PATH = path.join(DATA_DIR, 'hook-native-journal.jsonl');
// The spool is renamed to this before it is parsed, so hooks appending concurrently start a clean
// file and no line can be consumed twice within one cycle. A crash between the rename and the
// insert leaves this file behind; `drainNativeObservations` picks it up on the next cycle, which
// is why the ids below are content-derived rather than random.
const DRAINING_PATH = `${NATIVE_JOURNAL_PATH}.draining`;

const DRAIN_INTERVAL_MS = Number(envCompat('NATIVE_DRAIN_INTERVAL_MS')) || 15_000;
// Native calls are high-volume by nature — this table grows one row per file read, forever,
// unlike `usage_events` where a row is a governed decision worth keeping indefinitely. Trimmed on
// every drain rather than by a separate job so the retention rule cannot be forgotten to run.
const RETENTION_DAYS = Number(envCompat('NATIVE_RETENTION_DAYS')) || 14;
// A single drain's ceiling. A field that ran for a week with the server down can hand us a spool
// of a million lines; parsing and inserting it in one synchronous transaction would block the API
// for the whole of it. The excess is dropped, and dropped LOUDLY (see the log below) — a silent
// truncation would read as "you did 50,000 things" when the real number was higher.
const MAX_LINES_PER_DRAIN = Number(envCompat('NATIVE_DRAIN_MAX_LINES')) || 20_000;

const OUTCOMES = new Set(['ok', 'error', 'denied']);

/**
 * Content-derived id, so re-draining a `.draining` file left by a crash re-inserts the same ids
 * and the `INSERT OR IGNORE` below makes the whole operation idempotent. The cost is that two
 * genuinely distinct calls identical in every recorded dimension *including the millisecond
 * timestamp* collapse into one row. That is a real loss and a deliberately cheap one: the two are
 * indistinguishable in every field we keep, so the alternative to under-counting them by one is
 * double-counting an unknown number of rows after every unclean shutdown.
 */
function observationId(line) {
  return `nev_${crypto.createHash('sha256').update(line).digest('hex').slice(0, 20)}`;
}

function parseLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null; // a torn final line from a hook that died mid-append — skip it, don't fail the batch
  }
  if (!raw || typeof raw.toolName !== 'string' || !raw.toolName) return null;
  if (typeof raw.loomId !== 'string' || !raw.loomId) return null;
  return {
    ts: typeof raw.ts === 'string' ? raw.ts : new Date().toISOString(),
    toolName: raw.toolName,
    detail: typeof raw.detail === 'string' ? raw.detail : null,
    // An unrecognized outcome is recorded as 'ok' rather than rejected: the line is evidence the
    // call happened, which is the thing being observed, and a hook writing a fourth word is a bug
    // to notice in the data, not a reason to lose the row.
    outcome: OUTCOMES.has(raw.outcome) ? raw.outcome : 'ok',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    identity: {
      loomId: raw.loomId,
      humanName: typeof raw.humanName === 'string' ? raw.humanName : null,
      backend: typeof raw.backend === 'string' ? raw.backend : null,
      agentType: typeof raw.agentType === 'string' ? raw.agentType : null,
      field: typeof raw.field === 'string' ? raw.field : null,
      standalone: raw.standalone === true,
      osUser: typeof raw.osUser === 'string' ? raw.osUser : null,
      hostname: typeof raw.hostname === 'string' ? raw.hostname : null,
      // Deliberately absent — see server/principals/fromEnv.js's `skipSubject`. The observation
      // path cannot afford a subject read, so these rows say "not recorded" rather than guessing.
      subjectId: null,
      assuranceLevel: null,
    },
  };
}

/**
 * The id an observation is parked under when its loom has no principal row yet AND this node
 * cannot mint one. Derived from the loom id so it is stable across drains and across restarts —
 * which is what lets `reclaimPlaceheldObservations` below sweep every such row onto the real
 * principal with a single indexed UPDATE the moment one exists.
 */
function placeholderPrincipalId(loomId) {
  return `unresolved:${loomId}`;
}

function isPlaceholder(principalId) {
  return typeof principalId === 'string' && principalId.startsWith('unresolved:');
}

// Loom ids this process has parked observations under. Only these are worth sweeping, so the
// reclaim below costs nothing on the overwhelmingly common path where every loom resolved.
const placeheld = new Set();

/**
 * Resolves each distinct loomId in a batch to the principal its *governed* calls land on, so the
 * dashboard shows one agent rather than two. Memoized per drain because a batch is overwhelmingly
 * one or two looms making hundreds of calls.
 *
 * READ FIRST, and only write if the read misses. That ordering is the whole of it: this used to go
 * straight to `upsertPrincipalIdentity`, which on a node where central owns policy
 * (WINDROW_POLICY_AUTHORITY=central) is refused outright — principals there are a read replica.
 * Every loom therefore resolved to null, every row was skipped, and the drain quietly consumed the
 * spool and inserted nothing: the card went empty on exactly the nodes that are governed hardest.
 * A read works identically under either authority and hits on essentially every call, because a
 * loom that has made even one governed call already has its instance row here — minted locally, or
 * replicated down from central.
 *
 * A miss on a replica is the one case left, and it records the observation under a loom-derived
 * placeholder rather than dropping it. Dropping was the bug; and an observation is not policy —
 * this table has no foreign key and is in no hash chain, so parking a row under an id central has
 * not issued asserts nothing about who may do what.
 */
function resolvePrincipals(store, batch) {
  const byLoomId = new Map();
  // On a replica the upsert is not merely likely to fail, it is guaranteed to — so don't attempt
  // it, and don't log a screenful of refusals for a condition that is this node's normal state.
  const readOnly = typeof store.isPolicyReadOnly === 'function' && store.isPolicyReadOnly();
  for (const entry of batch) {
    const { loomId } = entry.identity;
    if (byLoomId.has(loomId)) continue;
    let principalId = null;
    try {
      const existing = store.findPrincipalByKindName('instance', loomId);
      if (existing) principalId = existing.id;
    } catch (err) {
      console.error('[native-observations] principal lookup failed for', loomId, err.message);
    }
    if (!principalId && !readOnly) {
      try {
        // Same pair POST /api/principals/resolve uses, so a loom first seen through a native call
        // gets the identical row its first governed call would have created.
        const { instance } = store.upsertPrincipalIdentity(principalRoleName(entry.identity), entry.identity);
        if (instance) principalId = instance.id;
      } catch (err) {
        // One unresolvable loom must not cost the batch every other loom's rows.
        console.error('[native-observations] could not resolve principal for', loomId, err.message);
      }
    }
    if (!principalId) {
      principalId = placeholderPrincipalId(loomId);
      placeheld.add(loomId);
    }
    byLoomId.set(loomId, principalId);
  }
  return byLoomId;
}

/**
 * Sweeps observations parked under a placeholder onto the real principal once it has replicated
 * down. Runs after each insert, over only the looms this process actually placeheld, and keys on
 * principalId — which is indexed — so the common case is one miss on an empty set.
 */
function reclaimPlaceheldObservations(store) {
  if (!placeheld.size || typeof store.reassignNativeToolEventPrincipal !== 'function') return 0;
  let moved = 0;
  for (const loomId of [...placeheld]) {
    let real = null;
    try {
      real = store.findPrincipalByKindName('instance', loomId);
    } catch {
      continue; // try again next cycle
    }
    if (!real) continue;
    try {
      moved += store.reassignNativeToolEventPrincipal(placeholderPrincipalId(loomId), real.id);
      placeheld.delete(loomId);
    } catch (err) {
      console.error('[native-observations] could not re-point placeheld observations for', loomId, err.message);
    }
  }
  return moved;
}

/**
 * Claims the spool by renaming it out of the way. Returns the lines, or null when there is nothing
 * to do.
 *
 * The rename can fail on Windows if a hook happens to hold the file open for its append at that
 * instant. That is not an error worth reporting: the file is still there, still complete, and the
 * next cycle picks it up a few seconds later. Nothing is lost by waiting.
 */
function claimSpool() {
  // A `.draining` file already present means a previous cycle died between claiming and
  // inserting. Finish it before taking anything new, so the two can't interleave out of order.
  if (!fs.existsSync(DRAINING_PATH)) {
    if (!fs.existsSync(NATIVE_JOURNAL_PATH)) return null;
    try {
      fs.renameSync(NATIVE_JOURNAL_PATH, DRAINING_PATH);
    } catch {
      return null;
    }
  }
  let text;
  try {
    text = fs.readFileSync(DRAINING_PATH, 'utf8');
  } catch (err) {
    console.error('[native-observations] could not read the claimed spool:', err.message);
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) {
    try {
      fs.unlinkSync(DRAINING_PATH);
    } catch {
      /* it will be retried next cycle */
    }
    return null;
  }
  return lines;
}

/**
 * One drain cycle. Safe to call at any time and from anywhere — it claims the spool atomically, so
 * two overlapping calls cannot consume the same lines.
 *
 * Returns `{ inserted, dropped, skipped }` for the caller that wants to log or test it; the timer
 * ignores the return value.
 */
function drainNativeObservations(store) {
  const lines = claimSpool();
  if (!lines) return { inserted: 0, dropped: 0, skipped: 0 };

  let dropped = 0;
  let claimed = lines;
  if (claimed.length > MAX_LINES_PER_DRAIN) {
    // Keep the NEWEST, not the oldest: a backlog this size means the server was down, and "what
    // has been happening recently" is the question a dashboard is actually asked.
    dropped = claimed.length - MAX_LINES_PER_DRAIN;
    claimed = claimed.slice(-MAX_LINES_PER_DRAIN);
  }

  const batch = [];
  let skipped = 0;
  for (const line of claimed) {
    const parsed = parseLine(line);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    batch.push({ ...parsed, id: observationId(line) });
  }

  let inserted = 0;
  if (batch.length) {
    const principalIdByLoomId = resolvePrincipals(store, batch);
    const rows = [];
    for (const entry of batch) {
      // resolvePrincipals always returns an id now — a real one, or a loom-derived placeholder it
      // will sweep onto the real row later. A null here would mean a loom with no id at all, which
      // parseLine already refuses, so this stays as the belt-and-braces it is.
      const principalId = principalIdByLoomId.get(entry.identity.loomId);
      if (!principalId) {
        skipped += 1;
        continue;
      }
      rows.push({
        id: entry.id,
        principalId,
        toolName: entry.toolName,
        detail: entry.detail,
        ts: entry.ts,
        outcome: entry.outcome,
        reason: entry.reason,
        sessionId: entry.sessionId,
        actorLoomId: entry.identity.loomId,
        actorHumanName: entry.identity.humanName,
        actorAgentType: entry.identity.agentType,
        actorBackend: entry.identity.backend,
        actorField: entry.identity.field,
        osUser: entry.identity.osUser,
        hostname: entry.identity.hostname,
      });
    }
    try {
      inserted = store.insertNativeToolEvents(rows);
      reclaimPlaceheldObservations(store);
    } catch (err) {
      // The spool is already claimed, so a failure here loses this batch. Logged rather than
      // rethrown: an observability batch must not take down the interval that drains the next one.
      console.error('[native-observations] insert failed, batch lost:', err.message);
    }
  }

  try {
    fs.unlinkSync(DRAINING_PATH);
  } catch {
    /* a leftover file is re-claimed next cycle; the content-derived ids make that a no-op */
  }

  if (dropped) {
    console.warn(
      `[native-observations] spool backlog exceeded ${MAX_LINES_PER_DRAIN} lines — dropped the ${dropped} oldest`
    );
  }
  return { inserted, dropped, skipped };
}

let timer = null;

/**
 * Starts the recurring drain. `unref()`d for the same reason the cache warmer's timer is: this is
 * background upkeep, and it must not be the thing keeping a process alive that is otherwise done.
 */
function startNativeObservationDrain(store) {
  if (timer) return timer;
  const prune = () => {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
      store.pruneNativeToolEvents(cutoff);
    } catch (err) {
      console.error('[native-observations] prune failed:', err.message);
    }
  };
  const tick = () => {
    try {
      drainNativeObservations(store);
      prune();
    } catch (err) {
      console.error('[native-observations] drain cycle failed:', err.message);
    }
  };
  tick(); // catch up on whatever accumulated while the server was down, before the first interval
  timer = setInterval(tick, DRAIN_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopNativeObservationDrain() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startNativeObservationDrain,
  stopNativeObservationDrain,
  drainNativeObservations,
  observationId,
  parseLine,
  placeholderPrincipalId,
  isPlaceholder,
  // Exported for nativeObservations-test.js, which drives them with a fake store: the regression
  // they encode (a replica refusing the principal upsert and the drain dropping the whole batch)
  // is in the resolution step alone, and reaching it through a real spool file would race the
  // running service for the same journal.
  resolvePrincipals,
  reclaimPlaceheldObservations,
  NATIVE_JOURNAL_PATH,
  DRAINING_PATH,
  DRAIN_INTERVAL_MS,
  RETENTION_DAYS,
};
