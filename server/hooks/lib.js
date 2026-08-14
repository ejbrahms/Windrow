'use strict';
// Shared helpers for the PreToolUse/PostToolUse hooks that wire real enforcement to the
// capability-governance API. See docs/design/integration-todo.md step 3.
//
// Both hooks are spawned fresh (one Node process per tool call) by the Claude Code harness, so
// state that needs to survive between the Pre and Post half of a single call is kept on disk,
// not in memory. Everything here is deliberately dependency-free (no fetch polyfill needed —
// Node 18+ has global fetch) so `npm install` isn't required just to run the hooks.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Hooks use the agent-scoped token (not the admin token) — a hook process is spawned per tool
// call, for every principal including untrusted skills, so it must not be able to reach the
// registry-mutating endpoints even if it were compromised. See server/auth.js and
// docs/design/governance-vulnerability-review.md finding #1.
const { AGENT_TOKEN, TOKEN_PATH, AGENT_TOKEN_PATH } = require('../auth');

const API_BASE = process.env.GOVERNANCE_API_BASE || 'http://localhost:4000/api';
const DATA_DIR = path.join(__dirname, '..', 'data');
const PENDING_DIR = path.join(DATA_DIR, 'pending');
const PRINCIPAL_CACHE_PATH = path.join(DATA_DIR, 'hook-principal-cache.json');
const CAPABILITY_CACHE_PATH = path.join(DATA_DIR, 'hook-capability-cache.json');
// Unlike the principal cache (cached forever per loom id — a loom's own identity doesn't change
// mid-life), the capability list is shared, mutable state: any principal can register a new
// capability or an admin can retier/remove one at any moment, and every hook process on every
// loom needs to see that within a bounded window rather than never. A short TTL still kills the
// common case — every hook invocation is a fresh Node process (see file header), so without this
// each one paid a full `GET /capabilities` round trip just to resolve the one capability a tool
// call maps to. Override via env for tests/tuning.
const CAPABILITY_CACHE_TTL_MS = Number(process.env.GOVERNANCE_CAPABILITY_CACHE_TTL_MS) || 30_000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // If nothing is piped (e.g. manual test run), don't hang forever.
    process.stdin.on('error', () => resolve(data));
  });
}

async function readHookInput() {
  const raw = await readStdin();
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Name-normalization layer: map a Claude Code tool call to the capability it represents in the
 * registry, or `null` if the tool isn't something this governance system tracks at all (native
 * harness tools like Bash, Read, Edit, Write, Grep, Glob, Task, WebFetch, TodoWrite, ... are
 * ungoverned pass-through — the registry only knows about skills and MCP tools).
 */
function normalizeToolCall(toolName, toolInput) {
  if (!toolName) return null;
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    // mcp__<server>__<tool...> — tool name itself may contain underscores (wispfield's tools
    // already start with "wispfield_", so keep everything after the server segment intact).
    const name = parts.slice(2).join('__');
    if (!name) return null;
    return { kind: 'mcp_tool', name };
  }
  if (toolName === 'Skill') {
    const name = toolInput && (toolInput.skill || toolInput.name);
    if (!name) return null;
    return { kind: 'skill', name };
  }
  return null;
}

// Host:port the governance API itself listens on, derived from API_BASE (not hardcoded) so this
// still matches if GOVERNANCE_API_BASE points somewhere non-default (docs/design/
// governance-vulnerability-review.md finding #2's "curl the API directly" bypass).
const GOVERNANCE_API_HOST = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return 'localhost:4000';
  }
})();
const GOVERNANCE_API_HOST_PATTERN = new RegExp(GOVERNANCE_API_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
// Basenames of both token files — a shell command reading either off disk (`cat`, `type`,
// PowerShell `Get-Content`, ...) can impersonate a hook without ever calling the API itself.
const GOVERNANCE_TOKEN_BASENAME_PATTERN = new RegExp(
  `\\b(${path.basename(TOKEN_PATH)}|${path.basename(AGENT_TOKEN_PATH)})\\b`,
  'i'
);

/**
 * True when a Bash (or other shell-style) command looks like it's targeting the governance API's
 * own HTTP surface or reading one of its token files directly — the cheapest, most severe
 * instance of "native tools are a total bypass" (finding #2): replicating what a governed MCP
 * call does via `curl`/PowerShell, with zero grant check and zero usage log. This does not
 * attempt to govern arbitrary Bash usage in general (a much larger effort — mapping shell
 * commands to capabilities has no spec yet); it only closes the specific hole of a shell command
 * reaching back into the governance system itself.
 */
function isGovernanceSelfCallAttempt(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const command = toolInput && toolInput.command;
  if (typeof command !== 'string' || !command) return false;
  return GOVERNANCE_API_HOST_PATTERN.test(command) || GOVERNANCE_TOKEN_BASENAME_PATTERN.test(command);
}

async function apiFetch(pathname, options) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AGENT_TOKEN}`,
      ...(options && options.headers),
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${options && options.method ? options.method : 'GET'} ${pathname} -> ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function loadCapabilityCache({ allowStale = false } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(CAPABILITY_CACHE_PATH, 'utf8'));
    if (!allowStale && Date.now() - cache.fetchedAt > CAPABILITY_CACHE_TTL_MS) return null; // stale — refetch
    return cache.capabilities;
  } catch {
    return null;
  }
}

function saveCapabilityCache(capabilities) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAPABILITY_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), capabilities }));
}

/**
 * Resolves a tool call to its registered capability. Backed by a file cache (like
 * resolvePrincipal's below) because every hook invocation is a fresh process — without it, every
 * single tool call paid a full `GET /capabilities` round trip. Kept fresh with a short TTL
 * (CAPABILITY_CACHE_TTL_MS) rather than cached for life, since the capability list is shared
 * mutable state (new capabilities, retiers) that other principals can change at any time.
 *
 * If the live fetch fails (governance API unreachable) and a stale cache exists, that's used
 * instead of throwing — so an outage doesn't blind every hook to the risk tier of a capability
 * it already knew about, and the mutating/destructive fail-*closed* policy in `runPreToolUse` can
 * still apply correctly (docs/design/governance-vulnerability-review.md finding #3). Only throws
 * when there's truly nothing cached at all.
 */
async function findCapability(kind, name) {
  let capabilities = loadCapabilityCache();
  if (!capabilities) {
    try {
      const res = await apiFetch('/capabilities');
      capabilities = await res.json();
      saveCapabilityCache(capabilities);
    } catch (err) {
      const stale = loadCapabilityCache({ allowStale: true });
      if (!stale) throw err;
      log(`governance API unreachable, using stale capability cache: ${err.message}`);
      capabilities = stale;
    }
  }
  return capabilities.find((c) => c.kind === kind && c.name === name) || null;
}

function loadPrincipalCache() {
  try {
    return JSON.parse(fs.readFileSync(PRINCIPAL_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function savePrincipalCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRINCIPAL_CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Resolve the real principal behind this hook invocation. Uses Finn's server/principals module
 * (roadmap step 2) directly rather than re-deriving identity here — that module owns the id
 * scheme (role = agentType, instance = loomId) and the upsert semantics. The hook runs as a local
 * Node child process of the loom (or, outside Wispfield, of whatever standalone backend invoked
 * it), same as that module assumes.
 *
 * `backendHint` (docs/design/cross-field-and-standalone.md) is passed by a backend-specific hook
 * entry point (agy, codex) so a standalone identity is attributed to the right backend without
 * guessing from env vars alone. `identityFromEnv` never returns `null` any more — a process with
 * no Wispfield loom id resolves to a deterministic "standalone" identity instead of going
 * ungoverned — so this function no longer returns `null` for that reason either; a `null` return
 * now only happens on an actual resolution error (caller still treats it as fail-open/closed).
 *
 * Upserting touches the store directly (not through the HTTP API), so it's cached per loom id for
 * the life of this cache file to keep the common case (a loom that's already registered) to a
 * single fs read with no store write at all.
 */
async function resolvePrincipal(backendHint) {
  const { identityFromEnv } = require('../principals/fromEnv');
  const { upsertPrincipalFromIdentity } = require('../principals/registry');
  const store = require('../store');

  const identity = identityFromEnv(process.env, { backendHint });

  const cache = loadPrincipalCache();
  const cached = cache[identity.loomId];
  if (cached) return cached;

  const db = store.load();
  const { instance } = upsertPrincipalFromIdentity(db, identity);
  store.save(db);

  cache[identity.loomId] = instance;
  savePrincipalCache(cache);
  return instance;
}

async function invoke(principalId, capabilityId, correlationId) {
  const res = await apiFetch('/invoke', {
    method: 'POST',
    body: JSON.stringify({ principalId, capabilityId, correlationId }),
  });
  return res.json();
}

async function patchUsageEvent(eventId, patch) {
  await apiFetch(`/usage/${eventId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Stable key linking a PreToolUse call to its PostToolUse counterpart (same process pair). */
function pendingKey(sessionId, toolName, toolInput) {
  const hash = crypto
    .createHash('sha1')
    .update(`${sessionId}|${toolName}|${JSON.stringify(toolInput || {})}`)
    .digest('hex');
  return hash;
}

function writePending(key, data) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(path.join(PENDING_DIR, `${key}.json`), JSON.stringify(data));
}

function readAndClearPending(key) {
  const file = path.join(PENDING_DIR, `${key}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return data;
  } catch {
    return null;
  }
}

/** Print a PreToolUse decision in the modern hookSpecificOutput shape and exit. */
function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision, // "allow" | "deny" | "ask"
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/**
 * Print a PreToolUse decision in Antigravity's hook output shape and exit. Same allow/deny/ask
 * vocabulary as Claude Code's `decide()`, just a flat `{decision, reason}` object instead of the
 * nested `hookSpecificOutput` envelope — see docs/design/agy-adapter.md. Antigravity also accepts
 * `force_ask`/`deny_unless_prior_grant`, which the broker's allow/deny/ask model has no use for.
 */
function decideAgy(decision, reason) {
  process.stdout.write(JSON.stringify({ decision, reason }));
  process.exit(0);
}

function log(...args) {
  // Hooks' stdout is reserved for the JSON decision — diagnostics go to stderr only.
  console.error('[governance-hook]', ...args);
}

/**
 * Shared PreToolUse core, used by all three backend adapters (pre-tool-use.js, agy-pre-tool-use.js,
 * codex-pre-tool-use.js). Only three things differ per backend and are passed in: how the tool
 * call was extracted from stdin (already done by the caller), which `backendHint` to attribute a
 * standalone principal to, and how to emit the final decision (`decideFn` — Claude's nested
 * `hookSpecificOutput` shape vs Antigravity/Codex's flat `{decision, reason}`). Everything else —
 * capability lookup, principal resolution, the grant check, and the fail-open/fail-closed policy
 * per risk tier — lives here once so a change to that policy only has to be made in one place.
 */
async function runPreToolUse({ toolName, toolInput, sessionId, backendHint, decideFn }) {
  // Bash (and any other native tool) is otherwise a total bypass of everything below — a raw
  // shell call never goes through `normalizeToolCall`, so it can't be tiered or grant-checked.
  // Full native-tool governance is a larger design effort (finding #2's recommendation), but the
  // single most severe instance — a shell command hitting the governance API or reading its
  // token(s) directly, replicating what a hook does without ever going through it — is cheap to
  // close outright: deny it, unconditionally, before it reaches the ungoverned pass-through below.
  if (isGovernanceSelfCallAttempt(toolName, toolInput)) {
    log(`blocked: ${toolName} appears to target the governance API/token directly:`, toolInput && toolInput.command);
    decideFn('deny', 'direct shell access to the governance API or its token file is not permitted');
    return;
  }

  const target = normalizeToolCall(toolName, toolInput);
  if (!target) {
    // Ungoverned tool — nothing to check, allow silently.
    decideFn('allow', undefined);
    return;
  }

  // Phase timings (docs/design/latency-breakdown.md) — carried through the pending file so
  // PostToolUse can fold them into the same correcting PATCH as outcome/latencyMs.
  const capabilityLookupStart = Date.now();
  let capability;
  try {
    capability = await findCapability(target.kind, target.name);
  } catch (err) {
    // findCapability() already tried a stale cache and found nothing — the risk tier is
    // genuinely unknown, so this fails *closed* (finding #3: killing the governance API used to
    // be an unconditional, unlogged "allow everything"). Read-only-only tools that have never
    // been resolved before during an outage are the one real cost of this; that's the tradeoff
    // the audit calls for over silent full access.
    log(`governance API unreachable resolving capability ${target.kind}/${target.name} (no cache):`, err.message);
    decideFn('deny', 'governance API unreachable and capability unknown — fail-closed');
    return;
  }
  const capabilityLookupMs = Date.now() - capabilityLookupStart;

  if (!capability) {
    log(`no registered capability for ${target.kind}/${target.name} — allowing, ungoverned`);
    decideFn('allow', undefined);
    return;
  }

  // Fail-open is now scoped to read_only only (finding #3) — a mutating or destructive
  // capability denies (or, for destructive, asks) on any governance error instead of silently
  // allowing, so an attacker can't turn "make the API unreachable" into free write/destructive
  // access the way a blanket "anything but destructive" policy allowed.
  const failOpen = capability.riskTier === 'read_only';

  const principalResolveStart = Date.now();
  let principal;
  try {
    principal = await resolvePrincipal(backendHint);
  } catch (err) {
    log('error resolving principal:', err.message);
    decideFn(failOpen ? 'allow' : 'deny', `principal resolution error — fail-${failOpen ? 'open' : 'closed'}`);
    return;
  }
  const principalResolveMs = Date.now() - principalResolveStart;

  if (!principal) {
    // resolvePrincipal() no longer returns null for "not running under Wispfield" — defensive
    // fallback only, for some other resolution failure that didn't throw.
    log(`principal resolution returned nothing unexpectedly — fail-${failOpen ? 'open' : 'closed'} for ${target.kind}/${target.name}`);
    decideFn(failOpen ? 'allow' : 'deny', `no principal identity — fail-${failOpen ? 'open' : 'closed'}`);
    return;
  }

  const loomLabel = process.env.LOOM_AGENT_NAME
    ? `${process.env.LOOM_AGENT_NAME}(${process.env.LOOM_NODE_ID || 'no-node-id'})`
    : process.env.LOOM_NODE_ID || 'local';
  const correlationId = `${loomLabel}:${sessionId || 'no-session'}`;

  const grantCheckStart = Date.now();
  let result;
  try {
    result = await invoke(principal.id, capability.id, correlationId);
  } catch (err) {
    log(
      `governance API error on /invoke for ${target.kind}/${target.name} (tier ${capability.riskTier}):`,
      err.message,
      failOpen ? '— failing open' : '— failing closed'
    );
    decideFn(failOpen ? 'allow' : 'deny', `governance API error — fail-${failOpen ? 'open' : 'closed'}`);
    return;
  }
  const grantCheckMs = Date.now() - grantCheckStart;

  if (result.allowed) {
    // Remember the event id so PostToolUse can correct it with the real outcome/latency once the
    // tool actually finishes.
    const key = pendingKey(sessionId, toolName, toolInput);
    writePending(key, {
      eventId: result.event.id,
      startedAt: Date.now(),
      capabilityLookupMs,
      principalResolveMs,
      grantCheckMs,
    });
    decideFn('allow', undefined);
  } else if (capability.riskTier === 'destructive') {
    log(`asking: principal ${principal.name} has no active grant for destructive ${target.kind}/${target.name}`);
    decideFn('ask', `destructive capability "${target.name}" has no active grant — approve this one call?`);
  } else {
    log(`denied: principal ${principal.name} has no active grant for ${target.kind}/${target.name}`);
    decideFn('deny', `no active grant for ${target.kind} "${target.name}"`);
  }
}

/**
 * Shared PostToolUse core, used by all three backend adapters. `failed` is a pre-computed boolean
 * (each adapter's own outcome shape — Claude's `tool_response.is_error`, Antigravity's plain
 * `error` string, Codex's several guessed shapes — is decided by the caller before this runs).
 */
async function runPostToolUse({ toolName, toolInput, sessionId, failed }) {
  const target = normalizeToolCall(toolName, toolInput);
  if (!target) return;

  const key = pendingKey(sessionId, toolName, toolInput);
  const pending = readAndClearPending(key);
  if (!pending) {
    // Denied, governance API was down at Pre-time, or a Post fired with no matching Pre —
    // nothing to correct either way.
    return;
  }

  const outcome = failed ? 'error' : 'ok';
  const latencyMs = Math.max(0, Date.now() - pending.startedAt);

  try {
    await patchUsageEvent(pending.eventId, {
      outcome,
      latencyMs,
      capabilityLookupMs: pending.capabilityLookupMs,
      principalResolveMs: pending.principalResolveMs,
      grantCheckMs: pending.grantCheckMs,
    });
  } catch (err) {
    log(`failed to record real outcome for event ${pending.eventId}:`, err.message);
  }
}

/**
 * Pulls {toolName, toolInput, sessionId} out of whichever of several plausible stdin shapes the
 * Codex CLI turns out to use — its actual PreToolUse/PostToolUse hook contract is unconfirmed
 * (docs/design/cross-field-and-standalone.md), so this tries the union of Claude Code's
 * snake_case top-level fields and Antigravity's `toolCall`-nested shape rather than assuming one.
 * Shared by codex-pre-tool-use.js and codex-post-tool-use.js.
 */
function extractCodexToolCall(input) {
  const toolCall = input.toolCall || input.tool_call || {};
  const toolName = input.tool_name || input.toolName || toolCall.name || toolCall.tool;
  const toolInput = input.tool_input || input.toolInput || toolCall.args || toolCall.arguments;
  const sessionId = input.session_id || input.sessionId || input.conversationId || input.conversation_id;
  return { toolName, toolInput, sessionId };
}

module.exports = {
  API_BASE,
  readHookInput,
  normalizeToolCall,
  isGovernanceSelfCallAttempt,
  findCapability,
  resolvePrincipal,
  invoke,
  patchUsageEvent,
  pendingKey,
  writePending,
  readAndClearPending,
  decide,
  decideAgy,
  log,
  runPreToolUse,
  runPostToolUse,
  extractCodexToolCall,
};
