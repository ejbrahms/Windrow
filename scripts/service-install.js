// Registers the combined backend+frontend (`npm start` at the repo root) as a Windows service, so
// it starts on boot and restarts on crash instead of only running in a terminal someone leaves
// open.
//
// The registered script is server/supervisor.js, NOT server/index.js. The supervisor binds :4000
// and runs the API as its own child on a private upstream port, so a backend restart parks incoming
// hook requests for up to 5 s instead of refusing the connection
// (docs/design/upgrade-resilience.md §3.4). Registering index.js directly would give the service
// back its old behaviour, where every restart is a fleet-wide FAULT for the hooks that fire during
// it. If you are upgrading an existing install, run `npm run service:uninstall` first — the target
// script is baked into server/daemon/windrow.xml at install time. Uses node-windows, which wraps the target script with a small native service host
// (winsw) and talks to the Windows Service Control Manager under the hood.
//
// Must be run from an elevated (Run as Administrator) terminal — the SCM refuses
// CreateService/OpenSCManager calls from a non-admin process. Run once:
//   npm run service:install
//
// ============================================================================================
// WHY THIS FILE CAPTURES THE WHOLE FLEET CONFIGURATION AND NOT JUST TWO VARIABLES
// ============================================================================================
//
// It used to pass exactly two: PORT and WINDROW_USER_HOME. That was complete while a Windrow
// install was one machine with one SQLite file. It stopped being complete when a node could join a
// fleet, and gap #7 of docs/design/setup-after-central.md §4 is the result — the one gap on that
// list that FAILS SILENTLY:
//
//   An operator configures a node for a fleet in a terminal (WINDROW_CENTRAL_URL,
//   WINDROW_POLICY_AUTHORITY=central), watches it ship usage and pull policy, and then installs it
//   as a service so it survives a reboot. The service starts with neither variable. It ships
//   nothing, pulls no policy, and enforces from its own local tables — and every surface reports a
//   healthy node, because a node with no central IS a valid, healthy deployment. Nothing is
//   broken; the fleet has simply lost a member and nobody is told.
//
// A Windows service inherits the SYSTEM environment, not the environment of the elevated shell that
// installed it, and `windrow.env` at the repo root (server/envFile.js) only helps if the operator
// put the configuration there rather than in their shell. So the fix is to snapshot what THIS shell
// has and hand it to the service explicitly, which is what CAPTURED_ENV below does — and then to
// PRINT the snapshot, because a captured list an operator cannot see is a list they cannot check.
// The printout is half the fix: it is what turns "the service quietly lacks WINDROW_CENTRAL_URL"
// into a line the person installing it reads at the moment they can still do something about it.
//
// ONLY WHAT IS ACTUALLY SET IS CAPTURED. Baking a default into the service registration would be
// worse than omitting the variable: an explicit value on the service overrides `windrow.env`
// (server/envFile.js never overwrites a real environment variable), so a captured default would
// permanently pin the service to whatever was true on install day and make the config file
// silently ineffective for that key.

const os = require('os');
const path = require('path');
// ../server/config first, so `windrow.env` is loaded before anything below reads process.env.
// Without it, an operator who put their fleet configuration in that file — which is the way this
// repo now recommends — would install a service that captured none of it, which is gap #7 arriving
// by a different door.
require('../server/config');
const { Service } = require('node-windows');

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * The node's configuration surface, as a list rather than as whatever the author remembered.
 *
 * Grepped out of the tree (`envCompat('X')` and literal `WINDROW_X` reads) rather than transcribed
 * from a design doc, because the doc is not what the code reads. Grouped by what each group breaks
 * when it goes missing, since that is the question an operator reading the printout is actually
 * asking.
 *
 * Central-only variables (WINDROW_CENTRAL_DB_URL, WINDROW_CENTRAL_TLS_PORT, …) are deliberately
 * absent: they belong to scripts/central-install.js, and capturing them onto a node service would
 * hand a user's PC a database DSN it has no use for.
 */
const CAPTURED_ENV = [
  // --- fleet membership. Missing => the silent standalone described above. -------------------
  { name: 'WINDROW_CENTRAL_URL', why: 'where usage is shipped and policy is pulled from' },
  { name: 'WINDROW_POLICY_AUTHORITY', why: 'whether central or this node owns grants' },
  { name: 'WINDROW_NODE_ID', why: 'the id this node ships under' },
  { name: 'WINDROW_CREDENTIAL_DIR', why: 'where the enrollment credential lives' },
  { name: 'WINDROW_CA_DIR', why: 'the enrollment CA this node issues and trusts against' },
  { name: 'WINDROW_SHIP_CREDENTIAL_NAME', why: 'which credential the shipper presents' },
  { name: 'WINDROW_POLICY_CREDENTIAL_NAME', why: 'which credential the policy client presents' },

  // --- storage and listeners. Missing => the service opens a DIFFERENT database. -------------
  { name: 'WINDROW_DB_PATH', why: 'which SQLite file is this node\'s registry' },
  { name: 'WINDROW_TLS_PORT', why: 'the mTLS listener port' },
  { name: 'WINDROW_UPSTREAM_PORT', why: 'the private port the supervisor runs the API on' },
  { name: 'WINDROW_PARK_MS', why: 'how long the supervisor parks requests across a restart' },

  // --- behaviour toggles. Missing => the service quietly does less than the terminal did. ----
  { name: 'WINDROW_SHIP_INTERVAL_MS', why: 'how often the outbox drains to central' },
  { name: 'WINDROW_ROLLUP_SOURCE', why: 'whether rollups are computed locally or fetched from central' },
  { name: 'WINDROW_SHADOW_EVAL', why: 'shadow evaluation of the central verdict alongside the local one' },
  { name: 'WINDROW_OBSERVE_NATIVE_TOOLS', why: 'native (non-MCP) tool observability' },
  { name: 'WINDROW_MAX_POLICY_AGE_MS', why: 'how long a replica may go stale before mutating calls fail closed' },
  { name: 'WINDROW_POLICY_POLL_INTERVAL_MS', why: 'how often the policy delta is pulled' },
  { name: 'WINDROW_NATIVE_RETENTION_DAYS', why: 'how long native observations are kept' },
  { name: 'SKILL_DIRS', why: 'override for the discovery scan roots' },
  { name: 'HOOK_INSTALL_PATHS', why: 'override for where hook wiring is written' },
];

/** The subset of CAPTURED_ENV this shell actually has, in the shape node-windows wants. */
function capture() {
  return CAPTURED_ENV
    .filter((v) => process.env[v.name] !== undefined && process.env[v.name] !== '')
    .map((v) => ({ name: v.name, value: process.env[v.name], why: v.why }));
}

const captured = capture();

const env = [
  { name: 'PORT', value: process.env.PORT || '4000' },
  // The service itself runs as LocalSystem, whose os.homedir() resolves to
  // C:\WINDOWS\system32\config\systemprofile — not the real user's ~/.claude, ~/.gemini, etc.
  // Capture the real home dir here, while the installer is still running under the actual
  // user's own (elevated) session, and hand it to the service explicitly. See
  // server/config.js's userHomeDir().
  { name: 'WINDROW_USER_HOME', value: process.env.WINDROW_USER_HOME || os.homedir() },
  ...captured.map(({ name, value }) => ({ name, value })),
];

/**
 * Print what the service will and will not carry, and warn on the two configurations that look
 * fine and are not.
 *
 * The omissions are printed as well as the captures, and that asymmetry is the point: a list of
 * what WAS captured reads as complete no matter what is on it, and the whole failure mode here is
 * an absence nobody looked for.
 */
function printCapture() {
  console.log('\nEnvironment the service will start with:');
  for (const { name, value } of env) {
    // Values are printed. Nothing on this list is a secret — the enrollment credential is a file on
    // disk, not an environment variable — and a redacted DSN is exactly the kind of "helpful"
    // omission that hides a typo in a hostname.
    console.log(`  ${name} = ${value}`);
  }

  const missing = CAPTURED_ENV.filter((v) => !captured.some((c) => c.name === v.name));
  if (missing.length) {
    console.log('\nNot set in this shell, so the service will not have it:');
    for (const v of missing) console.log(`  ${v.name.padEnd(32)} ${v.why}`);
  }

  const has = (n) => captured.some((c) => c.name === n);
  if (!has('WINDROW_CENTRAL_URL')) {
    console.log(
      '\n  NOTE: no WINDROW_CENTRAL_URL — this service will run as a STANDALONE node. It will ship no\n'
      + '        usage and pull no policy. That is a valid install; it is only wrong if you meant this\n'
      + '        machine to be part of a fleet, in which case set it (or put it in windrow.env) and\n'
      + '        re-run `npm run service:uninstall && npm run service:install`.'
    );
  }
  if (has('WINDROW_POLICY_AUTHORITY') && /^central$/i.test(process.env.WINDROW_POLICY_AUTHORITY) && !has('WINDROW_CENTRAL_URL')) {
    // server/policy/authority.js requires BOTH and downgrades to node-authoritative with only one.
    // It logs that once at boot, into a service log nobody opens — so it is said here instead,
    // while somebody is reading.
    console.log(
      '\n  WARNING: WINDROW_POLICY_AUTHORITY=central is captured but WINDROW_CENTRAL_URL is NOT.\n'
      + '           server/policy/authority.js needs both and silently falls back to node-authoritative\n'
      + '           with only one, so this service would enforce its own tables while looking like a\n'
      + '           read replica. Set WINDROW_CENTRAL_URL before installing.'
    );
  }
  console.log('\nVerify the result afterwards with `node scripts/verify-topology.js`.\n');
}

const svc = new Service({
  name: 'Windrow',
  description:
    'Windrow: backend API + built frontend served together on one port ' +
    '(http://localhost:4000).',
  script: path.join(__dirname, '..', 'server', 'supervisor.js'),
  nodeOptions: [],
  env,
});

svc.on('install', () => {
  console.log(`Service "${svc.name}" installed. Starting it now...`);
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log(
    `Service "${svc.name}" is already installed — its environment was NOT updated.\n`
    + 'The captured variables are baked into server/daemon/windrow.xml at install time, so run\n'
    + '`npm run service:uninstall` first if you changed any of the configuration printed above.'
  );
});

svc.on('start', () => {
  console.log(`Service "${svc.name}" is running: http://localhost:${process.env.PORT || 4000}/api`);
});

svc.on('error', (err) => {
  console.error('Service install/start error:', err);
  process.exitCode = 1;
});

console.log(
  `Installing Windows service "${svc.name}" -> node ${svc.script}\n` +
    'This requires an elevated (Administrator) terminal.'
);
printCapture();

// --dry-run stops here, after the printout and before the SCM call. It exists so the capture can be
// checked — and tested — without an elevated shell and without registering anything, which is the
// only part of this script that is hard to undo.
if (DRY_RUN) {
  console.log('--dry-run: nothing was registered with the Service Control Manager.');
} else {
  svc.install();
}
