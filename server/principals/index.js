const { identityFromEnv } = require('./fromEnv');
const { principalRoleName, upsertPrincipalFromIdentity } = require('./registry');

module.exports = { identityFromEnv, principalRoleName, upsertPrincipalFromIdentity };
