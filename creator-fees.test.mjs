import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCreatorFees } from './src/creator-fees.ts';
import { ReadError } from './src/rpc.ts';

const TOKEN = `0x${'ab'.repeat(20)}`;
const CREATOR = `0x${'c1'.repeat(20)}`;
const RECIPIENT = `0x${'d2'.repeat(20)}`;
const SPLITTER = '0x500acfbb2199d35ab1aa87736665d76c56bf633e';
const POOL = `0x${'11'.repeat(32)}`;
const CREATOR_IDENTITY = `0x${'21'.repeat(32)}`;
const RECIPIENT_IDENTITY = `0x${'22'.repeat(32)}`;
const CREATOR_LEG = `0x${'31'.repeat(32)}`;
const RECIPIENT_LEG = `0x${'32'.repeat(32)}`;
const NATIVE = `0x${'00'.repeat(20)}`;
const SELECTOR = {
  splitOf: '0x175d69cf', legsOf: '0x05fb1c3e', legIdOf: '0x3860622a',
  bindingOf: '0x17530ef1', claimable: '0x4499f5b3', credits: '0x65b6f91f',
  pendingOf: '0x018c21cb', remainder: '0xd61ca2f7',
};

const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const raw = (...values) => `0x${values.map((value) => typeof value === 'string' && value.startsWith('0x')
  ? value.slice(2).padStart(64, '0') : word(value)).join('')}`;
const address = (value) => `0x${value.slice(-40)}`.toLowerCase();

const CONFIG = {
  engineOrigin: 'https://engine.test',
  indexerGraphqlHttp: 'https://indexer.test/v1/graphql',
  rpcUrl: 'https://rpc.test',
  deploymentId: `16661:0xaabd31f24914b48daea998e69683225e289d08b0:${SPLITTER}`,
  timeoutMs: 1_000,
};

function fixtureFetch({ malformed = false, delayRpc = false, unconfigured = false,
  split = [3000, 7000, 2000], shares = [6000, 4000], pendingNative = [1000, 100], remainderNative = 10,
} = {}) {
  const calls = [];
  let activeRpc = 0;
  let maxActiveRpc = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url === CONFIG.indexerGraphqlHttp) {
      const rows = body.operationName === 'InfinityTokens'
        ? [{ id: `${CONFIG.deploymentId}:${TOKEN}`, address: TOKEN, decimals: 6, launchedPoolKey: `${CONFIG.deploymentId}:${POOL}` }]
        : body.operationName === 'InfinityPools'
          ? [{ id: `${CONFIG.deploymentId}:${POOL}`, poolId: POOL, currency0: NATIVE, currency1: TOKEN }]
          : [];
      return Response.json({ data: { InfinityDeployment: [{ id: CONFIG.deploymentId, sourceTimestamp: '123', rows }] } });
    }
    assert.equal(url, CONFIG.rpcUrl);
    if (body.method === 'eth_call') {
      activeRpc += 1;
      maxActiveRpc = Math.max(maxActiveRpc, activeRpc);
      if (delayRpc) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const answer = (result) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'eth_chainId') return answer('0x4115');
    if (body.method === 'eth_getBlockByNumber') return answer({ number: '0x64', timestamp: '0x7b' });
    assert.equal(body.method, 'eth_call');
    assert.equal(body.params[0].to.toLowerCase(), SPLITTER);
    assert.equal(body.params[1], '0x64', 'every fee read uses the same block');
    const data = body.params[0].data.toLowerCase();
    if (malformed && data.startsWith(SELECTOR.splitOf)) return answer('0x00');
    const done = (result) => { activeRpc -= 1; return answer(result); };
    if (data.startsWith(SELECTOR.splitOf)) return done(unconfigured ? raw(0, 0, 0, 0, 0) : raw(1, ...split, CREATOR_IDENTITY));
    if (data.startsWith(SELECTOR.legsOf)) return done(unconfigured ? raw(32, 0) : raw(32, 2, 0, shares[0], CREATOR_IDENTITY, 0, shares[1], RECIPIENT_IDENTITY));
    if (data.startsWith(SELECTOR.legIdOf)) return done(data.endsWith(RECIPIENT_IDENTITY.slice(2)) ? RECIPIENT_LEG : CREATOR_LEG);
    if (data.startsWith(SELECTOR.bindingOf)) {
      return done(raw(data.includes(RECIPIENT_LEG.slice(2)) ? RECIPIENT : CREATOR, 0, 1, NATIVE, 0));
    }
    const currency = address(data.slice(-64));
    const recipient = data.includes(RECIPIENT_LEG.slice(2));
    if (data.startsWith(SELECTOR.pendingOf)) return done(currency === TOKEN ? raw(200, 50) : raw(...pendingNative));
    if (data.startsWith(SELECTOR.remainder)) return done(raw(currency === TOKEN ? 0 : remainderNative));
    if (data.startsWith(SELECTOR.credits)) {
      if (recipient) return done(currency === TOKEN ? raw(90, 20, 0, 10) : raw(400, 50, 25, 11));
      return done(currency === TOKEN ? raw(500, 50, 10, 12) : raw(1000, 200, 50, 13));
    }
    if (data.startsWith(SELECTOR.claimable)) {
      if (recipient) return done(raw(currency === TOKEN ? 70 : 325));
      return done(raw(currency === TOKEN ? 440 : 750));
    }
    throw new Error(`unexpected calldata ${data}`);
  };
  fetchImpl.calls = calls;
  fetchImpl.maxActiveRpc = () => maxActiveRpc;
  return fetchImpl;
}

test('reads every bound wallet leg and keeps credited claimable separate from projected pending', async () => {
  const fetchImpl = fixtureFetch();
  const result = await readCreatorFees(CONFIG, { token: TOKEN }, fetchImpl);

  assert.equal(result.source, 'rpc');
  assert.equal(result.block_number, '100');
  assert.equal(result.complete, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.pools.length, 1);
  const pool = result.pools[0];
  assert.deepEqual(pool.split, { protocol_bps: 3000, creator_bps: 7000, compute_bps: 2000 });
  assert.deepEqual(pool.pending.native, {
    base_fee: { raw: '1000', formatted: '0.000000000000001' },
    tax: { raw: '100', formatted: '0.0000000000000001' },
    remainder: { raw: '10', formatted: '0.00000000000000001' },
  });
  assert.equal(pool.legs.length, 2);
  assert.equal(pool.legs[0].role, 'creator');
  assert.equal(pool.legs[0].wallet, CREATOR);
  assert.deepEqual(pool.legs[0].native, {
    earned: { raw: '1000', formatted: '0.000000000000001' },
    claimed: { raw: '200', formatted: '0.0000000000000002' },
    reassigned: { raw: '50', formatted: '0.00000000000000005' },
    claimable: { raw: '750', formatted: '0.00000000000000075' },
    pending: { raw: '388', formatted: '0.000000000000000388' },
  });
  assert.deepEqual(pool.legs[0].token, {
    earned: { raw: '500', formatted: '0.0005' },
    claimed: { raw: '50', formatted: '0.00005' },
    reassigned: { raw: '10', formatted: '0.00001' },
    claimable: { raw: '440', formatted: '0.00044' },
    pending: { raw: '91', formatted: '0.000091' },
  });
  assert.equal(pool.legs[1].native.pending.raw, '259');
  assert.equal(pool.legs[1].token.pending.raw, '60');
  assert.ok(fetchImpl.calls.every(({ body }) => !['eth_sendTransaction', 'eth_sendRawTransaction'].includes(body.method)));
});

test('wallet filtering follows bindingOf and reports a bounded token scan', async () => {
  const fetchImpl = fixtureFetch();
  const result = await readCreatorFees(CONFIG, { wallet: RECIPIENT }, fetchImpl);
  assert.equal(result.scanned, 1);
  assert.equal(result.complete, true);
  assert.equal(result.pools[0].legs.length, 1);
  assert.equal(result.pools[0].legs[0].wallet, RECIPIENT);
  assert.equal(result.pools[0].legs[0].role, 'recipient');
  const ledgerCalls = fetchImpl.calls.filter(({ body }) => body.method === 'eth_call'
    && [SELECTOR.credits, SELECTOR.claimable].some((prefix) => body.params[0].data.startsWith(prefix)));
  assert.ok(ledgerCalls.every(({ body }) => body.params[0].data.includes(RECIPIENT_LEG.slice(2))),
    'a wallet-filtered read must not fetch another wallet leg ledger');
});

test('bounds concurrent eth_call fanout independently of the number of fee reads', async () => {
  const fetchImpl = fixtureFetch({ delayRpc: true });
  await readCreatorFees(CONFIG, { token: TOKEN }, fetchImpl);
  assert.ok(fetchImpl.maxActiveRpc() <= 4, `observed ${fetchImpl.maxActiveRpc()} simultaneous eth_call requests`);
});

test('rejects missing or malformed filters before reading either source', async () => {
  const fetchImpl = fixtureFetch();
  await assert.rejects(readCreatorFees(CONFIG, {}, fetchImpl), (error) => error instanceof ReadError && error.outcome === 'invalid_request');
  await assert.rejects(readCreatorFees(CONFIG, { wallet: 'not-an-address' }, fetchImpl), (error) => error instanceof ReadError && error.outcome === 'invalid_request');
  assert.equal(fetchImpl.calls.length, 0);
});

test('malformed contract results fail the RPC read instead of returning zero balances', async () => {
  await assert.rejects(
    readCreatorFees(CONFIG, { token: TOKEN }, fixtureFetch({ malformed: true })),
    (error) => error instanceof ReadError && error.source === 'rpc',
  );
});

test('a canonical empty splitter configuration is reported as unconfigured, not malformed or zero', async () => {
  await assert.rejects(
    readCreatorFees(CONFIG, { token: TOKEN }, fixtureFetch({ unconfigured: true })),
    (error) => error instanceof ReadError && error.outcome === 'fees_not_configured' && error.source === 'rpc',
  );
});

// Distinct indexed pools share the ordinary fee fixture; individual RPC failures
// model one unusable pool without losing other wallet matches.
function walletFixture(count, intercept = async () => null) {
  const base = fixtureFetch();
  const tokens = Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const pools = tokens.map((_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`);
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === CONFIG.indexerGraphqlHttp) {
      const rows = body.operationName === 'InfinityTokens'
        ? tokens.map((token, i) => ({ id: `${CONFIG.deploymentId}:${token}`, address: token, decimals: 6,
          launchedPoolKey: `${CONFIG.deploymentId}:${pools[i]}` }))
        : pools.map((poolId, i) => ({ id: `${CONFIG.deploymentId}:${poolId}`, poolId,
          currency0: NATIVE, currency1: tokens[i] }));
      return Response.json({ data: { InfinityDeployment: [{ id: CONFIG.deploymentId, sourceTimestamp: '123', rows }] } });
    }
    const custom = await intercept(body, init, pools);
    return custom ?? base(url, init);
  };
  return { fetchImpl, tokens, pools };
}

test('wallet scan keeps successful pools and reports each failed pool with a bounded reason', async () => {
  const { fetchImpl, tokens } = walletFixture(4, async (body, _init, pools) => {
    const data = body.params?.[0]?.data;
    if (!data) return null;
    const pool = `0x${data.slice(10, 74)}`;
    const answer = result => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (pool === pools[1]) {
      if (data.startsWith(SELECTOR.splitOf)) return answer(raw(0, 0, 0, 0, 0));
      if (data.startsWith(SELECTOR.legsOf)) return answer(raw(32, 0));
    }
    if (pool === pools[2] && data.startsWith(SELECTOR.splitOf)) return answer('0x00');
    if (pool === pools[3] && data.startsWith(SELECTOR.splitOf)) {
      throw new Error('private RPC diagnostic must not be returned');
    }
    return null;
  });
  const result = await readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 4);
  assert.deepEqual(result.pools.map(pool => pool.token), [tokens[0]]);
  assert.deepEqual(result.failed, [
    { token: tokens[1], reason: 'fees_not_configured' },
    { token: tokens[2], reason: 'bad_payload' },
    { token: tokens[3], reason: 'unreachable' },
  ]);
  assert.match(result.basis, /address/);
  assert.match(result.basis, /not launch time/);
});

test('wallet scan processes multiple pools concurrently with at most eight pool workers', async () => {
  let active = 0;
  let peak = 0;
  const { fetchImpl } = walletFixture(20, async body => {
    if (!body.params?.[0]?.data?.startsWith(SELECTOR.splitOf)) return null;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return null;
  });
  const result = await readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  assert.equal(result.complete, true);
  assert.equal(result.pools.length, 20);
  assert.ok(peak > 1, 'pool reads must overlap');
  assert.ok(peak <= 8, `observed ${peak} concurrent pools`);
});

test('wallet scan deadline returns partial results and cancels reads, including a hung response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked;
  const stuck = new Promise(resolve => { blocked = resolve; });
  let hungSignal;
  let release;
  const { fetchImpl, tokens } = walletFixture(2, async (body, init, pools) => {
    if (body.params?.[0]?.data === SELECTOR.splitOf + pools[1].slice(2)) {
      hungSignal = init.signal;
      blocked();
      return { ok: true, json: () => new Promise(resolve => { release = () => resolve({ jsonrpc: '2.0', id: body.id, result: raw(1, 3000, 7000, 2000, CREATOR_IDENTITY) }); }) };
    }
    return null;
  });
  const pending = readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  await stuck;
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.scan_outcome, 'timeout');
  assert.deepEqual(result.pools.map(pool => pool.token), [tokens[0]]);
  assert.deepEqual(result.failed, [{ token: tokens[1], reason: 'timeout' }]);
  assert.equal(hungSignal.aborted, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.pools.length, 1, 'late completions cannot mutate the returned result');
});

test('wallet scan deadline also bounds stalled index discovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = readCreatorFees(CONFIG, { wallet: CREATOR }, async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.scan_outcome, 'timeout');
  assert.equal(result.block_number, null);
  assert.deepEqual(result.pools, []);
  assert.deepEqual(result.failed, []);
  assert.equal(signal.aborted, true);
});

// Derived from comfy-infinity@6fd0ccb8853cc5834a1b4dafd4257cba36239cad,
// contracts/test/unit/FeeSplitter.t.sol: test_taxBypassesLevelOne L184-L201,
// test_creatorComputeHalf L270-L285, and the no-op case L249-L264.
// Amounts are per-leg pending projections, not already credited balances.
test('pending projections reproduce pinned FeeSplitter contract test vectors', async () => {
  const vectors = [
    { split: [5000, 5000, 0], shares: [7000, 3000], pendingNative: [1000, 1000], remainderNative: 0, want: ['1050', '450'] },
    { split: [5000, 5000, 5000], shares: [7000, 3000], pendingNative: [1000, 0], remainderNative: 0, want: ['175', '75'] },
    { split: [5000, 5000, 10000], shares: [7000, 3000], pendingNative: [1000, 1000], remainderNative: 0, want: ['0', '0'] },
    { split: [5000, 5000, 0], shares: [7000, 3000], pendingNative: [0, 0], remainderNative: 2, want: ['0', '0'] },
    // Waterfall.divide L63-L86: pot 113, protocol 3, compute 13,
    // wallet pot 97 => 84 + 12, with one unit of residue carried forward.
    { split: [333, 9667, 1250], shares: [8750, 1250], pendingNative: [101, 7], remainderNative: 5, want: ['84', '12'] },
  ];
  for (const { want, ...fixture } of vectors) {
    const result = await readCreatorFees(CONFIG, { token: TOKEN }, fixtureFetch(fixture));
    assert.deepEqual(result.pools[0].legs.map(leg => leg.native.pending.raw), want);
  }
});

test('wallet timeout marks active and queued pools, and never starts queued RPC after the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = [];
  const { fetchImpl, tokens } = walletFixture(12, async (body, _init, pools) => {
    const data = body.params?.[0]?.data;
    if (data?.startsWith(SELECTOR.splitOf)) {
      started.push(`0x${data.slice(10, 74)}`);
      if (!data.endsWith(pools[0].slice(2))) return new Promise(() => {});
    }
    return null;
  });
  const pending = readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 12);
  assert.deepEqual(result.pools.map(pool => pool.token), [tokens[0]]);
  assert.deepEqual(result.failed, tokens.slice(1).map(token => ({ token, reason: 'timeout' })));
  assert.equal(started.length, 9, 'one finished pool plus eight occupied workers');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 9, 'queued pools must not start after returning');
});

test('wallet scan bounds live RPC calls when failures leave sibling reads hanging', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = 0;
  let peak = 0;
  const { fetchImpl } = walletFixture(99, async body => {
    const data = body.params?.[0]?.data;
    if (!data) return null;
    active++;
    peak = Math.max(peak, active);
    if (data.startsWith(SELECTOR.splitOf)) {
      active--;
      throw new Error('fast pool failure');
    }
    return new Promise(() => {});
  });
  const pending = readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.complete, false);
  assert.ok(peak <= 8, `live eth_call count reached ${peak}`);
  assert.equal(result.failed.length, 99);
});

test('wallet scan isolates missing and malformed indexed pool rows', async () => {
  const fixture = walletFixture(3);
  const fetchImpl = async (url, init) => {
    const response = await fixture.fetchImpl(url, init);
    if (url !== CONFIG.indexerGraphqlHttp || JSON.parse(init.body).operationName !== 'InfinityPools') return response;
    const body = await response.json();
    body.data.InfinityDeployment[0].rows.pop();
    body.data.InfinityDeployment[0].rows[1].poolId = 'invalid';
    return Response.json(body);
  };
  const result = await readCreatorFees(CONFIG, { wallet: CREATOR }, fetchImpl);
  assert.equal(result.complete, false);
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.pools.map(pool => pool.token), [fixture.tokens[0]]);
  assert.deepEqual(result.failed, fixture.tokens.slice(1).map(token => ({ token, reason: 'bad_payload' })));
});
