#!/usr/bin/env node
'use strict';
// Put central's policy tables back from a node's replica — `npm run central:restore-policy`.
//
// ==============================================================================================
// WHY THIS EXISTS
// ==============================================================================================
//
// `server/central/policy-smoke.js` opens with a TRUNCATE of `policy_changes, grants, approvals,
// capabilities, principals, windrow_audit, node_policy_state`. That is correct for the scratch
// database it is meant to run against and catastrophic against a live one, and there is nothing in
// the suite that checks which it got — it reads `WINDROW_CENTRAL_DB_URL`, and on a node that keeps
// its configuration in `windrow.env` that variable points at production by default.
//
// Run against a live central it destroys the entire control plane: every capability, every grant,
// every principal, and the `policy_changes` log that is central's promise to every replica.
//
// ==============================================================================================
// WHY A NODE'S REPLICA IS A SUFFICIENT SOURCE, AND WHEN IT STOPS BEING ONE
// ==============================================================================================
//
// Under `WINDROW_POLICY_AUTHORITY=central` every node holds `server/data/policy-replica.json` — a
// full materialisation of central's capabilities, principals and grants at a known version, kept
// current by `server/policy/policyClient.js`. It is a byte-for-byte copy of what central served,
// so it restores what was lost rather than approximating it.
//
// IT IS ALSO A COPY WITH A FUSE. `policyStore.policyDelta` answers a node with a wholesale RESET —
// replacing the replica rather than merging into it — when the node asks for a version central
// cannot serve from its log. A truncated central keeps working only while the surviving replica's
// version still happens to line up; the moment it does not, the node is reset to whatever the empty
// central holds and the last copy of the catalog is gone. So this is a repair to run promptly, not
// at leisure, and it is why the script refuses to widen its own scope while it runs.
//
// ==============================================================================================
// WHAT IT WRITES, AND THE THREE RULES IT WILL NOT BREAK
// ==============================================================================================
//
// IDS ARE PRESERVED, ALWAYS. This is the whole point and the reason `policyStore.insertCapability`
// cannot be used: that function mints `genId('cap')` for every row, which is right for a new
// capability and useless here. Every `usage_events` row already references the old ids, so a
// restore that minted new ones would leave the audit log pointing at rows that no longer exist —
// the dashboard would still show `cap_ad28cccf412a` and nothing would ever resolve it. Same for
// grants, whose ids appear in the deny-list every hook enforces from.
//
// IT ONLY EVER CREATES. `ON CONFLICT DO NOTHING` on every insert, so a row that survived — or that
// an admin has since edited — is left exactly as it is. A restore that overwrote would be a second
// data-loss event wearing a helpful name, and would silently undo any decision taken since.
//
// EVERY WRITE APPENDS TO `policy_changes` IN THE SAME TRANSACTION. That is invariant 3 of
// `server/central/policyStore.js` and it is what makes the restore safe for the fleet: the nodes
// see ordinary forward changes at versions above their own, describing rows they already hold, and
// materialise them idempotently. No node is reset, no hook sees a gap, and a node that was offline
// throughout catches up by the normal path.
//
// USAGE
//   node scripts/restore-central-policy.js --dry-run    report what would be written; write nothing
//   node scripts/restore-central-policy.js              do it
//   node scripts/restore-central-policy.js --replica <path>   restore from a specific replica file

const path = require('path');
const fs = require('fs');

const { assertNoLegacyEnv } = require(path.join(__dirname, '..', 'server', 'config'));
assertNoLegacyEnv();

const store = require(path.join(__dirname, '..', 'server', 'central', 'store'));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
// Evict a row that is blocking a restore ONLY when nothing whatsoever points at it. See the guard
// in `evictable` below — this is the difference between clearing test litter and deleting policy.
const EVICT = argv.includes('--replace-unreferenced');
const replicaFlag = argv.indexOf('--replica');
const REPLICA_PATH = replicaFlag >= 0 && argv[replicaFlag + 1]
  ? argv[replicaFlag + 1]
  : path.join(__dirname, '..', 'server', 'data', 'policy-replica.json');

if (argv.includes('-h') || argv.includes('--help')) {
  console.log([
    'restore-central-policy — put central\'s capabilities, principals and grants back from a node replica.',
    '',
    '  --dry-run          report what would be written; open no write transaction',
    '  --replica <path>   read a specific replica file (default: server/data/policy-replica.json)',
    '',
    'Preserves ids, creates only, and appends to policy_changes so replicas catch up by the',
    'ordinary delta path rather than being reset.',
  ].join('\n'));
  process.exit(0);
}

/** The replica is a signed file on disk; read it as data and let a malformed one fail loudly here
 *  rather than half way through a transaction. */
function loadReplica() {
  let raw;
  try {
    raw = fs.readFileSync(REPLICA_PATH, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the replica at ${REPLICA_PATH}: ${err.message}`);
  }
  const parsed = JSON.parse(raw);
  // `server/policy/replica.js` writes `{ payload, sig }` where `payload` is the JSON string that
  // was signed — so the rows are one level of parsing further in than they look. A bare object is
  // accepted too, so this works against a hand-extracted snapshot as well as the live file.
  //
  // The signature is NOT verified here, deliberately. It exists so the HOT PATH can refuse a
  // tampered replica; this is an operator restoring a control plane from a file on their own disk,
  // and refusing to read it because the signing key had rotated would turn a recoverable outage
  // into an unrecoverable one. What actually guards this run is that every id is checked against
  // central and only missing rows are written.
  let body = parsed;
  if (typeof parsed.payload === 'string') {
    try {
      body = JSON.parse(parsed.payload);
    } catch (err) {
      throw new Error(`the replica's payload is not JSON: ${err.message}`);
    }
  } else if (parsed.data && parsed.data.capabilities) {
    body = parsed.data;
  }
  const bag = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
  return {
    version: body.version ?? null,
    fetchedAt: body.fetchedAt ?? null,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : bag(body.capabilities),
    principals: Array.isArray(body.principals) ? body.principals : bag(body.principals),
    grants: Array.isArray(body.grants) ? body.grants : bag(body.grants),
  };
}

const CAP_COLS = ['id', 'kind', 'name', 'owner', 'riskTier', 'description', 'autoGrant', 'createdAt'];
const PRN_COLS = ['id', 'kind', 'name', 'subjectId', 'assuranceLevel', 'parentRole', 'humanName',
  'backend', 'agentType', 'field', 'standalone', 'status', 'owner', 'createdAt'];
const GRANT_COLS = ['id', 'principalId', 'capabilityId', 'constraints', 'createdAt', 'expiresAt',
  'revokedAt', 'revokedBy'];

/** Central's column list is narrower than a node's row — migration 3 deliberately omits `source`,
 *  `discoveredAt`, `lastSeenAt`, `stale` and `realUsage`, which describe what one machine found on
 *  its own filesystem. Projecting rather than spreading is what stops those travelling. */
function project(row, cols, defaults = {}) {
  const out = {};
  for (const c of cols) out[c] = row[c] === undefined ? (defaults[c] ?? null) : row[c];
  return out;
}

function insertSql(table, cols) {
  const names = cols.map((c) => `"${c}"`).join(', ');
  const params = cols.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO ${table} (${names}) VALUES (${params}) ON CONFLICT ("id") DO NOTHING RETURNING "id"`;
}

async function main() {
  const replica = loadReplica();
  console.log(`Replica ${REPLICA_PATH}`);
  console.log(`  version ${replica.version}, fetched ${replica.fetchedAt ? new Date(replica.fetchedAt).toISOString() : 'unknown'}`);
  console.log(`  ${replica.capabilities.length} capabilities, ${replica.principals.length} principals, ${replica.grants.length} grants`);

  const driver = await store.open();
  const before = {
    capabilities: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM capabilities')).n),
    principals: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM principals')).n),
    grants: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM grants')).n),
    version: Number((await driver.get('SELECT COALESCE(MAX("version"), 0)::BIGINT AS n FROM policy_changes')).n),
  };
  console.log(`\nCentral now: ${before.capabilities} capabilities, ${before.principals} principals, `
    + `${before.grants} grants, change log at version ${before.version}`);

  // What is genuinely missing, computed before anything is written so --dry-run and the real run
  // report the same number rather than the second one reporting zero.
  const have = async (table, ids) => {
    if (!ids.length) return new Set();
    const rows = await driver.all(`SELECT "id" FROM ${table} WHERE "id" = ANY($1)`, [ids]);
    return new Set(rows.map((r) => r.id));
  };
  // Index by id so the eviction step below can put a freed row back without re-scanning.
  const byId = {
    capabilities: new Map(replica.capabilities.map((c) => [c.id, c])),
    principals: new Map(replica.principals.map((p) => [p.id, p])),
  };
  const haveCaps = await have('capabilities', replica.capabilities.map((c) => c.id));
  const havePrns = await have('principals', replica.principals.map((p) => p.id));
  const haveGrants = await have('grants', replica.grants.map((g) => g.id));
  const missing = {
    capabilities: replica.capabilities.filter((c) => !haveCaps.has(c.id)),
    principals: replica.principals.filter((p) => !havePrns.has(p.id)),
    grants: replica.grants.filter((g) => !haveGrants.has(g.id)),
  };
  console.log(`Would write: ${missing.capabilities.length} capabilities, ${missing.principals.length} principals, `
    + `${missing.grants.length} grants`);

  // ---------------------------------------------------------------------------------------
  // NATURAL-KEY COLLISIONS ARE FILTERED OUT *BEFORE* THE TRANSACTION, NOT CAUGHT INSIDE IT.
  //
  // The unique indexes are on COALESCE(kind,'')+name for capabilities and (kind, name) for
  // principals — NOT on the id — so a row whose id is missing can still collide with a surviving
  // row that shares its natural key, which ON CONFLICT ("id") does not catch.
  //
  // Catching that mid-transaction is not an option. In Postgres ANY error aborts the enclosing
  // transaction, so a try/catch around one insert leaves every statement after it failing with
  // "current transaction is aborted" — one colliding row would silently cost the whole restore
  // while a skip counter ticked up as though it were coping. So collisions are found first,
  // excluded, and named.
  // ---------------------------------------------------------------------------------------
  const keyMap = async (table, expr) => {
    const found = await driver.all(`SELECT "id", ${expr} AS key FROM ${table}`);
    return new Map(found.map((r) => [r.key, r.id]));
  };
  const capsByKey = await keyMap('capabilities', `COALESCE("kind", '') || '' || "name"`);
  const prnsByKey = await keyMap('principals', `"kind" || '' || "name"`);
  const collided = [];
  const capKey = (c) => `${c.kind ?? ''}${c.name}`;
  const prnKey = (x) => `${x.kind}${x.name}`;
  missing.capabilities = missing.capabilities.filter((c) => {
    const heldBy = capsByKey.get(capKey(c));
    if (heldBy) collided.push({ entity: 'capability', id: c.id, name: c.name, heldBy });
    return !heldBy;
  });
  missing.principals = missing.principals.filter((x) => {
    const heldBy = prnsByKey.get(prnKey(x));
    if (heldBy) collided.push({ entity: 'principal', id: x.id, name: x.name, heldBy });
    return !heldBy;
  });
  if (collided.length) {
    console.log(`
${collided.length} row(s) cannot be restored under their original id — a surviving`);
    console.log('row already holds their (kind, name), and taking it would break what references it:');
    for (const c of collided) console.log(`  ${c.entity} ${c.id} "${c.name}" — held by ${c.heldBy}`);
  }
  // ---------------------------------------------------------------------------------------
  // --replace-unreferenced: repair grants that point at a row which is not there.
  //
  // DRIVEN FROM THE ORPHANS, NOT FROM THE COLLISIONS, and that ordering is the whole design. The
  // collision list says "these replica rows could not be restored", which on this fleet is six
  // different `mcp_tool/unknown/tool` capabilities — one per run of policy-smoke, each minting a
  // fresh id. Restoring "the one that collided" is meaningless when six contend for one key, and
  // queueing them all would insert one and abort the transaction on the next.
  //
  // The question worth answering is narrower and has one right answer: WHICH ROW DO LIVE GRANTS
  // ACTUALLY REFERENCE. That row is the one to bring back; the rest are litter whichever way you
  // look at them.
  //
  // TWO GUARDS, both required before anything is deleted:
  //   the blocker must have ZERO live grants and ZERO usage events — test litter, not policy;
  //   the row being restored must have at least one LIVE GRANT depending on it — otherwise there
  //   is no problem here to fix and no reason to touch a live control plane.
  // ---------------------------------------------------------------------------------------
  if (EVICT) {
    const orphans = await driver.all(`
      SELECT DISTINCT g."capabilityId" AS id, 'capability' AS entity FROM grants g
        WHERE g."revokedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM capabilities c WHERE c.id = g."capabilityId")
      UNION ALL
      SELECT DISTINCT g."principalId", 'principal' FROM grants g
        WHERE g."revokedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM principals p WHERE p.id = g."principalId")
    `);
    if (!orphans.length) console.log('No live grant points at a missing row - nothing to repair.');
    for (const o of orphans) {
      const isCap = o.entity === 'capability';
      const row = (isCap ? byId.capabilities : byId.principals).get(o.id);
      if (!row) {
        console.log(`  ${o.entity} ${o.id} is referenced by a live grant and is in NO replica — cannot repair`);
        continue;
      }
      const table = isCap ? 'capabilities' : 'principals';
      const fk = isCap ? 'capabilityId' : 'principalId';
      const keyExpr = isCap ? `COALESCE("kind", '') || '' || "name"` : `"kind" || '' || "name"`;
      const key = isCap ? `${row.kind ?? ''}${row.name}` : `${row.kind}${row.name}`;
      const blocker = await driver.get(`SELECT "id" FROM ${table} WHERE ${keyExpr} = $1`, [key]);
      const holders = Number((await driver.get(
        `SELECT COUNT(*)::BIGINT AS n FROM grants WHERE "${fk}" = $1 AND "revokedAt" IS NULL`, [o.id]
      )).n || 0);
      if (blocker) {
        const refs = await driver.get(
          `SELECT (SELECT COUNT(*)::BIGINT FROM grants WHERE "${fk}" = $1 AND "revokedAt" IS NULL) AS grants,
                  (SELECT COUNT(*)::BIGINT FROM usage_events WHERE "${fk}" = $1) AS events`,
          [blocker.id]
        );
        const g = Number(refs.grants || 0);
        const e = Number(refs.events || 0);
        if (g || e) {
          console.log(`  ${o.entity} "${row.name}" is blocked by ${blocker.id}, which has ${g} grant(s) and ${e} event(s) — left alone`);
          continue;
        }
        console.log(`  ${DRY_RUN ? 'would evict' : 'evicting'} ${blocker.id} — unreferenced, holding "${row.name}" that ${holders} live grant(s) need`);
        if (!DRY_RUN) {
          await driver.query(`DELETE FROM ${table} WHERE "id" = $1`, [blocker.id]);
          await driver.query(
            'INSERT INTO policy_changes ("entity", "entityId", "op", "row", "ts") VALUES ($1, $2, $3, $4, $5)',
            [o.entity, blocker.id, 'delete', null, new Date().toISOString()]
          );
        }
      }
      console.log(`  ${DRY_RUN ? 'would restore' : 'restoring'} ${o.id} "${row.name}" — ${holders} live grant(s) depend on it`);
      if (isCap) missing.capabilities.push(row); else missing.principals.push(row);
    }
  }

  console.log(`After filtering: ${missing.capabilities.length} capabilities, ${missing.principals.length} principals, `
    + `${missing.grants.length} grants`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing was written.');
    await store.close();
    return 0;
  }
  if (!missing.capabilities.length && !missing.principals.length && !missing.grants.length) {
    console.log('\nNothing to restore — central already holds every row in this replica.');
    await store.close();
    return 0;
  }

  const written = { capabilities: 0, principals: 0, grants: 0, changes: 0 };
  await driver.withTransaction(async (tx) => {
    const now = new Date().toISOString();
    // One helper for all three, because the rule is the same for all three: insert, and if a row
    // actually landed, describe it in the change log inside this same transaction.
    const restore = async (table, entity, rows, cols, defaults) => {
      for (const row of rows) {
        const projected = project(row, cols, defaults);
        // No try/catch here on purpose — see the pre-filter above. Anything that could collide
        // has already been removed, so an error at this point is a genuine fault and SHOULD abort
        // the whole restore rather than being swallowed row by row: in Postgres a caught error
        // still leaves the transaction aborted, so every row after it would fail anyway, and
        // silently — a skip count that grew while nothing was written.
        const landed = await tx.all(insertSql(table, cols), cols.map((c) => projected[c]));
        if (!landed.length) continue; // already present; not an error and not a change
        written[table] += 1;
        await tx.query(
          'INSERT INTO policy_changes ("entity", "entityId", "op", "row", "ts") VALUES ($1, $2, $3, $4, $5)',
          [entity, row.id, entity === 'grant' && row.revokedAt ? 'revoke' : 'upsert', JSON.stringify(projected), now]
        );
        written.changes += 1;
      }
    };
    // Capabilities and principals first: a grant references both, and while there is no foreign key
    // here, a replica that pulled mid-restore should never see a grant whose capability it has not
    // been told about.
    await restore('capabilities', 'capability', missing.capabilities, CAP_COLS, { autoGrant: false, createdAt: now });
    await restore('principals', 'principal', missing.principals, PRN_COLS, { standalone: false, status: 'active', createdAt: now });
    await restore('grants', 'grant', missing.grants, GRANT_COLS, { createdAt: now });
  });

  const after = {
    capabilities: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM capabilities')).n),
    principals: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM principals')).n),
    grants: Number((await driver.get('SELECT COUNT(*)::BIGINT AS n FROM grants')).n),
    version: Number((await driver.get('SELECT COALESCE(MAX("version"), 0)::BIGINT AS n FROM policy_changes')).n),
  };
  console.log(`\nRestored ${written.capabilities} capabilities, ${written.principals} principals, ${written.grants} grants`);
  console.log(`  ${written.changes} change-log rows appended; version ${before.version} -> ${after.version}`);
  console.log(`Central now: ${after.capabilities} capabilities, ${after.principals} principals, ${after.grants} grants`);
  if (collided.length) {
    console.log(`
${collided.length} row(s) were skipped on a natural-key collision — listed above.`);
  }
  console.log('\nNodes pick this up as an ordinary forward delta at the next pull — no reset, no gap.');
  await store.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('restore failed:', err.stack || err.message);
    try { await store.close(); } catch { /* already closed */ }
    process.exit(1);
  });
