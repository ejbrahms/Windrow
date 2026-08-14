// Upserts discovered candidates into the store's capability list. See docs/design/api-contract.md
// "Discovery (v1)" for the diff semantics this implements.
const { genId } = require('../id');

const DISCOVERED_SOURCES = new Set(['filesystem', 'usage-history-only', 'mcp-manifest']);

function capKey(kind, name) {
  return `${kind}::${name}`;
}

/** Capabilities from before discovery existed have no `source` — treat them as "manual". */
function migrateMissingFields(db) {
  for (const cap of db.capabilities) {
    if (!cap.source) cap.source = 'manual';
    if (cap.stale === undefined) cap.stale = false;
    if (cap.discoveredAt === undefined) cap.discoveredAt = null;
    if (cap.lastSeenAt === undefined) cap.lastSeenAt = null;
    if (cap.realUsage === undefined) cap.realUsage = null;
  }
}

/**
 * Mutates db.capabilities: creates new capabilities for candidates with no existing match,
 * updates in place (never duplicates) for ones matched by (kind, name), and flags previously-
 * discovered capabilities not seen this run as `stale: true` — never deletes anything, so grants
 * and usage history against a capability stay intact even after it stops being discovered.
 */
function mergeDiscovery(db, candidates) {
  migrateMissingFields(db);
  const now = new Date().toISOString();
  const byKey = new Map(db.capabilities.map((c) => [capKey(c.kind, c.name), c]));
  const seenKeys = new Set();
  const added = [];
  const updated = [];

  for (const candidate of candidates) {
    const key = capKey(candidate.kind, candidate.name);
    seenKeys.add(key);
    const existing = byKey.get(key);
    if (existing) {
      const changed =
        (candidate.description && candidate.description !== existing.description) ||
        (candidate.owner && candidate.owner !== existing.owner) ||
        JSON.stringify(candidate.realUsage || null) !== JSON.stringify(existing.realUsage || null) ||
        existing.stale === true ||
        existing.source !== candidate.source;
      if (candidate.description) existing.description = candidate.description;
      if (candidate.owner) existing.owner = candidate.owner;
      if (candidate.realUsage !== undefined) existing.realUsage = candidate.realUsage || existing.realUsage || null;
      existing.source = candidate.source;
      existing.lastSeenAt = now;
      existing.stale = false;
      if (changed) updated.push(existing);
    } else {
      const capability = {
        id: genId('cap'),
        kind: candidate.kind,
        name: candidate.name,
        owner: candidate.owner || null,
        riskTier: candidate.riskTier || 'mutating',
        description: candidate.description || null,
        source: candidate.source,
        discoveredAt: now,
        lastSeenAt: now,
        stale: false,
        realUsage: candidate.realUsage || null,
      };
      db.capabilities.push(capability);
      byKey.set(key, capability);
      added.push(capability);
    }
  }

  const staled = [];
  for (const cap of db.capabilities) {
    if (!DISCOVERED_SOURCES.has(cap.source)) continue; // "manual" capabilities aren't discovery's to manage
    if (!seenKeys.has(capKey(cap.kind, cap.name)) && !cap.stale) {
      cap.stale = true;
      staled.push(cap);
    }
  }

  return { added, updated, staled };
}

module.exports = { mergeDiscovery, capKey };
