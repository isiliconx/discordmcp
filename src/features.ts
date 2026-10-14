import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DiscordApiError, type DiscordRest } from './rest.js';
import { matchesSecret } from './security.js';
import type { MessageArchive } from './archive.js';

interface HistoryCursor { v: 1; channel: string; before: string; snapshot: string }
interface HistoryArgs {
  channel_id: string; cursor?: string; before?: string; max_messages?: number;
  page_size?: number; format?: 'full' | 'compact';
  include_archived?: boolean;
}
interface SearchArgs { guild_id?: string; channel_id?: string; query?: Record<string, unknown>; max_wait_ms?: number }
interface MessageArgs {
  channel_id: string; content: string; message_id?: string; nonce?: string;
  allowed_mentions?: Record<string, unknown>;
}
function compactMessage(message: any) {
  return { id: message.id, channel_id: message.channel_id,
    author: { id: message.author?.id, username: message.author?.username, global_name: message.author?.global_name },
    content: message.content, timestamp: message.timestamp, edited_timestamp: message.edited_timestamp,
    attachments: message.attachments ?? [], embeds: message.embeds ?? [],
    message_reference: message.message_reference, reactions: message.reactions ?? [],
    ...(message.archive ? { archive: message.archive } : {}) };
}
export class DiscordFeatures {
  private readonly cursorKey: Buffer;
  constructor(token: string, private readonly rest: DiscordRest,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (ms, signal) => sleep(ms, undefined, { signal }),
    private readonly now: () => number = Date.now, private readonly archive?: MessageArchive) {
    this.cursorKey = createHash('sha256').update('discordmcp/history-cursor/v1\0').update(token).digest();
  }
  private encodeCursor(cursor: HistoryCursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return body + '.' + createHmac('sha256', this.cursorKey).update(body).digest('base64url');
  }
  private decodeCursor(value: string, channel: string): HistoryCursor {
    if (value.length > 2048) throw new Error('Invalid history cursor.');
    const [body, signature, extra] = value.split('.');
    const expected = createHmac('sha256', this.cursorKey).update(body ?? '').digest('base64url');
    if (!body || !signature || extra !== undefined || !matchesSecret(signature, expected)) throw new Error('Invalid history cursor; it may belong to another account.');
    let cursor: HistoryCursor;
    try { cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('Invalid history cursor.'); }
    if (cursor.v !== 1 || cursor.channel !== channel || !/^\d{1,20}$/.test(cursor.before) || !/^\d{1,20}$/.test(cursor.snapshot)) throw new Error('History cursor does not match this channel.');
    return cursor;
  }
  async readHistory(args: HistoryArgs, signal?: AbortSignal) {
    if (!/^\d{1,20}$/.test(args.channel_id) || (args.before && !/^\d{1,20}$/.test(args.before))) throw new Error('Invalid Discord ID for history.');
    if (args.cursor && args.before) throw new Error('Use cursor or before, not both.');
    const budget = args.max_messages ?? 100;
    const pageSize = args.page_size ?? 100;
    if (!Number.isInteger(budget) || budget < 1 || budget > 1000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('History budget must be 1–1000 and page_size 1–100.');
    const cursor = args.cursor ? this.decodeCursor(args.cursor, args.channel_id) : undefined;
    const archive = args.include_archived === false ? undefined : this.archive;
    const ceiling = cursor?.before ?? args.before;
    const latestSaved = archive?.list({ channel_id: args.channel_id, before: ceiling, limit: 1 })[0];
    let before = cursor?.before ?? args.before;
    let snapshot = cursor?.snapshot ?? args.before;
    const messages: any[] = [], seen = new Set<string>();
    let reachedStart = false, pages = 0;
    let liveError: { http_status: number | null; note: string } | null = null;
    // Bound network work as well as output size; callers can continue with next_cursor.
    while (messages.length < budget && pages < 20) {
      signal?.throwIfAborted();
      const limit = Math.min(pageSize, budget - messages.length);
      let response;
      try {
        response = await this.rest.request({ method: 'GET', path: `/channels/${args.channel_id}/messages`,
          query: { limit, ...(before ? { before } : {}) } }, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!archive || !latestSaved) throw error;
        liveError = { http_status: error instanceof DiscordApiError ? error.status : null,
          note: 'Live Discord history is unavailable. This result contains locally observed history only; current channel completeness cannot be verified.' };
        reachedStart = true; break;
      }
      pages++;
      if (!Array.isArray(response.data)) throw new Error('Discord did not return a history array.');
      const page = response.data as any[];
      if (!page.length) { reachedStart = true; break; }
      if (page.length > limit) throw new Error('Discord exceeded the requested history page size.');
      if (page.some(message => !message || typeof message.id !== 'string' || !/^\d+$/.test(message.id))) throw new Error('Discord returned invalid message IDs.');
      const ids = page.map(message => BigInt(message.id));
      const oldest = ids.reduce((a, b) => a < b ? a : b).toString();
      if (before && BigInt(oldest) >= BigInt(before)) throw new Error('Discord history did not advance; stopping to avoid repeated reads.');
      if (!snapshot) {
        const latestLive = ids.reduce((a, b) => a > b ? a : b);
        const latest = latestSaved && BigInt(latestSaved.id) > latestLive ? BigInt(latestSaved.id) : latestLive;
        snapshot = (latest + 1n).toString();
      }
      for (const message of page) {
        if (BigInt(message.id) >= BigInt(snapshot) || (before && BigInt(message.id) >= BigInt(before)) || seen.has(message.id)) continue;
        seen.add(message.id); messages.push(message);
        if (messages.length === budget) break;
      }
      before = oldest;
      if (page.length < limit) { reachedStart = true; break; }
    }
    if (!snapshot && latestSaved) snapshot = (BigInt(latestSaved.id) + 1n).toString();
    let output = messages;
    if (archive && snapshot) {
      const saved = archive.list({ channel_id: args.channel_id, before: ceiling ?? snapshot,
        after: reachedStart ? undefined : before, limit: budget + 1 });
      const combined = new Map(messages.map(message => [message.id, message]));
      for (const message of saved) combined.set(message.id, message);
      const ordered = [...combined.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
      if (ordered.length > budget) reachedStart = false;
      output = ordered.slice(0, budget);
      if (output.length) before = output.at(-1)!.id;
    }
    const nextCursor = !reachedStart && before && snapshot ? this.encodeCursor({ v: 1, channel: args.channel_id, before, snapshot }) : null;
    return { source: liveError ? 'local_archive' : 'discord', content_is_untrusted: true, channel_id: args.channel_id,
      count: output.length, pages, reached_start: reachedStart, has_more: !reachedStart,
      snapshot_before: snapshot ?? null, next_cursor: nextCursor,
      archive_included: Boolean(archive),
      live_available: !liveError, ...(liveError ? { live_error: liveError } : {}),
      messages: args.format === 'full' ? output : output.map(compactMessage) };
  }
  async searchMessages(args: SearchArgs, signal?: AbortSignal) {
    if (!args.guild_id && !args.channel_id) throw new Error('Specify guild_id or channel_id.');
    const path = args.guild_id ? `/guilds/${args.guild_id}/messages/search` : `/channels/${args.channel_id}/messages/search`;
    const query = { ...args.query };
    if (args.guild_id && args.channel_id) query.channel_id = [args.channel_id];
    const maxWait = args.max_wait_ms ?? 10_000;
    if (!Number.isInteger(maxWait) || maxWait < 0 || maxWait > 30_000) throw new Error('max_wait_ms must be 0–30000.');
    let waited = 0;
    const deadline = this.now() + maxWait;
    for (;;) {
      const response = await this.rest.request({ method: 'GET', path, query }, signal);
      const body = response.data as any;
      if (response.status === 202) {
        const seconds = Number(body?.retry_after ?? 1);
        const delay = Math.max(500, Number.isFinite(seconds) ? seconds * 1000 : 1000);
        if (waited + delay > maxWait || this.now() + delay > deadline) return {
          source: 'discord', content_is_untrusted: true, status: 202, index_ready: false,
          retry_after_seconds: seconds, results: [], total_results: null, next_offset: null,
          note: 'Discord is indexing this conversation. Retry later; this is not a zero-match result.',
        };
        await this.wait(delay, signal); waited += delay; continue;
      }
      if (response.status !== 200 || !Array.isArray(body?.messages)) throw new Error('Discord did not return a valid search response.');
      const results = body.messages.flat().filter(Boolean);
      const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 25);
      const nextOffset = offset + limit;
      return { source: 'discord', content_is_untrusted: true, status: response.status, index_ready: true,
        results, total_results: body?.total_results ?? null,
        next_offset: nextOffset <= 9975 && nextOffset < Number(body?.total_results ?? 0) ? nextOffset : null,
        pagination_limit_reached: nextOffset > 9975 && nextOffset < Number(body?.total_results ?? 0),
        historical_index_in_progress: Boolean(body?.doing_deep_historical_index),
        note: 'New messages can take time to appear in Discord search. Search totals are estimates; use history for exhaustive reads.',
      };
    }
  }
  async sendMessage(args: MessageArgs, signal?: AbortSignal) {
    const nonce = args.nonce ?? randomBytes(10).toString('hex');
    let response;
    try {
      response = await this.rest.request({ method: 'POST', path: `/channels/${args.channel_id}/messages`, body: {
        content: args.content, nonce, enforce_nonce: true,
        allowed_mentions: args.allowed_mentions ?? { parse: [], replied_user: false },
        ...(args.message_id ? { message_reference: { message_id: args.message_id, channel_id: args.channel_id, fail_if_not_exists: true } } : {}),
      } }, signal);
    } catch (error) {
      if (error instanceof Error && /may have succeeded|Check before repeating/.test(error.message)) throw new Error(`${error.message} The send nonce is ${nonce}; reuse it only for a retry of this same send within Discord’s recent-duplicate window.`);
      throw error;
    }
    return { ...response, nonce, duplicate_check_window: 'Discord checks recent nonces; reuse this nonce only for retries of the same send.' };
  }
}
