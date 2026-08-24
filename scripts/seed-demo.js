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
// WHAT IT SEEDS, and why through the ingest paths rather than raw INSERTs: a synthetic three-node
// fleet with usage events, native observations and hook-health reports. Feeding them through
// store.ingestBatch / ingestNativeBatch / ingestNodeHealth is the same path a real node's shipper
// uses, so the rows, the shipment ledger, the partitions and the node roster all come out
// self-consistent — which is what makes the Fleet overview, nodes, usage, events and native pages
// look like a real deployment instead of hand-placed fixtures.
//
// IDEMPOTENT. The event ids are fixed strings, so a second run redelivers the same shipments and the
// idempotency ledger collapses them — accepted=0, duplicates=N. Re-run it freely.

const { assertNoLegacyEnv } = require('../server/config');

assertNoLegacyEnv();

const store = require('../server/central/store');

const AS_JSON = process.argv.includes('--json');

// A fixed clock so ids and timestamps are stable across runs (idempotence) and the demo always
// shows the same recent window. Anchored a little in the past so every event is "within 24h".
const NOW = new Date('2026-08-24T12:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

// The synthetic fleet. Three machines, each a different shape of user so the roster and the usage
// breakdown have something to distinguish.
const NODES = [
  { nodeId: 'demo-node-aurora', hostname: 'AURORA', osUser: 'ada', incarnation: 'inc_1', hookStatus: 'healthy' },
  { nodeId: 'demo-node-borealis', hostname: 'BOREALIS', osUser: 'linus', incarnation: 'inc_1', hookStatus: 'healthy' },
  { nodeId: 'demo-node-cascade', hostname: 'CASCADE', osUser: 'grace', incarnation: 'inc_2', hookStatus: 'degraded' },
];

// A handful of principal × capability × outcome combinations. Named to read as a real governed
// fleet: agents and humans invoking skills and MCP tools, mostly allowed, some denied, some awaiting.
const CALLS = [
  { principalId: 'agent:claude', capabilityId: 'skill:code-review', outcome: 'allowed', latencyMs: 42 },
  { principalId: 'agent:claude', capabilityId: 'mcp_tool:read_file', outcome: 'allowed', latencyMs: 8 },
  { principalId: 'agent:claude', capabilityId: 'mcp_tool:write_files', outcome: 'denied', latencyMs: 5, reason: 'no grant' },
  { principalId: 'agent:antigravity', capabilityId: 'skill:security-review', outcome: 'allowed', latencyMs: 61 },
  { principalId: 'agent:antigravity', capabilityId: 'mcp_tool:delete_files', outcome: 'denied', latencyMs: 4, reason: 'destructive: needs approval' },
  { principalId: 'human:ada', capabilityId: 'skill:dataviz', outcome: 'allowed', latencyMs: 30 },
  { principalId: 'human:grace', capabilityId: 'mcp_tool:search_threads', outcome: 'allowed', latencyMs: 120 },
  { principalId: 'agent:codex', capabilityId: 'skill:run', outcome: 'awaiting', latencyMs: 2, reason: 'consent requested' },
];

/** Build one usage envelope the way server/usageShipper.js would ship it. */
function usageEnvelope(node, call, seq, offsetMin) {
  return {
    nodeId: node.nodeId,
    kind: 'usage_event',
    seq,
    incarnation: node.incarnation,
    event: {
      id: `demo-${node.nodeId}-${seq}`,
      principalId: call.principalId,
      capabilityId: call.capabilityId,
      ts: minutesAgo(offsetMin),
      outcome: call.outcome,
      latencyMs: call.latencyMs,
      reason: call.reason || null,
      hostname: node.hostname,
      osUser: node.osUser,
      incarnation: node.incarnation,
      capabilityLookupMs: 1,
      grantCheckMs: 1,
      brokerMs: Math.max(0, call.latencyMs - 3),
    },
  };
}

/** One native observation — an unenforced sighting, item 1 of dashboard-placement. */
function nativeEnvelope(node, toolName, seq, offsetMin) {
  return {
    nodeId: node.nodeId,
    id: `demo-native-${node.nodeId}-${seq}`,
    toolName,
    detail: `${toolName} observed on ${node.hostname}`,
    ts: minutesAgo(offsetMin),
    outcome: 'observed',
    incarnation: node.incarnation,
    osUser: node.osUser,
    hostname: node.hostname,
  };
}

async function seed() {
  // migrate:true — this is the provisioning run. Against the DIRECT connection so the DDL lands.
  await store.open(undefined, { migrate: true });

  const summary = { nodes: 0, usageAccepted: 0, usageDuplicates: 0, native: 0, health: 0 };

  for (const node of NODES) {
    // Usage: every call, a few minutes apart, one shipment each.
    const usageLines = CALLS.map((call, i) =>
      JSON.stringify(usageEnvelope(node, call, i + 1, (i + 1) * 7))
    ).join('\n');
    const usage = await store.ingestBatch(usageLines, { authenticatedNodeId: node.nodeId, now: NOW });
    summary.usageAccepted += usage.accepted;
    summary.usageDuplicates += usage.duplicates;

    // Native sightings: a couple per node.
    const nativeLines = ['Bash', 'Read', 'Grep']
      .map((tool, i) => JSON.stringify(nativeEnvelope(node, tool, i + 1, (i + 1) * 11)))
      .join('\n');
    const native = await store.ingestNativeBatch(nativeLines, { authenticatedNodeId: node.nodeId, now: NOW });
    summary.native += native.accepted;

    // Hook health, so the nodes page and the hook-integrity view have something to show.
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
    summary.health += 1;
    summary.nodes += 1;
  }

  await store.close();

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Seeded the live-demo fleet into Supabase:');
    console.log(`  nodes:              ${summary.nodes}`);
    console.log(`  usage events:       ${summary.usageAccepted} accepted, ${summary.usageDuplicates} duplicate (re-run)`);
    console.log(`  native observations:${summary.native}`);
    console.log(`  health reports:     ${summary.health}`);
    console.log('');
    console.log('Next: point the Vercel function\'s DATABASE_URL at the POOLED Supabase URL (port 6543)');
    console.log('and set WINDROW_CENTRAL_DEMO_READONLY=1. See docs/design/vercel-supabase-demo.md.');
  }
}

seed().catch((err) => {
  console.error('[seed-demo] failed:', err.stack || err.message);
  process.exit(1);
});
