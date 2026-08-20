'use strict';

// THE ROLLUP'S CENTRAL SOURCE — phase 5 of docs/design/global-identity-and-central-db.md §2.7,
// "retire `rollup/index.js`'s sibling-`.db` scan into a central query".
//
// ./index.js walks every workspace directory under the workspace root and opens each one's
// `windrow.db` read-only. That was the right answer while there was no shared store, and its own
// header says why: no shared write path, no network, no new auth surface. What it cannot be is
// correct past one machine — it sees the workspaces whose directories happen to sit next to this
// one, so a fleet is as many disjoint rollups as it has PCs.
//
// Once usage lands centrally the same answer is one `GROUP BY` (server/central/queries.js
// `rollup`), over rows that are already de-duplicated at ingest by `(nodeId, seq)` and already
// carry the workspace on the event itself. This module is the node's half: fetch it, and translate
// it into the shape ./index.js has always returned so no route and no page has to know which source
// answered.
//
// THREE MODES, one environment variable, `WINDROW_ROLLUP_SOURCE`:
//
//   auto (default)  central when one is configured, the local scan when it is not — and the local
//                   scan again if central is unreachable, because a Fleet page that errors is worse
//                   than one showing this machine and saying so.
//   central         central or nothing. For a deployment that has decided the fleet view is the
//                   only true one: a silent fall back to one machine's numbers, presented under the
//                   same headings, is a wrong answer that looks like a right one.
//   local           the scan, always. The way back if a central query is slow or wrong, without
//                   unsetting WINDROW_CENTRAL_URL and taking usage shipping down with it.
//
// EVERY PAYLOAD SAYS WHICH SOURCE PRODUCED IT (`source`), and a fall back says why
// (`centralError`). That is not decoration: the two sources answer different questions — "every
// workspace on this disk" and "every workspace in the fleet" — and a number whose scope is
// unstated is the one thing this phase must not ship.

const { envCompat } = require('../config');

/** Central's rollup route (server/central/routes.js). A node certificate reaches it and is scoped
 *  to its own node; an admin certificate gets the fleet. */
const ROLLUP_PATH = envCompat('CENTRAL_ROLLUP_PATH') || '/api/fleet/rollup';

const AUTO = 'auto';
const CENTRAL = 'central';
const LOCAL = 'local';

function mode(env = process.env) {
  const raw = (envCompat('ROLLUP_SOURCE', { env }) || AUTO).toLowerCase();
  return raw === CENTRAL || raw === LOCAL ? raw : AUTO;
}

function centralUrl(env = process.env) {
  return envCompat('CENTRAL_URL', { env }) || null;
}

/** Should this request go to central at all? */
function enabled(env = process.env) {
  const m = mode(env);
  if (m === LOCAL) return false;
  if (m === CENTRAL) return true; // deliberately true with no URL, so `required` can report it
  return Boolean(centralUrl(env));
}

/** Is central the only acceptable answer — i.e. must a failure be reported rather than papered
 *  over with this machine's own scan? */
function required(env = process.env) {
  return mode(env) === CENTRAL;
}

/** Ask central. Separated from the adapters below so a test can drive them with a fixture instead
 *  of a live central, and required lazily so a node with no central configured never loads the
 *  policy client's transport at all. */
async function fetchRollup({ hours = null, limit = null } = {}) {
  if (!centralUrl()) {
    throw new Error('WINDROW_ROLLUP_SOURCE=central but WINDROW_CENTRAL_URL is not set — there is no central to query');
  }
  const { centralRequest } = require('../policy/policyClient');
  const params = new URLSearchParams();
  if (hours) params.set('hours', String(hours));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return centralRequest('GET', qs ? `${ROLLUP_PATH}?${qs}` : ROLLUP_PATH);
}

/**
 * Central's answer in `summary()`'s shape.
 *
 * Four fields of the scan's payload have no central counterpart, and each is filled with the
 * honest value rather than a plausible one:
 *
 *   fieldPath / dbPath   null. Central knows about events, not about any node's disk.
 *   reachable            true, for every workspace listed. Presence IS the evidence here — a
 *                        workspace appears because it reported — where the scan's flag meant "the
 *                        file opened". A workspace that has never reported is not unreachable; it
 *                        does not exist as far as the fleet is concerned.
 *   warnings             empty. The scan's warnings are schema-tolerance warnings, and there is no
 *                        schema to tolerate when every node ships into one table central owns.
 *   duplicatesSkipped    0, and it is 0 by construction rather than by measurement: ingest is
 *                        idempotent on `(nodeId, seq)` through `usage_shipments`, so a duplicate
 *                        never becomes a row to skip. `source: 'central'` is what tells a reader
 *                        which of those two zeroes this is.
 */
function toSummary(payload) {
  const totals = (payload && payload.totals) || {};
  return {
    source: 'central',
    centralError: null,
    // Which slice central answered for: null nodeIds means the whole fleet, a list means this
    // node's certificate scoped the answer to itself. Passed straight through so the page can say
    // so rather than implying a fleet it did not read.
    scope: (payload && payload.scope) || { nodeIds: null },
    since: (payload && payload.since) || null,
    fields: ((payload && payload.byField) || []).map((f) => ({
      field: f.field,
      fieldPath: null,
      nodeId: null,
      reachable: true,
      error: null,
      warnings: [],
    })),
    totals: {
      calls: totals.calls || 0,
      denied: totals.denied || 0,
      denialRate: totals.denialRate || 0,
      duplicatesSkipped: 0,
      clockSkew: totals.clockSkew || { sampled: 0, maxAheadMs: null, maxBehindMs: null },
      // Central-only, and the number the scan could not produce: events whose workspace could not
      // be established at all. The scan folded these into whichever directory it read them from.
      unattributedCalls: totals.unattributedCalls || 0,
      nodes: totals.nodes || 0,
    },
    byField: ((payload && payload.byField) || []).map((f) => ({
      field: f.field,
      fieldPath: null,
      calls: f.calls || 0,
      denied: f.denied || 0,
      principalCount: f.principalCount || 0,
    })),
    byPrincipal: (payload && payload.byPrincipal) || [],
    standalone: (payload && payload.standalone) || { calls: 0, denied: 0, byBackend: [] },
  };
}

/**
 * Central's answer in `listFields()`'s shape.
 *
 * `root` is null: the scan's root is a directory on this machine, and a fleet has no such thing.
 * `sharedOnly` is false throughout for the same reason it existed — it marked a workspace that had
 * no database of its own on this disk, a distinction that only means something to a reader of
 * files.
 */
function toFields(payload, { thisField = null } = {}) {
  return {
    source: 'central',
    centralError: null,
    scope: (payload && payload.scope) || { nodeIds: null },
    root: null,
    thisField,
    fields: ((payload && payload.byField) || []).map((f) => ({
      field: f.field,
      fieldPath: null,
      dbPath: null,
      nodeId: null,
      reachable: true,
      error: null,
      warnings: [],
      principalCount: f.principalCount || 0,
      // The scan counted rows in a file; central counts events it received for this workspace.
      // Same question, and the fleet's answer is the one that includes the other machines.
      eventCount: f.calls || 0,
      lastEventAt: f.lastEventAt || null,
      sharedOnly: false,
    })),
  };
}

module.exports = { AUTO, CENTRAL, LOCAL, ROLLUP_PATH, mode, enabled, required, fetchRollup, toSummary, toFields };
