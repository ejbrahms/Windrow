// `npm run resolve-principal` (or invoked directly by a hook) — resolves the current process's
// real platform identity, registers it, and prints `{identity, principalId}` as JSON on stdout.
// This is the piece a PreToolUse/PostToolUse hook (roadmap item 3) shells out to so it can call
// the governance API with a real `principalId` instead of a guessed one — the hook doesn't need
// to know the id scheme, just its own env, which it already inherits from the agent process that
// spawned it.
//
// Prints `{"identity": null, "principalId": null}` and exits 0 (not an error) when identity can't
// be resolved — a fail-open no-identity case the caller decides how to handle.
//
// Delegates to the hooks' own `resolvePrincipal` rather than reimplementing the upsert. That used
// to be `store.load()` → `upsertPrincipalFromIdentity` → `store.save()` here, i.e. store.js's
// `replaceAll` — a whole-database rewrite off a snapshot read microseconds earlier, on the hook
// path, discarding any row written in between. It now goes through `POST /api/principals/resolve`
// (a narrow two-row transaction behind `requireAuth`), and inherits the principal cache, so a
// second invocation for the same agent makes no registry write at all. Sharing the function is
// what keeps this entry point from drifting back into its own direct write path — see
// docs/design/global-identity-and-central-db.md, phase 0.
const { identityFromEnv } = require('./fromEnv');
const { resolvePrincipal } = require('../hooks/lib');

(async () => {
  const identity = identityFromEnv(process.env);
  const instance = identity ? await resolvePrincipal() : null;
  if (!instance) {
    console.log(JSON.stringify({ identity: null, principalId: null }));
    return;
  }
  console.log(JSON.stringify({ identity, principalId: instance.id }));
})();
