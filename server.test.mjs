/* Behaviour tests for the streamable-http lane: a real MCP client over real
 * HTTP against the stateless /mcp endpoint, upstreams mocked. The stdio lane
 * shares createComfyMcpServer with tools.test.mjs; what this file proves is
 * the transport wiring — routing, JSON handling, and per-request isolation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from './src/http.ts';

const CONFIG = {
  engineOrigin: 'https://engine.test',
  indexerGraphqlHttp: 'https://indexer.test/v1/graphql',
  session: 'owner-session',
  timeoutMs: 1_000,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('streamable-http serves tool listing and calls at POST /mcp', async () => {
  const upstream = async (url) => {
    if (url.startsWith(CONFIG.engineOrigin + '/bazaar/listings')) return json([{ id: 'listing-9', price_og: 9 }]);
    throw new TypeError('fetch failed');
  };
  const running = await startHttp(0, '127.0.0.1', CONFIG, upstream);
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    assert.equal('ladder' in tools.find(tool => tool.name === 'comfy_build_launch_tx').inputSchema.properties, false);
    for (const name of ['comfy_build_swap_tx', 'comfy_build_launch_tx']) {
      assert.equal(tools.find(tool => tool.name === name).annotations.idempotentHint, false);
    }
    for (const name of ['comfy_swap_quote', 'comfy_build_swap_tx']) {
      assert.equal(tools.find(tool => tool.name === name).inputSchema.properties.slippage_bps.maximum, 5000);
      const invalidSwap = await client.callTool({ name, arguments: {
        token: `0x${'ab'.repeat(20)}`, side: 'buy', amount: '1', slippage_bps: 5001,
        ...(name === 'comfy_build_swap_tx' ? { recipient: `0x${'cd'.repeat(20)}` } : {}),
      } });
      assert.equal(invalidSwap.isError, true);
      assert.match(invalidSwap.content[0].text, /5000/);
    }

    const listed = await client.callTool({ name: 'comfy_bazaar', arguments: {} });
    const body = JSON.parse(listed.content[0].text);
    assert.equal(body.live, true);
    assert.equal(body.data[0].id, 'listing-9');

    /* an indexer-backed tool on the same server reports its outage honestly */
    const downResult = await client.callTool({ name: 'comfy_tokens', arguments: {} });
    const downBody = JSON.parse(downResult.content[0].text);
    assert.equal(downResult.isError, true);
    assert.equal(downBody.live, false);
    assert.equal(downBody.outcome, 'unreachable');

  } finally {
    await client.close();
    await running.close();
  }
});

test('paths other than /mcp answer 404 and malformed JSON answers 400', async () => {
  const running = await startHttp(0, '127.0.0.1', CONFIG, async () => json({}));
  try {
    const missing = await fetch(`http://127.0.0.1:${running.port}/other`, { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).hint, 'POST /mcp');

    const malformed = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_json');
  } finally { await running.close(); }
});

test('the HTTP lane refuses foreign Host or Origin headers and oversized bodies', async () => {
  const running = await startHttp(0, '127.0.0.1', CONFIG, async () => json({}));
  const { request } = await import('node:http');
  const send = (headers, body = '{}') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: running.port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  try {
    assert.equal(await send({ host: 'evil.example' }), 403);
    assert.equal(await send({ origin: 'http://evil.example' }), 403);
    assert.equal(await send({}, 'x'.repeat(1_100_000)).catch(() => 413), 413);
  } finally { await running.close(); }
});
