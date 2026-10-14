import assert from 'node:assert/strict';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/live-archive-smoke.mjs --isolated [--env-file path]\nRequires an enabled archive with a connected background recorder. Creates a self-only group DM, tests original/edit/deletion events, verifies stored history across MCP restarts, deletes fixtures, and leaves the group.');
  process.exit(0);
}
if (!args.includes('--isolated')) throw new Error('Pass --isolated to authorize creation of a self-only test conversation.');
const fileArg = args.indexOf('--env-file');
const envFile = resolve(fileArg >= 0 ? args[fileArg + 1] : '.env');
config({ path: envFile, quiet: true });
if (!process.env.DISCORD_TOKEN || process.env.DISCORD_AUTH_TYPE !== 'user' || process.env.MCP_ARCHIVE_ENABLED !== 'true') throw new Error('Configure user authentication and enable the archive first.');
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
async function connect(archive) {
  const client = new Client({ name: 'archive-live-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, '--env-file', envFile],
    env: { ...process.env, MCP_TOOL_MODE: 'compact', MCP_ARCHIVE_ENABLED: archive ? 'true' : 'false', MCP_ARCHIVE_AUTOCONNECT: 'false' }, stderr: 'pipe' }));
  return client;
}
const mutator = await connect(false);
let reader = await connect(true), channelId, messageId, passed = 0, stage = 'recorder status';
const call = (name, arguments_ = {}) => { stage = name; return mutator.callTool({ name: 'discord_call', arguments: { name, arguments: arguments_ } }, undefined, { timeout: 45_000 }); };
const check = (label, condition) => { assert(condition, label); passed++; console.log(`${label}: OK`); };
const payload = result => result.structuredContent?.data;
async function savedUntil(predicate) {
  const deadline = Date.now() + 15_000;
  do {
    const result = await reader.callTool({ name: 'discord_archive_get_message', arguments: { channel_id: channelId, message_id: messageId } });
    if (!result.isError && predicate(result.structuredContent)) return result.structuredContent;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}
try {
  const status = await reader.callTool({ name: 'discord_archive_status', arguments: {} });
  check('Independent background recorder connected', status.structuredContent?.recorder?.active && status.structuredContent.recorder.state === 'ready');
  const account = await call('discord_get_my_user'); assert(!account.isError && payload(account)?.id);
  const group = await call('discord_create_group_dm', { body: { recipients: [] } });
  assert(!group.isError); const channel = payload(group);
  assert(channel.type === 3 && channel.owner_id === payload(account).id && !channel.recipients?.some(user => user.id !== payload(account).id));
  channelId = channel.id; check('Self-only test channel verified', true);
  const original = `Archive verification ${randomUUID()} original`;
  const edited = original.replace(/original$/, 'edited');
  const sent = await call('discord_create_message', { channel_id: channelId, body: { content: original, allowed_mentions: { parse: [] } } });
  assert(!sent.isError && payload(sent)?.id); messageId = payload(sent).id;
  check('Gateway CREATE preserved without REST capture', Boolean(await savedUntil(data => data?.message?.content === original)));
  const updated = await call('discord_update_message', { channel_id: channelId, message_id: messageId, body: { content: edited } }); assert(!updated.isError);
  const versions = await savedUntil(data => data?.versions?.some(v => v.message.content === original) && data.versions.some(v => v.message.content === edited));
  check('Gateway UPDATE preserves original and edited versions', Boolean(versions));
  const deleted = await call('discord_delete_message', { channel_id: channelId, message_id: messageId }); assert(!deleted.isError);
  check('Gateway DELETE retains content and marks deletion', Boolean(await savedUntil(data => data?.message?.archive?.deleted)));
  const missing = await call('discord_get_message', { channel_id: channelId, message_id: messageId });
  check('Live message endpoint returns deleted-message 404', missing.isError && JSON.stringify(missing.content).includes('HTTP 404'));
  const history = await reader.callTool({ name: 'discord_read_history', arguments: { channel_id: channelId, max_messages: 10 } });
  const retained = history.structuredContent?.messages?.find(message => message.id === messageId);
  check('Normal history includes deleted message and both versions', !history.isError && retained?.content === edited && retained.archive.deleted && retained.archive.versions.some(v => v.message.content === original));
  const search = await reader.callTool({ name: 'discord_archive_search', arguments: { query: original, channel_id: channelId, deleted_only: true } });
  check('Archive search finds text from original version', !search.isError && search.structuredContent?.count === 1);
  await reader.close(); reader = await connect(true);
  const durable = await savedUntil(data => data?.message?.archive?.deleted && data.versions.some(v => v.message.content === original) && data.versions.some(v => v.message.content === edited));
  check('MCP restart preserves deleted message and edit versions', Boolean(durable));
  const offline = await reader.callTool({ name: 'discord_archive_read_channel', arguments: { channel_id: channelId, deleted_only: true } });
  check('Saved history tool works without a reader Gateway session', !offline.isError && offline.structuredContent?.messages?.some(message => message.id === messageId));
} catch {
  console.error(`Archive live verification failed at ${stage}; inspect local credentials and recorder status.`); process.exitCode = 1;
} finally {
  if (channelId) {
    if (messageId) { try { await call('discord_delete_message', { channel_id: channelId, message_id: messageId }); } catch {} }
    try { const left = await call('discord_delete_channel', { channel_id: channelId }); check('Isolated channel cleanup', !left.isError); }
    catch { console.error(`Manual cleanup required for test channel ${channelId}.`); process.exitCode = 1; }
  }
  await reader.close(); await mutator.close();
  console.log(`Archive live checks: ${passed} passed.`);
}
