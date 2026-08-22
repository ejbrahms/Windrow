const fs = require('fs');
let n = 0;
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error('MISS in ' + p + ' >>>\n' + a + '\n<<<'); process.exit(1); }
    if (s.split(a).length > 2) { console.error('AMBIGUOUS in ' + p + ' >>>\n' + a.slice(0, 90)); process.exit(1); }
    s = s.replace(a, b);
    n += 1;
  }
  fs.writeFileSync(p, s);
}

// ============================================================ server/policy/replica.js
patch('server/policy/replica.js', [[
`function saveDenyList({ denyList, version, fetchedAt, central }) {
  writeSignedAtomic(DENY_LIST_PATH, {
    fetchedAt,
    version,
    central: Boolean(central),`,
`function saveDenyList({ denyList, version, fetchedAt, central, authority }) {
  writeSignedAtomic(DENY_LIST_PATH, {
    fetchedAt,
    version,
    central: Boolean(central),
    // WHO OWNS POLICY, written where the hook can see it (§2.7 phase 4).
    //
    // \`central\` above already says "a central is configured", which is what the staleness bound
    // keys off. It does NOT say "central is the authority" — a phase-3 node ships to a central it
    // does not obey, and on that node an unregistered capability is still genuinely ungoverned.
    // Under phase 4 the same absence means something else entirely: possibly ungoverned, possibly
    // just not replicated yet. server/hooks/lib.js has to tell those apart and cannot read the
    // server's environment to do it, so the writer states it here — the same trick, and the same
    // reason, as the \`central: true, fetchedAt: null\` marker beside it.
    authority: authority || (central ? 'central' : 'node'),`,
]]);

// ============================================================ server/policy/policyClient.js
patch('server/policy/policyClient.js', [
  [`  replica.saveDenyList({
    denyList: delta.denyList,
    version: delta.version,
    fetchedAt: Date.now(),
    central: true,
  });`,
  `  replica.saveDenyList({
    denyList: delta.denyList,
    version: delta.version,
    fetchedAt: Date.now(),
    central: true,
    authority: isCentralAuthority() ? 'central' : 'node',
  });`],
  [`  replica.saveDenyList({
    // Empty, and that is not a gap: an empty deny-list denies nothing, and everything it would have
    // denied is covered by the staleness bound this marker triggers, which is strictly stronger.
    denyList: { grantIds: [], pairs: [], principals: [] },
    version: 0,
    fetchedAt: null,
    central: true,
  });`,
  `  replica.saveDenyList({
    // Empty, and that is not a gap: an empty deny-list denies nothing, and everything it would have
    // denied is covered by the staleness bound this marker triggers, which is strictly stronger.
    denyList: { grantIds: [], pairs: [], principals: [] },
    version: 0,
    fetchedAt: null,
    central: true,
    authority: isCentralAuthority() ? 'central' : 'node',
  });`],
]);

// ============================================================ server/hooks/lib.js
patch('server/hooks/lib.js', [
  // 1. the new fault
  [`  STALE_POLICY: 'stale-policy',
};`,
  `  STALE_POLICY: 'stale-policy',
  // Phase 4 (docs/design/global-identity-and-central-db.md §2.7): the registry answered, and the
  // answer was "I have never heard of that" — from a node whose copy of the registry is a REPLICA
  // that may simply be behind. Under node authority "not in the registry" was a complete answer,
  // because there was nowhere else it could be; under central authority it is two answers wearing
  // one face, and only one of them is a decision. This names the other one.
  NOT_REPLICATED: 'not-replicated',
};`],

  // 2. an explicit reader for the authority marker
  [`/**
 * THE POLICY CHANNEL GATE`,
  `/**
 * What the deny-list file says about who owns policy and how current this node's copy is.
 *
 * Both facts come off the same file for the same reason: a hook runs in the AGENT's environment,
 * not the service's, so it cannot read WINDROW_POLICY_AUTHORITY or WINDROW_CENTRAL_URL. Whoever
 * writes the deny-list — server/policy/policyClient.js on a replica node, server/cacheWarmer.js on
 * a standalone one — states them there, and this is the one place that interprets them.
 *
 * \`replicating\` is deliberately false when the file is missing. A hook that guessed "probably a
 * replica" from an absent file would fail an entire standalone install closed on the strength of a
 * warmer that has not run yet.
 */
function policyPosture(now = Date.now()) {
  const denyList = loadPolicyDenyList();
  if (!denyList) return { denyList: null, replicating: false, stale: false, ageMs: null, version: null };
  const replicating = denyList.authority === 'central';
  // A node whose deny-list has never been stamped is treated as infinitely old, not as fresh —
  // "never confirmed" is the strongest form of stale, not an exemption from it.
  const ageMs = denyList.fetchedAt ? now - denyList.fetchedAt : null;
  const stale = Boolean(denyList.central) && (ageMs === null || ageMs > MAX_POLICY_AGE_MS);
  return { denyList, replicating, stale, ageMs, version: denyList.version ?? null };
}

/**
 * THE POLICY CHANNEL GATE`],

  // 3. the unknown-capability rule — the hook-contract change proper
  [`  if (!capability) {
    log(\`no registered capability for \${target.kind}/\${target.name} — allowing, ungoverned\`);
    decideFn('allow', undefined);
    return;
  }`,
  `  if (!capability) {
    // "NOT IN THE REGISTRY" STOPPED BEING A COMPLETE ANSWER AT PHASE 4, and this is the change to
    // the hook contract §2.7 warns about.
    //
    // While the node owned its own registry, an unregistered tool was ungoverned by definition:
    // there was no other registry it could be in. On a replica node there is — central's — and this
    // node's copy of it can be behind. So the absence has to be read against the copy's freshness:
    //
    //   fresh replica  → central genuinely has no such capability. Ungoverned, allow, as before.
    //   stale replica  → cannot tell. And unlike every other fault, the ladder cannot help, because
    //                    the ladder branches on riskTier and the tier is exactly what is missing —
    //                    the same reason the tier-unknown branch above is a hard deny rather than a
    //                    degradation. Deny, and say why in terms an agent can act on.
    //
    // The asymmetry is intentional: a stale replica denies a tool it has never seen, and keeps
    // allowing read_only tools it has. Failing an unknown tool closed costs a call; treating an
    // unreplicated destructive capability as ungoverned costs the guarantee.
    const posture = policyPosture();
    if (posture.replicating && posture.stale) {
      log(\`no capability for \${target.kind}/\${target.name} and the policy replica is stale — failing closed\`);
      journalFault({
        fault: FAULT.NOT_REPLICATED,
        tier: null,
        capability: \`\${target.kind}/\${target.name}\`,
        outcome: 'deny',
        why: 'unknown-capability-stale-replica',
        denialKind: DENIAL.FAULT,
        policyAgeMs: posture.ageMs,
        policyVersion: posture.version,
      });
      decideFn(
        'deny',
        faultReason(FAULT.NOT_REPLICATED, {
          detail: \`\${target.kind} "\${target.name}" is in no capability this node holds, and this node's copy of \`
            + \`central policy is \${posture.ageMs === null ? 'unconfirmed' : \`\${Math.round(posture.ageMs / 1000)}s old\`}, \`
            + 'so it cannot tell an ungoverned tool from one it has not replicated yet.',
          remedy: 'Retry once this node has confirmed policy with central.',
        })
      );
      return;
    }
    log(\`no registered capability for \${target.kind}/\${target.name} — allowing, ungoverned\`);
    decideFn('allow', undefined);
    return;
  }`],

  // 4. reuse the posture inside the gate rather than re-reading the file
  [`function policyChannelGate({ principal, capability, now = Date.now() }) {
  const denyList = loadPolicyDenyList();
`,
  `function policyChannelGate({ principal, capability, now = Date.now() }) {
  const { denyList } = policyPosture(now);
`],

  // 5. a denial from a replica says whose policy denied it
  [`    log(\`denied: principal \${principal.name} has no active grant for \${target.kind}/\${target.name}\`);
    // The reference policy denial, and what every \`[governance:fault/…]\` reason above is defined
    // against: governance was healthy, answered, and the answer was no.
    decideFn('deny', policyReason(\`No active grant for \${target.kind} "\${target.name}".\`));`,
  `    log(\`denied: principal \${principal.name} has no active grant for \${target.kind}/\${target.name}\`);
    // The reference policy denial, and what every \`[governance:fault/…]\` reason above is defined
    // against: governance was healthy, answered, and the answer was no.
    //
    // Phase 4 adds WHOSE policy said no. \`result.policy\` is stamped by server/app.js's /invoke and
    // carries the authority and the replica version the decision was made at. An agent told "no
    // grant" by a machine that is one of forty replicas deserves to know that asking the admin of
    // *this* machine will not help — the grant is issued centrally and arrives here by replication.
    const stamp = result.policy;
    decideFn('deny', policyReason(
      \`No active grant for \${target.kind} "\${target.name}".\`,
      stamp && stamp.authority === 'central'
        ? \`decided from central policy replicated to this node at version \${stamp.version}\`
        : undefined
    ));`],

  // 6. export the posture reader for the tests
  [`  MAX_POLICY_AGE_MS,`,
  `  MAX_POLICY_AGE_MS,
  // Phase 4: how the hook reads who owns policy and how fresh this node's copy is. Exported for
  // server/policy/authority-test.js, which stages a stale replica and asserts the unknown-capability
  // rule above — the one branch of this file that changed meaning rather than gaining a case.
  policyPosture,`],
]);

console.log('patched', n, 'sites');
