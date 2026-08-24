'use strict';
// Ships this node's HOOK INTEGRITY to central as node health — docs/design/dashboard-placement.md,
// item 2.
//
// The problem it closes is stated there in one line: hook integrity is node-local only. Every check
// in server/hooks/lib.js runs only because the harness actually invokes pre-tool-use.js, and that
// invocation is one JSON entry in a config file on the machine's own disk. server/hookWatcher.js
// notices when that entry goes missing and puts it back — but it notices *on that machine*, into a
// kv row *on that machine*, readable only from a dashboard served *by that machine*. So "is
// governance actually wired on that box" has been a question you answer by visiting the box.
//
// Central already keeps a node roster with `lastSeen` (server/central/centralMigrations.js
// migration 1). Hook status belongs beside it, and once it is there the question becomes a fleet
// query: one row per machine, and the interesting ones are the machines whose hooks are missing.
//
// WHY THIS IS NOT SHIPPED THROUGH THE USAGE OUTBOX. An outbox row is a durable, hash-chained,
// at-least-once *event* — a thing that happened, which central must eventually hold or the audit
// log has a hole. Node health is the opposite kind of fact: it is current state, it is worth
// nothing once superseded, and a report that never arrives costs nothing because the next one
// carries the same answer. Queueing it would put unbounded retries of a value nobody wants behind
// events that are irreplaceable. So it posts on a timer, last-write-wins, and a failure is a log
// line.
//
// WHAT IT IS NOT. This ships a STATUS, not the tamper log's contents beyond a bounded summary. The
// tamper log stays local: it names config paths on a user's own machine, it is unbounded, and the
// fleet question is "is this box wired" rather than "replay everything that ever happened to this
// box's settings.json".
//
// SINCE docs/design/disposable-nodes.md §5, IT CARRIES THREE MORE THINGS, and the reason they are
// here rather than on a channel of their own is that §5 names this file for it: a report that goes
// out on a slow timer and flushes immediately on a security-relevant local event is exactly the
// shape all three need.
//
//   divergence   the enforcement pause and the grace lease — the only two ways a node can widen
//                what it allows, and until now invisible to the fleet that is supposedly governing
//                it. See localDivergence.
//   credential   how long this node's own certificate has left. §2.2: an expiry used to present as
//                "never enrolled" and take the node silently offline. This is the warning.
//   journal      the fault journal itself, incrementally. That one IS a log rather than a status,
//                and it is the exception to everything the paragraph above says about queueing —
//                see the block on local divergence for how the cursor keeps it honest.

const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const { envCompat, FAULT_JOURNAL_PATH } = require('./config');
const { resolveTransport, REQUEST_TIMEOUT_MS } = require('./usageShipper');
const { listProviders } = require('./providers');
const { readEnforcementPause, pauseRemainingMs, ALL_TIERS } = require('./enforcementPause');
const { readGraceLease } = require('./maintenance');
const { credentialStatus } = require('./enrollment/renewal');

const CENTRAL_URL = envCompat('CENTRAL_URL') || null;
const HEALTH_INGEST_PATH = envCompat('CENTRAL_HEALTH_INGEST_PATH') || '/api/ingest/node-health';

// Slow on purpose. Hook wiring changes when a human or a compromised process edits a config file —
// which is rare — and the watcher's own fs.watch catches that within 250 ms and pokes `reportNow`
// below. The timer is the backstop for a report that was lost in transit and for a node that has
// been quiet, so its job is to bound staleness on the roster, not to detect anything.
const REPORT_INTERVAL_MS = Number(envCompat('HEALTH_REPORT_INTERVAL_MS')) || 5 * 60_000;

// How many tamper entries travel with the report. Enough that "when did this start" is answerable
// from the roster; far short of the local journal, which is capped at 200 and is the copy to read
// when the answer matters.
const TAMPER_SAMPLE = 5;

// ------------------------------------------------------------------------------------------------
// LOCAL DIVERGENCE — docs/design/disposable-nodes.md §5, "narrowing is free, widening is reported".
//
// §5's honest restatement is that both of these are true at once. A node CANNOT WRITE A GRANT:
// PolicyReadOnlyError refuses every policy mutator from every caller, including code written next
// year. And a node CAN OVERTURN A HEALTHY CENTRAL DENY for thirty minutes at a time, on its own
// signature, and central never learns — because an enforcement pause is minted locally, gated on a
// local admin certificate central can neither issue nor revoke.
//
//   Node columns on a grant row:                0
//   Ways a node can widen its effective grants: 2   (the pause, and the grace lease)
//   Of those, visible at central:               0
//
// §5's recommendation is not to close the widening — it is time-boxed and tier-scoped already, and
// those bounds are real — but to make it VISIBLE, and to reuse this file for it: node health
// already reports on a slow timer AND flushes immediately on a hook tamper, and a pause is
// precisely that shape of event. Deliberate, bounded, security-relevant, machine-local.
//
// So the payload grows two things:
//
//   `divergence`  the pause and the lease as current state, last-write-wins like everything else
//                 here. "Is that box still enforcing" becomes a fleet query.
//   `journal`     the evidence. A pause suppresses denials silently — nothing fails while one is on
//                 — so the count of what it let through lives only in hook-fault-journal.jsonl,
//                 which §3 lists first among the four things that never leave the machine.
//
// THE JOURNAL IS THE ONE PART THAT IS NOT LAST-WRITE-WINS, and it cannot be: it is a log, not a
// state. So it ships incrementally behind a byte cursor, bounded per report, and the cursor only
// advances on an acknowledged delivery. Central deduplicates on a content hash, so a cursor lost to
// a rebuild costs a re-ship rather than a duplicate.
// ------------------------------------------------------------------------------------------------

/** Where this node's cursor into its own fault journal is kept. See store.getNodeMark. */
const JOURNAL_CURSOR_KEY = 'nodeHealth.faultJournalCursor';
// Per-report ceilings. The journal is append-only and never trimmed, so a node that has been
// partitioned for a week has a lot of it; these bound one POST rather than the total, and the next
// tick five minutes later carries the next slice.
const JOURNAL_MAX_LINES = Number(envCompat('HEALTH_JOURNAL_MAX_LINES')) || 400;
const JOURNAL_MAX_BYTES = Number(envCompat('HEALTH_JOURNAL_MAX_BYTES')) || 192 * 1024;

let timer = null;
let store = null;
let target = null;
let inFlight = false;
let consecutiveFailures = 0;

/**
 * The health of this machine's hook wiring, as one word plus the evidence for it.
 *
 * The four answers are deliberately not a boolean, because "not installed" has two completely
 * different meanings and conflating them would make the fleet view useless:
 *
 *   installed   every adapter this workspace turned on is wired up right now.
 *   tampered    an adapter that WAS installed is not any more. Governance is bypassed for that
 *               backend until the watcher's repair lands — and if the repair failed, indefinitely.
 *   missing     an adapter this workspace turned on has wiring the watcher could not restore.
 *   unknown     nothing installable on this machine (no adapter has a known config path yet), so
 *               there is nothing to be right or wrong about. NOT reported as healthy: a node with
 *               no hooks installs governs nothing, and a green row would say the opposite.
 */
function hookHealth(storeModule = store) {
  if (!storeModule) throw new Error('nodeHealth: no store — call startNodeHealthReporter first, or pass one');
  const providers = listProviders();
  const integrity = storeModule.getHookIntegrity();
  const everInstalled = integrity.everInstalled || {};
  const log = Array.isArray(integrity.log) ? integrity.log : [];

  const installable = providers.filter((p) => p.installable);
  // "Should be installed" is the watcher's own rule (server/providers.js checkAndRepair), reused
  // rather than restated: an adapter nobody ever turned on is not missing, it is unused, and
  // reporting a fleet-wide amber for every machine that does not run Antigravity would be an alarm
  // that always rings.
  const expected = installable.filter((p) => everInstalled[p.id]);
  const broken = expected.filter((p) => !p.installed);
  const unreadable = providers.filter((p) => p.error);

  let status;
  if (!installable.length) status = 'unknown';
  else if (broken.length) status = 'missing';
  else if (log.some((e) => e.repaired === false)) status = 'tampered';
  else status = expected.length ? 'installed' : 'unknown';

  return {
    status,
    // The roster's headline number: how many backends on this machine are governed right now.
    installedCount: installable.filter((p) => p.installed).length,
    installableCount: installable.length,
    expectedCount: expected.length,
    brokenCount: broken.length,
    tamperCount: log.length,
    lastTamperAt: log.length ? log[0].ts : null,
    providers: providers.map((p) => ({
      id: p.id,
      label: p.label,
      installed: p.installed,
      installable: p.installable,
      // The config path is a filename on somebody's own PC. It travels because the one action a
      // fleet operator takes off this row is "go and run npm run providers:install on that box",
      // and knowing which file is the difference between that being one command and a hunt.
      configPath: p.configPath,
      error: p.error || null,
    })),
    unreadable: unreadable.map((p) => ({ id: p.id, error: p.error })),
    recentTampers: log.slice(0, TAMPER_SAMPLE).map((e) => ({
      ts: e.ts, provider: e.provider, reason: e.reason, repaired: e.repaired,
    })),
  };
}

/**
 * The two levers this node holds that WIDEN what it allows, as current state.
 *
 * Both are already bounded — the pause to 30 minutes and named tiers, the lease to 60 minutes and
 * the two non-destructive tiers — and neither can write a grant. What was missing is that neither
 * was visible anywhere but on the machine itself.
 *
 * `enforcing` is the headline, and it is deliberately false for a pause and true for a lease: a
 * lease softens FAULTS, which is degradation the fleet already expects during an upgrade, while a
 * pause overrides a healthy registry's real "no". Those are different questions and a single amber
 * would blur them.
 */
function localDivergence(now = Date.now()) {
  const pause = readEnforcementPause(now);
  const lease = readGraceLease(now);
  return {
    enforcing: !pause,
    pause: pause ? {
      id: pause.id,
      issuedAt: new Date(pause.issuedAt).toISOString(),
      until: new Date(pause.until).toISOString(),
      remainingMs: pauseRemainingMs(pause, now),
      tolerate: pause.tolerate,
      // True when the pause names every tier, which is the one shape that also suppresses denials
      // whose tier could not be determined at all. Computed here rather than left to be re-derived
      // at central from the tier list, because that derivation is a rule
      // (server/enforcementPause.js pauseCoversUnknownTier) and rules drift when they are copied.
      coversUnknownTier: ALL_TIERS.every((t) => pause.tolerate.includes(t)),
      reason: pause.reason || null,
      issuedBy: pause.issuedBy || null,
    } : null,
    lease: lease ? {
      id: lease.id || null,
      issuedAt: lease.issuedAt ? new Date(lease.issuedAt).toISOString() : null,
      until: new Date(lease.until).toISOString(),
      remainingMs: Math.max(0, lease.until - now),
      tolerate: lease.tolerate,
      reason: lease.reason || null,
    } : null,
  };
}

/**
 * The next slice of this node's fault journal, from `cursor` bytes in.
 *
 * TRUNCATION AND ROTATION ARE HANDLED BY MEASUREMENT, not by trust: if the file is now SHORTER than
 * the cursor, something replaced it and the cursor points into a file that no longer exists, so it
 * restarts from zero. Re-sending is safe (central dedupes on the line hash); skipping would lose
 * the evidence this whole mechanism exists to carry.
 *
 * A partial trailing line is left unshipped and uncursored — a hook may be mid-append — so the next
 * pass picks it up whole. That is why `nextCursor` is computed from the bytes actually consumed
 * rather than from the file size.
 */
function readJournalSlice(cursor = 0, { maxLines = JOURNAL_MAX_LINES, maxBytes = JOURNAL_MAX_BYTES } = {}) {
  let stat;
  try {
    stat = fs.statSync(FAULT_JOURNAL_PATH);
  } catch {
    return { entries: [], cursor: 0, nextCursor: 0, remainingBytes: 0, restarted: false };
  }
  const restarted = cursor > stat.size;
  const from = restarted ? 0 : cursor;
  if (from >= stat.size) return { entries: [], cursor: from, nextCursor: from, remainingBytes: 0, restarted };

  const length = Math.min(maxBytes, stat.size - from);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(FAULT_JOURNAL_PATH, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, from);
  } finally {
    fs.closeSync(fd);
  }

  const entries = [];
  let consumed = 0;
  let offset = 0;
  const text = buffer.toString('utf8');
  for (;;) {
    if (entries.length >= maxLines) break;
    const newline = text.indexOf('\n', offset);
    if (newline === -1) break; // a partial line — leave it for the next pass
    const line = text.slice(offset, newline);
    consumed = Buffer.byteLength(text.slice(0, newline + 1), 'utf8');
    offset = newline + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; } // a torn line is skipped, not fatal
    entries.push({
      // Content-derived, so the same line shipped twice is the same row at central. This is what
      // makes an incremental cursor safe to lose.
      id: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 32),
      ...parsed,
    });
  }
  return {
    entries,
    cursor: from,
    nextCursor: from + consumed,
    remainingBytes: stat.size - (from + consumed),
    restarted,
  };
}

/**
 * THE MACHINE-FACTS TIER, REPORTED UP — docs/design/disposable-nodes.md §6, and the fix for two of
 * §3's four leaks.
 *
 * §6's middle tier is "what is true about this box": the node is authoritative, central cannot know
 * it and should not guess — "but it should SEE it. Discovery sources are the one signal in the whole
 * flow table that still never leaves."
 *
 * Two of §3's four never-leave items are exactly this shape, and both are listed there because
 * losing them costs something real that a rescan cannot recover:
 *
 *   discovery_sources               A rescan reproduces the DEFAULTS. It does not reproduce a
 *                                   source somebody added, or one they deliberately disabled.
 *   kv.hook_integrity.everInstalled Which adapters were ever turned on — the input to hookHealth's
 *                                   "expected" set. Lose it and a MISSING hook reads as UNKNOWN,
 *                                   which is the difference between an alarm and a shrug.
 *   kv.packages_enabled             Which capability packages this workspace runs. Lose it and
 *                                   every package silently reverts to `enabledByDefault`.
 *
 * REPORTED, NOT PUSHED BACK. Central holds these so a rebuilt machine's operator can see what the
 * old one had; it does not re-impose them, because §6's whole split is that the node is
 * authoritative for this tier. Restoring them is a decision a human makes with the record in front
 * of them, not something that happens silently to a fresh box.
 *
 * The two remaining §3 leaks are deliberately NOT here. `windrow_audit` and `policy_changes` are
 * dead weight under central authority rather than leaks — nothing writes them once authority moves,
 * and central's own copies are the only ones that can be right.
 */
function machineFacts(storeModule = store) {
  if (!storeModule) return null;
  const safely = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const integrity = safely(() => storeModule.getHookIntegrity(), {}) || {};
  return {
    // Paths on somebody's own PC, and they travel for the same reason the hook config path already
    // does on this report: the action an operator takes off this row is "go and add that source
    // back on the new box", and knowing which path is the difference between that being one command
    // and an archaeology exercise.
    discoverySources: safely(() => storeModule.listDiscoverySources(), []).map((s) => ({
      path: s.path,
      label: s.label ?? null,
      kind: s.kind ?? null,
      enabled: Boolean(s.enabled),
      builtIn: Boolean(s.builtIn),
      writable: Boolean(s.writable),
    })),
    everInstalled: integrity.everInstalled || {},
    packagesEnabled: safely(() => storeModule.getPackagesState(), {}) || {},
    // §6's bootstrap/machine-fact boundary, made visible: the one filesystem root central genuinely
    // cannot invent, and the one whose being wrong makes every hook path on the machine wrong.
    userHome: process.env.WINDROW_USER_HOME || null,
  };
}

function post(body, nodeId) {
  return new Promise((resolve, reject) => {
    const url = new URL(HEALTH_INGEST_PATH, target.base);
    const req = target.module.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        agent: target.agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-windrow-node-id': nodeId,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* an empty or non-JSON 200 is still an ack */ }
            return resolve(parsed || {});
          }
          reject(new Error(`central returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Send one report. Safe to call at any time and from anywhere; a no-op without a central.
 *
 * Returns the report that was accepted, or null. Nothing is queued on failure — see the header for
 * why current state is the one kind of fact a retry queue makes worse rather than better.
 */
async function reportNow() {
  if (!store || !target || inFlight) return null;
  inFlight = true;
  try {
    const nodeId = store.nodeId();
    const cursor = Number(store.getNodeMark(JOURNAL_CURSOR_KEY, 0)) || 0;
    const slice = readJournalSlice(cursor);
    if (slice.restarted) {
      console.warn(
        `[node-health] the fault journal is shorter than this node's cursor (${cursor}) — it was truncated or `
        + 'replaced. Re-shipping from the start; central deduplicates on the line hash.'
      );
    }
    const report = {
      nodeId,
      reportedAt: new Date().toISOString(),
      hooks: hookHealth(),
      // §5: the two levers this node holds that can widen what it allows.
      divergence: localDivergence(),
      // §2.2: an expired credential must never again look like an absent one. It travels on the
      // health report because that is the channel that still works when the credential does not —
      // this POST authenticates with it, so a report that ARRIVES saying "expiring" is the last
      // warning central will get before the node goes quiet.
      credential: credentialStatus(),
      // §6's machine-fact tier: what is true about this box that central cannot work out.
      facts: machineFacts(),
      // §5's evidence: what a pause actually suppressed, and every other decision made without the
      // server. Incremental — see readJournalSlice.
      journal: {
        entries: slice.entries,
        fromByte: slice.cursor,
        throughByte: slice.nextCursor,
        remainingBytes: slice.remainingBytes,
      },
    };
    const ack = await post(JSON.stringify(report), nodeId);
    // THE CURSOR ADVANCES ONLY ON AN ACK THAT UNDERSTOOD THE JOURNAL, and only past what central
    // actually took. A cursor moved on a hopeful send is how a partitioned node loses the exact
    // window it most needs to explain — and a central predating §5 answers 200 to this POST while
    // dropping the journal on the floor, so a numeric `journalAccepted` is the only thing that
    // proves the other end has somewhere to put it.
    if (slice.entries.length && ack && typeof ack.journalAccepted === 'number') {
      store.setNodeMark(JOURNAL_CURSOR_KEY, slice.nextCursor);
    }
    if (consecutiveFailures > 0) {
      console.log(`[node-health] central reachable again — reported after ${consecutiveFailures} failed attempt(s).`);
    }
    consecutiveFailures = 0;
    return report;
  } catch (err) {
    consecutiveFailures += 1;
    // A node that cannot reach central still enforces, and its hook wiring is still watched and
    // repaired locally — so this is a visibility outage, not a governance one, and it says so
    // rather than escalating on the first miss.
    const say = consecutiveFailures >= 5 ? console.error : console.warn;
    say(
      `[node-health] could not report hook integrity to central (attempt ${consecutiveFailures}): ${err.message}.`,
      'Hook wiring is still watched and repaired on this machine; only the fleet view is stale.'
    );
    return null;
  } finally {
    inFlight = false;
  }
}

/**
 * Wire it up and start the timer. A no-op without a central — on a standalone install the
 * dashboard on this machine reads `GET /api/hook-integrity` directly and there is no fleet to tell.
 */
function startNodeHealthReporter(storeModule) {
  if (timer) return timer;
  if (!CENTRAL_URL) return null;
  const resolved = resolveTransport(CENTRAL_URL);
  if (resolved.error) {
    console.error(`[node-health] not reporting to ${CENTRAL_URL} — ${resolved.error}`);
    return null;
  }
  // The same identity check the usage and alert shippers make, for the same reason: a credential
  // directory copied between machines would file one machine's hook status against another's
  // roster row, and an operator would go and fix a PC that was never broken.
  if (resolved.nodeId && resolved.nodeId !== storeModule.nodeId()) {
    console.error(
      `[node-health] credential was issued to node ${resolved.nodeId} but this node is ${storeModule.nodeId()}`,
      '— refusing to report. Enroll this node for its own certificate.'
    );
    resolved.agent.destroy();
    return null;
  }
  store = storeModule;
  target = { base: CENTRAL_URL, module: resolved.module, agent: resolved.agent };

  // Immediately, before the first interval: a node that has just come up is exactly the node whose
  // roster row is most out of date, and a rebuilt one has no row at all.
  reportNow().catch(() => {});
  timer = setInterval(() => { reportNow().catch(() => {}); }, REPORT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref(); // background upkeep must not hold the process open
  console.log(
    `[node-health] reporting hook integrity to ${new URL(HEALTH_INGEST_PATH, CENTRAL_URL).href}`,
    `every ${Math.round(REPORT_INTERVAL_MS / 1000)}s, and immediately on any tamper.`
  );
  return timer;
}

function stopNodeHealthReporter() {
  if (timer) clearInterval(timer);
  timer = null;
  if (target && target.agent && typeof target.agent.destroy === 'function') target.agent.destroy();
  target = null;
  store = null;
  inFlight = false;
  consecutiveFailures = 0;
}

module.exports = {
  startNodeHealthReporter,
  stopNodeHealthReporter,
  reportNow,
  hookHealth,
  localDivergence,
  machineFacts,
  readJournalSlice,
  JOURNAL_CURSOR_KEY,
  CENTRAL_URL,
  HEALTH_INGEST_PATH,
  REPORT_INTERVAL_MS,
};
