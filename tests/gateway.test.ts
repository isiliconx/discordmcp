import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { DiscordGateway } from '../src/gateway.js';
import { DiscordRest } from '../src/rest.js';
import { loadConfig } from '../src/config.js';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: any[] = [];
  send(raw: string) {
    const payload = JSON.parse(raw); this.sent.push(payload);
    if (payload.op === 2) setImmediate(() => this.dispatch('READY', { session_id: 'private-session', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: '123' }, echoed: 'fake-token-value' }));
    if (payload.op === 6) setImmediate(() => this.dispatch('RESUMED', {}));
  }
  close(code = 1000) { this.readyState = WebSocket.CLOSED; this.emit('close', code); }
  dispatch(type: string, data: unknown) { this.emit('message', Buffer.from(JSON.stringify({ op: 0, t: type, s: 1, d: data }))); }
}
const config = loadConfig({ DISCORD_TOKEN: 'fake-token-value' });
function setup(url = 'wss://gateway.discord.gg') {
  const rest = new DiscordRest({ ...config, fetch: async () => new Response(JSON.stringify({ url })) });
  const sockets: FakeSocket[] = [];
  const gateway = new DiscordGateway(config, rest, { socketFactory: actualUrl => {
    assert.equal(actualUrl.search, '?v=10&encoding=json');
    const socket = new FakeSocket(); sockets.push(socket);
    setImmediate(() => socket.emit('message', Buffer.from('{"op":10,"d":{"heartbeat_interval":60000}}')));
    return socket as unknown as WebSocket;
  } });
  return { gateway, sockets };
}
test('Gateway identifies, buffers/redacts events, filters cursors, waits, and sends application opcodes', async () => {
  const { gateway, sockets } = setup();
  try {
    assert.equal((await gateway.connect() as any).state, 'ready');
    assert.equal(sockets[0].sent[0].op, 2);
    assert.equal(sockets[0].sent[0].d.token, config.token);
    assert.equal(gateway.interactionPayload({ type: 2 }).session_id, 'private-session');
    assert(!JSON.stringify(gateway.getEvents()).includes('private-session'));
    assert(!JSON.stringify(gateway.getEvents()).includes(config.token));
    const after = gateway.getEvents().next_cursor;
    const waiting = gateway.waitEvents(after, ['MESSAGE_CREATE'], 1, 1000);
    sockets[0].dispatch('TYPING_START', { channel_id: '1' });
    sockets[0].dispatch('MESSAGE_CREATE', { content: 'hello' });
    const result = await waiting;
    assert.equal(result.events[0].type, 'MESSAGE_CREATE');
    assert.equal(result.next_cursor, after + 2);
    assert.equal(gateway.send(3, { status: 'idle' }).sent, true);
    assert.throws(() => gateway.send(2, {}), /lifecycle/);
    for (let i = 0; i < 510; i++) sockets[0].dispatch('MESSAGE_CREATE', { i });
    assert.equal(gateway.getEvents(0, [], 500).events.length, 500);
    assert.equal(gateway.getEvents(after).dropped_events, true);
    const abort = new AbortController();
    const pending = gateway.waitEvents(99999, [], 1, 1000, abort.signal); abort.abort();
    await assert.rejects(pending);
  } finally { gateway.disconnect(); }
  assert.equal(gateway.status().state, 'disconnected');
});
test('Gateway refuses unexpected URLs and OAuth mode without opening a socket', async () => {
  const { gateway, sockets } = setup('wss://evil.example');
  await assert.rejects(gateway.connect(), /unexpected Gateway URL/);
  assert.equal(sockets.length, 0);
  const oauth = new DiscordGateway({ ...config, authType: 'oauth' }, new DiscordRest({ ...config }));
  await assert.rejects(oauth.connect(), /OAuth2/);
});
test('Gateway resumes a dropped connection and stops reconnecting on fatal auth failures', async () => {
  const { gateway, sockets } = setup();
  try {
    await gateway.connect(); sockets[0].close(4000);
    const deadline = Date.now() + 5000;
    while (gateway.status().state !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sockets.length, 2); assert.equal(gateway.status().state, 'ready');
    assert.equal(sockets[1].sent[0].op, 6); assert.equal(sockets[1].sent[0].d.session_id, 'private-session');
    sockets[1].close(4004);
    assert.equal(gateway.status().state, 'disconnected');
    assert.match(gateway.status().last_error!, /4004/);
  } finally { gateway.disconnect(); }
});
