import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveConfig, type McpConfig } from './config.js';
import { createComfyMcpServer } from './server.js';
import type { FetchLike } from './upstream.js';

const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* DNS-rebinding guard: a web page that rebinds its name to 127.0.0.1 still sends its
 * own Host and Origin, so only loopback names are served. */
function loopbackRequest(req: IncomingMessage): boolean {
  const hostname = (value: string) => {
    try { return new URL(`http://${value}`).hostname; } catch { return ''; }
  };
  if (!LOOPBACK_HOSTS.has(hostname(req.headers.host ?? ''))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch { return false; }
}

function answer(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* Stateless streamable-http: one server+transport pair per request, no
 * session table to leak. GET/DELETE (session flows) get the transport's own
 * method-not-allowed answer.
 *
 * NO OWNER SESSION ON THE NETWORK LANE. Nothing here authenticates the
 * connecting client, and loopback is not an OS-user boundary, so any local
 * principal could otherwise call comfy_jobs with the listener owner's
 * COMFY_SESSION. That bearer belongs to the stdio lane, where the owner's own
 * client is the only caller; over HTTP comfy_jobs relays the engine's 401. */
export async function startHttp(
  port: number,
  host = '127.0.0.1',
  config: McpConfig = resolveConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<{ close: () => Promise<void>; port: number }> {
  const networkConfig: McpConfig = { ...config, session: undefined };
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!loopbackRequest(req)) {
      answer(res, 403, { error: 'forbidden_host' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', hint: 'POST /mcp' }));
      return;
    }
    try {
      const server = createComfyMcpServer(networkConfig, fetchImpl);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      let body: unknown;
      if (req.method === 'POST') {
        let raw: string;
        try { raw = await readBody(req); } catch (error) {
          if (!(error instanceof BodyTooLarge)) throw error;
          answer(res, 413, { error: 'payload_too_large' });
          res.on('finish', () => req.destroy());
          return;
        }
        try { body = raw ? JSON.parse(raw) : undefined; } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }
      }
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('[comfy-mcp] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve()))),
  };
}
