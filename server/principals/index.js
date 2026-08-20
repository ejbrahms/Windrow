const { identityFromEnv } = require('./fromEnv');
const { principalRoleName, principalDisplayName, upsertPrincipalFromIdentity } = require('./registry');

module.exports = { identityFromEnv, principalRoleName, principalDisplayName, upsertPrincipalFromIdentity };
