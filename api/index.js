'use strict';

// The public read-only demo — one Vercel serverless function in front of a pooled Supabase.
// docs/design/vercel-supabase-demo.md.
//
// WHAT THIS IS FOR. Central's dashboard is otherwise unreachable without an enrolled admin
// certificate on a machine that can open central's mTLS port, and a fresh install ships with
// default credentials nobody should meet on the open internet. This function retires both: it
// serves the built dashboard SPA and central's GET /api/fleet/* reads against a seeded Supabase, so
// the Fleet console is a public URL anyone can open, and it carries no credential and no mutating
// route to protect.
//
// THREE THINGS MAKE IT SAFE TO PUT ON THE PUBLIC INTERNET, and they are independent so a mistake in
// one does not open the others:
//
//   1. A BLANKET GET-ONLY GUARD, below, refuses every method but GET/HEAD before a request reaches
//      any route. central mounts ingest, enrollment and policy POST routes; enrollment is mounted
//      WITHOUT requireCert on purpose, so gating by certificate alone would leave it reachable.
//      This guard does not care how a route is mounted — nothing that changes state is a GET.
//   2. WINDROW_CENTRAL_DEMO_READONLY=1 makes requireCert grant a certificate-less GET the admin
//      fleet scope (server/central/routes.js), and ONLY a GET — so the reads answer without a
//      certificate the browser could never present here, and the guard above still stands.
//   3. THE DATABASE IS A SEED. DATABASE_URL points at a pooled Supabase holding demo rows only, and
//      the connection role should be read-only (docs/design/vercel-supabase-demo.md §Supabase). The
//      store opens it with migrate:false — pgbouncer transaction pooling is unfriendly to session
//      DDL, and there is nothing to migrate because the schema was provisioned once out of band.
//
// The SPA itself is served as static assets by Vercel (vercel.json `outputDirectory`), not from
// here — this function only ever answers /health and /api/*.

// No top-level `require('express')` here on purpose: this file sits at the repo root, where express
// is not a dependency — it lives in server/node_modules and is required internally by buildApp. An
// express app is itself a plain (req, res) handler, so the GET-only guard below wraps it without a
// second express instance, and Vercel's dependency tracer only has to follow the central requires.
const store = require('../server/central/store');
const { buildApp } = require('../server/central/routes');

// Vercel keeps a warm container between invocations, so the pool and the built app are created once
// and reused. A cold start pays the one Supabase connect; every request after it is a checked-out
// pooled connection, which is the whole reason the demo uses the pooled URL and not the direct one.
let appPromise = null;

async function getApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    if (process.env.WINDROW_CENTRAL_DEMO_READONLY !== '1') {
      // Fail loud rather than serve central's real surface unguarded if the flag was forgotten.
      throw new Error(
        'refusing to start the public demo without WINDROW_CENTRAL_DEMO_READONLY=1 — that flag is '
          + 'what makes requireCert refuse every mutating route (server/central/routes.js).'
      );
    }
    // migrate:false — read-only against a pre-seeded, pooled Supabase. See store.open's header.
    await store.open(undefined, { migrate: false });
    return buildApp();
  })();
  return appPromise;
}

module.exports = async (req, res) => {
  try {
    // The blanket guard, ahead of everything: no route buildApp mounts — checked by a certificate
    // or, like enrollment, not — can be reached by a method that changes state. An express app is a
    // (req, res) handler, so wrapping it needs no second express instance.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        error: 'this is a read-only public demo — only GET is served',
        detail: 'the live demo serves central\'s fleet reads and the dashboard only; mutating routes are disabled.',
      }));
    }
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    // A failed cold start (Supabase unreachable, flag missing) must not hang the request. Reset the
    // memo so the next invocation retries rather than serving a permanently-rejected promise.
    appPromise = null;
    console.error('[demo] failed to serve request:', err.stack || err.message);
    res.status(503).json({ error: 'the demo backend is not available', detail: err.message });
  }
};
