'use strict';
// Manual smoke test: spawns the server over stdio, lists tools, calls a couple of read-only ones.
// Not part of the package's runtime — run with `node smoke-test.js` from mcp/, then delete or keep
// as a dev sanity check.
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'server.js')],
  });
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('Tools:', tools.tools.map((t) => t.name).join(', '));

  const caps = await client.callTool({ name: 'list_capabilities', arguments: { riskTier: 'destructive' } });
  console.log('\ndestructive capabilities:\n', caps.content[0].text.slice(0, 500));

  const who = await client.callTool({ name: 'who_can_use', arguments: { capability: 'code-review' } });
  console.log('\nwho_can_use code-review:\n', who.content[0].text.slice(0, 800));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
