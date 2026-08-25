'use strict';
// LangChain callback handler on top of @windrow/enforce (./index.js) — the ~50 lines the
// governance audit (finding #9) named as the highest-leverage integration artifact, and the proof
// that the in-process SDK is what a framework actually needs. LangChain runs the model and the
// tools in one process and exposes a "callback handler" over their lifecycle rather than a
// subprocess hook, so this maps that lifecycle onto pre()/post():
//
//   handleToolStart  -> pre()   : a deny throws here, which aborts the tool before it runs
//   handleToolEnd    -> post(failed:false)
//   handleToolError  -> post(failed:true)
//
// A denied pre() must actually STOP the tool, and a LangChain handler only stops a run if it both
// awaits handlers and re-raises their errors — otherwise a thrown error is caught and logged and
// the tool runs anyway. So the handler forces `awaitHandlers = true` and `raiseError = true`; with
// those set, throwing in handleToolStart propagates out of the tool's invoke() before _call runs.
//
// @langchain/core is a PEER of this integration, not a dependency of the whole server — most
// windrow deployments never touch LangChain. So it is required lazily, only when a handler is
// actually constructed, and its absence is a clear "install this" message rather than a load-time
// crash of a server that was never going to use it.

const enforce = require('./index');

// Class is built on first use so importing this module costs nothing and needs no LangChain — the
// require lives inside, so a deployment that never constructs a handler never needs the peer.
let HandlerClass = null;

function getHandlerClass() {
  if (HandlerClass) return HandlerClass;

  let BaseCallbackHandler;
  try {
    ({ BaseCallbackHandler } = require('@langchain/core/callbacks/base'));
  } catch (err) {
    const e = new Error(
      'windrow LangChain governance needs @langchain/core, which is not installed. ' +
        'Add it to the project using LangChain: `npm install @langchain/core`.'
    );
    e.cause = err;
    throw e;
  }

  HandlerClass = class WindrowCallbackHandler extends BaseCallbackHandler {
    constructor(options = {}) {
      super();
      this.name = 'WindrowCallbackHandler';
      // Both are what make a deny actually block — see the file header.
      this.awaitHandlers = true;
      this.raiseError = true;
      this.sessionId = options.sessionId;
      this.backendHint = options.backendHint;
      // runId -> the call context pre() saw, so handleToolEnd/handleToolError can post() the real
      // outcome for the same call. Cleared on end/error so a long-lived handler doesn't grow.
      this._pending = new Map();
    }

    // tool: the serialized tool; runName (last positional) is LangChain's resolved display name.
    async handleToolStart(tool, input, runId, _parentRunId, _tags, _metadata, runName) {
      const toolName = resolveToolName(tool, runName);
      const toolInput = coerceInput(input);
      const sessionId = this.sessionId || runId;
      const { decision, reason } = await enforce.pre({
        toolName,
        toolInput,
        sessionId,
        backendHint: this.backendHint,
      });
      if (decision === 'deny') {
        // Thrown, not returned: with raiseError set this propagates out of the tool's invoke()
        // before the tool body runs, which is the only way a callback handler blocks a call.
        throw new WindrowGovernanceDenied(toolName, reason);
      }
      // Allowed (or `ask`, which this SDK treats as proceed) — remember it so post() can correct
      // the usage event once the tool finishes.
      this._pending.set(runId, { toolName, toolInput, sessionId });
    }

    async handleToolEnd(_output, runId) {
      await this._settle(runId, false);
    }

    async handleToolError(_err, runId) {
      await this._settle(runId, true);
    }

    async _settle(runId, failed) {
      const ctx = this._pending.get(runId);
      if (!ctx) return; // denied, or a tool we never saw start
      this._pending.delete(runId);
      await enforce.post({ ...ctx, failed, backendHint: this.backendHint });
    }
  };

  return HandlerClass;
}

// The tool name governance keys on. LangChain hands the tool as a serialized object plus a resolved
// display name; the MCP capability naming (`mcp__<server>__<tool>`) is what normalizeToolCall reads,
// so a governed LangChain tool must carry that as its name. Prefer the explicit runName, fall back
// to the serialized id's last segment, then the tool's own `name`.
function resolveToolName(tool, runName) {
  if (typeof runName === 'string' && runName) return runName;
  if (tool && Array.isArray(tool.id) && tool.id.length) return tool.id[tool.id.length - 1];
  if (tool && typeof tool.name === 'string' && tool.name) return tool.name;
  return undefined;
}

// LangChain passes tool input as a string; governance wants an object. Parse JSON when it is one
// (MCP tool args usually are), otherwise wrap the raw string. The decision itself only reads the
// tool NAME, so this shape matters for the usage-event detail, not for allow/deny.
function coerceInput(input) {
  if (input && typeof input === 'object') return input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not JSON — fall through to the wrapped form */
    }
    return { input };
  }
  return {};
}

class WindrowGovernanceDenied extends Error {
  constructor(toolName, reason) {
    super(reason || `Tool "${toolName}" was denied by windrow governance.`);
    this.name = 'WindrowGovernanceDenied';
    this.toolName = toolName;
    this.reason = reason || null;
  }
}

/** Construct a LangChain callback handler that governs every tool call in the run it is attached
 * to. Pass it in a chain/agent's `callbacks` array. Throws if @langchain/core is not installed. */
function createWindrowCallbackHandler(options = {}) {
  const Handler = getHandlerClass();
  return new Handler(options);
}

module.exports = {
  createWindrowCallbackHandler,
  WindrowGovernanceDenied,
  // Exported for tests and for hosts that want to drive the mapping without a live LangChain.
  resolveToolName,
  coerceInput,
};
