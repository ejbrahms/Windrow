'use strict';
// Writing `windrow.env` — the one file that remembers what this host was set up as.
//
// WHY THE FILE EXISTS. Everything that makes a node part of a fleet is an environment variable:
// WINDROW_CENTRAL_URL, WINDROW_POLICY_AUTHORITY, WINDROW_CENTRAL_DB_URL, and forty-odd others
// (docs/design/setup-after-central.md §4, gap #6). An environment variable set in a terminal lives
// exactly as long as that terminal. So the shape this codebase kept producing was an operator who
// configured a fleet, saw it work, closed the window, and came back to a standalone install that
// looked perfectly healthy — the same silent failure §4's gap #7 describes for the Windows service,
// with the same cause: the configuration was never written down anywhere.
//
// WHY THE READING HALF IS NOT HERE. `parseEnvFile`, `readEnvFile` and `loadEnvFile` live in
// server/config.js, which is required by every entry point AND by every ~20 ms hook process. Pulling
// in a second module from there costs about 2 ms of compile — measurably, on every governed tool
// call on the field — to read a file that is usually 200 bytes. So the hot path owns the parser and
// this file, which only ever runs from scripts/setup.js, imports it. One parser, and nothing extra
// on the hook's budget.
//
// THE PRECEDENCE RULE, restated here because it is what makes writing this file safe: a real
// environment variable ALWAYS wins over a line in it (server/config.js's loadEnvFile). The Windows
// service is handed its configuration explicitly by scripts/service-install.js and must not be
// overridden by a repo file edited afterwards; scripts/sandbox.js and scripts/oobe.js work by
// exporting overrides into a child process, and a file that beat them would point a throwaway
// sandbox at the live database; and `WINDROW_CENTRAL_URL=… npm start` is how anyone tries a one-off.
// This file can only ever ADD configuration to a process, never change what was passed to it.

const fs = require('fs');
const path = require('path');
const { ENV_FILE, parseEnvFile, readEnvFile, loadEnvFile } = require('./config');

/**
 * Write `values` back, merged with what is already there.
 *
 * Comments and ordering are regenerated rather than preserved. That is a deliberate trade: the file
 * is machine-owned — the wizard writes it, `npm run setup -- --show` reads it back — and a merge
 * that preserved hand-written comments would have to parse them, which is the complexity a format
 * with no expansion rules exists to avoid.
 *
 * A key whose value is null, undefined or '' is REMOVED. That is what lets the wizard take a host
 * back OUT of a fleet: leaving a stale WINDROW_CENTRAL_URL behind is how a decommissioned node
 * keeps shipping to a central that no longer expects it.
 *
 * Written 0600 where the platform honours it, because WINDROW_CENTRAL_DB_URL carries a Postgres
 * password. On Windows the mode is advisory — NTFS ACLs are the real control — so this is a floor,
 * not a guarantee, and the file is git-ignored for the same reason.
 */
function write(values, { file = ENV_FILE, header = null } = {}) {
  const merged = { ...readEnvFile(file) };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') delete merged[key];
    else merged[key] = String(value);
  }
  const lines = [
    '# windrow.env — written by `npm run setup` (scripts/setup.js).',
    '# Read by server/config.js at startup. A real environment variable always wins over a line',
    '# here, so a sandbox or a one-off override still works. Delete a line to unset it.',
    ...(header ? ['#', ...String(header).split('\n').map((l) => `# ${l}`)] : []),
    '',
    ...Object.keys(merged).sort().map((k) => `${k}=${merged[k]}`),
    '',
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort — Windows ACLs are not modes */ }
  return { file, keys: Object.keys(merged) };
}

module.exports = {
  DEFAULT_PATH: ENV_FILE,
  parse: parseEnvFile,
  read: readEnvFile,
  load: (opts) => ({ file: (opts && opts.file) || ENV_FILE, applied: loadEnvFile(opts) }),
  write,
};
