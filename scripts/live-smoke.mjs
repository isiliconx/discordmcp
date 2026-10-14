import { config } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
config({ quiet: true });
if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in the environment or ignored .env first. Never paste a token into chat or commit it.');
  process.exit(1);
}
const client = new Client({ name: 'discordmcp-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env, MCP_TOOL_MODE: 'compact' },
});
try {
  await client.connect(transport);
  const operations = ['discord_get_my_user', 'discord_list_my_guilds'];
  if ((process.env.DISCORD_AUTH_TYPE ?? 'user') === 'user') operations.push('discord_list_private_channels');
  for (const name of operations) {
    const result = await client.callTool({ name: 'discord_call', arguments: { name, arguments: {} } });
    // Do not log credentials, private messages, profile information, or server membership.
    console.log(`${name}: ${result.isError ? 'FAILED (check token mode, scopes, or account restrictions)' : 'OK'}`);
    if (result.isError) process.exitCode = 1;
  }
} catch {
  console.error('Live MCP smoke test failed. Check local configuration.'); process.exitCode = 1;
} finally { await client.close(); }
