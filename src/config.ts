import type { AuthType } from './types.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  token: string;
  authType: AuthType;
  intents: number;
  httpToken: string;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  toolMode: 'full' | 'compact';
  readOnly: boolean;
  archiveEnabled: boolean;
  archiveAutoConnect: boolean;
  archivePath: string;
  pacingPath: string;
  minRequestIntervalMs: number;
  minWriteIntervalMs: number;
  pacingJitterMs: number;
}
const csv = (value: string | undefined) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.DISCORD_TOKEN?.trim() ?? '';
  if (!token) throw new Error('Set DISCORD_TOKEN in your environment or run discordmcp setup.');
  if (/\s/.test(token)) throw new Error('DISCORD_TOKEN must be a token without a Bot/Bearer prefix.');
  const authType = env.DISCORD_AUTH_TYPE ?? 'user';
  if (!['user', 'bot', 'oauth'].includes(authType)) throw new Error('DISCORD_AUTH_TYPE must be user, bot, or oauth.');
  const intents = Number(env.DISCORD_GATEWAY_INTENTS ?? 0);
  if (!Number.isSafeInteger(intents) || intents < 0) throw new Error('DISCORD_GATEWAY_INTENTS must be a nonnegative integer.');
  const port = Number(env.MCP_HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP_HTTP_PORT must be between 1 and 65535.');
  const host = env.MCP_HTTP_HOST ?? '127.0.0.1';
  const toolMode = env.MCP_TOOL_MODE ?? 'full';
  if (!['full', 'compact'].includes(toolMode)) throw new Error('MCP_TOOL_MODE must be full or compact.');
  const readOnly = env.MCP_READ_ONLY ?? 'false';
  if (!['true', 'false', '1', '0'].includes(readOnly)) throw new Error('MCP_READ_ONLY must be true or false.');
  const archiveEnabled = env.MCP_ARCHIVE_ENABLED ?? 'false';
  const archiveAutoConnect = env.MCP_ARCHIVE_AUTOCONNECT ?? 'true';
  for (const value of [archiveEnabled, archiveAutoConnect]) if (!['true', 'false', '1', '0'].includes(value)) throw new Error('Archive flags must be true or false.');
  const accountKey = createHash('sha256').update(token).digest('hex').slice(0, 24);
  const timing = (key: string, fallback: number, minimum: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > 30_000) throw new Error(`${key} must be an integer between ${minimum} and 30000.`);
    return value;
  };
  const localHostHeaders = ['localhost', '127.0.0.1', '[::1]'].flatMap(h => [h, `${h}:${port}`]);
  return { token, authType: authType as AuthType, intents, port, host,
    httpToken: env.MCP_HTTP_TOKEN?.trim() ?? '',
    allowedHosts: [...localHostHeaders, ...csv(env.MCP_ALLOWED_HOSTS)],
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS), toolMode: toolMode as Config['toolMode'], readOnly: ['true', '1'].includes(readOnly),
    archiveEnabled: ['true', '1'].includes(archiveEnabled), archiveAutoConnect: ['true', '1'].includes(archiveAutoConnect),
    archivePath: resolve(env.MCP_ARCHIVE_PATH ?? join(homedir(), '.local', 'share', 'discordmcp', accountKey, 'messages.sqlite')),
    pacingPath: resolve(env.MCP_PACING_PATH ?? join(homedir(), '.local', 'share', 'discordmcp', accountKey, 'pacing.sqlite')),
    minRequestIntervalMs: timing('MCP_MIN_REQUEST_INTERVAL_MS', 2000, 1000),
    minWriteIntervalMs: timing('MCP_MIN_WRITE_INTERVAL_MS', 6000, 3000), pacingJitterMs: timing('MCP_PACING_JITTER_MS', 500, 0) };
}
