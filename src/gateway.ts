import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Config } from './config.js';
import type { DiscordRest } from './rest.js';
import { redact } from './security.js';

export interface GatewayEvent { id: number; type: string; received_at: string; sequence: number | null; data: unknown }
interface Payload { op: number; d: any; s?: number | null; t?: string }
type State = 'disconnected' | 'connecting' | 'ready' | 'reconnecting';
interface GatewayOptions { socketFactory?: (url: URL) => WebSocket; maxBufferedBytes?: number }
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
export class DiscordGateway {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAck = true;
  private running = false;
  private state: State = 'disconnected';
  private sequence: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private gatewayUrl?: string;
  private nextId = 1;
  private events: GatewayEvent[] = [];
  private eventSizes: number[] = [];
  private bufferedBytes = 0;
  private waiters = 0;
  private readonly emitter = new EventEmitter();
  private connectPromise?: Promise<unknown>;
  private reconnectAttempts = 0;
  private sentTimes: number[] = [];
  private lastError?: string;
  constructor(private readonly config: Config, private readonly rest: DiscordRest, private readonly options: GatewayOptions = {}) {
    this.emitter.setMaxListeners(100);
  }
  status() {
    return { state: this.state, auth_type: this.config.authType, intents: this.config.intents,
      experimental: this.config.authType === 'user', buffered_events: this.events.length,
      buffered_bytes: this.bufferedBytes, active_waiters: this.waiters,
      oldest_event_id: this.events[0]?.id ?? null, latest_event_id: this.nextId - 1,
      last_error: this.lastError ?? null };
  }
  async connect() {
    if (this.state === 'ready') return this.status();
    if (this.connectPromise) return this.connectPromise;
    if (this.config.authType === 'oauth') throw new Error('OAuth2 bearer tokens do not support this Gateway implementation. Use REST tools.');
    this.connectPromise = this.start();
    try { return await this.connectPromise; } finally { this.connectPromise = undefined; }
  }
  private async start() {
    clearTimeout(this.heartbeat); clearTimeout(this.reconnectTimer);
    const previous = this.socket; this.socket = undefined; previous?.close(1000);
    this.running = true;
    this.state = 'connecting';
    this.lastError = undefined;
    try {
      if (!this.gatewayUrl) {
        const response = await this.rest.request({ method: 'GET', path: '/gateway' });
        this.gatewayUrl = (response.data as { url: string }).url;
      }
      const result = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Gateway did not become ready within 20 seconds.')); }, 20_000);
        const ready = () => { cleanup(); resolve(this.status()); };
        const fatal = (message: string) => { cleanup(); reject(new Error(message)); };
        const cleanup = () => { clearTimeout(timer); this.emitter.off('ready', ready); this.emitter.off('fatal', fatal); };
        this.emitter.once('ready', ready);
        this.emitter.once('fatal', fatal);
      });
      try { this.open(); } catch (error) { this.emitter.emit('fatal', error instanceof Error ? error.message : 'Gateway could not connect.'); }
      return await result;
    } catch (error) { this.disconnect(); throw error; }
  }
  private open() {
    const url = new URL(this.resumeUrl ?? this.gatewayUrl!);
    if (url.protocol !== 'wss:' || !(url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg')) || url.username || url.password || (url.port && url.port !== '443')) {
      throw new Error('Discord supplied an unexpected Gateway URL.');
    }
    url.search = '?v=10&encoding=json';
    this.sentTimes = [];
    const socket = this.options.socketFactory?.(url) ?? new WebSocket(url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15_000 });
    this.socket = socket;
    socket.on('message', raw => {
      if (socket !== this.socket) return;
      try { this.receive(JSON.parse(raw.toString()) as Payload); }
      catch { this.lastError = 'Malformed Gateway payload or protocol error.'; socket.close(4000); }
    });
    socket.on('error', () => { this.lastError = 'Gateway connection failed.'; });
    socket.on('close', (code) => {
      if (socket !== this.socket) return;
      clearTimeout(this.heartbeat);
      this.state = 'disconnected';
      if (FATAL_CODES.has(code)) {
        this.running = false;
        this.lastError = `Gateway rejected the connection (close code ${code}). Check authentication and bot intents.`;
        this.emitter.emit('fatal', this.lastError);
      } else if (this.running) {
        this.state = 'reconnecting';
        if (code === 4007 || code === 4009) { this.sessionId = undefined; this.sequence = null; }
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 5)) + Math.random() * 1000;
        this.reconnectTimer = setTimeout(() => {
          if (!this.running) return;
          try { this.open(); } catch { this.lastError = 'Unable to reopen Gateway.'; this.disconnect(); }
        }, delay);
      }
    });
  }
  private receive(payload: Payload) {
    if (typeof payload.s === 'number') this.sequence = payload.s;
    if (payload.op === 10) {
      const interval = Number(payload.d.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid heartbeat interval.');
      this.heartbeatAck = true;
      const beat = () => {
        if (!this.running) return;
        if (!this.heartbeatAck) { this.socket?.close(4000); return; }
        this.heartbeatAck = false;
        try { this.transmit(1, this.sequence); } catch { this.socket?.close(4000); return; }
        this.heartbeat = setTimeout(beat, interval);
      };
      this.heartbeat = setTimeout(beat, Math.random() * interval);
      if (this.sessionId) this.transmit(6, { token: this.config.token, session_id: this.sessionId, seq: this.sequence });
      else this.transmit(2, {
        token: this.config.token,
        properties: { os: process.platform, browser: 'discordmcp', device: 'discordmcp' },
        ...(this.config.authType === 'bot' ? { intents: this.config.intents } : {}),
      });
    } else if (payload.op === 11) this.heartbeatAck = true;
    else if (payload.op === 1) { this.heartbeatAck = false; this.transmit(1, this.sequence); }
    else if (payload.op === 7) this.socket?.close(4000);
    else if (payload.op === 9) {
      if (!payload.d) { this.sessionId = undefined; this.resumeUrl = undefined; this.sequence = null; }
      this.socket?.close(4000);
    } else if (payload.op === 0 && payload.t) {
      if (payload.t === 'READY') { this.sessionId = payload.d.session_id; this.resumeUrl = payload.d.resume_gateway_url; }
      if (payload.t === 'READY' || payload.t === 'RESUMED') {
        this.state = 'ready'; this.reconnectAttempts = 0; this.lastError = undefined; this.emitter.emit('ready');
      }
      const data = redact(payload.d, [this.config.token, this.config.httpToken, this.sessionId ?? '']);
      this.record(payload.t, data);
    }
  }
  private record(type: string, data: unknown) {
    const event = { id: this.nextId++, type, received_at: new Date().toISOString(), sequence: this.sequence, data };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push(event); this.eventSizes.push(bytes); this.bufferedBytes += bytes;
    while (this.events.length > 500 || this.bufferedBytes > (this.options.maxBufferedBytes ?? 32 * 1024 * 1024)) {
      this.events.shift(); this.bufferedBytes -= this.eventSizes.shift()!;
    }
    this.emitter.emit('event');
  }
  private transmit(op: number, data: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Gateway is not connected.');
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter(time => time > now - 60_000);
    // Reserve room for heartbeats/identify/resume; Discord allows 120 per minute.
    if (this.sentTimes.length >= (op === 1 || op === 2 || op === 6 ? 120 : 110)) throw new Error('Gateway send rate limit reached; try again later.');
    this.sentTimes.push(now);
    this.socket.send(JSON.stringify({ op, d: data }));
  }
  send(op: number, data: unknown) {
    if (this.config.readOnly) throw new Error('MCP_READ_ONLY blocks application Gateway commands.');
    if (this.state !== 'ready') throw new Error('Call discord_gateway_connect first and wait for ready.');
    if (!Number.isInteger(op) || op < 0 || op > 255 || [0, 1, 2, 6, 7, 9, 10, 11].includes(op)) throw new Error('Use an application Gateway opcode; lifecycle opcodes are managed by this server.');
    this.transmit(op, data);
    return { sent: true, opcode: op };
  }
  interactionPayload(data: Record<string, unknown>) {
    if (data.session_id !== undefined) return data;
    if (this.state !== 'ready' || !this.sessionId) throw new Error('Call discord_gateway_connect before invoking an interaction without a session_id.');
    return { ...data, session_id: this.sessionId };
  }
  redactionSecrets() { return [this.sessionId ?? '']; }
  getEvents(after = 0, types: string[] = [], limit = 100) {
    const matching = this.events.filter(event => event.id > after && (!types.length || types.includes(event.type)));
    const events = matching.slice(0, limit);
    return { events, next_cursor: events.at(-1)?.id ?? Math.max(after, this.nextId - 1),
      has_more: matching.length > limit,
      dropped_events: after > 0 && after < (this.events[0]?.id ?? this.nextId) - 1 };
  }
  async waitEvents(after = 0, types: string[] = [], limit = 100, timeoutMs = 15_000, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const initial = this.getEvents(after, types, limit);
    if (initial.events.length || timeoutMs === 0) return initial;
    if (this.waiters >= 100) throw new Error('Too many Gateway event waiters; retry later.');
    this.waiters++;
    try { await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.emitter.off('event', listener); signal?.removeEventListener('abort', abort); };
      const listener = () => { if (this.getEvents(after, types, limit).events.length) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Cancelled')); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      this.emitter.on('event', listener); signal?.addEventListener('abort', abort, { once: true });
    }); } finally { this.waiters--; }
    return this.getEvents(after, types, limit);
  }
  disconnect() {
    this.running = false;
    clearTimeout(this.heartbeat); clearTimeout(this.reconnectTimer);
    const socket = this.socket; this.socket = undefined;
    socket?.close(1000);
    this.state = 'disconnected'; this.sessionId = undefined; this.resumeUrl = undefined; this.sequence = null;
    this.emitter.emit('fatal', 'Gateway disconnected.');
    return this.status();
  }
}
