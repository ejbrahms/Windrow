// Verification for the hook-side deadline watchdog (server/hooks/lib.js: resolveHookDeadlineMs +
// armHookDeadline) — the artifact that closes the hang-based fail-open. Run it with:
//   node server/hooks/deadline-test.js   (npm run test:deadline --prefix server)
//
// No network and no server. The whole point of the watchdog is what happens when the network HANGS,
// which a live-server test cannot stage reliably; these assertions drive the timer directly:
//
//   1. resolveHookDeadlineMs sits a fixed margin INSIDE the harness budget, is FLOORED so a tiny
//      budget can't make it fire instantly, and honours the WINDROW_HOOK_DEADLINE_MS override.
//   2. When nothing settles, the watchdog EMITS A DENY on its own after the deadline — the fail-
//      CLOSED that beats the harness's fail-open.
//   3. That deny is tagged as a FAULT, not a policy denial: an agent must not read it as "I lack a
//      grant" and go ask for one.
//   4. A real decision that lands in time DISARMS the timer: the watchdog never double-emits, and a
//      timely allow is never overwritten by a late deny.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-deadline-'));
process.env.WINDROW_DATA_DIR = path.join(SCRATCH, 'data');
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');
// Read the override deterministically below rather than inheriting the ambient environment.
delete process.env.WINDROW_HOOK_DEADLINE_MS;

const lib = require('./lib');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 1: the deadline resolver.
  const margin = lib.HOOK_DEADLINE_MARGIN_MS;
  check(
    lib.resolveHookDeadlineMs(10000) === 10000 - margin,
    '1 deadline sits one margin inside the harness budget',
    `${lib.resolveHookDeadlineMs(10000)} vs ${10000 - margin}`
  );
  // A budget at or below the margin must floor, not go to zero/negative and fire instantly.
  check(lib.resolveHookDeadlineMs(500) >= 1000, '1 tiny budget is floored, not instant', String(lib.resolveHookDeadlineMs(500)));
  check(lib.resolveHookDeadlineMs(0) >= 1000, '1 zero/garbage budget falls back and is floored', String(lib.resolveHookDeadlineMs(0)));

  process.env.WINDROW_HOOK_DEADLINE_MS = '3500';
  check(lib.resolveHookDeadlineMs(60000) === 3500, '1 WINDROW_HOOK_DEADLINE_MS override wins', String(lib.resolveHookDeadlineMs(60000)));
  delete process.env.WINDROW_HOOK_DEADLINE_MS;

  // 2 + 3: nothing settles -> the watchdog denies on its own after the deadline, tagged as a fault.
  const fired = [];
  lib.armHookDeadline((decision, reason) => fired.push({ decision, reason }), { deadlineMs: 30, label: 'mcp_tool/x' });
  await delay(80);
  check(fired.length === 1, '2 watchdog emits exactly one decision on its own', JSON.stringify(fired));
  check(fired[0] && fired[0].decision === 'deny', '2 the unattended decision is a deny', JSON.stringify(fired[0]));
  check(
    fired[0] && typeof fired[0].reason === 'string' && fired[0].reason.includes(`${lib.DENIAL.FAULT}/${lib.FAULT.TIMED_OUT}`),
    '3 the deny is tagged as a fault, not a policy denial',
    fired[0] && fired[0].reason
  );
  check(
    fired[0] && fired[0].reason.includes('NOT a permission denial'),
    '3 the reason tells the agent this is not a missing grant',
    fired[0] && fired[0].reason
  );

  // 4: a real decision in time disarms the timer — no double-emit, no late overwrite.
  const settled = [];
  const guard = lib.armHookDeadline((decision, reason) => settled.push({ decision, reason }), { deadlineMs: 30, label: 'mcp_tool/y' });
  guard.decide('allow', undefined);
  await delay(80);
  check(settled.length === 1 && settled[0].decision === 'allow', '4 a timely decision fires once and is not overwritten', JSON.stringify(settled));

  // 4b: if the timer had already fired, a later real decision is a no-op (belt-and-suspenders
  // against a double stdout write / double process.exit in the subprocess hooks).
  const race = [];
  const raceGuard = lib.armHookDeadline((decision, reason) => race.push({ decision, reason }), { deadlineMs: 20, label: 'mcp_tool/z' });
  await delay(60); // let the watchdog fire first
  raceGuard.decide('allow', undefined); // arrives late — must be ignored
  check(race.length === 1 && race[0].decision === 'deny', '4b a late decision after the watchdog fired is ignored', JSON.stringify(race));

  console.log(failures === 0 ? '\nAll deadline-watchdog checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
