'use strict';
// The node's copy of central policy, and the one file the hook path actually reads from it.
//
// docs/design/global-identity-and-central-db.md §2.2 puts the node's replica in its local SQLite.
// This is not that, and the difference is deliberate scope: authority for grants does not flip to
// central until phase 4, so writing central's rows into the tables server/app.js authorises from
// today would change every decision on the box before any of it has run in shadow. What ships here
// is the channel and the *safety* half of it:
//
//   policy-replica.json     the applied delta state — version, floor, the rows themselves. Nothing
//                           on the hot path reads it yet; it is what phase 4 flips authority onto,
//                           and what makes "did the stream actually work" answerable now.
//   hook-policy-deny.json   the always-full deny-list plus the age of the policy it came from.
//                           server/hooks/lib.js reads THIS on every governed call, and it is live
//                           from the moment a central is configured.
//
// That split is the §2.4 promise stated as two files: the delta stream can be broken, stale or
// refused for schema skew, and revocation still lands, because the deny-list does not depend on any
// of it.
//
// Both are written through the same signed-envelope writer server/cacheWarmer.js uses, because
// server/hooks/lib.js's readSignedCache() discards anything that is not in that envelope — a
// plain-JSON writer here would produce a file the hook silently ignores, i.e. a deny-list that
// looks present and denies nothing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AGENT_TOKEN } = require('../auth');

const { DATA_DIR } = require('../config');
const REPLICA_PATH = path.join(DATA_DIR, 'policy-replica.json');
const DENY_LIST_PATH = path.join(DATA_DIR, 'hook-policy-deny.json');

/** The payload shapes this node knows how to apply (§2.6). A delta stamped anything else is refused
 *  whole rather than applied in part — see applyDelta. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

function writeSignedAtomic(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ payload, sig }));
  // write-then-rename: a hook reading mid-refresh must never see half a deny-list, which would be
  // a file that parses and under-denies.
  fs.renameSync(tmp, filePath);
}

function readSigned(filePath) {
  try {
    const { payload, sig } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof payload !== 'string' || typeof sig !== 'string') return null;
    const expected = crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** The empty replica — what a node that has never successfully pulled holds. Version 0 means "I
 *  have nothing", which is exactly what /api/policy?since=0 is answered with. */
function emptyReplica() {
  return {
    schemaVersion: 1,
    version: 0,
    floor: 0,
    fetchedAt: null,
    capabilities: {},
    principals: {},
    grants: {},
  };
}

function loadReplica() {
  return readSigned(REPLICA_PATH) || emptyReplica();
}

function saveReplica(replica) {
  writeSignedAtomic(REPLICA_PATH, replica);
}

/**
 * Write the deny-list the hook reads.
 *
 * `fetchedAt` is the age clock server/hooks/lib.js measures MAX_POLICY_AGE against, and it is
 * stamped here — on a *successful* fetch — rather than on every write attempt. A node that cannot
 * reach central must get older, not stay young; refreshing this timestamp on a failed poll would
 * make the fail-closed bound unreachable, which is the quiet way a staleness guard stops existing.
 *
 * `central` distinguishes the two deployments that both write this file. A standalone install
 * (server/cacheWarmer.js) is its own authority: its deny-list is never stale, so the hook must not
 * apply an age bound to it. A node with a central configured is exactly the case the bound is for.
 */
function saveDenyList({
  denyList, version, fetchedAt, central, authority, nodeConfig = null, nodeProfile = null,
  seeded = null, capabilityCount = null,
}) {
  writeSignedAtomic(DENY_LIST_PATH, {
    fetchedAt,
    // THE POLICY-PARAMETER TIER, riding the same file — docs/design/disposable-nodes.md §6.
    //
    // Beside the deny-list rather than in a file of its own, and that is the entire design: same
    // channel, same credential, same HMAC, same `fetchedAt`, no new endpoint and no new failure
    // mode. The deny-list already rides every response in full because it is small and monotone,
    // and policy parameters are the same shape.
    //
    // What it buys, and it is not a convenience: a node that cannot reach central AGES OUT ITS
    // PARAMETERS exactly as it ages out its policy, because there is only one timestamp and both
    // are measured against it. A separate config file would have needed its own staleness rule, and
    // a staleness rule that only exists in one of two places is the one that will be forgotten.
    //
    // Null is the ordinary state: a standalone install has no central to state anything, and
    // ./nodeConfig.js reads null as "every parameter falls back to its local value".
    nodeConfig: nodeConfig || null,
    // The profile's CONSTRAINT leg and its name, beside the parameters and deliberately not mixed
    // in with them — see server/central/policyStore.js nodeConfigFor on why the two vocabularies
    // stay apart. Consumed by server/app.js's shadow evaluator, which is the only place the third
    // narrowing leg runs until the §1.7 subject flip.
    nodeProfile: nodeProfile || null,
    // WHETHER THE WRITER HAD ANYTHING TO BE AUTHORITATIVE ABOUT — docs/design/disposable-nodes.md
    // §3. Only server/cacheWarmer.js sets this, because only a STANDALONE install has the question:
    // its own database is the authority, and an empty one is "this machine has not looked yet"
    // rather than "nothing here is governed". A replica node's answer to the same question is
    // `central`/`fetchedAt`, which is already here. Null means "not stated", which readers must
    // treat as the old behaviour so an older writer does not fail a working install closed.
    seeded,
    capabilityCount,
    version,
    central: Boolean(central),
    // WHO OWNS POLICY, written where the hook can see it (§2.7 phase 4).
    //
    // `central` above already says "a central is configured", which is what the staleness bound
    // keys off. It does NOT say "central is the authority" — a phase-3 node ships to a central it
    // does not obey, and on that node an unregistered capability is still genuinely ungoverned.
    // Under phase 4 the same absence means something else entirely: possibly ungoverned, possibly
    // just not replicated yet. server/hooks/lib.js has to tell those apart and cannot read the
    // server's environment to do it, so the writer states it here — the same trick, and the same
    // reason, as the `central: true, fetchedAt: null` marker beside it.
    authority: authority || (central ? 'central' : 'node'),
    // Stored as arrays and turned into Sets by the reader: a hook process reads this file once and
    // does a handful of lookups, so the parse cost of a Set is the cost, not the lookup.
    grantIds: denyList.grantIds || [],
    pairs: denyList.pairs || [],
    principals: denyList.principals || [],
  });
}

/**
 * Apply one /api/policy response to a replica, returning the new replica or an explanation.
 *
 * Pure, and takes/returns the replica rather than touching disk, so the ordering and skew rules
 * below are testable without a filesystem or a server. The caller persists the result.
 *
 * Three refusals, all of which leave the previous replica untouched:
 *   - an unknown schemaVersion (§2.6: "a node refuses to *apply* a delta it does not understand
 *     rather than half-applying it, falling back to its last-good replica");
 *   - a delta that does not start where this replica ended, which would leave a hole;
 *   - a version that went backwards, which means central was restored from a backup or this node is
 *     talking to a different one. Either way the replica is not a prefix of central's history and
 *     merging would produce a state that exists nowhere.
 */
function applyDelta(replica, delta) {
  if (!delta || typeof delta !== 'object') {
    return { ok: false, reason: 'empty response' };
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(delta.schemaVersion)) {
    return {
      ok: false,
      reason: `policy schemaVersion ${delta.schemaVersion} is newer than this node understands `
        + `(knows ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}) — keeping the last-good replica`,
      skew: true,
    };
  }

  if (delta.reset) {
    // A reset replaces rather than merges: central has told us our version is not a prefix of its
    // history, so anything we hold that its snapshot does not mention is a row that no longer
    // exists. Rebuilding from empty is what removes those; merging would keep them forever.
    const next = emptyReplica();
    next.version = delta.version;
    next.floor = delta.floor;
    next.fetchedAt = Date.now();
    for (const cap of delta.snapshot?.capabilities || []) next.capabilities[cap.id] = cap;
    for (const p of delta.snapshot?.principals || []) next.principals[p.id] = p;
    for (const g of delta.snapshot?.grants || []) next.grants[g.id] = g;
    return { ok: true, replica: next, applied: 0, reset: true };
  }

  const changes = delta.changes || [];
  if (delta.since !== replica.version) {
    return { ok: false, reason: `central answered since=${delta.since} but this replica is at ${replica.version}` };
  }
  if (delta.version < replica.version) {
    return { ok: false, reason: `central is at version ${delta.version}, behind this replica's ${replica.version} — refusing to rewind` };
  }

  const next = {
    ...replica,
    capabilities: { ...replica.capabilities },
    principals: { ...replica.principals },
    grants: { ...replica.grants },
  };
  let expected = replica.version;
  for (const change of changes) {
    // Versions must be contiguous and ascending. A gap here is not something to route around — it
    // means rows we will never see, so the honest move is to stop, keep what applied cleanly, and
    // let the next pull start from there (or be answered with a reset).
    if (change.version <= expected) continue; // already applied — an at-least-once re-send, not an error
    expected = change.version;
    if (change.entity === 'capability') {
      next.capabilities[change.entityId] = change.row;
    } else if (change.entity === 'principal') {
      next.principals[change.entityId] = change.row;
    } else if (change.entity === 'grant') {
      // A revoke is a soft-delete carrying its row, so it is stored, not removed: the deny-list is
      // built from `revokedAt`, and a replica that dropped the row could not tell "revoked" from
      // "never existed".
      next.grants[change.entityId] = change.row;
    }
    // An unrecognised entity — including the 'snapshot'/'reset' marker a wholesale store.save()
    // writes — advances the version and stores nothing. That marker is a signal to the operator in
    // central's log, not a row; the rows that follow it in the same delta carry the real state.
  }
  // The LAST CHANGE ACTUALLY APPLIED, not `delta.version`. Those differ whenever central capped the
  // batch (`complete: false`), and taking the head there would be the worst kind of wrong: the
  // replica would claim to hold everything up to the head while holding only the first page, and
  // the next pull — asking `since=head` — would be told it was current. The rows in between would be
  // silently missing forever. With no changes at all there is nothing to have missed, so the head
  // is correct and is what a no-op poll advances to.
  next.version = changes.length > 0 ? expected : delta.version;
  next.floor = delta.floor;
  next.schemaVersion = delta.schemaVersion;
  next.fetchedAt = Date.now();
  return { ok: true, replica: next, applied: changes.length, reset: false };
}

/** Read back what the hook would read. Exported for the distribution test and for /api/policy/status. */
function loadDenyList() {
  return readSigned(DENY_LIST_PATH);
}

/**
 * The policy parameters central last stated, or null.
 *
 * A separate accessor from `loadDenyList` because the readers are different: the hook already has
 * the deny-list in hand when it needs the staleness bound and must not read the file twice on a
 * 20 ms budget, while server/enforcementPause.js and server/maintenance.js want the parameters and
 * have no use for the revocation list at all.
 */
function loadNodeConfig() {
  const file = readSigned(DENY_LIST_PATH);
  return (file && file.nodeConfig) || null;
}

/** The node profile this machine is in — `{ name, constraints }` — or null. */
function loadNodeProfile() {
  const file = readSigned(DENY_LIST_PATH);
  return (file && file.nodeProfile) || null;
}

module.exports = {
  REPLICA_PATH,
  DENY_LIST_PATH,
  SUPPORTED_SCHEMA_VERSIONS,
  emptyReplica,
  loadReplica,
  saveReplica,
  saveDenyList,
  loadDenyList,
  loadNodeConfig,
  loadNodeProfile,
  applyDelta,
};
