import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MessageArchive } from '../src/archive.js';
import { DiscordRest } from '../src/rest.js';
import { DiscordFeatures } from '../src/features.js';
import { DiscordGateway } from '../src/gateway.js';
import { DiscordRuntime, createMcpServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const token = 'archive-test-credential';
const now = () => new Date().toISOString();
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'discordmcp-archive-'));
  const path = join(directory, 'messages.sqlite');
  const archive = new MessageArchive(path, token);
  return { path, archive, cleanup: () => { archive.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const message = (id: string, content = 'original') => ({ id, channel_id: '123', content, author: { id: '1', username: 'fixture' }, attachments: [], edited_timestamp: null });

test('archive preserves partial edits, empty edits, bulk deletions, unknown content, and restart durability', () => {
  const { archive, path, cleanup } = fixture();
  let reopened: MessageArchive | undefined;
  try {
    archive.observeDispatch('MESSAGE_CREATE', message('10'), now());
    archive.observeDispatch('MESSAGE_UPDATE', { id: '10', channel_id: '123', content: 'edited', edited_timestamp: '2026-10-14T01:00:00Z' }, now());
    archive.observeDispatch('MESSAGE_UPDATE', { id: '10', channel_id: '123', content: 'edited', edited_timestamp: '2026-10-14T01:00:00Z' }, now());
    archive.observeDispatch('MESSAGE_UPDATE', { id: '10', channel_id: '123', content: '', edited_timestamp: '2026-10-14T02:00:00Z' }, now());
    archive.observeDispatch('MESSAGE_DELETE_BULK', { channel_id: '123', ids: ['10', '11'] }, now());
    archive.observeDispatch('MESSAGE_DELETE', { channel_id: '123', id: '10' }, now());
    const result = archive.getMessage('123', '10');
    assert(result.found); assert(result.message?.archive.deleted);
    assert.equal(result.message.author.username, 'fixture');
    assert.equal(result.message.content, '');
    assert.deepEqual(result.versions.map(v => v.message.content), ['original', 'edited', '']);
    assert.equal(result.message.archive.version_count, 3);
    assert.equal(archive.getMessage('123', '11').message?.archive.content_known, false);
    assert.equal(archive.getMessage('123', '11').message?.archive.original_observed, false);
    assert.equal(archive.getMessage('123', '12').found, false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    archive.close(); reopened = new MessageArchive(path, token);
    assert.deepEqual(reopened.getMessage('123', '10').versions.map(v => v.message.content), ['original', 'edited', '']);
    assert.equal(reopened.status().deleted_messages, 2);
    assert.throws(() => new MessageArchive(path, 'different-account'), /different credential/);
  } finally { reopened?.close(); cleanup(); }
});

test('stale REST snapshots cannot overwrite newer edits, and literal search finds older versions', () => {
  const { archive, cleanup } = fixture();
  try {
    archive.observeMessages([message('100', 'first version with needle')]);
    archive.observeDispatch('MESSAGE_UPDATE', { id: '100', channel_id: '123', content: 'new version', edited_timestamp: '2026-10-14T01:00:00Z' }, now());
    archive.observeMessages([message('100', 'first version with needle')]);
    archive.observeDispatch('MESSAGE_DELETE', { channel_id: '123', id: '100' }, now());
    const found = archive.read({ query: 'needle', deleted_only: true, edited_only: true });
    assert.equal(found.count, 1); assert.equal(found.messages[0].content, 'new version');
    assert.equal(found.messages[0].archive.version_count, 2);
    assert.equal(archive.read({ query: "' OR 1=1 --" }).count, 0);
    assert.equal(archive.read({ channel_id: '999' }).count, 0);
  } finally { cleanup(); }
});

test('normal history merges deleted messages into bounded, stable pages without omissions or duplicates', async () => {
  const { archive, cleanup } = fixture();
  try {
    const all = Array.from({ length: 10 }, (_, i) => message(String(10 - i)));
    archive.observeMessages(all);
    for (const id of ['10', '8', '6']) archive.observeDispatch('MESSAGE_DELETE', { id, channel_id: '123' }, now());
    const live = all.filter(m => !['10', '8', '6'].includes(m.id));
    const rest = new DiscordRest({ token, authType: 'user', fetch: async url => {
      const params = new URL(String(url)).searchParams;
      return new Response(JSON.stringify(live.filter(m => BigInt(m.id) < BigInt(params.get('before') ?? '9999')).slice(0, Number(params.get('limit')))));
    } });
    rest.onResponse((request, response) => archive.observeResponse(request, response));
    const features = new DiscordFeatures(token, rest, undefined, undefined, archive);
    let page = await features.readHistory({ channel_id: '123', max_messages: 3, page_size: 2 });
    assert.deepEqual(page.messages.map(m => m.id), ['10', '9', '8']); assert(page.messages[0].archive.deleted);
    const seen = page.messages.map(m => m.id);
    live.unshift(message('11', 'new after first page')); archive.observeMessages([live[0]]);
    while (page.next_cursor) {
      page = await features.readHistory({ channel_id: '123', max_messages: 3, page_size: 2, cursor: page.next_cursor });
      assert(page.count <= 3); seen.push(...page.messages.map(m => m.id));
    }
    assert.deepEqual(seen, all.map(m => m.id)); assert(page.reached_start);
    const liveOnly = await features.readHistory({ channel_id: '123', max_messages: 3, include_archived: false });
    assert.deepEqual(liveOnly.messages.map(m => m.id), ['11', '9', '7']);
  } finally { cleanup(); }
});

test('history still returns saved content when every observed message was deleted; full version lists paginate', async () => {
  const { archive, cleanup } = fixture();
  try {
    archive.observeMessages([message('5'), message('4'), message('3')]);
    for (let i = 0; i < 15; i++) archive.observeDispatch('MESSAGE_UPDATE', { id: '5', channel_id: '123', content: `edit ${i}` }, now());
    archive.observeDispatch('MESSAGE_DELETE_BULK', { channel_id: '123', ids: ['5', '4', '3'] }, now());
    const features = new DiscordFeatures(token, new DiscordRest({ token, authType: 'user', fetch: async () => new Response('[]') }), undefined, undefined, archive);
    const first = await features.readHistory({ channel_id: '123', max_messages: 2 });
    assert.deepEqual(first.messages.map(m => m.id), ['5', '4']); assert(first.next_cursor);
    assert(first.messages[0].archive.versions_truncated);
    assert.equal(first.messages[0].archive.versions[0].message.content, 'original');
    const second = await features.readHistory({ channel_id: '123', cursor: first.next_cursor!, max_messages: 2 });
    assert.deepEqual(second.messages.map(m => m.id), ['3']); assert(second.reached_start);
    const versions = archive.getMessage('123', '5', 0, 5);
    assert.equal(versions.versions.length, 5); assert.equal(versions.next_offset, 5);
    assert.equal(archive.getMessage('123', '5', 15, 5).versions[0].message.content, 'edit 14');
  } finally { cleanup(); }
});

test('independent database handles share observations and enforce a single background-recorder lease', () => {
  const { archive, path, cleanup } = fixture(); const second = new MessageArchive(path, token);
  try {
    assert(archive.claimRecorder('first')); assert(!second.claimRecorder('second'));
    assert(archive.heartbeat('first', 'ready', null)); assert(!second.heartbeat('second', 'ready', null));
    archive.observeMessages([message('20')]);
    second.observeDispatch('MESSAGE_UPDATE', { id: '20', channel_id: '123', content: 'second connection edit' }, now());
    assert.equal(archive.getMessage('123', '20').versions.length, 2);
    assert(archive.status().recorder.active); archive.releaseRecorder('first');
    assert(second.claimRecorder('second')); second.releaseRecorder('second');
  } finally { second.close(); cleanup(); }
});
test('normal history falls back explicitly to saved content during live authentication/access failures', async () => {
  const { archive, cleanup } = fixture();
  try {
    archive.observeMessages([message('5'), message('4'), message('3')]);
    const rest = new DiscordRest({ token, authType: 'user', fetch: async () => new Response('{"code":0,"message":"401: Unauthorized"}', { status: 401 }) });
    const features = new DiscordFeatures(token, rest, undefined, undefined, archive);
    const first = await features.readHistory({ channel_id: '123', max_messages: 2 });
    assert.equal(first.source, 'local_archive'); assert.equal(first.live_available, false); assert.equal(first.live_error?.http_status, 401);
    assert.deepEqual(first.messages.map(m => m.id), ['5', '4']); assert(first.next_cursor);
    const next = await features.readHistory({ channel_id: '123', max_messages: 2, cursor: first.next_cursor! });
    assert.deepEqual(next.messages.map(m => m.id), ['3']); assert(next.reached_start);
    await assert.rejects(features.readHistory({ channel_id: '999' }), /HTTP 401/);
    await assert.rejects(features.readHistory({ channel_id: '123', include_archived: false }), /HTTP 401/);
  } finally { cleanup(); }
});

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send(raw: string) { if (JSON.parse(raw).op === 2) setImmediate(() => this.dispatch('READY', { session_id: 'private-session', resume_gateway_url: 'wss://gateway.discord.gg' })); }
  close(code = 1000) { this.readyState = WebSocket.CLOSED; this.emit('close', code); }
  dispatch(type: string, data: unknown) { this.emit('message', Buffer.from(JSON.stringify({ op: 0, t: type, s: 1, d: data }))); }
}
test('MCP archive tools preserve Gateway events beyond the event buffer and capture REST reads/deletes', async () => {
  const { archive, path, cleanup } = fixture(); archive.close();
  const config = loadConfig({ DISCORD_TOKEN: token, MCP_ARCHIVE_ENABLED: 'true', MCP_ARCHIVE_PATH: path, MCP_TOOL_MODE: 'full' });
  const rest = new DiscordRest({ ...config, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/gateway')) return new Response('{"url":"wss://gateway.discord.gg"}');
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify([message('600', 'REST original')]));
  } });
  const socket = new Socket();
  const gateway = new DiscordGateway(config, rest, { socketFactory: () => {
    setImmediate(() => socket.emit('message', Buffer.from('{"op":10,"d":{"heartbeat_interval":60000}}')));
    return socket as unknown as WebSocket;
  } });
  const runtime = new DiscordRuntime(config, rest, gateway), server = createMcpServer(runtime);
  const client = new Client({ name: 'archive-test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct); await gateway.connect();
    for (let id = 1; id <= 510; id++) socket.dispatch('MESSAGE_CREATE', message(String(id), `Gateway ${id}`));
    socket.dispatch('MESSAGE_UPDATE', { id: '1', channel_id: '123', content: 'updated after buffer eviction' });
    socket.dispatch('MESSAGE_DELETE', { id: '1', channel_id: '123' });
    const saved = await client.callTool({ name: 'discord_archive_get_message', arguments: { channel_id: '123', message_id: '1' } });
    assert(!saved.isError); const value = saved.structuredContent as any;
    assert(value.message.archive.deleted); assert.deepEqual(value.versions.map((v: any) => v.message.content), ['Gateway 1', 'updated after buffer eviction']);
    assert.equal(gateway.getEvents(0, [], 500).events.length, 500);
    assert(!(await client.callTool({ name: 'discord_list_messages', arguments: { channel_id: '123' } })).isError);
    assert(!(await client.callTool({ name: 'discord_delete_message', arguments: { channel_id: '123', message_id: '600' } })).isError);
    const found = await client.callTool({ name: 'discord_archive_search', arguments: { query: 'REST original', deleted_only: true } });
    assert.equal(found.structuredContent?.count, 1);
    assert(!JSON.stringify(found).includes(token)); assert(!JSON.stringify(found).includes('private-session'));
    const status = await client.callTool({ name: 'discord_archive_status', arguments: {} });
    assert.equal(status.structuredContent?.messages, 511);
  } finally { await client.close(); await server.close(); runtime.close(); cleanup(); }
});
