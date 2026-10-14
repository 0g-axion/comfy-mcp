/* Behaviour-level tests for the fourteen read tools, upstreams mocked.
 *
 * Contracts under test:
 *  - output shape of every tool through a real MCP client/server pair;
 *  - the honesty gates: a never-traded token reports null market figures,
 *    an unknown token is data:null, an unexpected trade side stays null;
 *  - upstream-down behaviour: live:false with a named outcome, never an
 *    invented empty-but-live answer;
 *  - the market tools read the Infinity index through its PUBLIC base reads, and the
 *    GraphQL documents match that collection's ASTs, because the public indexer serves
 *    ONLY those (the indexer's public allowlist). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComfyMcpServer } from './src/server.ts';
import { INFINITY_CANDLES, INFINITY_LAUNCHES, INFINITY_POOLS, INFINITY_TOKENS, INFINITY_TRADES } from './src/queries.ts';
import { ignoredDeployment, resolveConfig, DEFAULT_ENGINE_ORIGIN, DEFAULT_INDEXER_GRAPHQL_HTTP, DEFAULT_INFINITY_DEPLOYMENT } from './src/config.ts';
import { dayWindow, hiddenReason, OFFICIAL_TOKEN_ADDRESSES, RESERVED_TICKERS, TEST_NAME_PATTERNS, TEST_TOKEN_ADDRESSES, visibleTicker } from './src/market.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Cross-checks against sibling Comfy monorepo packages; skipped in the standalone repo.
const MONOREPO_ONLY = { skip: !existsSync(join(HERE, '../../deploy/indexer')) && 'needs the Comfy monorepo' };
const CONFIG = {
  engineOrigin: 'https://engine.test',
  indexerGraphqlHttp: 'https://indexer.test/v1/graphql',
  deploymentId: `16661:0x${'a1'.repeat(20)}:0x${'b2'.repeat(20)}`,
  session: 'owner-session',
  timeoutMs: 1_000,
};
const TOKEN_A = '0x' + 'aa'.repeat(20);
const TOKEN_B = '0x' + 'bb'.repeat(20);
const WALLET = '0x' + 'dd'.repeat(20);
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const POOL_KEY = (token) => `${CONFIG.deploymentId}:0x${token.slice(2, 10).padEnd(64, '0')}`;

/** n 0G (or n tokens) as an 18-decimal fixed-point string */
const OG = (n) => String(BigInt(Math.round(n * 1e6)) * 10n ** 12n);

const tokenRow = (address, over = {}) => ({
  id: `${CONFIG.deploymentId}:${address}`, address, name: 'Agent', symbol: 'AGT', decimals: 18,
  creator: WALLET, holderCount: 3, totalSupply: OG(1_000_000_000), image: null, verified: false,
  launchedPoolKey: POOL_KEY(address), ...over,
});
const poolRow = (address, over = {}) => ({
  id: POOL_KEY(address), kind: null, openingBps: 0, floorBps: 0, launchTimestamp: String(NOW - 7200),
  priceQuotePerTokenX18: OG(0.00002), fdvQuote: OG(20_000), marketCapQuote: OG(500), liquidityQuote: OG(19_000), quoteInPool: OG(300),
  traderCount: 2, tradeCount: '5', lastTradeAt: String(NOW - 100),
  executionQuoteVolume: OG(12), buyQuoteVolume: OG(10), sellQuoteVolume: OG(2), ...over,
});
/* a pool that has launched and never traded: the index still carries its opening
   price and FDV, which are not measured market figures */
const untradedPool = (address) => poolRow(address, {
  traderCount: 0, tradeCount: '0', lastTradeAt: null, marketCapQuote: '0', quoteInPool: '0',
  executionQuoteVolume: '0', buyQuoteVolume: '0', sellQuoteVolume: '0',
});
const launchRow = (address, ts) => ({
  id: `${CONFIG.deploymentId}:${ts}`, token: address, poolKey: POOL_KEY(address),
  timestamp: String(ts), cursor: String(ts).padStart(24, '0'),
});
const hourRow = (address, bucketStart, over = {}) => ({
  id: `${POOL_KEY(address)}:3600:${bucketStart}`, poolKey: POOL_KEY(address), intervalSeconds: 3600,
  bucketStart: String(bucketStart), openX18: OG(0.00001), closeX18: OG(0.00001), volumeQuote: '0', trades: 0, ...over,
});
const tradeRow = (address, ts, over = {}) => ({
  id: `${CONFIG.deploymentId}:0x${String(ts).padStart(64, '0')}:1`, poolKey: POOL_KEY(address),
  transactionHash: `0x${String(ts).padStart(64, '0')}`, timestamp: String(ts), cursor: String(ts).padStart(24, '0'),
  isBuy: true, trader: WALLET, executionTokenAmount: OG(1000), executionQuoteAmount: OG(0.02),
  effectivePriceX18: OG(0.00002), spotPriceX18: OG(0.000021), ...over,
});

/** A small Infinity index: answers the five public base reads by name, applying their
 *  `$where` (_and, _eq, _in, _gt, _gte), `$after` and `$limit` the way Hasura does,
 *  capped at 100 rows a page like the public edge. */
function fakeIndex({ launches = [], tokens = [], pools = [], hours = [], trades = [], through = NOW, deploymentId = CONFIG.deploymentId } = {}) {
  const tables = {
    InfinityLaunches: [launches, 'cursor'], InfinityTokens: [tokens, 'id'], InfinityPools: [pools, 'id'],
    InfinityCandles: [hours, 'id'], InfinityTrades: [trades, 'cursor'],
  };
  const compare = (a, b) => (/^\d+$/.test(String(a)) && /^\d+$/.test(String(b)) ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const holds = (row, where) => Object.entries(where ?? {}).every(([field, test]) => {
    if (field === '_and') return test.every((w) => holds(row, w));
    if (field === '_or') return test.some((w) => holds(row, w));
    return Object.entries(test).every(([op, value]) => {
      const cell = row[field];
      if (op === '_ilike') return String(cell).toLowerCase().includes(value.slice(1, -1).toLowerCase());
      if (op === '_eq') return String(cell) === String(value);
      if (op === '_in') return value.map(String).includes(String(cell));
      if (op === '_gt') return cell != null && compare(cell, value) > 0;
      if (op === '_gte') return cell != null && compare(cell, value) >= 0;
      throw new Error(`fake index: no ${op}`);
    });
  });
  return (url, init) => {
    const { operationName, variables } = JSON.parse(init.body);
    const [rows, order] = tables[operationName];
    if (variables.deploymentId !== deploymentId) return json({ data: { InfinityDeployment: [] } });
    const page = rows
      .filter((row) => holds(row, variables.where) && String(row[order]) > String(variables.after))
      .sort((x, y) => (String(x[order]) < String(y[order]) ? -1 : 1))
      .slice(0, Math.min(variables.limit, 100));
    return json({ data: { InfinityDeployment: [{ id: deploymentId, sourceTimestamp: String(through), rows: page }] } });
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch stub: routes by URL, records every call for assertion. */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    for (const route of routes) if (route.match(url, init)) return route.respond(url, init);
    throw new TypeError('fetch failed');
  };
  impl.calls = calls;
  return impl;
}

const indexerRoute = (respond) => ({ match: (url) => url === CONFIG.indexerGraphqlHttp, respond });
const engineRoute = (respond) => ({ match: (url) => url.startsWith(CONFIG.engineOrigin), respond });

async function connect(fetchImpl, config = CONFIG) {
  const server = createComfyMcpServer(config, fetchImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'behaviour-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
    },
    async close() { await client.close(); await server.close(); },
  };
}

test('lists exactly the fourteen read tools, all annotated read-only', async () => {
  const rig = await connect(stubFetch([]));
  try {
    const { tools } = await rig.client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'comfy_agent_compute', 'comfy_bazaar', 'comfy_build_launch_tx', 'comfy_build_swap_tx', 'comfy_compute_funded',
        'comfy_creator_fees', 'comfy_jobs', 'comfy_search_tokens', 'comfy_swap_quote',
        'comfy_task', 'comfy_tasks', 'comfy_token', 'comfy_tokens', 'comfy_trades',
      ],
    );
    for (const tool of tools) {
      /* warmth left every user surface (2026-09-24); an agent reading this server
         learns nothing of it */
      assert.doesNotMatch(JSON.stringify(tool), /warmth|°/i, `${tool.name} still names warmth`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must declare readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must declare non-destructive`);
    }
  } finally { await rig.close(); }
});

/* --- the market tools, over the Infinity index ---------------------------- */

test('comfy_tokens lists the newest launches first, with Infinity market fields in 0G', async () => {
  const index = fakeIndex({
    launches: [launchRow(TOKEN_A, NOW - 7200), launchRow(TOKEN_B, NOW - 600)],
    tokens: [tokenRow(TOKEN_A, { name: 'Agent A', symbol: 'AAA' }), tokenRow(TOKEN_B, { name: 'Agent B', symbol: 'BBB', holderCount: 0 })],
    pools: [poolRow(TOKEN_A), untradedPool(TOKEN_B)],
    /* the hour before the window closed at 0.00001, and a trade inside it moved the price */
    hours: [
      hourRow(TOKEN_A, Math.floor((NOW - 90_000) / HOUR) * HOUR),
      hourRow(TOKEN_A, Math.floor((NOW - 100) / HOUR) * HOUR, { volumeQuote: OG(3), trades: 2, closeX18: OG(0.00002) }),
    ],
  });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { isError, body } = await rig.call('comfy_tokens', { limit: 5 });
    assert.equal(isError, false);
    assert.equal(body.live, true);
    assert.equal(body.source, 'indexer');
    assert.equal(body.hidden, 0);
    assert.deepEqual(body.data.map((t) => t.symbol), ['BBB', 'AAA'], 'newest launch first');
    const [b, a] = body.data;
    assert.equal(a.token, TOKEN_A);
    assert.equal(a.name, 'Agent A');
    assert.equal(a.pool, POOL_KEY(TOKEN_A));
    assert.equal(a.creator, WALLET);
    assert.equal(a.launched_at, NOW - 7200);
    assert.equal(a.price_og, 0.00002);
    assert.equal(a.chg_24h, 100);
    assert.equal(a.vol_24h, 3);
    assert.equal(a.fdv_og, 20_000);
    assert.equal(a.mcap_og, 500);
    assert.equal(a.liquidity_og, 300, 'the 0G in the pool, not liquidityQuote (unsold supply at price)');
    assert.equal(a.affiliated, false);
    assert.equal(a.traders, 2);
    assert.equal(a.holder_count, 3);
    assert.equal(a.total_supply, 1_000_000_000);
    /* never traded: the opening price and FDV the index carries are not measured market figures */
    for (const field of ['price_og', 'chg_24h', 'vol_24h', 'fdv_og', 'mcap_og', 'last_trade_ts']) {
      assert.equal(b[field], null, `untraded ${field} must be null, not a number`);
    }
    assert.equal(b.traders, 0);
    assert.equal(b.liquidity_og, 0, 'a fresh launch holds no 0G, whatever its FDV');
  } finally { await rig.close(); }
});

test('every read is scoped to the configured deployment, through the public base reads only', async () => {
  const fetchImpl = stubFetch([indexerRoute(fakeIndex({
    launches: [launchRow(TOKEN_A, NOW - 60)], tokens: [tokenRow(TOKEN_A)], pools: [poolRow(TOKEN_A)],
  }))]);
  const rig = await connect(fetchImpl);
  try {
    await rig.call('comfy_tokens', { limit: 3 });
    await rig.call('comfy_token', { token: TOKEN_A });
    await rig.call('comfy_trades', { token: TOKEN_A });
    const names = new Set(fetchImpl.calls.map((c) => c.body.operationName));
    assert.deepEqual([...names].sort(), ['InfinityCandles', 'InfinityLaunches', 'InfinityPools', 'InfinityTokens', 'InfinityTrades']);
    for (const call of fetchImpl.calls) assert.equal(call.body.variables.deploymentId, CONFIG.deploymentId);
  } finally { await rig.close(); }
});

test('the newest launches come from a widening window, and past a full page', async () => {
  /* 130 launches a week old and none this week: the 1-day window is empty, the 7-day
     one holds all of them over two pages, and the newest is the last of the second */
  const old = Array.from({ length: 130 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
  const index = fakeIndex({
    launches: old.map((token, i) => launchRow(token, NOW - 6 * 86_400 + i)),
    tokens: old.map((token, i) => tokenRow(token, { symbol: `T${i + 1}` })),
    pools: old.map((token) => untradedPool(token)),
  });
  const fetchImpl = stubFetch([indexerRoute(index)]);
  const rig = await connect(fetchImpl);
  try {
    const { body } = await rig.call('comfy_tokens', { limit: 3 });
    assert.deepEqual(body.data.map((t) => t.symbol), ['T130', 'T129', 'T128']);
    const launchReads = fetchImpl.calls.filter((c) => c.body.operationName === 'InfinityLaunches');
    assert.ok(launchReads.length >= 3, 'the empty day, then two pages of the week');
    assert.ok(launchReads.some((c) => c.body.variables.after !== ''), 'the second page follows the cursor');
  } finally { await rig.close(); }
});

test('a read cut off by the page budget is never served as the newest', async () => {
  /* 1,200 trades in the last hour: the 5-minute window holds 30 and is whole; the hour
     runs past ten pages, so its tail is not the newest. The whole window's 30 are served. */
  const trades = Array.from({ length: 1200 }, (_, i) => tradeRow(TOKEN_A, NOW - 3000 + i * 2.4 | 0, {
    id: `t${String(i).padStart(5, '0')}`, cursor: String(NOW - 3000 + i).padStart(24, '0'),
  }));
  const recent = Array.from({ length: 30 }, (_, i) => tradeRow(TOKEN_A, NOW - 290 + i, {
    id: `r${String(i).padStart(3, '0')}`, cursor: String(NOW - 290 + i).padStart(24, '0') + 'z',
  }));
  const index = fakeIndex({ tokens: [tokenRow(TOKEN_A)], pools: [poolRow(TOKEN_A)], trades: [...trades.filter((t) => Number(t.timestamp) <= NOW - 300), ...recent] });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { isError, body } = await rig.call('comfy_trades', { token: TOKEN_A, limit: 100 });
    assert.equal(isError, false);
    assert.equal(body.data.length, 30, 'the whole window, not a cut-off prefix of the wider one');
    assert.equal(body.data[0].ts, NOW - 261);
  } finally { await rig.close(); }
});

test('hourly buckets cut off by the page budget make the 24h figures unknown, not low', async () => {
  const hours = Array.from({ length: 1100 }, (_, i) => hourRow(TOKEN_A, NOW - 3600 - i, { id: `h${String(i).padStart(5, '0')}`, volumeQuote: OG(1), trades: 1 }));
  const index = fakeIndex({ tokens: [tokenRow(TOKEN_A)], pools: [poolRow(TOKEN_A)], hours });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { body } = await rig.call('comfy_token', { token: TOKEN_A });
    assert.equal(body.data.vol_24h, null);
    assert.equal(body.data.chg_24h, null);
    assert.equal(body.data.price_og, 0.00002, 'the pool\'s own figures still read');
  } finally { await rig.close(); }
});

test('the affiliate\'s market (iAI) leads the list, as on the site, though it has no launch row', async () => {
  const IAI = '0x' + '1a'.repeat(20);
  const iaiPool = poolRow(IAI, {
    id: `${CONFIG.deploymentId}:0x${'1a'.repeat(32)}`, kind: 'IAI_OPENING_FEE', openingBps: 9000,
    tokenIsCurrency0: false, currency0: '0x' + '00'.repeat(20), currency1: IAI, launchTimestamp: String(NOW - 86_400 * 20),
  });
  const index = fakeIndex({
    launches: [launchRow(TOKEN_A, NOW - 60)],
    /* its token row has no launch pool of its own */
    tokens: [tokenRow(TOKEN_A, { symbol: 'AAA' }), tokenRow(IAI, { symbol: 'IAI', launchedPoolKey: null })],
    pools: [poolRow(TOKEN_A), iaiPool],
    trades: [tradeRow(IAI, NOW - 30, { poolKey: iaiPool.id })],
  });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { body } = await rig.call('comfy_tokens', { limit: 5 });
    assert.deepEqual(body.data.map((t) => [t.symbol, t.affiliated]), [['IAI', true], ['AAA', false]]);
    assert.equal(body.data[0].pool, iaiPool.id);
    assert.equal(body.hidden, 0, 'its reserved ticker and opening fee are the admitted pool\'s own');

    const detail = await rig.call('comfy_token', { token: IAI });
    assert.equal(detail.body.data.pool, iaiPool.id, 'found through its pool, not a launch');
    assert.equal(detail.body.data.listed, true);
    const trades = await rig.call('comfy_trades', { token: IAI });
    assert.equal(trades.body.data.length, 1);
  } finally { await rig.close(); }
});

test('an iAI token without its first supply snapshot is not a market row yet', async () => {
  const IAI = '0x' + '1a'.repeat(20);
  const index = fakeIndex({
    tokens: [tokenRow(IAI, { symbol: 'IAI', launchedPoolKey: null, totalSupply: null })],
    pools: [poolRow(IAI, { kind: 'IAI_OPENING_FEE', tokenIsCurrency0: false, currency1: IAI })],
  });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { body } = await rig.call('comfy_tokens', { limit: 5 });
    assert.deepEqual(body.data, []);
  } finally { await rig.close(); }
});

test('a count the index did not carry is unknown, not zero', async () => {
  const index = fakeIndex({ tokens: [tokenRow(TOKEN_A, { holderCount: null, launchedPoolKey: null })] });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { body } = await rig.call('comfy_token', { token: TOKEN_A });
    assert.equal(body.data.holder_count, null);
    assert.equal(body.data.traders, null);
    assert.equal(body.data.trade_count, null);
  } finally { await rig.close(); }
});

test('comfy_tokens leaves out what the site leaves out, and says how many', async () => {
  const qa = '0x' + '01'.repeat(20), reserved = '0x' + '02'.repeat(20), opening = '0x' + '03'.repeat(20), iai = '0x' + '04'.repeat(20);
  const index = fakeIndex({
    launches: [launchRow(TOKEN_A, NOW - 50), launchRow(qa, NOW - 40), launchRow(reserved, NOW - 30), launchRow(opening, NOW - 20), launchRow(iai, NOW - 10)],
    tokens: [
      tokenRow(TOKEN_A, { symbol: 'AAA' }),
      tokenRow(qa, { name: 'QA staging launch 20260929', symbol: 'QA1' }),
      /* full-width and a zero-width space: still COMFY to a reader */
      tokenRow(reserved, { symbol: 'ＣＯ​ＭＦＹ' }),
      tokenRow(opening, { symbol: 'SNIPE' }),
      tokenRow(iai, { symbol: 'IAI' }),
    ],
    pools: [poolRow(TOKEN_A), poolRow(qa), poolRow(reserved), poolRow(opening, { openingBps: 9000 }), poolRow(iai, { kind: 'IAI_OPENING_FEE', openingBps: 9000 })],
  });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { body } = await rig.call('comfy_tokens', { limit: 10 });
    /* an opening fee hides nothing: SNIPE is listed beside iAI */
    assert.deepEqual(body.data.map((t) => t.symbol), ['IAI', 'SNIPE', 'AAA'], 'the QA launch and the reserved ticker are not listed');
    assert.equal(body.hidden, 2);
    const detail = await rig.call('comfy_token', { token: opening });
    assert.equal(detail.body.data.symbol, 'SNIPE');
    assert.equal(detail.body.data.listed, true);
  } finally { await rig.close(); }
});

test('comfy_token returns an Infinity token in detail and data:null for an unknown address', async () => {
  const index = fakeIndex({ tokens: [tokenRow(TOKEN_A, { name: 'Agent A', symbol: 'AAA', image: 'https://img.test/a.png' })], pools: [poolRow(TOKEN_A)] });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const known = await rig.call('comfy_token', { token: TOKEN_A.toUpperCase().replace('0X', '0x') });
    assert.equal(known.isError, false);
    const d = known.body.data;
    assert.equal(d.token, TOKEN_A);
    assert.equal(d.symbol, 'AAA');
    assert.equal(d.pool, POOL_KEY(TOKEN_A));
    assert.equal(d.creator, WALLET);
    assert.equal(d.image_url, 'https://img.test/a.png');
    assert.equal(d.trade_count, 5);
    assert.equal(d.vol_total_og, 12);
    assert.equal(d.buy_vol_total_og, 10);
    assert.equal(d.sell_vol_total_og, 2);
    assert.equal(d.listed, true);
    assert.equal(d.chg_24h, null, 'no hourly buckets inside the window: no measured change');

    const unknown = await rig.call('comfy_token', { token: TOKEN_B });
    assert.equal(unknown.isError, false);
    assert.deepEqual(unknown.body, { live: true, source: 'indexer', data: null });
  } finally { await rig.close(); }
});

test('a token from the retired index is unknown to the Infinity index: data:null, never a legacy row', async () => {
  /* The retired Envio index is not read at all (a deliberate choice): production
     is 0G mainnet, and its every token is an Infinity launch. */
  const fetchImpl = stubFetch([indexerRoute(fakeIndex({ tokens: [tokenRow(TOKEN_A)] }))]);
  const rig = await connect(fetchImpl);
  try {
    const { body } = await rig.call('comfy_token', { token: TOKEN_B });
    assert.equal(body.data, null);
    for (const call of fetchImpl.calls) assert.match(call.body.operationName, /^Infinity/);
  } finally { await rig.close(); }
});

test('a deployment key the index does not know is said, not answered as an empty market', async () => {
  const rig = await connect(stubFetch([indexerRoute(fakeIndex({ deploymentId: 'someone-else' }))]));
  try {
    for (const [tool, args] of [['comfy_tokens', { limit: 3 }], ['comfy_token', { token: TOKEN_A }], ['comfy_trades', { token: TOKEN_A }]]) {
      const { isError, body } = await rig.call(tool, args);
      assert.equal(isError, true, tool);
      assert.equal(body.live, false, tool);
      assert.equal(body.outcome, 'deployment_unknown', tool);
    }
  } finally { await rig.close(); }
});

test('comfy_jobs relays the engine 403 wallet_mismatch as its own outcome, not as sign-in advice', async () => {
  const fetchImpl = stubFetch([engineRoute(() => json({ error: 'wallet_mismatch' }, 403))]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_jobs', { address: WALLET });
    assert.equal(isError, true);
    assert.equal(body.live, false);
    assert.equal(body.outcome, 'wallet_mismatch');
    assert.equal(body.status, 403);
  } finally { await rig.close(); }
});

test('comfy_trades reads one pool newest first and keeps an unstated side null', async () => {
  const index = fakeIndex({
    tokens: [tokenRow(TOKEN_A)],
    pools: [poolRow(TOKEN_A)],
    trades: [
      tradeRow(TOKEN_A, NOW - 300, { isBuy: false }),
      tradeRow(TOKEN_A, NOW - 200),
      tradeRow(TOKEN_A, NOW - 100, { isBuy: null }),
      /* another pool's trade never reaches this tape */
      tradeRow(TOKEN_B, NOW - 50),
    ],
  });
  const rig = await connect(stubFetch([indexerRoute(index)]));
  try {
    const { isError, body } = await rig.call('comfy_trades', { token: TOKEN_A, limit: 10 });
    assert.equal(isError, false);
    assert.deepEqual(body.data.map((t) => t.ts), [NOW - 100, NOW - 200, NOW - 300]);
    assert.deepEqual(body.data.map((t) => t.side), [null, 'buy', 'sell']);
    const [, buy] = body.data;
    assert.equal(buy.trader, WALLET);
    assert.equal(buy.token_amount, 1000);
    assert.equal(buy.volume_og, 0.02);
    assert.equal(buy.price_og, 0.00002);
    assert.equal(buy.spot_price_og, 0.000021);
    assert.equal(buy.tx, `0x${String(NOW - 200).padStart(64, '0')}`);

    const limited = await rig.call('comfy_trades', { token: TOKEN_A, limit: 2 });
    assert.deepEqual(limited.body.data.map((t) => t.ts), [NOW - 100, NOW - 200]);

    const unknown = await rig.call('comfy_trades', { token: TOKEN_B });
    assert.equal(unknown.body.data, null, 'a token the index does not know has no tape, not an empty one');
  } finally { await rig.close(); }
});

test('the 24h window is the web board\'s: hours overlapping the last day, from the close before it', () => {
  const through = 1_000_000;
  const hour = (start, close, volume, trades = 1) => ({ bucketStart: BigInt(start), openX18: 10n, closeX18: BigInt(close), volumeQuote: BigInt(volume), trades });
  /* before the window closed at 10; inside, 5 and 7 of volume */
  const hours = [hour(through - 90_000, 10, 99), hour(through - 3600, 12, 5), hour(through - 1800, 15, 7)];
  const day = dayWindow(hours, 20n, through);
  assert.equal(day.volumeQuote, 12n, 'only the hours inside the window count');
  assert.equal(day.change, 100);
  assert.equal(dayWindow([hour(through - 3600, 12, 5, 0)], 20n, through).change, null, 'no trade in the window: no change');
  assert.equal(dayWindow([hour(through - 3600, 12, 5)], 20n, through).change, 100, 'no earlier hour: from the first open');
});

test('a ticker is shown as a reader sees it: hidden characters gone', () => {
  assert.equal(visibleTicker('R1​9'), 'R19');
  assert.equal(visibleTicker('‮91R'), '91R');
  assert.equal(visibleTicker('​'), null);
  assert.equal(hiddenReason({ address: TOKEN_A, symbol: '$comfy' }, undefined), 'reserved_ticker');
  assert.equal(hiddenReason({ address: TOKEN_A, symbol: 'AAA' }, { kind: null, openingBps: 9800, floorBps: 1000 }), null);
});

test('comfy_bazaar reads the public listings path and serves its array verbatim', async () => {
  const listings = [{
    id: 'lst_1234', seller: WALLET, token: TOKEN_A, title: 'Ship a canary',
    description: 'Run the bounded proof.', price_og: 2.5, unit: 'job', active: 1,
    created_at: '2026-08-29T08:00:00.000Z',
  }];
  const fetchImpl = stubFetch([engineRoute((url, init) => {
    assert.equal(url, `${CONFIG.engineOrigin}/bazaar/listings`);
    assert.equal(init.headers.authorization, undefined, 'the open floor must stay public');
    return json(listings);
  })]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_bazaar');
    assert.equal(isError, false);
    assert.equal(body.live, true);
    assert.equal(body.source, 'engine');
    assert.deepEqual(body.data, listings);
  } finally { await rig.close(); }
});

const TASK_ID = 'tsk_0123456789ab';

test('comfy_tasks reads the public board with its filters and serves the page verbatim', async () => {
  const page = { tasks: [{ id: TASK_ID, title: 'check a launch note', budget_og: '2', kind: 'second_opinion',
    category: 'research', acceptors: 1 }], cursor: `1790000000000.${TASK_ID}`, now_s: 1790000000 };
  const fetchImpl = stubFetch([engineRoute((url, init) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/bazaar/tasks');
    assert.equal(u.searchParams.get('kind'), 'second_opinion');
    assert.equal(u.searchParams.get('min_budget_og'), '1.5');
    assert.equal(u.searchParams.get('after'), `1790000000000.${TASK_ID}`);
    assert.equal(init.headers.authorization, undefined, 'the board is read in public');
    return json(page);
  })]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_tasks',
      { kind: 'second_opinion', min_budget_og: '1.5', after: `1790000000000.${TASK_ID}` });
    assert.equal(isError, false);
    assert.deepEqual(body, { live: true, source: 'engine', data: page });
    const detail = { task: { id: TASK_ID }, acceptors: [], standing: { tasks_posted: 1 }, award: null, now_s: 1790000000 };
    const one = await connect(stubFetch([engineRoute((url, init) => {
      assert.equal(url, `${CONFIG.engineOrigin}/bazaar/tasks/${TASK_ID}`);
      assert.equal(init.headers.authorization, undefined, 'no session: no award or fund arguments are read here');
      return json(detail);
    })]));
    try {
      assert.deepEqual((await one.call('comfy_task', { id: TASK_ID })).body, { live: true, source: 'engine', data: detail });
    } finally { await one.close(); }
    const gone = await connect(stubFetch([engineRoute(() => json({ error: 'there is no such task on the board',
      code: 'task_not_found' }, 404))]));
    try {
      assert.deepEqual((await gone.call('comfy_task', { id: TASK_ID })).body, { live: true, source: 'engine', data: null });
    } finally { await gone.close(); }
  } finally { await rig.close(); }
});

test('comfy_task refuses an id that is not a task id without calling the engine', async () => {
  const fetchImpl = stubFetch([engineRoute(() => json({}))]);
  const rig = await connect(fetchImpl);
  try {
    for (const id of ['tsk_0123', 'job_0123456789ab', 'tsk_0123456789AB', '../agents/1', `${TASK_ID}?x=1`]) {
      const { isError, body } = await rig.call('comfy_task', { id });
      assert.equal(isError, true, id);
      assert.equal(body.live, false);
      assert.equal(body.outcome, 'invalid_request');
    }
    const odd = await rig.call('comfy_tasks', { after: '../x' });
    assert.equal(odd.body.outcome, 'invalid_request');
    assert.equal(fetchImpl.calls.length, 0);
  } finally { await rig.close(); }
});

test('comfy_tasks relays a closed board as down, never as an empty list', async () => {
  const closed = () => json({ error: 'the task board is not open yet', code: 'task_board_closed' }, 503);
  const rig = await connect(stubFetch([engineRoute(closed)]));
  try {
    for (const [name, args] of [['comfy_tasks', {}], ['comfy_task', { id: TASK_ID }]]) {
      const { isError, body } = await rig.call(name, args);
      assert.equal(isError, true, name);
      assert.deepEqual(body, { live: false, source: 'engine', outcome: 'task_board_closed', status: 503 }, name);
    }
  } finally { await rig.close(); }
  /* a page without its tasks array is a broken upstream, not an empty board */
  const broken = await connect(stubFetch([engineRoute(() => json({ cursor: null }))]));
  try {
    const { isError, body } = await broken.call('comfy_tasks');
    assert.equal(isError, true);
    assert.equal(body.outcome, 'bad_payload');
  } finally { await broken.close(); }
});

test('comfy_jobs forwards COMFY_SESSION and serves the engine jobs array verbatim', async () => {
  const jobs = [{
    id: 'job_1234', listing_id: 'lst_1234', buyer: WALLET, seller: TOKEN_B,
    token: TOKEN_A, price_og: 2.5, state: 'delivered', settle_tx: '0x01',
    note: 'ready', artifact_url: 'https://artifact.test/result.json',
    created_at: '2026-08-29T08:00:00.000Z', updated_at: '2026-08-29T09:00:00.000Z',
    auto_settled: false,
  }];
  const fetchImpl = stubFetch([engineRoute((url, init) => {
    assert.equal(url, `${CONFIG.engineOrigin}/bazaar/jobs/${WALLET}`);
    assert.equal(init.headers.authorization, `Bearer ${CONFIG.session}`);
    return json(jobs);
  })]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_jobs', { address: WALLET.toUpperCase().replace('0X', '0x') });
    assert.equal(isError, false);
    assert.equal(body.live, true);
    assert.equal(body.source, 'engine');
    assert.deepEqual(body.data, jobs);
  } finally { await rig.close(); }
});

test('comfy_jobs passes the engine 401 refusal through verbatim and never retries', async () => {
  const refusal = 'sign_in_required';
  const fetchImpl = stubFetch([engineRoute(() => json({ error: refusal }, 401))]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_jobs', { address: WALLET });
    assert.equal(isError, true);
    assert.deepEqual(body, { live: false, source: 'engine', outcome: refusal, status: 401 });
    assert.equal(fetchImpl.calls.length, 1, 'a refused private read must not retry');
  } finally { await rig.close(); }
});

/* --- the compute loop --------------------------------------------------- */

/* The engine's payload as it serializes it (points-service compute-funded.ts). */
const POOL = (n) => `16661:0x${'a1'.repeat(20)}:0x${String(n).padStart(64, '0')}`;
const COMPUTE_FUNDED = {
  basis: 'Delivered compute: the sum of InfinityComputeDestination.totalDelivered, the cumulative 0G an executor delivered to compute for each pool of the pinned Infinity deployments, read from the indexer (docs/fee-model.md); it is NOT a remaining balance or a measurement of inference purchased.',
  status: 'ready',
  reason: null,
  through: NOW - 5,
  total_og: 12.75,
  agents: 1,
  tokens: 2,
  since: NOW - 86_400,
  since_basis: 'first_tick',
  tier_floors_og: [1, 10, 100],
  rows: [
    { token: TOKEN_A, pool: POOL(1), symbol: 'AAA', name: 'Agent A', compute_og: 12.5, tier: 'x10' },
    { token: null, pool: POOL(9), symbol: null, name: null, compute_og: 0.25, tier: null },
    { token: TOKEN_B, pool: POOL(2), symbol: 'BBB', name: 'Agent B', compute_og: 0, tier: null },
  ],
  hidden_test: 1,
};
const COMPUTE_UNKNOWN = {
  basis: COMPUTE_FUNDED.basis, status: 'unknown', reason: 'stale', through: null,
  total_og: null, agents: null, tokens: null, since: null, since_basis: 'unknown', tier_floors_og: [1, 10, 100],
  rows: [], hidden_test: null,
};

test('comfy_compute_funded serves the engine payload verbatim, basis sentence included', async () => {
  const fetchImpl = stubFetch([engineRoute((url, init) => {
    assert.equal(url, `${CONFIG.engineOrigin}/compute/funded`);
    assert.equal(init.headers.authorization, undefined, 'the compute figure is public');
    return json(COMPUTE_FUNDED);
  })]);
  const rig = await connect(fetchImpl);
  try {
    const { isError, body } = await rig.call('comfy_compute_funded');
    assert.equal(isError, false);
    assert.equal(body.live, true);
    assert.equal(body.source, 'engine');
    assert.deepEqual(body.data, COMPUTE_FUNDED);
    /* the honesty the tool exists to carry: the number arrives WITH its basis */
    assert.match(body.data.basis, /^Delivered compute/);
    assert.match(body.data.basis, /NOT a remaining balance/);
  } finally { await rig.close(); }
});

test('the compute tools describe delivered compute, and no volume estimate', async () => {
  const rig = await connect(stubFetch([]));
  try {
    const { tools } = await rig.client.listTools();
    for (const name of ['comfy_compute_funded', 'comfy_agent_compute']) {
      const { description } = tools.find((tool) => tool.name === name);
      assert.match(description, /delivered/i, name);
      assert.match(description, /compute_unknown/, name);
      assert.doesNotMatch(description, /estimate|0\.001|volume/i, name);
    }
  } finally { await rig.close(); }
});

test('an engine that could not read the index is live:false compute_unknown with its reason, never a figure', async () => {
  for (const [tool, args] of [['comfy_compute_funded', {}], ['comfy_agent_compute', { token: TOKEN_A }]]) {
    const rig = await connect(stubFetch([engineRoute(() => json(COMPUTE_UNKNOWN))]));
    try {
      const { isError, body } = await rig.call(tool, args);
      assert.equal(isError, true, tool);
      assert.deepEqual(body, { live: false, source: 'engine', outcome: 'compute_unknown', data: { reason: 'stale' } }, tool);
    } finally { await rig.close(); }
  }
});

test('comfy_compute_funded treats a payload without total/rows/basis as a broken upstream', async () => {
  for (const payload of [
    { total_og: 1 },
    { basis: 'x', status: 'ready', total_og: 'twelve', agents: 1, rows: [] },
    { basis: 'x', status: 'ready', total_og: 1, agents: 1, rows: [{ token: TOKEN_A, pool: POOL(1) }] },
    { basis: 'x', status: 'ready', total_og: 1, agents: 1, rows: [{ token: TOKEN_A, compute_og: 1 }] },
    /* the retired shape, with no status, is not a delivered figure */
    { basis: 'x', total_og: 1, agents: 1, rows: [] },
    /* an unknown that still carries a number is not an unknown */
    { basis: 'x', status: 'unknown', reason: 'stale', total_og: 3 },
    [],
    null,
  ]) {
    const rig = await connect(stubFetch([engineRoute(() => json(payload))]));
    try {
      const { isError, body } = await rig.call('comfy_compute_funded');
      assert.equal(isError, true, JSON.stringify(payload));
      assert.equal(body.live, false);
      assert.equal(body.outcome, 'bad_payload');
      assert.equal(body.data, undefined, 'a broken payload must not be passed on as data');
    } finally { await rig.close(); }
  }
});

test('comfy_agent_compute reads one token out of the engine rows and says the router is not an engine fact', async () => {
  const fetchImpl = stubFetch([engineRoute(() => json(COMPUTE_FUNDED))]);
  const rig = await connect(fetchImpl);
  try {
    /* address case is normalised for the lookup, and the engine\'s own casing is served back */
    const funded = await rig.call('comfy_agent_compute', { token: TOKEN_A.toUpperCase().replace('0X', '0x') });
    assert.equal(funded.isError, false);
    assert.equal(funded.body.live, true);
    assert.equal(funded.body.source, 'engine');
    assert.deepEqual(funded.body.data, {
      token: TOKEN_A, pool: POOL(1), symbol: 'AAA', name: 'Agent A', compute_og: 12.5, tier: 'x10',
      tier_floors_og: [1, 10, 100], basis: COMPUTE_FUNDED.basis,
      router: null,
      router_reason: funded.body.data.router_reason,
    });
    assert.equal(typeof funded.body.data.router_reason, 'string');
    assert.ok(funded.body.data.router_reason.length > 20, 'a null router needs a stated reason');
    assert.equal(fetchImpl.calls[0].url, `${CONFIG.engineOrigin}/compute/funded`);

    /* known but unfunded: a real zero with no tier, not an absent token — found past
       the funded pool no token names, which no address can match */
    const unfunded = await rig.call('comfy_agent_compute', { token: TOKEN_B });
    assert.equal(unfunded.isError, false);
    assert.equal(unfunded.body.data.compute_og, 0);
    assert.equal(unfunded.body.data.tier, null);
    assert.equal(unfunded.body.data.pool, POOL(2));

    /* unknown token: live read, absent answer — stated, not invented */
    const unknown = await rig.call('comfy_agent_compute', { token: '0x' + '99'.repeat(20) });
    assert.equal(unknown.isError, false);
    assert.equal(unknown.body.live, true);
    assert.equal(unknown.body.data, null);
  } finally { await rig.close(); }
});

test('comfy_agent_compute reports a broken engine payload, never a fabricated zero', async () => {
  const rig = await connect(stubFetch([engineRoute(() => json({ rows: 'nope' }))]));
  try {
    const { isError, body } = await rig.call('comfy_agent_compute', { token: TOKEN_A });
    assert.equal(isError, true);
    assert.equal(body.outcome, 'bad_payload');
    assert.equal(body.data, undefined);
  } finally { await rig.close(); }
});

test('dead engine reports honest errors for the bazaar and compute tools without invented rows', async () => {
  for (const [tool, args] of [
    ['comfy_bazaar', {}],
    ['comfy_jobs', { address: WALLET }],
    ['comfy_compute_funded', {}],
    ['comfy_agent_compute', { token: TOKEN_A }],
  ]) {
    const rig = await connect(stubFetch([]));
    try {
      const { isError, body } = await rig.call(tool, args);
      assert.equal(isError, true, tool);
      assert.equal(body.live, false, tool);
      assert.equal(body.source, 'engine', tool);
      assert.equal(body.outcome, 'unreachable', tool);
      assert.equal(body.data, undefined, `${tool} must not invent rows`);
    } finally { await rig.close(); }
  }
});

test('an engine timeout or 5xx on the compute figure is named, not turned into zero', async () => {
  const cases = [
    { name: 'http 503', route: engineRoute(() => json({ error: 'draining' }, 503)), outcome: 'http_error', status: 503 },
    {
      name: 'timeout',
      route: engineRoute(() => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }),
      outcome: 'timeout',
    },
  ];
  for (const c of cases) {
    for (const [tool, args] of [['comfy_compute_funded', {}], ['comfy_agent_compute', { token: TOKEN_A }]]) {
      const rig = await connect(stubFetch([c.route]));
      try {
        const { isError, body } = await rig.call(tool, args);
        assert.equal(isError, true, `${tool} ${c.name}`);
        assert.equal(body.live, false, `${tool} ${c.name}`);
        assert.equal(body.source, 'engine', `${tool} ${c.name}`);
        assert.equal(body.outcome, c.outcome, `${tool} ${c.name}`);
        if (c.status) assert.equal(body.status, c.status, `${tool} ${c.name}`);
        assert.equal(body.data, undefined, `${tool} ${c.name} must not invent a figure`);
      } finally { await rig.close(); }
    }
  }
});

test('upstream failures come back live:false with a named outcome, never invented data', async () => {
  const cases = [
    { name: 'http 500', route: indexerRoute(() => json({ oops: true }, 500)), outcome: 'http_error', status: 500 },
    { name: 'graphql errors', route: indexerRoute(() => json({ errors: [{ message: 'denied' }] })), outcome: 'graphql_error' },
    {
      name: 'timeout',
      route: indexerRoute(() => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; }),
      outcome: 'timeout',
    },
    { name: 'unreachable', route: { match: () => false, respond: () => {} }, outcome: 'unreachable' },
  ];
  for (const c of cases) {
    const rig = await connect(stubFetch([c.route]));
    try {
      const { isError, body } = await rig.call('comfy_tokens', { limit: 5 });
      assert.equal(isError, true, `${c.name} must be an error result`);
      assert.equal(body.live, false, `${c.name} must not claim live`);
      assert.equal(body.outcome, c.outcome, c.name);
      if (c.status) assert.equal(body.status, c.status, c.name);
      assert.equal(body.data, undefined, `${c.name} must not carry invented data`);
    } finally { await rig.close(); }
  }
});

test('an invalid address is rejected before any upstream request leaves the process', async () => {
  const fetchImpl = stubFetch([]);
  const rig = await connect(fetchImpl);
  try {
    for (const [tool, args] of [
      ['comfy_token', { token: 'porch' }],
      ['comfy_trades', { token: '0x123' }],
      ['comfy_jobs', { address: 'not-an-address' }],
      ['comfy_agent_compute', { token: 'porch' }],
      ['comfy_agent_compute', { token: '0x' + 'zz'.repeat(20) }],
    ]) {
      const { isError, body } = await rig.call(tool, args);
      assert.equal(isError, true, tool);
      assert.equal(body.outcome, 'invalid_request', tool);
    }
    assert.equal(fetchImpl.calls.length, 0, 'no request may carry junk into an upstream URL');
  } finally { await rig.close(); }
});

/* --- allowlist pinning ------------------------------------------------- */

const tokenize = (graphql) => graphql
  .replace(/#[^\n]*/g, ' ')
  .replace(/([(){}\[\]:,!=])/g, ' $1 ')
  .split(/\s+/)
  .filter(Boolean)
  .join(' ');

test('every GraphQL document is an exact entry of the public Infinity read collection', MONOREPO_ONLY, () => {
  const allowlist = tokenize(
    readFileSync(join(HERE, '../../deploy/indexer/hasura/infinity-allowed-operations.graphql'), 'utf8'),
  );
  const metadata = JSON.parse(readFileSync(join(HERE, '../../deploy/indexer/hasura/infinity-metadata.json'), 'utf8'));
  const publicReads = metadata.query_collections.find((c) => c.name === 'infinity-read-v1-public').definition.queries;
  for (const [name, document] of [
    ['InfinityLaunches', INFINITY_LAUNCHES],
    ['InfinityTokens', INFINITY_TOKENS],
    ['InfinityPools', INFINITY_POOLS],
    ['InfinityTrades', INFINITY_TRADES],
    ['InfinityCandles', INFINITY_CANDLES],
  ]) {
    assert.ok(document.startsWith(`query ${name}(`), `${name} is the document's own name`);
    assert.ok(
      allowlist.includes(tokenize(document)),
      `${name} drifted from infinity-allowed-operations.graphql: resync src/queries.ts from the allowlist`,
    );
    const entry = publicReads.find((q) => q.name === name);
    assert.ok(entry, `${name} is not in the public collection: the public indexer would refuse it`);
    assert.equal(tokenize(entry.query), tokenize(document), `${name} differs from the public collection's entry`);
  }
});

test('the default deployment is production\'s one generation, derived from its record', MONOREPO_ONLY, () => {
  const record = JSON.parse(readFileSync(
    join(HERE, '../indexer/infinity/deployments/mainnet-production-generations-20260928.json'), 'utf8',
  ));
  assert.equal(record.chainId, 16661);
  assert.equal(record.generations.length, 1, 'a second generation: the market tools must read it too');
  const { deployment } = record.generations[0];
  const key = `${deployment.chainId}:${deployment.contracts.manager.address}:${deployment.contracts.splitter.address}`;
  assert.equal(DEFAULT_INFINITY_DEPLOYMENT, key.toLowerCase());
});

/* The site's lists leave these out (web lib/test-tokens, reserved-tokens, and the
   launch rules in points-service wire/limits). The MCP ships
   on npm without the web, so it carries copies, and these tests keep the copies equal. */
test('the lists comfy_tokens leaves out are the site\'s own', MONOREPO_ONLY, () => {
  const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
  /* a declaration that moved must fail by name, not as "cannot read '1' of null" */
  const grab = (re, text, what) => { const m = re.exec(text); assert.ok(m, `${what} not found: update this test beside it`); return m[1]; };
  const limits = read('../points-service/src/wire/limits.ts');
  const reserved = grab(/\bRESERVED_TICKERS\b[^=]*=\s*\[([^\]]*)\]/, limits, 'RESERVED_TICKERS');
  assert.deepEqual(RESERVED_TICKERS, [...reserved.matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const tests = read('../web/lib/test-tokens.ts');
  const addresses = grab(/\bTEST_TOKEN_ADDRESSES\b[^=]*=\s*new Set(?:<string>)?\(\[([\s\S]*?)\]\)/, tests, 'TEST_TOKEN_ADDRESSES');
  assert.deepEqual(TEST_TOKEN_ADDRESSES, [...addresses.matchAll(/'(0x[0-9a-f]{40})'/g)].map((m) => m[1]));
  const patterns = grab(/\bNAME_PATTERNS\b[^=]*=\s*\[([\s\S]*?)\];/, tests, 'NAME_PATTERNS');
  assert.deepEqual(TEST_NAME_PATTERNS.map(String), [...patterns.matchAll(/^\s*(\/.+\/[a-z]*),/gm)].map((m) => m[1]));

  const official = grab(/\bOFFICIAL_TOKEN_ADDRESSES\b[^=]*=\s*new Set(?:<string>)?\(\[([\s\S]*?)\]\)/, read('../web/lib/reserved-tokens.ts'), 'OFFICIAL_TOKEN_ADDRESSES');
  assert.deepEqual(OFFICIAL_TOKEN_ADDRESSES, [...official.matchAll(/'(0x[0-9a-f]{40})'/g)].map((m) => m[1]));

  /* and no pool is hidden for its opening fee: the web's filter is gone */
  assert.equal(existsSync(join(HERE, '../web/lib/opening-fee-tokens.ts')), false);
});

/* --- config ------------------------------------------------------------ */

test('config defaults to production and env overrides every base', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.engineOrigin, DEFAULT_ENGINE_ORIGIN);
  assert.equal(defaults.indexerGraphqlHttp, DEFAULT_INDEXER_GRAPHQL_HTTP);
  assert.equal(defaults.deploymentId, DEFAULT_INFINITY_DEPLOYMENT);
  assert.equal(defaults.session, undefined);
  assert.equal(defaults.timeoutMs, 5000);

  const other = `16661:0x${'c3'.repeat(20)}:0x${'d4'.repeat(20)}`;
  const overridden = resolveConfig({
    COMFY_ENGINE_ORIGIN: 'http://localhost:4177/',
    COMFY_INDEXER_GRAPHQL_HTTP: 'http://localhost:18080/v1/graphql/',
    COMFY_INFINITY_DEPLOYMENT: ` ${other.toUpperCase().replace(/0X/g, '0x')} `,
    COMFY_SESSION: ' owner-session ',
    COMFY_MCP_TIMEOUT_MS: '2500',
  });
  assert.equal(overridden.engineOrigin, 'http://localhost:4177');
  assert.equal(overridden.indexerGraphqlHttp, 'http://localhost:18080/v1/graphql');
  assert.equal(overridden.deploymentId, other);
  assert.equal(overridden.session, 'owner-session');
  assert.equal(overridden.timeoutMs, 2500);

  /* an unusable timeout or deployment key falls back to the default, never to nothing */
  assert.equal(resolveConfig({ COMFY_MCP_TIMEOUT_MS: 'never' }).timeoutMs, 5000);
  assert.equal(resolveConfig({ COMFY_INFINITY_DEPLOYMENT: 'galileo' }).deploymentId, DEFAULT_INFINITY_DEPLOYMENT);
  /* ...and says so at startup, so nobody reads mainnet believing they read another deployment */
  assert.equal(ignoredDeployment({ COMFY_INFINITY_DEPLOYMENT: 'galileo' }), 'galileo');
  assert.equal(ignoredDeployment({ COMFY_INFINITY_DEPLOYMENT: other }), null);
  assert.equal(ignoredDeployment({}), null);
});

test('search uses the allowlisted token filter, matches case-insensitively and reports its bound', async () => {
  const { searchTokens } = await import('./src/market.ts');
  const fetchImpl = stubFetch([indexerRoute(fakeIndex({
    tokens: [tokenRow(TOKEN_A, { name: 'Agent A', symbol: 'AAA' }), tokenRow(TOKEN_B, { name: 'QA hidden', symbol: 'AAA' })],
    pools: [poolRow(TOKEN_A), poolRow(TOKEN_B)],
  }))]);
  const result = await searchTokens(CONFIG, 'aaa', 10, fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.tokens.map(t => t.token), [TOKEN_A]);
  assert.equal(result.value.hidden, 1);
  assert.equal(result.value.complete, true);
  const query = fetchImpl.calls.find(c => c.body?.operationName === 'InfinityTokens');
  assert.equal(query.body.query, INFINITY_TOKENS);
  assert.deepEqual(query.body.variables.where._or, [
    { name: { _ilike: '%aaa%' } }, { symbol: { _ilike: '%aaa%' } }, { address: { _ilike: '%aaa%' } },
  ]);
});

test('search ranks all scanned rows before limiting, with liquidity descending and nulls last within each match tier', async () => {
  const { searchTokens } = await import('./src/market.ts');
  const entries = [
    ...Array.from({ length: 100 }, () => ({ symbol: 'OTHER', name: 'Contains needle', liquidity: OG(1000) })),
    { symbol: 'OTHER', name: 'Needle name', liquidity: OG(500) },
    { symbol: 'NeedlePrefix', name: 'Other', liquidity: OG(400) },
    { symbol: 'OTHER', name: 'NEEDLE', liquidity: OG(300) },
    { symbol: 'NEEDLE', name: 'Other', liquidity: null },
    { symbol: 'needle', name: 'Other', liquidity: '0' },
    { symbol: 'Needle', name: 'Other', liquidity: OG(2) },
    // Raw units differ even when the public JS-number projection rounds them equal.
    { symbol: 'nEeDlE', name: 'Other', liquidity: String(BigInt(OG(2)) + 1n) },
  ].map((entry, i) => ({ ...entry, address: `0x${i.toString(16).padStart(8, '0')}${'0'.repeat(32)}` }));
  const fetchImpl = stubFetch([indexerRoute(fakeIndex({
    tokens: entries.map(e => tokenRow(e.address, { symbol: e.symbol, name: e.name })),
    pools: entries.map(e => poolRow(e.address, { quoteInPool: e.liquidity })),
  }))]);
  const ranked = await searchTokens(CONFIG, '  nEeDlE  ', 8, fetchImpl);
  assert.equal(ranked.ok, true);
  assert.deepEqual(ranked.value.tokens.map(t => t.token), [106, 105, 104, 103, 102, 101, 100, 0].map(i => entries[i].address));
  assert.equal(ranked.value.scanned, 107);
  assert.equal(ranked.value.matched, 107);
  assert.equal(ranked.value.complete, true);
  assert.equal(ranked.value.truncated, true);
  assert.match(ranked.value.basis, /ranked before limit/i);
  const limited = await searchTokens(CONFIG, 'needle', 1, fetchImpl);
  assert.deepEqual(limited.value.tokens.map(t => t.token), [entries[106].address]);

  const addressMatch = entries[106].address;
  const addressIndex = fakeIndex({
    tokens: [tokenRow(TOKEN_A, { symbol: addressMatch }), tokenRow(addressMatch, { symbol: 'ADDR' })],
    pools: [poolRow(TOKEN_A), poolRow(addressMatch, { quoteInPool: null })],
  });
  const exact = await searchTokens(CONFIG, addressMatch.toUpperCase(), 1, addressIndex);
  assert.deepEqual(exact.value.tokens.map(t => t.token), [addressMatch]);
});

test('iAI exact ticker outranks AINU and CMFY substring matches even with limit one', async () => {
  const iai = '0x' + 'cc'.repeat(20);
  const rig = await connect(stubFetch([indexerRoute(fakeIndex({
    tokens: [tokenRow(TOKEN_A, { symbol: 'AINU', name: 'iAI Inu' }),
      tokenRow(TOKEN_B, { symbol: 'CMFY', name: 'Comfy iAI' }),
      tokenRow(iai, { symbol: 'iAI', name: 'Affiliated' })],
    pools: [poolRow(TOKEN_A), poolRow(TOKEN_B),
      poolRow(iai, { kind: 'IAI_OPENING_FEE', currency1: iai, tokenIsCurrency0: false, quoteInPool: '0' })],
  }))]));
  try {
    const { isError, body } = await rig.call('comfy_search_tokens', { query: 'iAI', limit: 1 });
    assert.equal(isError, false);
    assert.deepEqual(body.data.tokens.map(t => t.symbol), ['iAI']);
    assert.equal(body.data.matched, 3);
    assert.equal(body.data.truncated, true);
  } finally { await rig.close(); }
});

test('search escapes wildcard input and never changes an indexer failure into no matches', async () => {
  const { searchTokens } = await import('./src/market.ts');
  let seen;
  const fetchImpl = async (_url, init) => { seen = JSON.parse(init.body); return json({ errors: [{ message: 'down' }] }); };
  const result = await searchTokens(CONFIG, '%_', 10, fetchImpl);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'graphql_error');
  assert.equal(seen.variables.where._or[0].name._ilike, '%\\%\\_%');
});

test('new tools report the failed source over MCP and never issue a transaction send', async () => {
  const calls = [];
  const config = resolveConfig({ COMFY_RPC_URL: 'https://rpc.test' });
  const rpcDown = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (url === config.rpcUrl) throw new TypeError('offline');
    const rows = body.operationName === 'InfinityTokens' ? [{ address: TOKEN_A, decimals: 18, launchedPoolKey: 'pool' }]
      : body.operationName === 'InfinityPools' ? [{ id: 'pool', poolId: '0x' + '12'.repeat(32) }] : [];
    return json({ data: { InfinityDeployment: [{ id: config.deploymentId, rows }] } });
  };
  const rig = await connect(rpcDown, config);
  try {
    for (const [name, args] of [
      ['comfy_swap_quote', { token: TOKEN_A, side: 'buy', amount: '1' }],
      ['comfy_build_swap_tx', { token: TOKEN_A, side: 'sell', amount: '1', slippage_bps: 100, recipient: WALLET }],
      ['comfy_creator_fees', { token: TOKEN_A }],
      ['comfy_build_launch_tx', { creator: WALLET, name: 'Example', symbol: 'EX', salt: '0x'+'12'.repeat(32), opening_tick: 0,
        terms: { creator_tax_bps: 0, delay_seconds: 30, opening_bps: 0, floor_bps: 0, decay_seconds: 0 } }],
    ]) {
      const result = await rig.call(name, args);
      assert.equal(result.isError, true, name);
      assert.deepEqual(result.body, { live: false, source: 'rpc', outcome: 'unreachable' });
    }
    const invalid = await rig.call('comfy_creator_fees', {});
    assert.equal(invalid.body.outcome, 'invalid_request');
  } finally { await rig.close(); }
  const indexRig = await connect(async () => { throw new TypeError('offline'); }, config);
  try {
    const result = await indexRig.call('comfy_search_tokens', { query: 'example' });
    assert.deepEqual(result.body, { live: false, source: 'indexer', outcome: 'unreachable' });
  } finally { await indexRig.close(); }
  assert.ok(calls.every(call => !['eth_sendTransaction', 'eth_sendRawTransaction'].includes(call.method)));
});

test('consumer-installed chain tools pin the same production venue as the web', MONOREPO_ONLY, async () => {
  const { MAINNET } = await import('./src/deployment.ts');
  const manifest = JSON.parse(readFileSync(join(HERE, '../indexer/infinity/deployments/mainnet-production-16661.json')));
  const admission = JSON.parse(readFileSync(join(HERE, '../indexer/infinity/deployments/mainnet-production-launch-admission.json')));
  const addresses = JSON.parse(readFileSync(join(HERE, '../../deploy/addresses/deployed-addresses.mainnet-production.json')));
  assert.equal(MAINNET.manager, manifest.contracts.manager.address);
  assert.equal(MAINNET.vault, manifest.contracts.vault.address);
  assert.equal(MAINNET.w0g, addresses.w0g);
  assert.equal(MAINNET.splitter, manifest.contracts.splitter.address);
  assert.equal(MAINNET.hook, manifest.hooks[0].address);
  assert.equal(MAINNET.router, manifest.iaiPoolFamily.routing.comfyRouter);
  assert.equal(MAINNET.quoter, manifest.iaiPoolFamily.routing.clQuoter);
  assert.equal(MAINNET.permit2, manifest.iaiPoolFamily.routing.permit2);
  assert.equal(MAINNET.iaiHook, manifest.iaiPoolFamily.hook.address);
  assert.equal(MAINNET.iaiToken, manifest.iaiPoolFamily.iai.IAI);
  assert.equal(MAINNET.launcher, admission.launcher);
  assert.equal(MAINNET.sourceCommit, manifest.sourceCommit);
  assert.equal(resolveConfig({}).rpcUrl, 'https://evmrpc.0g.ai');
  assert.equal(resolveConfig({ COMFY_RPC_URL: 'https://rpc.test/' }).rpcUrl, 'https://rpc.test');
});

test('creator fee discovery excludes admitted iAI LP pools and reports the exclusion', async () => {
  const { feeTokens } = await import('./src/market.ts');
  const index = fakeIndex({tokens:[tokenRow(TOKEN_A,{origin:'ADMITTED_POOL'})],pools:[poolRow(TOKEN_A,{kind:'IAI_OPENING_FEE',poolId:'0x'+'11'.repeat(32)})]});
  const result = await feeTokens(CONFIG,undefined,index);
  assert.equal(result.ok,true);
  assert.deepEqual(result.value.rows,[]);
  assert.equal(result.value.excluded,1);
});

test('engine and indexer overrides must be HTTPS or loopback, like the RPC override', () => {
  assert.throws(() => resolveConfig({ COMFY_ENGINE_ORIGIN: 'http://engine.example' }), /COMFY_ENGINE_ORIGIN must use HTTPS/);
  assert.throws(() => resolveConfig({ COMFY_INDEXER_GRAPHQL_HTTP: 'http://indexer.example/v1/graphql' }), /COMFY_INDEXER_GRAPHQL_HTTP must use HTTPS/);
  assert.equal(resolveConfig({ COMFY_ENGINE_ORIGIN: 'https://engine.example/' }).engineOrigin, 'https://engine.example');
});
