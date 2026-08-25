// Verification for the enforcement pause — "turn off denials for X time" (server/enforcementPause.js).
// Run it with: node server/enforcementPause-test.js  (npm run test:enforcement-pause --prefix server)
//
// Nothing here needs a network or a server. What is under test is the part that is dangerous if it
// is subtly wrong: a bypass that is wider, longer, or quieter than it claims to be.
//
// NINE PROPERTIES, each chosen because it is a way this feature could look correct and not be:
//
//   1. IT ACTUALLY SUPPRESSES. A pause covering a tier turns that tier's denial into an allow.
//      Asserted first because everything below is a limit on this, and a limit on nothing is easy
//      to pass.
//   2. IT IS TIER-SCOPED. A pause on read_only+mutating leaves a destructive denial standing. An
//      operator who types the short form must not get the wide window.
//   3. IT EXPIRES. A pause whose `until` has passed is no pause — this is what makes forgetting to
//      close one cost half an hour rather than forever, and it is the only bound that holds with
//      nobody doing anything.
//   4. IT IS CLAMPED. Asking for 4 hours gets 30 minutes; asking for 10 seconds gets 5. The cap is
//      the difference between a debugging window and an off switch.
//   5. IT IS SIGNED. A pause file written by hand, or edited to extend itself, is ignored — so
//      "only a healthy server can mint one" is enforced by the reader and not merely by which code
//      path happens to write the file.
//   6. AN UNKNOWN TIER NEEDS THE FULL PAUSE. A denial whose risk tier we could not determine is
//      covered only by a pause naming every tier, because `tolerate` is a list of tiers and one we
//      could not name cannot be on it.
//   7. IT IS LOUD. Every suppressed denial writes a fault-journal row carrying the pause id and
//      what the decision WOULD have been. A silent bypass is an audit gap.
//   8. THE ENV VAR IS PARSED THE WAY ITS DOCS SAY. "1" is a default-length window, not a
//      1-millisecond one; "off" does nothing; a malformed value is ignored rather than fatal.
//   9. THE ALL-TIER PAUSE NEEDS THE OWNER KEY. A pause naming every tier — the only one that
//      suppresses destructive and unknown-tier denials — is honoured only with a second signature
//      under the owner-only key, so the hook-readable agent token alone cannot forge one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-pause-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const pauseModule = require('./enforcementPause');
const {
  PAUSE_PATH,
  MIN_PAUSE_MS,
  MAX_PAUSE_MS,
  DEFAULT_PAUSE_MS,
  readEnforcementPause,
  pauseCoversUnknownTier,
  parseDurationMs,
  beginEnforcementPause,
  endEnforcementPause,
  applyEnvEnforcementPause,
} = pauseModule;

const hooks = require('./hooks/lib');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`     ${detail}`);
  }
}

const FAULT_JOURNAL = path.join(__dirname, 'data', 'hook-fault-journal.jsonl');
function journalTail() {
  try {
    const lines = fs.readFileSync(FAULT_JOURNAL, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

const CAP = { id: 'cap-1', kind: 'mcp', name: 'test/thing', riskTier: 'mutating' };
const DESTRUCTIVE = { id: 'cap-2', kind: 'mcp', name: 'test/nuke', riskTier: 'destructive' };
const PRINCIPAL = { id: 'prin-1', name: 'tester' };

// ---------------------------------------------------------------------------
// 1. It actually suppresses.
endEnforcementPause();
beginEnforcementPause({ durationMs: '10m', reason: 'property 1' });
check(
  Boolean(hooks.enforcementPauseOverride({ tier: 'mutating', capability: CAP.name, why: 'no-grant', emit: false })),
  '1. a pause covering mutating suppresses a mutating denial'
);

// 2. Tier-scoped: the default window leaves destructive standing.
check(
  hooks.enforcementPauseOverride({ tier: 'destructive', capability: DESTRUCTIVE.name, why: 'no-grant', emit: false })
    === null,
  '2. the default pause does NOT cover destructive'
);
endEnforcementPause();
beginEnforcementPause({ durationMs: '10m', reason: 'property 2', tolerate: ['read_only', 'mutating', 'destructive'] });
check(
  Boolean(
    hooks.enforcementPauseOverride({ tier: 'destructive', capability: DESTRUCTIVE.name, why: 'no-grant', emit: false })
  ),
  '2. a pause that names destructive does cover it'
);

// 3. It expires. Read at a moment past `until` rather than by sleeping ten minutes.
const shortLived = beginEnforcementPause({ durationMs: '10m', reason: 'property 3' });
check(readEnforcementPause(shortLived.until - 1) !== null, '3. a pause is live one ms before it expires');
check(readEnforcementPause(shortLived.until) === null, '3. a pause is dead at the instant it expires');
check(readEnforcementPause(shortLived.until + 60_000) === null, '3. an expired pause stays dead');

// 4. Clamped at both ends.
const tooLong = beginEnforcementPause({ durationMs: '4h', reason: 'property 4' });
check(
  tooLong.until - tooLong.issuedAt === MAX_PAUSE_MS,
  '4. a 4-hour request is clamped to the 30-minute cap',
  `got ${tooLong.until - tooLong.issuedAt}ms`
);
const tooShort = beginEnforcementPause({ durationMs: '10s', reason: 'property 4' });
check(
  tooShort.until - tooShort.issuedAt === MIN_PAUSE_MS,
  '4. a 10-second request is raised to the 5-minute floor',
  `got ${tooShort.until - tooShort.issuedAt}ms`
);
const defaulted = beginEnforcementPause({ reason: 'property 4' });
check(defaulted.until - defaulted.issuedAt === DEFAULT_PAUSE_MS, '4. no duration means the 15-minute default');
let refusedBadDuration = false;
try {
  beginEnforcementPause({ durationMs: 'soon', reason: 'property 4' });
} catch (err) {
  refusedBadDuration = err.status === 400;
}
check(refusedBadDuration, '4. an unparseable duration is refused, not silently defaulted');

// 5. Signed. Hand-writing a pause, or editing a real one to extend itself, is ignored.
beginEnforcementPause({ durationMs: '10m', reason: 'property 5' });
const genuine = fs.readFileSync(PAUSE_PATH, 'utf8');
fs.writeFileSync(
  PAUSE_PATH,
  JSON.stringify({
    payload: JSON.stringify({ id: 'forged', issuedAt: Date.now(), until: Date.now() + 3_600_000, tolerate: ['mutating'], reason: 'forged' }),
    sig: 'deadbeef',
  })
);
check(readEnforcementPause() === null, '5. a forged signature is ignored');
// The tamper that matters most: keep the real signature, extend the payload.
const { payload, sig } = JSON.parse(genuine);
const extended = JSON.parse(payload);
extended.until += 24 * 3_600_000;
fs.writeFileSync(PAUSE_PATH, JSON.stringify({ payload: JSON.stringify(extended), sig }));
check(readEnforcementPause() === null, '5. a payload edited under a valid signature is ignored');
fs.writeFileSync(PAUSE_PATH, 'not json at all');
check(readEnforcementPause() === null, '5. an unreadable pause file means enforcement is ON, not off');

// 6. Unknown tier needs the full pause.
endEnforcementPause();
beginEnforcementPause({ durationMs: '10m', reason: 'property 6' });
check(
  hooks.enforcementPauseOverride({ tier: null, capability: 'mcp/never-seen', why: 'tier-unknown', emit: false }) === null,
  '6. a partial pause does NOT cover a denial whose tier is unknown'
);
check(!pauseCoversUnknownTier(readEnforcementPause()), '6. pauseCoversUnknownTier is false for a partial pause');
endEnforcementPause();
beginEnforcementPause({ durationMs: '10m', reason: 'property 6', tolerate: ['read_only', 'mutating', 'destructive'] });
check(
  Boolean(hooks.enforcementPauseOverride({ tier: null, capability: 'mcp/never-seen', why: 'tier-unknown', emit: false })),
  '6. a pause naming every tier DOES cover an unknown tier'
);

// 7. Loud. The journal row names the pause and what it suppressed.
endEnforcementPause();
const audited = beginEnforcementPause({ durationMs: '10m', reason: 'property 7' });
hooks.enforcementPauseOverride({
  tier: 'mutating',
  capability: CAP.name,
  principalId: PRINCIPAL.id,
  why: 'no-grant',
  emit: true,
});
const row = journalTail();
check(row && row.why === 'enforcement-pause', '7. the suppressed call is journalled as enforcement-pause', JSON.stringify(row));
check(row && row.enforcementPause === audited.id, '7. the journal row carries the pause id');
check(row && row.suppressed === 'no-grant', '7. the journal row records what the decision would have been');
check(row && row.outcome === 'allow' && row.principalId === PRINCIPAL.id, '7. the row records the allow and who got it');

// The ladder, end to end: a healthy-server fault on a mutating capability with no lease denies, and
// the same call under a pause allows. This is the property the wiring exists to produce, asserted
// through faultPolicy rather than through the override alone.
endEnforcementPause();
const strict = hooks.faultPolicy({ fault: hooks.FAULT.UNREACHABLE, capability: CAP, principal: PRINCIPAL });
check(strict.decision === 'deny', '7. with enforcement on, a mutating fault with no lease still denies');
beginEnforcementPause({ durationMs: '10m', reason: 'ladder' });
const relaxed = hooks.faultPolicy({ fault: hooks.FAULT.UNREACHABLE, capability: CAP, principal: PRINCIPAL });
check(relaxed.decision === 'allow' && relaxed.journal.why === 'enforcement-pause', '7. under a pause the same fault allows');
const stillDestructive = hooks.faultPolicy({ fault: hooks.FAULT.UNREACHABLE, capability: DESTRUCTIVE, principal: PRINCIPAL });
check(stillDestructive.decision !== 'allow', '7. a destructive fault is NOT auto-allowed by the default pause');

// 8. The env var.
check(parseDurationMs('20m') === 1_200_000, '8. "20m" parses to 20 minutes');
check(parseDurationMs('90s') === 90_000, '8. "90s" parses to 90 seconds');
check(parseDurationMs('900000') === 900_000, '8. a bare number is milliseconds');
check(parseDurationMs('soon') === null, '8. nonsense parses to null rather than to zero');

const quiet = () => {};
endEnforcementPause();
check(applyEnvEnforcementPause({}, { log: quiet }) === null, '8. an unset env var opens nothing');
check(
  applyEnvEnforcementPause({ WINDROW_DISABLE_DENIALS: 'false' }, { log: quiet }) === null,
  '8. "false" opens nothing'
);
endEnforcementPause();
const fromFlag = applyEnvEnforcementPause({ WINDROW_DISABLE_DENIALS: '1' }, { log: quiet });
check(
  fromFlag && fromFlag.until - fromFlag.issuedAt === DEFAULT_PAUSE_MS,
  '8. "1" means the default window, NOT one millisecond',
  fromFlag ? `${fromFlag.until - fromFlag.issuedAt}ms` : 'null'
);
endEnforcementPause();
const fromDuration = applyEnvEnforcementPause(
  { WINDROW_DISABLE_DENIALS: '20m', WINDROW_DISABLE_DENIALS_TIERS: 'read_only,mutating,destructive', WINDROW_DISABLE_DENIALS_REASON: 'repro' },
  { log: quiet }
);
check(fromDuration && fromDuration.until - fromDuration.issuedAt === 1_200_000, '8. "20m" opens a 20-minute window');
check(fromDuration && fromDuration.tolerate.length === 3, '8. WINDROW_DISABLE_DENIALS_TIERS is honoured');
check(fromDuration && fromDuration.reason === 'repro', '8. WINDROW_DISABLE_DENIALS_REASON is recorded');
endEnforcementPause();
check(
  applyEnvEnforcementPause({ WINDROW_DISABLE_DENIALS: 'whenever' }, { log: quiet }) === null,
  '8. a malformed duration is ignored rather than fatal'
);
check(readEnforcementPause() === null, '8. ...and leaves no pause behind');

// ---------------------------------------------------------------------------
// 9. THE ALL-TIER PAUSE NEEDS THE OWNER KEY. The agent token every hook carries also signs the
//    pause file, so the model accepts that reading it forges a tier-scoped pause. The all-tier
//    pause — the only one that turns off destructive and unknown-tier denials — must additionally
//    carry an owner-key co-signature the hook-readable token cannot produce. See bound 6.
const crypto = require('crypto');
const { AGENT_TOKEN, OWNER_SIGNING_KEY } = require('./auth');
const agentSig = (payload) => crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
const ownerSigOf = (payload) => crypto.createHmac('sha256', OWNER_SIGNING_KEY).update(payload).digest('hex');

// A genuine all-tier pause carries the owner co-signature on disk and is honoured.
endEnforcementPause();
beginEnforcementPause({ durationMs: '10m', reason: 'property 9', tolerate: ['read_only', 'mutating', 'destructive'] });
const allTierEnvelope = JSON.parse(fs.readFileSync(PAUSE_PATH, 'utf8'));
check(typeof allTierEnvelope.ownerSig === 'string', '9. a minted all-tier pause is co-signed with the owner key');
check(readEnforcementPause() !== null, '9. a genuinely minted all-tier pause is honoured');

// The attack: an all-tier pause forged with ONLY the agent token — a valid `sig`, no `ownerSig`.
const forgedPayload = JSON.stringify({
  id: 'forged-all-tier', issuedAt: Date.now(), until: Date.now() + 3_600_000,
  tolerate: ['read_only', 'mutating', 'destructive'], reason: 'forged',
});
fs.writeFileSync(PAUSE_PATH, JSON.stringify({ payload: forgedPayload, sig: agentSig(forgedPayload) }));
check(readEnforcementPause() === null, '9. an all-tier pause with a valid agent sig but no owner sig is rejected');
check(
  hooks.enforcementPauseOverride({ tier: 'destructive', capability: DESTRUCTIVE.name, why: 'no-grant', emit: false }) === null,
  '9. ...so a destructive denial still stands'
);
check(
  hooks.enforcementPauseOverride({ tier: null, capability: 'mcp/never-seen', why: 'tier-unknown', emit: false }) === null,
  '9. ...and an unknown-tier denial still stands'
);

// A wrong owner sig fails the same way as a missing one.
fs.writeFileSync(PAUSE_PATH, JSON.stringify({ payload: forgedPayload, sig: agentSig(forgedPayload), ownerSig: 'deadbeef' }));
check(readEnforcementPause() === null, '9. an all-tier pause with a bad owner sig is rejected');

// Downgrading a co-signed all-tier payload to a partial one under the same envelope does not slip
// through: the agent sig is over the WHOLE payload, so any edit breaks it before the owner check.
const partialForged = JSON.stringify({
  id: 'downgrade', issuedAt: Date.now(), until: Date.now() + 3_600_000, tolerate: ['mutating'], reason: 'x',
});
fs.writeFileSync(PAUSE_PATH, JSON.stringify({ payload: partialForged, sig: agentSig(partialForged), ownerSig: ownerSigOf(partialForged) }));
check(readEnforcementPause() !== null, '9. a partial pause with only the agent sig (owner sig ignored) is still honoured');

// Leave the machine as we found it: this test writes a real pause file into server/data, and a
// forgotten one would silently disable denials on the developer's own box.
endEnforcementPause();
check(readEnforcementPause() === null, 'cleanup: no pause is left in force');
fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log(failures === 0 ? '\nAll enforcement-pause properties hold.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
