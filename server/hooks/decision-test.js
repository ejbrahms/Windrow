// Verification for the PreToolUse decision path — server/hooks/lib.js `runPreToolUse`, the shared
// core behind pre-tool-use.js (and the agy/codex adapters). Run it with:
//   node server/hooks/decision-test.js   (npm run test:decision --prefix server)
//
// This is the highest-stakes untested path in the whole system: the one function that turns a tool
// call plus a grant state into allow / deny / ask, and the one place a bug silently over- or
// under-permits every governed call on a machine. deadline-test.js drives the watchdog and
// authority-test.js drives the unknown-capability branch; neither exercises the ordinary
// grant-state decision, and none of them exercise the HTTP CLIENT (apiFetch) those decisions ride
// on top of.
//
// So this test stands up a REAL local HTTP server as the governance API and points the hook at it
// with WINDROW_API_BASE — nothing is stubbed below apiFetch. That means every assertion here also
// exercises the client: the /capabilities fetch + cache, the /principals/resolve round trip, the
// /invoke grant check, and the two client failure modes that read as a governance verdict if the
// client gets them wrong (a 503 fault, and the version-skew case where an old server answers a
// route it doesn't have with its own SPA HTML instead of JSON — see apiFetch.json()).
//
// Properties, each a way the decision could look correct and not be:
//   1. A NATIVE tool (Read) is ungoverned pass-through — allowed, no round trip.
//   2. A SELF-CALL (Bash hitting the governance API/token) is denied as POLICY, before any check.
//   3. A GRANTED tool is allowed AND leaves a pending file so PostToolUse can correct the row.
//   4. An ungranted MUTATING tool is a POLICY deny — the reference "governance said no".
//   5. An ungranted DESTRUCTIVE tool is ASK, not deny — a human decides, and it is recorded.
//   6. A GRANTED read_only tool is allowed.
//   7. An UNKNOWN tool on a healthy standalone node is ungoverned pass-through (allow).
//   8. When /invoke FAULTS (503): read_only fails OPEN, mutating fails CLOSED — and the closed one
//      is tagged a fault, not a policy denial, so an agent does not go ask for a grant it has.
//   9. VERSION SKEW (server answers /capabilities with SPA HTML) fails closed and names the real
//      cause — a stale server — rather than reaching the agent as an unexplained deny.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-decision-'));
process.env.WINDROW_DATA_DIR = path.join(SCRATCH, 'data');
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');
// Isolate the secrets the hook signs its caches with — otherwise loadOrCreateSecret would touch the
// real server/data token files.
process.env.WINDROW_AGENT_TOKEN_PATH = path.join(SCRATCH, 'agent-api-token');
process.env.WINDROW_OWNER_SIGNING_KEY_PATH = path.join(SCRATCH, 'owner-signing-key');
// The native-observation spool is best-effort noise here; keep it off so nothing writes a journal
// line beside the decisions under test.
process.env.WINDROW_OBSERVE_NATIVE_TOOLS = '0';

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// The fixture governance API. Mutable per-test state controls what it answers.
// ---------------------------------------------------------------------------

// Capabilities are matched by (kind, name); the tool call mcp__<server>__<tool> normalizes to the
// bare <tool> name, so these names are the bare tool names, not the qualified kind/name form.
const CAPS = [
  { id: 'cap_ro', kind: 'mcp_tool', name: 'get_usage', riskTier: 'read_only', autoGrant: false },
  { id: 'cap_mut_ok', kind: 'mcp_tool', name: 'grant_capability', riskTier: 'mutating', autoGrant: false },
  { id: 'cap_mut_no', kind: 'mcp_tool', name: 'ship', riskTier: 'mutating', autoGrant: false },
  { id: 'cap_dtr', kind: 'mcp_tool', name: 'destroy', riskTier: 'destructive', autoGrant: false },
];

const state = {
  granted: new Set(['cap_ro', 'cap_mut_ok']), // which capability ids this principal holds
  failInvoke: false, // 503 from /invoke — stage a governance fault on the grant check
  skewCapabilities: false, // answer /capabilities with SPA HTML — stage a version-skew fault
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  if (req.method === 'GET' && url === '/api/capabilities') {
    if (state.skewCapabilities) {
      // What an older server does: it serves the built SPA plus a catch-all, so a route it doesn't
      // have answers 200 with index.html rather than 404.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>windrow</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CAPS));
    return;
  }
  if (req.method === 'POST' && url === '/api/principals/resolve') {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ instance: { id: 'pr_test', name: 'tester', kind: 'instance', parentRole: null } }));
    return;
  }
  if (req.method === 'POST' && url === '/api/invoke') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (state.failInvoke) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'central unavailable' }));
      return;
    }
    const allowed = state.granted.has(body.capabilityId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      allowed,
      event: { id: `evt_${body.capabilityId}` },
      policy: { authority: 'node', version: 1 },
    }));
    return;
  }
  if (req.method === 'PATCH' && url.startsWith('/api/usage/')) {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// A fresh capability cache re-reads /capabilities the next call — used to test the skew path, which
// only fires on a live fetch, after the earlier tests have warmed the cache.
function clearCapabilityCache() {
  try { fs.unlinkSync(path.join(process.env.WINDROW_DATA_DIR, 'hook-capability-cache.json')); } catch { /* already gone */ }
}

function pendingFiles() {
  try { return fs.readdirSync(path.join(process.env.WINDROW_DATA_DIR, 'pending')); } catch { return []; }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // MUST be set before lib is required: API_BASE and the self-call host pattern are both derived at
  // module load.
  process.env.WINDROW_API_BASE = `http://127.0.0.1:${port}/api`;

  const lib = require('./lib');

  const decideFor = async (toolName, toolInput, sessionId = 'decision-test') => {
    let decision = null;
    let reason = null;
    await lib.runPreToolUse({ toolName, toolInput, sessionId, decideFn: (d, r) => { decision = d; reason = r; } });
    return { decision, reason };
  };

  // 1. Native tool — ungoverned pass-through.
  {
    const { decision, reason } = await decideFor('Read', { file_path: '/tmp/x' });
    check(decision === 'allow' && reason === undefined, '1 a native tool is allowed with no reason', `${decision}: ${reason}`);
  }

  // 2. Self-call — denied as policy, before any capability/grant check.
  {
    const { decision, reason } = await decideFor('Bash', { command: `curl http://127.0.0.1:${port}/api/grants` });
    check(decision === 'deny', '2 a shell call at the governance API is denied', `${decision}: ${reason}`);
    check(/\[governance:denied\]/.test(reason || ''), '2 and it is tagged a policy denial, not a fault', reason);
  }

  // 3. Granted mutating tool — allowed, and a pending file is written for PostToolUse.
  {
    const before = pendingFiles().length;
    const { decision } = await decideFor('mcp__windrow__grant_capability', { some: 'input' }, 'sess-grant');
    check(decision === 'allow', '3 a granted mutating tool is allowed', decision);
    check(pendingFiles().length === before + 1, '3 and it leaves a pending file so PostToolUse can correct the row');
  }

  // 4. Ungranted mutating tool — the reference policy deny.
  {
    const { decision, reason } = await decideFor('mcp__deploy__ship', {});
    check(decision === 'deny', '4 an ungranted mutating tool is denied', `${decision}: ${reason}`);
    check(/\[governance:denied\]/.test(reason || '') && /No active grant/.test(reason || ''), '4 as a policy denial naming the missing grant', reason);
  }

  // 5. Ungranted destructive tool — ask, not deny.
  {
    const { decision, reason } = await decideFor('mcp__infra__destroy', {});
    check(decision === 'ask', '5 an ungranted destructive tool asks the human rather than denying', `${decision}: ${reason}`);
    check(/approve/i.test(reason || ''), '5 and the prompt asks to approve this one call', reason);
  }

  // 6. Granted read_only tool — allowed.
  {
    const { decision } = await decideFor('mcp__windrow__get_usage', {});
    check(decision === 'allow', '6 a granted read_only tool is allowed', decision);
  }

  // 7. Unknown tool on a healthy standalone node — ungoverned pass-through.
  {
    const { decision } = await decideFor('mcp__misc__never_registered', {});
    check(decision === 'allow', '7 an unknown tool on a healthy node is ungoverned and allowed', decision);
  }

  // 8. /invoke faults (503): read_only fails open, mutating fails closed as a FAULT (not a denial).
  state.failInvoke = true;
  {
    const ro = await decideFor('mcp__windrow__get_usage', {});
    check(ro.decision === 'allow', '8 read_only fails OPEN when the grant check faults', `${ro.decision}: ${ro.reason}`);

    const mut = await decideFor('mcp__windrow__grant_capability', {}, 'sess-fault');
    check(mut.decision === 'deny', '8 mutating fails CLOSED when the grant check faults', `${mut.decision}: ${mut.reason}`);
    check(/\[governance:fault\//.test(mut.reason || ''), '8 and the closed call is tagged a fault, not a permission denial', mut.reason);
    check(/NOT a permission denial/.test(mut.reason || ''), '8 so the agent is told no grant is missing', mut.reason);
  }
  state.failInvoke = false;

  // 9. Version skew: /capabilities answers with SPA HTML. Cold the cache so the live fetch runs.
  // Through the hook the decision fails closed and is tagged a fault; the client-level message that
  // names the real cause (a stale server) rides on the thrown error, so assert that on findCapability
  // directly — it re-throws the client error when no stale cache can rescue it.
  clearCapabilityCache();
  state.skewCapabilities = true;
  {
    const { decision, reason } = await decideFor('mcp__windrow__get_usage', {});
    check(decision === 'deny', '9 a version-skew HTML answer fails closed', `${decision}: ${reason}`);
    check(/\[governance:fault\/version-skew/.test(reason || ''), '9 as a version-skew fault, not a policy denial', reason);

    clearCapabilityCache();
    let err = null;
    try { await lib.findCapability('mcp_tool', 'get_usage'); } catch (e) { err = e; }
    check(err && err.fault === lib.FAULT.SKEW, '9 the client classifies an SPA answer as version skew', err && err.fault);
    check(err && /older build|restart the governance service/i.test(err.message || ''), '9 and the client error names the real cause: a stale server', err && err.message);
  }
  state.skewCapabilities = false;

  server.close();
  console.log(failures === 0 ? '\nall decision-path checks passed' : `\n${failures} check(s) FAILED`);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* a temp dir that outlives the run is not a failure */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { server.close(); } catch { /* nothing to close */ }
  process.exit(1);
});
