import { createServer } from 'node:http';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type DiscordRuntime } from './server.js';
import { matchesSecret } from './security.js';

const MAX_BODY = 36 * 1024 * 1024; // Room for 25 MiB of base64 uploads plus JSON metadata.
async function parseBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body exceeds 36 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createHttpServer(runtime: DiscordRuntime): HttpServer {
  const config = runtime.config;
  if (config.httpToken.length < 32) throw new Error('HTTP mode requires MCP_HTTP_TOKEN with at least 32 characters.');
  if (matchesSecret(config.httpToken, config.token)) throw new Error('MCP_HTTP_TOKEN must be different from DISCORD_TOKEN.');
  return createServer(async (req, res) => {
    const respond = (status: number, message: string) => {
      if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); }
    };
    const origin = req.headers.origin;
    if (!config.allowedHosts.includes(req.headers.host ?? '')) { respond(403, 'Unrecognized Host header.'); return; }
    if (origin && !config.allowedOrigins.includes(origin)) { respond(403, 'Origin is not allowed.'); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!matchesSecret(req.headers.authorization ?? '', `Bearer ${config.httpToken}`)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="discordmcp"'); respond(401, 'A valid MCP Bearer token is required.'); return;
    }
    const path = req.url?.split('?')[0];
    if (path === '/health' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (path !== '/mcp') { respond(404, 'Use /mcp.'); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); respond(405, 'Stateless MCP uses POST.'); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { respond(415, 'Content-Type must be application/json.'); return; }
    let body: unknown;
    try { body = await parseBody(req); } catch { respond(400, 'Invalid or oversized JSON request body.'); return; }
    const server = createMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Host/origin validation above also covers health, preflight, and malformed requests.
    res.on('close', () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    catch { respond(500, 'MCP request failed.'); await server.close(); }
  });
}
