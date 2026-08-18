'use strict';
// Closes "anything on localhost can self-grant": before this, the API had zero authentication —
// CORS only restricted which *browser origins* could call it, and CORS is not a security boundary
// against a same-machine process (curl, another local tool, a compromised MCP tool) making raw
// HTTP requests directly to :4000. Every request now needs a bearer token that matches a secret
// generated on first run and kept out of git.
//
// Two scoped tokens, not one (docs/design/governance-vulnerability-review.md, finding #1/#8): a
// single shared token meant every PreToolUse/PostToolUse hook process — spawned fresh per tool
// call, for every principal, including untrusted skills — held enough power to call
// `POST /api/grants` and self-escalate to any capability. Now:
//   - the **admin** token (server/data/api-token) is for the human-facing dashboard (embedded in
//     the built client JS at build time, same as before) and CLI/admin scripts. It's the only
//     token that can mutate the registry: capabilities, principals, grants, discovery.
//   - the **agent** token (server/data/agent-api-token) is the one every hook process reads
//     (server/hooks/lib.js). It can only do what a governed tool call actually needs: resolve a
//     capability (`GET /capabilities`), check/log a call (`POST /invoke`,
//     `PATCH /usage/:id`). It is rejected by every registry-mutating route (see `requireAdmin`
//     below and its use in server/app.js), so a compromised skill/hook/bash call that reads this
//     file off disk still cannot grant itself anything.
// Both live under server/data/ (gitignored) so local, trusted call sites — the Vite dev proxy
// (client/vite.config.ts), the hooks, CLI scripts — can read them off disk without either being
// checked in or exposed to a browser. Set GOVERNANCE_API_TOKEN / GOVERNANCE_AGENT_TOKEN to
// override (e.g. in CI, or to share tokens across a fleet of hosts) instead of relying on the
// generated files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_PATH = process.env.GOVERNANCE_API_TOKEN_PATH || path.join(__dirname, 'data', 'api-token');
const AGENT_TOKEN_PATH =
  process.env.GOVERNANCE_AGENT_TOKEN_PATH || path.join(__dirname, 'data', 'agent-api-token');
// Third scope (docs/design/governance-review-2026-08-16.md, F1): the governance MCP server used to
// hold the *admin* token so it could call `grant_capability`/`revoke_grant`, which meant any agent
// with a grant for those two tools could ride the MCP server's admin token straight to
// `POST /api/grants` and self-escalate — the deputy (mcp/server.js) was confused about whose
// authority it was spending. The proposer token can reach only the propose endpoints
// (`POST /api/grants/propose`, `POST /api/grants/:id/propose-revoke`), which never touch the
// `grants` table directly — they just queue an `approvals` row. Only the admin token can
// approve/deny one, so a human is now structurally in the loop for anything this token requests.
const PROPOSER_TOKEN_PATH =
  process.env.GOVERNANCE_PROPOSER_TOKEN_PATH || path.join(__dirname, 'data', 'proposer-api-token');

function loadOrCreateToken(envVar, tokenPath) {
  if (process.env[envVar]) return process.env[envVar].trim();
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // no token file yet — generate one below
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

const TOKEN = loadOrCreateToken('GOVERNANCE_API_TOKEN', TOKEN_PATH);
// Guard against ever generating the same value for both tokens (astronomically unlikely, but the
// whole point of the split is that these two scopes are never interchangeable).
let AGENT_TOKEN = loadOrCreateToken('GOVERNANCE_AGENT_TOKEN', AGENT_TOKEN_PATH);
if (AGENT_TOKEN === TOKEN) {
  AGENT_TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(AGENT_TOKEN_PATH, AGENT_TOKEN, { mode: 0o600 });
}
let PROPOSER_TOKEN = loadOrCreateToken('GOVERNANCE_PROPOSER_TOKEN', PROPOSER_TOKEN_PATH);
while (PROPOSER_TOKEN === TOKEN || PROPOSER_TOKEN === AGENT_TOKEN) {
  PROPOSER_TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(PROPOSER_TOKEN_PATH, PROPOSER_TOKEN, { mode: 0o600 });
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware: requires `Authorization: Bearer <token>` matching one of the three scoped
 * secrets. Sets `req.tokenScope` to `'admin'`, `'agent'`, or `'proposer'` so downstream routes
 * (see `requireAdmin`/`requireProposer`) can further restrict what each scope may do.
 */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return res.status(401).json({ error: 'unauthorized: missing or invalid API token' });
  }
  if (safeEqual(value, TOKEN)) {
    req.tokenScope = 'admin';
    return next();
  }
  if (safeEqual(value, AGENT_TOKEN)) {
    req.tokenScope = 'agent';
    return next();
  }
  if (safeEqual(value, PROPOSER_TOKEN)) {
    req.tokenScope = 'proposer';
    return next();
  }
  return res.status(401).json({ error: 'unauthorized: missing or invalid API token' });
}

/** Express middleware: only the admin-scoped token may proceed. Chain after `requireAuth`. */
function requireAdmin(req, res, next) {
  if (req.tokenScope !== 'admin') {
    return res.status(403).json({ error: 'forbidden: this endpoint requires the admin token' });
  }
  next();
}

/**
 * Express middleware: the admin token or the proposer token may proceed — the propose endpoints
 * (server/app.js's POST /api/grants/propose, POST /api/grants/:id/propose-revoke) are the one
 * place a non-admin caller is allowed to *initiate* a registry change, precisely because they
 * can't make it take effect on their own (see PROPOSER_TOKEN_PATH comment above). Chain after
 * `requireAuth`.
 */
function requireProposer(req, res, next) {
  if (req.tokenScope !== 'admin' && req.tokenScope !== 'proposer') {
    return res.status(403).json({ error: 'forbidden: this endpoint requires the admin or proposer token' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireProposer,
  TOKEN,
  TOKEN_PATH,
  AGENT_TOKEN,
  AGENT_TOKEN_PATH,
  PROPOSER_TOKEN,
  PROPOSER_TOKEN_PATH,
};
