import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiRequest, ApiResponse, AuthType } from './types.js';
import { redact, validateApiPath } from './security.js';
import { VERSION } from './version.js';

export class DiscordApiError extends Error {
  constructor(public readonly status: number, public readonly details: unknown) {
    super(`Discord returned HTTP ${status}: ${JSON.stringify(details)}`);
  }
}
interface RestOptions {
  token: string;
  authType: AuthType;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  requestTimeoutMs?: number;
  maxRateLimitWaitMs?: number;
  readOnly?: boolean;
  maxPendingRequests?: number;
  maxResponseBytes?: number;
}
const BASE_URL = 'https://discord.com/api/v10';
const MAX_UPLOAD = 25 * 1024 * 1024;

export class DiscordRest {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly deadlines = new Map<string, number>();
  private readonly buckets = new Map<string, string>();
  private globalDeadline = 0;
  private pendingRequests = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  constructor(private readonly options: RestOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  }
  request(request: ApiRequest, signal?: AbortSignal): Promise<ApiResponse> {
    if (this.options.readOnly && request.method !== 'GET') return Promise.reject(new Error('MCP_READ_ONLY blocks Discord API writes.'));
    if (this.pendingRequests >= (this.options.maxPendingRequests ?? 100)) return Promise.reject(new Error('Discord request queue is full; retry later.'));
    this.pendingRequests++;
    // Serialize requests per account so simultaneous AI calls cannot race a learned bucket.
    const work = this.tail.then(() => this.performWithCompatibility(request, signal));
    const tracked = work.finally(() => { this.pendingRequests--; });
    this.tail = tracked.catch(() => undefined);
    return tracked;
  }
  private async performWithCompatibility(request: ApiRequest, signal?: AbortSignal): Promise<ApiResponse> {
    // Discord's single-message endpoint returns 20002 (bots only) for user accounts.
    // User accounts can read history instead. Match the exact ID so a nearby message
    // is never accidentally returned when the requested message is missing/deleted.
    const singleMessage = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(request.path);
    if (this.options.authType === 'user' && request.method === 'GET' && singleMessage) {
      if (request.body !== undefined || request.files?.length) throw new Error('GET requests cannot have a body or files.');
      const response = await this.perform({ method: 'GET', path: `/channels/${singleMessage[1]}/messages`,
        query: { ...request.query, around: singleMessage[2], limit: 1 } }, signal);
      const message = Array.isArray(response.data) ? response.data.find(item => item?.id === singleMessage[2]) : undefined;
      if (!message) throw new DiscordApiError(404, { message: 'Unknown Message', code: 10008 });
      return { status: 200, data: message };
    }
    return this.perform(request, signal);
  }
  private async perform(request: ApiRequest, signal?: AbortSignal): Promise<ApiResponse> {
    signal?.throwIfAborted();
    validateApiPath(request.path);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) throw new Error('Unsupported HTTP method.');
    if (request.method === 'GET' && (request.body !== undefined || request.files?.length)) throw new Error('GET requests cannot have a body or files.');
    // Preserve explicit mention choices, but keep ordinary sends/edits quiet by default.
    const messageRoute = /^\/channels\/\d+\/messages(?:\/\d+)?$/.test(request.path)
      || /^\/webhooks\/\d+\/[^/]+(?:\/messages\/(?:\d+|@original))?$/.test(request.path);
    if (messageRoute && ['POST', 'PATCH'].includes(request.method) &&
        (request.body === undefined || (request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body)))) {
      const payload = request.body as Record<string, unknown> | undefined;
      if (!payload || !Object.hasOwn(payload, 'allowed_mentions')) request = { ...request, body: { ...payload, allowed_mentions: { parse: [], replied_user: false } } };
    }
    const url = new URL(BASE_URL + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value == null) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Query values must be scalars or arrays of scalars.');
        url.searchParams.append(key, String(item));
      }
    }
    const headers: Record<string, string> = {
      Authorization: this.options.authType === 'user' ? this.options.token
        : `${this.options.authType === 'bot' ? 'Bot' : 'Bearer'} ${this.options.token}`,
      'User-Agent': `DiscordBot (https://github.com/isiliconx/discordmcp, ${VERSION})`,
    };
    if (request.reason !== undefined) {
      if (request.reason.length > 512) throw new Error('Audit log reason must be at most 512 characters.');
      headers['X-Audit-Log-Reason'] = encodeURIComponent(request.reason);
    }
    const body = this.makeBody(request, headers);
    const normalized = request.path.replace(/\d{6,}/g, ':id');
    const major = /^\/(channels|guilds|webhooks)\/([^/]+)/.exec(request.path);
    // Webhook tokens are also major parameters; never expose these internal keys in errors.
    const scope = major ? `${major[1]}:${major[2]}${major[1] === 'webhooks' ? ':' + request.path.split('/')[3] : ''}` : 'none';
    const route = `${request.method}:${normalized}:${scope}`;
    let totalWait = 0;
    for (let attempt = 0; attempt <= 5; attempt++) {
      signal?.throwIfAborted();
      const bucket = this.buckets.get(route) ?? route;
      const waitMs = Math.max(0, this.globalDeadline - this.now(), (this.deadlines.get(bucket) ?? 0) - this.now());
      totalWait += waitMs;
      if (totalWait > (this.options.maxRateLimitWaitMs ?? 120_000)) throw new Error('Discord rate limit requires a longer wait; try again later.');
      if (waitMs > 0) await this.sleep(waitMs, signal);
      const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: request.method, headers, body, signal: combined, redirect: 'error' });
      } catch {
        // Never retry ambiguous network failures: a write may already have succeeded.
        if (signal?.aborted) signal.throwIfAborted();
        throw new Error('Discord request failed or timed out. A write may have succeeded; check before repeating it.');
      }
      const learned = response.headers.get('x-ratelimit-bucket');
      const bucketKey = learned ? `${learned}:${scope}` : bucket;
      if (learned) this.buckets.set(route, bucketKey);
      const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(resetAfter) && resetAfter > 0) {
        this.deadlines.set(bucketKey, this.now() + Math.ceil(resetAfter * 1000));
      }
      let raw: string;
      try { raw = await this.readResponse(response); } catch (error) {
        if (error instanceof Error && error.message === 'Discord response exceeds this server’s size limit.') throw error;
        throw new Error('Discord response was interrupted. Check before repeating a write.');
      }
      let data: unknown = null;
      if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
      if (response.status === 429 && attempt < 5) {
        const limited = data as { retry_after?: number; global?: boolean } | null;
        const retry = Number(limited?.retry_after ?? response.headers.get('retry-after'));
        if (!Number.isFinite(retry) || retry <= 0) throw new DiscordApiError(429, redact(data, [this.options.token]));
        const deadline = this.now() + Math.ceil(retry * 1000) + 50;
        if (limited?.global || response.headers.get('x-ratelimit-global') === 'true') this.globalDeadline = deadline;
        else this.deadlines.set(bucketKey, deadline);
        continue;
      }
      const safeData = redact(data, [this.options.token]);
      if (!response.ok) throw new DiscordApiError(response.status, safeData);
      return { status: response.status, data: safeData };
    }
    throw new Error('Discord rate limit retry budget exhausted.');
  }
  private async readResponse(response: Response): Promise<string> {
    const limit = this.options.maxResponseBytes ?? 16 * 1024 * 1024;
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > limit) {
      await response.body?.cancel(); throw new Error('Discord response exceeds this server’s size limit.');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader.cancel(); throw new Error('Discord response exceeds this server’s size limit.'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  private makeBody(request: ApiRequest, headers: Record<string, string>): BodyInit | undefined {
    const multipart = request.content_type === 'multipart' || Boolean(request.files?.length);
    if (multipart) {
      const form = new FormData();
      if (request.multipart_mode === 'fields') {
        if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))) {
          throw new Error('Multipart fields mode requires an object body.');
        }
        for (const [key, value] of Object.entries(request.body as Record<string, unknown> ?? {})) {
          if (value != null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      } else if (request.body !== undefined) form.append('payload_json', JSON.stringify(request.body));
      let totalSize = 0;
      for (const [index, file] of (request.files ?? []).entries()) {
        if (file.data_base64.length > Math.ceil(MAX_UPLOAD / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data_base64)) {
          throw new Error('File data must be valid base64; each upload is limited to 25 MiB by this server.');
        }
        const bytes = Buffer.from(file.data_base64, 'base64');
        totalSize += bytes.length;
        if (totalSize > MAX_UPLOAD) throw new Error('Combined upload exceeds this server’s 25 MiB limit.');
        form.append(file.field ?? `files[${index}]`, new Blob([new Uint8Array(bytes)], { type: file.content_type ?? 'application/octet-stream' }), file.filename);
      }
      return form;
    }
    if (request.content_type === 'form') {
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new Error('Form encoding requires an object body.');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(request.body)) {
        if (value != null) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      return form;
    }
    if (request.body === undefined) return undefined;
    headers['Content-Type'] = 'application/json';
    return JSON.stringify(request.body);
  }
}
