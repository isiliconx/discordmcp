import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request as httpRequest } from 'node:http';
import { loadConfig } from '../src/config.js';
import { DiscordRest } from '../src/rest.js';
import { DiscordRuntime, createMcpServer } from '../src/server.js';
import { createHttpServer } from '../src/http.js';
import { publicOperations, userOperations, describeOperation } from '../src/catalog.js';

const token = 'fake-discord-credential';
const httpToken = 'fake-http-token-012345678901234567890123456789';
const makeRuntime = (compact = false, fetchImpl: typeof fetch = async () => new Response('{}')) => {
  const config = loadConfig({ DISCORD_TOKEN: token, MCP_HTTP_TOKEN: httpToken, MCP_TOOL_MODE: compact ? 'compact' : 'full' });
  return new DiscordRuntime(config, new DiscordRest({ ...config, fetch: fetchImpl }));
};
async function connect(runtime: DiscordRuntime) {
  const server = createMcpServer(runtime), client = new Client({ name: 'test', version: '1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); runtime.close(); } };
}
test('MCP exposes every public and experimental operation, valid schemas, resources, and descriptions', async () => {
  const { client, close } = await connect(makeRuntime());
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, publicOperations.length + userOperations.length + 21);
    assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
    const ajv = new Ajv({ strict: false, allowUnionTypes: true, validateFormats: false });
    for (const tool of tools) assert.doesNotThrow(() => ajv.compile(tool.inputSchema), tool.name);
    assert.equal((await client.listResources()).resources.length, 2);
    assert.match(JSON.stringify(await client.readResource({ uri: 'discord://guide' })), /untrusted/);
    const description = describeOperation('discord_create_message') as any;
    assert(description.components.schemas.MessageCreateRequest.properties.content);
    assert(!JSON.stringify(await client.callTool({ name: 'discord_capabilities' })).includes(token));
  } finally { await close(); }
});
test('named tools encode emoji path segments, validate IDs, support multipart-only routes, and return remote errors', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const { client, close } = await connect(makeRuntime(false, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: '123', content: 'hello' }));
  }));
  try {
    const created = await client.callTool({ name: 'discord_create_message', arguments: { channel_id: '123456789', body: { content: 'hello' } } });
    assert(!created.isError);
    const payload = JSON.parse(String(requests[0].init!.body));
    assert.equal(payload.content, 'hello'); assert.deepEqual(payload.allowed_mentions, { parse: [], replied_user: false });
    const reaction = publicOperations.find(op => op.method === 'PUT' && op.path.includes('/reactions/{emoji_name}/@me'))!;
    assert(reaction);
    const result = await client.callTool({ name: reaction.name, arguments: { channel_id: '123456789', message_id: '987654321', emoji_name: '👍' } });
    assert(!result.isError); assert.match(requests[1].url, /%F0%9F%91%8D/);
    const invalid = await client.callTool({ name: 'discord_create_message', arguments: { channel_id: 123, body: {} } });
    assert(invalid.isError); assert.equal(requests.length, 2);
    const sticker = await client.callTool({ name: 'discord_create_guild_sticker', arguments: { guild_id: '123456789', body: { name: 'Hi', tags: 'wave' }, files: [{ field: 'file', filename: 's.png', data_base64: 'aGk=' }] } });
    assert(!sticker.isError); assert.equal((requests[2].init!.body as FormData).get('name'), 'Hi');
  } finally { await close(); }
});
test('compact mode retains all operations through discovery and dispatcher', async () => {
  const { client, close } = await connect(makeRuntime(true, async url => {
    assert.equal(String(url), 'https://discord.com/api/v10/users/@me/channels');
    return new Response('[{"id":"123"}]');
  }));
  try {
    assert.equal((await client.listTools()).tools.length, 21);
    const discovered = await client.callTool({ name: 'discord_search_tools', arguments: { query: 'private channels', include_schemas: true } });
    assert.match(JSON.stringify(discovered), /discord_list_private_channels/);
    const result = await client.callTool({ name: 'discord_call', arguments: { name: 'discord_list_private_channels', arguments: {} } });
    assert(!result.isError); assert.match(JSON.stringify(result), /123/);
    const bad = await client.callTool({ name: 'discord_call', arguments: { name: 'discord_delete_channel', arguments: {} } });
    assert(bad.isError);
  } finally { await close(); }
});
test('actual stdio process initializes, exposes tools, calls capabilities, and keeps stdout protocol-clean', async () => {
  const client = new Client({ name: 'stdio-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { ...process.env as Record<string, string>, DISCORD_TOKEN: token, MCP_TOOL_MODE: 'compact', MCP_ARCHIVE_ENABLED: 'false' } });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 21);
    assert(!(await client.callTool({ name: 'discord_capabilities' })).isError);
  } finally { await client.close(); }
});
test('Streamable HTTP authenticates clients, rejects bad hosts/origins, and works end to end', async () => {
  const runtime = makeRuntime(true), listener = createHttpServer(runtime);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address() as { port: number };
  runtime.config.allowedHosts.push(`127.0.0.1:${address.port}`);
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${httpToken}`, Host: 'evil.example', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${httpToken}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${httpToken}` } } }));
    assert.equal((await client.listTools()).tools.length, 21);
    assert(!(await client.callTool({ name: 'discord_capabilities' })).isError);
    assert.equal((await fetch(new URL('/health', url), { headers: { Authorization: `Bearer ${httpToken}` } })).status, 200);
    const oversize = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${httpToken}`, 'Content-Type': 'application/json', 'Content-Length': String(36 * 1024 * 1024 + 1) } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(oversize, 413);
  } finally { await client.close(); runtime.close(); listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); }
});
test('HTTP requires a strong separate credential and rejects malformed configuration', () => {
  const runtime = makeRuntime(true);
  runtime.config.httpToken = runtime.config.token;
  runtime.config.token = runtime.config.httpToken = 'same-token-that-has-at-least-32-characters';
  assert.throws(() => createHttpServer(runtime), /different/);
  runtime.config.httpToken = 'short';
  assert.throws(() => createHttpServer(runtime), /at least 32/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'Bot x' }), /without a Bot/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: token, MCP_TOOL_MODE: 'missing' }), /full or compact/);
});
test('MCP read-only mode rejects named, generic, helper, and Gateway writes while retaining reads', async () => {
  let calls = 0;
  const config = loadConfig({ DISCORD_TOKEN: token, MCP_TOOL_MODE: 'full', MCP_READ_ONLY: 'true' });
  const runtime = new DiscordRuntime(config, new DiscordRest({ ...config, fetch: async () => { calls++; return new Response('{}'); } }));
  const { client, close } = await connect(runtime);
  try {
    for (const [name, args] of [
      ['discord_create_message', { channel_id: '123', body: { content: 'hello' } }],
      ['discord_api_request', { method: 'DELETE', path: '/channels/123' }],
      ['discord_send_message', { channel_id: '123', content: 'hello' }],
      ['discord_reply_to_message', { channel_id: '123', message_id: '456', content: 'hello' }],
      ['discord_gateway_send', { opcode: 3, data: { status: 'online' } }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert(result.isError); assert.match(JSON.stringify(result), /MCP_READ_ONLY/);
    }
    assert.equal(calls, 0);
    assert(!(await client.callTool({ name: 'discord_get_my_user' })).isError);
    assert.equal(calls, 1);
    const caps = await client.callTool({ name: 'discord_capabilities' }); assert.equal(caps.structuredContent?.read_only, true);
  } finally { await close(); }
});
