'use strict';
// THE ENFORCEMENT PAUSE — "turn off denials for X minutes".
//
// What it is for: debugging and testing. When you are trying to work out why a tool call behaves
// the way it does, an enforcement layer that denies half of what you try is a second variable in
// an experiment that already has one. This turns denials off for a bounded window so the thing
// under test is the only thing failing.
//
// HOW IT DIFFERS FROM THE MAINTENANCE GRACE LEASE (server/maintenance.js), which is the file this
// one is modelled on and is deliberately NOT an extension of:
//
//   grace lease  softens FAULTS. It is consulted only when governance did not answer, and it never
//                overrides a real "no" from a healthy registry. A revoked grant still denies under
//                a lease. It exists so an upgrade does not deny the field.
//   pause        overrides DECISIONS. A healthy registry says "no active grant" and the call is
//                allowed anyway. That is the entire point, and it is why this is a separate,
//                separately-named, separately-logged, more tightly-bounded thing: an operator
//                opening a debugging window must not be able to believe they opened a maintenance
//                one, and a reader of the audit trail must be able to tell the two apart.
//
// SO IT IS A REAL BYPASS, and it is bounded the same four ways the lease is, plus two:
//
//   1. MINTED BY THE SERVER, while it is up and serving, HMAC-signed with the agent token. There is
//      no offline path that writes one. An attacker who kills the API to force a fail-open cannot
//      sign a pause, because signing requires the thing they just killed
//      — and that property has to survive every change made to this file.
//   2. TIME-BOXED, and shorter than the lease: 5 minutes minimum, 30 maximum. A debugging window
//      you forget about costs half an hour, not an afternoon. An expired pause is no pause, so it
//      re-tightens on its own with nobody doing anything.
//   3. ADMIN-SCOPED. The routes that mint it are requireAdmin, so the agent token every hook
//      carries cannot open one — otherwise any governed call could pause the thing governing it.
//   4. TIER-SCOPED. `tolerate` names the risk tiers whose denials are suppressed, defaulting to
//      read_only + mutating. `destructive` is allowed but ONLY when named explicitly: an operator
//      who types "pause denials" gets a window that still stops a destructive call, and one who
//      means to include those has to say so.
//   5. LOUD. Every suppressed denial is journalled to the same fault journal as every other
//      degraded decision, tagged `enforcement-pause`, with the pause id on it — so "what ran while
//      enforcement was off" is a query over a file rather than a gap. The server logs a heartbeat
//      the whole time one is in force and logs again when it lapses.
//   6. DOUBLY SIGNED WHEN IT NAMES EVERY TIER. Bound 3 keeps the agent token every hook carries
//      from MINTING a pause through the API. But the agent token also SIGNS the pause file, and the
//      model already accepts that a process which can read it can forge a signed file — tolerable
//      for a tier-scoped pause, too cheap for the all-tier one, which is the only pause that
//      suppresses destructive and unknown-tier denials (see pauseCoversUnknownTier). So an all-tier
//      pause carries a SECOND HMAC signature under a separate OWNER-ONLY key (server/auth.js) that
//      never rides a request and that a hook only ever READS to verify, never mints with. A file
//      naming every tier without that co-signature — the shape the hook-readable agent token alone
//      can produce — is discarded as if there were no pause. It is still symmetric HMAC, so reading
//      the owner key file still forges; what it removes is the cheaper path where the wire-borne
//      agent token was on its own enough to turn off every denial including destructive.
//
// WHAT IT NEVER SUPPRESSES, because these are not policy decisions about a principal's grants:
//   * the direct-shell-access-to-the-governance-API deny (server/hooks/lib.js). That is a standing
//     rule against replicating a hook without going through one, and a debugging window is exactly
//     the cover a bypass of it would want.
//   * a denial whose risk tier is UNKNOWN — an unresolvable capability, or one missing from a stale
//     replica. `tolerate` is a list of tiers, and a tier we could not determine cannot be on it.
//     The one exception is a pause that names ALL THREE tiers, which is an operator saying "every
//     tier", and an unknown tier is necessarily one of them.
//   * a REVOCATION. A grant on the deny-list is central saying "stop", not this node saying "you
//     never had one", and server/hooks/lib.js already enforces it even when the rest of the policy
//     channel is not trusted. The pause suppresses "you have no grant for this"; it does not
//     suppress "your access to this was taken away", which is the one denial most likely to have
//     been issued *because* of what someone was doing when they wanted a debugging window.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Two keys, not one. AGENT_TOKEN signs every pause; OWNER_SIGNING_KEY signs the all-tier one a
// SECOND time. The agent token is the bearer credential every hook holds and puts on the wire, so
// the model already accepts that reading it lets you forge a signed file — tolerable for a
// tier-scoped pause, too cheap for the all-tier pause that suppresses even destructive and
// unknown-tier denials. The owner key never rides a request and is only ever read (never minted
// with) by a hook, so the token that leaks off the wire is no longer enough for an all-tier pause.
// See bound 1 in the header and the comment on OWNER_SIGNING_KEY in server/auth.js.
const { AGENT_TOKEN, OWNER_SIGNING_KEY } = require('./auth');
// The policy-parameter tier: which of this node's ceilings central states, and which way each
// narrows (docs/design/disposable-nodes.md §6). `replica` is where the last-pulled block landed.
const { nodeConfigValue } = require('./policy/nodeConfig');
const replica = require('./policy/replica');

const { DATA_DIR } = require('./config');
const PAUSE_PATH = path.join(DATA_DIR, 'hook-enforcement-pause.json');

// The window. Deliberately narrower than the grace lease's 60 minutes: this one overrides real
// decisions, so the cost of forgetting it is higher and the ceiling is lower.
const MIN_PAUSE_MS = 5 * 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const DEFAULT_PAUSE_MS = 15 * 60_000;

const ALL_TIERS = ['read_only', 'mutating', 'destructive'];
// What you get when you do not say. `destructive` is absent — see bound 4 in the header.
const DEFAULT_TIERS = ['read_only', 'mutating'];

function sign(payload) {
  return crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
}

// The second signature. Applied ONLY to a pause that names every tier — the one artifact whose
// forgery the agent token alone must not be able to accomplish (bound 6). A pause naming fewer
// tiers carries no `ownerSig` and needs none.
function signOwner(payload) {
  return crypto.createHmac('sha256', OWNER_SIGNING_KEY).update(payload).digest('hex');
}

// Whether a pause names all three tiers. This is the escalation the owner key exists to gate: an
// all-tier pause is the only one that suppresses destructive and unknown-tier denials (see
// pauseCoversUnknownTier), so it is the only one that must survive an attacker holding the agent
// token but not the owner key.
function namesAllTiers(data) {
  return Boolean(data) && Array.isArray(data.tolerate) && ALL_TIERS.every((t) => data.tolerate.includes(t));
}

// Constant-time equality of two hex signatures. A length mismatch is an immediate no rather than a
// throw from timingSafeEqual on unequal buffers.
function sigEquals(a, expected) {
  if (typeof a !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(expected);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function writeSigned(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(data);
  const envelope = { payload, sig: sign(payload) };
  // An all-tier pause is co-signed with the owner key. A healthy server mints it here; a hook only
  // ever reaches readSigned below, so it can verify this second signature but never produce one.
  if (namesAllTiers(data)) envelope.ownerSig = signOwner(payload);
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  fs.renameSync(tmp, filePath); // write-then-rename: a hook reading mid-write never sees a partial body
}

function readSigned(filePath) {
  const { payload, sig, ownerSig } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  if (!sigEquals(sig, sign(payload))) return null; // tampered, or another token's
  const data = JSON.parse(payload);
  // The escalation gate. An all-tier pause is honoured ONLY with a valid owner-key co-signature; a
  // file that names every tier but lacks it — the shape an attacker with just the agent token can
  // produce — is discarded, which reads to every caller as "no pause" and so leaves enforcement ON,
  // the safe direction to round. A pause naming fewer tiers never carries `ownerSig` and this skips.
  if (namesAllTiers(data) && !sigEquals(ownerSig, signOwner(payload))) return null;
  return data;
}

/**
 * The active pause, or `null`. Never throws: absent, malformed, tampered and expired all mean the
 * same thing to every caller — enforcement is ON — and that is the safe direction to round in. A
 * pause file nobody can read must not be the reason a tool call dies, and must not be the reason
 * one is allowed either.
 */
function readEnforcementPause(now = Date.now()) {
  let pause;
  try {
    pause = readSigned(PAUSE_PATH);
  } catch {
    return null; // absent, or unparseable
  }
  if (!pause || typeof pause.until !== 'number') return null;
  if (pause.until <= now) return null; // expired — an expired pause is no pause
  const tolerate = Array.isArray(pause.tolerate) ? pause.tolerate.filter((t) => ALL_TIERS.includes(t)) : [];
  if (!tolerate.length) return null;
  return { ...pause, tolerate };
}

/** True when a pause is in force AND names this risk tier — the only question the hook asks. */
function pauseCovers(pause, riskTier) {
  return Boolean(pause && pause.tolerate.includes(riskTier));
}

/**
 * True when the pause covers a denial whose tier we could not determine. Only a pause naming every
 * tier does: with anything less, "which tier is this?" has no answer and so cannot be matched
 * against the list. See the header's last paragraph.
 */
function pauseCoversUnknownTier(pause) {
  return Boolean(pause && ALL_TIERS.every((t) => pause.tolerate.includes(t)));
}

/** Milliseconds left, or 0. For log lines and the status route. */
function pauseRemainingMs(pause, now = Date.now()) {
  return pause ? Math.max(0, pause.until - now) : 0;
}

/**
 * Parse a human duration into milliseconds: "20m", "90s", "1200000", 1200000. Returns null for
 * anything it cannot read, so a caller can tell "not specified" from "specified as nonsense" and
 * refuse the second rather than silently substituting a default.
 */
function parseDurationMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] || 'ms'];
  return n * unit;
}

/**
 * Mints a pause. Called by the server while it is still serving — that timing IS the security
 * property (bound 1), so there is no offline or CLI path that writes one without a healthy server
 * having agreed to it.
 *
 * A duration outside [MIN, MAX] is CLAMPED rather than refused, because the operator asking for 2
 * hours wants the longest window available and refusing them a window entirely helps nobody; the
 * returned lease says what they actually got, and every caller prints it. A duration that could
 * not be *parsed* is a different thing and is refused — see parseDurationMs.
 */
function beginEnforcementPause({ durationMs, reason = 'debugging', tolerate, issuedBy = null } = {}) {
  const requested = tolerate === undefined ? DEFAULT_TIERS : tolerate;
  if (!Array.isArray(requested)) {
    const err = new Error(`tolerate must be an array of tiers (allowed: ${ALL_TIERS.join(', ')})`);
    err.status = 400;
    throw err;
  }
  const rejected = requested.filter((t) => !ALL_TIERS.includes(t));
  if (rejected.length) {
    const err = new Error(`unknown risk tier: ${rejected.join(', ')} (allowed: ${ALL_TIERS.join(', ')})`);
    err.status = 400;
    throw err;
  }
  // An explicit empty list is refused rather than defaulted, for the same reason server/maintenance.js
  // refuses it: filling it in would hand back MORE than was asked for, and a caller who wants no
  // window simply does not open one.
  if (!requested.length) {
    const err = new Error(`a pause must name at least one tier (allowed: ${ALL_TIERS.join(', ')})`);
    err.status = 400;
    throw err;
  }
  const parsed = durationMs === undefined || durationMs === null ? null : parseDurationMs(durationMs);
  if (parsed === null && durationMs !== undefined && durationMs !== null) {
    const err = new Error(`could not read duration "${durationMs}" — use e.g. 20m, 900s, or a number of ms`);
    err.status = 400;
    throw err;
  }
  // CENTRAL'S CEILING, NARROWED BY THIS NODE'S OWN — docs/design/disposable-nodes.md §5 and §6.
  //
  // §5: "If central should be able to FORBID a pause rather than merely learn of one, that also
  // lives on the profile — `allowPause: false`, or a `maxPauseTier` — and it works for the same
  // reason the ceiling does: it can only narrow." This is that, and the numbers arrive on the
  // policy response beside the deny-list rather than through anything new.
  //
  // Read at MINT TIME rather than at module load, which is the difference between a ceiling and a
  // suggestion: this process may have been running since before the profile existed.
  const nodeConfig = replica.loadNodeConfig();
  if (!nodeConfigValue('allowPause', nodeConfig)) {
    const err = new Error(
      'this node’s profile forbids enforcement pauses. The fleet has decided this machine may not '
      + 'suppress denials; an admin at central can change its profile.'
    );
    err.status = 403;
    throw err;
  }
  const allowedTiers = nodeConfigValue('pauseTiers', nodeConfig);
  const forbidden = requested.filter((t) => !allowedTiers.includes(t));
  if (forbidden.length) {
    // REFUSED, not silently narrowed. Handing back a window that covers less than was asked for is
    // how an operator ends up believing a tier is paused when it is not — the same argument the
    // empty-`tolerate` check above makes, in the other direction.
    const err = new Error(
      `this node's profile allows pausing [${allowedTiers.join(', ')}] only; refusing ${forbidden.join(', ')}`
    );
    err.status = 403;
    throw err;
  }
  // Both ceilings apply, and the tighter wins — MAX_PAUSE_MS is this build's hard bound and
  // `pauseMaxMs` is the fleet's, and neither is allowed to relax the other. A caller who asked for
  // longer is still CLAMPED rather than refused (the returned lease says what they actually got,
  // and every caller prints it); a caller naming a tier they may not pause is REFUSED, because
  // silently granting fewer tiers than asked is a different and much worse kind of surprise.
  const ceilingMs = Math.min(MAX_PAUSE_MS, nodeConfigValue('pauseMaxMs', nodeConfig));
  const defaultMs = Math.min(nodeConfigValue('pauseDefaultMs', nodeConfig), ceilingMs);
  const ms = Math.min(Math.max(parsed === null ? defaultMs : parsed, MIN_PAUSE_MS), ceilingMs);
  const issuedAt = Date.now();
  const pause = {
    id: crypto.randomBytes(6).toString('hex'),
    issuedAt,
    until: issuedAt + ms,
    tolerate: requested,
    reason: String(reason).slice(0, 200),
    issuedBy: issuedBy ? String(issuedBy).slice(0, 120) : null,
  };
  writeSigned(PAUSE_PATH, pause);
  return pause;
}

/** Ends the window early. Idempotent — resuming when nothing is paused is a no-op, not an error. */
function endEnforcementPause() {
  try {
    fs.unlinkSync(PAUSE_PATH);
    return true;
  } catch {
    return false;
  }
}

/** One line, used by every log site so the wording is identical wherever it surfaces. */
function describePause(pause, now = Date.now()) {
  if (!pause) return 'enforcement pause: none — denials are being enforced normally';
  const mins = Math.ceil(pauseRemainingMs(pause, now) / 60_000);
  return (
    `ENFORCEMENT PAUSED (${pause.id}): denials on [${pause.tolerate.join(', ')}] are being SUPPRESSED ` +
    `for ${mins} more minute${mins === 1 ? '' : 's'}, until ${new Date(pause.until).toISOString()} — ` +
    `"${pause.reason}"${pause.issuedBy ? ` (opened by ${pause.issuedBy})` : ''}`
  );
}

// ---------------------------------------------------------------------------
// THE ENV VAR — `WINDROW_DISABLE_DENIALS`, applied once at boot.
//
// Why an env var at all, given the API and the CLI already exist: the case this feature is for is
// often "start the service, reproduce the thing, look at what happened", and making the operator
// start the server and then remember a second command to run against it is how a debugging session
// begins with an enforcement window that quietly never opened.
//
// Why it is read HERE, in the server, at boot, rather than by the hook: a hook reading its own
// bypass flag out of the agent's environment would be a bypass every governed process could set for
// itself, which is precisely the property server/maintenance.js's header spends a paragraph on. The
// env var is not a flag the hook obeys — it is an instruction to the *server* to mint a signed
// pause while it is coming up healthy, which is the same trust boundary as the API route. A hook
// still only ever reads a signed file.
//
//   WINDROW_DISABLE_DENIALS=1        → the default window (15 minutes) on the default tiers
//   WINDROW_DISABLE_DENIALS=20m      → 20 minutes; clamped into [5m, 30m]
//   WINDROW_DISABLE_DENIALS_TIERS=read_only,mutating,destructive
//   WINDROW_DISABLE_DENIALS_REASON="repro #412"
//
// Unset or "0"/"false" does nothing at all — including NOT revoking a pause opened through the API,
// because a restart during a debugging window should not end the window.

const OFF = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Mint a pause from the environment, or return null. Takes `env` so a test can stage one without
 * editing the process's own environment. Throws nothing: a malformed value is reported and ignored,
 * because failing a server's boot over a debugging convenience is the wrong direction to round.
 */
function applyEnvEnforcementPause(env = process.env, { log = console.error } = {}) {
  const raw = env.WINDROW_DISABLE_DENIALS;
  if (raw === undefined || OFF.has(String(raw).trim().toLowerCase())) return null;
  const text = String(raw).trim().toLowerCase();
  // "1"/"true"/"yes"/"on" mean "yes, for the default time" rather than "for 1 millisecond".
  const asDuration = ['1', 'true', 'yes', 'on'].includes(text) ? undefined : text;
  const tiers = env.WINDROW_DISABLE_DENIALS_TIERS
    ? String(env.WINDROW_DISABLE_DENIALS_TIERS).split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;
  try {
    const pause = beginEnforcementPause({
      durationMs: asDuration,
      reason: env.WINDROW_DISABLE_DENIALS_REASON || 'WINDROW_DISABLE_DENIALS at startup',
      tolerate: tiers,
      issuedBy: 'boot-env',
    });
    log(`[enforcement] ${describePause(pause)}`);
    return pause;
  } catch (err) {
    log(`[enforcement] WINDROW_DISABLE_DENIALS ignored: ${err.message}`);
    return null;
  }
}

/**
 * The heartbeat. A pause is invisible by construction — nothing fails, so the only evidence it is
 * on is a call that should have been denied and was not, which nobody notices. This says so on a
 * timer for as long as one is in force, and says so ONCE more when it lapses, so an operator
 * scrolling back can see both ends of the window and a monitor can alert on the line.
 *
 * Returns a stop function; the timer is unref'd so it never holds the process open.
 */
function startEnforcementPauseHeartbeat({ intervalMs = 60_000, log = console.error } = {}) {
  let announced = null; // the id of the pause we last logged, so an expiry is reported exactly once
  const tick = () => {
    const pause = readEnforcementPause();
    if (pause) {
      announced = pause.id;
      log(`[enforcement] ${describePause(pause)}`);
      return;
    }
    if (announced) {
      log(`[enforcement] pause ${announced} has EXPIRED — denials are being enforced again.`);
      announced = null;
    }
  };
  tick(); // report a pause that survived a restart immediately, not a minute from now
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  PAUSE_PATH,
  MIN_PAUSE_MS,
  MAX_PAUSE_MS,
  DEFAULT_PAUSE_MS,
  ALL_TIERS,
  DEFAULT_TIERS,
  readEnforcementPause,
  pauseCovers,
  pauseCoversUnknownTier,
  pauseRemainingMs,
  parseDurationMs,
  beginEnforcementPause,
  endEnforcementPause,
  describePause,
  applyEnvEnforcementPause,
  startEnforcementPauseHeartbeat,
};
