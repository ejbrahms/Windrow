'use strict';
// Minimal DER *encoder*, and deliberately only an encoder.
//
// We need to mint X.509 client certificates (docs/design/global-identity-and-central-db.md §2.5:
// "Node credential — mTLS client cert issued at enrollment"), and Node's crypto can generate keys
// and sign, but cannot construct a certificate. The three options were an npm cert library, the
// openssl CLI, or this. This project has exactly three runtime dependencies (better-sqlite3, cors,
// express) and the server runs as a Windows service where an `openssl` on PATH is not a safe
// assumption, so both alternatives cost more than they save.
//
// The safety argument for hand-rolling is that this file never *parses* anything an attacker
// controls. It emits DER in one fixed shape; every security decision that reads a certificate —
// chain building, signature verification, expiry, key usage — is made by OpenSSL inside Node's
// `tls` module (see server/enrollment/ca.js and the mTLS listener). A bug here produces a
// certificate that fails the handshake loudly, not one that is silently trusted. Enrollment
// likewise takes a bare SPKI public key rather than a PKCS#10 CSR precisely so that no
// attacker-supplied ASN.1 is ever parsed by code in this directory — `crypto.createPublicKey`
// does that parsing, and it is OpenSSL.

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
};

/**
 * DER length octets: short form below 128, else a leading count byte with the high bit set
 * followed by big-endian length bytes. DER (unlike BER) requires the *minimal* encoding, which is
 * why the short form is not just "always use long form with one byte".
 */
function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** tag-length-value, the one primitive everything else here is built from. */
function tlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const seq = (...parts) => tlv(TAG.SEQUENCE, Buffer.concat(parts.flat()));
const set = (...parts) => tlv(TAG.SET, Buffer.concat(parts.flat()));

/** Context-specific constructed [n], the EXPLICIT tagging X.509 uses for version and extensions. */
const explicit = (n, value) => tlv(0xa0 | n, value);
/** Context-specific primitive [n], used inside SubjectAltName / AuthorityKeyIdentifier. */
const implicitPrimitive = (n, value) => tlv(0x80 | n, value);

/**
 * DER INTEGER. Two rules that are easy to get wrong and produce certificates OpenSSL rejects:
 * the encoding must be minimal (no redundant leading 0x00), and because DER integers are *signed*
 * a value whose top bit is set needs a 0x00 prefix or it reads as negative. Serial numbers are the
 * case that matters — a negative serial is a spec violation some verifiers enforce.
 */
function integerFromBuffer(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0x00 && (buf[i + 1] & 0x80) === 0) i++;
  let v = buf.subarray(i);
  if (v.length === 0) v = Buffer.from([0x00]);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
  return tlv(TAG.INTEGER, v);
}

function integer(n) {
  if (Buffer.isBuffer(n)) return integerFromBuffer(n);
  const bytes = [];
  let v = n;
  if (v === 0) bytes.push(0);
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return integerFromBuffer(Buffer.from(bytes));
}

/** BIT STRING, with the leading "unused bits in the final octet" byte X.509 always sets to 0. */
const bitString = (buf) => tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0x00]), buf]));
const octetString = (buf) => tlv(TAG.OCTET_STRING, buf);
const boolean = (b) => tlv(TAG.BOOLEAN, Buffer.from([b ? 0xff : 0x00]));
const utf8 = (s) => tlv(TAG.UTF8_STRING, Buffer.from(s, 'utf8'));
const ia5 = (s) => tlv(TAG.IA5_STRING, Buffer.from(s, 'ascii'));
const nullValue = () => tlv(TAG.NULL, Buffer.alloc(0));

/**
 * OBJECT IDENTIFIER. The first two arcs share a byte (40*a + b); the rest are base-128 varints,
 * big-endian, with the high bit set on every byte but the last.
 */
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

/**
 * UTCTime (YYMMDDHHMMSSZ) below 2050 and GeneralizedTime at or above it — the switchover RFC 5280
 * mandates, because UTCTime's two-digit year is ambiguous past then. Our CA lifetime makes this
 * reachable, so it is handled rather than asserted away.
 */
function time(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = date.getUTCFullYear();
  const rest =
    p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours()) +
    p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z';
  if (y < 2050) return tlv(TAG.UTC_TIME, Buffer.from(p(y % 100) + rest, 'ascii'));
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(p(y, 4) + rest, 'ascii'));
}

/** Wrap DER in the PEM armour Node's tls/crypto APIs accept. */
function toPem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

module.exports = {
  TAG, encodeLength, tlv, seq, set, explicit, implicitPrimitive,
  integer, bitString, octetString, boolean, utf8, ia5, nullValue, oid, time, toPem,
};
