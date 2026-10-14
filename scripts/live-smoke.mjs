import { config } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
config({ quiet: true });
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run smoke:live -- [--isolated]\nDefault: read-only account checks. --isolated: create a self-only group DM, test messaging/uploads/Gateway, delete test messages, and leave the group.');
  process.exit(0);
}
if (args.some(arg => arg !== '--isolated')) { console.error('Unknown option. Use --help.'); process.exit(1); }
const isolated = args.includes('--isolated');
if (!process.env.DISCORD_TOKEN) {
  console.error('Set DISCORD_TOKEN in the environment or ignored .env first. Never paste a token into chat or commit it.');
  process.exit(1);
}
const client = new Client({ name: 'discordmcp-live-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: { ...process.env, MCP_TOOL_MODE: 'compact' },
});
let channelId;
let passed = 0, failed = 0;
const data = result => result.structuredContent?.data;
const check = (label, result, ...assertions) => {
  const ok = !result.isError && (!assertions.length || assertions[0] === true);
  console.log(`${label}: ${ok ? 'OK' : 'FAILED'}`);
  if (ok) passed++; else { failed++; process.exitCode = 1; }
  return ok;
};
const call = (name, args = {}) => client.callTool({ name: 'discord_call', arguments: { name, arguments: args } }, undefined, { timeout: 45_000 });
try {
  await client.connect(transport);
  const operations = ['discord_get_my_user', 'discord_list_my_guilds'];
  if ((process.env.DISCORD_AUTH_TYPE ?? 'user') === 'user') operations.push('discord_list_private_channels');
  let accountId;
  for (const name of operations) {
    const result = await call(name);
    // Do not log credentials, private messages, profile information, or server membership.
    check(name, result);
    if (name === 'discord_get_my_user' && !result.isError) accountId = data(result)?.id;
  }
  if (isolated) {
    if ((process.env.DISCORD_AUTH_TYPE ?? 'user') !== 'user' || !accountId) throw new Error('Isolated tests require a successfully authenticated user account.');
    const gateway = await client.callTool({ name: 'discord_gateway_connect' }, undefined, { timeout: 45_000 });
    const ready = check('Gateway READY', gateway, gateway.structuredContent?.state === 'ready');
    const group = await call('discord_create_group_dm', { body: { recipients: [] } });
    if (!check('Create self-only group DM', group)) throw new Error('Could not create isolated test channel.');
    const channel = data(group);
    if (channel.type !== 3 || channel.owner_id !== accountId || channel.recipients?.some(user => user.id !== accountId)) {
      throw new Error('Unexpected test-channel membership; message tests skipped.');
    }
    channelId = channel.id;
    const marker = `Discord MCP verification ${randomUUID()}`;
    const created = await call('discord_create_message', { channel_id: channelId, body: { content: marker, allowed_mentions: { parse: [] } } });
    if (check('Create message', created)) {
      const messageId = data(created).id;
      const route = { channel_id: channelId, message_id: messageId };
      const read = await call('discord_get_message', route);
      check('Read exact message', read, data(read)?.id === messageId && data(read)?.content === marker);
      const edited = await call('discord_update_message', { ...route, body: { content: marker + ' edited' } });
      check('Edit message', edited, data(edited)?.content === marker + ' edited');
      check('Add reaction', await call('discord_add_my_message_reaction', { ...route, emoji_name: '👍' }));
      const reactions = await call('discord_list_message_reactions_by_emoji', { ...route, emoji_name: '👍' });
      check('Read reactions', reactions, data(reactions)?.some(user => user.id === accountId));
      check('Remove reaction', await call('discord_delete_my_message_reaction', { ...route, emoji_name: '👍' }));
      check('Pin message', await call('discord_create_pin', route));
      const pins = await call('discord_list_pins', { channel_id: channelId });
      check('List pins', pins, data(pins)?.items?.some(item => item.message.id === messageId));
      check('Unpin message', await call('discord_delete_pin', route));
      check('Mark message read', await call('discord_acknowledge_message', { ...route, body: { token: null } }));
      const deleted = await call('discord_delete_message', route);
      if (check('Delete message', deleted)) {
        const missing = await call('discord_get_message', route);
        const correctError = missing.isError && JSON.stringify(missing.content).includes('HTTP 404') && JSON.stringify(missing.content).includes('10008');
        check('Deleted message returns 404', { isError: false }, correctError);
      }
    }
    const upload = await call('discord_create_message', {
      channel_id: channelId, body: { content: marker + ' attachment', allowed_mentions: { parse: [] } },
      files: [{ filename: 'discordmcp-verification.txt', content_type: 'text/plain', data_base64: Buffer.from('Discord MCP attachment test\n').toString('base64') }],
    });
    if (check('Upload attachment', upload, data(upload)?.attachments?.length === 1)) {
      check('Delete upload message', await call('discord_delete_message', { channel_id: channelId, message_id: data(upload).id }));
    }
    check('Read channel history', await call('discord_list_messages', { channel_id: channelId, query: { limit: 5 } }));
    if (ready) {
      const events = await client.callTool({ name: 'discord_gateway_wait_events', arguments: { types: ['MESSAGE_CREATE'], limit: 100, timeout_ms: 5000 } }, undefined, { timeout: 15_000 });
      check('Live MESSAGE_CREATE event', events, events.structuredContent?.events?.some(event => event.data?.channel_id === channelId && event.data?.content?.startsWith(marker)));
    }
  }
} catch {
  failed++;
  console.error('Live MCP smoke test failed. Check local configuration.'); process.exitCode = 1;
} finally {
  if (channelId) {
    try {
      const left = await call('discord_delete_channel', { channel_id: channelId });
      if (!check('Leave isolated group DM', left)) console.error(`Manual cleanup required for test channel ${channelId}.`);
    } catch { console.error(`Manual cleanup required for test channel ${channelId}.`); process.exitCode = 1; }
  }
  if (isolated) { try { await client.callTool({ name: 'discord_gateway_disconnect' }); } catch {} }
  await client.close();
  console.log(`Live checks: ${passed} passed, ${failed} failed.`);
}
