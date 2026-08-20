#!/usr/bin/env node
'use strict';
// MCP server for the capability-governance API (registry/broker/usage-log). Exposes the same
// data the client dashboard shows — capabilities, principals, grants, usage, drift — as MCP tools
// so an agent can query and manage the registry directly instead of
// shelling out to curl or context-switching to the browser card. Complements (does not replace)
// the `open-capabilities-dashboard` skill: that skill is for *looking*, these tools are for
// *asking questions and acting* from inside a conversation.
//
// Auth: this server enrolls once and presents a per-node **proposer** client certificate over
// mutual TLS (docs/design/per-node-enrollment-credentials.md). It holds no bearer token and no
// admin authority at all. Point it elsewhere with WINDROW_API_URL; the credential itself lives in
// server/data/credentials/ and is created by enrolling, not by copying a secret.
//
// It used to read the shared admin token off disk, with `grant_capability`/`revoke_grant` carved
// out onto a separate proposer token (docs/design/governance-review-2026-08-16.md, F1) because
// holding admin here made this process a confused deputy: any agent granted either tool could ride
// this server's admin token straight to POST/DELETE /api/grants and self-escalate, through the
// front door, with nothing recorded.
//
// Per-node credentials collapse that carve-out into something simpler. There is one credential, it
// is proposer-scoped, and there is no admin authority present to be confused about. The propose
// routes still only queue a pending-approval row that a human clears in the dashboard, so the
// human-in-the-loop property is unchanged — what changed is that the stronger credential is not
// sitting here waiting to be misused.

const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
// Env vars are WINDROW_* only; the GOVERNANCE_* spellings were removed in tier 4 of
// docs/design/governance-to-windrow-rename.md and now stop the process rather than being ignored.
const { envCompat, assertNoLegacyEnv } = require('../server/config');

// Before anything reads configuration: name every removed GOVERNANCE_* var at once. This server is
// launched by an agent's MCP client, which surfaces a startup crash as "server failed to start" —
// so the message has to say which variable, or the operator sees only that the tools vanished.
assertNoLegacyEnv();

const https = require('https');
const enrollment = require('../server/enrollment/client');

const REPO_ROOT = path.join(__dirname, '..');
const BASE_URL = envCompat('API_URL', { fallback: 'https://localhost:4443/api' }).replace(/\/+$/, '');

// ONE credential, and it is the proposer one.
//
// This server used to hold *two* shared bearer tokens: the admin token for reads and a separate
// proposer token for the two propose calls. Splitting them was the fix for the confused deputy in
// docs/design/governance-review-2026-08-16.md F1 — an agent granted `grant_capability` could
// otherwise ride this server's admin token straight to POST /api/grants and self-escalate.
//
// With per-node credentials the split collapses into something simpler and stronger: this server
// enrolls once, as a `proposer`, and that is the only authority it can ever spend
// (docs/design/per-node-enrollment-credentials.md). It no longer holds admin authority to be
// confused about. Reads that genuinely require admin now fail with a 403 rather than quietly
// succeeding on borrowed authority, which is the correct answer — an agent should not be reading
// the audit log through this server with admin rights.
let credential = null;
function loadCredential() {
  if (credential) return credential;
  credential = enrollment.load('mcp');
  if (!credential) {
    throw new Error(
      'The windrow MCP server is not enrolled. Mint a proposer enrollment token with ' +
      'POST /api/enrollment-tokens {"scope":"proposer"} and enroll with ' +
      "require('./server/enrollment/client').enroll({name:'mcp', baseUrl:'https://localhost:4443', enrollmentToken:'<token>'})"
    );
  }
  return credential;
}

/**
 * One request against the API, authenticated by the TLS handshake rather than a header.
 *
 * `https.request` rather than `fetch`: undici does not accept an `https.Agent`, and a client
 * certificate is exactly what has to be attached to the connection. It also lets the agent be
 * reused across calls, which is the whole reason a long-lived process can afford mTLS where a
 * per-tool-call hook cannot (see the header of server/auth.js).
 */
function api(pathAndQuery, { method = 'GET', body } = {}) {
  const cred = loadCredential();
  const url = new URL(`${BASE_URL}${pathAndQuery}`);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      key: cred.key,
      cert: cred.cert,
      ca: cred.ca,
      // The server certificate's SAN is `localhost` even when the connection is made to 127.0.0.1.
      servername: 'localhost',
      agent: enrollment.agentFor(cred),
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (res.statusCode >= 400) {
          const msg = (data && data.error) || res.statusMessage;
          return reject(new Error(`${method} ${pathAndQuery} -> ${res.statusCode}: ${msg}`));
        }
        resolve(data);
      });
    });
    req.on('error', (err) => reject(new Error(
      `Could not reach the windrow API at ${BASE_URL} (${err.message}). Is the server running ` +
      '(npm start, or the Windrow Windows service)?')));
    req.end(payload);
  });
}

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries).toString();
}

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

function tool(server, name, description, schema, handler) {
  server.registerTool(
    name,
    { description, inputSchema: schema },
    async (args) => {
      try {
        return await handler(args || {});
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

const server = new McpServer({ name: 'windrow', version: '1.0.0' });

// ---------------------------------------------------------------------------
// Read: capabilities, principals, grants
// ---------------------------------------------------------------------------

tool(
  server,
  'list_capabilities',
  'List capabilities in the governance registry (skills and MCP tools), optionally filtered by kind, riskTier, or owner. Use this to see what could be called, and at what risk tier.',
  {
    kind: z.enum(['skill', 'mcp_tool']).optional(),
    riskTier: z.enum(['read_only', 'mutating', 'destructive']).optional(),
    owner: z.string().optional(),
  },
  async ({ kind, riskTier, owner }) => {
    let caps = await api('/capabilities');
    if (kind) caps = caps.filter((c) => c.kind === kind);
    if (riskTier) caps = caps.filter((c) => c.riskTier === riskTier);
    if (owner) caps = caps.filter((c) => c.owner === owner);
    return json(caps);
  }
);

tool(
  server,
  'list_principals',
  'List principals (agent roles or specific agent instances) in the registry, optionally filtered by kind ("role" or "instance") or a case-insensitive substring of name/humanName.',
  {
    kind: z.enum(['role', 'instance']).optional(),
    search: z.string().optional(),
  },
  async ({ kind, search }) => {
    let ps = await api('/principals');
    if (kind) ps = ps.filter((p) => p.kind === kind);
    if (search) {
      const needle = search.toLowerCase();
      ps = ps.filter(
        (p) =>
          (p.name || '').toLowerCase().includes(needle) ||
          (p.humanName || '').toLowerCase().includes(needle)
      );
    }
    return json(ps);
  }
);

tool(
  server,
  'whoami',
  "Resolve the current process's own agent-runtime identity from its environment (LOOM_NODE_ID etc.) and look up the matching principal in the registry, if one exists yet. Answers \"what am I, and what can I already do\" without needing to know a principal id up front.",
  {},
  async () => {
    const { identityFromEnv } = require(path.join(REPO_ROOT, 'server', 'principals', 'fromEnv.js'));
    const identity = identityFromEnv(process.env);
    const principals = await api('/principals');
    const principal = principals.find((p) => p.kind === 'instance' && p.name === identity.loomId) || null;
    let grants = [];
    let roleGrants = [];
    if (principal) {
      grants = await api(`/grants${qs({ principalId: principal.id })}`);
      if (principal.parentRole) {
        const rolePrincipal = principals.find((p) => p.kind === 'role' && p.name === principal.parentRole);
        if (rolePrincipal) {
          roleGrants = await api(`/grants${qs({ principalId: rolePrincipal.id })}`);
        }
      }
    }
    return json({ identity, principal, ownGrantCount: grants.length, inheritedGrantCount: roleGrants.length });
  }
);

tool(
  server,
  'list_grants',
  'List grants (a principal\'s permission to use a capability), optionally filtered by principalId and/or capabilityId. Pass names through find_principal/find_capability first if you only have names.',
  {
    principalId: z.string().optional(),
    capabilityId: z.string().optional(),
  },
  async ({ principalId, capabilityId }) => json(await api(`/grants${qs({ principalId, capabilityId })}`))
);

tool(
  server,
  'who_can_use',
  'Answer "who has access to this capability" — resolves a capability by exact id or by name (case-insensitive), then lists every principal with an active grant for it, including grants inherited from a role by instance principals.',
  { capability: z.string().describe('Capability id (cap_...) or its name, e.g. "code-review" or "wispfield_clear_field"') },
  async ({ capability }) => {
    const caps = await api('/capabilities');
    const cap = caps.find((c) => c.id === capability) || caps.find((c) => c.name.toLowerCase() === capability.toLowerCase());
    if (!cap) return errorResult(new Error(`No capability matching "${capability}"`));
    const [grants, principals] = await Promise.all([api(`/grants${qs({ capabilityId: cap.id })}`), api('/principals')]);
    const direct = grants.map((g) => {
      const p = principals.find((pp) => pp.id === g.principalId);
      return { principal: p ? p.humanName || p.name : g.principalId, kind: p ? p.kind : null, via: 'direct grant', expiresAt: g.expiresAt };
    });
    const grantedRoleNames = new Set(
      grants
        .map((g) => principals.find((p) => p.id === g.principalId))
        .filter((p) => p && p.kind === 'role')
        .map((p) => p.name)
    );
    const inherited = principals
      .filter((p) => p.kind === 'instance' && p.parentRole && grantedRoleNames.has(p.parentRole) && !grants.some((g) => g.principalId === p.id))
      .map((p) => ({ principal: p.humanName || p.name, kind: p.kind, via: `inherited from role "${p.parentRole}"`, expiresAt: null }));
    return json({ capability: { id: cap.id, name: cap.name, riskTier: cap.riskTier, owner: cap.owner }, hasAccess: [...direct, ...inherited] });
  }
);

// ---------------------------------------------------------------------------
// Write: grants — propose only (docs/design/governance-review-2026-08-16.md, F1). Destructive-tier
// as of this change, and deliberately *not* a direct write: these two queue a pending-approval row
// via the proposer token and return immediately. Nothing is actually granted or revoked until a
// human clears the request in the dashboard's Approvals page.
// ---------------------------------------------------------------------------

tool(
  server,
  'grant_capability',
  'Propose granting a principal permission to use a capability. This does not grant anything by itself — it queues a pending-approval request that a human must clear in the dashboard before it takes effect. 409 if a grant for that pair already exists.',
  {
    principalId: z.string(),
    capabilityId: z.string(),
    constraints: z.string().optional(),
    expiresAt: z.string().optional().describe('ISO 8601 timestamp; omit for a grant that never expires'),
  },
  // No token argument any more: this server has exactly one credential and it is proposer-scoped,
  // so there is nothing to select between. The propose endpoints are the only registry-touching
  // routes it can reach, and they queue an approval rather than changing anything.
  async ({ principalId, capabilityId, constraints, expiresAt }) => json(
    await api('/grants/propose', {
      method: 'POST',
      body: { principalId, capabilityId, constraints, expiresAt },
    })
  )
);

tool(
  server,
  'revoke_grant',
  'Propose revoking a grant by its id. This does not revoke anything by itself — it queues a pending-approval request that a human must clear in the dashboard before it takes effect.',
  { grantId: z.string() },
  async ({ grantId }) => json(
    await api(`/grants/${encodeURIComponent(grantId)}/propose-revoke`, { method: 'POST' })
  )
);

// ---------------------------------------------------------------------------
// Usage, summary, drift
// ---------------------------------------------------------------------------

tool(
  server,
  'get_usage',
  'List recent usage events (one call, logged win or lose), newest first, optionally filtered by principalId and/or capabilityId.',
  {
    principalId: z.string().optional(),
    capabilityId: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  },
  async ({ principalId, capabilityId, limit }) =>
    json(await api(`/usage${qs({ principalId, capabilityId, limit })}`))
);

tool(
  server,
  'get_usage_summary',
  'Aggregate usage over a time window: totals (calls, denied, denial rate, avg latency), broken down by capability, by principal, and by time bucket. Good for "what happened this week" questions.',
  {
    granularity: z.enum(['minute', 'hour', 'day']).optional(),
    windowMinutes: z.number().int().positive().optional(),
  },
  async ({ granularity, windowMinutes }) => json(await api(`/usage/summary${qs({ granularity, windowMinutes })}`))
);

tool(
  server,
  'get_drift',
  'Grants unused for 90+ days (prune candidates) and capabilities with a high denial rate (≥5 calls, ≥20% denied — either dead weight or a misconfigured principal). Good for "what\'s stale or broken" questions.',
  {},
  async () => json(await api('/drift'))
);

// ---------------------------------------------------------------------------
// Fleet rollup
// ---------------------------------------------------------------------------

tool(
  server,
  'get_fleet_summary',
  'Cross-workspace usage rollup: tracks every workspace, not just the one you are in — the whole fleet when a central store is configured, otherwise every workspace on this machine. Use this to see per-workspace call/denial counts, including standalone (non-platform) usage. The `source` field on the reply says which of the two you got.',
  {},
  async () => json(await api('/rollup/summary'))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('windrow-mcp-server failed to start:', err);
  process.exit(1);
});
