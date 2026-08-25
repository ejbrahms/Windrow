// Verification for the in-process governance SDK (server/enforce/) and its LangChain callback
// handler — the artifact behind governance audit finding #9 (docs/design/
// governance-review-2026-08-24-repo-audit.md). Run it with:
//   node server/enforce-test.js   (npm run test:enforce --prefix server)
//
// No network and no server. The SDK deliberately does NOT re-implement policy — it wraps the same
// runPreToolUse/runPostToolUse core the subprocess hooks use — so what is under test here is the
// WIRING, the one thing that could be subtly wrong in a way that reads as correct:
//
//   1. pre() CAPTURES a decision instead of writing stdout+exit. The whole reason a hook could not
//      be reused in-process is that its decideFn calls process.exit; this proves the in-process
//      decideFn returns a value and the process survives.
//   2. AN UNGOVERNED TOOL IS ALLOWED, with no server reachable. The common path must not fail just
//      because the framework runs in-process.
//   3. THE SELF-CALL BLOCK STILL FIRES through the SDK — the one deny that needs no server. Proves
//      pre() reaches the real policy core, not a stub that always allows.
//   4. post() DOES NOT THROW on an ungoverned tool with nothing pending — a host that calls it
//      unconditionally after every tool must be safe.
//   5. THE LANGCHAIN HANDLER MAPS THE LIFECYCLE: a deny THROWS out of handleToolStart (the only way
//      a callback handler blocks a tool), an allow records the call so post() can settle it, and
//      handleToolEnd/handleToolError both settle without error. Driven against a stub BaseCallback-
//      Handler so it runs without @langchain/core installed.
//   6. THE PEER DEPENDENCY IS A CLEAR MESSAGE, NOT A CRASH: constructing a handler with no
//      @langchain/core available names the package to install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'windrow-enforce-'));
process.env.WINDROW_DB_PATH = path.join(SCRATCH, 'windrow.db');
process.env.WINDROW_DATA_DIR = path.join(SCRATCH, 'data');
process.env.WINDROW_CA_DIR = path.join(SCRATCH, 'ca');
process.env.WINDROW_BOOTSTRAP_TOKEN_PATH = path.join(SCRATCH, 'bootstrap-token');
// Keep the self-call deny path from spooling an observation line during the test.
process.env.WINDROW_OBSERVE_NATIVE_TOOLS = '0';

const enforce = require('./enforce');

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// A LangChain host name that reaches the governance API, so the self-call block denies it without
// any server being up. `mcp__…` names would need a live registry, which this test deliberately
// avoids — the point is the wiring, not the grant check.
function apiHost() {
  try {
    return new URL(require('./hooks/lib').API_BASE).host;
  } catch {
    return '127.0.0.1:4000';
  }
}

async function main() {
  // 1 + 2: pre() returns a captured decision and allows an ungoverned tool with no server.
  const allow = await enforce.pre({ toolName: 'Read', toolInput: { file_path: '/tmp/x' }, sessionId: 's1' });
  check(allow && allow.decision === 'allow', '1/2 pre() captures a decision and allows an ungoverned tool', JSON.stringify(allow));
  check(enforce.isAllowed(allow.decision) === true, 'isAllowed(allow) is true');

  // 3: the self-call block denies through the SDK, no server needed.
  const host = apiHost();
  const deny = await enforce.pre({ toolName: 'Bash', toolInput: { command: `curl http://${host}/api/grants` }, sessionId: 's2' });
  check(deny && deny.decision === 'deny', '3 self-call attempt is denied through pre()', JSON.stringify(deny));
  check(typeof deny.reason === 'string' && deny.reason.length > 0, 'deny carries a reason');
  check(enforce.isAllowed(deny.decision) === false, 'isAllowed(deny) is false');

  // 4: post() on an ungoverned tool with nothing pending must not throw.
  let postThrew = false;
  try {
    await enforce.post({ toolName: 'Read', toolInput: { file_path: '/tmp/x' }, sessionId: 's1', failed: false });
  } catch {
    postThrew = true;
  }
  check(!postThrew, '4 post() on an ungoverned tool does not throw');

  // 5: the LangChain handler, driven against a stub BaseCallbackHandler so no real dependency is
  // needed. Inject the stub into the module loader before requiring the handler.
  const origLoad = Module._load;
  class StubBase {
    constructor() {}
  }
  Module._load = function (request, ...rest) {
    if (request === '@langchain/core/callbacks/base') return { BaseCallbackHandler: StubBase };
    return origLoad.call(this, request, ...rest);
  };
  let handlerModule;
  try {
    handlerModule = require('./enforce/langchain');
    const handler = handlerModule.createWindrowCallbackHandler({ sessionId: 'lc1' });
    check(handler instanceof StubBase, '5 handler extends BaseCallbackHandler');
    check(handler.raiseError === true && handler.awaitHandlers === true, 'handler forces raiseError + awaitHandlers so a deny blocks');

    // Deny → throws out of handleToolStart.
    let denied = false;
    try {
      await handler.handleToolStart({ id: ['Bash'] }, JSON.stringify({ command: `curl http://${host}/api/grants` }), 'run-deny', null, null, null, 'Bash');
    } catch (err) {
      denied = err instanceof handlerModule.WindrowGovernanceDenied;
    }
    check(denied, 'a denied tool throws WindrowGovernanceDenied from handleToolStart');

    // Allow → records the call, then end/error settle without throwing.
    await handler.handleToolStart({ id: ['ReadFile'] }, '{}', 'run-allow', null, null, null, 'ReadFile');
    check(handler._pending.has('run-allow'), 'an allowed tool is remembered for post()');
    let settleThrew = false;
    try {
      await handler.handleToolEnd('output', 'run-allow');
    } catch {
      settleThrew = true;
    }
    check(!settleThrew && !handler._pending.has('run-allow'), 'handleToolEnd settles the call without error');
    // handleToolError on an unknown run is a no-op, not a throw.
    let errSettleThrew = false;
    try {
      await handler.handleToolError(new Error('boom'), 'run-unknown');
    } catch {
      errSettleThrew = true;
    }
    check(!errSettleThrew, 'handleToolError on an unknown run is a safe no-op');
  } finally {
    Module._load = origLoad;
  }

  // 6: with the stub removed, constructing a handler names the package to install.
  delete require.cache[require.resolve('./enforce/langchain')];
  const freshModule = require('./enforce/langchain');
  let msg = '';
  try {
    freshModule.createWindrowCallbackHandler({});
  } catch (err) {
    msg = err.message;
  }
  check(/@langchain\/core/.test(msg), '6 missing @langchain/core is a clear install message', msg);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
