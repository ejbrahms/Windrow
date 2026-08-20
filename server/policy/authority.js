'use strict';

// WHO OWNS POLICY ON THIS INSTALL — one answer, read from one place.
//
// Phase 4 of docs/design/global-identity-and-central-db.md §2.7 moves authority for `grants` and
// `capabilities` to central and leaves the node a read replica plus a deny-list. Six files need to
// agree about whether that has happened on *this* box: server/index.js (which adapter to bind and
// whether to lock the store), server/app.js (whether to serve its own policy channel), the store
// (whether to refuse a policy write), the policy client (whether to materialise deltas into the
// mirror), the cache warmer (who writes the deny-list) and the hook (how to read an unknown
// capability). A boolean computed in six places is a boolean that will eventually be two different
// booleans, and the failure that produces is silent: a node that refuses local writes but never
// applies remote ones is a node with a frozen registry that looks healthy.
//
// TWO CONDITIONS, BOTH REQUIRED. Naming a central is not the same as handing it authority — phase 3
// nodes ship usage to a central they do not obey, and that deployment has to keep working. So the
// flip needs WINDROW_POLICY_AUTHORITY=central *and* a WINDROW_CENTRAL_URL to obey. Asking for
// authority with nowhere to get it is refused loudly rather than silently downgraded: a node that
// quietly kept enforcing its own tables while an operator believed it was replicating is exactly
// the state §2.7 phase 4 exists to end.
//
// REVERSIBILITY. Unset the variable and restart, and the node is phase 3 again: its own tables are
// authoritative, its own /api/policy serves them, and the mirror it accumulated is simply the last
// state central gave it. That is deliberate — the flip is the riskiest step in the sequence and the
// way back should not require a database restore.

const { envCompat } = require('../config');

const CENTRAL = 'central';
const NODE = 'node';

/**
 * Resolve authority for a given environment. Pure, and takes `env`, so the tests can stage a
 * deployment without editing the process's own environment — which in a test that also boots the
 * server would leak into every module required after it.
 */
function resolvePolicyAuthority(env = process.env) {
  const requested = (envCompat('POLICY_AUTHORITY', { env }) || NODE).toLowerCase();
  const centralUrl = envCompat('CENTRAL_URL', { env }) || null;
  if (requested !== CENTRAL && requested !== NODE) {
    return {
      authority: NODE,
      centralUrl,
      error: `WINDROW_POLICY_AUTHORITY must be "${NODE}" or "${CENTRAL}", got "${requested}" — staying node-authoritative`,
    };
  }
  if (requested === CENTRAL && !centralUrl) {
    return {
      authority: NODE,
      centralUrl: null,
      error: 'WINDROW_POLICY_AUTHORITY=central but WINDROW_CENTRAL_URL is not set — there is no authority to '
        + 'replicate from, so this node stays authoritative over its own tables',
    };
  }
  return { authority: requested, centralUrl, error: null };
}

/** True when central owns grants and capabilities and this node is a replica. */
function isCentralAuthority(env = process.env) {
  return resolvePolicyAuthority(env).authority === CENTRAL;
}

module.exports = { CENTRAL, NODE, resolvePolicyAuthority, isCentralAuthority };
