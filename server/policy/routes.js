'use strict';
// The policy distribution channel, central side — docs/design/global-identity-and-central-db.md
// §2.4. Two routes, and they are two of the three channels that section takes "together":
//
//   GET /api/policy?since=<v>   the delta pull. Serves everything after version <v>, plus the
//                               always-full deny-list, plus a `reset` + snapshot when <v> cannot
//                               be caught up incrementally.
//   GET /api/policy/events      SSE. Carries no policy at all — only "the version is now N", which
//                               pokes a node into pulling immediately instead of waiting out its
//                               poll interval. That is the whole of the push channel, deliberately:
//                               a push that carried data would be a second, weaker copy of the pull
//                               with its own ordering bugs.
//
// §2.4 costs the three channels as "poll ≤ TTL, push < 1s typical, deny-list < 1s and survives a
// stale replica". Each degrades into the one below it: lose SSE and the poll still converges within
// its interval; lose the delta stream entirely and the deny-list still revokes; lose everything and
// server/hooks/lib.js fails closed past MAX_POLICY_AGE. Nothing here is load-bearing on its own,
// which is the property that makes a WAN in the path acceptable.
//
// A mountable router rather than more routes in server/app.js, for the reason
// server/enrollment/routes.js gives: that file is 2000+ lines and this is a two-line mount there.

const express = require('express');

// How long a held SSE connection may go quiet before we write a comment down it. Proxies and
// corporate TLS inspection (the reason §2.5 picked SSE over a raw socket in the first place) will
// close an idle connection well before a quiet policy day ends, and the node cannot tell a closed
// connection from a calm one. 25s is under the common 30s/60s idle ceilings.
const HEARTBEAT_MS = 25_000;

// One response's ceiling on delta rows. The node loops on `complete: false`, so this bounds a body
// rather than a catch-up — see store.policyDelta.
const MAX_CHANGES = 500;

/**
 * Build the router. `store` is injected for the same reason the enrollment router injects it: this
 * file stays testable without a database, and a store that predates the policy log answers 503
 * rather than throwing a TypeError inside a route.
 */
function createPolicyRouter(store) {
  const router = express.Router();

  function requireStore(req, res, next) {
    const ready = ['policyDelta', 'policyDenyList', 'policyVersion', 'onPolicyChange']
      .every((fn) => typeof store[fn] === 'function');
    if (!ready) {
      return res.status(503).json({ error: 'policy distribution is unavailable: the store has no policy_changes table yet' });
    }
    next();
  }

  /**
   * The delta pull.
   *
   * `since` is the version the caller already holds, so the response is everything *after* it. An
   * absent, negative or unparseable `since` is treated as 0 — "I hold nothing" — rather than
   * rejected, because the failure that produces one is a node whose local state was lost, and the
   * correct answer to that is a snapshot, not a 400 it cannot act on.
   */
  router.get('/api/policy', requireStore, (req, res) => {
    const raw = Number.parseInt(req.query.since, 10);
    const since = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || MAX_CHANGES, MAX_CHANGES);
    const delta = store.policyDelta(since, { limit });
    // A node caches nothing about this by URL — `since` moves every time — and an intermediary that
    // did would be handing out a stale policy version, which is the one thing this channel exists
    // to prevent.
    res.set('Cache-Control', 'no-store');
    res.json(delta);
  });

  /**
   * The deny-list on its own.
   *
   * Redundant with the `denyList` on every /api/policy response, and that redundancy is the point:
   * this endpoint is the one a node can still use when it has decided its delta stream is broken
   * and it is refusing to apply what /api/policy sends. It answers with no version dependency and
   * no state on either side, so there is nothing about it left to be broken.
   */
  router.get('/api/policy/deny-list', requireStore, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ schemaVersion: store.POLICY_SCHEMA_VERSION, ...store.policyDenyList() });
  });

  /**
   * The push channel. Emits `{version}` on connect and after every policy mutation.
   *
   * On connect matters as much as on change: a node that reconnects after a dropped connection has
   * no idea whether anything happened while it was away, and an immediate version tells it without
   * a special "what did I miss" request. The event is idempotent — a node that already holds N
   * pulls nothing.
   */
  router.get('/api/policy/events', requireStore, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which for SSE means the poke arrives batched
      // with the next one — turning a sub-second channel into an unbounded one.
      'X-Accel-Buffering': 'no',
    });
    // Before anything else: an SSE client waits for headers, and express will not send them until
    // something is written.
    res.flushHeaders();

    const send = (version) => {
      // `retry` tells the client how long to wait before reconnecting if this drops. It is sent
      // once, with the first event, because it is a property of the channel and not of the news.
      res.write(`event: policy\ndata: ${JSON.stringify({ version })}\n\n`);
    };

    res.write(`retry: 5000\n\n`);
    send(store.policyVersion());

    const unsubscribe = store.onPolicyChange((version) => {
      try {
        send(version);
      } catch {
        /* the socket went away between the notify and the write — the close handler cleans up */
      }
    });

    const heartbeat = setInterval(() => {
      // A comment line, not an event: it keeps the connection warm without the client having to
      // filter a no-op out of its own stream.
      try { res.write(': keepalive\n\n'); } catch { /* see above */ }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    // Both, not just 'close': a client that goes away mid-write emits 'error' and never 'close' on
    // some Node versions, and a leaked listener here would keep a dead response in the notify set
    // for the life of the process.
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  return router;
}

module.exports = { createPolicyRouter, HEARTBEAT_MS, MAX_CHANGES };
