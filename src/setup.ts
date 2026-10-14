import { mkdir, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';

async function hiddenToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive setup requires a terminal. Otherwise set DISCORD_TOKEN through the environment.');
  process.stdout.write('Discord token (hidden input): ');
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((accept, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { cleanup(); reject(new Error('Setup cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); accept(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
export async function setup(directory: string = process.cwd()) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Setup requires an interactive terminal. See .env.example for environment-based setup.');
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const envPath = resolve(target, '.env'), mcpPath = resolve(target, 'mcp.json');
  for (const path of [envPath, mcpPath]) {
    try { await access(path); throw new Error(`${path} already exists. Setup will not overwrite credentials or client configuration.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  process.stdout.write('User mode is experimental; Discord forbids automated user accounts. Bot and OAuth tokens are also supported.\n');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const authType = (await readline.question('Authentication type [user/bot/oauth] (default user): ')).trim() || 'user';
  readline.close();
  const token = await hiddenToken();
  loadConfig({ DISCORD_TOKEN: token, DISCORD_AUTH_TYPE: authType });
  const httpToken = randomBytes(32).toString('hex');
  const env = `DISCORD_AUTH_TYPE=${authType}\nDISCORD_TOKEN=${JSON.stringify(token)}\nMCP_HTTP_TOKEN=${httpToken}\nMCP_TOOL_MODE=full\n`;
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.js');
  const mcp = { mcpServers: { discord: { command: process.execPath, args: [entry, '--env-file', envPath] } } };
  await writeFile(envPath, env, { mode: 0o600, flag: 'wx' });
  await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Saved credentials to ${envPath} (owner-only permissions).\nSaved MCP client configuration to ${mcpPath}. Copy that configuration into your MCP client.\n`);
}
