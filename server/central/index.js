'use strict';

// The central process — `npm run central --prefix server`.
//
// Deliberately a SEPARATE ENTRY POINT from server/index.js, not a mode of it. A node and central
// are different deployments with different failure domains: the node is a Windows service on a
// user's PC that must keep enforcing when the network is gone (§2.8), and central is one host with
// a Postgres behind it. Folding both into one entry would mean every node process carried the
// central code, the `pg` dependency and the risk of an environment variable turning one into the
// other by accident.
//
// TWO MODES, AND THE DATABASE DECIDES WHICH. With migrations 1-2 applied this process is phase 3's
// shadow: it receives usage, answers fleet questions and serves no policy, so stopping it costs
// only the fleet view. With migration 3 applied it is also phase 4's AUTHORITY for grants and
// capabilities — it mints the ids and owns the canonical rows, and every node runs a read replica
// plus the deny-list. GET /health reports which, read off the schema rather than off an environment
// variable, because that is where the answer actually lives.
//
// What does NOT change between them: nothing a node does is BLOCKED on this process. §2.8's first
// row — a node partitioned from central still enforces from its replica for MAX_POLICY_AGE, and
// only then starts failing mutating and destructive calls closed. Phase 4 buys a bound on how long
// a revoked grant can survive; it does not put a WAN hop on any tool call.

const http = require('http');
const https = require('https');
const { assertNoLegacyEnv, envCompat } = require('../config');

assertNoLegacyEnv();

const store = require('./store');
const partitions = require('./partitions');
const { buildApp, ALLOW_INSECURE } = require('./routes');
const { startDashboardProxy } = require('./dashboardProxy');
const { startCentralAlertEngine, stopCentralAlertEngine } = require('./alertEngine');
const enrollmentStore = require('./enrollmentStore');
const { ensureBootstrapToken, BOOTSTRAP_TOKEN_PATH } = require('../enrollment/routes');

const TLS_PORT = Number(envCompat('CENTRAL_TLS_PORT')) || 5443;
const PLAIN_PORT = Number(envCompat('CENTRAL_PORT')) || 5000;

/** The browser's door — see ./dashboardProxy.js. Off unless a port is set, so a host-run central is
 *  unchanged; the container sets it (docker-compose.yml) and publishes it to the host's loopback.
 *  It only means anything when the plaintext listener it forwards to is up (ALLOW_INSECURE=1), which
 *  is the same condition, so the two travel together. */
const DASHBOARD_PORT = Number(envCompat('CENTRAL_DASHBOARD_PORT')) || 0;

/** Extra origins a mutating dashboard request may come from, on top of the loopback names on the
 *  dashboard port. Comma-separated origins or host:port — set only when the operator reaches the
 *  proxy by some other name (an SSH tunnel, a reverse proxy). The CSRF/rebinding allowlist in
 *  dashboardProxy.js already covers plain localhost, so the common case leaves this unset. */
const DASHBOARD_ORIGINS = String(envCompat('CENTRAL_DASHBOARD_ORIGINS') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** How often partition maintenance runs. Hourly, not daily: the cost is a catalogue lookup that
 *  finds nothing to do, and the benefit is that a central restarted at any hour of any day is
 *  never more than an hour from having next month's partitions. */
const MAINTENANCE_INTERVAL_MS = Number(envCompat('CENTRAL_MAINTENANCE_INTERVAL_MS')) || 3600_000;

/** Months of usage to keep. Unset means keep everything — see partitions.dropExpiredPartitions for
 *  why this file does not pick a number on an operator's behalf. */
const RETENTION_MONTHS = Number(envCompat('CENTRAL_RETENTION_MONTHS')) || 0;

async function main() {
  await store.open();
  const driver = store.requireDriver();
  const app = buildApp();

  // The first admin has nowhere to get an enrollment token from, so a central with no admin node
  // enrolled mints one and writes it where only the installing user can read it. This is the first
  // step of docs/design/setup-after-central.md §5's fleet install: read that file, hand it to
  // `node scripts/enroll.js --token …` on the machine that will administer the fleet, and every
  // subsequent token is minted through POST /api/enrollment-tokens with that credential.
  //
  // AFTER store.open() because it reads and writes tables migration 5 creates, and BEFORE the
  // listeners because a central that is accepting requests while still deciding whether it needs a
  // bootstrap token has a window in which two enrollments could both find no admin.
  //
  // Idempotent, and that is the security property rather than a convenience: once an admin node is
  // enrolled this mints nothing and DELETES the file, so a restart never reopens the window and a
  // spendable admin credential does not sit on disk beside the one that replaced it.
  try {
    const bootstrap = await ensureBootstrapToken(enrollmentStore);
    if (!bootstrap) console.log(`[central] an admin node is already enrolled — no bootstrap token minted.`);
  } catch (err) {
    // Not fatal. A central whose data directory is unwritable still ingests from nodes that have
    // already enrolled, and failing to start over a file an operator may not even need would take
    // the fleet's usage stream down to fix an onboarding convenience.
    console.error(`[central] could not mint a bootstrap enrollment token (${BOOTSTRAP_TOKEN_PATH}):`, err.message);
  }

  // Create ahead, expire behind, and say so if a row ever reached the default partition.
  const maintain = () => partitions
    .runMaintenance(driver, { retentionMonths: RETENTION_MONTHS })
    .catch((err) => console.error('[central-db] partition maintenance failed:', err.message));
  await maintain();
  const timer = setInterval(maintain, MAINTENANCE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  // §2.3's central half: evaluate the alert rules over the fleet aggregate, so "this subject is on
  // five PCs and the total crossed the threshold" is caught somewhere — no node can see that
  // number. Started AFTER the store is open and the partitions exist, because its first act is an
  // aggregate over usage_events. It writes through the same primary key the nodes' own alerts
  // arrive on, which is where "a breach seen from both sides fires once" is actually enforced.
  startCentralAlertEngine();

  // mTLS is the real listener. The CA is the same enrollment CA the nodes are issued from
  // (server/enrollment/ca.js) — a node that has enrolled already holds a certificate this trusts,
  // which is what makes §2.5's "per-node credential" one mechanism rather than two.
  //
  // `rejectUnauthorized: false` lets an unauthenticated request reach the app so it gets a JSON
  // 401 that explains itself instead of a bare TLS alert. Nothing is authorised by arriving —
  // ./routes.js checks `socket.authorized` before it reads anything off the certificate.
  // `listen` reports failure ASYNCHRONOUSLY, on the server's 'error' event — a try/catch around
  // the call catches nothing, and an 'error' event with no listener is re-thrown as an uncaught
  // exception that takes the process down. So each listener gets an explicit handler and a
  // promise that settles either way, and "did any listener come up" is a question answered after
  // both have been tried rather than guessed at from the absence of a throw.
  //
  // The case that matters is a port already in use, which for central is the ordinary shape of an
  // operator restarting it before the old process has let go: without this, the second instance
  // dies with a stack trace *after* its other listener is already serving, which is the worst of
  // both — a process that looks half up and exits under you.
  const listen = (server, port, host, label) => new Promise((resolve) => {
    server.once('error', (err) => {
      console.error(`[central] could not start the ${label}: ${err.message}`);
      resolve(false);
    });
    server.listen(port, host, () => resolve(true));
  });

  let tlsUp = false;
  try {
    // eslint-disable-next-line global-require
    const ca = require('../enrollment/ca');
    const root = ca.loadOrCreateCa();
    const serverCert = ca.loadOrCreateServerCert(root);
    const tls = https.createServer({
      key: serverCert.key,
      cert: serverCert.cert,
      ca: root.certPem,
      requestCert: true,
      rejectUnauthorized: false,
    }, app);
    tlsUp = await listen(tls, TLS_PORT, undefined, `mutual-TLS listener on port ${TLS_PORT}`);
    if (tlsUp) console.log(`[central] mutual-TLS listener on https://0.0.0.0:${TLS_PORT}/api — ingest + fleet`);
  } catch (err) {
    // The synchronous half: a CA that cannot be loaded or a certificate that cannot be issued.
    console.error('[central] could not prepare the mutual-TLS listener:', err.message);
  }

  let plainUp = false;
  if (ALLOW_INSECURE) {
    // Loopback only, and only because it was asked for. Bound to 127.0.0.1 explicitly, so "only
    // loopback" is a property of the socket rather than a check that could be bypassed by a header.
    plainUp = await listen(http.createServer(app), PLAIN_PORT, '127.0.0.1', `plaintext listener on port ${PLAIN_PORT}`);
    if (plainUp) {
      console.log(
        `[central] plaintext listener on http://127.0.0.1:${PLAIN_PORT}/api — WINDROW_CENTRAL_ALLOW_INSECURE=1.`,
        'Batches on this listener are attributed to whatever node id they claim, since there is no',
        'certificate to check them against. Development only.'
      );
    }
  }

  // The browser's front door. It forwards to the plaintext listener above over this container's own
  // loopback, which is what gets a certificate-less browser past routes.js's isLoopback check — so
  // it is only useful when that listener came up. Refuse rather than start a proxy that would 502
  // every request, and say which switch is missing.
  if (DASHBOARD_PORT) {
    if (!plainUp) {
      console.error(
        `[central] WINDROW_CENTRAL_DASHBOARD_PORT=${DASHBOARD_PORT} is set but the plaintext listener it`,
        'forwards to is not up — set WINDROW_CENTRAL_ALLOW_INSECURE=1. The dashboard proxy is NOT starting.'
      );
    } else {
      const proxy = await startDashboardProxy({ listenPort: DASHBOARD_PORT, targetPort: PLAIN_PORT, allowedOrigins: DASHBOARD_ORIGINS });
      if (proxy) {
        console.log(
          `[central] dashboard proxy on http://0.0.0.0:${DASHBOARD_PORT} → the plaintext listener on ${PLAIN_PORT}.`,
          'Publish it to the host\'s 127.0.0.1 only: anything that reaches this port has full admin,',
          'exactly as the loopback listener behind it does.'
        );
      }
    }
  }

  if (!tlsUp && !plainUp) {
    console.error(
      '[central] no listener started — nothing can reach this process, so it is exiting rather than',
      'sitting there looking healthy. Free the port above, or set WINDROW_CENTRAL_ALLOW_INSECURE=1',
      'for a loopback-only development listener.'
    );
    await store.close().catch(() => {});
    process.exit(1);
  }

  const shutdown = async () => {
    clearInterval(timer);
    stopCentralAlertEngine();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[central] failed to start:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { main };
