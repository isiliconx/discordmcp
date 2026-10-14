import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRest, DiscordApiError } from '../src/rest.js';
import { validateApiPath } from '../src/security.js';

const token = 'test-secret-value';
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
test('user, bot, and OAuth authentication; paths, arrays, reason, and 204 responses', async () => {
  for (const [authType, expected] of [['user', token], ['bot', `Bot ${token}`], ['oauth', `Bearer ${token}`]] as const) {
    const rest = new DiscordRest({ token, authType, fetch: async (url, init) => {
      assert.equal(String(url), 'https://discord.com/api/v10/channels/123456/messages?author_id=1&author_id=2&pinned=false');
      assert.equal((init!.headers as any).Authorization, expected);
      assert.equal((init!.headers as any)['X-Audit-Log-Reason'], 'reason%20with%20%2F%20slash');
      assert.equal(init!.redirect, 'error');
      return response(null, 204);
    } });
    assert.deepEqual(await rest.request({ method: 'DELETE', path: '/channels/123456/messages', query: { author_id: ['1', '2'], pinned: false, absent: null }, reason: 'reason with / slash' }), { status: 204, data: null });
  }
});
test('429 retries respect fractional/global limits, and learned buckets apply across routes', async () => {
  let now = 1000, count = 0;
  const waits: number[] = [];
  const rest = new DiscordRest({ token, authType: 'bot', now: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
    fetch: async () => {
      count++;
      if (count === 1) return response({ retry_after: 0.25, global: true }, 429);
      if (count === 2) return response({ id: '1' }, 200, { 'x-ratelimit-bucket': 'shared', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.5' });
      if (count === 3) return response({ id: '2' }, 200, { 'x-ratelimit-bucket': 'shared' });
      return response({ id: '3' });
    } });
  await rest.request({ method: 'GET', path: '/channels/123456/messages/111111' });
  await rest.request({ method: 'GET', path: '/guilds/222222' });
  await rest.request({ method: 'GET', path: '/channels/123456/messages/999999' });
  assert.deepEqual(waits, [300, 500]);
  assert.equal(count, 4);
});
test('bucket hashes are scoped by major channel ID, and 429 waits are bounded', async () => {
  let calls = 0;
  const rest = new DiscordRest({ token, authType: 'user', maxRateLimitWaitMs: 100,
    sleep: async () => { throw new Error('Must not sleep beyond wait budget'); }, fetch: async () => {
      calls++;
      if (calls <= 2) return response({}, 200, { 'x-ratelimit-bucket': 'same', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1' });
      return response({ retry_after: 1000 }, 429);
    } });
  await rest.request({ method: 'GET', path: '/channels/111111/messages' });
  await rest.request({ method: 'GET', path: '/channels/222222/messages' });
  await assert.rejects(rest.request({ method: 'GET', path: '/guilds/333333' }), /longer wait/);
  assert.equal(calls, 3);
});
test('multipart attachments and multipart field uploads preserve data and select correct fields', async () => {
  let calls = 0;
  const rest = new DiscordRest({ token, authType: 'user', fetch: async (_url, init) => {
    calls++;
    const form = init!.body as FormData;
    assert(form instanceof FormData);
    assert.equal((init!.headers as any)['Content-Type'], undefined);
    if (calls === 1) {
      assert.equal(form.get('payload_json'), '{"content":"hello"}');
      assert.equal(await (form.get('files[0]') as File).text(), 'hello');
    } else {
      assert.equal(form.get('name'), 'sticker');
      assert.equal(form.get('payload_json'), null);
      assert.equal(await (form.get('file') as File).text(), 'hello');
    }
    return response({ id: '1' });
  } });
  const file = { filename: 'test.txt', data_base64: Buffer.from('hello').toString('base64') };
  await rest.request({ method: 'POST', path: '/channels/123/messages', body: { content: 'hello' }, files: [file] });
  await rest.request({ method: 'POST', path: '/guilds/123/stickers', content_type: 'multipart', multipart_mode: 'fields', body: { name: 'sticker' }, files: [{ ...file, field: 'file' }] });
});
test('rejects malformed paths, JSON queries, GET bodies, and malformed uploads before fetching', async () => {
  for (const path of ['https://evil.example', '//evil.example', '/../../x', '/%2e%2e/x', '/a/%2f/x', '/a\\b', '/a?token=x', '/a#x', '/api/v10/users/@me', '/bad%']) assert.throws(() => validateApiPath(path));
  validateApiPath('/channels/123/reactions/%F0%9F%91%8D/@me');
  const rest = new DiscordRest({ token, authType: 'user', fetch: async () => { throw new Error('Unexpected fetch'); } });
  await assert.rejects(rest.request({ method: 'GET', path: '/users/@me', query: { x: {} } }), /scalars/);
  await assert.rejects(rest.request({ method: 'GET', path: '/users/@me', body: {} }), /cannot have a body/);
  await assert.rejects(rest.request({ method: 'POST', path: '/channels/123/messages', files: [{ filename: 'a', data_base64: 'bad!!' }] }), /valid base64/);
});
test('redacts echoed credentials and does not retry ambiguous write failures or 403', async () => {
  let calls = 0;
  const rest = new DiscordRest({ token, authType: 'user', fetch: async () => {
    calls++;
    if (calls === 1) throw new Error(`Network contained ${token}`);
    return response({ message: `denied ${token}`, errors: { auth: { token } } }, 403);
  } });
  await assert.rejects(rest.request({ method: 'POST', path: '/channels/123/messages', body: {} }), error => {
    assert(!String(error).includes(token)); assert.match(String(error), /write may have succeeded/); return true;
  });
  await assert.rejects(rest.request({ method: 'DELETE', path: '/channels/123' }), error => {
    assert(error instanceof DiscordApiError); assert.equal(error.status, 403); assert(!error.message.includes(token)); return true;
  });
  assert.equal(calls, 2);
});
test('cancelled queued work is never sent and the request queue recovers from failures', async () => {
  let release!: () => void, calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const rest = new DiscordRest({ token, authType: 'user', fetch: async () => { calls++; await blocked; return response({}); } });
  const first = rest.request({ method: 'GET', path: '/users/@me' });
  const controller = new AbortController();
  const second = rest.request({ method: 'GET', path: '/users/123' }, controller.signal);
  controller.abort(); release();
  await first; await assert.rejects(second);
  await rest.request({ method: 'GET', path: '/users/456' });
  assert.equal(calls, 2);
});
test('user message lookup uses history, returns the exact target, and refuses nearby/deleted messages', async () => {
  let calls = 0;
  const rest = new DiscordRest({ token, authType: 'user', fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://discord.com/api/v10/channels/123456/messages?around=987654&limit=1');
    assert.equal((init!.headers as any).Authorization, token);
    return response([{ id: calls === 1 ? '987654' : '987655', content: 'body' }]);
  } });
  const request = { method: 'GET' as const, path: '/channels/123456/messages/987654' };
  assert.deepEqual(await rest.request(request), { status: 200, data: { id: '987654', content: 'body' } });
  await assert.rejects(rest.request(request), error => error instanceof DiscordApiError && error.status === 404 && (error.details as any).code === 10008);
});
test('bot and OAuth message lookups retain the direct endpoint and user lookups propagate access errors', async () => {
  for (const authType of ['bot', 'oauth'] as const) {
    const rest = new DiscordRest({ token, authType, fetch: async url => {
      assert.equal(String(url), 'https://discord.com/api/v10/channels/123/messages/456');
      return response({ id: '456' });
    } });
    assert.deepEqual((await rest.request({ method: 'GET', path: '/channels/123/messages/456' })).data, { id: '456' });
  }
  const rest = new DiscordRest({ token, authType: 'user', fetch: async () => response({ message: 'Missing Access', code: 50001 }, 403) });
  await assert.rejects(rest.request({ method: 'GET', path: '/channels/123/messages/456' }), error => error instanceof DiscordApiError && error.status === 403);
});
