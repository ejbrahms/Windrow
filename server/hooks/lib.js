'use strict';
// Shared helpers for the PreToolUse/PostToolUse hooks that wire real enforcement to the
// capability-governance API. See docs/design/integration-todo.md step 3.
//
// Both hooks are spawned fresh (one Node process per tool call) by the Claude Code harness, so
// state that needs to survive between the Pre and Post half of a single call is kept on disk,
// not in memory. Everything here is deliberately dependency-free — including HTTP itself: see
// apiFetch below for why that's built on `http.request` rather than global fetch.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
// Hooks use the agent-scoped token (not the admin token) — a hook process is spawned per tool
// call, for every principal including untrusted skills, so it must not be able to reach the
// registry-mutating endpoints even if it were compromised. See server/auth.js.
// TOKEN_PATH (the old shared admin `api-token`) is deliberately NOT destructured here any more:
// server/auth.js dropped it when admin auth moved to mTLS, and this file kept asking for it — so
// `path.basename(undefined)` threw while the module was still loading, which crashed every hook
// process before it could emit any decision at all. That is the most extreme form of the very
// confusion this file's fault taxonomy exists to end: a hook that dies emits no verdict, no reason
// and no journal row, leaving governance-is-broken indistinguishable from every other outcome.
const { AGENT_TOKEN, AGENT_TOKEN_PATH } = require('../auth');
// The epoch that invalidates this file's principal cache when the grant subject moves — see
// loadPrincipalCache below and server/principals/subject.js.
const { GRANT_SUBJECT_EPOCH } = require('../principals/subject');
// The maintenance grace lease (docs/design/upgrade-resilience.md §3.2) — the signed, time-boxed
// permission a *healthy* server gives for faults to degrade instead of denying. Consulted only on
// a fault; never consulted for a real decision.
const { readGraceLease, leaseCovers } = require('../maintenance');
// The DEBUGGING pause — the other, stronger thing a healthy server can sign, and deliberately not
// the same thing as the lease above. The lease softens faults and never overrides a real decision;
// this one overrides real decisions, which is why it is separately named, tier-scoped, capped at 30
// minutes and journalled on every call it lets through. See server/enforcementPause.js.
const {
  readEnforcementPause,
  pauseCovers,
  pauseCoversUnknownTier,
} = require('../enforcementPause');
// WINDROW_* env reads. The GOVERNANCE_* spellings were removed in tier 4 of
// docs/design/governance-to-windrow-rename.md and now throw; in a hook that is the right verdict,
// because a hook that cannot resolve its own API base must fail closed rather than guess.
const { envCompat } = require('../config');

// 127.0.0.1, not 'localhost': each hook invocation is a brand-new Node process (file header) with
// nothing warm to reuse, and Windows/Node's dual-stack ("happy eyeballs") resolution of 'localhost'
// routinely adds tens of ms to a first-ever request before it settles on IPv4 — that overhead was
// showing up as a big chunk of grantCheckMs (the /invoke round trip; see runPreToolUse below and
// docs/design/latency-breakdown.md) on every single call, not just the first. A literal IP skips
// DNS/happy-eyeballs entirely.
const API_BASE = envCompat('API_BASE', { fallback: 'http://127.0.0.1:4000/api' });
const DATA_DIR = path.join(__dirname, '..', 'data');
const PENDING_DIR = path.join(DATA_DIR, 'pending');
const PRINCIPAL_CACHE_PATH = path.join(DATA_DIR, 'hook-principal-cache.json');
const CAPABILITY_CACHE_PATH = path.join(DATA_DIR, 'hook-capability-cache.json');
// Records the subject key (server/principals/subject.js) this machine last registered — see
// loadSubjectMarker below for why it isn't a field on the principal cache.
const SUBJECT_MARKER_PATH = path.join(DATA_DIR, 'hook-subject-marker.json');
// The grant replica written by server/cacheWarmer.js — what makes a fault-time decision a real
// grant check rather than a coin flip. See replicaGrantAllows below.
const GRANT_CACHE_PATH = path.join(DATA_DIR, 'hook-grant-cache.json');
// The always-full deny-list, and the age of the policy it was computed from
// (docs/design/global-identity-and-central-db.md §2.4). Written by server/policy/policyClient.js on
// an enrolled node and by server/cacheWarmer.js on a standalone one; read here on EVERY governed
// call, healthy or not. See policyChannelGate below for why it is consulted before the live check
// rather than only on a fault.
const POLICY_DENY_LIST_PATH = path.join(DATA_DIR, 'hook-policy-deny.json');

// How long this node may go without confirming policy with central before it stops trusting its own
// replica. §2.4: "past MAX_POLICY_AGE, fail closed for mutating/destructive and stay open for
// read_only — the exact policy this file already applies to an unreachable API, extended from
// 'cannot reach' to 'cannot trust'."
//
// 15 minutes, against a 30s poll: thirty consecutive missed polls before a node is disarmed. Short
// enough that a revoked grant on a node whose delta stream is broken AND whose deny-list fetch is
// failing has a bounded life; long enough that a laptop closing its lid over lunch, a VPN
// reconnect or a central restart does not lock a working machine out of its own tools.
const MAX_POLICY_AGE_MS = Number(envCompat('MAX_POLICY_AGE_MS')) || 15 * 60_000;
// Append-only record of every call decided while the server was unreachable
// (docs/design/upgrade-resilience.md §3.5). The decision degrades during a fault; the audit must
// not. This is the local half of the outbox Part 2 phase 3 needs, sized to what a hook can do
// with no server: write a line, and let recovery reconcile it.
const FAULT_JOURNAL_PATH = path.join(DATA_DIR, 'hook-fault-journal.jsonl');
// Append-only spool of *native* harness tool calls — Read, Edit, Bash, Grep, ... — which the
// registry does not model and this system does not enforce (normalizeToolCall returns null for
// them). They were previously invisible
// as well as ungoverned: no capability, so no /invoke, so no row anywhere, so the dashboard could
// not answer "what did this loom actually do" for the overwhelming majority of what it did.
//
// This is observation only. Nothing here changes a decision, and deliberately so — the calls stay
// allowed, they just stop being unrecorded, which is the cheap half of finding #2 and the half
// that has to come first anyway (you cannot tier what you have never measured).
//
// Why a spool file and not a request: `decide()` ends the process with `process.exit(0)`, so an
// un-awaited fetch is simply killed, and an awaited one puts a ~10-15ms round trip plus TCP setup
// on the hot path of every file read. An `appendFileSync` of one line is ~0.1ms and survives the
// server being down entirely. server/nativeObservations.js drains it.
const NATIVE_JOURNAL_PATH = path.join(DATA_DIR, 'hook-native-journal.jsonl');
// Backstop for the one failure mode a local spool has: the server never comes back, and a spool
// nothing drains grows for as long as agents keep working. At the cap the hook stops appending
// rather than filling the disk — observability is the thing that gets dropped under pressure, not
// the machine. Override for a deployment that drains on a longer cycle.
const NATIVE_JOURNAL_MAX_BYTES = Number(envCompat('NATIVE_JOURNAL_MAX_BYTES')) || 16 * 1024 * 1024;
// Observation is on by default. `WINDROW_OBSERVE_NATIVE_TOOLS=0` turns it off without touching
// hook wiring — the escape hatch for anyone who wants the old silence back.
const OBSERVE_NATIVE_TOOLS = envCompat('OBSERVE_NATIVE_TOOLS') !== '0';
// Unlike the principal cache (cached forever per agent id — an agent's own identity doesn't
// change mid-life), the capability list is shared, mutable state: any principal can register a new
// capability or an admin can retier/remove one at any moment, and every hook process on every
// agent needs to see that within a bounded window rather than never. A short TTL still kills the
// common case — every hook invocation is a fresh Node process (see file header), so without this
// each one paid a full `GET /capabilities` round trip just to resolve the one capability a tool
// call maps to. Override via env for tests/tuning.
const CAPABILITY_CACHE_TTL_MS = Number(envCompat('CAPABILITY_CACHE_TTL_MS')) || 30_000;

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
 * ungoverned pass-through — the registry only knows about MCP tools; skills are catalog-only and
 * have no enforcement path here).
 */
function normalizeToolCall(toolName, toolInput) {
  if (!toolName) return null;
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    // mcp__<server>__<tool...> — tool name itself may contain underscores (the platform's own
    // tools already start with "wispfield_", so keep everything after the server segment intact).
    const name = parts.slice(2).join('__');
    if (!name) return null;
    return { kind: 'mcp_tool', name };
  }
  return null;
}

// Host:port the governance API itself listens on, derived from API_BASE (not hardcoded) so this
// still matches if WINDROW_API_BASE points somewhere non-default — this is what closes the
// "just curl the API directly" bypass.
const WINDROW_API_HOST = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return 'localhost:4000';
  }
})();
const WINDROW_API_HOST_PATTERN = new RegExp(WINDROW_API_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
// Basenames of both token files — a shell command reading either off disk (`cat`, `type`,
// PowerShell `Get-Content`, ...) can impersonate a hook without ever calling the API itself.
// 'api-token' stays in the alternation as a literal even though auth.js no longer defines that
// path: the file can still be sitting on disk from before the mTLS migration, and a guard that
// quietly stopped matching it would be a narrowing of the block nobody asked for.
const WINDROW_TOKEN_BASENAMES = [...new Set([path.basename(AGENT_TOKEN_PATH), 'api-token'])];
const WINDROW_TOKEN_BASENAME_PATTERN = new RegExp(`\\b(${WINDROW_TOKEN_BASENAMES.join('|')})\\b`, 'i');

/**
 * True when a Bash (or other shell-style) command looks like it's targeting the governance API's
 * own HTTP surface or reading one of its token files directly — the cheapest, most severe
 * instance of "native tools are a total bypass" (finding #2): replicating what a governed MCP
 * call does via `curl`/PowerShell, with zero grant check and zero usage log. This does not
 * attempt to govern arbitrary Bash usage in general (a much larger effort — mapping shell
 * commands to capabilities has no spec yet); it only closes the specific hole of a shell command
 * reaching back into the governance system itself.
 */
function isWindrowSelfCallAttempt(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const command = toolInput && toolInput.command;
  if (typeof command !== 'string' || !command) return false;
  return WINDROW_API_HOST_PATTERN.test(command) || WINDROW_TOKEN_BASENAME_PATTERN.test(command);
}

// Built on `http.request`, not global fetch, even though Node 18+ ships fetch for free: undici
// (fetch's implementation) lazily builds its Agent/TLS machinery on its *first* call in a process,
// and every hook invocation is a fresh process (file header) that only ever makes one or two
// requests before exiting — so every single call paid that one-time setup cost in full. Measured
// on this machine that was ~30ms of a ~40ms round trip to a bare `GET /capabilities` (see
// docs/design/latency-breakdown.md), on top of the localhost-vs-127.0.0.1 fix above. `http.request`
// has no such lazy-init tax and brought the same call down to ~10-15ms.
async function apiFetch(pathname, options) {
  const method = (options && options.method) || 'GET';
  const body = options && options.body;
  const url = new URL(`${API_BASE}${pathname}`);
  const client = url.protocol === 'https:' ? https : http;

  const { status, text } = await new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${AGENT_TOKEN}`,
          ...(options && options.headers),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

  const ok = status >= 200 && status < 300;
  if (!ok && status !== 404) {
    const err = new Error(`${method} ${pathname} -> ${status} ${text}`);
    err.status = status;
    throw err;
  }
  // fetch()-shaped response so call sites (findCapability, invoke, ...) didn't need to change.
  return {
    ok,
    status,
    text: async () => text,
    // The API and the built client are one service (app.js serves CLIENT_DIST plus a catch-all
    // that returns index.html), so a route the *running* server doesn't have answers 200 with
    // HTML rather than 404 — the status check above can't see it. A bare JSON.parse then died
    // with `Unexpected token '<'`, which reaches the agent as an unexplained fail-closed and
    // reads like a governance decision instead of a stale deployment. Name the real cause.
    json: async () => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        const looksLikeSpa = /^\s*<(!doctype|html)/i.test(text);
        const err = new Error(
          looksLikeSpa
            ? `${method} ${pathname} -> ${status} but the response was the client HTML, not JSON: ` +
              `the server listening on ${WINDROW_API_HOST} has no such route. It is almost certainly ` +
              `running an older build than this checkout — restart the governance service.`
            : `${method} ${pathname} -> ${status} returned unparseable JSON: ${text.slice(0, 200)}`
        );
        // Classified so runPreToolUse can tell "the server disagrees with me about the contract"
        // from "the server is not there" — both are faults, but skew is the one an upgrade causes
        // and the one worth shouting about. See FAULT below.
        err.fault = looksLikeSpa ? FAULT.SKEW : FAULT.UNPARSEABLE;
        throw err;
      }
    },
  };
}

// Both hook-side caches would otherwise be plain
// JSON with no signature, so any local process with filesystem write access could previously
// rewrite one to retier a capability (flipping a destructive call's fail-closed policy to
// fail-open) or hand a hook a spoofed principal identity, without ever going through the API. Both
// are now HMAC-signed with the agent token — a secret only this server and its own hook processes
// hold — so a tampered file is detected and thrown away (treated as "no cache", same as missing)
// instead of trusted. This doesn't stop a process that can *read* AGENT_TOKEN from forging a valid
// signature (that's the same "local write access" trust boundary the review's finding accepts as
// a given), but it does stop a write that doesn't also require reading the token file first.
/**
 * Fault taxonomy (docs/design/upgrade-resilience.md §3.1).
 *
 * The defect this exists to fix: `runPreToolUse` used to branch on `capability.riskTier` alone, so
 * "this principal has no grant" and "I could not find out" both emitted `deny` with a reason string
 * a human read as a permission problem. These name the second kind. A FAULT is never a decision —
 * it means the registry did not answer, and the ladder below decides what to do about that.
 */
const FAULT = {
  UNREACHABLE: 'unreachable', // no server on the socket at all
  SKEW: 'version-skew', // a server answered, but not in a contract we understand (the 2026-08-19 case)
  UNPARSEABLE: 'unparseable', // answered, JSON-shaped promise broken
  NO_PRINCIPAL: 'no-principal', // could not establish who is calling
  // The registry on this box may be answering perfectly — and be wrong, because it has not heard
  // from central inside MAX_POLICY_AGE. §2.4 calls this extending the policy from "cannot reach" to
  // "cannot trust", and it is a fault rather than a denial for exactly the reason the taxonomy
  // exists: nothing is wrong with the principal's permissions, and asking for a grant will not help.
  STALE_POLICY: 'stale-policy',
  // Phase 4 (docs/design/global-identity-and-central-db.md §2.7): the registry answered, and the
  // answer was "I have never heard of that" — from a node whose copy of the registry is a REPLICA
  // that may simply be behind. Under node authority "not in the registry" was a complete answer,
  // because there was nowhere else it could be; under central authority it is two answers wearing
  // one face, and only one of them is a decision. This names the other one.
  NOT_REPLICATED: 'not-replicated',
};

/**
 * The two kinds of "no" this hook can emit — and the distinction the fault taxonomy above existed
 * to make internally but never carried out to the caller.
 *
 *   POLICY — governance answered, and the answer was no. A grant is missing. The agent should stop
 *            asking and get one; retrying changes nothing.
 *   FAULT  — governance did not answer, so the call failed closed. NOTHING is wrong with the
 *            principal's permissions. The agent should retry once the service is back, and a human
 *            should go and look at the service.
 *
 * The harness protocol has exactly three verdicts (allow/deny/ask), so a fault cannot be a fourth
 * one — a fault still *emits* deny. What makes it distinguishable is this tag, which leads every
 * reason string: `[governance:denied]` vs `[governance:fault/unreachable]`. It is the only part of
 * a decision an agent actually receives, so it is where the classification has to live; the
 * journal and the log carry the same `denialKind` for the human side.
 */
const DENIAL = { POLICY: 'policy', FAULT: 'fault' };

/**
 * A fault-time reason. Says outright that this is not a permission problem, because the failure
 * mode being fixed is an agent reading a fail-closed deny as "I lack access" and going off to ask
 * for a grant it already has.
 */
function faultReason(fault, { detail, remedy } = {}) {
  return (
    `[governance:${DENIAL.FAULT}/${fault}] Governance could not be consulted, so this call failed ` +
    'closed. This is NOT a permission denial — no grant is missing and asking for one will not ' +
    `help. ${detail ? `${detail} ` : ''}${remedy || 'Retry once the governance service answers again.'}`
  );
}

/** A policy reason: governance was healthy and said no. `note` qualifies *how* it decided. */
function policyReason(text, note) {
  return `[governance:denied] ${text}${note ? ` (${note})` : ''}`;
}

function signPayload(payload) {
  return crypto.createHmac('sha256', AGENT_TOKEN).update(payload).digest('hex');
}

function writeSignedCache(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(data);
  fs.writeFileSync(filePath, JSON.stringify({ payload, sig: signPayload(payload) }));
}

function readSignedCache(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { payload, sig } = JSON.parse(raw);
  if (typeof payload !== 'string' || typeof sig !== 'string') return null;
  const expected = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // tampered or stale-key — discard
  return JSON.parse(payload);
}

function loadCapabilityCache({ allowStale = false } = {}) {
  try {
    const cache = readSignedCache(CAPABILITY_CACHE_PATH);
    if (!cache) return null;
    if (!allowStale && Date.now() - cache.fetchedAt > CAPABILITY_CACHE_TTL_MS) return null; // stale — refetch
    return cache.capabilities;
  } catch {
    return null;
  }
}

function saveCapabilityCache(capabilities) {
  writeSignedCache(CAPABILITY_CACHE_PATH, { fetchedAt: Date.now(), capabilities });
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
 * still apply correctly. Only throws
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

/**
 * The principal cache is keyed by `loomId` and kept for the life of the file — no TTL, because an
 * agent's own identity doesn't change mid-life. What *can* change underneath it is which principal
 * a grant is read off: the phase-5 flip to the OS subject, or simply a second person driving looms
 * on this machine. Either leaves warm entries answering for a subject that no longer applies, and
 * nothing about the entry itself would show it (docs/design/global-identity-and-central-db.md
 * §1.6, want-mszgwnz1-22). Two stamps close that, both checked on read:
 *
 *   - `epoch` — GRANT_SUBJECT_EPOCH (server/principals/subject.js), bumped by any change that
 *     moves the grant subject. A mismatch discards the whole file.
 *   - `subjects` — the subjectId each entry was resolved under, for entries a *hook* wrote. An
 *     entry stamped with a different subject than this call's is a miss and re-resolves.
 *
 * Entries carry no subject stamp when server/cacheWarmer.js wrote them; those are mirrored from
 * the live db on a timer, so they are fresh by construction and are used as-is.
 *
 * The file is not deleted on a mismatch: returning an empty cache re-resolves every loom, and the
 * next savePrincipalCache rewrites the file under the current stamps.
 */
function loadPrincipalCache() {
  try {
    const cache = readSignedCache(PRINCIPAL_CACHE_PATH);
    if (!cache || typeof cache !== 'object') return emptyPrincipalCache();
    // A file written before this envelope existed has no epoch and is invalidated by the same
    // check, which is what a bare pre-epoch cache deserves.
    if (cache.epoch !== GRANT_SUBJECT_EPOCH) return emptyPrincipalCache();
    return {
      epoch: cache.epoch,
      principals: cache.principals || {},
      subjects: cache.subjects || {},
    };
  } catch {
    return emptyPrincipalCache();
  }
}

function emptyPrincipalCache() {
  return { epoch: GRANT_SUBJECT_EPOCH, principals: {}, subjects: {} };
}

/**
 * A cached entry is usable only if it was resolved under the subject this call is running as.
 * An unstamped entry is the cache warmer's (see loadPrincipalCache) and is always usable; a call
 * with no subject at all (the SID read failed) can't compare, and takes the entry rather than
 * forcing a round trip on every call in a process that will never resolve one.
 */
function principalCacheHit(cache, loomId, subjectId) {
  const entry = cache.principals[loomId];
  if (!entry) return null;
  const stamp = cache.subjects[loomId];
  if (stamp && subjectId && stamp !== subjectId) return null;
  return entry;
}

function savePrincipalCache(cache) {
  writeSignedCache(PRINCIPAL_CACHE_PATH, cache);
}

/** The grant replica (server/cacheWarmer.js's refreshGrantCache), or null if absent/tampered. */
function loadGrantCache() {
  try {
    return readSignedCache(GRANT_CACHE_PATH);
  } catch {
    return null;
  }
}

/**
 * The same question app.js's `findActiveGrant` answers, asked of the replica instead of the db.
 * Kept deliberately in step with it — autoGrant, then a direct active grant, then the instance's
 * parentRole fallback — because a fault-time decision that is *more* permissive than the live one
 * would turn an outage into an escalation.
 *
 * `revokedAt` needs no check here: the warmer only ever writes grants the store already filtered
 * (`WHERE revokedAt IS NULL`). `expiresAt` does, and against the time of *this call* — a replica
 * written before a grant lapsed must not keep honouring it.
 */
function replicaGrantAllows(principal, capability, replica, now = Date.now()) {
  if (capability.autoGrant) return true;
  if (!replica || !Array.isArray(replica.grants)) return false;
  const active = (g) => !g.expiresAt || new Date(g.expiresAt) > new Date(now);
  const held = (principalId) =>
    replica.grants.some((g) => g.principalId === principalId && g.capabilityId === capability.id && active(g));

  if (held(principal.id)) return true;
  if (principal.kind === 'instance' && principal.parentRole) {
    const roleId = replica.roles && replica.roles[principal.parentRole];
    if (roleId && held(roleId)) return true;
  }
  return false;
}

/**
 * The always-full deny-list (§2.4), or null if there is none.
 *
 * Null is not "nothing is denied" — it is "this node has no deny-list at all", which on a machine
 * that expects one is a fault. policyChannelGate is where that distinction is made; this only
 * reports what is on disk.
 */
function loadPolicyDenyList() {
  try {
    return readSignedCache(POLICY_DENY_LIST_PATH);
  } catch {
    return null;
  }
}

/**
 * What the deny-list file says about who owns policy and how current this node's copy is.
 *
 * Both facts come off the same file for the same reason: a hook runs in the AGENT's environment,
 * not the service's, so it cannot read WINDROW_POLICY_AUTHORITY or WINDROW_CENTRAL_URL. Whoever
 * writes the deny-list — server/policy/policyClient.js on a replica node, server/cacheWarmer.js on
 * a standalone one — states them there, and this is the one place that interprets them.
 *
 * `replicating` is deliberately false when the file is missing. A hook that guessed "probably a
 * replica" from an absent file would fail an entire standalone install closed on the strength of a
 * warmer that has not run yet.
 */
function policyPosture(now = Date.now()) {
  const denyList = loadPolicyDenyList();
  if (!denyList) return { denyList: null, replicating: false, stale: false, ageMs: null, version: null };
  const replicating = denyList.authority === 'central';
  // A node whose deny-list has never been stamped is treated as infinitely old, not as fresh —
  // "never confirmed" is the strongest form of stale, not an exemption from it.
  const ageMs = denyList.fetchedAt ? now - denyList.fetchedAt : null;
  const stale = Boolean(denyList.central) && (ageMs === null || ageMs > MAX_POLICY_AGE_MS);
  return { denyList, replicating, stale, ageMs, version: denyList.version ?? null };
}

/**
 * THE POLICY CHANNEL GATE — the node-side half of docs/design/global-identity-and-central-db.md
 * §2.4, run on every governed call before the live grant check.
 *
 * Before, not after, and that ordering is the whole design. The live check consults this node's own
 * registry, which on an enrolled node is a *replica* of central: it can be perfectly healthy and
 * perfectly out of date. Running the deny-list only on a fault would mean a revoked grant kept
 * working for as long as the local server kept answering — which is precisely the "node with a
 * broken delta stream" §2.4 names, and the reason the deny-list is a separate channel rather than a
 * field on the replica.
 *
 * Two verdicts, in order:
 *
 *   1. REVOKED — the grant id, the principal+capability pair, or the principal itself is on the
 *      list. A hard deny for every tier, read_only included: a revocation is central saying "stop",
 *      and there is no tier for which honouring it is optional. Classified POLICY, not FAULT,
 *      because it is a real decision made by a healthy authority — the agent should stop asking.
 *
 *   2. STALE — no deny-list, or one older than MAX_POLICY_AGE. Handed to `faultPolicy` as
 *      FAULT.STALE_POLICY rather than decided here, so "cannot trust" degrades down the exact same
 *      ladder as "cannot reach": read_only allows, mutating denies unless a signed maintenance
 *      lease is in force, destructive asks under a lease and denies without one. One policy
 *      expressed once, which is the property the ladder was extracted to get.
 *
 * Returns null when the channel is healthy and says nothing — the overwhelmingly common case, and
 * the one that has to cost a file read and three Set lookups.
 *
 * Age is measured only where age is a meaningful claim: a standalone install writes `central: false`
 * (server/cacheWarmer.js) because its own database is the authority and there is no channel that
 * could be behind it. Applying a staleness bound there would fail a machine closed for being out of
 * date with itself.
 */
function policyChannelGate({ principal, capability, now = Date.now() }) {
  const { denyList } = policyPosture(now);

  if (denyList) {
    const pair = principal ? `${principal.id}:${capability.id}` : null;
    const revoked =
      (principal && denyList.principals && denyList.principals.includes(principal.id))
      || (pair && denyList.pairs && denyList.pairs.includes(pair));
    if (revoked) {
      // Deliberately NOT routed through enforcementPauseOverride. A debugging window suppresses
      // "you have no grant for this"; a revocation is central saying "your access was taken away",
      // which is the one denial most likely to have been issued because of what the person wanting
      // the window was doing. See server/enforcementPause.js.
      journalFault({
        fault: null,
        tier: capability.riskTier,
        capability: capability.name,
        outcome: 'deny',
        why: 'deny-list',
        denialKind: DENIAL.POLICY,
        principalId: principal ? principal.id : null,
        policyVersion: denyList.version,
      });
      return {
        decision: 'deny',
        reason: policyReason(
          `Access to "${capability.name}" has been revoked.`,
          'on the revocation list, which is enforced even when the rest of the policy channel is not'
        ),
      };
    }
  }

  // Age. `fetchedAt` is stamped only on a successful fetch (server/policy/replica.js), so a node
  // that cannot reach central genuinely gets older here rather than resetting its own clock.
  //
  // An ABSENT file is not stale, and that is a deliberate refusal to guess. A hook cannot see the
  // server's WINDROW_CENTRAL_URL — it runs in the agent's environment, not the service's — so
  // "there is no deny-list" is ambiguous between "no central is configured", "the warmer has not
  // run yet on a server that started four seconds ago" and "the client cannot authenticate". Rather
  // than fail every install closed on the strength of a missing file, the writer resolves the
  // ambiguity: server/policy/policyClient.js lays down a `central: true, fetchedAt: null` marker the
  // moment it knows a central is configured — including when it cannot reach it — so the
  // never-confirmed case arrives here as a present file with no timestamp, and is caught below.
  if (!denyList) return null;
  const stale = Boolean(denyList.central) && (!denyList.fetchedAt || now - denyList.fetchedAt > MAX_POLICY_AGE_MS);
  if (!stale) return null;

  const ageMs = denyList.fetchedAt ? now - denyList.fetchedAt : null;
  const detail = ageMs === null
    ? 'This node has never confirmed policy with central, so its grants cannot be trusted.'
    : `This node last confirmed policy with central ${Math.round(ageMs / 1000)}s ago, past the ${Math.round(MAX_POLICY_AGE_MS / 1000)}s limit.`;
  const verdict = faultPolicy({ fault: FAULT.STALE_POLICY, capability, principal, now });
  if (verdict.decision === 'allow' && verdict.journal.why === 'read_only') {
    // read_only under a stale policy stays open (§2.4), and journalling that would write a line per
    // read for the whole outage — the fault journal is for calls whose decision was *degraded*, and
    // this one is not.
    return null;
  }
  journalFault({ ...verdict.journal, policyAgeMs: ageMs, principalId: principal ? principal.id : null });
  return verdict.decision === 'allow'
    ? null
    : { decision: verdict.decision, reason: verdict.reason || faultReason(FAULT.STALE_POLICY, { detail }) };
}

/**
 * One line per call decided without the server. Best-effort by construction: a hook that cannot
 * reach the API must not also die because it could not write its own journal, so every failure
 * here is swallowed. Recovery reads this to answer "what ran while governance was down" — a query,
 * rather than the gap it is today.
 */
function journalFault(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(FAULT_JOURNAL_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* never let the audit trail take down the call it is describing */
  }
}

// A native call's most useful single dimension after the tool name, and the one place this path
// could leak something it shouldn't. The rule is per-tool rather than "stringify tool_input":
//
//   file-shaped tools  → the path or pattern, which is the whole point ("which files did it read")
//   Bash               → the FIRST TOKEN ONLY, i.e. the program. `git`, `npm`, `curl` answers
//                        "what is this loom reaching for" without spooling a command line that
//                        routinely carries tokens, passwords and heredoc'd file content into a
//                        log that is read casually and replicated across workspaces by the rollup.
//   anything else      → nothing. An unrecognized tool records its name and no arguments, so a
//                        tool added upstream tomorrow cannot start leaking through this by default.
const NATIVE_DETAIL_FIELD = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Skill: 'skill',
  Task: 'subagent_type',
  Agent: 'subagent_type',
};
const NATIVE_DETAIL_MAX = 200;

function nativeCallDetail(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = toolInput.command;
    if (typeof command !== 'string') return null;
    const program = command.trim().split(/\s+/)[0];
    return program ? program.slice(0, NATIVE_DETAIL_MAX) : null;
  }
  const field = NATIVE_DETAIL_FIELD[toolName];
  if (!field) return null;
  const value = toolInput[field];
  return typeof value === 'string' && value ? value.slice(0, NATIVE_DETAIL_MAX) : null;
}

/**
 * One spool line per native tool call. Best-effort by exactly the same rule as journalFault: an
 * observability record must never be able to fail the call it describes, so every error here is
 * swallowed and the tool proceeds as if this feature did not exist.
 *
 * The identity is read with `skipSubject` — see server/principals/fromEnv.js for why (a subject
 * read is a child process per hook, and this path is supposed to cost one write). Everything on
 * the line is either free env-reading or already in hand.
 */
function observeNativeCall({ toolName, toolInput, sessionId, backendHint, outcome, reason = null }) {
  if (!OBSERVE_NATIVE_TOOLS || !toolName) return;
  try {
    // Only the *cap* is checked here, not the file's whole state: statSync on an existing file is
    // a single cheap stat, and skipping it would trade the disk backstop for nothing measurable.
    try {
      if (fs.statSync(NATIVE_JOURNAL_PATH).size >= NATIVE_JOURNAL_MAX_BYTES) return;
    } catch {
      /* no spool yet — that is the empty case, not an error */
    }
    const { identityFromEnv } = require('../principals/fromEnv');
    const identity = identityFromEnv(process.env, { backendHint, skipSubject: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      NATIVE_JOURNAL_PATH,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        toolName,
        detail: nativeCallDetail(toolName, toolInput),
        outcome, // 'ok' | 'error' | 'denied'
        reason,
        sessionId: sessionId || null,
        loomId: identity.loomId,
        humanName: identity.humanName,
        backend: identity.backend,
        agentType: identity.agentType,
        field: identity.field,
        standalone: identity.standalone,
        osUser: identity.osUser,
        hostname: identity.hostname,
      })}\n`
    );
  } catch {
    /* never let an observation take down the call it is observing */
  }
}

/**
 * THE ONE PLACE A DENIAL IS SUPPRESSED. Every deny site in this file routes its would-be decision
 * through here first, so "is enforcement paused?" is asked once, answered the same way everywhere,
 * and journalled identically however the denial arose.
 *
 * `tier` is the capability's risk tier, or `null` when the denial happened before we could learn it
 * — an unresolvable capability, or one absent from a stale replica. A null tier is only covered by
 * a pause that names every tier; see server/enforcementPause.js.
 *
 * Returns null when enforcement is on (the overwhelmingly common case — one file read). Otherwise
 * returns an allow verdict carrying the audit row: a call that got through because denials were off
 * is exactly the call someone will need to find afterwards, and the pause id on the row is what
 * ties it to the window that let it through.
 *
 * `emit` decides who writes that row. Sites that emit a decision directly pass `true` and this
 * writes it; `faultPolicy` passes `false` because its own contract is to *return* a journal entry
 * its caller writes, and journalling here as well would put the call in the audit trail twice.
 */
function enforcementPauseOverride({
  tier,
  capability,
  principalId = null,
  why,
  fault = null,
  now = Date.now(),
  emit = true,
}) {
  const pause = readEnforcementPause(now);
  if (!pause) return null;
  const covered = tier === null || tier === undefined ? pauseCoversUnknownTier(pause) : pauseCovers(pause, tier);
  if (!covered) return null;
  const journal = {
    fault,
    tier,
    capability,
    outcome: 'allow',
    why: 'enforcement-pause',
    // What the decision WOULD have been, kept because the row is otherwise indistinguishable from
    // an ordinary allow and the interesting question about this window is what it changed.
    suppressed: why,
    enforcementPause: pause.id,
    pauseReason: pause.reason,
    pauseUntil: new Date(pause.until).toISOString(),
    principalId,
  };
  if (emit) journalFault(journal);
  log(
    `ENFORCEMENT PAUSED (${pause.id}) — suppressing ${tier || 'unknown-tier'} denial "${why}" on ` +
      `${capability} until ${new Date(pause.until).toISOString()} ("${pause.reason}")`
  );
  return { decision: 'allow', reason: undefined, journal };
}

/**
 * The degradation ladder (docs/design/upgrade-resilience.md §3.3) — what to do when the registry
 * did not answer. Replaces the old `failOpen = riskTier === 'read_only'` boolean.
 *
 *   read_only            → allow. Unchanged from before; a read that was already fail-open stays so.
 *   mutating, no lease   → deny. Unchanged from before, and this is the security property:
 *                          killing the server must not become write access (vulnerability-review
 *                          finding #3). A fault alone relaxes NOTHING.
 *   mutating, leased     → run the real grant check against the replica. A revoked or expired
 *                          grant still denies; only a genuinely-granted call gets through.
 *   destructive          → `ask` while a lease is in force (a human decides, not a cache), else
 *                          deny. Never auto-allowed, which is why `destructive` is not a leasable
 *                          tier in server/maintenance.js.
 *
 * `principal` is null when the fault *was* the identity lookup. That is the 2026-08-19 case, so
 * handling it is the point rather than an edge: under a lease a `mutating` call is allowed
 * unattributed and journalled as such. This is the one genuine weakening in the design, and it is
 * bounded three ways — the lease is signed by a server that was healthy when it signed, it is
 * time-boxed, and every call it lets through is on disk in the fault journal.
 */
function faultPolicy({ fault, capability, principal, now = Date.now() }) {
  const verdict = faultPolicyStrict({ fault, capability, principal, now });
  if (verdict.decision === 'allow') return verdict;
  // Applied to the ladder's OUTPUT rather than woven into its branches, so the ladder keeps stating
  // the real policy in one readable piece and the pause stays a visible override on top of it — the
  // arrangement that makes "what would this have decided with enforcement on?" answerable by
  // deleting one line rather than re-reading five.
  const override = enforcementPauseOverride({
    tier: capability.riskTier,
    capability: capability.name,
    principalId: principal ? principal.id : null,
    why: verdict.journal.why,
    fault,
    now,
    emit: false, // this function's callers journal what it returns
  });
  return override || verdict;
}

function faultPolicyStrict({ fault, capability, principal, now = Date.now() }) {
  const tier = capability.riskTier;
  const lease = readGraceLease(now);
  const base = { fault, tier, capability: capability.name, lease: lease ? lease.id : null };

  if (tier === 'read_only') {
    return { decision: 'allow', reason: undefined, journal: { ...base, outcome: 'allow', why: 'read_only' } };
  }

  if (tier === 'destructive') {
    if (lease) {
      return {
        decision: 'ask',
        reason: faultReason(fault, {
          detail:
            `"${capability.name}" is destructive and its grant cannot be checked, and maintenance ` +
            `"${lease.reason}" is in force.`,
          remedy: 'Approve this one call?',
        }),
        journal: { ...base, outcome: 'ask', why: 'destructive-under-lease', denialKind: DENIAL.FAULT },
      };
    }
    return {
      decision: 'deny',
      reason: faultReason(fault, {
        detail: `"${capability.name}" is destructive, and destructive calls fail closed rather than guess.`,
      }),
      journal: { ...base, outcome: 'deny', why: 'destructive-no-lease', denialKind: DENIAL.FAULT },
    };
  }

  // mutating
  if (!leaseCovers(lease, tier)) {
    return {
      decision: 'deny',
      reason: faultReason(fault, {
        detail: `"${capability.name}" is mutating, and no maintenance grace lease is in force.`,
      }),
      journal: { ...base, outcome: 'deny', why: 'no-lease', denialKind: DENIAL.FAULT },
    };
  }

  if (!principal) {
    return {
      decision: 'allow',
      reason: undefined,
      journal: { ...base, outcome: 'allow', why: 'unattributed-under-lease', unattributed: true },
    };
  }

  const replica = loadGrantCache();
  const replicaAgeMs = replica && replica.fetchedAt ? now - replica.fetchedAt : null;
  const allowed = replicaGrantAllows(principal, capability, replica, now);

  if (allowed) {
    return {
      decision: 'allow',
      reason: undefined,
      journal: {
        ...base,
        outcome: 'allow',
        why: 'replica-grant-check',
        principalId: principal.id,
        replicaAgeMs,
      },
    };
  }

  // The two denials below are the same `false` from replicaGrantAllows and are NOT the same event,
  // which is the conflation this whole taxonomy exists to end. With a replica we consulted real
  // grant data and found none — a policy denial that happens to have been decided offline, and one
  // a human should answer by granting. With no replica we consulted nothing: `replicaGrantAllows`
  // returns false for a missing cache exactly as it does for a missing grant, so calling that a
  // permission problem would blame the principal for the warmer never having run.
  if (!replica) {
    return {
      decision: 'deny',
      reason: faultReason(fault, {
        detail:
          `There is no local grant replica to fall back on, so "${capability.name}" could not be ` +
          'checked at all.',
      }),
      journal: { ...base, outcome: 'deny', why: 'no-replica', denialKind: DENIAL.FAULT, principalId: principal.id },
    };
  }

  return {
    decision: 'deny',
    reason: policyReason(
      `No active grant for ${capability.kind} "${capability.name}".`,
      `decided from the local grant replica because governance is unavailable: ${fault}`
    ),
    journal: {
      ...base,
      outcome: 'deny',
      why: 'replica-grant-check',
      denialKind: DENIAL.POLICY,
      principalId: principal.id,
      replicaAgeMs,
    },
  };
}

/** Applies a faultPolicy result: journals it, logs it, and emits the decision. */
function emitFault(decideFn, policy, extra = {}) {
  journalFault({ ...policy.journal, ...extra });
  log(
    `fault(${policy.journal.fault}) on ${policy.journal.tier} ${policy.journal.capability} -> ${policy.decision}` +
      // The kind is on the log line and not only in the journal because this is what a human tails
      // during an outage: a `policy` deny here means the replica genuinely had no grant, so
      // restoring the service will not make that call start working.
      `${policy.journal.denialKind ? `/${policy.journal.denialKind}` : ''}` +
      ` [${policy.journal.why}${policy.journal.lease ? `, lease ${policy.journal.lease}` : ''}]`
  );
  decideFn(policy.decision, policy.reason);
}

/**
 * The subject key this machine's hooks have already registered
 * (docs/design/global-identity-and-central-db.md §1.4). Deliberately a *separate* file from the
 * principal cache rather than a field on its entries: that file is also rewritten from the db by
 * server/cacheWarmer.js, which knows nothing about what a hook has posted, so a marker living in it
 * would be erased every warm cycle and every hook call after one would re-post. This file only the
 * hook writes.
 *
 * Why a marker is needed at all: the principal cache is keyed by loomId, so a loom that was already
 * cached never posts a resolve again and would never register its subject. One post per machine per
 * subject closes that, off the hot path for every call after the first.
 */
function loadSubjectMarker() {
  try {
    return readSignedCache(SUBJECT_MARKER_PATH) || {};
  } catch {
    return {};
  }
}

function saveSubjectMarker(subjectId) {
  writeSignedCache(SUBJECT_MARKER_PATH, { subjectId, registeredAt: Date.now() });
}

/**
 * Resolve the real principal behind this hook invocation.
 *
 * Identity itself is still derived locally (server/principals/fromEnv.js) — only this process can
 * see its own environment. What is *no longer* local is the write: registering that identity used
 * to be `store.load()` → `upsertPrincipalFromIdentity` → `store.save()` right here, which is
 * store.js's `replaceAll` — a whole-database rewrite, off a snapshot read microseconds earlier,
 * issued by a process that never passed `requireAuth`. That lost any row written in between and
 * handed every hook (for every principal, trusted or not) a direct write path into the entire
 * registry. The upsert now happens server-side, behind `POST /api/principals/resolve`
 * (server/app.js), as a narrow two-row transaction. See docs/design/global-identity-and-central-db.md,
 * phase 0.
 *
 * `backendHint` (docs/design/cross-field-and-standalone.md) is passed by a backend-specific hook
 * entry point (agy, codex) so a standalone identity is attributed to the right backend without
 * guessing from env vars alone. `identityFromEnv` never returns `null` any more — a process with
 * no platform agent id resolves to a deterministic "standalone" identity instead of going
 * ungoverned — so this function no longer returns `null` for that reason either; a `null` return
 * now only happens on an actual resolution error (caller still treats it as fail-open/closed).
 *
 * Cached per agent id for the life of the cache file, so the common case (an agent already
 * registered) stays a single fs read with no API round trip at all — the same reason it was
 * cached when the upsert was local, and now also what keeps this route off the hot path.
 */
async function resolvePrincipal(backendHint) {
  const { identityFromEnv } = require('../principals/fromEnv');

  const identity = identityFromEnv(process.env, { backendHint });
  // osUser/hostname are the *current* OS identity, read fresh above (not part of the cached
  // principal record, which is keyed by loomId and reused across calls) — attach them to the
  // returned object on every call, cache hit or not, so a caller always has this call's real
  // computer-account info rather than whatever was true the first time this agent registered.
  // The actor* fields ride along for the same reason: they describe *this call*, so they come
  // from the identity just read out of the environment rather than from the cached principal
  // record (whose registered values can differ — see the identityDrift handling in app.js's
  // /principals/resolve, which deliberately keeps the registered ones).
  const withOsIdentity = (instance) => ({
    ...instance,
    osUser: identity.osUser,
    hostname: identity.hostname,
    actorLoomId: identity.loomId || null,
    actorAgentType: identity.agentType || null,
    actorBackend: identity.backend || null,
    actorField: identity.field || null,
    // The subject, and the tier it was read at, for *this* call — freshly derived above like
    // osUser/hostname rather than taken from the cached principal record. That matters more here
    // than anywhere else: the subject principal's stored assurance only ratchets up, so a call made
    // in a process where the SID read failed must report tier 1 on its own event even though the
    // row it lands under says 2 (docs/design/global-identity-and-central-db.md §1.4).
    subjectId: identity.subjectId || null,
    assuranceLevel: identity.assuranceLevel ?? null,
  });

  const cache = loadPrincipalCache();
  const cached = principalCacheHit(cache, identity.loomId, identity.subjectId);
  // A cache hit still owes one thing to the server: the *subject*. The cache is keyed by loomId, so
  // a warm loom would otherwise never report which OS account is behind it, and a machine whose
  // looms are all cached would register no subject at all
  // (docs/design/global-identity-and-central-db.md §1.4). Posting once per subject per machine
  // keeps that from being true, without putting a round trip on the hot path of every call.
  if (cached) {
    if (identity.subjectId && loadSubjectMarker().subjectId !== identity.subjectId) {
      try {
        await postIdentity(identity);
        saveSubjectMarker(identity.subjectId);
      } catch (err) {
        // Registering the subject changes no decision yet (phase 1 observes), so failing to do it
        // must not fail the tool call that triggered it — the actor is already resolved.
        log(`subject registration failed, continuing: ${err.message}`);
      }
    }
    return withOsIdentity(cached);
  }

  // Cache miss (first hook call for this agent instance) — ask the server to register it. Only
  // the identity fields the registry actually stores are sent; osUser/hostname describe the call,
  // not the principal, and go on the usage event via /invoke instead.
  const { instance } = await postIdentity(identity);
  if (!instance) throw new Error('principal resolve returned no instance');

  cache.principals[identity.loomId] = instance;
  if (identity.subjectId) cache.subjects[identity.loomId] = identity.subjectId;
  savePrincipalCache(cache);
  if (identity.subjectId) saveSubjectMarker(identity.subjectId);
  return withOsIdentity(instance);
}

/**
 * The one registry write a hook makes: POST /api/principals/resolve with the identity this process
 * observed. `subjectId`/`assuranceLevel` are the *subject* — the OS account the call is accountable
 * to, read by server/principals/subject.js — as opposed to the loom/backend/agentType fields, which
 * describe the actor. osUser/hostname are still not sent: they describe the call and ride on the
 * usage event via /invoke.
 */
async function postIdentity(identity) {
  const res = await apiFetch('/principals/resolve', {
    method: 'POST',
    body: JSON.stringify({
      loomId: identity.loomId,
      humanName: identity.humanName,
      backend: identity.backend,
      agentType: identity.agentType,
      field: identity.field,
      standalone: identity.standalone,
      subjectId: identity.subjectId,
      assuranceLevel: identity.assuranceLevel,
      osUser: identity.osUser,
    }),
  });
  return (await res.json()) || {};
}

// `callIdentity` is the resolvePrincipal() return value — it carries the OS identity, the actor*
// fields and the subject key with its assurance tier, all of which describe *this call* rather than
// the principal row.
async function invoke(principalId, capabilityId, correlationId, callIdentity) {
  const res = await apiFetch('/invoke', {
    method: 'POST',
    body: JSON.stringify({
      principalId,
      capabilityId,
      correlationId,
      osUser: callIdentity && callIdentity.osUser,
      hostname: callIdentity && callIdentity.hostname,
      actorLoomId: callIdentity && callIdentity.actorLoomId,
      actorAgentType: callIdentity && callIdentity.actorAgentType,
      actorBackend: callIdentity && callIdentity.actorBackend,
      actorField: callIdentity && callIdentity.actorField,
      subjectId: callIdentity && callIdentity.subjectId,
      assuranceLevel: callIdentity && callIdentity.assuranceLevel,
    }),
  });
  return res.json();
}

async function patchUsageEvent(eventId, patch) {
  await apiFetch(`/usage/${eventId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/**
 * The PostToolUse-side counterpart to the `ask` branch in runPreToolUse below: corrects a
 * `denied` /invoke-time event to `approved` and leaves a consent record behind in the `approvals`
 * table (server/app.js's POST /usage/:id/approve-consent). Only ever called once PostToolUse has
 * already established the tool actually ran, i.e. the harness's own permission prompt got a "yes".
 */
async function approveConsentEvent(eventId, principalId, correlationId) {
  await apiFetch(`/usage/${eventId}/approve-consent`, {
    method: 'POST',
    body: JSON.stringify({ principalId, correlationId }),
  });
}

/**
 * Stable key linking a PreToolUse call to its PostToolUse counterpart (same process pair).
 * Keyed with the agent token (finding #7), not a bare unsalted hash: the inputs
 * (sessionId/toolName/toolInput) are all knowable or guessable ahead of time, so a plain
 * sha1 let a local process pre-place or overwrite another call's pending file — redirecting its
 * later correcting PATCH onto an unrelated eventId, corrupting the audit log. HMAC with a secret
 * only this server and its own hook processes hold means a pending filename can no longer be
 * produced without also holding that token.
 */
function pendingKey(sessionId, toolName, toolInput) {
  return crypto
    .createHmac('sha256', AGENT_TOKEN)
    .update(`${sessionId}|${toolName}|${JSON.stringify(toolInput || {})}`)
    .digest('hex');
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
  if (isWindrowSelfCallAttempt(toolName, toolInput)) {
    log(`blocked: ${toolName} appears to target the governance API/token directly:`, toolInput && toolInput.command);
    // The one native-tool decision this system actually enforces, and until now the only trace it
    // left was a line on the hook's own stderr — a security-relevant *deny* with no audit row,
    // because the deny happens before any capability exists to hang a usage event off. It is
    // spooled here for the same reason the allows below are: a block nobody can see afterwards is
    // indistinguishable from one that never fired. This is also why the deny is recorded even when
    // the observation feature is otherwise the cheap best-effort path — it is the rare case, not
    // the hot one.
    observeNativeCall({
      toolName,
      toolInput,
      sessionId,
      backendHint,
      outcome: 'denied',
      reason: 'targets the governance API or its token file',
    });
    // A policy denial even though no grant was consulted: this is a standing rule, it is the same
    // answer from a perfectly healthy server, and retrying when the service comes back will not
    // change it — which is exactly what the `policy` tag promises the reader.
    decideFn('deny', policyReason('Direct shell access to the governance API or its token file is not permitted.'));
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
    // Still fail-closed, and deliberately outside the ladder below: the ladder branches on
    // `capability.riskTier`, and this is the one fault where the tier itself is unknown. A grace
    // lease cannot help — it names the tiers it tolerates, and we cannot say which one this is.
    log(`governance API unreachable resolving capability ${target.kind}/${target.name} (no cache):`, err.message);
    // A pause naming every tier covers this; anything narrower cannot, because the tier is exactly
    // what we failed to learn (server/enforcementPause.js).
    if (
      enforcementPauseOverride({
        tier: null,
        capability: `${target.kind}/${target.name}`,
        why: 'tier-unknown',
        fault: err.fault || FAULT.UNREACHABLE,
      })
    ) {
      decideFn('allow', undefined);
      return;
    }
    journalFault({
      fault: err.fault || FAULT.UNREACHABLE,
      tier: null,
      capability: `${target.kind}/${target.name}`,
      outcome: 'deny',
      why: 'tier-unknown',
      denialKind: DENIAL.FAULT,
    });
    decideFn(
      'deny',
      faultReason(err.fault || FAULT.UNREACHABLE, {
        detail: `The risk tier of ${target.kind} "${target.name}" is unknown, so it could not be tiered or checked.`,
      })
    );
    return;
  }
  const capabilityLookupMs = Date.now() - capabilityLookupStart;

  if (!capability) {
    // "NOT IN THE REGISTRY" STOPPED BEING A COMPLETE ANSWER AT PHASE 4, and this is the change to
    // the hook contract §2.7 warns about.
    //
    // While the node owned its own registry, an unregistered tool was ungoverned by definition:
    // there was no other registry it could be in. On a replica node there is — central's — and this
    // node's copy of it can be behind. So the absence has to be read against the copy's freshness:
    //
    //   fresh replica  → central genuinely has no such capability. Ungoverned, allow, as before.
    //   stale replica  → cannot tell. And unlike every other fault the ladder cannot help, because
    //                    the ladder branches on riskTier and the tier is exactly what is missing —
    //                    the same reason the tier-unknown branch above is a hard deny rather than a
    //                    degradation. Deny, and say why in terms an agent can act on.
    //
    // The asymmetry is intentional: a stale replica denies a tool it has never seen while still
    // allowing read_only tools it has. Failing an unknown tool closed costs a call; treating an
    // unreplicated destructive capability as ungoverned costs the guarantee.
    const posture = policyPosture();
    if (posture.replicating && posture.stale) {
      log(`no capability for ${target.kind}/${target.name} and the policy replica is stale — failing closed`);
      if (
        enforcementPauseOverride({
          tier: null,
          capability: `${target.kind}/${target.name}`,
          why: 'unknown-capability-stale-replica',
          fault: FAULT.NOT_REPLICATED,
        })
      ) {
        decideFn('allow', undefined);
        return;
      }
      journalFault({
        fault: FAULT.NOT_REPLICATED,
        tier: null,
        capability: `${target.kind}/${target.name}`,
        outcome: 'deny',
        why: 'unknown-capability-stale-replica',
        denialKind: DENIAL.FAULT,
        policyAgeMs: posture.ageMs,
        policyVersion: posture.version,
      });
      decideFn(
        'deny',
        faultReason(FAULT.NOT_REPLICATED, {
          detail: `${target.kind} "${target.name}" matches no capability this node holds, and this node's copy `
            + `of central policy is ${posture.ageMs === null ? 'unconfirmed' : `${Math.round(posture.ageMs / 1000)}s old`}, `
            + 'so it cannot tell an ungoverned tool from one it has not replicated yet.',
          remedy: 'Retry once this node has confirmed policy with central.',
        })
      );
      return;
    }
    log(`no registered capability for ${target.kind}/${target.name} — allowing, ungoverned`);
    decideFn('allow', undefined);
    return;
  }

  // Every governance error below goes through `faultPolicy` (the ladder) rather than the old
  // `failOpen = riskTier === 'read_only'` boolean. Same outcomes when no lease is in force —
  // read_only allows, mutating and destructive deny — so finding #3's property is unchanged by
  // default; a healthy server's signed, time-boxed grace lease is the only thing that softens it.
  const principalResolveStart = Date.now();
  let principal;
  try {
    principal = await resolvePrincipal(backendHint);
  } catch (err) {
    log('error resolving principal:', err.message);
    emitFault(decideFn, faultPolicy({ fault: err.fault || FAULT.NO_PRINCIPAL, capability, principal: null }), {
      detail: err.message,
    });
    return;
  }
  const principalResolveMs = Date.now() - principalResolveStart;

  if (!principal) {
    // resolvePrincipal() no longer returns null for "not running under the platform" — defensive
    // fallback only, for some other resolution failure that didn't throw.
    log(`principal resolution returned nothing unexpectedly for ${target.kind}/${target.name}`);
    emitFault(decideFn, faultPolicy({ fault: FAULT.NO_PRINCIPAL, capability, principal: null }));
    return;
  }

  // The policy channel, before the live check — see policyChannelGate for why the order matters.
  // On a healthy node this is one file read and returns null; it is the only thing standing between
  // a node whose delta stream is broken and a revoked grant that still works.
  const gate = policyChannelGate({ principal, capability });
  if (gate) {
    log(`${gate.decision}: ${target.kind}/${target.name} stopped by the policy channel for ${principal.name}`);
    decideFn(gate.decision, gate.reason);
    return;
  }

  const loomLabel = process.env.LOOM_AGENT_NAME
    ? `${process.env.LOOM_AGENT_NAME}(${process.env.LOOM_NODE_ID || 'no-node-id'})`
    : process.env.LOOM_NODE_ID || 'local';
  const correlationId = `${loomLabel}:${sessionId || 'no-session'}`;

  const grantCheckStart = Date.now();
  let result;
  try {
    result = await invoke(principal.id, capability.id, correlationId, principal);
  } catch (err) {
    log(`governance API error on /invoke for ${target.kind}/${target.name} (tier ${capability.riskTier}):`, err.message);
    emitFault(decideFn, faultPolicy({ fault: err.fault || FAULT.UNREACHABLE, capability, principal }), {
      principalId: principal.id,
      detail: err.message,
    });
    return;
  }
  const grantCheckMs = Date.now() - grantCheckStart;

  if (result.allowed) {
    // Remember the event id so PostToolUse can correct it with the real outcome/latency once the
    // tool actually finishes.
    const key = pendingKey(sessionId, toolName, toolInput);
    writePending(key, {
      eventId: result.event.id,
      // PATCH /api/usage/:id now requires the caller to assert the event's own principalId
      // (server/app.js) — a caller holding only the shared agent token can no longer correct an
      // event it didn't log itself, and this is how PostToolUse proves it's the same principal
      // that logged it, without a per-principal token to check.
      principalId: principal.id,
      startedAt: Date.now(),
      capabilityLookupMs,
      principalResolveMs,
      grantCheckMs,
    });
    decideFn('allow', undefined);
  } else if (
    enforcementPauseOverride({
      tier: capability.riskTier,
      capability: capability.name,
      principalId: principal.id,
      why: 'no-grant',
    })
  ) {
    // Governance was healthy, consulted, and said no — and a signed, time-boxed, admin-issued
    // debugging window says to let it through anyway. This is the branch the whole feature exists
    // for, and the only one where a *policy* decision (rather than a degraded one) is overturned.
    //
    // /invoke above has already logged this call as `denied`, which is now the wrong record: the
    // tool is about to run. The pending file is written for the same reason the `ask` branch below
    // writes one — so PostToolUse corrects the row with the real outcome instead of leaving the
    // audit trail claiming a call was blocked when it was not. Nothing here is silent; the
    // suppression is on stderr and in the fault journal with the pause id on it.
    const key = pendingKey(sessionId, toolName, toolInput);
    writePending(key, {
      eventId: result.event.id,
      principalId: principal.id,
      correlationId,
      startedAt: Date.now(),
      capabilityLookupMs,
      principalResolveMs,
      grantCheckMs,
    });
    decideFn('allow', undefined);
  } else if (capability.riskTier === 'destructive') {
    log(`asking: principal ${principal.name} has no active grant for destructive ${target.kind}/${target.name}`);
    // /invoke above already logged this call as
    // `denied` (no active grant), and the harness's own permission prompt is about to ask the
    // human — but this hook process exits before it learns their answer. Writing a pending file
    // here, tagged `ask: true`, is what lets PostToolUse tell "the human said yes" (the tool ran,
    // so PostToolUse fired) from "the human said no" (nothing ran, PostToolUse never fires and
    // this file is simply never claimed) and correct the record accordingly instead of leaving an
    // approved call recorded as denied forever.
    const key = pendingKey(sessionId, toolName, toolInput);
    writePending(key, {
      eventId: result.event.id,
      principalId: principal.id,
      correlationId,
      startedAt: Date.now(),
      capabilityLookupMs,
      principalResolveMs,
      grantCheckMs,
      ask: true,
    });
    decideFn(
      'ask',
      `destructive capability "${target.name}" has no active grant — approve this one call? (Recorded either way — an admin can extend a "yes" to a 1-hour grant from the Approvals page.)`
    );
  } else {
    log(`denied: principal ${principal.name} has no active grant for ${target.kind}/${target.name}`);
    // The reference policy denial, and what every `[governance:fault/…]` reason above is defined
    // against: governance was healthy, answered, and the answer was no.
    //
    // Phase 4 adds WHOSE policy said no. `result.policy` is stamped by server/app.js's /invoke and
    // carries the authority and the replica version the decision was made at. An agent told "no
    // grant" by a machine that is one of forty replicas deserves to know that asking the admin of
    // *this* machine will not help — the grant is issued centrally and arrives here by replication.
    const stamp = result.policy;
    decideFn('deny', policyReason(
      `No active grant for ${target.kind} "${target.name}".`,
      stamp && stamp.authority === 'central'
        ? `decided from central policy replicated to this node at version ${stamp.version}`
        : undefined
    ));
  }
}

/**
 * Shared PostToolUse core, used by all three backend adapters. `failed` is a pre-computed boolean
 * (each adapter's own outcome shape — Claude's `tool_response.is_error`, Antigravity's plain
 * `error` string, Codex's several guessed shapes — is decided by the caller before this runs).
 */
async function runPostToolUse({ toolName, toolInput, sessionId, backendHint, failed }) {
  const target = normalizeToolCall(toolName, toolInput);
  if (!target) {
    // Native tool — ungoverned, but no longer unrecorded. Observed from Post rather than Pre on
    // purpose, and it is the whole reason this costs nothing the user can feel: PreToolUse is the
    // call the harness *blocks on*, while PostToolUse runs after the tool has already produced its
    // result. Recording here also means the row carries the real ok/error outcome instead of a
    // guess made before the tool ran — the same correction the governed path needs two round trips
    // (invoke + PATCH) to make, for free, because nothing had to be written optimistically first.
    observeNativeCall({
      toolName,
      toolInput,
      sessionId,
      backendHint,
      outcome: failed ? 'error' : 'ok',
    });
    return;
  }

  const key = pendingKey(sessionId, toolName, toolInput);
  const pending = readAndClearPending(key);
  if (!pending) {
    // Denied, governance API was down at Pre-time, or a Post fired with no matching Pre —
    // nothing to correct either way.
    return;
  }

  if (pending.ask) {
    // Reaching PostToolUse at all means the tool actually ran, which for the `ask` branch is only
    // possible if the harness's own permission prompt got a "yes" — a "no" blocks the tool and
    // PostToolUse never fires, leaving this pending file simply unclaimed (see runPreToolUse).
    // There's no error/ok distinction to make here the way the allowed branch below has one; the
    // outcome this call cares about is "was it approved", already established by getting here.
    try {
      await approveConsentEvent(pending.eventId, pending.principalId, pending.correlationId);
    } catch (err) {
      log(`failed to record consent approval for event ${pending.eventId}:`, err.message);
    }
    return;
  }

  const outcome = failed ? 'error' : 'ok';
  const latencyMs = Math.max(0, Date.now() - pending.startedAt);

  try {
    await patchUsageEvent(pending.eventId, {
      principalId: pending.principalId,
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
  isWindrowSelfCallAttempt,
  observeNativeCall,
  nativeCallDetail,
  NATIVE_JOURNAL_PATH,
  findCapability,
  // Exported so the classification can be asserted from outside rather than only observed in a
  // reason string: FAULT/DENIAL name the kinds, faultPolicy is the ladder, and the two reason
  // builders are what any future decision path must use to stay inside the taxonomy.
  FAULT,
  DENIAL,
  faultReason,
  policyReason,
  faultPolicy,
  // The debugging pause's single suppression point, exported for the same reason faultPolicy is: it
  // is the one function in this file that can turn a deny into an allow on a healthy server, so it
  // has to be assertable directly rather than only through a full hook run.
  enforcementPauseOverride,
  // The policy distribution channel's node-side enforcement (§2.4) — exported for the same reason
  // faultPolicy is: the deny-list and the staleness bound are security properties, so they have to
  // be assertable directly rather than only through a full hook run.
  policyChannelGate,
  loadPolicyDenyList,
  POLICY_DENY_LIST_PATH,
  MAX_POLICY_AGE_MS,
  // Phase 4: how the hook reads who owns policy and how fresh this node's copy is. Exported for
  // server/policy/authority-test.js, which stages a stale replica and asserts the
  // unknown-capability rule above — the one branch of this file that changed meaning rather than
  // merely gaining a case.
  policyPosture,
  resolvePrincipal,
  invoke,
  patchUsageEvent,
  approveConsentEvent,
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
