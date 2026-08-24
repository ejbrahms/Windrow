#!/usr/bin/env node
'use strict';
// `npm run providers:install claude` — hook wiring from a shell instead of from the dashboard.
//
// docs/design/dashboard-placement.md, item 3: installing hooks into ~/.claude/settings.json is
// "the one genuinely machine-local write, and it has no CLI". Until now it was reachable only
// through POST /api/providers/:id/install on the node's mTLS API, which the onboarding wizard
// drives — so a node with no browser on it could not be wired up at all, and a node that is a
// background service is exactly a node with no browser on it.
//
// This is a thin wrapper over server/providers.js's `installProvider`, which already exists and is
// already what the route calls. Deliberately thin: the adapter registry, the merge-don't-clobber
// rewrite of the config file and the "is it installed" detection all stay in one place, so the CLI
// and the route can never disagree about what installed means.
//
// IT DOES NOT GO THROUGH THE API, and that is the point rather than a shortcut. The route needs a
// running server and an admin certificate; this needs neither, because the write is to a file on
// this machine that this process can already open. A CLI that shelled out to its own server would
// reintroduce the dependency it exists to remove.
//
// It does not touch the package state the route also flips (server/packages.js). That is a
// dashboard convenience — "use this backend" enabling the matching capability package — and
// server/cacheWarmer.js re-derives it; wiring the hooks is the part a headless node needs, and
// making the CLI a second writer of package state would give two entry points two behaviours.

const path = require('path');

const {
  listProviders,
  installProvider,
  uninstallProvider,
  NotFoundError,
  UnsupportedError,
} = require(path.join(__dirname, '..', 'server', 'providers'));

const USAGE = `Usage:
  npm run providers                     list every adapter and whether its hooks are installed
  npm run providers:install <id>        install this adapter's PreToolUse/PostToolUse wiring
  npm run providers:uninstall <id>      strip just that wiring back out

  <id> is one of the ids printed by the list — e.g. "claude", "agy".

Installing writes only the hook entries into that backend's own config file; everything else in
the file (permissions, other hook groups, unrelated keys) is read, edited in place and rewritten
untouched.`;

/** One provider as a line. `installed` first because it is the only column anyone scans for. */
function line(p) {
  const mark = p.installed ? 'installed' : p.installable ? 'not installed' : 'no install path yet';
  const where = p.configPath || '(no known config location)';
  return [
    `  ${p.id.padEnd(8)} ${mark.padEnd(19)} ${p.label}`,
    `           ${where}`,
    p.error ? `           ! ${p.error}` : null,
  ].filter(Boolean).join('\n');
}

function list() {
  const providers = listProviders();
  console.log('Backend adapters and their hook wiring on this machine:\n');
  for (const p of providers) console.log(line(p));
  const missing = providers.filter((p) => p.installable && !p.installed);
  if (missing.length) {
    console.log(
      `\n${missing.length} installable adapter(s) are not wired up. Governance does not run for a`,
      '\nbackend whose hooks are missing — the tool call simply proceeds ungoverned, with nothing',
      '\nanywhere to record that it did. Install with:',
      `\n  npm run providers:install ${missing[0].id}`
    );
  }
  return 0;
}

function mutate(verb, id) {
  if (!id) {
    console.error(`error: which provider? \n\n${USAGE}`);
    return 2;
  }
  const run = verb === 'install' ? installProvider : uninstallProvider;
  let status;
  try {
    status = run(id);
  } catch (err) {
    if (err instanceof NotFoundError) {
      const known = listProviders().map((p) => p.id).join(', ');
      console.error(`error: ${err.message}. Known providers: ${known}`);
      return 2;
    }
    if (err instanceof UnsupportedError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    // A permissions failure or an unparseable config file lands here. Print it plainly rather
    // than as a stack: the reader is an operator setting a machine up, and the message
    // ("EACCES, open '...'") is the whole of what they need.
    console.error(`error: could not ${verb} ${id}: ${err.message}`);
    return 1;
  }
  console.log(`${verb === 'install' ? 'Installed' : 'Removed'} ${status.label} hook wiring in ${status.configPath}`);
  // Report the re-read state rather than assuming the write worked — `describe` re-parses the file
  // it just wrote, so this is the same check the watcher will make a moment later.
  if (verb === 'install' && !status.installed) {
    console.error('warning: the config was written but the wiring still does not read as installed.');
    return 1;
  }
  if (verb === 'install') {
    console.log(
      'Restart the backend (or open a new session) so it re-reads its hook config.\n'
      + 'server/hookWatcher.js now watches this file and puts the entries back if they go missing.'
    );
  }
  return 0;
}

function main(argv) {
  const [command, id] = argv;
  switch (command) {
    case undefined:
    case 'list':
      return list();
    case 'install':
    case 'uninstall':
      return mutate(command, id);
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`error: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exit(main(process.argv.slice(2)));
