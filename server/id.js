const crypto = require('crypto');

/** `<prefix>_<12 hex chars>` id, per the API contract. */
function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = { genId };
