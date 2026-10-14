import { createHash } from 'node:crypto';
import type { DatabaseSync as Database } from 'node:sqlite';
import { createRequire } from 'node:module';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ApiRequest, ApiResponse } from './types.js';

type Message = Record<string, any>;
interface Row { channel_id: string; message_id: string; state_json: string; first_seen_at: string; last_seen_at: string; deleted_at: string | null; original_observed: number; version_count: number }
interface Filters { channel_id?: string; guild_id?: string; before?: string; after?: string; query?: string; deleted_only?: boolean; edited_only?: boolean; limit?: number }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const key = (id: string) => id.padStart(20, '0');
const versionFields = ['content', 'attachments', 'embeds', 'components', 'flags', 'sticker_items', 'poll'];
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const fingerprint = (message: Message) => canonical(Object.fromEntries(versionFields.filter(field => Object.hasOwn(message, field)).map(field => [field, message[field]])));

/** Only messages actually observed through this account are saved. No recovery requests. */
export class MessageArchive {
  private readonly db: Database;
  private closed = false;
  private lastError: string | null = null;
  readonly path: string;
  constructor(path: string, token: string) {
    this.path = resolve(path);
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink()) throw new Error('Archive directory must not be a symbolic link.');
    if ((lstatSync(parent).mode & 0o077) !== 0) throw new Error('Archive directory must have owner-only permissions (0700). Choose a private subdirectory.');
    if (!existsSync(this.path)) closeSync(openSync(this.path, 'wx', 0o600));
    const info = lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('Archive must be a regular file owned by the current user.');
    chmodSync(this.path, 0o600);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        channel_id TEXT NOT NULL, message_id TEXT NOT NULL, id_key TEXT NOT NULL, guild_id TEXT,
        state_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        deleted_at TEXT, original_observed INTEGER NOT NULL DEFAULT 0, version_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(channel_id, message_id));
      CREATE INDEX IF NOT EXISTS messages_channel_order ON messages(channel_id, id_key DESC);
      CREATE INDEX IF NOT EXISTS messages_order ON messages(id_key DESC);
      CREATE INDEX IF NOT EXISTS messages_guild_order ON messages(guild_id, id_key DESC);
      CREATE TABLE IF NOT EXISTS versions (
        channel_id TEXT NOT NULL, message_id TEXT NOT NULL, version INTEGER NOT NULL,
        observed_at TEXT NOT NULL, source TEXT NOT NULL, content TEXT, state_json TEXT NOT NULL,
        PRIMARY KEY(channel_id, message_id, version),
        FOREIGN KEY(channel_id,message_id) REFERENCES messages(channel_id,message_id));
      CREATE TABLE IF NOT EXISTS recorder (
        id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, owner TEXT NOT NULL,
        started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT);
    `);
    const binding = createHash('sha256').update('discordmcp/archive/v1\0').update(token).digest('hex');
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('credential', ?)").run(binding);
    if ((this.db.prepare("SELECT value FROM metadata WHERE key='credential'").get() as any).value !== binding) {
      this.db.close(); throw new Error('This archive belongs to a different credential. Choose a separate MCP_ARCHIVE_PATH.');
    }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('created_at', ?)").run(new Date().toISOString());
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private row(channel: string, id: string) { return this.db.prepare('SELECT * FROM messages WHERE channel_id=? AND message_id=?').get(channel, id) as unknown as Row | undefined; }
  private observe(message: Message, source: string, at: string, original: boolean) {
    if (!message || !validId(message.id) || !validId(message.channel_id)) return;
    const prior = this.row(message.channel_id, message.id);
    const previous: Message = prior ? JSON.parse(prior.state_json) : {};
    // Slow history/search responses must not roll a newer Gateway edit backwards.
    if (source === 'rest' && previous.edited_timestamp && (!message.edited_timestamp || message.edited_timestamp < previous.edited_timestamp)) return;
    if (previous.edited_timestamp && message.edited_timestamp && message.edited_timestamp < previous.edited_timestamp) return;
    const state = { ...previous, ...message };
    const hasVersion = versionFields.some(field => Object.hasOwn(state, field));
    const changed = hasVersion && (!prior?.version_count || fingerprint(previous) !== fingerprint(state));
    const count = (prior?.version_count ?? 0) + Number(changed);
    this.db.prepare(`INSERT INTO messages (channel_id,message_id,id_key,guild_id,state_json,first_seen_at,last_seen_at,original_observed,version_count)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(channel_id,message_id) DO UPDATE SET
      guild_id=COALESCE(excluded.guild_id,messages.guild_id),state_json=excluded.state_json,last_seen_at=excluded.last_seen_at,
      original_observed=MAX(messages.original_observed,excluded.original_observed),version_count=excluded.version_count`).run(
      message.channel_id, message.id, key(message.id), state.guild_id ?? null, JSON.stringify(state), prior?.first_seen_at ?? at, at,
      Number(original && typeof state.content === 'string'), count);
    if (changed) this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,?)').run(message.channel_id, message.id, count, at, source, typeof state.content === 'string' ? state.content : null, JSON.stringify(state));
  }
  observeMessages(messages: Message[], source = 'rest', at = new Date().toISOString()) {
    this.transaction(() => { for (const message of messages) this.observe(message, source, at, source === 'gateway:create' || (source === 'rest' && !message?.edited_timestamp)); });
  }
  private deleted(channel: string, id: string, guild: string | undefined, at: string) {
    if (!validId(channel) || !validId(id)) return;
    this.observe({ id, channel_id: channel, ...(guild ? { guild_id: guild } : {}) }, 'delete', at, false);
    this.db.prepare('UPDATE messages SET deleted_at=COALESCE(deleted_at,?), last_seen_at=? WHERE channel_id=? AND message_id=?').run(at, at, channel, id);
  }
  /** Persistence failures are surfaced in status, without retrying an API write. */
  capture(work: () => void) {
    if (this.closed) return;
    try { work(); this.lastError = null; }
    catch { this.lastError = 'Message archive could not save an observation. Check disk space and file permissions.'; }
  }
  observeDispatch(type: string, data: any, at: string) {
    if (type === 'MESSAGE_CREATE' || type === 'MESSAGE_UPDATE') this.observeMessages([data], type === 'MESSAGE_CREATE' ? 'gateway:create' : 'gateway:update', at);
    else if (type === 'MESSAGE_DELETE' || type === 'MESSAGE_DELETE_BULK') this.transaction(() => {
      for (const id of type === 'MESSAGE_DELETE' ? [data.id] : (Array.isArray(data.ids) ? data.ids : [])) this.deleted(data.channel_id, id, data.guild_id, at);
    });
  }
  observeResponse(request: ApiRequest, response: ApiResponse) {
    const route = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(request.path);
    const body = response.data as any;
    if (route && request.method === 'DELETE' && route[2]) {
      this.transaction(() => this.deleted(route[1], route[2], undefined, new Date().toISOString()));
    } else if (route && ['GET', 'POST', 'PATCH'].includes(request.method)) {
      this.observeMessages((Array.isArray(body) ? body : [body]).filter(Boolean).map(message => ({ ...message, channel_id: message.channel_id ?? route[1] })));
    } else if (/^\/(channels|guilds)\/\d+\/messages\/search$/.test(request.path) && Array.isArray(body?.messages)) {
      this.observeMessages(body.messages.flat());
    } else if (/^\/channels\/\d+\/messages\/bulk-delete$/.test(request.path) && request.method === 'POST') {
      const ids = (request.body as any)?.messages;
      if (Array.isArray(ids)) this.transaction(() => { for (const id of ids) this.deleted(request.path.split('/')[2], id, undefined, new Date().toISOString()); });
    }
  }
  private decorate(row: Row) {
    const count = row.version_count;
    const versions = this.db.prepare(`SELECT version,observed_at,source,state_json FROM versions WHERE channel_id=? AND message_id=?
      AND (version=1 OR version>?) ORDER BY version`).all(row.channel_id, row.message_id, Math.max(1, count - 9)) as any[];
    return { ...JSON.parse(row.state_json), archive: {
      source: 'local_observation', deleted: Boolean(row.deleted_at), deleted_at: row.deleted_at,
      first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at,
      original_observed: Boolean(row.original_observed), content_known: typeof JSON.parse(row.state_json).content === 'string',
      version_count: count, versions_truncated: versions.length < count,
      versions: versions.map(({ state_json, ...version }) => ({ ...version, message: JSON.parse(state_json) })),
    } };
  }
  getMessage(channel: string, id: string, offset = 0, limit = 100) {
    if (!validId(channel) || !validId(id) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid archive message ID or version pagination.');
    const row = this.row(channel, id);
    if (!row) return { source: 'local_archive', content_is_untrusted: true, found: false, message: null, versions: [], next_offset: null };
    const versions = this.db.prepare('SELECT version,observed_at,source,state_json FROM versions WHERE channel_id=? AND message_id=? ORDER BY version LIMIT ? OFFSET ?').all(channel, id, limit, offset) as any[];
    return { source: 'local_archive', content_is_untrusted: true, found: true, message: this.decorate(row),
      versions: versions.map(({ state_json, ...version }) => ({ ...version, message: JSON.parse(state_json) })),
      next_offset: offset + versions.length < row.version_count ? offset + versions.length : null };
  }
  list(filters: Filters) {
    const { channel_id, guild_id, before, after, query, deleted_only, edited_only, limit = 100 } = filters;
    if ([channel_id, guild_id, before, after].some(value => value !== undefined && !validId(value)) || !Number.isInteger(limit) || limit < 1 || limit > 1001 || (query !== undefined && (typeof query !== 'string' || query.length > 1000))) throw new Error('Invalid archive filters.');
    const conditions: string[] = [], args: (string | number)[] = [];
    for (const [column, value] of [['channel_id', channel_id], ['guild_id', guild_id]] as const) if (value) { conditions.push(`m.${column}=?`); args.push(value); }
    if (before) { conditions.push('m.id_key<?'); args.push(key(before)); }
    if (after) { conditions.push('m.id_key>=?'); args.push(key(after)); }
    if (deleted_only) conditions.push('m.deleted_at IS NOT NULL');
    if (edited_only) conditions.push("(m.version_count>1 OR json_extract(m.state_json,'$.edited_timestamp') IS NOT NULL)");
    if (query) { conditions.push('EXISTS(SELECT 1 FROM versions v WHERE v.channel_id=m.channel_id AND v.message_id=m.message_id AND instr(lower(v.content),lower(?))>0)'); args.push(query); }
    const rows = this.db.prepare(`SELECT m.* FROM messages m ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY m.id_key DESC LIMIT ?`).all(...args, limit) as unknown as Row[];
    return rows.map(row => this.decorate(row));
  }
  read(filters: Filters) {
    const limit = filters.limit ?? 100;
    const candidates = this.list({ ...filters, limit: limit + 1 });
    const messages = candidates.slice(0, limit);
    return { source: 'local_archive', content_is_untrusted: true, count: messages.length, messages,
      has_more: candidates.length > limit, next_before: candidates.length > limit ? messages.at(-1)!.id : null,
      coverage: 'Observed messages only. Offline periods and undelivered events cannot be recovered.' };
  }
  claimRecorder(owner: string) {
    return this.transaction(() => {
      const now = new Date().toISOString(), stale = new Date(Date.now() - 20_000).toISOString();
      const existing = this.db.prepare('SELECT heartbeat_at FROM recorder WHERE id=1').get() as any;
      if (existing && existing.heartbeat_at > stale) return false;
      this.db.prepare(`INSERT INTO recorder VALUES (1,?,?,?,?,? ,NULL) ON CONFLICT(id) DO UPDATE SET
        pid=excluded.pid,owner=excluded.owner,started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,state=excluded.state,last_error=NULL`).run(process.pid, owner, now, now, 'connecting');
      return true;
    });
  }
  heartbeat(owner: string, state: string, error: string | null) {
    return Number(this.db.prepare('UPDATE recorder SET heartbeat_at=?,state=?,last_error=? WHERE id=1 AND owner=?').run(new Date().toISOString(), state, error ?? this.lastError, owner).changes) === 1;
  }
  releaseRecorder(owner: string) { this.db.prepare("UPDATE recorder SET heartbeat_at='1970-01-01T00:00:00.000Z',state='stopped' WHERE id=1 AND owner=?").run(owner); }
  status() {
    const counts = this.db.prepare('SELECT count(*) AS messages,COALESCE(sum(version_count),0) AS versions,count(deleted_at) AS deleted_messages FROM messages').get();
    const recorder = this.db.prepare('SELECT pid,started_at,heartbeat_at,state,last_error FROM recorder WHERE id=1').get() as any;
    return { enabled: true, ...counts, last_error: this.lastError,
      recorder: recorder ? { ...recorder, active: Date.parse(recorder.heartbeat_at) > Date.now() - 20_000 } : null,
      coverage: 'Only content this account observed through REST or received Gateway events. No retroactive deleted-message recovery. Attachment metadata/URLs are saved; attachment files are not downloaded.' };
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
