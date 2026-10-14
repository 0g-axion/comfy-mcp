/* the streamable-http lane is reachable by any local principal that can
 * open a loopback socket, and it authenticates none of them. So the listener
 * owner's COMFY_SESSION must never ride along on a network client's comfy_jobs
 * call; only the stdio lane (the owner's own MCP client) may forward it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from './src/http.ts';

const OWNER = '0x' + 'a'.repeat(40);
const CONFIG = {
  engineOrigin: 'https://engine.test',
  indexerGraphqlHttp: 'https://indexer.test/v1/graphql',
  session: 'owner-session',
  timeoutMs: 1_000,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* An engine stub that behaves like GET /bazaar/jobs/:address: private rows for
 * the owner's bearer, 401 with no bearer. It records what it was sent. */
function engineStub() {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const authorization = init.headers?.authorization;
    seen.push({ url, authorization });
    if (!url.startsWith(`${CONFIG.engineOrigin}/bazaar/jobs/`)) throw new TypeError('fetch failed');
    if (authorization === `Bearer ${CONFIG.session}`) return json([{ id: 'private-job-1' }]);
    return json({ error: 'sign_in_required' }, 401);
  };
  return { seen, fetchImpl };
}

test('an unauthenticated HTTP client does not inherit the owner COMFY_SESSION', async () => {
  const engine = engineStub();
  const running = await startHttp(0, '127.0.0.1', CONFIG, engine.fetchImpl);
  const client = new Client({ name: 'other-principal', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));

    const result = await client.callTool({ name: 'comfy_jobs', arguments: { address: OWNER } });
    const body = JSON.parse(result.content[0].text);

    assert.equal(engine.seen.length, 1);
    assert.equal(engine.seen[0].authorization, undefined);
    assert.equal(result.isError, true);
    assert.equal(body.live, false);
    assert.equal(body.outcome, 'sign_in_required');
    assert.doesNotMatch(result.content[0].text, /private-job-1/);
  } finally {
    await client.close();
    await running.close();
  }
});
