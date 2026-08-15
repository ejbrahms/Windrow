// `npm run resolve-principal` (or invoked directly by a hook) — resolves the current process's
// real platform identity, upserts it into the store, and prints `{identity, principalId}` as
// JSON on stdout. This is the piece a PreToolUse/PostToolUse hook (roadmap item 3) shells out to
// so it can call the governance API with a real `principalId` instead of a guessed one — the
// hook doesn't need to know the id scheme, just its own env, which it already inherits from the
// agent process that spawned it.
//
// Prints `{"identity": null, "principalId": null}` and exits 0 (not an error) when run outside
// the platform (no LOOM_NODE_ID) — a fail-open no-identity case the caller decides how to handle.
const store = require('../store');
const { identityFromEnv } = require('./fromEnv');
const { upsertPrincipalFromIdentity } = require('./registry');

const identity = identityFromEnv(process.env);
if (!identity) {
  console.log(JSON.stringify({ identity: null, principalId: null }));
  process.exit(0);
}

const db = store.load();
const { instance } = upsertPrincipalFromIdentity(db, identity);
store.save(db);

console.log(JSON.stringify({ identity, principalId: instance.id }));
