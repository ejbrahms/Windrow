// Stand-in for real MCP tool discovery. A true implementation would speak the MCP `tools/list`
// JSON-RPC call to each configured server and get a live tool list — that's roadmap item 3
// territory (it needs the same broker/hook plumbing as real enforcement). Until then, this reads
// a checked-in manifest of the tools genuinely available in this environment right now. When
// live introspection replaces this, entries this manifest used to have but a real server no
// longer reports will fall out of the discovery run and pick up `stale: true` automatically —
// that's exactly the mechanism `stale` exists for.
const fs = require('fs');
const path = require('path');
const store = require('../store');

function loadManifestFile(manifestPath) {
  const list = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return list.map((tool) => ({ ...tool, source: 'mcp-manifest' }));
}

/**
 * Custom manifest files an admin has registered on the Sources page (kind 'mcp_manifest' in
 * store.js's discovery_sources table) — same JSON shape as known-mcp-tools.json, for MCP tools
 * this checked-in manifest doesn't know about (a team's own MCP servers). A missing/unreadable
 * file or malformed JSON is skipped rather than failing the whole discovery run — same
 * silent-skip posture scan.js takes on an absent skill directory.
 */
function loadCustomMcpManifests() {
  const candidates = [];
  for (const manifestPath of store.listEnabledMcpManifestPaths()) {
    try {
      candidates.push(...loadManifestFile(manifestPath));
    } catch {
      continue;
    }
  }
  return candidates;
}

/** Built-in manifest plus every configured custom one, deduped by name (built-in wins ties). */
function loadKnownMcpTools() {
  const builtIn = loadManifestFile(path.join(__dirname, 'known-mcp-tools.json'));
  const seenNames = new Set(builtIn.map((tool) => tool.name));
  const custom = loadCustomMcpManifests().filter((tool) => {
    if (seenNames.has(tool.name)) return false;
    seenNames.add(tool.name);
    return true;
  });
  return builtIn.concat(custom);
}

module.exports = { loadKnownMcpTools, loadCustomMcpManifests };
