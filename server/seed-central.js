'use strict';

// `npm run seed:central` — the phase-4 counterpart to `npm run seed`, and gap #2 of
// docs/design/setup-after-central.md §4.
//
// WHY A SECOND SEEDER EXISTS AT ALL. ./seed.js ends in `store.save(db)`, and `save` is one of the
// mutators ../server/store.js wraps in `guardPolicyWrite`. On a node with
// WINDROW_POLICY_AUTHORITY=central that throws PolicyReadOnlyError — correctly, because a
// capability written locally is a row no delta could ever correct, and the node is a read replica
// now. The consequence the audit measured is that under phase 4 *nothing* seeds the catalog:
// central comes up with an empty `capabilities` table, so there is no capability for any node to be
// granted anything against, and the first thing an operator meets is a fleet where every call is
// denied for a reason that looks like a bug.
//
// IDEMPOTENCE IS THE FEATURE, not a nicety, and it is enforced against the database rather than
// against a flag file. Central is the single writer for policy and `policy_changes` is a promise to
// every replica — a version, once handed out, is never handed out again — so a seeder that
// re-upserted unchanged rows would append a change row per capability per run, and every node in
// the fleet would pull, diff and materialise a delta that changes nothing. Run this twice and the
// second run writes zero rows and bumps the version by zero. That is checked by matching on
// `(kind, name)` — the pair the unique index is on, and the only identity available, since central
// mints the ids and the catalog has none to offer (see ./starterCatalog.js).
//
// SEED CREATES; IT NEVER RETIERS. An existing capability is left exactly as it is, including its
// riskTier, for the same reason ../central/policyStore.js's `resolveCapability` only ever creates:
// letting a re-run change a tier would make retiering a capability a race between an admin who
// lowered it on purpose and whoever next ran the seeder. The same rule covers grants — a revoked
// grant is NOT re-issued, because "somebody took this away" is a decision, and a seeder that undid
// it would be a privilege escalation with a cron job's alibi.
//
// USAGE
//   node server/seed-central.js                 seed, printing what it wrote
//   node server/seed-central.js --dry-run       report what it would write, change nothing
//   node server/seed-central.js --json          machine-readable summary (composes with --dry-run)

// ./config first, before anything reads process.env: it is what loads `windrow.env`, and
// WINDROW_CENTRAL_DB_URL is very often in that file rather than in the shell that ran this.
const { assertNoLegacyEnv } = require('./config');

assertNoLegacyEnv();

const store = require('./central/store');
const policy = require('./central/policyStore');
const { CAPABILITIES, ROLES, capRef, grantsForRole } = require('./starterCatalog');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const AS_JSON = argv.includes('--json');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    'seed-central — insert the starter capability catalog into central\'s Postgres.',
    '',
    '  --dry-run   report what would be written; open no transaction',
    '  --json      emit a JSON summary instead of a table',
    '',
    'Reads WINDROW_CENTRAL_DB_URL (or PGHOST/PGDATABASE/…), from the environment or windrow.env.',
    'Safe to run repeatedly: it matches existing rows on (kind, name) and writes only what is missing.',
  ].join('\n'));
  process.exit(0);
}

/** Everything the run did or would do, accumulated so --json and the table are two renderings of
 *  one result rather than two code paths that could disagree about what happened. */
const report = {
  dryRun: DRY_RUN,
  capabilities: { created: [], existing: [] },
  principals: { created: [], existing: [] },
  grants: { created: [], existing: [], skippedRevoked: [] },
  policyVersion: { before: null, after: null },
};

/**
 * Capabilities.
 *
 * Not `resolveCapability`, even though it has exactly these semantics, because it is the *discovery*
 * path — a node proposing a tool it found — and this is a bootstrap. Keeping them apart means the
 * audit trail can still tell "an operator seeded this" from "a machine reported it", which is the
 * distinction §2.2 draws between what central decides and what a node claims.
 */
async function seedCapabilities(driver) {
  const byRef = new Map();
  for (const entry of CAPABILITIES) {
    const ref = capRef(entry.kind, entry.name);
    const existing = await policy.findCapabilityByKindName(driver, entry.kind, entry.name);
    if (existing) {
      byRef.set(ref, existing.id);
      report.capabilities.existing.push(ref);
      continue;
    }
    if (DRY_RUN) {
      // A null id, deliberately: the grant pass below then reports "would grant" without inventing
      // an id that no store handed out. See `resolveGrantTarget`.
      byRef.set(ref, null);
      report.capabilities.created.push(ref);
      continue;
    }
    const created = await policy.insertCapability(driver, {
      kind: entry.kind,
      name: entry.name,
      owner: entry.owner,
      riskTier: entry.riskTier,
      description: entry.description,
      autoGrant: Boolean(entry.autoGrant),
    });
    byRef.set(ref, created.id);
    report.capabilities.created.push(ref);
  }
  return byRef;
}

/**
 * Role principals.
 *
 * `status: 'active'`, not upsertRole's F7 default of 'pending'. These are not a first sighting —
 * an operator ran a seeder — and a pending row would be a full set of grants sitting behind an
 * "awaiting approval" badge nobody put there. Same reasoning as ./seed.js's `claudecode` row.
 */
async function seedPrincipals(driver) {
  const byName = new Map();
  for (const role of ROLES) {
    const existing = await policy.findPrincipalByKindName(driver, 'role', role.name);
    if (existing) {
      byName.set(role.name, existing.id);
      report.principals.existing.push(`role:${role.name}`);
      continue;
    }
    if (DRY_RUN) {
      byName.set(role.name, null);
      report.principals.created.push(`role:${role.name}`);
      continue;
    }
    const created = await policy.insertPrincipal(driver, {
      kind: 'role',
      name: role.name,
      parentRole: role.parentRole || null,
      status: 'active',
    });
    byName.set(role.name, created.id);
    report.principals.created.push(`role:${role.name}`);
  }
  return byName;
}

/**
 * Grants.
 *
 * `findGrant` matches only LIVE rows (`revokedAt IS NULL`), so a revoked grant reads as absent and
 * would be re-issued — which is precisely the escalation described in the header. So the revoked
 * case is looked for explicitly and reported as skipped rather than silently restored: an operator
 * who wants it back should say so, and an operator re-running the seeder after a revocation should
 * be told that is what they nearly did.
 */
async function seedGrants(driver, capIdByRef, principalIdByName) {
  for (const role of ROLES) {
    const principalId = principalIdByName.get(role.name);
    for (const ref of grantsForRole(role.name)) {
      const capabilityId = capIdByRef.get(ref);
      const label = `role:${role.name} -> ${ref}`;
      // Either end missing an id means the row itself is pending creation, which only happens
      // under --dry-run: nothing exists to look a grant up against, and the grant is new too.
      if (!principalId || !capabilityId) {
        report.grants.created.push(label);
        continue;
      }
      const live = await policy.findGrant(driver, principalId, capabilityId);
      if (live) { report.grants.existing.push(label); continue; }
      const revoked = await driver.get(
        'SELECT "id", "revokedAt" FROM grants WHERE "principalId" = $1 AND "capabilityId" = $2 '
          + 'AND "revokedAt" IS NOT NULL ORDER BY "revokedAt" DESC LIMIT 1',
        [principalId, capabilityId]
      );
      if (revoked) {
        report.grants.skippedRevoked.push(`${label} (revoked ${revoked.revokedAt})`);
        continue;
      }
      if (DRY_RUN) { report.grants.created.push(label); continue; }
      await policy.insertGrant(driver, { principalId, capabilityId });
      report.grants.created.push(label);
    }
  }
}

function renderTable() {
  const line = (label, n, extra = '') => console.log(`  ${label.padEnd(24)}${String(n).padStart(5)}${extra}`);
  console.log(DRY_RUN
    ? '\nseed:central --dry-run — nothing was written.\n'
    : '\nseed:central\n');
  line('capabilities created', report.capabilities.created.length);
  line('capabilities present', report.capabilities.existing.length);
  line('principals created', report.principals.created.length);
  line('principals present', report.principals.existing.length);
  line('grants created', report.grants.created.length);
  line('grants present', report.grants.existing.length);
  if (report.grants.skippedRevoked.length) {
    line('grants left revoked', report.grants.skippedRevoked.length, '  <- not re-issued');
    for (const g of report.grants.skippedRevoked) console.log(`      ${g}`);
  }
  // The version is the number the fleet actually replicates against, so it is the honest measure of
  // whether a run did anything — a second run should show the same number on both sides.
  console.log(`\n  policy version ${report.policyVersion.before} -> ${report.policyVersion.after}`);
  if (DRY_RUN && (report.capabilities.created.length || report.principals.created.length || report.grants.created.length)) {
    console.log('\n  Re-run without --dry-run to write them.');
    for (const ref of report.capabilities.created) console.log(`    + capability ${ref}`);
    for (const ref of report.principals.created) console.log(`    + principal  ${ref}`);
  }
  console.log('');
}

/**
 * Get a driver, and under --dry-run get one that has not touched the database.
 *
 * `store.open()` migrates — correctly, since every other way of reaching central's schema goes
 * through the same migrator and a second path would be a second opinion about what version this
 * database is at. But "--dry-run changes nothing" has to mean nothing, and applying five migrations
 * to a fresh Postgres is not nothing. So a dry run opens a bare pool instead and refuses if the
 * policy tables are absent, which is the honest answer: on an unmigrated database there is nothing
 * to report a diff against, and inventing one would report 39 creations against a schema that could
 * not hold them.
 */
let dryRunPool = null;

async function openDriver() {
  if (!DRY_RUN) {
    await store.open();
    return store.requireDriver();
  }
  // eslint-disable-next-line global-require
  const { openPool, pgDriver } = require('./central/pgDriver');
  dryRunPool = openPool();
  const driver = pgDriver(dryRunPool);
  if (!(await driver.ddl.hasTable('policy_changes'))) {
    throw new Error(
      'this database has no policy tables, so there is nothing to diff against. Start '
      + 'server/central/index.js once to migrate it (--dry-run deliberately does not), then re-run.'
    );
  }
  return driver;
}

/** Close whichever connection openDriver opened. */
async function closeDriver() {
  if (dryRunPool) { await dryRunPool.end().catch(() => {}); dryRunPool = null; }
  await store.close().catch(() => {});
}

async function main() {
  const driver = await openDriver();

  report.policyVersion.before = await policy.policyVersion(driver);
  const capIdByRef = await seedCapabilities(driver);
  const principalIdByName = await seedPrincipals(driver);
  await seedGrants(driver, capIdByRef, principalIdByName);
  report.policyVersion.after = DRY_RUN
    ? report.policyVersion.before
    : await policy.policyVersion(driver);

  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  else renderTable();
}

if (require.main === module) {
  main()
    .then(() => closeDriver())
    .catch(async (err) => {
      await closeDriver().catch(() => {});
      // The commonest failure by a wide margin is "run on a node instead of on central", so the
      // message names the variable rather than letting a pg ECONNREFUSED stand as the explanation.
      console.error('[seed:central] failed:', err.message);
      if (/no central database configured/i.test(err.message)) {
        console.error(
          '  This is the CENTRAL host seeder. On a node, run `npm run seed` instead — or set\n'
          + '  WINDROW_CENTRAL_DB_URL (in the environment or in windrow.env) if this IS central.'
        );
      }
      process.exit(1);
    });
}

module.exports = { main };
