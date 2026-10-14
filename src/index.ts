#!/usr/bin/env node
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { DiscordRuntime, createMcpServer } from './server.js';
import { createHttpServer } from './http.js';
import { setup } from './setup.js';
import { archiveCommand, runRecorder } from './recorder.js';

const help = `discordmcp — Discord Model Context Protocol server\n\nUsage:\n  discordmcp setup [directory]       Save a token and generate MCP client configuration\n  discordmcp [--env-file path]       Start stdio MCP (default)\n  discordmcp --http [--env-file path] Start authenticated Streamable HTTP at /mcp\n  discordmcp --help                  Show this help\n\nDISCORD_TOKEN is required. DISCORD_AUTH_TYPE=user|bot|oauth (default user).\nHTTP requires a separate MCP_HTTP_TOKEN (32+ characters).\nMCP_TOOL_MODE=compact reduces advertised tools while retaining all catalog operations.\n`;
async function main() {
  let args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(help + '\nArchive recording:\n  discordmcp archive start|stop|status --env-file /absolute/path/.env\n  discordmcp --archive-only --env-file /absolute/path/.env\n\nSet MCP_ARCHIVE_ENABLED=true. Observed deleted messages and edit versions are\nretained locally; unseen content cannot be recovered. Background start survives\nAI clients closing, but does not install reboot autostart.\n'); return;
  }
  if (args[0] === 'setup') { if (args.length > 2) throw new Error('Usage: discordmcp setup [directory]'); await setup(args[1]); return; }
  const archiveAction = args[0] === 'archive' ? args[1] : undefined;
  if (args[0] === 'archive') { if (!archiveAction) throw new Error('Usage: discordmcp archive start|stop|status --env-file /absolute/path/.env'); args = args.slice(2); }
  let envFile: string | undefined;
  let http = false;
  let archiveOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--http') http = true;
    else if (args[index] === '--archive-only') archiveOnly = true;
    else if (args[index] === '--env-file' && args[index + 1] && !args[index + 1].startsWith('--')) envFile = args[++index];
    else throw new Error(`Unknown or incomplete option: ${args[index]}. Use --help.`);
  }
  const loaded = loadEnv({ path: resolve(envFile ?? '.env'), quiet: true });
  if (envFile && loaded.error) throw new Error('Could not read the specified --env-file.');
  const config = loadConfig();
  const runtime = new DiscordRuntime(config);
  if (archiveAction) { try { await archiveCommand(runtime, archiveAction, envFile ? resolve(envFile) : undefined); } finally { runtime.close(); } return; }
  if (archiveOnly) { if (http) { runtime.close(); throw new Error('--archive-only cannot be combined with --http.'); } await runRecorder(runtime); return; }
  runtime.startRecording();
  if (http) {
    const listener = createHttpServer(runtime);
    listener.on('error', () => { console.error('Could not start the HTTP listener. Check host/port configuration.'); runtime.close(); process.exitCode = 1; });
    listener.listen(config.port, config.host, () => console.error(`Discord MCP listening at http://${config.host}:${config.port}/mcp (${config.toolMode} tools)`));
    const shutdown = () => { runtime.close(); listener.close(); listener.closeAllConnections(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } else {
    const server = createMcpServer(runtime);
    const transport = new StdioServerTransport();
    server.onclose = () => runtime.close();
    const shutdown = async () => { runtime.close(); await server.close(); };
    process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
    await server.connect(transport);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Failed to start discordmcp.'); process.exitCode = 1; });
