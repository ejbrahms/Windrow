// Verification for the policyStore / usageSink seam — docs/design/global-identity-and-central-db.md
// §2.7 phase 2. Run it with: node server/policy/smoke.js
//
// Two passes, because the refactor has two ways to be wrong:
//   1. a member app.js names but the seam does not define — caught statically, before any route runs
//   2. a route whose body no longer does what it did — caught by driving it against a scratch db
//
// The database is a throwaway under the OS temp dir; the live server/data is never touched. The
// auth gates are neutered on purpose: what is under test is the route bodies after the rewrite,
// not the mTLS admission in front of them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-seam-'));
process.env.WINDROW_DB_PATH = process.env.SMOKE_DB || path.join(SCRATCH, 'windrow.db');
const http = require('http');

// --- pass 1: every seam member app.js references actually exists ------------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const seam = require('./index');
let staticBad = 0;
const members = (re) => [...new Set([...appSrc.matchAll(re)].map((m) => m[1]))].sort();
for (const [name, obj, re] of [
  ['policyStore', seam.policyStore, /policyStore\.([A-Za-z_][A-Za-z0-9_]*)/g],
  ['usageSink', seam.usageSink, /usageSink\.([A-Za-z_][A-Za-z0-9_]*)/g],
]) {
  const used = members(re);
  const missing = used.filter((k) => obj[k] === undefined);
  const unused = Object.keys(obj).filter((k) => !used.includes(k));
  console.log(`${missing.length ? 'FAIL' : 'ok  '} ${name}: ${used.length} members referenced by app.js, all defined`);
  if (missing.length) { console.log('     MISSING: ' + missing.join(', ')); staticBad++; }
  if (unused.length) console.log('     declared but unused by app.js: ' + unused.join(', '));
}
// Nothing policy- or usage-shaped may still be reaching around the seam to the raw store handle.
const rawStore = members(/(?<![A-Za-z])store\.([A-Za-z_][A-Za-z0-9_]*)/g).filter((k) => k !== 'js');
// One name matches the policy-shaped pattern below and is deliberately NOT a leak:
// setCapabilityDiscoveryState writes source/discoveredAt/lastSeenAt/stale/realUsage — the
// MACHINE-LOCAL half of a capability row (docs/design/global-identity-and-central-db.md §2.2,
// "filesystem paths are machine-local by nature"). Central holds no opinion about those columns and
// a replica node must keep writing them, so routing them through the seam would be wrong rather
// than tidy. Named here so the carve-out is a decision on the record instead of a loosened regex.
const NODE_LOCAL_ON_A_CAPABILITY = new Set(['setCapabilityDiscoveryState']);
const leaked = rawStore
  .filter((k) => !NODE_LOCAL_ON_A_CAPABILITY.has(k))
  .filter((k) => /Grant|Capabilit|Principal|Approval|UsageEvent|AuditEntr|NativeTool|ChainHead|nodeId/.test(k));
console.log(`${leaked.length ? 'FAIL' : 'ok  '} raw store.* left in app.js (node-local only): ${rawStore.join(', ')}`);
if (leaked.length) { console.log('     LEAKED: ' + leaked.join(', ')); staticBad++; }

// --- pass 2: drive the routes ----------------------------------------------
const auth = require('../auth.js');
auth.requireAdmin = (req, res, next) => next();
auth.requireProposer = (req, res, next) => next();
const app = require('../app.js');
const T = auth.AGENT_TOKEN;

const srv = http.createServer(app).listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const call = (method, p, body) =>
    new Promise((res) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: {
            Authorization: `Bearer ${T}`,
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (r) => {
          let b = '';
          r.on('data', (c) => (b += c));
          r.on('end', () => res({ status: r.statusCode, body: b }));
        }
      );
      req.on('error', (e) => res({ status: 'ERR', body: String(e) }));
      if (data) req.write(data);
      req.end();
    });

  let bad = staticBad;
  const check = (label, ok, extra = '') => {
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' :: ' + String(extra).slice(0, 170) : ''}`);
  };

  // --- reads ---------------------------------------------------------------
  for (const g of [
    '/api/capabilities', '/api/principals', '/api/principals/owner-proposals', '/api/grants',
    '/api/approvals', '/api/audit', '/api/usage', '/api/usage/summary', '/api/usage/verify',
    '/api/native-calls', '/api/native-calls/summary', '/api/native-calls/timeseries',
    '/api/drift', '/api/shadow-divergence',
    '/api/discovery/sources', '/api/hook-integrity',
  ]) {
    const r = await call('GET', g);
    check(`GET ${g} -> ${r.status}`, r.status === 200, r.status === 200 ? '' : r.body);
  }

  // --- capabilities --------------------------------------------------------
  // `mutating`, so the read_only auto-grant baseline a new principal gets does not pre-create the
  // grant this script goes on to issue by hand.
  const cap = await call('POST', '/api/capabilities', { kind: 'mcp_tool', name: 'smoke_tool', description: 'smoke', riskTier: 'mutating', owner: 'smoke' });
  check(`POST /api/capabilities -> ${cap.status}`, cap.status === 201, cap.status === 201 ? '' : cap.body);
  const capId = cap.status === 201 ? JSON.parse(cap.body).id : null;
  const dupCap = await call('POST', '/api/capabilities', { kind: 'mcp_tool', name: 'smoke_tool', description: 'x', riskTier: 'mutating', owner: 'smoke' });
  check('POST /api/capabilities dup -> 409 (policyStore.CapabilityConflictError instanceof)', dupCap.status === 409, dupCap.body);
  const auto = await call('PATCH', `/api/capabilities/${capId}/auto-grant`, { autoGrant: false });
  check(`PATCH auto-grant -> ${auto.status} (policyStore.setCapabilityAutoGrant)`, auto.status === 200, auto.body);

  // --- principals ----------------------------------------------------------
  const pr = await call('POST', '/api/principals', { kind: 'role', name: 'smoke_role', description: 'smoke' });
  check(`POST /api/principals (role) -> ${pr.status}`, pr.status === 201, pr.status === 201 ? '' : pr.body);
  const prId = pr.status === 201 ? JSON.parse(pr.body).id : null;

  // principals(kind, name) is UNIQUE for role/instance (migration 16, §2.1) — same shape as the
  // capabilities check above, and for the same reason: these are the kinds the hook path resolves
  // by (kind, name), so two rows would let scan order pick which one's grants govern a call.
  const dupRole = await call('POST', '/api/principals', { kind: 'role', name: 'smoke_role' });
  check('POST /api/principals dup role -> 409 (policyStore.PrincipalConflictError instanceof)', dupRole.status === 409, dupRole.body);

  const user = await call('POST', '/api/principals', { kind: 'user', name: 'Smoke User', subjectId: 'env-user:smoke@smokehost' });
  check(`POST /api/principals (user) -> ${user.status} (policyStore.findPrincipalBySubjectId)`, user.status === 201, user.body);
  const userId = user.status === 201 ? JSON.parse(user.body).id : null;

  // The constraint is partial on purpose: a `user` row is keyed on subjectId, its name is a label,
  // and two subjects legitimately share one — the env-user fallback lands beside a win-sid row with
  // the same OS username. A full UNIQUE(kind, name) would refuse this 201.
  const userDupLabel = await call('POST', '/api/principals', { kind: 'user', name: 'Smoke User', subjectId: 'win-sid:S-1-5-21-smoke' });
  check(`POST /api/principals (second user, same label) -> ${userDupLabel.status} (name is a label, not a key)`, userDupLabel.status === 201, userDupLabel.body);

  const rename = await call('PATCH', `/api/principals/${userId}/name`, { name: 'Smoke User Renamed' });
  check(`PATCH /api/principals/:id/name -> ${rename.status} (policyStore.setPrincipalName)`, rename.status === 200, rename.body);
  // owner / approve / deny only apply to an *instance* principal, and only while it is pending —
  // so the subject is the instance /resolve just minted, not the hand-registered role above.
  const resolve = await call('POST', '/api/principals/resolve', { loomId: 'smoke-loom-1', agentType: 'claude', humanName: 'Smoke', backend: 'claude', field: 'smoke' });
  check(`POST /api/principals/resolve -> ${resolve.status} (policyStore.upsertPrincipalIdentity)`, resolve.status === 200 || resolve.status === 201, resolve.status < 300 ? '' : resolve.body);
  const instanceId = resolve.status < 300 ? JSON.parse(resolve.body).instance?.id : null;
  check('resolve returned an instance principal', !!instanceId, resolve.body);

  const owner = await call('POST', `/api/principals/${instanceId}/owner`, { ownerPrincipalId: userId, osUser: 'smoke', reason: 'smoke' });
  check(`POST /api/principals/:id/owner -> ${owner.status} (policyStore.setPrincipalOwner)`, owner.status === 200, owner.body);
  // A newly-sighted ROLE lands `pending` with no grants (server/principals/registry.js) — that is
  // the row approve/deny are for, and the one that exercises policyStore.setPrincipalStatus.
  const roleId = resolve.status < 300 ? JSON.parse(resolve.body).role?.id : null;
  const deny = await call('POST', `/api/principals/${roleId}/deny`, { reason: 'smoke' });
  check(`POST /api/principals/:id/deny -> ${deny.status} (policyStore.setPrincipalStatus)`, deny.status === 200, deny.body);
  // Approve needs its own pending row — the one above is now denied — so sight a second role.
  const resolve2 = await call('POST', '/api/principals/resolve', { loomId: 'smoke-loom-2', agentType: 'codex', humanName: 'Smoke2', backend: 'codex', field: 'smoke' });
  const roleId2 = resolve2.status < 300 ? JSON.parse(resolve2.body).role?.id : null;
  const approve = await call('POST', `/api/principals/${roleId2}/approve`, {});
  check(`POST /api/principals/:id/approve -> ${approve.status} (policyStore.setPrincipalStatus + read_only baseline)`, approve.status === 200, approve.body);

  // --- grants --------------------------------------------------------------
  const gr = await call('POST', '/api/grants', { principalId: prId, capabilityId: capId, reason: 'smoke' });
  check(`POST /api/grants -> ${gr.status}`, gr.status === 201, gr.status === 201 ? '' : gr.body);
  const grantId = gr.status === 201 ? JSON.parse(gr.body).id : null;
  const dup = await call('POST', '/api/grants', { principalId: prId, capabilityId: capId });
  check('POST /api/grants dup -> 409 (policyStore.GrantConflictError instanceof)', dup.status === 409, dup.body);

  // --- invoke + usage ------------------------------------------------------
  const inv = await call('POST', '/api/invoke', { principalId: prId, capabilityId: capId, decisionLatencyMs: 1 });
  check(`POST /api/invoke -> ${inv.status}`, inv.status === 200, inv.status === 200 ? '' : inv.body);
  const eventId = inv.status === 200 ? JSON.parse(inv.body).event?.id : null;
  check('invoke returned an event id', !!eventId, inv.body);
  if (eventId) {
    const patched = await call('PATCH', `/api/usage/${eventId}`, { principalId: prId, outcome: 'ok', latencyMs: 12 });
    check(`PATCH /api/usage/:id -> ${patched.status} (usageSink.patchUsageEvent)`, patched.status === 200, patched.body);
  }

  const usage = JSON.parse((await call('GET', '/api/usage')).body);
  check(`usage event landed via usageSink.recordUsageEvent (${usage.length})`, usage.length > 0);
  const auditRows = JSON.parse((await call('GET', '/api/audit')).body);
  check(`audit rows via usageSink.recordAuditEntry (${auditRows.length})`, auditRows.length > 0);

  const verify = JSON.parse((await call('GET', '/api/usage/verify')).body);
  check(`GET /api/usage/verify ok=${verify.ok} nodeId=${!!verify.nodeId} (usageSink.nodeId/listChainHeads/verify)`, verify.ok === true && !!verify.nodeId, JSON.stringify(verify).slice(0, 200));
  const summary = JSON.parse((await call('GET', '/api/usage/summary')).body);
  check(`GET /api/usage/summary calls=${summary.totals?.calls}`, summary.totals?.calls > 0);

  // --- approvals -----------------------------------------------------------
  const propDup = await call('POST', '/api/grants/propose', { principalId: prId, capabilityId: capId, reason: 'already granted' });
  check(`POST /api/grants/propose (already granted -> 409) -> ${propDup.status}`, propDup.status === 409, propDup.body);
  const revokeProp = await call('POST', `/api/grants/${grantId}/propose-revoke`, { reason: 'smoke' });
  check(`POST /api/grants/:id/propose-revoke -> ${revokeProp.status} (policyStore.insertApproval)`, revokeProp.status === 202, revokeProp.body);
  const approvalId = revokeProp.status === 202 ? JSON.parse(revokeProp.body).approval.id : null;
  if (approvalId) {
    const decided = await call('POST', `/api/approvals/${approvalId}/approve`, {});
    check(`POST /api/approvals/:id/approve (revoke path) -> ${decided.status} (policyStore.decideApproval + revokeGrant)`, decided.status === 200, decided.body);
  }
  const grantProp = await call('POST', '/api/grants/propose', { principalId: prId, capabilityId: capId, reason: 'smoke re-grant' });
  check(`POST /api/grants/propose (now revoked -> 202) -> ${grantProp.status}`, grantProp.status === 202, grantProp.body);
  const grantPropId = grantProp.status === 202 ? JSON.parse(grantProp.body).approval.id : null;
  if (grantPropId) {
    const denied = await call('POST', `/api/approvals/${grantPropId}/deny`, { reason: 'smoke' });
    check(`POST /api/approvals/:id/deny -> ${denied.status}`, denied.status === 200, denied.body);
  }

  // --- direct revoke -------------------------------------------------------
  const gr2 = await call('POST', '/api/grants', { principalId: prId, capabilityId: capId, reason: 'smoke 2' });
  check(`POST /api/grants (re-issue) -> ${gr2.status}`, gr2.status === 201, gr2.status === 201 ? '' : gr2.body);
  if (gr2.status === 201) {
    const del = await call('DELETE', `/api/grants/${JSON.parse(gr2.body).id}`);
    check(`DELETE /api/grants/:id -> ${del.status} (policyStore.revokeGrant)`, del.status === 204, del.body);
  }

  console.log(bad === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${bad})`);
  srv.close();
  // Best-effort: SQLite still holds the file handle on Windows, and a leftover temp directory is
  // not worth failing an otherwise-green run over.
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* temp dir, let the OS have it */ }
  process.exit(bad === 0 ? 0 : 1);
});
