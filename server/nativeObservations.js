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
 * Resolves each distinct loomId in a batch to a principal exactly the way POST /api/principals/
 * resolve does — same `principalRoleName` + `upsertPrincipalIdentity` pair — so a native
 * observation lands on the *same* principal row the loom's governed calls land on. Anything else
 * and the dashboard would show one agent twice.
 *
 * Memoized per drain because a batch is overwhelmingly one or two looms making hundreds of calls.
 */
function resolvePrincipals(store, batch) {
  const byLoomId = new Map();
  for (const entry of batch) {
    if (byLoomId.has(entry.identity.loomId)) continue;
    try {
      const { instance } = store.upsertPrincipalIdentity(principalRoleName(entry.identity), entry.identity);
      byLoomId.set(entry.identity.loomId, instance ? instance.id : null);
    } catch (err) {
      // One unresolvable loom must not cost the batch every other loom's rows.
      console.error('[native-observations] could not resolve principal for', entry.identity.loomId, err.message);
      byLoomId.set(entry.identity.loomId, null);
    }
  }
  return byLoomId;
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
  NATIVE_JOURNAL_PATH,
  DRAINING_PATH,
  DRAIN_INTERVAL_MS,
  RETENTION_DAYS,
};
