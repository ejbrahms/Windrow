'use strict';
// KEEPING THIS NODE'S CREDENTIAL ALIVE — docs/design/disposable-nodes.md §2.2, and the year-fuse it
// measures.
//
// ./ca.js says, in a comment, that a leaf is short "because renewal is automatic (a node re-enrolls
// against its own current certificate)". It was not implemented. Zero lines of renewal code existed
// in the tree, so what actually happens 365 days after an install is this:
//
//   `client.load()` sees an expired certificate and returns NULL, because an expired credential and
//   an absent one are the same value. Every caller reads null as "this node was never enrolled" and
//   takes its no-central branch — so the node STOPS SHIPPING and STOPS PULLING, and neither says
//   anything, because not being enrolled is a perfectly ordinary state. Enforcement then continues
//   off a frozen policy replica until MAX_POLICY_AGE, at which point governed calls start failing
//   closed with a staleness message that names nothing about a certificate. `verify-topology.js` was
//   the only detector in the tree and it has to be run by hand.
//
// So this file does two things, and the second is as important as the first:
//
//   1. RENEWS IN GOOD TIME. A daily check, and at a third of the leaf's life remaining it trades the
//      current certificate for a fresh one — no token, no admin, no downtime. `client.enroll` sends
//      a proof of possession and ../enrollment/routes.js's `renew` honours it.
//   2. MAKES THE FAILURE LOUD. Whatever happens — renewed, expiring, expired, never enrolled — it is
//      stated on this node's log AND carried to central on the node-health report, so "which boxes
//      are about to fall out of my fleet" is a fleet query instead of a per-machine visit. An
//      expired credential is not allowed to look like an absent one ever again.
//
// AND IT ENROLS FROM A JOIN TOKEN IF IT HAS ONE. §4 notes that WINDROW_ENROLLMENT_TOKEN is read by
// scripts/enroll.js but nothing populates it, and §6 wants the bootstrap surface down to three
// values an orchestrator can inject. Injecting one here is what closes that: a container started
// with WINDROW_CENTRAL_URL and WINDROW_ENROLLMENT_TOKEN enrols itself on boot with nobody typing
// anything, which is the difference between a node you rebuild and a node you re-install.

const client = require('./client');
const { envCompat } = require('../config');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the check runs. Daily: a year-long leaf renewed at a third of its life left has four
 *  months of slack, so a check that costs one `statSync` a day is generous by two orders of
 *  magnitude and there is no argument for making it tighter. */
const CHECK_INTERVAL_MS = Number(process.env.WINDROW_CREDENTIAL_CHECK_INTERVAL_MS) || DAY_MS;

/**
 * Renew once the remaining life falls below this fraction of a full leaf.
 *
 * A third rather than "seven days" for one reason: a node that is offline for a fortnight must not
 * come back to an expired certificate. With a 365-day leaf this starts trying about four months out
 * and retries daily, so a machine has to be unreachable for a third of a year — long past the point
 * where the fleet has other ways of noticing — before expiry can actually happen.
 */
const RENEW_AT_FRACTION = Number(process.env.WINDROW_CREDENTIAL_RENEW_AT_FRACTION) || (1 / 3);

let timer = null;
/** Last verdict, for the node-health report and for `/api/ready`'s explainer. Never null once the
 *  first check has run, which is at startup. */
let lastStatus = { state: 'unknown', checkedAt: null };

function credentialName() {
  return process.env.WINDROW_SHIP_CREDENTIAL_NAME || 'node-shipper';
}

/**
 * What this node's shipping credential looks like right now, in terms a human and central can both
 * act on. Pure — safe to call from a route handler, and it is.
 *
 *   state: 'valid' | 'renewing-soon' | 'expiring' | 'expired' | 'absent' | 'unreadable'
 */
function credentialStatus(now = Date.now()) {
  const found = client.inspect(credentialName());
  if (!found) return { state: 'absent', nodeId: null, notAfter: null, expiresInMs: null };
  if (found.unreadable) {
    return { state: 'unreadable', nodeId: null, notAfter: null, expiresInMs: null, detail: found.unreadable };
  }
  const expiresInMs = new Date(found.notAfter).getTime() - now;
  const base = {
    nodeId: (found.meta && found.meta.nodeId) || null,
    notAfter: found.notAfter,
    expiresInMs,
    expiresInDays: Math.round(expiresInMs / DAY_MS),
  };
  if (expiresInMs <= 0) return { state: 'expired', ...base };
  // The threshold is expressed against the FULL leaf life rather than against this certificate's
  // own remaining span, so it does not creep: a certificate renewed at four months out is replaced
  // by a fresh 365-day one, not by a shorter and shorter series.
  const renewAt = require('./ca').LEAF_DAYS * DAY_MS * RENEW_AT_FRACTION;
  if (expiresInMs < renewAt) return { state: 'expiring', ...base };
  return { state: 'valid', ...base };
}

/** The last check's verdict, for server/nodeHealth.js and anything else that reports upward. */
function lastCredentialStatus() {
  return lastStatus;
}

/**
 * One pass. Enrol if there is a token and no credential; renew if the credential is close to the
 * end; say so either way.
 *
 * Never throws. A renewal that cannot reach central is a thing to retry tomorrow, not a reason to
 * take the process down — and this runs on a timer nobody is watching.
 */
async function checkOnce({ now = Date.now() } = {}) {
  const centralUrl = envCompat('CENTRAL_URL');
  const status = credentialStatus(now);
  const record = (extra) => {
    lastStatus = { ...status, ...extra, checkedAt: new Date(now).toISOString() };
    return lastStatus;
  };

  if (!centralUrl) {
    // A standalone install has no issuer to renew against and needs none — nothing it does is
    // authenticated by a certificate central signed. Silence is correct here.
    return record({ state: status.state === 'absent' ? 'not-applicable' : status.state });
  }

  const name = credentialName();
  const joinToken = process.env.WINDROW_ENROLLMENT_TOKEN || null;

  if (status.state === 'absent') {
    if (!joinToken) {
      console.warn(
        `[enroll] this node has no "${name}" credential and WINDROW_CENTRAL_URL is set — it ships nothing and `
        + 'pulls no policy. Enrol it: node scripts/enroll.js --url ' + centralUrl + ' --token <t>'
      );
      return record({ action: 'none', error: 'not enrolled and no join token' });
    }
    return doEnroll({ name, centralUrl, joinToken, why: 'no credential, joining with the token in the environment', record, now });
  }

  if (status.state === 'unreadable') {
    console.error(`[enroll] the "${name}" credential will not parse (${status.detail}). This node cannot authenticate to central.`);
    return record({ action: 'none' });
  }

  if (status.state === 'valid') return record({ action: 'none' });

  // 'expiring' or 'expired'. Both renew; only the log line differs, and it differs because one of
  // them means the node is already offline as far as central is concerned.
  if (status.state === 'expired') {
    console.error(
      `[enroll] the "${name}" credential EXPIRED on ${status.notAfter}. Until it is replaced this node ships `
      + 'nothing, pulls no policy, and enforces off whatever replica it last held. Renewing now.'
    );
  } else {
    console.log(`[enroll] renewing the "${name}" credential — ${status.expiresInDays} day(s) left (expires ${status.notAfter}).`);
  }
  return doEnroll({ name, centralUrl, joinToken, why: status.state, record, now });
}

async function doEnroll({ name, centralUrl, joinToken, why, record, now }) {
  try {
    // `force: true` because the whole point is to replace a credential that already exists;
    // without it `enroll()` returns the current one and the renewal silently never happens. The
    // token is passed when there is one and omitted when there is not — an ordinary renewal needs
    // none, because the proof of possession client.js attaches is the stronger credential.
    const credential = await client.enroll({
      name,
      baseUrl: String(centralUrl).replace(/\/+$/, ''),
      enrollmentToken: joinToken || undefined,
      force: true,
    });
    console.log(`[enroll] credential for ${credential.meta.nodeId} renewed, valid to ${credential.meta.notAfter}.`);
    return record({
      state: 'valid',
      action: 'renewed',
      nodeId: credential.meta.nodeId,
      notAfter: credential.meta.notAfter,
      expiresInMs: new Date(credential.meta.notAfter).getTime() - now,
      renewedAt: new Date(now).toISOString(),
    });
  } catch (err) {
    // Loud, and specific about what it costs, because the whole failure class this file exists for
    // is one that used to be silent.
    console.error(`[enroll] could not renew the "${name}" credential (${why}): ${err.message}. Retrying in ${Math.round(CHECK_INTERVAL_MS / 3600000)}h.`);
    return record({ action: 'failed', error: err.message });
  }
}

/**
 * Start the loop. Runs one check immediately — a process that has just come up after a long stop is
 * exactly when a credential is most likely to have run out — and then daily.
 *
 * `unref()` so this timer never holds the process open: a CLI that requires this module by accident
 * must still be able to exit.
 */
function startCredentialRenewal({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (timer) return timer;
  checkOnce().catch(() => {});
  timer = setInterval(() => { checkOnce().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stopCredentialRenewal() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startCredentialRenewal, stopCredentialRenewal, checkOnce, credentialStatus, lastCredentialStatus,
  CHECK_INTERVAL_MS, RENEW_AT_FRACTION,
};
