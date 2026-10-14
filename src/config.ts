import type { AuthType } from './types.js';

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
  const localHostHeaders = ['localhost', '127.0.0.1', '[::1]'].flatMap(h => [h, `${h}:${port}`]);
  return { token, authType: authType as AuthType, intents, port, host,
    httpToken: env.MCP_HTTP_TOKEN?.trim() ?? '',
    allowedHosts: [...localHostHeaders, ...csv(env.MCP_ALLOWED_HOSTS)],
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS), toolMode: toolMode as Config['toolMode'] };
}
