// The stable subject key: *who* a call is accountable to, as opposed to *what* made it
// (docs/design/global-identity-and-central-db.md §1.4, want-mszgwij4-17).
//
// The rule is "key on the opaque identifier, never on the display name" — names get reused and
// renamed, and the audit trail outlives both. This module produces that opaque identifier for the
// OS account the current process is really running as, prefixed by the authority that issued it so
// heterogeneous sources cannot collide:
//
//   win-sid:S-1-5-21-2963395615-2330981250-1484618637-1001
//   posix:1000@<hostname>
//   env-user:<username>@<hostname>   -- assurance tier 1 only, see below
//   federated:<opaque>               -- reserved; a later server-verified token maps onto the same
//                                       column, an extra authority prefix rather than a redesign
//
// The whole SID is stored, never the RID: `…-1001` is the first ordinary account on *every*
// Windows machine, so shortening it merges every developer's primary account into one principal.
// `posix:` carries a host qualifier for the same reason — uid 1000 is the first ordinary account
// on most Linux boxes — which also makes explicit that a per-machine OS account is machine-scoped
// by nature: the same person on two machines is two subjects until a federated authority says
// otherwise.
//
// Assurance (§1.4) travels with the key, because "OS-read identity" and "a username off the
// environment" are not the same claim and the migration should not have to pretend they are:
//
//   3  server-verified over an authenticated channel   (nothing here; needs §1.5)
//   2  OS-read identity, same machine                  (win-sid:, posix:)
//   1  env-derived username — display only             (env-user:)
//
// Everything here answers "who am I?" as asked by the process itself. That is sufficient for a
// local hook talking to a local service on the same machine and worthless across a trust boundary
// — Part 2's central deployment is where that stops being theoretical.

/**
 * Bumped whenever the *grant subject* moves — i.e. whenever a change makes the principal a grant
 * is read off different from what it was before (the phase-5 flip from the loom instance to the OS
 * subject, a change to how `subjectId` itself is composed, a change to which principal
 * /principals/resolve hands back). It is a cache-invalidation epoch, not a schema version.
 *
 * Why it lives here rather than in the hook: `server/data/hook-principal-cache.json` is keyed by
 * `loomId` and kept for the life of the file, so an already-warm loom never resolves again. Move
 * the subject without invalidating it and every warm loom on the machine keeps resolving the
 * principal it registered under the old rule — grants checked against a stale subject, silently,
 * until someone deletes the file by hand (docs/design/global-identity-and-central-db.md §1.6,
 * want-mszgwnz1-22). Bumping this number is the invalidation: hooks/lib.js's loadPrincipalCache
 * discards a whole cache file stamped with any other epoch, and the next call re-resolves.
 *
 * So: any change in this file, in fromEnv.js's subject wiring, or in the resolve route that moves
 * which principal a grant is read off bumps this in the same commit.
 */
const GRANT_SUBJECT_EPOCH = 2;

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The three tiers, named. `server-verified` has no producer in this module by design — nothing
// running as the process being identified can reach it (§1.5); it exists as a constant so the
// column's domain is the whole vocabulary from the start, and so the later authenticated-channel
// path in §1.5 slots a value in rather than widening the enum under live data.
const ASSURANCE_SERVER_VERIFIED = 3;
const ASSURANCE_OS_READ = 2;
const ASSURANCE_ENV_DERIVED = 1;

const ASSURANCE_LABELS = {
  3: 'server-verified',
  2: 'os-read',
  1: 'env-derived',
};

/**
 * The tier as a word, for logs, API responses and the dashboard. `unknown` (not a guess, and not
 * an empty string) for a row that predates the column or a call that never resolved a subject —
 * "we did not record how this was obtained" is a distinct claim from any of the three tiers.
 */
function assuranceLabel(level) {
  return ASSURANCE_LABELS[level] || 'unknown';
}

/** True for a value that is one of the three tiers — the one check every writer shares. */
function isAssuranceLevel(level) {
  return Number.isInteger(level) && level >= ASSURANCE_ENV_DERIVED && level <= ASSURANCE_SERVER_VERIFIED;
}

// Resolving a Windows SID costs a child process, and this runs on the hook path (every tool call
// that misses the principal cache). The OS identity of a process cannot change while it runs, so
// it is resolved at most once per process.
let cached = null;

function hostQualifier(env) {
  return String(env.COMPUTERNAME || env.HOSTNAME || os.hostname() || 'unknown-host').toLowerCase();
}

/**
 * Reads the real token SID via `whoami /user`. Invoked by absolute path out of %SystemRoot%
 * rather than by name: a hook runs as a child of the agent and inherits its environment, so
 * resolving `whoami` through `PATH` would let the process being identified choose the binary that
 * identifies it. The value itself can't be substituted this way — only which program produces it.
 *
 * Returns null (not a throw) on any failure — no whoami, a locked-down account, an unparseable
 * line — so the caller can fall back to the tier-1 key instead of the hook path dying.
 */
function readWindowsSid(env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const whoami = path.join(systemRoot, 'System32', 'whoami.exe');
  try {
    // /fo csv /nh -> `"host\user","S-1-5-21-…-1001"` on one line, no header to skip.
    const out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /"(S-1-[0-9-]+)"/.exec(out);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * The subject key for the OS account this process runs as, plus the assurance tier that key was
 * obtained at. Never throws and never returns null: an unreadable SID degrades to the tier-1
 * `env-user:` key rather than leaving a call with no subject at all.
 *
 * `osUser`/`hostname` are passed in by the caller (server/principals/fromEnv.js already reads them
 * the un-spoofable way, `os.userInfo()` first) so the two cannot disagree about who this is.
 */
function subjectFromOs(env = process.env, { osUser = 'unknown-user', force = false } = {}) {
  if (cached && !force) return cached;

  const host = hostQualifier(env);
  let subject = null;

  if (process.platform === 'win32') {
    const sid = readWindowsSid(env);
    if (sid) subject = { subjectId: `win-sid:${sid}`, assuranceLevel: ASSURANCE_OS_READ };
  } else if (typeof process.getuid === 'function') {
    // getuid() is the kernel's answer about this process and nothing in the environment can talk
    // it out of that, so it is tier 2 the same way a token SID is.
    subject = { subjectId: `posix:${process.getuid()}@${host}`, assuranceLevel: ASSURANCE_OS_READ };
  }

  if (!subject) {
    subject = { subjectId: `env-user:${osUser}@${host}`, assuranceLevel: ASSURANCE_ENV_DERIVED };
  }

  cached = subject;
  return subject;
}

/** Test/diagnostic hook — drops the per-process memo so a later call re-reads the OS. */
function resetSubjectCache() {
  cached = null;
}

module.exports = {
  GRANT_SUBJECT_EPOCH,
  subjectFromOs,
  resetSubjectCache,
  readWindowsSid,
  assuranceLabel,
  isAssuranceLevel,
  ASSURANCE_LABELS,
  ASSURANCE_SERVER_VERIFIED,
  ASSURANCE_OS_READ,
  ASSURANCE_ENV_DERIVED,
};
