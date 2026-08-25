'use strict';

// `node scripts/demo-local.js` — run the public read-only demo entry (../api/index.js) locally, in
// front of whatever Postgres DATABASE_URL points at, so the exact serverless code path can be
// exercised and browser-checked before it is deployed to Vercel. docs/design/vercel-supabase-demo.md.
//
// Vercel serves the SPA statically and routes only /health and /api/* to the function; locally
// buildApp() serves client/dist itself (server/central/routes.js's static mount finds the repo's
// client/dist), so this one http server stands in for both halves. It changes NO behaviour of the
// function — it just gives it a socket.
//
//   DATABASE_URL='postgres://windrow:windrow@localhost:5432/windrow_central' \
//     WINDROW_CENTRAL_DEMO_READONLY=1 node scripts/demo-local.js
//
// Defaults DATABASE_URL to the local central-db compose credentials and the flag to on, so a bare
// `node scripts/demo-local.js` works against `npm run central:db`.
//
// ITS TWO SIBLINGS: `scripts/seed-demo.js` fills the Supabase database this reads (run once,
// against the DIRECT connection), and `npm run demo` / `scripts/demo.js` is the unrelated one —
// a throwaway local SQLite node + Vite for looking at the dashboard on your own machine, with no
// Postgres and nothing to do with Vercel.

const http = require('http');

if (!process.env.DATABASE_URL && !process.env.WINDROW_CENTRAL_DB_URL) {
  process.env.DATABASE_URL = 'postgres://windrow:windrow@localhost:5432/windrow_central';
}
if (!process.env.WINDROW_CENTRAL_DEMO_READONLY) {
  process.env.WINDROW_CENTRAL_DEMO_READONLY = '1';
}

const handler = require('../api/index.js');
const PORT = Number(process.env.PORT) || 5610;

http.createServer((req, res) => handler(req, res)).listen(PORT, '127.0.0.1', () => {
  console.log(`[demo-local] read-only demo on http://127.0.0.1:${PORT}`);
  console.log(`[demo-local] DATABASE_URL=${process.env.DATABASE_URL || process.env.WINDROW_CENTRAL_DB_URL}`);
  console.log('[demo-local] try:  curl -s http://127.0.0.1:' + PORT + '/health');
});
