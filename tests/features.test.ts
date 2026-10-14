import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordRest } from '../src/rest.js';
import { DiscordFeatures } from '../src/features.js';

const token = 'private-test-key';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
test('signed history cursors resume across instances, resist tampering/cross-channel use, and exclude new messages', async () => {
  const dataset = [8, 7, 6, 5, 4, 3, 2, 1].map(id => ({ id: String(id), channel_id: '123', content: `message ${id}`, author: { id: '1' }, attachments: [] }));
  let calls = 0;
  const rest = new DiscordRest({ token, authType: 'user', fetch: async url => {
    calls++; const parsed = new URL(String(url)); const before = BigInt(parsed.searchParams.get('before') ?? '9999');
    return json(dataset.filter(m => BigInt(m.id) < before).slice(0, Number(parsed.searchParams.get('limit'))));
  } });
  const first = await new DiscordFeatures(token, rest).readHistory({ channel_id: '123', max_messages: 3, page_size: 2 });
  assert.deepEqual(first.messages.map(m => m.id), ['8', '7', '6']); assert(first.next_cursor); assert.equal(first.snapshot_before, '9');
  dataset.unshift({ id: '10', channel_id: '123', content: 'new', author: { id: '1' }, attachments: [] });
  const restart = new DiscordFeatures(token, rest);
  const second = await restart.readHistory({ channel_id: '123', cursor: first.next_cursor!, max_messages: 10, page_size: 3, format: 'full' });
  assert.deepEqual(second.messages.map(m => m.id), ['5', '4', '3', '2', '1']); assert(second.reached_start); assert.equal(second.next_cursor, null);
  const priorCalls = calls;
  await assert.rejects(restart.readHistory({ channel_id: '999', cursor: first.next_cursor! }), /does not match/);
  await assert.rejects(restart.readHistory({ channel_id: '123', cursor: first.next_cursor! + 'x' }), /Invalid/);
  await assert.rejects(new DiscordFeatures('different-account', rest).readHistory({ channel_id: '123', cursor: first.next_cursor! }), /another account/);
  assert.equal(calls, priorCalls); assert(!first.next_cursor!.includes(token));
});
test('history call has a page budget, can continue, and stops nonadvancing responses', async () => {
  const all = Array.from({ length: 25 }, (_, i) => ({ id: String(25 - i), content: 'x' }));
  const rest = new DiscordRest({ token, authType: 'user', fetch: async url => {
    const p = new URL(String(url)); return json(all.filter(m => Number(m.id) < Number(p.searchParams.get('before') ?? 999)).slice(0, Number(p.searchParams.get('limit'))));
  } });
  const features = new DiscordFeatures(token, rest);
  const first = await features.readHistory({ channel_id: '1', max_messages: 1000, page_size: 1 });
  assert.equal(first.pages, 20); assert.equal(first.count, 20); assert(first.has_more);
  const next = await features.readHistory({ channel_id: '1', cursor: first.next_cursor!, max_messages: 1000, page_size: 1 });
  assert.equal(next.count, 5); assert(next.reached_start);
  const stuck = new DiscordFeatures(token, new DiscordRest({ token, authType: 'user', fetch: async () => json([{ id: '5' }]) }));
  await assert.rejects(stuck.readHistory({ channel_id: '1', max_messages: 2, page_size: 1 }), /did not advance/);
});
test('search waits for indexing within budget, flattens results, and exposes offsets without inventing readiness', async () => {
  let now = 0, calls = 0; const waits: number[] = [];
  const rest = new DiscordRest({ token, authType: 'user', fetch: async url => {
    assert.equal(new URL(String(url)).searchParams.get('channel_id'), '2'); calls++;
    return calls <= 2 ? json({ retry_after: calls === 1 ? 0 : 2, code: 110000 }, 202)
      : json({ messages: [[{ id: '1' }], [{ id: '2' }]], total_results: 40 });
  } });
  const features = new DiscordFeatures(token, rest, async ms => { waits.push(ms); now += ms; }, () => now);
  const result = await features.searchMessages({ guild_id: '1', channel_id: '2', query: { limit: 2 }, max_wait_ms: 3000 });
  assert.deepEqual(waits, [500, 2000]); assert.equal(result.results.length, 2); assert(result.index_ready); assert.equal(result.next_offset, 2);
  const pending = new DiscordFeatures(token, new DiscordRest({ token, authType: 'user', fetch: async () => json({ retry_after: 2, code: 110000 }, 202) }));
  const notReady = await pending.searchMessages({ channel_id: '1', max_wait_ms: 0 });
  assert.equal(notReady.status, 202); assert.equal(notReady.index_ready, false); assert.equal(notReady.total_results, null);
  await assert.rejects(pending.searchMessages({}), /Specify/);
});
test('send/reply helper suppresses mentions, preserves nonce, and fails closed on missing reply targets', async () => {
  const requests: any[] = [];
  const rest = new DiscordRest({ token, authType: 'user', fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body)); requests.push(body); return json({ id: '100', content: body.content, message_reference: body.message_reference });
  } });
  const features = new DiscordFeatures(token, rest);
  const result = await features.sendMessage({ channel_id: '1', content: '@everyone hello', message_id: '2', nonce: 'same-send' });
  assert.equal(result.nonce, 'same-send'); assert.equal(requests[0].enforce_nonce, true);
  assert.deepEqual(requests[0].allowed_mentions, { parse: [], replied_user: false });
  assert.deepEqual(requests[0].message_reference, { message_id: '2', channel_id: '1', fail_if_not_exists: true });
  const uncertain = new DiscordFeatures(token, new DiscordRest({ token, authType: 'user', fetch: async () => { throw new Error('network'); } }));
  await assert.rejects(uncertain.sendMessage({ channel_id: '1', content: 'hello', nonce: 'recoverable' }), /nonce is recoverable/);
});
