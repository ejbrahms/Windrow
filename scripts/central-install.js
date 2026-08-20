'use strict';

// Registers server/central/index.js as a Windows service — gap #3 of
// docs/design/setup-after-central.md §4, "central runs in a terminal someone leaves open".
//
// WHY THIS IS A SEPARATE SCRIPT AND NOT A FLAG ON service-install.js. The same reason
// server/central/index.js is a separate entry point rather than a mode of server/index.js: a node
// and central are different deployments with different failure domains and different
// configuration, and the failure this avoids is an operator running the wrong one on the wrong
// machine. Two scripts, two service names, two environment lists — and a node that accidentally
// runs this one gets a refusal naming the missing database rather than a service that starts and
// does nothing.
//
//   service name   Windrow          server/supervisor.js   a user's PC
//   service name   WindrowCentral   server/central/index.js   the central host
//
// Both may legitimately be installed on the same machine — a single-box fleet is how phase 3 was
// developed — which is why the names differ rather than one replacing the other.
//
// ============================================================================================
// WHY THE DATABASE IS CHECKED BEFORE THE SERVICE IS REGISTERED, TWICE
// ============================================================================================
//
// A central that starts without WINDROW_CENTRAL_DB_URL is gap #7's failure shape wearing different
// clothes: server/central/index.js's `main()` calls `store.open()` first, which throws "no central
// database configured", which exits the process — and the Service Control Manager reports a service
// that keeps restarting, with the actual reason in a log file. So:
//
//   1. REFUSE TO INSTALL when no database is configured at all. There is no useful central without
//      one, and registering the service anyway would trade a clear message now for a restart loop
//      later.
//   2. WAIT FOR IT TO ANSWER before starting the service. The audit asks for a pg_isready-style
//      wait; this does it with `SELECT 1` through server/central/pgDriver.js instead, so the check
//      is against the same DSN, the same driver and the same credentials the service will use, and
//      it does not require `psql` to be installed on a Windows host that has no reason to have it.
//      A Postgres in a compose stack that is still starting is the ordinary case here, so this
//      retries rather than failing on the first refused connection.
//
// The environment capture below is the same fix as scripts/service-install.js's, applied to the
// other half of the deployment: a Windows service inherits the SYSTEM environment, not the elevated
// shell's, so anything configured in this terminal has to be snapshotted explicitly — and printed,
// because a capture nobody sees is a capture nobody can check.
//
// USAGE (elevated terminal)
//   node scripts/central-install.js              register and start
//   node scripts/central-install.js --dry-run    print the capture and probe the database; register nothing
//   node scripts/central-install.js --uninstall   remove the service
//
// scripts/service-uninstall.js is NOT reused: it hard-codes name 'Windrow' and server/index.js, so
// it would refuse to find this service. Hence --uninstall here, which is the same node-windows call
// against the name this file registers.

const os = require('os');
const path = require('path');
// ../server/config first — it loads `windrow.env`, and WINDROW_CENTRAL_DB_URL is far likelier to
// live there than in the shell that ran this. Reading process.env before it would make this script
// refuse to install on a correctly configured host.
require('../server/config');
const { Service } = require('node-windows');

const DRY_RUN = process.argv.includes('--dry-run');
const UNINSTALL = process.argv.includes('--uninstall');

const SERVICE_NAME = 'WindrowCentral';

/**
 * Central's configuration surface.
 *
 * Split into `required` (the process is useless without it) and the rest, because the printout's
 * job is to make an absence visible and not every absence matters equally — WINDROW_CENTRAL_PORT
 * defaulting to 5000 is fine, WINDROW_CENTRAL_DB_URL defaulting to nothing is the gap.
 *
 * The PG* pieces are here as well as the DSN because server/central/pgDriver.js's
 * `centralDbConfig` accepts either, and a host configured the PG* way would otherwise install a
 * service that had lost its database while the installer said nothing.
 */
const CAPTURED_ENV = [
  { name: 'WINDROW_CENTRAL_DB_URL', why: 'the Postgres central stores everything in' },
  { name: 'DATABASE_URL', why: 'fallback DSN, read when WINDROW_CENTRAL_DB_URL is unset' },
  { name: 'PGHOST', why: 'Postgres host, when the DSN is given in pieces' },
  { name: 'PGPORT', why: 'Postgres port' },
  { name: 'PGDATABASE', why: 'Postgres database name' },
  { name: 'PGUSER', why: 'Postgres user' },
  { name: 'PGPASSWORD', why: 'Postgres password' },
  { name: 'WINDROW_CENTRAL_TLS_PORT', why: 'the mutual-TLS listener nodes ship to (default 5443)' },
  { name: 'WINDROW_CENTRAL_PORT', why: 'the loopback plaintext listener (default 5000)' },
  { name: 'WINDROW_CENTRAL_ALLOW_INSECURE', why: 'enables that plaintext listener at all — development only' },
  { name: 'WINDROW_CA_DIR', why: 'the enrollment CA central verifies every node certificate against' },
  { name: 'WINDROW_CENTRAL_RETENTION_MONTHS', why: 'how many months of usage partitions are kept' },
  { name: 'WINDROW_CENTRAL_MAINTENANCE_INTERVAL_MS', why: 'how often partitions are created ahead and expired behind' },
  { name: 'WINDROW_CENTRAL_DB_POOL_MAX', why: 'connection pool size' },
  { name: 'WINDROW_CENTRAL_DB_CONNECT_TIMEOUT_MS', why: 'how long a connect may hang before failing fast' },
  { name: 'WINDROW_CENTRAL_ALERT_SWEEP_MS', why: 'how often the fleet-wide alert rules are evaluated' },
  { name: 'WINDROW_SERVER_SANS', why: 'extra subject alternative names on central\'s server certificate' },
];

function capture() {
  return CAPTURED_ENV.filter((v) => process.env[v.name] !== undefined && process.env[v.name] !== '');
}

/** Does this host have a database configured at all, by either spelling? */
function hasDatabase() {
  return Boolean(process.env.WINDROW_CENTRAL_DB_URL || process.env.DATABASE_URL
    || process.env.PGHOST || process.env.PGDATABASE);
}

/** A DSN with its password removed — this printout ends up in bug reports. */
function redactDsn(dsn) {
  return String(dsn).replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

const captured = capture();
const env = [
  // Central reads the discovery/hook paths through server/config.js like everything else, and it
  // runs as LocalSystem for the same reason the node service does, so the same home-dir capture
  // applies — see server/config.js's userHomeDir().
  { name: 'WINDROW_USER_HOME', value: process.env.WINDROW_USER_HOME || os.homedir() },
  ...captured.map(({ name }) => ({ name, value: process.env[name] })),
];

function printCapture() {
  console.log('\nEnvironment the service will start with:');
  for (const { name, value } of env) {
    console.log(`  ${name} = ${/PASSWORD/i.test(name) ? '***' : redactDsn(value)}`);
  }
  const missing = CAPTURED_ENV.filter((v) => !captured.some((c) => c.name === v.name));
  if (missing.length) {
    console.log('\nNot set in this shell, so the service will not have it:');
    for (const v of missing) console.log(`  ${v.name.padEnd(40)} ${v.why}`);
  }
  if (!process.env.WINDROW_CA_DIR) {
    // Not fatal — server/enrollment/ca.js has a default under server/data/ca — but on the central
    // host this is the fleet's trust root, and a default one under the repo is a root that a
    // reinstall or a `git clean` can take out from under every enrolled node.
    console.log(
      '\n  NOTE: no WINDROW_CA_DIR — central will load or create its CA under server/data/ca inside\n'
      + '        this checkout. That directory holds the private key every node in the fleet is verified\n'
      + '        against; point it somewhere durable and backed up before enrolling anybody.'
    );
  }
  if (!process.env.WINDROW_CENTRAL_TLS_PORT) {
    console.log('\n  NOTE: no WINDROW_CENTRAL_TLS_PORT — nodes must ship to the default, port 5443.');
  }
}

/**
 * Wait for Postgres to answer `SELECT 1`.
 *
 * Retried rather than checked once: the ordinary install order is `docker compose up -d` followed
 * immediately by this script, and a Postgres 16 container takes several seconds to accept
 * connections. Failing on the first ECONNREFUSED would make a correct sequence look like a
 * misconfiguration. The last error is kept and reported, because "still refusing after 30s" and
 * "password authentication failed" are the same timeout with completely different repairs.
 */
async function waitForDatabase({ attempts = 15, delayMs = 2000 } = {}) {
  // eslint-disable-next-line global-require
  const { openPool, pgDriver } = require('../server/central/pgDriver');
  // `pg`'s connection-timeout error arrives with an EMPTY message, so a naive `err.message` prints
  // "waiting for Postgres (1/15): " and tells an operator nothing at the one moment they are
  // watching. Fall back to the code, then the constructor name.
  const describe = (err) => (err && (err.message || err.code || err.name)) || 'connection failed with no detail';
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    let pool = null;
    try {
      pool = openPool();
      const row = await pgDriver(pool).get('SELECT 1 AS ok');
      await pool.end().catch(() => {});
      if (row && Number(row.ok) === 1) return { ok: true, attempts: i };
      lastError = new Error('connected, but SELECT 1 returned nothing');
    } catch (err) {
      lastError = err;
      if (pool) await pool.end().catch(() => {});
    }
    if (i < attempts) {
      process.stdout.write(`  waiting for Postgres (${i}/${attempts}): ${describe(lastError)}\n`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { ok: false, attempts, error: lastError, detail: describe(lastError) };
}

function buildService() {
  return new Service({
    name: SERVICE_NAME,
    description:
      'Windrow central: fleet usage ingest, fleet queries and the policy control plane, '
      + 'backed by PostgreSQL (mutual-TLS on port '
      + `${process.env.WINDROW_CENTRAL_TLS_PORT || 5443}).`,
    script: path.join(__dirname, '..', 'server', 'central', 'index.js'),
    nodeOptions: [],
    env,
  });
}

function uninstall() {
  const svc = buildService();
  svc.on('uninstall', () => console.log(`Service "${SERVICE_NAME}" uninstalled.`));
  svc.on('error', (err) => { console.error('Service uninstall error:', err); process.exitCode = 1; });
  console.log(`Uninstalling Windows service "${SERVICE_NAME}"...`);
  svc.uninstall();
}

async function install() {
  console.log(
    `Installing Windows service "${SERVICE_NAME}" -> node ${path.join(__dirname, '..', 'server', 'central', 'index.js')}\n`
    + 'This requires an elevated (Administrator) terminal.'
  );

  if (!hasDatabase()) {
    // The refusal, and the reason this script has one. See the header: a central service with no
    // DSN starts, throws inside store.open(), exits, and is restarted by the SCM forever.
    console.error(
      '\nREFUSING TO INSTALL: no central database is configured.\n\n'
      + '  Central stores everything in PostgreSQL; without a DSN this service would start, fail inside\n'
      + '  store.open(), exit, and be restarted by Windows indefinitely with the real reason buried in a\n'
      + '  service log. Set one first — in this shell or in windrow.env at the repo root:\n\n'
      + '    WINDROW_CENTRAL_DB_URL=postgres://windrow:windrow@localhost:5432/windrow_central\n\n'
      + '  or the PG* pieces (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).\n'
      + '  `docker compose -f server/central/docker-compose.yml up -d` stands one up locally.\n'
    );
    process.exitCode = 1;
    return;
  }

  printCapture();

  console.log('\nProbing the database before registering anything...');
  const probe = await waitForDatabase();
  if (!probe.ok) {
    console.error(
      `\nREFUSING TO INSTALL: the database did not answer SELECT 1 after ${probe.attempts} attempts.\n`
      + `  last error: ${probe.detail || 'unknown'}\n\n`
      + '  The service would come up into the same failure. Fix the connection first — if the Postgres is\n'
      + '  in the compose stack, `docker compose -f server/central/docker-compose.yml up -d` and try again.\n'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  database answered SELECT 1 (attempt ${probe.attempts}).`);
  console.log(
    '\n  The schema is NOT migrated here. server/central/index.js migrates on boot, which keeps one\n'
    + '  migration path for every way central can be started. Seed the catalog afterwards with\n'
    + '  `node server/seed-central.js`, and check the result with `node scripts/verify-topology.js`.'
  );

  // --dry-run stops here: everything above is a read, everything below registers a Windows service.
  // That split is what makes the capture and the database wait testable without an elevated shell.
  if (DRY_RUN) {
    console.log('\n--dry-run: nothing was registered with the Service Control Manager.\n');
    return;
  }

  const svc = buildService();
  svc.on('install', () => {
    console.log(`Service "${SERVICE_NAME}" installed. Starting it now...`);
    svc.start();
  });
  svc.on('alreadyinstalled', () => {
    console.log(
      `Service "${SERVICE_NAME}" is already installed — its environment was NOT updated.\n`
      + 'The captured variables are baked in at install time, so run `node scripts/central-install.js --uninstall`\n'
      + 'first if you changed any of the configuration printed above.'
    );
  });
  svc.on('start', () => {
    console.log(
      `Service "${SERVICE_NAME}" is running: mutual-TLS on port ${process.env.WINDROW_CENTRAL_TLS_PORT || 5443}.`
    );
  });
  svc.on('error', (err) => { console.error('Service install/start error:', err); process.exitCode = 1; });
  svc.install();
}

if (require.main === module) {
  if (UNINSTALL) uninstall();
  else {
    install().catch((err) => {
      console.error('[central-install] failed:', err.stack || err.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { CAPTURED_ENV, hasDatabase, waitForDatabase, SERVICE_NAME };
