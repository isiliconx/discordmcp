import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, openSync, closeSync, lstatSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';

interface Clock { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>; random?: () => number }
export class RequestPacer {
  private readonly db: DatabaseSync;
  private readonly credential: string;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  private readonly random: () => number;
  private closed = false;
  constructor(private readonly config: Config, clock: Clock = {}) {
    this.now = clock.now ?? Date.now; this.wait = clock.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal })); this.random = clock.random ?? Math.random;
    this.credential = createHash('sha256').update(config.token).digest('hex');
    const parent = dirname(config.pacingPath); mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink() || (lstatSync(parent).mode & 0o077)) throw new Error('Pacing state requires a private 0700 directory.');
    if (!existsSync(config.pacingPath)) closeSync(openSync(config.pacingPath, 'wx', 0o600));
    const info = lstatSync(config.pacingPath);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('Pacing state must be a regular file owned by this user.');
    chmodSync(config.pacingPath, 0o600);
    const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.db = new Database(config.pacingPath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, is_write INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state (credential TEXT PRIMARY KEY, until INTEGER NOT NULL DEFAULT 0, reason TEXT,
        rate_streak INTEGER NOT NULL DEFAULT 0, network_streak INTEGER NOT NULL DEFAULT 0,
        cycle_start INTEGER NOT NULL DEFAULT 0, last_activity INTEGER NOT NULL DEFAULT 0, rest_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS denied (credential TEXT NOT NULL, route TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(credential,route));`);
    this.db.prepare('INSERT OR IGNORE INTO state(credential) VALUES (?)').run(this.credential);
  }
  private state() { return this.db.prepare('SELECT * FROM state WHERE credential=?').get(this.credential) as any; }
  private route(method: string, path: string) { return createHash('sha256').update(method + ':' + path).digest('hex'); }
  private blockReason(method: string, path: string) {
    const state = this.state(), now = this.now();
    if (state.reason && (state.until === 0 || state.until > now)) return { reason: state.reason, until: state.until };
    const denied = this.db.prepare('SELECT until FROM denied WHERE credential=? AND route=?').get(this.credential, this.route(method, path)) as any;
    if (denied?.until > now) return { reason: 'This route recently returned HTTP 403; it is paused to prevent repeated denied requests.', until: denied.until };
    if (state.rest_until > now) return { reason: 'Automatic rest break after sustained API activity.', until: state.rest_until };
    return null;
  }
  private reserve(method: string) {
    const now = this.now(), write = method !== 'GET';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.state();
      if (state.rest_until <= now && (state.rest_until || now - state.last_activity >= 600_000 || !state.cycle_start)) {
        this.db.prepare('UPDATE state SET cycle_start=?,last_activity=?,rest_until=0 WHERE credential=?').run(now, now, this.credential);
      } else if (now - state.cycle_start >= 2_700_000) {
        this.db.prepare('UPDATE state SET rest_until=? WHERE credential=?').run(now + 600_000, this.credential);
        this.db.exec('COMMIT'); return null;
      }
      this.db.prepare('DELETE FROM slots WHERE at<?').run(now - 60_000);
      this.db.prepare('DELETE FROM denied WHERE until<?').run(now);
      const slots = this.db.prepare('SELECT at,is_write FROM slots ORDER BY at DESC').all() as any[];
      const writes = slots.filter(slot => slot.is_write);
      const jitter = Math.floor(this.random() * this.config.pacingJitterMs);
      const at = Math.max(now, (slots[0]?.at ?? now - this.config.minRequestIntervalMs) + this.config.minRequestIntervalMs,
        write ? (writes[0]?.at ?? now - this.config.minWriteIntervalMs) + this.config.minWriteIntervalMs : now,
        slots[19] ? slots[19].at + 60_001 : now, write && writes[3] ? writes[3].at + 60_001 : now) + jitter;
      if (at - now > 120_000) throw new Error('Shared account queue needs more than two minutes. Retry later.');
      const row = this.db.prepare('INSERT INTO slots(at,is_write) VALUES (?,?)').run(at, Number(write));
      this.db.prepare('UPDATE state SET last_activity=? WHERE credential=?').run(now, this.credential);
      this.db.exec('COMMIT'); return { id: row.lastInsertRowid, at };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async beforeRequest(method: string, path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let block = this.blockReason(method, path);
    if (block && (!block.until || block.until - this.now() > 120_000)) throw new Error(`Discord activity paused: ${block.reason}`);
    if (block) await this.wait(Math.max(0, block.until - this.now()), signal);
    const slot = this.reserve(method);
    if (!slot) throw new Error('Discord activity paused for a 10-minute rest break after 45 minutes of sustained API activity.');
    try {
      if (slot.at > this.now()) await this.wait(slot.at - this.now(), signal);
      // Other local clients may have received an account challenge during our wait.
      block = this.blockReason(method, path);
      if (block) throw new Error(`Discord activity paused: ${block.reason}`);
      signal?.throwIfAborted();
    } catch (error) { this.db.prepare('DELETE FROM slots WHERE id=?').run(slot.id); throw error; }
  }
  observe(method: string, path: string, status: number, data: any) {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE state SET network_streak=0 WHERE credential=?').run(this.credential);
      if (status === 401 || data?.code === 40002 || data?.captcha_key || data?.captcha_sitekey) {
        this.db.prepare('UPDATE state SET until=0,reason=? WHERE credential=?').run('Authentication or account verification failed. Resolve it in Discord and update the credential before retrying.', this.credential);
      } else if (status === 429) {
        const count = Number(this.state().rate_streak) + 1, seconds = Number(data?.retry_after ?? 1);
        const storm = count >= 3 || seconds > 60;
        this.db.prepare('UPDATE state SET rate_streak=?,until=?,reason=? WHERE credential=?').run(count,
          now + (storm ? 600_000 : Math.max(1000, (Number.isFinite(seconds) ? seconds : 1) * 1000 + 500)),
          storm ? 'Repeated or prolonged rate limiting. Wait at least 10 minutes.' : 'Discord requested a rate-limit cooldown.', this.credential);
      } else {
        this.db.prepare('UPDATE state SET rate_streak=0 WHERE credential=?').run(this.credential);
        if (status === 403) this.db.prepare('INSERT OR REPLACE INTO denied VALUES (?,?,?)').run(this.credential, this.route(method, path), now + 900_000);
        if ([40003, 40004].includes(data?.code)) this.db.prepare('UPDATE state SET until=?,reason=? WHERE credential=?').run(now + 900_000, 'Discord temporarily restricted messaging. Wait at least 15 minutes.', this.credential);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  networkFailure() {
    this.db.prepare('UPDATE state SET network_streak=network_streak+1 WHERE credential=?').run(this.credential);
    if (this.state().network_streak >= 3) this.db.prepare('UPDATE state SET until=?,reason=? WHERE credential=?').run(this.now() + 600_000, 'Repeated network failures. Outgoing requests paused for 10 minutes.', this.credential);
  }
  status() {
    const state = this.state(), now = this.now();
    const blocked = Boolean(state.reason && (!state.until || state.until > now)), resting = state.rest_until > now;
    return { enabled: true, shared_between_local_clients: true,
      minimum_request_interval_ms: this.config.minRequestIntervalMs, minimum_write_interval_ms: this.config.minWriteIntervalMs,
      additional_jitter_ms: this.config.pacingJitterMs, requests_per_minute: 20, writes_per_minute: 4,
      rest_after_minutes: 45, rest_minutes: 10, rest_until: state.rest_until > now ? new Date(state.rest_until).toISOString() : null,
      paused: blocked || resting, reason: blocked ? state.reason : resting ? 'Automatic rest break.' : null,
      resume_after: blocked ? (state.until > now ? new Date(state.until).toISOString() : null) : resting ? new Date(state.rest_until).toISOString() : null };
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
