'use strict';

// `node scripts/seed-demo.js` — provision and populate the read-only Vercel + Supabase live demo.
// docs/design/vercel-supabase-demo.md.
//
// RUN THIS ONCE, AGAINST THE DIRECT SUPABASE CONNECTION (port 5432), not the pooled one the Vercel
// function uses. It opens central's store with migrate:true, so it creates every table and the
// month partitions — session-level DDL that Supabase's pgbouncer transaction pooler (port 6543)
// will not run. The Vercel function then reads that same database through the pooled URL.
//
//   DATABASE_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' \
//     node scripts/seed-demo.js
//
// WHAT IT SEEDS, IN TWO HALVES.
//
//   THE POLICY HALF — the capability catalog, the principals and the grants, from
//   ./demo-catalog.js. Every capability there is a real tool name from a real MCP server (GitHub,
//   Slack, Linear, Sentry, Notion, Stripe, Playwright, Figma, Postgres, the filesystem reference
//   server, the Gmail and Drive connectors) or a real published Agent Skill; the organisation
//   around them — who holds what, who was refused, what is still pending — is invented, because
//   that is the part a demo has to invent. Written through ../server/central/policyStore.js rather
//   than by raw INSERT, so every row appends to `policy_changes` in the same transaction and the
//   catalog a visitor reads is one a real node could have replicated.
//
//   THE FLEET HALF — a synthetic three-node fleet with usage events, native observations and
//   hook-health reports, fed through store.ingestBatch / ingestNativeBatch / ingestNodeHealth,
//   which is the same path a real node's shipper uses. The rows, the shipment ledger, the
//   partitions and the node roster then come out self-consistent, which is what makes the Fleet
//   overview, nodes, usage, events and native pages look like a deployment instead of fixtures.
//
// THE TWO HALVES AGREE, AND THAT IS THE POINT. Every usage event's outcome is COMPUTED from the
// grants seeded above it — `findActiveGrant`'s rule, including an instance inheriting its parent
// role — rather than written down beside them. So a denial in the event log is a denial you can
// chase into the Grants page and find the missing row for; the agent denied `slack_post_message` is
// the one whose grant was revoked nine days ago, and the request to get it back is sitting in the
// approvals queue. A demo whose log and whose policy were written independently would contradict
// itself on the first row anybody clicked.
//
// IDEMPOTENT, on both halves and for two different reasons. Policy rows are matched on the pair
// their unique index is on — `(kind, name)` — so a second run creates nothing and bumps the policy
// version by zero (../server/seed-central.js's header explains why that matters). Usage event ids
// are derived from the node and its shipment sequence, not from the clock, so a second run
// redelivers the same shipments and the idempotency ledger collapses them: accepted=0,
// duplicates=N. Re-run it freely.
//
// THE CLOCK DEFAULTS TO NOW, AND THAT IS DELIBERATE. Every fleet page windows on the last 24 hours,
// so a hard-coded seed date means a demo that is empty the day after it was provisioned. Pass
// `--now=<iso>` to pin it for a reproducible screenshot. Re-seeding does NOT move existing rows to
// the new clock — the ledger has already collapsed them — so a fresh window means a fresh database.
//
// ITS TWO SIBLINGS: `scripts/demo-local.js` runs the serverless entry that reads this database,
// locally, so the deployment can be checked before it ships; and `npm run demo` /
// `scripts/demo.js` is the unrelated one — a throwaway local SQLite node + Vite for looking at
// the dashboard on your own machine, with no Postgres and nothing to do with Vercel.

const { assertNoLegacyEnv } = require('../server/config');

assertNoLegacyEnv();

const store = require('../server/central/store');
const policy = require('../server/central/policyStore');
const catalog = require('./demo-catalog');

const { capRef } = catalog;

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');

/** The seed's clock. Real now unless pinned — see the header. */
const NOW = (() => {
  const pinned = argv.find((a) => a.startsWith('--now='));
  if (!pinned) return new Date();
  const at = new Date(pinned.slice('--now='.length));
  if (Number.isNaN(at.getTime())) throw new Error(`--now must be an ISO timestamp, got "${pinned}"`);
  return at;
})();

const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const daysAhead = (d) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

/**
 * A seeded linear congruential generator, and the only source of variation in this file.
 *
 * `Math.random()` would make the demo's shape different on every provisioning run — which sounds
 * harmless until a screenshot in the docs shows a chart the next run cannot reproduce. Seeded from
 * a constant, so "the demo looks like this" is a statement that survives a re-provision onto a new
 * database.
 */
let rngState = 0x5eed_1234;
function rnd() {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}
const rndInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
/** Pick from a list of `[item, weight]` pairs. */
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [item, w] of pairs) {
    r -= w;
    if (r <= 0) return item;
  }
  return pairs[pairs.length - 1][0];
}

// The synthetic fleet. Three machines, each a different shape of user so the roster and the usage
// breakdown have something to distinguish.
const NODES = [
  { nodeId: 'demo-node-aurora', hostname: 'AURORA', osUser: 'ada', incarnation: 'inc_1', hookStatus: 'healthy' },
  { nodeId: 'demo-node-borealis', hostname: 'BOREALIS', osUser: 'linus', incarnation: 'inc_1', hookStatus: 'healthy' },
  // CASCADE's clock is about four minutes fast, and that is the point of it: `clockSkewMs` is a
  // column the Events and Nodes pages surface, and a fleet where every node reads zero would never
  // show what it looks like when one does not. Its hooks are degraded for a separate reason.
  { nodeId: 'demo-node-cascade', hostname: 'CASCADE', osUser: 'grace', incarnation: 'inc_2', hookStatus: 'degraded', clockOffsetMs: 237_000 },
];

const NODE_BY_ID = new Map(NODES.map((n) => [n.nodeId, n]));

/**
 * WHO IS CALLING, on each machine.
 *
 * `principal` is the registry row the hook resolved the caller to, in `kind:name` form. For an
 * agent that is normally its INSTANCE row — one running loom — which holds no grants of its own and
 * inherits its parent role's, exactly as server/app.js's findActiveGrant resolves it. Two actors
 * are plain roles instead, which is the shape of a call with no loom behind it: a CI run, and an
 * older hook that forwards no loom id. One is a `user` — a person driving the tools directly.
 */
const ACTORS = [
  // ---- AURORA: product work on the checkout surface ----------------------------------------
  {
    node: 'demo-node-aurora', principal: 'instance:claude-7fq2hb31-204', loom: 'claude-7fq2hb31-204',
    agentType: 'claudecode', backend: 'claude', field: 'checkout', share: 26,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 9], [capRef('mcp_tool', 'list_pull_requests'), 5],
      [capRef('mcp_tool', 'get_pull_request_diff'), 5], [capRef('mcp_tool', 'list_commits'), 3],
      [capRef('mcp_tool', 'create_or_update_file'), 4], [capRef('mcp_tool', 'create_pull_request'), 2],
      [capRef('mcp_tool', 'add_issue_comment'), 3], [capRef('mcp_tool', 'create_branch'), 2],
      [capRef('mcp_tool', 'update_issue'), 3], [capRef('mcp_tool', 'create_comment'), 2],
      [capRef('mcp_tool', 'slack_post_message'), 2], [capRef('mcp_tool', 'edit_file'), 4],
      [capRef('mcp_tool', 'browser_navigate'), 2],
      [capRef('mcp_tool', 'browser_snapshot'), 2],
      // Ungranted anywhere: the destructive Playwright row. A denial with an obvious remedy.
      [capRef('mcp_tool', 'browser_evaluate'), 1],
    ],
  },
  {
    node: 'demo-node-aurora', principal: 'instance:claude-k4m9zt08-117', loom: 'claude-k4m9zt08-117',
    agentType: 'general-purpose', backend: 'claude', field: 'checkout', share: 18,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 8], [capRef('mcp_tool', 'search_repositories'), 3],
      [capRef('mcp_tool', 'read_text_file'), 5], [capRef('mcp_tool', 'list_directory'), 4],
      [capRef('mcp_tool', 'find_issues'), 3], [capRef('mcp_tool', 'get_issue_details'), 3],
      [capRef('mcp_tool', 'create_issue'), 2], [capRef('mcp_tool', 'edit_file'), 3],
      [capRef('mcp_tool', 'search'), 2], [capRef('mcp_tool', 'fetch'), 2],
      // Revoked 23 days ago, and the loop that used it has not been updated.
      [capRef('mcp_tool', 'create_branch'), 2],
      // Expired three days ago — a different denial from a missing grant, and the pages say so.
      [capRef('mcp_tool', 'search_events'), 2],
      // Sitting in the approvals queue, unanswered.
      [capRef('mcp_tool', 'merge_pull_request'), 1],
    ],
  },
  {
    node: 'demo-node-aurora', principal: 'instance:claude-3vn8qs45-291', loom: 'claude-3vn8qs45-291',
    agentType: 'Explore', backend: 'claude', field: 'checkout', share: 12,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 10], [capRef('mcp_tool', 'read_text_file'), 8],
      [capRef('mcp_tool', 'directory_tree'), 4], [capRef('mcp_tool', 'list_directory'), 6],
      [capRef('mcp_tool', 'search_repositories'), 4], [capRef('mcp_tool', 'list_commits'), 3],
      [capRef('mcp_tool', 'get_file_info'), 2],
      // Explore holds the read-only baseline and nothing else, so anything that writes is denied.
      [capRef('mcp_tool', 'write_file'), 1],
    ],
  },
  {
    node: 'demo-node-aurora', principal: 'instance:claude-p1w6vd52-388', loom: 'claude-p1w6vd52-388',
    agentType: 'design-agent', backend: 'claude', field: 'storefront', share: 10,
    calls: [
      [capRef('mcp_tool', 'get_code'), 6], [capRef('mcp_tool', 'get_variable_defs'), 4],
      [capRef('mcp_tool', 'get_image'), 3], [capRef('mcp_tool', 'get_code_connect_map'), 2],
      [capRef('mcp_tool', 'browser_navigate'), 3], [capRef('mcp_tool', 'browser_take_screenshot'), 4],
      [capRef('mcp_tool', 'browser_click'), 2], [capRef('mcp_tool', 'notion-create-pages'), 2],
      // Refused six days ago in the approvals queue; the agent still tries.
      [capRef('mcp_tool', 'create_or_update_file'), 1],
    ],
  },

  // ---- BOREALIS: infrastructure and on-call --------------------------------------------------
  {
    node: 'demo-node-borealis', principal: 'instance:claude-h2j7yr19-462', loom: 'claude-h2j7yr19-462',
    agentType: 'claudecode', backend: 'claude', field: 'infra', share: 22,
    calls: [
      [capRef('mcp_tool', 'query'), 7], [capRef('mcp_tool', 'find_issues'), 5],
      [capRef('mcp_tool', 'get_issue_details'), 5], [capRef('mcp_tool', 'list_workflow_runs'), 4],
      [capRef('mcp_tool', 'get_file_contents'), 6], [capRef('mcp_tool', 'edit_file'), 3],
      [capRef('mcp_tool', 'write_file'), 2], [capRef('mcp_tool', 'add_issue_comment'), 3],
      [capRef('mcp_tool', 'slack_post_message'), 3], [capRef('mcp_tool', 'slack_get_channel_history'), 2],
      [capRef('mcp_tool', 'merge_pull_request'), 2],
      [capRef('mcp_tool', 'find_projects'), 2],
    ],
  },
  {
    node: 'demo-node-borealis', principal: 'instance:agy-3xr8cn74-051', loom: 'agy-3xr8cn74-051',
    agentType: 'agy', backend: 'agy', field: 'infra', share: 12,
    calls: [
      [capRef('mcp_tool', 'find_issues'), 5], [capRef('mcp_tool', 'get_issue_details'), 4],
      [capRef('mcp_tool', 'find_projects'), 3], [capRef('mcp_tool', 'find_organizations'), 2],
      [capRef('mcp_tool', 'query'), 4], [capRef('mcp_tool', 'list_workflow_runs'), 3],
      [capRef('mcp_tool', 'edit_file'), 2], [capRef('mcp_tool', 'add_issue_comment'), 2],
      // The revoked one. Its re-request is the second row in the approvals queue.
      [capRef('mcp_tool', 'slack_post_message'), 3],
    ],
  },
  {
    // No loom: a CI run on the standalone role, which is why `loom` is null and the event carries
    // no actorLoomId for a label to fall back on.
    node: 'demo-node-borealis', principal: 'role:claude-standalone', loom: null,
    agentType: 'claude-standalone', backend: 'claude', field: null, share: 8,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 6], [capRef('mcp_tool', 'list_workflow_runs'), 4],
      [capRef('mcp_tool', 'get_pull_request_diff'), 4],
      [capRef('mcp_tool', 'add_issue_comment'), 2], [capRef('mcp_tool', 'create_issue'), 2],
    ],
  },
  {
    // The pending backend. Every call it makes is refused because the PRINCIPAL is not approved —
    // a different denial from a missing grant, and the one the Principals page is for.
    node: 'demo-node-borealis', principal: 'instance:codex-9bt5lm26-013', loom: 'codex-9bt5lm26-013',
    agentType: 'codex', backend: 'codex', field: 'infra', share: 3,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 4], [capRef('mcp_tool', 'read_text_file'), 3],
      [capRef('mcp_tool', 'list_directory'), 2], [capRef('mcp_tool', 'query'), 1],
    ],
  },

  // ---- CASCADE: billing ----------------------------------------------------------------------
  {
    node: 'demo-node-cascade', principal: 'instance:claude-w5c1kf83-330', loom: 'claude-w5c1kf83-330',
    agentType: 'claudecode', backend: 'claude', field: 'billing', share: 16,
    calls: [
      [capRef('mcp_tool', 'search_threads'), 5], [capRef('mcp_tool', 'get_message'), 5],
      [capRef('mcp_tool', 'get_thread'), 3], [capRef('mcp_tool', 'create_draft'), 3],
      [capRef('mcp_tool', 'label_message'), 2], [capRef('mcp_tool', 'search_files'), 4],
      [capRef('mcp_tool', 'read_file_content'), 4], [capRef('mcp_tool', 'create_file'), 2],
      [capRef('mcp_tool', 'query'), 3], [capRef('mcp_tool', 'notion-update-page'), 2],
      // Billing's destructive rows belong to Grace, not to any agent.
      [capRef('mcp_tool', 'create_refund'), 1], [capRef('mcp_tool', 'send_message'), 1],
    ],
  },
  {
    node: 'demo-node-cascade', principal: 'instance:claude-t8d4gp67-175', loom: 'claude-t8d4gp67-175',
    agentType: 'general-purpose', backend: 'claude', field: 'billing', share: 10,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 5], [capRef('mcp_tool', 'read_text_file'), 4],
      [capRef('mcp_tool', 'query'), 4], [capRef('mcp_tool', 'search'), 3],
      [capRef('mcp_tool', 'fetch'), 3], [capRef('mcp_tool', 'create_issue'), 2],
      [capRef('mcp_tool', 'read_file_content'), 3], [capRef('mcp_tool', 'search_files'), 3],
      [capRef('mcp_tool', 'list_invoices'), 2], [capRef('mcp_tool', 'list_customers'), 2],
    ],
  },
  {
    // A person, driving the billing tools directly rather than through an agent. `user` principals
    // are keyed on subjectId, which is why these are the rows the "usage by human" breakdown can
    // resolve a name for without going through a loom.
    node: 'demo-node-cascade', principal: 'user:grace', loom: null,
    agentType: null, backend: null, field: null, share: 7,
    calls: [
      [capRef('mcp_tool', 'list_invoices'), 4], [capRef('mcp_tool', 'list_customers'), 3],
      [capRef('mcp_tool', 'list_subscriptions'), 3], [capRef('mcp_tool', 'retrieve_balance'), 2],
      [capRef('mcp_tool', 'create_customer'), 2], [capRef('mcp_tool', 'create_payment_link'), 2],
      [capRef('mcp_tool', 'create_refund'), 2], [capRef('mcp_tool', 'cancel_subscription'), 1],
      [capRef('mcp_tool', 'search_documentation'), 2],
    ],
  },
  {
    // An older hook on this machine that forwards no loom id, so the call resolves to the bare
    // role. §2.6's tolerance rule in the data rather than in a comment.
    node: 'demo-node-cascade', principal: 'role:claude', loom: null,
    agentType: 'claude', backend: 'claude', field: 'billing', share: 6,
    calls: [
      [capRef('mcp_tool', 'get_file_contents'), 5], [capRef('mcp_tool', 'search_threads'), 3],
      [capRef('mcp_tool', 'get_message'), 3], [capRef('mcp_tool', 'create_draft'), 2],
      [capRef('mcp_tool', 'query'), 2], [capRef('mcp_tool', 'search'), 2],
      // Withdrawn in the Q3 access review, 47 days ago.
      [capRef('mcp_tool', 'trash_message'), 1],
    ],
  },
];

/** Calls per hour across the whole fleet, indexed by hours-ago (0 = the hour in progress). A
 *  working day rather than a flat line, so the usage chart has a shape a reader can recognise —
 *  quiet overnight, a morning ramp, a dip, an afternoon peak. */
const HOURLY_SHAPE = [
  22, 26, 31, 34, 30, 24, 18, 12, 8, 5, 4, 3, 4, 7, 13, 21, 28, 33, 36, 32, 27, 25, 23, 20,
];

/** Native tool calls — the ungoverned harness tools every agent uses constantly. These are
 *  OBSERVATIONS, not decisions (docs/design/dashboard-placement.md item 1), and their volume
 *  against the governed calls above is the comparison the Native page exists to draw. */
const NATIVE_TOOLS = [
  ['Read', 26], ['Bash', 20], ['Edit', 14], ['Grep', 12], ['Glob', 7], ['Write', 6],
  ['TodoWrite', 5], ['Task', 4], ['WebFetch', 3], ['WebSearch', 2], ['NotebookEdit', 1],
];

// ---------------------------------------------------------------------------------------------
// The policy half
// ---------------------------------------------------------------------------------------------

const report = {
  now: NOW.toISOString(),
  capabilities: { created: 0, existing: 0 },
  principals: { created: 0, existing: 0 },
  grants: { created: 0, existing: 0, revoked: 0, expiring: 0 },
  approvals: 0,
  audit: 0,
  nodes: 0,
  usageAccepted: 0,
  usageDuplicates: 0,
  usageDenied: 0,
  native: 0,
  health: 0,
  policyVersion: { before: null, after: null },
};

/**
 * Backdate a column that the store stamps with its own clock.
 *
 * The store mints `createdAt` from `new Date()` — correct for a real write, and wrong for a demo,
 * where a catalog whose every row was created in the same second is a catalog that announces
 * itself as a fixture. Applied only to rows THIS run created, so a re-run never rewrites history
 * somebody has already looked at.
 */
async function backdate(driver, table, column, id, iso) {
  await driver.query(`UPDATE ${table} SET "${column}" = $1 WHERE "id" = $2`, [iso, id]);
}

/** The catalog, matched on `(kind, name)` — the pair the unique index is on and the only identity
 *  ./demo-catalog.js has to offer, since central mints the ids. */
async function seedCapabilities(driver) {
  const byRef = new Map();
  for (const entry of catalog.CAPABILITIES) {
    const ref = capRef(entry.kind, entry.name);
    const existing = await policy.findCapabilityByKindName(driver, entry.kind, entry.name);
    if (existing) {
      byRef.set(ref, existing);
      report.capabilities.existing += 1;
      continue;
    }
    const created = await policy.insertCapability(driver, {
      kind: entry.kind,
      name: entry.name,
      owner: entry.owner,
      riskTier: entry.riskTier,
      description: entry.description,
      autoGrant: Boolean(entry.autoGrant),
    });
    await backdate(driver, 'capabilities', 'createdAt', created.id, daysAgo(entry.addedDaysAgo || 30));
    byRef.set(ref, created);
    report.capabilities.created += 1;
  }
  return byRef;
}

/** Principals, keyed the same way — `principals` is unique on `(kind, name)`. */
async function seedPrincipals(driver) {
  const byRef = new Map();
  for (const entry of catalog.PRINCIPALS) {
    const ref = `${entry.kind}:${entry.name}`;
    const existing = await policy.findPrincipalByKindName(driver, entry.kind, entry.name);
    if (existing) {
      byRef.set(ref, existing);
      report.principals.existing += 1;
      continue;
    }
    const created = await policy.insertPrincipal(driver, {
      kind: entry.kind,
      name: entry.name,
      subjectId: entry.subjectId ?? null,
      assuranceLevel: entry.assuranceLevel ?? null,
      parentRole: entry.parentRole ?? null,
      humanName: entry.humanName ?? null,
      backend: entry.backend ?? null,
      agentType: entry.agentType ?? null,
      field: entry.field ?? null,
      standalone: Boolean(entry.standalone),
      status: entry.status || 'active',
      owner: entry.owner ?? null,
    });
    await backdate(driver, 'principals', 'createdAt', created.id, daysAgo(entry.addedDaysAgo || 30));
    byRef.set(ref, created);
    report.principals.created += 1;
  }
  return byRef;
}

/**
 * Grants: the baseline for every ACTIVE role, plus each principal's own extras, plus the two
 * decorations that make the page worth looking at — expiries and revocations.
 *
 * `codex` is skipped on purpose. A pending principal with a full set of grants would be a
 * contradiction: it is on the deny list precisely because nobody has approved it, and its grants
 * would be permissions that cannot be used and that nobody remembers issuing.
 */
async function seedGrants(driver, capByRef, principalByRef) {
  const expiryByPair = new Map(catalog.EXPIRING.map((e) => [`${e.ref}|${e.cap}`, e]));
  const revokeByPair = new Map(catalog.REVOKED.map((r) => [`${r.ref}|${r.cap}`, r]));
  // How old the capability is, so a grant is never backdated to before the thing it grants existed.
  const capAgeByRef = new Map(catalog.CAPABILITIES.map((c) => [capRef(c.kind, c.name), c.addedDaysAgo || 30]));
  const wanted = new Map(); // `${principalRef}|${capRef}` -> { principalRef, capRef }

  for (const entry of catalog.PRINCIPALS) {
    const ref = `${entry.kind}:${entry.name}`;
    if ((entry.status || 'active') !== 'active') continue;
    // An instance holds nothing of its own — it inherits its parent role's grants, which is the
    // whole difference between the two kinds and is enforced in server/app.js, not just described.
    if (entry.kind === 'instance') continue;
    const refs = entry.kind === 'role'
      ? [...new Set([...catalog.READ_ONLY_BASELINE, ...(catalog.GRANTS[ref] || [])])]
      : (catalog.GRANTS[ref] || []);
    for (const cap of refs) wanted.set(`${ref}|${cap}`, { principalRef: ref, capRef: cap });
  }
  // The revoked rows have to exist before they can be taken back — a revoke is a soft delete here,
  // so "somebody held this and it was withdrawn" is a row, not an absence.
  for (const r of catalog.REVOKED) wanted.set(`${r.ref}|${r.cap}`, { principalRef: r.ref, capRef: r.cap });

  const live = new Set();
  const revoked = new Map();
  const expired = new Set();

  for (const [pair, { principalRef, capRef: ref }] of wanted) {
    const principal = principalByRef.get(principalRef);
    const capability = capByRef.get(ref);
    if (!principal) throw new Error(`demo-catalog: grant refers to unknown principal "${principalRef}"`);
    if (!capability) throw new Error(`demo-catalog: grant refers to unknown capability "${ref}"`);

    const existing = await driver.get(
      'SELECT * FROM grants WHERE "principalId" = $1 AND "capabilityId" = $2 ORDER BY "createdAt" DESC LIMIT 1',
      [principal.id, capability.id]
    );
    let grant = existing;
    if (!grant) {
      const expiry = expiryByPair.get(pair);
      grant = await policy.insertGrant(driver, {
        principalId: principal.id,
        capabilityId: capability.id,
        expiresAt: expiry ? daysAhead(expiry.days) : null,
      });
      // Granted somewhere between the capability's registration and now, so the Grants page is not
      // a single timestamp repeated 180 times. A grant that was later revoked, or that has already
      // lapsed, is aged past that event as well — a row created after it was taken away would be a
      // detail nobody notices until they sort the column, and then it is the only thing they see.
      const floor = revokeByPair.has(pair)
        ? revokeByPair.get(pair).daysAgo + 20
        : (expiry && expiry.days < 0 ? -expiry.days + 20 : 3);
      const ceiling = Math.max(floor + 1, Math.min(120, capAgeByRef.get(ref) || 30));
      await backdate(driver, 'grants', 'createdAt', grant.id, daysAgo(rndInt(floor, ceiling)));
      if (expiry) report.grants.expiring += 1;
      report.grants.created += 1;
    } else {
      report.grants.existing += 1;
    }

    if (revokeByPair.has(pair) && !grant.revokedAt) {
      const spec = revokeByPair.get(pair);
      const gone = await policy.revokeGrant(driver, grant.id, spec.by);
      await backdate(driver, 'grants', 'revokedAt', gone.id, daysAgo(spec.daysAgo));
      const entry = await policy.recordAuditEntry(driver, {
        action: 'grant_revoke',
        actorScope: 'admin',
        principalId: principal.id,
        capabilityId: capability.id,
        grantId: gone.id,
        reason: spec.reason,
      });
      // Dated when the revoke happened, not when this script ran — an audit whose four newest rows
      // all landed in the same second is the one thing on the page that cannot be true.
      await backdate(driver, 'windrow_audit', 'createdAt', entry.id, daysAgo(spec.daysAgo));
      report.grants.revoked += 1;
      report.audit += 1;
      revoked.set(pair, spec);
      continue;
    }
    if (grant.revokedAt) { revoked.set(pair, { reason: null }); continue; }

    const expiry = expiryByPair.get(pair);
    if (expiry && expiry.days < 0) { expired.add(pair); continue; }
    live.add(pair);
  }

  return { live, revoked, expired };
}

/** The approvals queue and the decisions already taken on it. */
async function seedApprovals(driver, capByRef, principalByRef) {
  const already = await driver.get('SELECT COUNT(*)::INT AS n FROM approvals');
  if (already && Number(already.n) > 0) return;
  for (const a of catalog.APPROVALS) {
    const principal = principalByRef.get(a.ref);
    const capability = capByRef.get(a.cap);
    const row = await policy.insertApproval(driver, {
      action: a.action,
      principalId: principal.id,
      capabilityId: capability.id,
      requestedByScope: a.requestedByScope,
      payload: { principalId: principal.id, capabilityId: capability.id, note: a.note || null },
    });
    await backdate(driver, 'approvals', 'requestedAt', row.id, daysAgo(a.daysAgo));
    if (a.status !== 'pending') {
      const decided = await policy.decideApproval(driver, row.id, {
        status: a.status,
        decidedByScope: a.decidedByScope,
        reason: a.reason,
      });
      // Decided a few hours after it was asked, not in the same instant it was raised.
      await backdate(driver, 'approvals', 'decidedAt', decided.id, daysAgo(Math.max(0, a.daysAgo - 0.25)));
    }
    report.approvals += 1;
  }
}

/** The handful of control-plane decisions a person made. See ./demo-catalog.js AUDIT for why the
 *  ~180 bootstrap grants are not in here. */
async function seedAudit(driver, capByRef, principalByRef) {
  const already = await driver.get(
    `SELECT COUNT(*)::INT AS n FROM windrow_audit WHERE "action" <> 'grant_revoke'`
  );
  if (already && Number(already.n) > 0) return;
  for (const entry of catalog.AUDIT) {
    const capability = entry.cap ? capByRef.get(entry.cap) : null;
    const principal = entry.ref ? principalByRef.get(entry.ref) : null;
    const row = await policy.recordAuditEntry(driver, {
      action: entry.action,
      actorScope: entry.actorScope,
      nodeId: entry.nodeId || null,
      capabilityId: capability ? capability.id : null,
      principalId: principal ? principal.id : null,
      reason: entry.reason,
    });
    await backdate(driver, 'windrow_audit', 'createdAt', row.id, daysAgo(entry.daysAgo));
    report.audit += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The fleet half
// ---------------------------------------------------------------------------------------------

/**
 * What would have happened to this call — server/app.js's `findActiveGrant`, restated over the sets
 * seedGrants returned.
 *
 * This is what keeps the two halves of the demo agreeing. Nothing below writes an outcome down; it
 * is derived from the policy that was just seeded, so a denial in the event log is always chaseable
 * to a missing, revoked, expired or unapproved row on the policy pages.
 */
function decide(actor, ref, principalByRef) {
  const principal = principalByRef.get(actor.principal);
  if (principal.status !== 'active') {
    return { outcome: 'denied', reason: `principal ${principal.kind}/${principal.name} is ${principal.status} — awaiting approval` };
  }
  // An instance inherits from its parent role and holds nothing directly.
  const holder = principal.kind === 'instance' ? `role:${principal.parentRole}` : actor.principal;
  const pair = `${holder}|${ref}`;
  if (grantState.live.has(pair)) return { outcome: 'ok', reason: null };
  if (grantState.expired.has(pair)) return { outcome: 'denied', reason: 'grant expired' };
  if (grantState.revoked.has(pair)) {
    const spec = grantState.revoked.get(pair);
    return { outcome: 'denied', reason: spec.reason ? `grant revoked — ${spec.reason}` : 'grant revoked' };
  }
  return { outcome: 'denied', reason: `no active grant for principal+capability in central policy (replica v${policyStamp})` };
}

let grantState = { live: new Set(), revoked: new Map(), expired: new Set() };
let policyStamp = 1;

/** Build one usage envelope the way server/usageShipper.js would ship it. */
function usageEnvelope(node, seq, event) {
  return { nodeId: node.nodeId, kind: 'usage_event', seq, incarnation: node.incarnation, event };
}

/** One native observation — an unenforced sighting, item 1 of dashboard-placement. */
function nativeEnvelope(node, actor, toolName, seq, ts) {
  return {
    nodeId: node.nodeId,
    id: `demo-native-${node.nodeId}-${seq}`,
    toolName,
    detail: `${toolName} on ${node.hostname}`,
    ts,
    outcome: 'observed',
    incarnation: node.incarnation,
    osUser: node.osUser,
    hostname: node.hostname,
    actorLoomId: actor.loom,
    actorAgentType: actor.agentType,
    actorBackend: actor.backend,
    actorField: actor.field,
  };
}

/**
 * Generate a day of traffic and ship it, one batch per node per hour.
 *
 * THE BATCHING IS NOT AN OPTIMISATION. `observedAt` — central's arrival clock and the column every
 * chart buckets on — is stamped from the `now` passed to ingestBatch, so shipping the whole day in
 * one call would put every event in a single bucket and draw a 24-hour flat line with one spike at
 * the end. An hourly shipment is also what a real node does.
 */
async function seedTraffic(capByRef, principalByRef) {
  // A FRESH RNG STREAM, and this reset is load-bearing. The policy half above draws from `rnd()`
  // too (backdating a grant picks a date), and how many times it draws depends on how many rows it
  // had to create — which is zero on a re-run. Without this, the same script against a seeded
  // database would generate a DIFFERENT day of traffic and ship shipment numbers the ledger has
  // never seen, so "re-run it freely" would quietly stop being true.
  rngState = 0x7a17_c0de;
  const seqByNode = new Map(NODES.map((n) => [n.nodeId, 0]));
  const nativeSeqByNode = new Map(NODES.map((n) => [n.nodeId, 0]));
  const totalShare = ACTORS.reduce((s, a) => s + a.share, 0);
  // A few denials were taken to the owner and allowed after the fact — the `approved` outcome,
  // which is a denial that a human overrode, not a second flavour of ok.
  let approvalsLeft = 4;

  for (let hoursBack = 23; hoursBack >= 0; hoursBack -= 1) {
    const shipAt = new Date(NOW.getTime() - hoursBack * 3_600_000);
    const fleetCalls = HOURLY_SHAPE[hoursBack];
    const byNode = new Map(NODES.map((n) => [n.nodeId, []]));
    const nativeByNode = new Map(NODES.map((n) => [n.nodeId, []]));

    for (let i = 0; i < fleetCalls; i += 1) {
      const actor = weighted(ACTORS.map((a) => [a, a.share / totalShare]));
      const node = NODE_BY_ID.get(actor.node);
      const ref = weighted(actor.calls);
      const capability = capByRef.get(ref);
      const principal = principalByRef.get(actor.principal);
      const decision = decide(actor, ref, principalByRef);

      let { outcome, reason } = decision;
      // A tool that was allowed and then failed upstream — the node PATCHes the event to `error`
      // once it knows (server/app.js's completion route), so an error is always an allowed call.
      if (outcome === 'ok' && rnd() < 0.022) {
        outcome = 'error';
        reason = weighted([['upstream 502 from the MCP server', 3], ['tool timed out after 30s', 2], ['invalid arguments', 1]]);
      } else if (outcome === 'denied' && approvalsLeft > 0 && rnd() < 0.06) {
        outcome = 'approved';
        reason = 'owner approved after the denial';
        approvalsLeft -= 1;
      }

      const seq = seqByNode.get(node.nodeId) + 1;
      seqByNode.set(node.nodeId, seq);
      // Somewhere inside the hour this shipment covers, and a little before the shipment itself —
      // which is what gives the rows a small, believable clock skew rather than a skew of zero.
      // WHEN THE NODE SAYS IT HAPPENED, relative to when central received it — the difference is
      // `clockSkewMs`, which §2.3 calls the thing that turns an audit log into plausible-looking
      // fiction, so it has to come out of this seed looking like a real fleet's. A shipper flushes
      // its outbox within seconds, so a call sits a minute or two behind its shipment at most; what
      // is left on top of that is the machine's clock being genuinely wrong, which is CASCADE's
      // (`clockOffsetMs` below) and nobody else's.
      const ts = new Date(shipAt.getTime() - rndInt(2, 130) * 1000 + (node.clockOffsetMs || 0)).toISOString();
      const latency = outcome === 'denied'
        ? rndInt(2, 9)
        : capability.kind === 'skill' ? rndInt(180, 2400) : rndInt(35, 900);
      const grantCheckMs = rndInt(0, 2);
      const lookupMs = rndInt(0, 2);
      const resolveMs = rndInt(0, 3);

      byNode.get(node.nodeId).push({ seq, event: {
        id: `demo-${node.nodeId}-${seq}`,
        principalId: principal.id,
        capabilityId: capability.id,
        ts,
        outcome,
        latencyMs: latency,
        reason,
        hostname: node.hostname,
        osUser: node.osUser,
        incarnation: node.incarnation,
        actorLoomId: actor.loom,
        actorAgentType: actor.agentType,
        actorBackend: actor.backend,
        actorField: actor.field,
        // The person the call is accountable to — the OS account it ran under, resolved through
        // `principals.subjectId` so the "usage by human" breakdown has a name to show.
        subjectId: subjectFor(node, principalByRef),
        assuranceLevel: 2,
        capabilityLookupMs: lookupMs,
        principalResolveMs: resolveMs,
        grantCheckMs,
        brokerMs: Math.max(1, Math.round(latency * 0.08)) + grantCheckMs + lookupMs + resolveMs,
        correlationId: `req_${node.nodeId.slice(-7)}_${seq}`,
      } });
      if (outcome === 'denied') report.usageDenied += 1;

      // Native tools run several times per governed call — that ratio is the comparison the Native
      // page draws, so it is generated here rather than as a separate flat sprinkle.
      for (let k = rndInt(1, 4); k > 0; k -= 1) {
        const nseq = nativeSeqByNode.get(node.nodeId) + 1;
        nativeSeqByNode.set(node.nodeId, nseq);
        nativeByNode.get(node.nodeId).push(nativeEnvelope(node, actor, weighted(NATIVE_TOOLS), nseq, ts));
      }
    }

    for (const node of NODES) {
      const events = byNode.get(node.nodeId);
      if (events.length) {
        // The envelope's `seq` is the SHIPMENT number, unique per node — it is the idempotency key
        // (usage_shipments' primary key is (nodeId, seq, kind)), which is what makes a re-run
        // collapse into duplicates rather than a second copy of the day.
        const lines = events.map(({ seq, event }) => JSON.stringify(usageEnvelope(node, seq, event))).join('\n');
        const res = await store.ingestBatch(lines, { authenticatedNodeId: node.nodeId, now: shipAt });
        report.usageAccepted += res.accepted;
        report.usageDuplicates += res.duplicates;
      }
      const natives = nativeByNode.get(node.nodeId);
      if (natives.length) {
        const res = await store.ingestNativeBatch(
          natives.map((n) => JSON.stringify(n)).join('\n'),
          { authenticatedNodeId: node.nodeId, now: shipAt }
        );
        report.native += res.accepted;
      }
    }
  }
}

/** The `subjectId` of the person whose account a node's calls run under. Read off the seeded `user`
 *  principal rather than written down twice, so the event and the registry cannot disagree. */
function subjectFor(node, principalByRef) {
  const user = principalByRef.get(`user:${node.osUser}`);
  return user ? user.subjectId : null;
}

async function seedHealth() {
  for (const node of NODES) {
    const healthy = node.hookStatus === 'healthy';
    await store.ingestNodeHealth(
      {
        nodeId: node.nodeId,
        reportedAt: minutesAgo(3),
        hooks: {
          status: node.hookStatus,
          installedCount: healthy ? 6 : 4,
          installableCount: 6,
          brokenCount: healthy ? 0 : 2,
          tamperCount: 0,
        },
        divergence: { enforcing: true, pause: null },
      },
      { authenticatedNodeId: node.nodeId, now: NOW }
    );
    report.health += 1;
    report.nodes += 1;
  }
}

// ---------------------------------------------------------------------------------------------

async function seed() {
  // migrate:true — this is the provisioning run. Against the DIRECT connection so the DDL lands.
  await store.open(undefined, { migrate: true });
  const driver = store.requireDriver();

  report.policyVersion.before = await policy.policyVersion(driver);

  const capByRef = await seedCapabilities(driver);
  const principalByRef = await seedPrincipals(driver);
  grantState = await seedGrants(driver, capByRef, principalByRef);
  await seedApprovals(driver, capByRef, principalByRef);
  await seedAudit(driver, capByRef, principalByRef);

  report.policyVersion.after = await policy.policyVersion(driver);
  // The replica version the denial reasons quote — read after the policy half so the sentence on a
  // denied event names the version the catalog it was denied against actually reached.
  policyStamp = report.policyVersion.after;

  await seedTraffic(capByRef, principalByRef);
  await seedHealth();

  await store.close();

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const line = (label, n, extra = '') => console.log(`  ${label.padEnd(24)}${String(n).padStart(6)}${extra}`);
  console.log(`\nSeeded the live demo (clock ${report.now}):\n`);
  console.log('  policy');
  line('capabilities', report.capabilities.created, `  (${report.capabilities.existing} already present)`);
  line('principals', report.principals.created, `  (${report.principals.existing} already present)`);
  line('grants', report.grants.created, `  (${report.grants.existing} already present)`);
  line('  of those revoked', report.grants.revoked);
  line('  of those expiring', report.grants.expiring);
  line('approvals', report.approvals);
  line('audit entries', report.audit);
  console.log(`\n  policy version ${report.policyVersion.before} -> ${report.policyVersion.after}\n`);
  console.log('  fleet');
  line('nodes', report.nodes);
  line('usage events', report.usageAccepted, `  (${report.usageDuplicates} duplicate — re-run)`);
  line('  of those denied', report.usageDenied);
  line('native observations', report.native);
  line('health reports', report.health);
  console.log('');
  console.log('Next: point the Vercel function\'s DATABASE_URL at the POOLED Supabase URL (port 6543)');
  console.log('and set WINDROW_CENTRAL_DEMO_READONLY=1. See docs/design/vercel-supabase-demo.md.');
}

seed().catch((err) => {
  console.error('[seed-demo] failed:', err.stack || err.message);
  process.exit(1);
});
