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

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware: requires `Authorization: Bearer <token>` matching either scoped secret.
 * Sets `req.tokenScope` to `'admin'` or `'agent'` so downstream routes (see `requireAdmin`) can
 * further restrict registry-mutating endpoints to the admin token only.
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
  return res.status(401).json({ error: 'unauthorized: missing or invalid API token' });
}

/** Express middleware: only the admin-scoped token may proceed. Chain after `requireAuth`. */
function requireAdmin(req, res, next) {
  if (req.tokenScope !== 'admin') {
    return res.status(403).json({ error: 'forbidden: this endpoint requires the admin token' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, TOKEN, TOKEN_PATH, AGENT_TOKEN, AGENT_TOKEN_PATH };
