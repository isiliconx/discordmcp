import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestPacer } from '../src/pacing.js';
import { DiscordRest } from '../src/rest.js';
import { loadConfig } from '../src/config.js';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'discordmcp-pacing-'));
  const config = loadConfig({ DISCORD_TOKEN: 'private-test-token', MCP_PACING_PATH: join(directory, 'pacing.sqlite'), MCP_PACING_JITTER_MS: '0' });
  let now = 1_000_000;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; }, random: () => 0 };
  const first = new RequestPacer(config, clock), second = new RequestPacer(config, clock);
  return { config, first, second, clock, now: () => now, advance: (ms: number) => { now += ms; },
    close: () => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('separate local clients share minimum request/write spacing and a rolling write cap', async () => {
  const f = fixture();
  try {
    const start = f.now();
    await f.first.beforeRequest('GET', '/users/@me');
    await f.second.beforeRequest('GET', '/channels/123'); assert.equal(f.now() - start, 2000);
    const writes: number[] = [];
    for (let i = 0; i < 5; i++) { await (i % 2 ? f.first : f.second).beforeRequest('POST', '/channels/123/messages'); writes.push(f.now()); }
    assert(writes.slice(1).every((at, index) => at - writes[index] >= 6000));
    assert(writes[4] - writes[0] >= 60_000);
    assert.equal(f.first.status().requests_per_minute, 20);
  } finally { f.close(); }
});
test('401 and verification challenges stop later network calls across clients; forbidden routes are cooled separately', async () => {
  const f = fixture(); let fetches = 0;
  try {
    const rest = new DiscordRest({ ...f.config, pacer: f.first, fetch: async () => { fetches++; return new Response('{"code":0}', { status: 401 }); } });
    await assert.rejects(rest.request({ method: 'GET', path: '/users/@me' }), /HTTP 401/);
    await assert.rejects(rest.request({ method: 'GET', path: '/channels/123' }), /activity paused/);
    await assert.rejects(f.second.beforeRequest('POST', '/channels/123/messages'), /activity paused/);
    assert.equal(fetches, 1); assert(f.second.status().paused);
    const refreshed = new RequestPacer({ ...f.config, token: 'refreshed-test-token' }, f.clock);
    try {
      await refreshed.beforeRequest('GET', '/users/@me');
      refreshed.observe('GET', '/channels/999', 403, { code: 50001 });
      await assert.rejects(refreshed.beforeRequest('GET', '/channels/999'), /recently returned HTTP 403/);
      await refreshed.beforeRequest('GET', '/channels/123');
      refreshed.observe('GET', '/channels/123', 403, { code: 40002 });
      await assert.rejects(refreshed.beforeRequest('GET', '/users/@me'), /verification/);
    } finally { refreshed.close(); }
  } finally { f.close(); }
});
test('repeated rate limits stop at three attempts and enforce a shared 10-minute cooldown', async () => {
  const f = fixture(); let calls = 0;
  try {
    const rest = new DiscordRest({ ...f.config, pacer: f.first, now: f.clock.now, sleep: f.clock.sleep,
      fetch: async () => { calls++; return new Response('{"retry_after":1}', { status: 429 }); } });
    await assert.rejects(rest.request({ method: 'GET', path: '/channels/123/messages' }), /activity paused/);
    assert.equal(calls, 3); assert(f.second.status().paused);
    await assert.rejects(f.second.beforeRequest('GET', '/users/@me'), /10 minutes/);
    f.advance(600_001); await f.second.beforeRequest('GET', '/users/@me');
    f.second.observe('GET', '/users/@me', 200, {}); assert(!f.second.status().paused);
  } finally { f.close(); }
});
test('long runs take a rest break, while ordinary idle periods restart the activity window', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 90; i++) { await f.first.beforeRequest('GET', '/channels/123/messages'); f.advance(30_000); }
    await assert.rejects(f.second.beforeRequest('GET', '/channels/123/messages'), /10-minute rest break/);
    assert(f.second.status().rest_until);
    assert(f.second.status().paused); assert(f.second.status().resume_after);
    f.advance(600_001); await f.second.beforeRequest('GET', '/users/@me');
    assert.equal(f.second.status().rest_until, null);
    f.advance(3_000_000); await f.first.beforeRequest('GET', '/users/@me');
    assert.equal(f.first.status().rest_until, null);
  } finally { f.close(); }
});
test('three network failures stop new requests without retrying an ambiguous write', async () => {
  const f = fixture(); let calls = 0;
  try {
    const rest = new DiscordRest({ ...f.config, pacer: f.first, fetch: async () => { calls++; throw new Error('offline'); } });
    for (let i = 0; i < 3; i++) await assert.rejects(rest.request({ method: 'POST', path: '/channels/123/messages', body: { content: 'fixture' } }), /may have succeeded/);
    await assert.rejects(rest.request({ method: 'POST', path: '/channels/123/messages', body: { content: 'fixture' } }), /activity paused/);
    assert.equal(calls, 3); assert(f.second.status().paused);
  } finally { f.close(); }
});
test('the shared rolling request cap prevents a burst across two clients', async () => {
  const f = fixture();
  try {
    const start = f.now();
    for (let i = 0; i < 20; i++) await (i % 2 ? f.first : f.second).beforeRequest('GET', '/users/@me');
    assert.equal(f.now() - start, 38_000);
    await f.second.beforeRequest('GET', '/users/@me'); assert(f.now() - start >= 60_000);
  } finally { f.close(); }
});
test('cancelling a scheduled request releases its unused slot', async () => {
  const f = fixture(); let abortNext = false;
  const third = new RequestPacer(f.config, { ...f.clock, sleep: async (ms, signal) => {
    if (abortNext) { abortNext = false; throw new Error('cancelled'); }
    signal?.throwIfAborted(); f.advance(ms);
  } });
  try {
    const start = f.now(); await f.first.beforeRequest('GET', '/users/@me'); abortNext = true;
    await assert.rejects(third.beforeRequest('GET', '/users/@me'), /cancelled/);
    await f.second.beforeRequest('GET', '/users/@me'); assert.equal(f.now() - start, 2000);
  } finally { third.close(); f.close(); }
});
