'use strict';
// Write a file only its owner can read — actually, rather than nominally.
//
// This exists because of a bug the enrollment CA's self-test caught in the pattern this codebase
// already used everywhere. `fs.writeFileSync(p, data, { mode: 0o600 })` is what server/auth.js
// writes its bearer tokens with, and its header comment describes them as protected on that basis.
// On Windows the mode argument is very nearly a no-op: NTFS permissions come from ACLs, not POSIX
// mode bits, and the file lands at an effective 0666 inheriting whatever the parent directory
// grants. `fs.statSync().mode` cheerfully reports 0666 back.
//
// For a bearer token that was already bad. For the CA private key it is fatal to the whole point
// of the change: anyone able to read server/data/ca/ca-key.pem can mint a certificate for any
// nodeId with any scope, which is precisely the "any node can forge any other node's events"
// property that per-node credentials exist to remove
// (docs/design/global-identity-and-central-db.md §2.5).
//
// So on Windows we drop inherited ACEs and grant only the current user and SYSTEM. Administrators
// are intentionally not enumerated — an admin can take ownership regardless, so listing them buys
// nothing, while every *non-admin* account on the machine loses access, which is the threat here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const isWindows = process.platform === 'win32';

/**
 * Restrict an existing file to its owner. Returns true if the tightening was applied, false if it
 * could not be — callers decide how loudly to complain, because a secret that is not actually
 * secret should never fail *silently*.
 */
function restrictToOwner(file) {
  if (!isWindows) {
    try {
      fs.chmodSync(file, 0o600);
      return true;
    } catch {
      return false;
    }
  }
  // `icacls <file> /inheritance:r /grant:r <user>:F "NT AUTHORITY\SYSTEM":F`
  //   /inheritance:r  — remove inherited ACEs, keeping none. Without this the parent directory's
  //                     Users:(RX) grant survives and every local account can still read the key.
  //   /grant:r        — replace any existing grant for that principal rather than adding to it.
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : os.userInfo().username;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', 'NT AUTHORITY\\SYSTEM:F'],
      { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or overwrite a secret file with owner-only access. The POSIX mode is still passed so the
 * file is never briefly world-readable on platforms that honour it, and the ACL tightening then
 * covers Windows.
 */
function writeSecret(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  if (!restrictToOwner(file)) {
    console.warn(
      `[secrets] could not restrict permissions on ${file} — it may be readable by other accounts ` +
      'on this machine. On Windows this needs icacls to be available on PATH.');
  }
}

/**
 * Whether a file is readable only by its owner. Used by the self-test and by the startup check, so
 * that a key which silently lost its ACL (restored from a backup, copied with xcopy, unzipped)
 * is reported rather than trusted.
 */
function isOwnerOnly(file) {
  if (!isWindows) {
    try {
      return (fs.statSync(file).mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
  let out;
  try {
    out = execFileSync('icacls', [file], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return false;
  }
  // Every ACE line looks like "path:DOMAIN\principal:(F)". Anything granted to the broad built-in
  // groups means another account on this machine can read the secret.
  const broad = /\b(Everyone|BUILTIN\\Users|Authenticated Users|BUILTIN\\Guests|INTERACTIVE)\b/i;
  return !broad.test(out);
}

module.exports = { writeSecret, restrictToOwner, isOwnerOnly, isWindows };
