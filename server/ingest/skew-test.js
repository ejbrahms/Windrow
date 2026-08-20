// Verification for the two version-skew rules — docs/design/global-identity-and-central-db.md §2.6.
// Run it with: node server/ingest/skew-test.js  (npm run test:skew --prefix server)
//
// The rules exist for a fleet of N nodes on user PCs that update at N different times, so every
// test here is a *mismatch* staged deliberately: an event from a build with fields this one has
// never heard of, an event from a build that had not grown fields this one has, a policy payload
// stamped with a schema this node cannot read.
//
//   RULE 1 — INGEST IS ADDITIVE-ONLY AND TOLERANT
//     1a  an unknown field is stored, not rejected, and is still there after a round trip
//     1b  a missing field is null — not a throw, and not an invented 'unknown'/0
//     1c  a re-ingest (ship, restore) does not lose what a previous build parked in `extra`
//     1d  a field that has since gained a column is promoted out of `extra`, not held in both
//     1e  the caller cannot reach past the broker: `extra` is not a way to set `outcome`
//     1f  `extra` is inside the hash chain, so an edit to an unknown field is still detectable
//
//   RULE 2 — POLICY PAYLOADS CARRY A SCHEMA VERSION
//     2a  a delta stamped with a version this node does not understand is refused whole
//     2b  the refusal leaves the LAST-GOOD replica exactly as it was — no half-apply
//     2c  a payload with no schemaVersion at all is refused the same way (absent ≠ compatible)
//     2d  the refusal is distinguishable from a quiet node: it is reported as skew
//
// Rule 2's other half — that a refused delta still lands the deny-list, so revocation survives —
// is asserted end-to-end over a live server in server/policy/distribution-test.js, and is not
// duplicated here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-skew-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');

const { normalizeUsageEvent, readExtra } = require('./usageEvent');
const store = require('../store');
const replica = require('../policy/replica');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log('     ', detail);
  }
}

// ---------------------------------------------------------------------------
// Rule 1 — ingest is additive-only and tolerant
// ---------------------------------------------------------------------------

console.log('\n-- §2.6 rule 1: ingest stores unknown fields and nulls missing ones --');

// A capability and a principal to hang events off. Nothing here tests authorization; the events
// just need referents that exist so a later read is not filtered out from under the assertions.
const cap = store.insertCapability({
  id: 'cap_skew', kind: 'tool', name: 'skew_probe', owner: 'test', riskTier: 'read_only',
  description: null, source: 'test', discoveredAt: new Date().toISOString(), lastSeenAt: null,
  stale: 0, realUsage: null, autoGrant: 0,
});
const principal = store.insertPrincipal({
  id: 'pr_skew', kind: 'role', name: 'skew-tester', status: 'active',
});
check(Boolean(cap && principal), 'scratch capability and principal exist');

// 1a + 1b. One event as a NEWER build would send it: two fields with no column here, and most of
// the columns this build does have simply absent.
const fromNewerBuild = {
  id: 'ev_newer',
  principalId: principal.id,
  capabilityId: cap.id,
  ts: new Date().toISOString(),
  outcome: 'ok',
  latencyMs: 12,
  // Neither of these exists as a column in this build. One scalar, one structured — the structured
  // one is the case an INSERT column list loses most quietly.
  tenantId: 'acme',
  toolInput: { path: 'C:/x', bytes: 4096 },
};
const stored = store.insertUsageEvent(fromNewerBuild);
check(Boolean(stored), '1a an event carrying unknown fields is accepted, not rejected');
const back = readExtra(stored.extra);
check(back && back.tenantId === 'acme', '1a a scalar unknown field survives the round trip', stored.extra);
check(
  back && back.toolInput && back.toolInput.bytes === 4096,
  '1a a structured unknown field survives verbatim rather than stringifying to [object Object]',
  stored.extra
);
check(stored.osUser === null && stored.subjectId === null, '1b a field this build has but the sender omitted reads null');
check(stored.correlationId === null, '1b a missing nullable field is null, not undefined');

// 1b, the sharper half: the five columns that were NOT NULL before §2.6. An OLDER build predates
// them; the event has to land anyway, and it must not land carrying invented values.
const fromOlderBuild = normalizeUsageEvent({ id: 'ev_older' });
check(fromOlderBuild.ok, '1b an event with nothing but an id normalizes rather than throwing');
check(
  fromOlderBuild.row.outcome === null && fromOlderBuild.row.latencyMs === null,
  '1b a missing outcome/latencyMs is null — never invented as "unknown"/0, which would read as real',
  fromOlderBuild.row
);
let landed = null;
try {
  landed = store.insertUsageEvent({ id: 'ev_older', principalId: principal.id, capabilityId: cap.id });
} catch (err) {
  landed = { error: err.message };
}
check(landed && !landed.error && landed.outcome === null, '1b a partial event reaches the table with nulls, not a NOT NULL failure', landed);

// The one refusal, and it is about a key rather than a field.
const noId = normalizeUsageEvent({ principalId: 'p' });
check(noId.ok === false, '1b an event with no id is refused — an id is the key a redelivery arrives with, not a field');

// 1c. Re-ingest: exactly what happens when a shipped row reaches central, or a snapshot is
// restored. The `extra` the row already carries must not be dropped or nested.
const reingested = normalizeUsageEvent(stored);
check(reingested.ok, '1c a stored row re-normalizes');
const reBack = readExtra(reingested.row.extra);
check(reBack && reBack.tenantId === 'acme' && !('extra' in reBack), '1c re-ingest keeps `extra` flat and intact', reingested.row.extra);
check(reingested.row.extra === stored.extra, '1c re-ingest is idempotent — the same canonical string, so the same hash');

// 1d. The upgrade case the column exists for: this build has grown `subjectId`, and a row written
// before it did carries the value in `extra`. It is promoted into the column and removed from
// `extra`, so no reader has two places to look.
const promoted = normalizeUsageEvent({ id: 'ev_promote', extra: JSON.stringify({ subjectId: 'win-sid:S-1-5-21-1', tenantId: 'acme' }) });
check(promoted.row.subjectId === 'win-sid:S-1-5-21-1', '1d a field that has since gained a column is promoted out of `extra`');
check(promoted.promotedKeys.includes('subjectId'), '1d the promotion is reported, not silent');
const promotedExtra = readExtra(promoted.row.extra);
check(promotedExtra && !('subjectId' in promotedExtra) && promotedExtra.tenantId === 'acme',
  '1d the promoted value is not left behind in `extra` as a second copy free to disagree', promoted.row.extra);

// 1e. Tolerance is not a bypass. Every name this build knows is decided by this build.
const spoofed = normalizeUsageEvent({
  id: 'ev_spoof', outcome: 'denied', nodeId: 'someone-elses-node', seq: 99, hash: 'forged',
});
const spoofExtra = readExtra(spoofed.row.extra);
check(!('nodeId' in spoofed.row) && !('seq' in spoofed.row) && !('hash' in spoofed.row),
  '1e writer-assigned coordinates are not taken from the caller', spoofed.row);
check(spoofExtra === null, '1e nor are they smuggled in via `extra` — they are dropped, not filed as news', spoofed.row.extra);

// Key ordering: `extra` is hashed, so two ingests of the same fields in different orders must
// produce the same string or the same event would chain differently on two nodes.
const orderA = normalizeUsageEvent({ id: 'e', alpha: 1, zulu: 2 }).row.extra;
const orderB = normalizeUsageEvent({ id: 'e', zulu: 2, alpha: 1 }).row.extra;
check(orderA === orderB, '1e `extra` is canonical — key order in the request does not change the hash', [orderA, orderB]);

// 1f. `extra` is in the chain. Edit an unknown field directly in the database and the chain has to
// break — an unrecognised field is evidence like any other, and evidence outside the chain is
// evidence that can be rewritten for free.
check(store.verifyUsageEventChain().ok, '1f the chain verifies before tampering');
const Database = require('better-sqlite3');
const raw = new Database(process.env.WINDROW_DB_PATH);
raw.prepare("UPDATE usage_events SET extra = ? WHERE id = 'ev_newer'").run(JSON.stringify({ tenantId: 'someone-else', toolInput: {} }));
raw.close();
const tampered = store.verifyUsageEventChain();
check(tampered.ok === false && tampered.brokenAt === 'ev_newer',
  '1f editing an unknown field breaks the hash chain — `extra` is covered like every other column', tampered);

// ---------------------------------------------------------------------------
// Rule 2 — policy payloads carry a schema version
// ---------------------------------------------------------------------------

console.log('\n-- §2.6 rule 2: a node refuses a policy payload it does not understand --');

const KNOWN = [...replica.SUPPORTED_SCHEMA_VERSIONS][0];

// A last-good replica: one applied delta, so there is something real to fall back TO. A refusal
// against an empty replica would pass this test while proving nothing.
const good = replica.applyDelta(replica.emptyReplica(), {
  schemaVersion: KNOWN,
  since: 0,
  version: 2,
  floor: 1,
  complete: true,
  changes: [
    { version: 1, entity: 'capability', entityId: 'cap_a', row: { id: 'cap_a', name: 'a', riskTier: 'read_only' } },
    { version: 2, entity: 'grant', entityId: 'g_a', row: { id: 'g_a', principalId: 'p', capabilityId: 'cap_a' } },
  ],
});
check(good.ok && good.replica.version === 2, '2b a well-formed delta applies, giving us a last-good replica to fall back to', good);
const lastGood = JSON.parse(JSON.stringify(good.replica));

// 2a + 2b. The same delta, one field different.
const skewed = replica.applyDelta(good.replica, {
  schemaVersion: KNOWN + 41,
  since: 2,
  version: 4,
  floor: 1,
  complete: true,
  changes: [
    { version: 3, entity: 'capability', entityId: 'cap_b', row: { id: 'cap_b', name: 'b', riskTier: 'destructive' } },
    { version: 4, entity: 'grant', entityId: 'g_b', row: { id: 'g_b', principalId: 'p', capabilityId: 'cap_b' } },
  ],
});
check(skewed.ok === false, '2a a delta stamped with an unknown schemaVersion is refused');
check(skewed.skew === true, '2d the refusal is flagged as skew, so it is distinguishable from a gap or a rewind');
check(/schemaVersion/.test(skewed.reason || ''), '2d the reason names the schema version, since the remedy is an upgrade', skewed.reason);
// The half-apply this rule exists to prevent: cap_b landing without g_b, or the version moving
// while the rows did not. `applyDelta` is pure and returns the untouched replica, so the check is
// that the object it was handed is byte-identical afterwards.
assert.deepStrictEqual(good.replica, lastGood);
check(true, '2b the last-good replica is untouched — refused whole, never applied in part');
check(!skewed.replica, '2b no partial replica is offered for the caller to persist by accident');

// 2c. Absent is not compatible. A payload from a central that predates versioning, or a proxy that
// stripped the field, must take the same path as one from the future — "no version" is not a
// version this node understands.
const unstamped = replica.applyDelta(good.replica, { since: 2, version: 3, floor: 1, complete: true, changes: [] });
check(unstamped.ok === false && unstamped.skew === true, '2c a payload with no schemaVersion at all is refused, not assumed compatible', unstamped);

// And the compatible case still works, so the check is a version check and not a wall.
const next = replica.applyDelta(good.replica, {
  schemaVersion: KNOWN, since: 2, version: 3, floor: 1, complete: true,
  changes: [{ version: 3, entity: 'principal', entityId: 'p_a', row: { id: 'p_a', name: 'a' } }],
});
check(next.ok && next.replica.version === 3, '2a a payload at a version this node understands still applies', next);

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`}`);
try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* windows file locks */ }
process.exit(failures === 0 ? 0 : 1);
