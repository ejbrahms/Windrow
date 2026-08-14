// Stand-in for real MCP tool discovery. A true implementation would speak the MCP `tools/list`
// JSON-RPC call to each configured server and get a live tool list — that's roadmap item 3
// territory (it needs the same broker/hook plumbing as real enforcement). Until then, this reads
// a checked-in manifest of the tools genuinely available in this environment right now. When
// live introspection replaces this, entries this manifest used to have but a real server no
// longer reports will fall out of the discovery run and pick up `stale: true` automatically —
// that's exactly the mechanism `stale` exists for.
const fs = require('fs');
const path = require('path');

function loadKnownMcpTools() {
  const manifestPath = path.join(__dirname, 'known-mcp-tools.json');
  const list = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return list.map((tool) => ({ ...tool, source: 'mcp-manifest' }));
}

module.exports = { loadKnownMcpTools };
