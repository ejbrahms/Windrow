#!/usr/bin/env node
'use strict';

// `node scripts/enroll.js` — the front door for the most-used step in the fleet architecture.
//
// docs/design/setup-after-central.md §5 step 2: enrollment is now mandatory for shipping usage AND
// for pulling policy, and until this file existed the instruction printed by three separate places
// was a hand-assembled
//
//     node -e "require('./server/enrollment/client').enroll({name:'mcp', baseUrl:'…', enrollmentToken:'…'})"
//
// which is not an instruction, it is a snippet an operator has to edit correctly on the first try
// with a single-use token that is gone if they do not. This wraps the same function with named
// flags, a readable failure, and a machine-readable success.
//
// TWO CALLERS, AND THE SECOND ONE IS WHY --json IS A CONTRACT. A human runs this once per machine
// and reads the prose. The setup wizard SHELLS OUT to it and parses stdout, so under `--json` this
// prints exactly one JSON object — {"nodeId","scope","notAfter","dir"} — and nothing else on
// stdout, ever. Progress, warnings and errors go to stderr precisely so that stays true. Exit 0 on
// success, 1 on failure with the reason on stderr.
//
// THE TOKEN IS A SECRET AND THE COMMAND LINE IS NOT A SECRET PLACE. On Windows a full command line
// is visible to any process that can enumerate them and lands in the shell's history file, so
// `--token -` reads it from stdin and WINDROW_ENROLLMENT_TOKEN reads it from the environment. The
// flag is still accepted because an interactive first run with a token pasted from central's own
// console is the common case and refusing it would only send people to `node -e` again.

const fs = require('fs');
const path = require('path');
const { enroll, DEFAULT_DIR } = require('../server/enrollment/client');

const USAGE = `
Enroll this machine with a Windrow server and store the credential it issues.

  node scripts/enroll.js --url https://central.example:5443 --token <t> [options]

  --url <u>     required. The server that issues the certificate. For a FLEET this is CENTRAL,
                not the local node: the certificate has to be signed by the CA whose listener will
                verify it (docs/design/setup-after-central.md §2).
  --token <t>   the single-use enrollment token. "-" reads it from stdin; WINDROW_ENROLLMENT_TOKEN
                is read when the flag is absent. Both keep it out of shell history.
  --name <n>    which credential this is, and the filename stem it is stored under. Default
                "node-shipper", and the default is load-bearing: server/usageShipper.js and
                server/policy/policyClient.js both load the credential named by
                WINDROW_SHIP_CREDENTIAL_NAME, which falls back to exactly that string. Enrolling
                under any other stem produces a valid certificate that nothing ever presents — a
                node that looks enrolled, ships nothing, and reports no error.
                Use a second name (e.g. "admin", "mcp") for a second caller on the same machine —
                separate names mean separate private keys.
  --label <l>   a human label recorded on the server's node list. Default: the name.
  --ca <path>   the issuer's CA certificate, obtained out of band. Omit it and the CA is fetched
                over an unverified hop — see the warning this prints.
  --dir <path>  where the credential is written. Default WINDROW_CREDENTIAL_DIR, else
                server/data/credentials.
  --force       enroll again even though a valid credential already exists, spending the token.
  --json        print {"nodeId","scope","notAfter","dir"} on stdout and nothing else.
`;

/** Flags only, no positionals: every value here is either a URL, a secret or a path, and all three
 *  are things a positional argument gets silently wrong. An unknown flag is fatal rather than
 *  ignored — a typo'd `--tokn` would otherwise reach the server as "no token" and burn nothing,
 *  which reads like a server problem. */
function parseArgs(argv) {
  // 'node-shipper' because that is what the runtime LOADS, not because it reads well: see the
  // --name entry in USAGE. WINDROW_SHIP_CREDENTIAL_NAME is honoured so a machine that has moved its
  // credential does not have to remember to pass the flag on every re-enrollment.
  const opts = {
    name: process.env.WINDROW_SHIP_CREDENTIAL_NAME || 'node-shipper',
    json: false,
    force: false,
  };
  const takesValue = new Set(['url', 'token', 'name', 'label', 'ca', 'dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}" — every value takes a named flag`);
    const flag = arg.slice(2);
    if (flag === 'json' || flag === 'force') { opts[flag] = true; continue; }
    if (!takesValue.has(flag)) throw new Error(`unknown flag --${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${flag} needs a value`);
    opts[flag] = value;
    i += 1;
  }
  return opts;
}

/** Everything the whole of stdin holds, trimmed. Used for `--token -`. Trimmed because the
 *  overwhelmingly likely producer is `echo`, and a trailing newline inside a token hashes to
 *  something the server has never heard of — which would present as an invalid token rather than
 *  as the whitespace problem it is. */
function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; });
    process.stdin.on('end', () => resolve(text.trim()));
    process.stdin.on('error', reject);
  });
}

async function resolveToken(opts) {
  if (opts.token === '-') return readStdin();
  if (opts.token) return opts.token;
  return process.env.WINDROW_ENROLLMENT_TOKEN || null;
}

function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }

  // stderr for everything a human reads, so `--json`'s stdout contract holds without this function
  // having to remember which stream it is on.
  const say = (msg) => { if (!opts.json) process.stderr.write(`${msg}\n`); };

  if (!opts.url) throw new Error('--url is required (the server that issues the certificate)');
  const token = await resolveToken(opts);

  const dir = opts.dir ? path.resolve(opts.dir) : DEFAULT_DIR;
  let caPem = null;
  if (opts.ca) {
    caPem = fs.readFileSync(path.resolve(opts.ca), 'utf8');
    say(`Verifying ${opts.url} against the CA in ${opts.ca}.`);
  } else if (!isLoopbackUrl(opts.url)) {
    // A real caveat, stated plainly rather than buried, because it is the one step of a fleet
    // install where an operator can be talked into enrolling with an impostor. The client's first
    // hop — GET /api/enroll/ca — runs with rejectUnauthorized:false, because there is by definition
    // nothing yet to verify the server against. On loopback during OOBE that is fine; across a
    // network it means whoever answers that hop chooses the CA this machine will trust from then
    // on. Printed on stderr and not fatal: refusing outright would leave no way to enroll the
    // first node, and the token is single-use so the window is one request wide.
    say(
      `\n  ! ${opts.url} is not loopback and no --ca was given.\n`
      + '  ! The CA certificate will be fetched from that host over a connection nothing verifies\n'
      + '  ! (trust on first use). Whoever answers decides which root this machine trusts.\n'
      + `  ! To close that: copy the issuer's server/data/ca/ca-cert.pem here and pass --ca <path>.\n`
    );
  }

  if (!token) {
    throw new Error(
      'no enrollment token. Pass --token <t>, pipe one in with --token -, or set '
      + 'WINDROW_ENROLLMENT_TOKEN. A fresh central writes its first one to '
      + 'server/data/bootstrap-enrollment-token and logs the path; afterwards an admin mints them '
      + 'with POST /api/enrollment-tokens.'
    );
  }

  say(`Enrolling "${opts.name}" with ${opts.url} …`);
  const credential = await enroll({
    name: opts.name,
    baseUrl: opts.url.replace(/\/+$/, ''),
    enrollmentToken: token,
    label: opts.label || opts.name,
    caPem,
    dir,
    force: Boolean(opts.force),
  });

  const summary = {
    nodeId: credential.meta.nodeId,
    scope: credential.meta.scope,
    notAfter: credential.meta.notAfter,
    dir,
  };
  if (opts.json) {
    // The contract. One line, one object, nothing else on this stream.
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    say(
      `\n  enrolled as ${summary.nodeId}\n`
      + `  scope       ${summary.scope}\n`
      + `  expires     ${summary.notAfter}\n`
      + `  credential  ${dir}\n\n`
      + 'The private key was generated here and never left this machine. The enrollment token is\n'
      + 'now spent; enrolling again needs a new one, or --force with one.\n'
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // stderr and exit 1, both halves of the contract the wizard reads. `--json` callers get an
    // empty stdout, which is unambiguous: a parse of "" fails loudly where a half-written object
    // would not.
    // `err.message` alone is not enough: a connection failure surfaces as an AggregateError whose
    // message is the empty string, so the whole report would have read "enrollment failed: ". The
    // code and the per-address causes are what actually say which host refused.
    const causes = Array.isArray(err.errors) ? err.errors.map((e) => e.message).join('; ') : '';
    const detail = [err.message, err.code, causes].filter(Boolean).join(' — ') || String(err);
    process.stderr.write(`enrollment failed: ${detail}\n`);
    process.exit(1);
  });
