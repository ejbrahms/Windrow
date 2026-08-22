// Verification for native-tool observation *principal resolution* (server/nativeObservations.js).
// Run it with: node server/nativeObservations-test.js  (npm run test:native-observations --prefix server)
//
// This exists because of a failure with no symptom at the point it happened. On a node where
// central owns policy (WINDROW_POLICY_AUTHORITY=central), principals are a read replica and
// `store.upsertPrincipalIdentity()` is refused outright. The drain called it for every loom in a
// batch, caught the refusal, resolved every loom to null, and skipped every row — after it had
// already renamed the spool out of the way. So the spool emptied, nothing was inserted, and the
// dashboard's "Native tool calls — observed, not governed" card simply stopped gaining rows on
// exactly the nodes that are governed hardest. Nothing failed loudly; a card went quiet.
//
// FIVE PROPERTIES, each a way this could look fixed and not be:
//
//   1. AN EXISTING PRINCIPAL IS FOUND BY READING, NOT BY WRITING. The read hits on essentially
//      every real call, and it is the only step that works identically under either authority.
//   2. A REPLICA NEVER ATTEMPTS THE WRITE. Not merely "survives the refusal" — attempting it once
//      per unknown loom per drain is what filled the service log with refusals for a condition
//      that is the node's normal state.
//   3. AN UNRESOLVED LOOM STILL GETS AN ID. Dropping the row was the bug; a loom-derived
//      placeholder keeps the observation, and `principalId` is NOT NULL so there is no third option.
//   4. THE PLACEHOLDER IS SWEPT ONTO THE REAL ROW once the principal replicates down, so the
//      per-principal rollup shows one agent rather than two.
//   5. A NODE THAT OWNS ITS POLICY STILL MINTS PRINCIPALS, exactly as POST /api/principals/resolve
//      does — the replica fix must not quietly turn a standalone install into a read-only one.
//
// Everything is driven with a fake store: what is under test is the resolution step, and reaching
// it through a real spool file would race the running service for the same journal.

const {
  resolvePrincipals,
  reclaimPlaceheldObservations,
  placeholderPrincipalId,
  isPlaceholder,
} = require('./nativeObservations');

let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`);
}

function entry(loomId, extra = {}) {
  return {
    toolName: 'Read',
    identity: { loomId, humanName: 'Tester', backend: 'claude', agentType: 'claudecode', field: 'f', ...extra },
  };
}

/** A stand-in for server/store.js carrying only what resolution touches. */
function fakeStore({ principals = {}, readOnly = false } = {}) {
  const calls = { upserts: 0, reassigns: [] };
  return {
    calls,
    principals,
    isPolicyReadOnly: () => readOnly,
    findPrincipalByKindName: (kind, name) => (kind === 'instance' ? principals[name] || null : null),
    upsertPrincipalIdentity: (roleName, identity) => {
      calls.upserts += 1;
      if (readOnly) throw new Error('upsertPrincipalIdentity() is refused: central owns policy on this node');
      const row = { id: `pr_minted_${identity.loomId}`, kind: 'instance', name: identity.loomId };
      principals[identity.loomId] = row;
      return { instance: row };
    },
    reassignNativeToolEventPrincipal: (from, to) => {
      calls.reassigns.push([from, to]);
      return 7;
    },
  };
}

// 1. An existing principal is found by reading.
{
  const store = fakeStore({ principals: { 'claude-1': { id: 'pr_real' } }, readOnly: true });
  const byLoom = resolvePrincipals(store, [entry('claude-1'), entry('claude-1')]);
  check(byLoom.get('claude-1') === 'pr_real', '1. an existing principal resolves to its real id');
  check(store.calls.upserts === 0, '1. ...without a write', `${store.calls.upserts} upserts`);
}

// 2 & 3. A replica does not attempt the write, and the unresolved loom still gets an id.
{
  const store = fakeStore({ readOnly: true });
  const byLoom = resolvePrincipals(store, [entry('claude-unknown')]);
  check(store.calls.upserts === 0, '2. a replica never attempts the refused upsert', `${store.calls.upserts} attempts`);
  const id = byLoom.get('claude-unknown');
  check(Boolean(id), '3. an unresolved loom still gets an id (the row is kept, not dropped)');
  check(isPlaceholder(id), '3. ...and it is recognisable as a placeholder', String(id));
  check(id === placeholderPrincipalId('claude-unknown'), '3. ...derived from the loom id, so it is stable across drains');
}

// 4. The placeholder is swept onto the real row once the principal replicates down.
{
  const store = fakeStore({ readOnly: true });
  resolvePrincipals(store, [entry('claude-late')]);
  check(reclaimPlaceheldObservations(store) === 0, '4. nothing is swept while the principal is still absent');
  store.principals['claude-late'] = { id: 'pr_replicated' };
  const moved = reclaimPlaceheldObservations(store);
  check(moved === 7, '4. observations are re-pointed once the principal arrives', `${moved} rows`);
  check(
    store.calls.reassigns.some(([from, to]) => from === placeholderPrincipalId('claude-late') && to === 'pr_replicated'),
    '4. ...from the placeholder onto the real principal',
    JSON.stringify(store.calls.reassigns)
  );
  const before = store.calls.reassigns.length;
  reclaimPlaceheldObservations(store);
  check(store.calls.reassigns.length === before, '4. ...and the sweep does not repeat once it has succeeded');
}

// 5. A node that owns its policy still mints principals.
{
  const store = fakeStore({ readOnly: false });
  const byLoom = resolvePrincipals(store, [entry('claude-local')]);
  check(store.calls.upserts === 1, '5. a policy-owning node mints the principal it did not find');
  check(byLoom.get('claude-local') === 'pr_minted_claude-local', '5. ...and the observation lands on that row');
  check(!isPlaceholder(byLoom.get('claude-local')), '5. ...not on a placeholder');
}

console.log(failures === 0 ? '\nAll native-observation resolution properties hold.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
