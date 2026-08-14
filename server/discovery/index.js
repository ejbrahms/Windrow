const path = require('path');
const { scanFilesystem } = require('./scan');
const { loadKnownMcpTools } = require('./mcpManifest');
const { backfillRealUsage } = require('./usageHistory');
const { mergeDiscovery } = require('./merge');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Runs a full discovery pass: real skill directories + the MCP tool manifest + real usage
 * history, then upserts the result into `db.capabilities` (mutated in place) and stores the run
 * on `db.discovery`. Returns `{ranAt, added, updated, staled}`, the same shape GET
 * /api/discovery/last serves.
 */
function runDiscovery(db, repoRoot = REPO_ROOT) {
  let candidates = scanFilesystem();
  candidates = candidates.concat(loadKnownMcpTools());
  candidates = backfillRealUsage(candidates);

  const result = mergeDiscovery(db, candidates);
  const ranAt = new Date().toISOString();
  db.discovery = { ranAt, ...result };
  return db.discovery;
}

module.exports = { runDiscovery };
