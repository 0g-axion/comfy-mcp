#!/usr/bin/env node
/* comfy-mcp — read-only MCP server over Comfy's read surfaces.
 *
 *   comfy-mcp                    stdio transport (for MCP client configs)
 *   comfy-mcp --http [--port N]  streamable-http transport at POST /mcp
 *
 * Read-only by construction: no key and no signing. COMFY_SESSION may carry
 * an already-issued owner bearer for comfy_jobs; it is forwarded only to that
 * private read, and only on stdio (see http.ts). Base URLs come from COMFY_ENGINE_ORIGIN /
 * COMFY_INDEXER_GRAPHQL_HTTP with comfy.fun's public mainnet
 * defaults (see src/config.ts). */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ignoredDeployment, resolveConfig } from './config.js';

/* stderr, never stdout: stdout is the protocol */
const ignored = ignoredDeployment();
if (ignored) console.error(`[comfy-mcp] COMFY_INFINITY_DEPLOYMENT is not chainId:manager:splitter; reading comfy.fun instead`);
import { createComfyMcpServer } from './server.js';
import { startHttp } from './http.js';

const DEFAULT_HTTP_PORT = 8931;

function parseArgs(argv: string[]) {
  const http = argv.includes('--http');
  const portFlag = argv[argv.indexOf('--port') + 1];
  const portRaw = Number(argv.includes('--port') ? portFlag : process.env.COMFY_MCP_PORT ?? '');
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65_536 ? portRaw : DEFAULT_HTTP_PORT;
  return { http, port };
}

async function startStdio(): Promise<void> {
  const server = createComfyMcpServer(resolveConfig());
  await server.connect(new StdioServerTransport());
  /* stdout belongs to the protocol; anything human goes to stderr */
  console.error('[comfy-mcp] stdio server ready');
}

const { http, port } = parseArgs(process.argv.slice(2));
if (http) {
  if (resolveConfig().session) console.error('[comfy-mcp] COMFY_SESSION is ignored over --http; comfy_jobs needs stdio');
  startHttp(port).then(({ port: bound }) => {
    console.error(`[comfy-mcp] streamable-http listening on http://127.0.0.1:${bound}/mcp`);
  }).catch((error) => { console.error('[comfy-mcp] failed to start:', error); process.exit(1); });
} else {
  startStdio().catch((error) => { console.error('[comfy-mcp] failed to start:', error); process.exit(1); });
}
