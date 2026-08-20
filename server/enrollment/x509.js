'use strict';
// Mints the X.509 certificates that replace the fleet-wide shared bearer tokens
// (docs/design/global-identity-and-central-db.md §2.5). One CA per install, issuing one
// certificate per enrolled node/caller, so a credential names *who* it belongs to instead of
// merely asserting "a hook" — which is the whole property §2.5's warning block is about: a
// fleet-wide agent token means any node can forge any other node's usage events.
//
// Curve and hash are fixed at EC P-256 / SHA-256 rather than configurable. There is exactly one
// producer and one consumer of these certificates and both are this codebase, so an algorithm
// negotiation would only add a downgrade surface. EC over RSA because keygen is milliseconds
// rather than seconds — enrollment happens on a user's PC during OOBE, and a multi-second stall
// there reads as a hang.
//
// See server/enrollment/der.js for why this is hand-rolled and why nothing here parses
// attacker-supplied ASN.1.

const crypto = require('crypto');
const der = require('./der');

const OID = {
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

/** EC P-256 keypair. Returned as KeyObjects; callers persist the PEM forms. */
function createKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/**
 * BIT STRING carrying a real "unused bits" count. `der.bitString` hardcodes 0, which is right for
 * a signature or a public key but wrong for KeyUsage, where the trailing bits of the final octet
 * are genuinely unused and OpenSSL will read the wrong flags if the count lies.
 */
function keyUsageBits(bits) {
  const highest = Math.max(...bits);
  const nBytes = Math.floor(highest / 8) + 1;
  const buf = Buffer.alloc(nBytes);
  for (const b of bits) buf[Math.floor(b / 8)] |= 0x80 >> (b % 8);
  const unused = nBytes * 8 - (highest + 1);
  return der.tlv(der.TAG.BIT_STRING, Buffer.concat([Buffer.from([unused]), buf]));
}

/**
 * The subjectPublicKey BIT STRING inside an SPKI, which RFC 5280 method 1 hashes to form a key
 * identifier. This is the one place here that reads DER, and it reads only an SPKI that
 * `crypto.createPublicKey` has already accepted — i.e. OpenSSL validated the structure first, and
 * a malformed input never reaches this function. It walks two fixed TLVs; it is not a parser.
 */
function keyIdentifier(spkiDer) {
  const readLen = (buf, i) => {
    const first = buf[i];
    if (first < 0x80) return { len: first, next: i + 1 };
    const n = first & 0x7f;
    let len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i + 1 + k];
    return { len, next: i + 1 + n };
  };
  // SPKI ::= SEQUENCE { AlgorithmIdentifier, subjectPublicKey BIT STRING }
  let { next } = readLen(spkiDer, 1);              // into the outer SEQUENCE
  const alg = readLen(spkiDer, next + 1);          // skip AlgorithmIdentifier
  const bitStart = alg.next + alg.len;
  const bits = readLen(spkiDer, bitStart + 1);
  // +1 skips the BIT STRING's own unused-bits octet, which is not part of the key.
  const raw = spkiDer.subarray(bits.next + 1, bits.next + bits.len);
  return crypto.createHash('sha1').update(raw).digest();
}

/** RDNSequence for the small fixed set of attributes we put in a subject. */
function name({ commonName, organization, organizationalUnit }) {
  const rdns = [];
  const push = (oidStr, value) => {
    if (value == null || value === '') return;
    rdns.push(der.set(der.seq(der.oid(oidStr), der.utf8(String(value)))));
  };
  push(OID.organization, organization);
  push(OID.organizationalUnit, organizationalUnit);
  push(OID.commonName, commonName);
  return der.tlv(der.TAG.SEQUENCE, Buffer.concat(rdns));
}

function extension(oidStr, critical, valueDer) {
  const parts = [der.oid(oidStr)];
  if (critical) parts.push(der.boolean(true));
  parts.push(der.octetString(valueDer));
  return der.seq(...parts);
}

function subjectAltName(sans) {
  const entries = sans.map((s) =>
    s.type === 'ip'
      ? der.implicitPrimitive(7, Buffer.from(s.value.split('.').map(Number)))
      : der.implicitPrimitive(2, Buffer.from(s.value, 'ascii')));
  return der.tlv(der.TAG.SEQUENCE, Buffer.concat(entries));
}

/**
 * Build and sign one certificate.
 *
 * `issuerKey`/`issuerName` are the CA's when issuing a leaf, and the subject's own when creating
 * the self-signed root. Serial numbers are 16 random bytes: with no central allocator (the CA runs
 * on each install) a counter would collide across reinstalls, and a repeated serial from the same
 * issuer is the one uniqueness property a CA genuinely must not break.
 */
function issue({
  subject, publicKey, issuerName, issuerKey,
  notBefore, notAfter, isCa = false, extKeyUsage = [], sans = [], serial,
}) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serialBuf = serial || crypto.randomBytes(16);
  const sigAlg = der.seq(der.oid(OID.ecdsaWithSHA256)); // ECDSA takes absent parameters, not NULL

  // Always derived from the signing key, which makes the self-signed root fall out of the same
  // code path: there, issuerKey *is* this subject's own key, so AKI and SKI coincide as they must.
  const issuerSpki = crypto.createPublicKey(issuerKey).export({ type: 'spki', format: 'der' });

  const exts = [
    extension(OID.basicConstraints, true, isCa
      ? der.seq(der.boolean(true))
      : der.seq()),
    extension(OID.keyUsage, true, isCa
      ? keyUsageBits([5, 6])   // keyCertSign | cRLSign
      : keyUsageBits([0])),    // digitalSignature
    extension(OID.subjectKeyIdentifier, false, der.octetString(keyIdentifier(spki))),
    extension(OID.authorityKeyIdentifier, false,
      der.seq(der.implicitPrimitive(0, keyIdentifier(issuerSpki)))),
  ];
  if (extKeyUsage.length) {
    exts.push(extension(OID.extKeyUsage, false,
      der.tlv(der.TAG.SEQUENCE, Buffer.concat(extKeyUsage.map((o) => der.oid(o))))));
  }
  if (sans.length) exts.push(extension(OID.subjectAltName, false, subjectAltName(sans)));

  const tbs = der.seq(
    der.explicit(0, der.integer(2)),               // v3
    der.integer(serialBuf),
    sigAlg,
    issuerName,
    der.seq(der.time(notBefore), der.time(notAfter)),
    name(subject),
    spki,
    der.explicit(3, der.tlv(der.TAG.SEQUENCE, Buffer.concat(exts))),
  );

  const signature = crypto.sign('sha256', tbs, issuerKey);
  const cert = der.seq(tbs, sigAlg, der.bitString(signature));
  return { pem: der.toPem(cert, 'CERTIFICATE'), der: cert, serial: serialBuf.toString('hex'), subjectName: name(subject) };
}

module.exports = { OID, createKeyPair, issue, name, keyIdentifier };
