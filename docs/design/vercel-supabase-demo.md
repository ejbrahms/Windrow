# A public, read-only live demo — Vercel + Supabase

> [!tip]
> **What this retires.** The dashboard is otherwise unreachable without an enrolled admin
> certificate on a machine that can open central's mTLS port, and a fresh install ships with default
> credentials nobody should meet on the open internet. This deployment makes the Fleet console a
> public URL that carries **no credential and no mutating route** — so "the dashboard is
> unreachable" and "don't expose default creds" both stop being blockers.

```mermaid
flowchart LR
  B[Browser<br/>anyone] -->|/, /assets/*| V[Vercel static<br/>client/dist SPA]
  B -->|/health, /api/fleet/* GET| F[api/index.js<br/>serverless fn]
  F -->|GET-only, no mTLS| S[(Supabase Postgres 16<br/>POOLED :6543, read-only role)]
  V -. same origin .- F
```

## The three things that make it safe on the open internet

They are independent, so a mistake in one does not open the others:

1. **A blanket GET-only guard** (`api/index.js`) refuses every method but `GET`/`HEAD` *before* any
   route. This catches `/api/enroll`, which is mounted **without** `requireCert` on purpose — a
   certificate check alone would leave it reachable. Verified: `POST /api/enroll` → `405`.
2. **`WINDROW_CENTRAL_DEMO_READONLY=1`** makes `requireCert` grant a certificate-less **GET** the
   admin fleet scope, and only a GET (`server/central/routes.js`). The reads answer without a
   certificate the browser could never present here.
3. **The database is a seed.** `DATABASE_URL` points at a **pooled** Supabase holding demo rows
   only, opened with `migrate:false`. Give the connection a **read-only role** so even a hypothetical
   write has nothing to write with.

## Supabase — provision once, against the DIRECT connection

```bash
# 1. New Supabase project. From Settings → Database, copy TWO connection strings:
#    DIRECT  (…@db.<ref>.supabase.co:5432/postgres)   — session mode, DDL works
#    POOLED  (…@…pooler.supabase.com:6543/postgres)    — pgbouncer transaction mode

# 2. Create schema + partitions + a synthetic 3-node fleet (usage, native, hooks).
DATABASE_URL='<DIRECT url>' node scripts/seed-demo.js      # idempotent — safe to re-run

# 3. (recommended) a read-only role for the demo to connect as:
#    CREATE ROLE demo_ro LOGIN PASSWORD '…';
#    GRANT USAGE ON SCHEMA public TO demo_ro;
#    GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_ro;
#    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO demo_ro;
#    Then build the POOLED url with demo_ro's credentials for Vercel below.
```

`scripts/seed-demo.js` feeds rows through `store.ingestBatch` / `ingestNativeBatch` /
`ingestNodeHealth` — the same paths a real node's shipper uses — so the roster, ledger and
partitions come out self-consistent rather than hand-placed.

## Vercel — deploy

```bash
vercel link            # or import the repo in the Vercel dashboard
# Project → Settings → Environment Variables:
#   DATABASE_URL                    = <POOLED url, demo_ro>
#   WINDROW_CENTRAL_DEMO_READONLY   = 1
vercel --prod
```

`vercel.json` builds the client, serves `client/dist` statically, and routes only `/health` and
`/api/*` to `api/index.js`. Everything else falls back to `index.html` for client-side routing.

## What the browser gets

`GET /health` returns `{ok, mode, defaultPartitionRows}`, so the SPA's host probe
(`client/src/api/host.ts`) resolves **central** and lands on `/fleet/overview`. The Fleet pages —
overview, nodes & hooks, usage, events, native observations, alerts, shadow — all read `GET
/api/fleet/*` and render. The machine-console pages (Policy, discovery, providers) are node-only and
are simply not shown; that is the existing "open this on the node" behaviour, not a demo change.

## Verified locally

Run the exact serverless entry against any Postgres before deploying:

```bash
DATABASE_URL='postgres://windrow:windrow@localhost:5432/windrow_central' \
  WINDROW_CENTRAL_DEMO_READONLY=1 node scripts/demo-local.js   # → http://127.0.0.1:5610
```

Against the local `central:db` this rendered the full Fleet overview with live data, `/api/fleet/*`
answered with no certificate, and every mutating route — `ingest`, `enroll`, dead-letter
`discard` — returned `405`.
