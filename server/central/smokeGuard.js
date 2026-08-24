'use strict';
// Refuse to destroy a database that is somebody's fleet.
//
// ==============================================================================================
// THE INCIDENT THIS EXISTS BECAUSE OF
// ==============================================================================================
//
// `./policy-smoke.js` opens with `TRUNCATE policy_changes, grants, approvals, capabilities,
// principals, windrow_audit, node_policy_state`, and `./smoke.js` with a TRUNCATE of the usage
// tables. Both are correct against the scratch database they are meant for. Neither had any way of
// knowing which database it got.
//
// They read `WINDROW_CENTRAL_DB_URL`, and `server/config.js` loads `windrow.env` — so on any
// machine that has been through `npm run setup`, running the suite with no override points it at
// PRODUCTION. On 2026-08-22 that is exactly what happened here: a routine verification sweep ran
// `smoke:central-policy` against the live central and destroyed the whole control plane — 139
// capabilities, 529 grants, every principal, and 810 rows of the `policy_changes` log that is
// central's promise to every replica. It was recovered only because a node still held a replica
// with the pre-truncate contents, and that replica survived by luck: one version mismatch and
// central would have reset it to the empty catalog, taking the last copy with it.
//
// The suites were not wrong to truncate. They were wrong to truncate WITHOUT LOOKING.
//
// ==============================================================================================
// WHAT THE GUARD CHECKS, AND WHY NOT THE OBVIOUS THING
// ==============================================================================================
//
// NOT THE DATABASE NAME. The obvious guard is "refuse unless the name contains `test` or
// `scratch`", and it would not have caught this: the live database is called `windrow_central`,
// which is exactly what a developer would call theirs too. A name is a convention, and a
// convention is the thing that fails at 3am.
//
// SO IT COUNTS ROWS. A scratch database is empty or holds only what a previous run of this suite
// left behind. A production one holds a fleet's history. Counting what is about to be destroyed is
// the one check that distinguishes them by their actual content rather than by their label, and it
// costs one query per table on a database the caller was about to empty anyway.
//
// THE OVERRIDE IS DELIBERATELY UGLY. `WINDROW_SMOKE_TRUNCATE_ANYWAY=1` is not a flag anyone sets
// by habit or copies from a README; it is one you set having read this file and decided. That is
// the point — a guard with a comfortable override is a guard that gets set once in a CI config and
// never thought about again.

/**
 * Refuse to continue if `tables` hold anything.
 *
 * `label` names the suite, so the message says which command is about to do what. Returns the
 * per-table counts on the way through, so a caller can log "started from empty" rather than
 * inferring it.
 */
// Checked ONCE PER PROCESS. `./smoke.js` calls `reset()` several times during a run — between
// scenarios — and by the second call the database is full of the suite's own fixtures. Re-checking
// would refuse the suite for rows it had just written itself, which is the guard failing at the one
// job it has: telling a fleet's database apart from a scratch one. That question is answered once,
// before anything is written, and the answer does not change while the process runs.
let vetted = false;

async function assertSafeToTruncate(driver, tables, { label = 'this smoke suite' } = {}) {
  if (vetted) return null;
  if (process.env.WINDROW_SMOKE_TRUNCATE_ANYWAY === '1') {
    console.warn(
      `[smoke-guard] WINDROW_SMOKE_TRUNCATE_ANYWAY=1 — truncating ${tables.length} table(s) without checking.`,
      'If this is a fleet\'s central, its control plane is about to be destroyed.'
    );
    vetted = true;
    return null;
  }

  const counts = {};
  let populated = 0;
  for (const table of tables) {
    try {
      const row = await driver.get(`SELECT COUNT(*)::BIGINT AS n FROM ${table}`);
      counts[table] = Number((row && row.n) || 0);
      if (counts[table] > 0) populated += 1;
    } catch {
      // A table this build does not have yet is not a reason to refuse — the suite creates the
      // schema it tests. An unreadable table cannot be holding data anyone will miss.
      counts[table] = 0;
    }
  }
  if (!populated) {
    vetted = true;
    return counts;
  }

  const inhabited = Object.entries(counts).filter(([, n]) => n > 0);
  const detail = inhabited.map(([t, n]) => `    ${t}: ${n} row(s)`).join('\n');
  throw new Error(
    `${label} is about to TRUNCATE ${tables.length} table(s), and this database is not empty:\n`
    + `${detail}\n\n`
    + '  This suite destroys everything in those tables. Refusing, because a database with rows in\n'
    + '  it is far more likely to be a real fleet than a scratch one — and the difference is not\n'
    + '  visible in its name.\n\n'
    + '  Point it at a scratch database instead:\n'
    + '    WINDROW_CENTRAL_DB_URL=postgres://…/windrow_scratch npm run smoke:central-policy\n\n'
    + '  Note that WINDROW_CENTRAL_DB_URL is read from windrow.env when the environment does not\n'
    + '  set it, so running with no override points this at whatever that file configures — which\n'
    + '  on a set-up machine is production.\n\n'
    + '  If you have read server/central/smokeGuard.js and genuinely mean it:\n'
    + '    WINDROW_SMOKE_TRUNCATE_ANYWAY=1'
  );
}

module.exports = { assertSafeToTruncate };
