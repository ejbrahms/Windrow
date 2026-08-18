#!/usr/bin/env node
'use strict';
// MCP server for the capability-governance API (registry/broker/usage-log). Exposes the same
// data the client dashboard shows — capabilities, principals, grants, usage, drift — as MCP tools
// so an agent can query and manage the registry directly instead of
// shelling out to curl or context-switching to the browser card. Complements (does not replace)
// the `open-capabilities-dashboard` skill: that skill is for *looking*, these tools are for
// *asking questions and acting* from inside a conversation.
//
// Auth: reads the admin token off disk the same way the dashboard build does (server/data/api-
// token, gitignored) — this MCP server runs as a trusted local process on the same machine as the
// governance API, same trust boundary as the dashboard itself. Override with GOVERNANCE_API_TOKEN
// / GOVERNANCE_API_URL env vars (see mcp/README.md) to point at a non-default token or a shared
// instance on another host.
//
// `grant_capability`/`revoke_grant` are the one exception (docs/design/governance-review-
// 2026-08-16.md, F1): holding the admin token here made this process a confused deputy — any agent
// with a grant for either tool could ride this server's admin token straight to POST/DELETE
// /api/grants and self-escalate to anything, through the front door, with nothing recorded. Those
// two calls now use the separate *proposer* token (server/data/proposer-api-token /
// GOVERNANCE_PROPOSER_TOKEN) against POST /api/grants/propose and POST /api/grants/:id/propose-
// revoke, which only ever queue a pending-approval row; a human still has to clear it in the
// dashboard before it takes effect.

const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_TOKEN_PATH = path.join(REPO_ROOT, 'server', 'data', 'api-token');
const DEFAULT_PROPOSER_TOKEN_PATH = path.join(REPO_ROOT, 'server', 'data', 'proposer-api-token');
const BASE_URL = (process.env.GOVERNANCE_API_URL || 'http://localhost:4000/api').replace(/\/+$/, '');

function loadToken() {
  if (process.env.GOVERNANCE_API_TOKEN) return process.env.GOVERNANCE_API_TOKEN.trim();
  try {
    return fs.readFileSync(DEFAULT_TOKEN_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

// Scoped to `grant_capability`/`revoke_grant` only (see the file-header comment) — everything else
// this server does still reads with `loadToken()` above.
function loadProposerToken() {
  if (process.env.GOVERNANCE_PROPOSER_TOKEN) return process.env.GOVERNANCE_PROPOSER_TOKEN.trim();
  try {
    return fs.readFileSync(DEFAULT_PROPOSER_TOKEN_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

async function api(pathAndQuery, { method = 'GET', body, token: tokenOverride } = {}) {
  const token = tokenOverride || loadToken();
  if (!token) {
    throw new Error(
      `No governance API token found at ${DEFAULT_TOKEN_PATH} and GOVERNANCE_API_TOKEN is unset. ` +
        `Start the governance server at least once (npm start in server/) to generate one.`
    );
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Could not reach the governance API at ${BASE_URL} (${err.message}). Is the server running ` +
        `(npm start in server/, or the CapabilityGovernance Windows service)?`
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText;
    throw new Error(`${method} ${pathAndQuery} -> ${res.status}: ${msg}`);
  }
  return data;
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

const server = new McpServer({ name: 'capability-governance', version: '1.0.0' });

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
  async ({ principalId, capabilityId, constraints, expiresAt }) => {
    const proposerToken = loadProposerToken();
    if (!proposerToken) {
      throw new Error(
        `No proposer token found at ${DEFAULT_PROPOSER_TOKEN_PATH} and GOVERNANCE_PROPOSER_TOKEN is unset. ` +
          `Start the governance server at least once (npm start in server/) to generate one.`
      );
    }
    return json(
      await api('/grants/propose', {
        method: 'POST',
        body: { principalId, capabilityId, constraints, expiresAt },
        token: proposerToken,
      })
    );
  }
);

tool(
  server,
  'revoke_grant',
  'Propose revoking a grant by its id. This does not revoke anything by itself — it queues a pending-approval request that a human must clear in the dashboard before it takes effect.',
  { grantId: z.string() },
  async ({ grantId }) => {
    const proposerToken = loadProposerToken();
    if (!proposerToken) {
      throw new Error(
        `No proposer token found at ${DEFAULT_PROPOSER_TOKEN_PATH} and GOVERNANCE_PROPOSER_TOKEN is unset. ` +
          `Start the governance server at least once (npm start in server/) to generate one.`
      );
    }
    return json(
      await api(`/grants/${encodeURIComponent(grantId)}/propose-revoke`, { method: 'POST', token: proposerToken })
    );
  }
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
  'Cross-workspace usage rollup: this shared governance server tracks every workspace on the machine, not just the one you are in. Use this to see per-workspace call/denial counts, including standalone (non-platform) usage.',
  {},
  async () => json(await api('/rollup/summary'))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('governance-mcp-server failed to start:', err);
  process.exit(1);
});
