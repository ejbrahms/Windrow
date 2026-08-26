#!/usr/bin/env node
'use strict';
// `npm run setup` — configure this machine as a Windrow node, a central host, or both.
//
// WHAT IT SETS UP. A Windrow deployment is one or more nodes, and optionally one central host.
// A node is a machine where agents run: it holds a SQLite registry and enforces every tool call
// through its hooks. It serves NO dashboard (docs/design/dashboard-placement.md). A central host
// holds a Postgres, the fleet's certificate authority, the fleet-wide view and the dashboard; it
// enforces nothing, and no hook talks to it.
//
// THE DEFAULT IS BOTH, ON THIS MACHINE — central in a container and a node as a host process —
// because that is the smallest install that has a user interface. A node alone is complete and
// correct, and answers every question as a command instead.
//
// HOW IT WORKS. Each step shells out to the script that owns that job — scripts/enroll.js,
// server/seed-central.js, scripts/service-install.js, scripts/verify-topology.js, docker compose —
// so this file is a sequence and a set of questions rather than a second implementation of
// anything. A wizard that only calls the real scripts cannot drift away from what they do.
//
// WHAT IT LEAVES BEHIND. One file: `windrow.env` at the repo root, read by server/config.js at
// startup (server/envFile.js). Configuration that lives only in a terminal disappears when that
// terminal closes, and a node whose fleet settings disappear reports itself healthy while sending
// nothing. Writing them down keeps "what is this host" answerable.
//
// EVERY STEP IS IDEMPOTENT AND RE-RUNNABLE. Run this as often as you like: no step destroys
// anything it did not create, and each one reports that the work is already done rather than
// redoing it.
//
//   npm run setup                    interactive, asks what this machine is
//   npm run setup -- --role central  skip the first question
//   npm run setup -- --show          print how this machine is configured, change nothing
//   npm run setup -- --dry-run       print every command it would run, run none of them
//   npm run setup -- --yes           non-interactive: take every default, fail rather than prompt

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

// Load windrow.env into this process too, so a re-run sees what the last run decided and offers it
// back as the default instead of asking from scratch.
require('../server/config');
const envFile = require('../server/envFile');
const { writeSecret } = require('../server/enrollment/secretFile');

const ROOT = path.join(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'server', 'central', 'docker-compose.yml');
// The overlay that bind-mounts the host's real CA into the container, and the only reason it is
// ever safe to start `central` from these files on a machine that has enrolled a node. Paired with
// COMPOSE_FILE everywhere, exactly as `npm run central:up` pairs them.
const COMPOSE_HOST_CA_FILE = path.join(ROOT, 'server', 'central', 'docker-compose.host-ca.yml');
// container_name in docker-compose.yml, so it is fixed rather than project-prefixed like a volume.
const CENTRAL_CONTAINER = 'windrow-central';

// ---------------------------------------------------------------------------------------------
// Output
//
// WRITING STYLE, for whoever edits this file. Everything this script prints follows the Google
// developer documentation style guide (https://developers.google.com/style): sentence-case
// headings, bare-infinitive headings for tasks, second person, active voice, present tense, and
// the four notice types below. Notices are deliberately rare — the guide's rule is that grouping
// them together trains readers to skip them, so ordinary explanation is body text and a label
// means something.
//
// No dependency: this script can run before `npm install` has finished, so it must not import
// anything that is not already on disk.

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

/**
 * The four notice types from the style guide, and nothing else.
 *
 *   Note      useful, but you can still succeed if you skip it
 *   Caution   proceed with care
 *   Warning   stronger than a caution — don't do this, or it cannot be undone
 *   Success   a positive outcome, allowed here because this is interactive rather than a static page
 *
 * `body` and `detail` are NOT notices. They exist because the commonest way to misuse this
 * taxonomy is to label four consecutive lines "Note", which is how readers learn to skip all of
 * them. Ordinary explanation goes through `body`; supporting material a reader can skim goes
 * through `detail`.
 *
 * `ok` marks a step as finished. It is a progress marker rather than a Success notice, for the same
 * reason: a run that says "Success" nine times has said it none.
 */
const ok = (s) => console.log(`  ${green('OK')}       ${s}`);
const success = (s) => console.log(`  ${green('Success:')} ${s}`);
const note = (s) => console.log(`  ${cyan('Note:')}    ${s}`);
const caution = (s) => console.log(`  ${yellow('Caution:')} ${s}`);
const warning = (s) => console.log(`  ${red('Warning:')} ${s}`);
const failure = (s) => console.log(`  ${red('Error:')}   ${s}`);
const body = (s) => console.log(`           ${s}`);
const detail = (s) => console.log(`           ${dim(s)}`);

/**
 * A step heading: a bare infinitive in sentence case, with the counter on its own line above.
 *
 * The style guide says not to put sequence numbers in headings, because in a document the numbering
 * duplicates what navigation already shows. A terminal has no navigation, and the counter is the
 * only way to know how much is left, so it stays — as a separate progress line rather than as part
 * of the heading text, which keeps the heading itself clean and translatable.
 */
function heading(n, total, title) {
  console.log(`\n${dim(`Step ${n} of ${total}`)}`);
  console.log(bold(title));
}

// ---------------------------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const DRY_RUN = has('--dry-run');
const ASSUME_YES = has('--yes') || has('-y');
const SHOW_ONLY = has('--show');
const ROLE_ARG = opt('--role');

/**
 * `--help` prints the header block at the top of this file, and only that block.
 *
 * Filtering the whole file for lines beginning with `//` also picks up every section divider and
 * every internal aside, which is how help output ends up showing a reader a row of dashes and a
 * note about module load order. So this stops at the first line that is not a comment — the blank
 * line before the first `require` — which makes the header the help text and leaves everything
 * below it for whoever is reading the source.
 */
if (has('--help') || has('-h')) {
  const lines = [];
  for (const line of fs.readFileSync(__filename, 'utf8').split('\n')) {
    if (line.startsWith('#!') || line.startsWith("'use strict'")) continue;
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Questions

let rl = null;
function prompt(question) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

/**
 * Ask for a value, offering a default. With --yes it takes the default silently; with --yes and no
 * default it stops, because a non-interactive run that invents a database URL is worse than one
 * that refuses to guess.
 */
async function ask(question, fallback = null, { secret = false } = {}) {
  if (ASSUME_YES) {
    if (fallback === null) {
      failure(`--yes was given, but "${question}" has no default. Pass it explicitly, or drop --yes.`);
      process.exit(1);
    }
    return fallback;
  }
  const shown = fallback === null || fallback === '' ? '' : ` ${dim(`[${secret ? '****' : fallback}]`)}`;
  const answer = await prompt(`  ${question}${shown}: `);
  return answer || fallback || '';
}

async function askYesNo(question, defaultYes = true) {
  if (ASSUME_YES) return defaultYes;
  const answer = await prompt(`  ${question} ${dim(defaultYes ? '[Y/n]' : '[y/N]')} `);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

/** Ask a multiple-choice question. `choices` is [{key, title, detail}]. Returns the chosen key. */
async function askChoice(question, choices, defaultKey) {
  if (ASSUME_YES) return defaultKey;
  console.log(`\n  ${bold(question)}`);
  choices.forEach((choice, i) => {
    const marker = choice.key === defaultKey ? green('>') : ' ';
    console.log(`   ${marker} ${cyan(String(i + 1))}. ${choice.title}`);
    if (choice.detail) console.log(`        ${dim(choice.detail)}`);
  });
  const answer = await prompt(`  Choose 1-${choices.length} ${dim(`[${choices.findIndex((x) => x.key === defaultKey) + 1}]`)}: `);
  if (!answer) return defaultKey;
  const idx = Number(answer) - 1;
  if (Number.isInteger(idx) && choices[idx]) return choices[idx].key;
  const byKey = choices.find((x) => x.key === answer.toLowerCase());
  if (byKey) return byKey.key;
  console.log(`  ${red('That is not one of the options.')}`);
  return askChoice(question, choices, defaultKey);
}

// ---------------------------------------------------------------------------------------------
// Running commands
//
// Every external command goes through `run`, so --dry-run is a property of this script rather than
// something each step has to remember, and so a failure prints the command that produced it.

/**
 * `shell: true` is what makes `npm` work on Windows without hardcoding `.cmd`, and it is also what
 * breaks an unquoted path containing a space: the default Node install lives at
 * `C:\Program Files\nodejs\node.exe`, and cmd.exe reads that as the command `C:\Program` with an
 * argument `Files\nodejs\node.exe`. Every step below invokes `process.execPath`, so on a default
 * Windows install this quoting decides whether the script works at all. Arguments are quoted at
 * each call site, where it is known whether a value is a path or a flag.
 */
const quoteIfNeeded = (s) => (/\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s);

function run(cmd, args, { cwd = ROOT, env = process.env, capture = false, allowFail = false, label = null } = {}) {
  const command = quoteIfNeeded(cmd);
  const shown = `${command} ${args.join(' ')}`;
  if (DRY_RUN) {
    console.log(`           ${dim('would run:')} ${shown}`);
    return { status: 0, stdout: '', stderr: '', dryRun: true };
  }
  if (label) detail(label);
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: true,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !allowFail) {
    failure(`\`${shown}\` failed with exit code ${result.status}.`);
    if (capture && result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

/**
 * Does the Compose data volume already exist?
 *
 * Matched by suffix, not by exact name: Compose prefixes a volume with its project, which defaults
 * to the directory holding the compose file, so the volume declared as `windrow-central-data` is
 * actually created as `central_windrow-central-data` — and would be something else again under
 * `-p`. False when Docker can't answer; this only decides whether to print a note, so an
 * unanswerable question means don't.
 */
function dockerVolumeExists(name) {
  if (DRY_RUN) return false;
  const probe = spawnSync('docker', ['volume', 'ls', '--format', '"{{.Name}}"'], {
    shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0 || !probe.stdout) return false;
  return probe.stdout.split('\n').some((v) => v.trim() === name || v.trim().endsWith(`_${name}`));
}

/** Is a command on PATH? Tells "Docker is not installed" apart from "Docker is not running". */
function commandExists(cmd) {
  const probe = spawnSync(cmd, ['--version'], { shell: true, stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Stop unless Docker is installed AND its daemon is answering.
 *
 * Two different facts with two different fixes, which is why they are two branches: `docker compose
 * up` reports a stopped daemon as a named-pipe error that reads like a bug in this script.
 * `whatFor` finishes the sentence "Docker is not on PATH, ...", so each caller says what it wanted
 * Docker for rather than sharing one vague line.
 */
function requireDocker(whatFor, recovery) {
  if (!commandExists('docker')) {
    failure(`Docker is not on PATH, ${whatFor}`);
    body(recovery);
    process.exit(1);
  }
  if (!DRY_RUN && run('docker', ['version', '--format', '"{{.Server.Version}}"'], { capture: true, allowFail: true }).status !== 0) {
    failure('The Docker CLI is installed, but no Docker daemon is answering.');
    body(process.platform === 'win32'
      ? 'Start Docker Desktop, wait for it to say "Engine running", then run setup again.'
      : 'Start the Docker daemon, then run setup again.');
    process.exit(1);
  }
}

/**
 * Is this process running elevated?
 *
 * `net session` reads the Server service's session list, which the SCM refuses to a non-admin
 * token — so its exit code is the cheapest elevation probe on Windows that needs nothing
 * installed. It is the same check scripts/windows/install-service.bat makes before it re-launches itself under
 * UAC.
 */
let elevatedCache = null;
function isElevated() {
  if (process.platform !== 'win32') return false;
  if (elevatedCache === null) {
    elevatedCache = spawnSync('net', ['session'], { shell: true, stdio: 'ignore' }).status === 0;
  }
  return elevatedCache;
}

/**
 * Offer to install a Windows service — but only when this shell can actually do it.
 *
 * The commonest way this wizard starts is a double-click on scripts/windows/setup.bat, which does not elevate.
 * The Service Control Manager refuses CreateService from a non-admin token, so in that shell the
 * answer "yes" can only produce an error partway up the output followed by `Setup complete.` at
 * the bottom, with nothing installed. A question whose only possible outcome is a failure is worse
 * than no question.
 *
 * So the gate comes BEFORE the prompt, and the not-elevated branch prints the one-line recovery
 * rather than a refusal: by the time this runs, everything else is already written to windrow.env,
 * and service-install.js reads that file — so running just the installer from an admin shell is a
 * complete fix and needs no second pass through the wizard.
 */
async function offerServiceInstall(question, installerScript, { extraNotes = [] } = {}) {
  if (process.platform !== 'win32') return false;

  const elevated = isElevated();

  // --dry-run reports what a correctly elevated run WOULD do, so it does not stop here — gating it
  // on the current token would make `npm run setup -- --dry-run` in an ordinary shell silently omit
  // the one step the operator is most likely to be checking. It does say which way a real run would
  // go, because "it would install a service" and "it would tell you it cannot" are different
  // answers to the question a dry run is asking.
  if (DRY_RUN && !elevated) {
    detail('this terminal is not elevated, so a real run would skip the question below and print');
    detail('the elevated command to run afterwards instead');
  }

  if (!elevated && !DRY_RUN) {
    note('This terminal is not elevated, so a service cannot be installed from it.');
    detail('The Service Control Manager refuses service creation from a non-admin process.');
    detail('Everything else here is being written to windrow.env, and the installer reads that');
    detail('file — so finish this wizard, then run the one command below from a terminal opened');
    detail('with "Run as Administrator":');
    detail('');
    detail(`  node ${path.relative(ROOT, installerScript)}`);
    return false;
  }

  if (!await askYesNo(question, false)) return false;
  for (const line of extraNotes) detail(line);
  run(process.execPath, [`"${installerScript}"`], { allowFail: true });
  return true;
}

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answer) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(700);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fresh password for a Compose Postgres the wizard is about to create.
 *
 * The default used to be `windrow`, which — paired with `windrow:windrow` in every copy of the
 * docs — meant a first-run install shipped with a credential an attacker already knows. The port
 * is loopback-only now (docker-compose.yml), so this is defence in depth rather than the only
 * wall, but a known default password on a database holding every usage row is not one to keep.
 *
 * base64url of 24 random bytes is 32 URL-safe characters, so it drops straight into a
 * `postgres://user:PASSWORD@host` connection string with no percent-encoding — a `/`, `+` or `@`
 * in the password would otherwise have to be escaped everywhere the URL is parsed. Generated once
 * per run and offered as the default, so accepting it writes a strong password into windrow.env
 * that the container's volume is then initialised with.
 */
function randomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// Settings
//
// Collected in one object and written ONCE, at the end of a role's steps, rather than incrementally
// — so a run you abandon halfway leaves the previous configuration intact instead of a half-applied
// one. A half-configured node, with a central URL but no credential, is exactly the state that
// looks healthy and ships nothing.

const settings = {};
const set = (key, value) => { settings[key] = value; };
/**
 * The current value of a setting: a real environment variable first, then windrow.env, then the
 * default this script suggests.
 *
 * The WINDROW_NO_ENV_FILE check is not redundant with server/config.js's. That flag stops config.js
 * loading the file into process.env, but this function reads the file DIRECTLY, so without the
 * check the flag would half-work: the rest of the process would ignore windrow.env while the wizard
 * kept offering its values as defaults. Half-honouring a flag named "no env file" is worse than not
 * having it.
 */
const current = (key, fallback = null) => {
  if (process.env[key] !== undefined) return process.env[key];
  if (process.env.WINDROW_NO_ENV_FILE === '1') return fallback;
  return envFile.read()[key] || fallback;
};

function persist(headerLine) {
  if (DRY_RUN) {
    console.log(`           ${dim('would write windrow.env:')}`);
    Object.keys(settings).sort().forEach((k) => console.log(`             ${k}=${redactIfSecret(k, settings[k])}`));
    return;
  }
  const { file, keys } = envFile.write(settings, { header: headerLine });
  ok(`Wrote ${path.relative(ROOT, file)} with ${keys.length} settings.`);
  Object.keys(settings).sort().forEach((k) => detail(`${k}=${redactIfSecret(k, settings[k])}`));
}

/** Redact only the part that is actually secret. A Postgres URL with the password blanked is still
 *  worth reading back; a wholly hidden value is not. */
function redactIfSecret(key, value) {
  if (value === null || value === undefined) return '(unset)';
  if (!/DB_URL|PASSWORD|TOKEN/i.test(key)) return String(value);
  return String(value).replace(/:\/\/([^:/@]+):([^@]+)@/, '://$1:****@');
}

// ---------------------------------------------------------------------------------------------
// Steps shared between roles

function ensureDependencies() {
  const missing = ['server', 'client'].filter((d) => !fs.existsSync(path.join(ROOT, d, 'node_modules')));
  if (missing.length === 0) {
    ok('Dependencies are installed.');
    return;
  }
  detail(`${missing.join(' and ')} have no node_modules. Installing them now.`);
  run('npm', ['run', 'install:all']);
  ok('Dependencies installed.');
}

/**
 * Report where the certificate authority lives, and on a central host say what that means.
 *
 * WINDROW_CA_DIR defaults to server/data/ca. On a central host that directory holds the fleet's
 * trust root: a copy of it can issue an admin certificate for any node id in the fleet, so it has
 * to exist in exactly one place. That is a Warning rather than a Caution because copying the
 * directory cannot be undone — once the key is on a second machine, the only remedy is to reissue
 * the whole fleet.
 */
function reportCaLocation(role) {
  const caDir = current('WINDROW_CA_DIR', path.join(ROOT, 'server', 'data', 'ca'));
  const exists = fs.existsSync(path.join(caDir, 'ca-cert.pem'));
  if (role === 'central') {
    if (exists) ok(`The certificate authority is at ${caDir}`);
    else ok(`Windrow creates the certificate authority at ${caDir} when central first starts.`);
    warning('That directory holds the fleet\'s private key. Don\'t copy it to another machine.');
    body('A copy can issue an admin certificate for any node in the fleet. Back it up encrypted,');
    body('and keep it on this host only.');
  } else if (exists) {
    ok(`This node's own certificate authority is at ${caDir}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Central host

async function configureCentralDatabase() {
  const existing = current('WINDROW_CENTRAL_DB_URL');
  if (existing && await askYesNo(`Keep the configured database (${redactIfSecret('WINDROW_CENTRAL_DB_URL', existing)})?`, true)) {
    set('WINDROW_CENTRAL_DB_URL', existing);
    // Checked here rather than left to the schema step, so a database that is simply not running is
    // reported as that, in the step that is about the database.
    requireReachable(existing);
    ok(`Using ${redactIfSecret('WINDROW_CENTRAL_DB_URL', existing)}`);
    return existing;
  }

  const source = await askChoice('Where does the central Postgres come from?', [
    {
      key: 'compose',
      title: 'Start one here with Docker Compose',
      detail: 'server/central/docker-compose.yml — Postgres 16, one container, a named volume.',
    },
    {
      key: 'existing',
      title: 'Use a Postgres you already have',
      detail: 'Enter its connection URL at the next prompt.',
    },
  ], commandExists('docker') ? 'compose' : 'existing');

  if (source === 'existing') {
    const url = await ask('Connection URL', 'postgres://windrow:windrow@localhost:5432/windrow_central');
    set('WINDROW_CENTRAL_DB_URL', url);
    requireReachable(url);
    ok('That database answered.');
    return url;
  }

  requireDocker('so Compose cannot start a database here.',
    'Install Docker Desktop, or run setup again and choose the existing-Postgres option.');

  const user = await ask('Postgres user', 'windrow');
  // A fresh random password by default, not `windrow`. The volume keeps whatever it is first
  // created with, so this is the one moment the credential is chosen — and it is written to
  // windrow.env below, so accepting the default is not "no password", it is a strong one you can
  // read back. Under --yes this default is taken silently, which is the point: an unattended
  // install must not fall back to a password every copy of the docs prints.
  const password = await ask('Postgres password', randomPassword(), { secret: true });
  const database = await ask('Database name', 'windrow_central');
  const port = await ask('Host port to publish Postgres on', '5432');
  // A named volume outlives `down`, and Postgres honours these three only when it *initialises* a
  // data directory. Answering them differently on a later run therefore does nothing, and the
  // disagreement surfaces two steps later as a login or missing-database failure — so say it here,
  // where the answers were just given.
  if (dockerVolumeExists('windrow-central-data')) {
    note('The windrow-central-data volume already exists, from an earlier run.');
    body('Postgres applies the user, password and database name only when it first creates its');
    body('data directory, so the container keeps the ones that volume was made with. If the');
    body('answers above differ from those, the next step will say so and tell you what to do.');
  }

  // `postgres`, NAMED — this step starts the DATABASE only. `docker compose up` with no service
  // argument starts every service in the file, and this file also defines `central`; from the base
  // file alone that container gets a PRIVATE, EMPTY CA volume and mints a brand-new root on first
  // boot, which orphans every enrolled node in the fleet at once (docker-compose.yml's header
  // caution, and why `npm run central:db` names its service too). The central *process* is a
  // separate, later step the operator runs with the host-CA overlay — `npm run central:up` — never
  // this one.
  updateComposeEnv({
    POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database, POSTGRES_PORT: port,
  });
  run('docker', ['compose', '-f', `"${COMPOSE_FILE}"`, 'up', '-d', 'postgres'], {
    env: {
      ...process.env,
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
      POSTGRES_PORT: port,
    },
    label: 'Starting the central Postgres container...',
  });

  const url = `postgres://${user}:${password}@localhost:${port}/${database}`;
  set('WINDROW_CENTRAL_DB_URL', url);
  await waitForPostgres(url);
  return url;
}

/**
 * Record Compose settings where Compose itself will find them.
 *
 * `docker compose` reads a `.env` beside the compose file, and the `central` SERVICE builds its own
 * WINDROW_CENTRAL_DB_URL out of POSTGRES_USER/PASSWORD/DB. Without this file the answers given here
 * reach only the `postgres` service this script starts, and a later `npm run central:up` — run in a
 * shell that never saw them — hands central the compose defaults, which a volume initialised with a
 * generated password rejects. That failure surfaces as an authentication error inside a container,
 * several steps from the prompt that caused it.
 *
 * MERGED, not overwritten, because two different steps write to it: the database step sets the
 * Postgres credentials and the container step sets the published ports. Written 0600 because it
 * holds that password; `.gitignore` already covers `.env*` at any depth.
 */
function updateComposeEnv(values) {
  const file = path.join(path.dirname(COMPOSE_FILE), '.env');
  if (DRY_RUN) {
    console.log(`           ${dim('would write:')} ${path.relative(ROOT, file)}`);
    Object.keys(values).forEach((k) => console.log(`             ${k}=${redactIfSecret(k, values[k])}`));
    return;
  }
  const merged = {};
  try {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) merged[match[1]] = match[2];
    });
  } catch { /* first run — nothing to merge with */ }
  Object.assign(merged, values);
  writeSecret(file, [
    '# Written by `npm run setup`. Docker Compose reads this file automatically, so `central:db`,',
    '# `central:up` and a bare `docker compose` all agree about the database and the ports.',
    ...Object.keys(merged).sort().map((k) => `${k}=${merged[k]}`),
    '',
  ].join('\n'));
  ok(`Wrote ${path.relative(ROOT, file)} so Compose starts central against the same database.`);
}

/**
 * How the child scripts below report a failure so this one can explain it.
 *
 * `err.message` is not enough, and the way it is not enough is the reason this exists. Node 18+
 * connects to `localhost` on both ::1 and 127.0.0.1 and, when both are refused, rejects with an
 * `AggregateError` whose **`message` is the empty string** — the individual `ECONNREFUSED`s are in
 * `err.errors`. So `console.error(err.message)` on the commonest failure this script can hit (a
 * Postgres that isn't running) printed a blank line, and the step above it reported that something
 * had gone wrong without ever saying what. Flattening the tree and carrying the `code` out is what
 * turns that back into an error a reader can act on.
 *
 * Injected into each child as source rather than required, because these run in a separate process
 * against a temp file and must not depend on anything this repo has not installed yet.
 */
const DB_ERROR_REPORTER = `
  function reportDbError(err) {
    const parts = [];
    const codes = [];
    const seen = new Set();
    (function walk(e) {
      if (!e || typeof e !== 'object' || seen.has(e)) return;
      seen.add(e);
      if (e.code && !codes.includes(e.code)) codes.push(e.code);
      const msg = e.message || '';
      if (msg) parts.push(e.code && !msg.includes(e.code) ? msg + ' (' + e.code + ')' : msg);
      if (Array.isArray(e.errors)) e.errors.forEach(walk);
      if (e.cause) walk(e.cause);
    })(err);
    const text = [...new Set(parts)].join('\\n');
    console.error(text || (err && err.stack) || String(err));
    if (codes.length) console.error('WINDROW_DB_CODE ' + codes.join(','));
    process.exit(1);
  }
`;

/** Write `script` to a temp file and run it through `run()`. Via a file rather than `node -e`
 *  because run() goes through a shell so --dry-run can print the command it would have run, and a
 *  multi-line -e argument does not survive cmd.exe intact. */
let probeSeq = 0;
function runNodeScript(script, env) {
  const scriptFile = path.join(os.tmpdir(), `windrow-setup-${process.pid}-${probeSeq += 1}.js`);
  fs.writeFileSync(scriptFile, script);
  try {
    return run(process.execPath, [`"${scriptFile}"`], { env, capture: true, allowFail: true });
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* best effort */ }
  }
}

/** The `WINDROW_DB_CODE` line a child emitted, split out from the human-readable part. */
function splitDbFailure(result) {
  const lines = `${result.stderr || ''}\n${result.stdout || ''}`.split('\n');
  const codes = [];
  const text = [];
  for (const line of lines) {
    if (line.startsWith('WINDROW_DB_CODE ')) codes.push(...line.slice('WINDROW_DB_CODE '.length).split(','));
    else if (line.trim() && !line.startsWith('WINDROW_SCHEMA ')) text.push(line.trimEnd());
  }
  return { codes, text };
}

/** Where a connection URL points, for an error message. Never the password. */
function endpointOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || '5432', database: decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default)' };
  } catch {
    return { host: '(unparseable URL)', port: '', database: '' };
  }
}

/**
 * Say what to do about a Postgres that would not answer.
 *
 * Every branch here is a failure a first run actually produces, and each has a different fix —
 * which is the point of naming the code rather than printing one generic "check your database"
 * line. The credential and database-name branches share a cause worth stating plainly: `docker
 * compose up` honours POSTGRES_USER/PASSWORD/DB only when it *initialises* the data directory, so
 * a second setup run that answers those prompts differently gets a container whose credentials are
 * still the first run's, and the mismatch surfaces here rather than at compose.
 */
function explainDbFailure(codes, url) {
  const { host, port, database } = endpointOf(url);
  const has = (code) => codes.includes(code);
  if (has('ECONNREFUSED')) {
    body(`Nothing is listening at ${host}:${port}.`);
    if (process.platform === 'win32') body('If this is the Compose database, check that Docker Desktop is running.');
    body('Start it with:  npm run central:db');
    body('Then read its log if it does not come up:');
    body('  docker compose -f server/central/docker-compose.yml logs');
    return;
  }
  if (has('ENOTFOUND') || has('EAI_AGAIN')) {
    body(`The host "${host}" does not resolve. Check the hostname in WINDROW_CENTRAL_DB_URL.`);
    return;
  }
  if (has('ETIMEDOUT')) {
    body(`${host}:${port} accepted no connection before the timeout — usually a firewall in between.`);
    return;
  }
  if (has('28P01') || has('28000')) {
    body('Postgres refused the user or password in WINDROW_CENTRAL_DB_URL.');
    body('A Compose database keeps the credentials from the run that first created its volume, so');
    body('answering these prompts differently does not change them. To start that volume over —');
    body('which DELETES every row in it — run:');
    body('  docker compose -f server/central/docker-compose.yml down -v');
    return;
  }
  if (has('3D000')) {
    body(`Postgres is running at ${host}:${port}, but it has no database called "${database}".`);
    body('A Compose database creates POSTGRES_DB only when it first initialises its volume, so a');
    body('later run that asks for a different name connects to a database nobody made. Either use');
    body('the original name, or create this one:');
    body(`  docker exec windrow-central-db createdb -U windrow ${database}`);
    return;
  }
  body(`The database is ${host}:${port}/${database}. The message above is Postgres's own.`);
}

/**
 * Is the database reachable right now? Returns null when it is, or `{codes, text}` when it is not.
 *
 * One attempt, no retry: this is the check for a database that is supposed to be up already, as
 * distinct from `waitForPostgres`, which is for one that was started a moment ago.
 */
function probePostgres(url) {
  if (DRY_RUN) return null;
  const script = `${DB_ERROR_REPORTER}
    const { openPool } = require(${JSON.stringify(path.join(ROOT, 'server', 'central', 'pgDriver.js'))});
    const pool = openPool({ connectionString: process.env.PROBE_URL });
    pool.query('SELECT 1').then(() => pool.end()).then(() => process.exit(0)).catch(reportDbError);
  `;
  const result = runNodeScript(script, { ...process.env, PROBE_URL: url });
  return result.status === 0 ? null : splitDbFailure(result);
}

/**
 * Check a database the user says already exists, and stop here if it does not answer.
 *
 * This runs on the two paths that skip `waitForPostgres` — reusing the URL a previous run wrote,
 * and naming a Postgres you already have — because those were the paths where an unreachable
 * database went undiscovered until the schema step, and was then reported as a schema problem.
 * "Postgres is not running" is not a migration failure, and calling it one sends the reader to
 * migration code.
 */
function requireReachable(url) {
  const failed = probePostgres(url);
  if (!failed) return;
  failure('That database did not answer.');
  failed.text.forEach((line) => console.error(`           ${line}`));
  explainDbFailure(failed.codes, url);
  body('Fix that and run setup again — every step it has taken so far is idempotent.');
  process.exit(1);
}

/**
 * Wait for the database to answer, rather than starting central against one that is still booting.
 * server/central/pgDriver.js fails fast by design — a 10 s connect timeout and no retry — which is
 * right for ingest, where the node keeps the rows and retries, and wrong for the twenty seconds
 * after `docker compose up`.
 */
async function waitForPostgres(url, attempts = 30) {
  if (DRY_RUN) { console.log(`           ${dim('would wait for Postgres to accept connections')}`); return true; }
  process.stdout.write('           waiting for Postgres');
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = probePostgres(url);
    if (!last) {
      process.stdout.write('\n');
      ok('Postgres is accepting connections.');
      return true;
    }
    // A database still booting refuses the connection outright; one whose volume predates the
    // answers just given is up and answering, and will never start agreeing however long this
    // waits. So anything that is not a connection-level refusal ends the loop and is explained now
    // rather than thirty seconds from now under the wrong headline.
    if (!last.codes.some((code) => ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code))) break;
    process.stdout.write('.');
    await sleep(1000);
  }
  process.stdout.write('\n');
  // Two different failures, and the headline has to tell them apart: waiting longer is the fix for
  // one and could never be the fix for the other.
  const refused = !last || last.codes.some((code) => ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code));
  failure(refused ? 'Postgres never accepted a connection.' : 'Postgres answered, and refused this connection.');
  if (last) {
    last.text.forEach((line) => console.error(`           ${line}`));
    explainDbFailure(last.codes, url);
  }
  process.exit(1);
  return false;
}

/**
 * Bring the central schema up to date.
 *
 * This calls server/central/store.js's own `open()`, which is the same call the central process
 * makes when it starts, so there is only one definition of what the schema is. That is also why
 * docker-compose.yml carries no init.sql: one migrator, one ledger, one answer to "what version is
 * this database at".
 */
function initialiseCentralSchema(url) {
  if (DRY_RUN) {
    console.log(`           ${dim('would run the central migrations and create this month\'s partitions')}`);
    return null;
  }
  // An ABSOLUTE require path, because the script below is written to the temp directory and
  // `require` resolves relative to the file, not to the child's cwd. A relative './server/...' here
  // fails with MODULE_NOT_FOUND on any machine whose temp directory is outside the repo.
  const script = `${DB_ERROR_REPORTER}
    process.env.WINDROW_CENTRAL_DB_URL = process.env.PROBE_URL;
    const store = require(${JSON.stringify(path.join(ROOT, 'server', 'central', 'store.js'))});
    store.open()
      .then(async (driver) => {
        const v = await driver.get('SELECT MAX(version) AS v FROM schema_migrations');
        const authority = await driver.ddl.hasTable('policy_changes');
        console.log('WINDROW_SCHEMA ' + JSON.stringify({
          version: Number(v && v.v) || 0, mode: authority ? 'authority' : 'shadow',
        }));
        await store.close();
      })
      .catch(reportDbError);
  `;
  const result = runNodeScript(script, { ...process.env, PROBE_URL: url });
  if (result.status !== 0) {
    failure('Couldn\'t bring the central schema up to date.');
    const failed = splitDbFailure(result);
    failed.text.forEach((line) => console.error(`           ${line}`));
    explainDbFailure(failed.codes, url);
    process.exit(1);
  }
  const line = result.stdout.split('\n').find((l) => l.startsWith('WINDROW_SCHEMA '));
  let parsed = null;
  try { parsed = JSON.parse(line.slice('WINDROW_SCHEMA '.length)); } catch { /* fall through */ }
  if (parsed) {
    ok(`Schema is at version ${parsed.version}. This database supports ${parsed.mode} mode.`);
    detail('The same call creates the monthly partitions for usage_events, so the first batch a');
    detail('node ships doesn\'t land in the default partition.');
  } else {
    ok('Schema is up to date.');
  }
  return parsed;
}

async function chooseFleetMode(defaultKey = 'shadow') {
  return askChoice('How does this fleet use central?', [
    {
      key: 'shadow',
      title: 'Shadow — usage goes up, each node keeps its own policy authority',
      detail: 'No decision a node makes depends on central. If central stops, you lose the fleet '
        + 'view and nothing else. `npm run shadow:compare` reports how far the two sides agree.',
    },
    {
      key: 'authority',
      title: 'Active — central owns capabilities and grants, and nodes read a replica',
      detail: 'Central issues the ids and holds the canonical rows. Nodes keep enforcing from their '
        + 'replica when central is unreachable, so a tool call never waits on the network. In this '
        + 'mode `npm run seed` on a node is refused; you seed the catalog at central instead.',
    },
  ], defaultKey);
}

async function setupCentral() {
  const steps = 8;
  console.log(bold('\nSet up a central host'));
  body('You need one central host per fleet. It holds the Postgres, the fleet\'s certificate');
  body('authority, and — in active mode — the canonical capabilities and grants. It is not a node:');
  body('it enforces nothing, and no hook ever talks to it.');

  heading(1, steps, 'Install dependencies');
  ensureDependencies();

  heading(2, steps, 'Set up the database');
  const url = await configureCentralDatabase();

  heading(3, steps, 'Create the schema');
  initialiseCentralSchema(url);

  heading(4, steps, 'Choose a mode');
  const mode = await chooseFleetMode(current('WINDROW_FLEET_MODE', 'shadow'));
  set('WINDROW_FLEET_MODE', mode);
  ok(mode === 'authority'
    ? 'Active mode. Central is the policy authority, and nodes get WINDROW_POLICY_AUTHORITY=central.'
    : 'Shadow mode. Central receives usage and answers fleet questions; nodes stay authoritative.');
  detail('Recorded in windrow.env, so setup on each node can offer you the matching answer.');

  heading(5, steps, 'Configure the listeners');
  const tlsPort = await ask('Mutual-TLS port, which is what nodes connect to', current('WINDROW_CENTRAL_TLS_PORT', '5443'));
  set('WINDROW_CENTRAL_TLS_PORT', tlsPort);
  const insecure = await askYesNo('Also open the loopback plaintext listener, for development?', false);
  if (insecure) {
    set('WINDROW_CENTRAL_ALLOW_INSECURE', '1');
    set('WINDROW_CENTRAL_PORT', await ask('Plaintext port', current('WINDROW_CENTRAL_PORT', '5000')));
    caution('On the plaintext listener, central attributes a batch to whatever node id it claims,');
    body('because there is no certificate to check it against. Turn WINDROW_CENTRAL_ALLOW_INSECURE');
    body('off before this host faces a network.');
  } else {
    set('WINDROW_CENTRAL_ALLOW_INSECURE', null);
    set('WINDROW_CENTRAL_PORT', null);
  }
  const sans = await ask(
    'Hostnames and IPs that nodes reach this host by, comma-separated',
    current('WINDROW_SERVER_SANS', os.hostname()),
  );
  set('WINDROW_SERVER_SANS', sans);
  detail('These go into central\'s server certificate. A node that connects by a name you leave out');
  detail('fails on the hostname rather than on the certificate chain — a different error, and a');
  detail('more common one.');

  heading(6, steps, 'Locate the certificate authority');
  reportCaLocation('central');
  detail('Central issues node certificates from this authority through POST /api/enroll. That is');
  detail('what lets a node on a second machine hold a credential central trusts.');

  heading(7, steps, 'Seed the catalog');
  if (mode === 'authority') {
    if (await askYesNo('Seed the starter capability catalog into central now?', true)) {
      run(process.execPath, [`"${path.join(ROOT, 'server', 'seed-central.js')}"`], {
        env: { ...process.env, WINDROW_CENTRAL_DB_URL: url },
        allowFail: true,
        label: 'Seeding the central catalog...',
      });
      ok('Catalog seeded. Seeding is idempotent, so running setup again won\'t duplicate it.');
    } else {
      detail('Skipped. Run `npm run seed:central` when you want it. Until then central holds no');
      detail('capabilities, so there is nothing to grant any node access to.');
    }
  } else {
    detail('In shadow mode each node holds its own catalog, so there is nothing to seed at central');
    detail('yet. Run `npm run seed:central` when you switch to active mode.');
  }

  heading(8, steps, 'Start central');
  persist('Role: central host.');
  const asService = await offerServiceInstall(
    'Install central as a Windows service, so it survives a reboot?',
    path.join(ROOT, 'scripts', 'central-install.js'),
    { extraNotes: ['The installer waits for the database to answer before it starts the service.'] },
  );
  if (!asService) ok('To start central, run: npm run central');

  await finish('central', { url, mode, tlsPort });
}

// ---------------------------------------------------------------------------------------------
// Node

async function setupNode({ joinFleet }) {
  const steps = joinFleet ? 9 : 6;
  let step = 0;
  const next = (title) => heading((step += 1), steps, title);

  console.log(bold(joinFleet ? '\nSet up a node that joins a fleet' : '\nSet up a standalone node'));
  body('A node is what a hook talks to. server/supervisor.js holds the public port permanently and');
  body('runs the API as a child process, so restarting the backend holds hook requests for a few');
  body('seconds instead of denying every mutating call.');

  next('Install dependencies');
  ensureDependencies();

  next('Choose ports');
  const port = await ask('Port the supervisor listens on, which is what hooks connect to', current('PORT', '4000'));
  set('PORT', port);
  set('WINDROW_UPSTREAM_PORT', await ask('Private upstream port for the API child process', current('WINDROW_UPSTREAM_PORT', '4100')));
  set('WINDROW_TLS_PORT', await ask('Mutual-TLS port for the dashboard and the CLI', current('WINDROW_TLS_PORT', '4443')));
  if (await portInUse(Number(port))) {
    caution(`Something is already listening on port ${port}. \`npm start\` offers to stop it.`);
  } else {
    ok(`Port ${port} is free.`);
  }

  next('Set the database and paths');
  set('WINDROW_DB_PATH', await ask('SQLite database',
    current('WINDROW_DB_PATH', path.join(ROOT, 'server', 'data', 'windrow.db'))));
  set('WINDROW_USER_HOME', await ask('Your home directory, where ~/.claude and ~/.gemini live',
    current('WINDROW_USER_HOME', os.homedir())));
  detail('Windrow captures your home directory because the Windows service runs as LocalSystem,');
  detail('whose home is C:\\WINDOWS\\system32\\config\\systemprofile — not the one hooks need.');

  next('Build the dashboard');
  if (fs.existsSync(path.join(ROOT, 'client', 'dist', 'index.html'))) {
    ok('The dashboard is already built.');
    if (await askYesNo('Rebuild it?', false)) run(process.execPath, [`"${path.join(ROOT, 'scripts', 'build-client.js')}"`]);
  } else {
    run(process.execPath, [`"${path.join(ROOT, 'scripts', 'build-client.js')}"`], { label: 'Building the dashboard...' });
    ok('Dashboard built.');
  }

  if (!joinFleet) {
    next('Seed the catalog');
    if (await askYesNo('Seed the starter capability catalog into this node\'s database?', true)) {
      run('npm', ['run', 'seed', '--prefix', 'server'], { allowFail: true, label: 'Seeding...' });
      ok('Catalog seeded.');
    }

    next('Start the node');
    reportCaLocation('node');
    persist('Role: standalone node. No central — this is the single-machine install.');
    const asService = await offerServiceInstall(
      'Install this node as a Windows service?',
      path.join(ROOT, 'scripts', 'service-install.js'),
    );
    if (!asService) ok('To start the node, run: npm start');
    await finish('node-standalone', { port });
    return;
  }

  next('Point this node at central');
  const centralUrl = await ask('Central\'s base URL, as this node reaches it',
    current('WINDROW_CENTRAL_URL', 'https://central.example:5443'));
  set('WINDROW_CENTRAL_URL', centralUrl);
  if (/^http:/i.test(centralUrl) && !/127\.0\.0\.1|localhost/i.test(centralUrl)) {
    caution('That URL is plaintext to a host that isn\'t loopback, and central refuses it: the');
    body('plaintext listener binds 127.0.0.1 only. Use the https mutual-TLS port instead.');
  }

  next('Choose a mode');
  const mode = await askChoice('What is central\'s role for this node?', [
    {
      key: 'shadow',
      title: 'Shadow — send usage up, and keep this node\'s own policy authority',
      detail: 'No decision this node makes depends on central being reachable.',
    },
    {
      key: 'authority',
      title: 'Active — central owns capabilities and grants',
      detail: 'This node reads a replica and the deny-list. `npm run seed` here is refused, '
        + 'correctly: no delta can correct a capability written locally.',
    },
  ], current('WINDROW_FLEET_MODE', 'shadow'));
  set('WINDROW_FLEET_MODE', mode);
  set('WINDROW_POLICY_AUTHORITY', mode === 'authority' ? 'central' : null);
  ok(mode === 'authority'
    ? 'Active mode. Policy comes down from central, and usage goes up.'
    : 'Shadow mode. This node keeps its policy authority, and usage goes up.');
  detail('In both modes the node keeps enforcing from its local tables when central is unreachable.');
  detail('A tool call never waits on central.');

  next('Enroll this node');
  await enrollAgainstCentral(centralUrl);

  next('Start the node');
  reportCaLocation('node');
  persist(`Role: node in a fleet, ${mode} mode. Central: ${centralUrl}`);
  const asService = await offerServiceInstall(
    'Install this node as a Windows service?',
    path.join(ROOT, 'scripts', 'service-install.js'),
    {
      extraNotes: [
        'The installer captures the fleet configuration above into the service. Without it the',
        'service comes back up standalone, sends nothing, and still reports itself healthy.',
      ],
    },
  );
  if (!asService) ok('To start the node, run: npm start');

  await finish('node-fleet', { port, centralUrl, mode });
}

/**
 * Enroll this node against central.
 *
 * A node that enrolls against its OWN server holds a certificate signed by its own authority,
 * which central does not trust and rejects at the TLS layer with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 * So the URL enrolled against here has to be CENTRAL'S, which is worth saying rather than
 * defaulting quietly.
 */
async function enrollAgainstCentral(centralUrl) {
  const credentialDir = current('WINDROW_CREDENTIAL_DIR', path.join(ROOT, 'server', 'data', 'credentials'));
  set('WINDROW_CREDENTIAL_DIR', credentialDir);

  // `node-shipper`, not `node`, and this is not cosmetic. server/usageShipper.js and
  // server/policy/policyClient.js both load the credential named by WINDROW_SHIP_CREDENTIAL_NAME,
  // which defaults to `node-shipper`. Enrolling under any other name produces a perfectly valid
  // certificate that nothing ever presents — a node that looks enrolled, sends nothing, and reports
  // no error.
  const credentialName = current('WINDROW_SHIP_CREDENTIAL_NAME', 'node-shipper');

  if (fs.existsSync(path.join(credentialDir, `${credentialName}-cert.pem`)) && !DRY_RUN) {
    ok(`This node already has a credential in ${credentialDir}`);
    if (!await askYesNo('Enroll again? You need to only if it expired, was revoked, or came from a different authority.', false)) {
      detail('Keeping it. `npm run verify:topology` tells you whether central trusts it.');
      return;
    }
  }

  console.log(`\n  ${bold('Where to get an enrollment token')}`);
  body('An admin on the central host issues one. It is single-use and valid for 24 hours:');
  body('');
  body(`  POST ${centralUrl}/api/enrollment-tokens   {"scope":"node","label":"this PC"}`);
  body('');
  body('presented with an admin client certificate. If no admin is enrolled at central yet, the');
  body('bootstrap token is at server/data/bootstrap-enrollment-token on that host.');
  note('The token is the only thing that authorizes this step, because this node has no');
  body('certificate yet. That is what enrollment is for.');

  const token = process.env.WINDROW_ENROLLMENT_TOKEN
    || await ask('Enrollment token, or leave blank to do this later', '', { secret: true });
  if (!token) {
    caution('Until this node enrolls, it can neither send usage nor pull policy.');
    body(`To enroll later, run: node scripts/enroll.js --name ${credentialName} --url ${centralUrl} --token <token>`);
    return;
  }

  const label = await ask('A label for this node', os.hostname());
  const caFile = await ask('Central\'s CA certificate file, if you have one', '');

  const parsed = runEnroll({
    url: centralUrl, name: credentialName, label, dir: credentialDir, token, caFile,
    activity: 'Enrolling against central...',
  });
  if (!parsed) {
    if (DRY_RUN) return;
    body('The token is single-use. If it was already spent, issue a fresh one at central and run:');
    body(`  node scripts/enroll.js --name ${credentialName} --url ${centralUrl} --token <token>`);
    body('Setup continues, because everything else on this node is configured.');
    return;
  }
  if (parsed.nodeId) {
    ok(`Enrolled as ${parsed.nodeId}, scope ${parsed.scope}, valid until ${parsed.notAfter}.`);
    set('WINDROW_NODE_ID', parsed.nodeId);
  } else {
    ok('Enrolled.');
  }
}

// ---------------------------------------------------------------------------------------------
// Central in a container and a node on this machine — the default role.
//
// THE SHAPE THIS PRODUCES: central is two containers (`windrow-central` and `windrow-central-db`),
// the node is a host process, and the two share this repo's `server/data/ca`. That sharing is what
// makes a one-machine fleet enrollable at all — central verifies node client certificates against
// the same root that signed them — and it is equally this configuration's one blind spot: the
// certificate-authority mismatch a real two-host fleet can hit cannot happen here, so this setup
// will never catch it.
//
// WHY THE CONTAINER RATHER THAN `npm run central`. A host-run central never raises the `:5599`
// dashboard proxy — server/central/dashboardProxy.js starts only when CENTRAL_DASHBOARD_PORT is
// set, which docker-compose.yml sets and a host process does not. Since dashboard-placement.md
// moved the console off the node, "no proxy" means no user interface anywhere on a single-machine
// install. This role is the wizard's default precisely because it is the one that has one.

async function setupDevBoth() {
  const steps = 8;
  console.log(bold('\nSet up central in a container and a node on this machine'));
  body('The recommended single-machine install: enforcement runs here as a host process, and the');
  body('dashboard is served by central in Docker at http://localhost:5599.');
  caution('Both halves share this repo\'s certificate authority, so the authority mismatch that a');
  body('real two-host fleet can hit cannot happen here, and this setup will not catch it. Test');
  body('that on two machines before you rely on it.');

  heading(1, steps, 'Check the prerequisites');
  ensureDependencies();
  requireDocker('and central runs as a container on this path.',
    'Install Docker Desktop, or run setup again and choose "A node, on its own" — no Docker and no '
    + 'database, at the cost of the dashboard.');

  heading(2, steps, 'Set up the database');
  const url = await configureCentralDatabase();

  heading(3, steps, 'Create the schema');
  initialiseCentralSchema(url);

  heading(4, steps, 'Choose a mode and seed the catalog');
  const mode = await chooseFleetMode(current('WINDROW_FLEET_MODE', 'shadow'));
  set('WINDROW_FLEET_MODE', mode);
  set('WINDROW_POLICY_AUTHORITY', mode === 'authority' ? 'central' : null);
  // Seeded BEFORE central starts, and the order is not cosmetic: seed-central.js and central's own
  // boot both cut this month's usage_events partitions, and the two racing fails on a duplicate key
  // in pg_class. A database nothing is attached to yet has nothing to race.
  if (mode === 'authority') {
    run(process.execPath, [`"${path.join(ROOT, 'server', 'seed-central.js')}"`], {
      env: { ...process.env, WINDROW_CENTRAL_DB_URL: url },
      allowFail: true,
      label: 'Seeding the central catalog...',
    });
  } else {
    run('npm', ['run', 'seed', '--prefix', 'server'], { allowFail: true, label: 'Seeding the node catalog...' });
  }

  heading(5, steps, 'Mint the certificate authority both halves share');
  mintSharedCa();

  heading(6, steps, 'Start central in a container');
  const tlsPort = await ask('Central mutual-TLS port, the one nodes dial', current('WINDROW_CENTRAL_TLS_PORT', '5443'));
  const dashboardPort = await ask('Dashboard port, published to this machine only', current('WINDROW_CENTRAL_DASHBOARD_PORT', '5599'));
  set('WINDROW_CENTRAL_TLS_PORT', tlsPort);
  set('WINDROW_CENTRAL_DASHBOARD_PORT', dashboardPort);
  await startCentralContainer({ tlsPort, dashboardPort });

  heading(7, steps, 'Enroll this node against central');
  const centralUrl = `https://127.0.0.1:${tlsPort}`;
  set('WINDROW_CENTRAL_URL', centralUrl);
  // Cleared, not merely left unset. An earlier version of this role pointed the node at central's
  // loopback PLAINTEXT listener — which the container binds to its own loopback and no `ports:`
  // entry can publish, so the node it configured could not reach the central it started. Those two
  // settings describe a host-run central that this role no longer produces.
  set('WINDROW_CENTRAL_ALLOW_INSECURE', null);
  set('WINDROW_CENTRAL_PORT', null);
  await enrollDevBothNode(centralUrl);

  heading(8, steps, 'Start the node');
  set('PORT', current('PORT', '4000'));
  set('WINDROW_UPSTREAM_PORT', current('WINDROW_UPSTREAM_PORT', '4100'));
  set('WINDROW_TLS_PORT', current('WINDROW_TLS_PORT', '4443'));
  set('WINDROW_USER_HOME', current('WINDROW_USER_HOME', os.homedir()));
  persist(`Role: central in a container and a node on this machine, ${mode} mode.`);
  ok('Central is already up. To start the node:');
  body('  npm start');
  body('');
  ok(`The dashboard is at http://localhost:${dashboardPort}`);
  detail('Central keeps running across reboots — the containers are `restart: unless-stopped`.');
  detail('`npm run central:down` stops them; `npm run central:up` brings them back.');

  await finish('dev-both', { url, mode, dashboardPort });
}

/**
 * Mint the root and server certificates on the HOST, before the container starts.
 *
 * The order is the whole point. docker-compose.host-ca.yml bind-mounts this directory READ-ONLY, so
 * a central that found it empty could not create what it needs; and a central handed its own
 * private volume instead — which is what the base compose file alone does — mints a SECOND root
 * that every node in the fleet is a stranger to. Minting here means one authority, on disk, that
 * both halves read.
 *
 * Idempotent: server/enrollment/ca.js loads what already exists and only mints what does not, so a
 * re-run of setup never reissues the root out from under an enrolled node.
 */
function mintSharedCa() {
  if (DRY_RUN) {
    console.log(`           ${dim('would mint server/data/ca if this machine has none yet')}`);
    return;
  }
  const ca = require('../server/enrollment/ca');
  const root = ca.loadOrCreateCa();
  ca.loadOrCreateServerCert(root);
  ok(`The fleet's certificate authority is ${path.relative(ROOT, ca.CA_DIR)}.`);
  detail('The container mounts it read-only, so central loads this root rather than minting one.');
  caution('Never copy that directory to another machine. The key in it can mint an admin');
  body('certificate for any node id in the fleet. Back it up encrypted, and keep it here.');
}

/**
 * Bring up `windrow-central-db` and `windrow-central`, and wait until central is actually serving.
 *
 * BOTH COMPOSE FILES, never the base alone. docker-compose.host-ca.yml is what bind-mounts the CA
 * minted above; without it the container gets a private, empty CA volume and mints a brand-new
 * root, which on a machine that has ever enrolled a node orphans every one of them at once. This is
 * the same pairing `npm run central:up` performs, and the reason that script exists.
 */
async function startCentralContainer({ tlsPort, dashboardPort }) {
  updateComposeEnv({ CENTRAL_TLS_PORT: tlsPort, CENTRAL_DASHBOARD_PORT: dashboardPort });
  const files = ['-f', `"${COMPOSE_FILE}"`, '-f', `"${COMPOSE_HOST_CA_FILE}"`];
  // Pulled, but not fatally: a machine that already holds the image — or one offline with it — has
  // everything `up` needs, and `up` reports a genuinely missing image better than a failed pull.
  run('docker', ['compose', ...files, 'pull', 'central'], {
    allowFail: true,
    label: 'Pulling the central image from ghcr.io...',
  });
  run('docker', ['compose', ...files, 'up', '-d'], { label: 'Starting central...' });
  await waitForCentralContainer();
}

/**
 * Wait for the container's own HEALTHCHECK to pass.
 *
 * Asking Docker rather than probing a port, because the two answer different questions: the port is
 * open the moment the process binds it, while the healthcheck (see the Dockerfile) fetches /health,
 * which is only answered once the schema migration at boot has finished. Enrolling against a
 * central still migrating is how the first version of this got a confusing 500.
 */
async function waitForCentralContainer(attempts = 40) {
  if (DRY_RUN) {
    console.log(`           ${dim('would wait for the windrow-central container to report healthy')}`);
    return true;
  }
  process.stdout.write('           waiting for central');
  for (let i = 0; i < attempts; i += 1) {
    const probe = spawnSync('docker', ['inspect', '-f', '"{{.State.Health.Status}}"', CENTRAL_CONTAINER], {
      shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const status = (probe.stdout || '').trim().replace(/"/g, '');
    if (status === 'healthy') {
      process.stdout.write('\n');
      ok('Central is up and answering.');
      return true;
    }
    if (status === 'unhealthy') {
      process.stdout.write('\n');
      failure('The central container started and then failed its own healthcheck.');
      body('Read its log — the cause is almost always the database:');
      body('  docker compose -f server/central/docker-compose.yml logs central');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
  process.stdout.write('\n');
  failure(`${CENTRAL_CONTAINER} did not report healthy within ${attempts * 2} seconds.`);
  body('Setup stops here rather than enrolling against a central that is not serving. Check:');
  body('  docker compose -f server/central/docker-compose.yml logs central');
  process.exit(1);
}

/**
 * Get this node a shipping credential without the operator handling a token.
 *
 * TWO ENROLLMENTS, AND THE SECOND IS THE POINT. The bootstrap token central writes on first boot is
 * ADMIN-scoped (server/enrollment/routes.js, ensureBootstrapToken), because the first caller has to
 * be able to mint every later token. Spending it directly on the shipping credential would leave
 * the thing that ships usage holding the strongest scope in the fleet for a year. So it buys an
 * `admin` credential once, and that credential mints the node-scoped token this node runs on.
 *
 * On a fleet all of this is a human at central issuing a token out of band — see
 * enrollAgainstCentral below. It can be automated here only because central is on this machine and
 * this process can read the bootstrap file out of its container.
 */
async function enrollDevBothNode(centralUrl) {
  const credentialDir = current('WINDROW_CREDENTIAL_DIR', path.join(ROOT, 'server', 'data', 'credentials'));
  set('WINDROW_CREDENTIAL_DIR', credentialDir);
  // `node-shipper`, not `node`, and this is not cosmetic: server/usageShipper.js and
  // server/policy/policyClient.js both load the credential named by WINDROW_SHIP_CREDENTIAL_NAME.
  // Any other name produces a valid certificate that nothing ever presents.
  const credentialName = current('WINDROW_SHIP_CREDENTIAL_NAME', 'node-shipper');

  if (DRY_RUN) {
    console.log(`           ${dim(`would read the bootstrap token from ${CENTRAL_CONTAINER} and enroll admin, then ${credentialName}`)}`);
    return;
  }

  if (hasCredential(credentialDir, credentialName)) {
    ok(`This node already holds a ${credentialName} credential.`);
    detail('Keeping it — enrolling again would spend a token to replace a working certificate.');
    detail('`npm run verify:topology` reports whether central still trusts this one.');
    return;
  }

  if (!hasCredential(credentialDir, 'admin')) {
    const bootstrap = readBootstrapToken();
    if (!bootstrap) {
      failure('Central has no bootstrap token left, and this machine has no admin credential.');
      body('The token is single-use and is deleted once an admin enrolls, so this means one was');
      body('spent somewhere else. Mint a node token with the admin credential that spent it:');
      body(`  POST ${centralUrl}/api/enrollment-tokens  {"scope":"node"}`);
      body(`Then: node scripts/enroll.js --name ${credentialName} --url ${centralUrl} --token <token>`);
      body('Setup continues, because everything else on this machine is configured.');
      return;
    }
    const admin = runEnroll({
      url: centralUrl, name: 'admin', label: `${os.hostname()} admin`, dir: credentialDir,
      token: bootstrap, activity: 'Enrolling the admin credential...',
    });
    if (!admin) {
      body('The bootstrap token is single-use. To start over, remove the central CA volume and');
      body('bring it up again — safe here only because no other node has enrolled yet.');
      return;
    }
    ok('Enrolled an admin credential. Central deletes the bootstrap token now that one exists.');
  }

  const token = mintNodeToken(centralUrl, credentialDir, os.hostname());
  if (!token) {
    body(`To finish by hand: node scripts/enroll.js --name ${credentialName} --url ${centralUrl} --token <token>`);
    return;
  }
  const enrolled = runEnroll({
    url: centralUrl, name: credentialName, label: os.hostname(), dir: credentialDir,
    token, activity: 'Enrolling this node...',
  });
  if (!enrolled) return;
  if (enrolled.nodeId) {
    ok(`Enrolled as ${enrolled.nodeId}, scope ${enrolled.scope}, valid until ${enrolled.notAfter}.`);
    set('WINDROW_NODE_ID', enrolled.nodeId);
  } else {
    ok('Enrolled.');
  }
  detail('The private key was generated here and never left this machine.');
}

/** Does a credential of this name exist? Absence is what says "enroll", so it is checked by file. */
function hasCredential(dir, name) {
  return fs.existsSync(path.join(dir, `${name}-cert.pem`));
}

/**
 * Read the single-use bootstrap token out of the central container.
 *
 * It lives in the CA volume rather than on the host, so `docker exec` is the only way to it. Empty
 * output is not an error here — central deletes the file as soon as an admin is enrolled, so
 * "missing" is the normal state of a central that has been set up before.
 */
function readBootstrapToken() {
  const result = run('docker',
    ['exec', CENTRAL_CONTAINER, 'cat', '/app/server/data/bootstrap-enrollment-token'],
    { capture: true, allowFail: true });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Mint a node-scoped enrollment token using the admin credential this machine just enrolled.
 *
 * Run as a child process rather than inline because the credential is a mutual-TLS handshake, not a
 * header: server/enrollment/client.js builds the https.Agent that carries it, and loading that
 * module into the wizard would pull the node's whole enrollment stack into a script that mostly
 * writes a config file.
 */
function mintNodeToken(centralUrl, credentialDir, label) {
  const script = `
    const https = require('https');
    const client = require(${JSON.stringify(path.join(ROOT, 'server', 'enrollment', 'client.js'))});
    const credential = client.load('admin', process.env.WINDROW_CREDENTIAL_DIR);
    if (!credential) { console.error('no usable admin credential in ' + process.env.WINDROW_CREDENTIAL_DIR); process.exit(1); }
    const url = new URL(process.env.CENTRAL_URL + '/api/enrollment-tokens');
    const payload = JSON.stringify({ scope: 'node', label: process.env.NODE_LABEL });
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      agent: client.agentFor(credential),
      timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 201 && res.statusCode !== 200) {
          console.error('central answered ' + res.statusCode + ': ' + body);
          process.exit(1);
        }
        let token = null;
        try { token = JSON.parse(body).token; } catch { /* reported below */ }
        if (!token) { console.error('central issued no token: ' + body); process.exit(1); }
        process.stdout.write(token);
      });
    });
    req.on('error', (err) => { console.error(err.message); process.exit(1); });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.end(payload);
  `;
  detail('Minting a node-scoped enrollment token...');
  const result = runNodeScript(script, {
    ...process.env,
    CENTRAL_URL: centralUrl,
    WINDROW_CREDENTIAL_DIR: credentialDir,
    NODE_LABEL: label,
  });
  if (result.status !== 0 || !result.stdout) {
    failure('Could not mint a node enrollment token.');
    if (result.stderr) console.error(`           ${result.stderr.split('\n').join('\n           ')}`);
    return null;
  }
  return result.stdout.trim();
}

/**
 * Run scripts/enroll.js and hand back what it reported.
 *
 * The token travels in the environment, not on the command line, where every other process on the
 * machine could read it out of the process table. Returns the parsed `--json` line, or null when
 * enrollment failed — the caller says what to do about it, because that differs by call site.
 */
function runEnroll({ url, name, label, dir, token, caFile = null, activity = null }) {
  const args = [`"${path.join(ROOT, 'scripts', 'enroll.js')}"`,
    '--url', `"${url}"`, '--name', name, '--label', `"${label}"`,
    '--dir', `"${dir}"`, '--token', '-', '--json'];
  if (caFile) args.push('--ca', `"${caFile}"`);
  const result = run(process.execPath, args, {
    capture: true,
    allowFail: true,
    env: { ...process.env, WINDROW_ENROLLMENT_TOKEN: token },
    label: activity,
  });
  if (result.dryRun) return null;
  if (result.status !== 0) {
    failure(`Enrollment failed for "${name}".`);
    if (result.stderr) console.error(`           ${result.stderr.split('\n').join('\n           ')}`);
    return null;
  }
  try { return JSON.parse(result.stdout.split('\n').filter(Boolean).pop()); } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// Verification and the closing summary

/** What each role produced, in a sentence the closing Success notice can end on. A slug with its
 *  hyphen swapped for a space reads as "node standalone", which is not English. */
const ROLE_LABELS = {
  central: 'This machine is the central host for your fleet.',
  'node-fleet': 'This node is configured to join your fleet.',
  'node-standalone': 'This machine is a standalone node.',
  'dev-both': 'This machine runs central in a container and a node.',
};

async function finish(role, details) {
  console.log(`\n${bold('Verify the setup')}`);
  if (DRY_RUN) {
    console.log(`           ${dim('would run: node scripts/verify-topology.js')}`);
  } else if (await askYesNo('Check the topology now?', true)) {
    // allowFail, deliberately: a check that reports a problem is this script doing its job, not
    // this script failing. The exit code says whether setup ran, not whether the fleet is healthy
    // — a node set up before its central exists is a normal, correct state.
    run(process.execPath, [`"${path.join(ROOT, 'scripts', 'verify-topology.js')}"`], { allowFail: true });
  } else {
    detail('You can run it at any time: npm run verify:topology');
  }

  console.log();
  success(`Setup is complete. ${ROLE_LABELS[role] || 'This machine is configured.'}`);

  console.log(`\n${bold('What to do next')}`);
  if (role === 'central') {
    // The container, not `npm run central`: a host process raises no dashboard proxy, and it is
    // the deployment that crash-looped under the Windows service when Postgres was slow at boot.
    // The BASE compose file alone is right here and only here — a dedicated central host has no
    // node sharing its authority, so central minting its own root is correct rather than orphaning.
    console.log('  1. Start central:              docker compose -f server/central/docker-compose.yml up -d');
    console.log('  2. Read the bootstrap token:   docker exec windrow-central cat');
    console.log('                                   /app/server/data/bootstrap-enrollment-token');
    console.log('  3. Enroll the first admin:');
    console.log(`                                 node scripts/enroll.js --name admin --url https://<this host>:${details.tlsPort} --token <token>`);
    console.log('  4. Issue a token per node:     POST /api/enrollment-tokens with that certificate');
    console.log('  5. On each node PC:            npm run setup, then choose the fleet option');
  } else if (role === 'node-fleet') {
    console.log('  1. Start the node:             npm start');
    console.log('  2. Confirm it is sending:      npm run verify:topology');
    console.log('  3. Watch it arrive at central: GET /api/fleet/nodes');
    if (details.mode === 'shadow') {
      console.log('  4. Compare node and central:   npm run shadow:compare');
    }
  } else if (role === 'dev-both') {
    console.log('  1. Start the node:             npm start');
    console.log(`  2. Open the dashboard:         http://localhost:${details.dashboardPort}`);
    console.log('  3. Wire an agent backend:      npm run providers:install claude');
    console.log('  4. Check the topology:         npm run verify:topology');
    console.log(`
${dim('Central is already running in Docker and restarts with the machine.')}`);
  } else {
    // No dashboard line here, and its absence is the point: since
    // docs/design/dashboard-placement.md a node serves no user interface at all, and an install
    // that ends by naming a URL which answers "there is nothing here" reads as a broken install.
    console.log('  1. Start the node:             npm start');
    console.log('  2. Wire an agent backend:      npm run providers:install claude');
    console.log('  3. Check the setup:            npm run verify:topology');
    console.log(`
${dim('A standalone node serves no dashboard. To get one, run setup again and choose')}`);
    console.log(`${dim('"Central in a container, and a node here" — it adds Docker, not a second machine.')}`);
  }
  console.log(`\n${dim('Your configuration is in windrow.env. You can run `npm run setup` again at any time;')}`);
  console.log(`${dim('every step is idempotent.')}`);
}

/** `--show`: report how this machine is configured, based on what it can actually read. Changes
 *  nothing. */
function showConfiguration() {
  const file = envFile.DEFAULT_PATH;
  console.log(bold('\nHow this machine is configured\n'));
  const centralUrl = current('WINDROW_CENTRAL_URL');
  const dbUrl = current('WINDROW_CENTRAL_DB_URL');
  const authority = (current('WINDROW_POLICY_AUTHORITY') || 'node').toLowerCase();

  const roles = [];
  if (dbUrl) roles.push('central host');
  if (centralUrl) roles.push('node in a fleet');
  if (roles.length === 0) roles.push('standalone node');
  console.log(`  Role:             ${bold(roles.join(' + '))}`);
  console.log(`  Policy authority: ${authority === 'central' && centralUrl ? 'central (active mode)' : 'this node (shadow mode, or standalone)'}`);
  console.log(`  Config file:      ${fs.existsSync(file) ? file : `${file} ${dim('(does not exist)')}`}`);
  if (authority === 'central' && !centralUrl) {
    console.log();
    caution('WINDROW_POLICY_AUTHORITY is central, but WINDROW_CENTRAL_URL is not set.');
    body('server/policy/authority.js falls back to node-authoritative, so this machine is not');
    body('doing what the setting says. Set the URL, or remove the authority setting.');
  }

  console.log(`\n${bold('  Settings')}`);
  const inFile = envFile.read();
  const keys = [...new Set([
    ...Object.keys(inFile),
    ...Object.keys(process.env).filter((k) => k.startsWith('WINDROW_')),
  ])].sort();
  if (keys.length === 0) {
    console.log(`    ${dim('Nothing is set. This is an unconfigured checkout.')}`);
  }
  for (const key of keys) {
    const fromFile = inFile[key] !== undefined;
    const raw = process.env[key];
    const source = !fromFile ? 'environment'
      : (raw !== undefined && raw !== inFile[key] ? 'environment, overriding windrow.env' : 'windrow.env');
    console.log(`    ${key.padEnd(32)} ${redactIfSecret(key, current(key))} ${dim(`(${source})`)}`);
  }
  console.log(`\n${dim('  To check whether any of this works, run: npm run verify:topology')}`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(bold('\nWindrow setup'));
  if (DRY_RUN) console.log(yellow('  --dry-run: this run starts, writes and installs nothing.'));

  if (SHOW_ONLY) { showConfiguration(); return; }

  const role = ROLE_ARG || await askChoice('What is this machine?', [
    {
      key: 'dev-both',
      title: 'Central in a container, and a node here',
      detail: 'The recommended install. Enforcement runs on this machine; central runs in Docker '
        + 'and serves the dashboard at http://localhost:5599. Setup starts the containers and '
        + 'enrolls this node for you. Needs Docker.',
    },
    {
      key: 'node',
      title: 'A node, on its own',
      detail: 'A single machine: SQLite, its own capability catalog and grants, no central host and '
        + 'no Docker. Enforcement is identical, but there is NO dashboard — a node serves none, so '
        + 'everything is a command.',
    },
    {
      key: 'node-fleet',
      title: 'A node that joins a fleet',
      detail: 'Sends usage to a central host, and in active mode takes policy from it. You need a '
        + 'central already running, and an enrollment token issued there.',
    },
    {
      key: 'central',
      title: 'The central host, on its own',
      detail: 'One per fleet, on a machine that runs no agents: Postgres, the certificate '
        + 'authority, the fleet view. It enforces nothing, and no hook talks to it.',
    },
  ], 'dev-both');

  switch (role) {
    case 'node': await setupNode({ joinFleet: false }); break;
    case 'node-fleet': await setupNode({ joinFleet: true }); break;
    case 'central': await setupCentral(); break;
    case 'dev-both': await setupDevBoth(); break;
    default:
      failure(`"${role}" is not a role. Use one of: dev-both, node, node-fleet, central`);
      process.exit(1);
  }
}

main()
  .then(() => { if (rl) rl.close(); })
  .catch((err) => {
    if (rl) rl.close();
    console.error(`\n${red('Setup failed:')} ${err.stack || err.message}`);
    console.error(dim('Windrow writes windrow.env only at the end of a role\'s steps, so your previous'));
    console.error(dim('configuration is intact.'));
    process.exit(1);
  });
