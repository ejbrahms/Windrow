'use strict';

// `node scripts/cleanup-skill-grants.js [--dry-run]` — a one-off maintenance script that REVOKES
// every live grant pointing at a `skill` capability in central's store.
//
// WHY IT EXISTS. Skills are catalog-only (docs/design/skill-mcp-governance.md §0): a skill has no
// PreToolUse choke point, so a grant against one enforces nothing. Earlier seeders and the
// read-only baselines nonetheless issued them, so an established central accumulated skill grants
// that govern nothing and only make the Grants page imply a control that does not exist. The
// seeders, baselines, server guards and UI were fixed so no new skill grant can be created; this
// removes the ones already in the database.
//
// SOFT DELETE, NOT A ROW DROP — it calls policyStore.revokeGrant, the same write the dashboard's
// revoke button makes. So each removal appends to `policy_changes` and rides the deny-list every
// node fetches in full, which is what makes it land fleet-wide rather than only on central. The
// skill capability rows themselves are LEFT ALONE: they stay catalogued (discoverable), which is
// exactly what §0 asks for.
//
// SAFE TO RE-RUN: it only touches grants whose capability is a skill and that are still live, so a
// second run finds nothing to do. Pass --dry-run to list what it WOULD revoke without writing.
//
//   DATABASE_URL='postgres://windrow:windrow@localhost:5432/windrow_central' \
//     node scripts/cleanup-skill-grants.js --dry-run
//
// Defaults DATABASE_URL to the local central-db compose credentials, like scripts/demo-local.js.

if (!process.env.DATABASE_URL && !process.env.WINDROW_CENTRAL_DB_URL) {
  process.env.DATABASE_URL = 'postgres://windrow:windrow@localhost:5432/windrow_central';
}

const store = require('../server/central/store');
const policy = require('../server/central/policyStore');

const DRY_RUN = process.argv.includes('--dry-run');
const REASON = 'skills are catalog-only (docs/design/skill-mcp-governance.md §0) — grant governed nothing; removed in the §0 alignment';

async function main() {
  // migrate:false — this is maintenance against an already-provisioned store, not a schema change.
  await store.open(undefined, { migrate: false });
  const driver = store.requireDriver();

  const before = await policy.policyVersion(driver);

  // Live grants whose capability is a skill. Joined in SQL rather than filtered in JS so the set is
  // exactly what will be revoked, with the capability name to log.
  const rows = await driver.all(
    `SELECT g."id" AS "grantId", g."principalId", c."id" AS "capabilityId", c."name" AS "capabilityName"
       FROM grants g
       JOIN capabilities c ON c."id" = g."capabilityId"
      WHERE g."revokedAt" IS NULL AND c."kind" = 'skill'
      ORDER BY c."name"`
  );

  console.log(`${rows.length} live skill grant(s) found${DRY_RUN ? ' (dry run — nothing will be written)' : ''}.`);
  if (rows.length === 0) {
    await store.close();
    return;
  }

  if (DRY_RUN) {
    for (const r of rows) console.log(`  would revoke ${r.grantId}  ${r.capabilityName}  (principal ${r.principalId})`);
    await store.close();
    return;
  }

  let revoked = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const gone = await policy.revokeGrant(driver, r.grantId, 'admin');
    if (gone) revoked += 1;
  }

  // One audit entry for the whole sweep rather than 114 — the individual revokes are already in
  // policy_changes; this records that a person ran the cleanup and why.
  await policy.recordAuditEntry(driver, {
    action: 'skill_grants_purged',
    actorScope: 'admin',
    reason: `${REASON} — revoked ${revoked} grant(s)`,
  });

  const after = await policy.policyVersion(driver);
  console.log(`Revoked ${revoked} skill grant(s). Policy version ${before} -> ${after}.`);
  console.log('Skill capability rows were left in the catalog (catalog-only, discoverable).');
  await store.close();
}

main().catch((err) => {
  console.error('[cleanup-skill-grants] failed:', err.stack || err.message);
  process.exit(1);
});
