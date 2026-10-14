import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { DEFAULT_INFINITY_DEPLOYMENT } from './src/config.ts';

let subject;
try { subject = await import('./src/launch.ts'); } catch { subject = undefined; }

const CONFIG = {
  rpcUrl: 'https://rpc.test', engineOrigin: 'https://engine.test',
  indexerGraphqlHttp: 'https://indexer.test', deploymentId: DEFAULT_INFINITY_DEPLOYMENT,
  timeoutMs: 1_000,
};
const CREATOR = '0x1111111111111111111111111111111111111111';
// SDK parity tests read the Comfy monorepo's launch SDK; they skip in the standalone repo.
const SDK_LAUNCH_URL = new URL('../shared/infinity-sdk/launch/index.ts', import.meta.url);
const SDK_LAUNCH_COMPUTE_URL = new URL('../shared/infinity-sdk/launch/compute.ts', import.meta.url);
const MONOREPO = existsSync(SDK_LAUNCH_URL) && existsSync(SDK_LAUNCH_COMPUTE_URL);
const MONOREPO_ONLY = { skip: !MONOREPO && 'needs the Comfy monorepo launch SDK' };
const SDK_LAUNCH_SOURCE = MONOREPO ? readFileSync(SDK_LAUNCH_URL, 'utf8') : '';
const SDK_LAUNCH_COMPUTE_SOURCE = MONOREPO ? readFileSync(SDK_LAUNCH_COMPUTE_URL, 'utf8') : '';

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing SDK declaration: ${signature}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing SDK function body: ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated SDK function body: ${signature}`);
}

function loadSdkLaunchLadder() {
  const presets = SDK_LAUNCH_SOURCE.match(/export const LADDER_PRESETS = \[[^\]]+\] as const;/)?.[0];
  const minTick = SDK_LAUNCH_SOURCE.match(/const MIN_OPENING_TICK = -?[\d_]+;/)?.[0];
  const maxTick = SDK_LAUNCH_SOURCE.match(/const MAX_OPENING_TICK = -?[\d_]+;/)?.[0];
  const spacing = SDK_LAUNCH_COMPUTE_SOURCE.match(/export const LAUNCH_TICK_SPACING = ([\d_]+);/)?.[1];
  assert.ok(presets && minTick && maxTick && spacing, 'SDK launch ladder declarations are present');
  const selectedSource = [
    `const LAUNCH_TICK_SPACING = ${spacing};`,
    presets.replace('export ', ''),
    'type LadderPreset = (typeof LADDER_PRESETS)[number];',
    minTick,
    maxTick,
    extractFunction(SDK_LAUNCH_SOURCE, 'function openingInRange'),
    extractFunction(SDK_LAUNCH_SOURCE, 'export function launchLadder').replace('export ', ''),
    'module.exports = { LADDER_PRESETS, MIN_OPENING_TICK, MAX_OPENING_TICK, launchLadder };',
  ].join('\n');
  const compiled = ts.transpileModule(selectedSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports });
  return module.exports;
}

const SDK_LADDER = MONOREPO ? loadSdkLaunchLadder() : undefined;
const POLICY = {
  launchConfig: '0x000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000001ef00000000000000000000000000000000000000000000000000000000000023280000000000000000000000000000000000000000000000000000000000000e1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bb80000000000000000000000000000000000000000000000000000000000001b580000000000000000000000000b30cce8d5bfd661924cc62e7090166cd54c96fa000000000000000000000000273bb32bfc82216389b7bb873fa4286ed613fa32048b20eb7e5c35018d1df89737d228963cae2dcd495bda93a2bbe4a8bb099317',
  launchFee: '0x' + '0'.repeat(62) + '7b',
  supply: '0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000',
};
const EXPECTED_DATA = '0xd685f0910000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000032000000000000000000000000000000000000000000000000000000000000003601212121212121212121212121212121212121212121212121212121212121212000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000017ebc00000000000000000000000000000000000000000000000000000000000003a00000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000038400000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000258fcbe1d5cc9ab04109b55d7dcc61104aa59e3d3084ea4530cc7c3efb2dafde42f00000000000000000000000000000000000000000000000000000000000005a00000000000000000000000000000000000000000000000000000000000000680048b20eb7e5c35018d1df89737d228963cae2dcd495bda93a2bbe4a8bb099317000000000000000000000000000000000000000000000000000000006b49d32c000000000000000000000000000000000000000000000000000000000000000a4d4350204c61756e63680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044d43504c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c697066733a2f2f696d6167650000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f697066733a2f2f6d6574616461746100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005746f6f6c7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000013ec00000000000000000000000000000000000000000000000000000000000017ebc00000000000000000000000000000000000000000000000000000000000003e70000000000000000000000000000000000000000000000000000000000010fe00000000000000000000000000000000000000000000000000000000000013ec0000000000000000000000000000000000000000000000000000000000000094e00000000000000000000000000000000000000000000000000000000000058200000000000000000000000000000000000000000000000000000000000010fe0000000000000000000000000000000000000000000000000000000000000101b0000000000000000000000000000000000000000000000000000000000002184000000000000000000000000000000000000000000000000000000000000582000000000000000000000000000000000000000000000000000000000000004c0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf7c00000000000000000000000000000000000000000000000000000000000021840000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001d4cfcbe1d5cc9ab04109b55d7dcc61104aa59e3d3084ea4530cc7c3efb2dafde42f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009c43434343434343434343434343434343434343434343434343434343434343434000000000000000000000000000000000000000000000000000000000000000200000000000000000000000011111111111111111111111111111111111111110000000000000000000000002222222222222222222222222222222222222222';

const INPUT = {
  creator: CREATOR, name: 'MCP Launch', symbol: 'MCPL', image: 'ipfs://image',
  metadata: 'ipfs://metadata', context: 'tools', salt: '0x' + '12'.repeat(32),
  opening_tick: 97980,
  terms: { creator_tax_bps: 100, delay_seconds: 30, opening_bps: 900, floor_bps: 100, decay_seconds: 600 },
  recipients: [{ identity: '0x' + '34'.repeat(32), account_wallet: '0x2222222222222222222222222222222222222222', share_bps: 2500 }],
};

function rpcFixture() {
  const methods = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body); methods.push(request.method);
    let result;
    if (request.method === 'eth_chainId') result = '0x4115';
    else if (request.method === 'eth_getBlockByNumber') result = { number: '0x2b7cd00', timestamp: '0x6b49d200' };
    else if (request.method === 'eth_call') {
      const callSelector = request.params[0].data;
      result = callSelector === '0x5293fc6f' ? POLICY.launchConfig
        : callSelector === '0xcf3cf573' ? POLICY.launchFee
        : callSelector === '0xc50497ae' ? POLICY.supply
        : assert.fail(`unexpected call ${callSelector}`);
      assert.equal(request.params[1], '0x2b7cd00');
    } else assert.fail(`unsafe RPC method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
  };
  return { fetchImpl, methods };
}

test('builds the exact SDK/viem oracle calldata from the live launcher policy', MONOREPO_ONLY, async () => {
  assert.equal(typeof subject?.buildLaunchTransaction, 'function');
  const rpc = rpcFixture();
  const result = await subject.buildLaunchTransaction(CONFIG, INPUT, rpc.fetchImpl);
  assert.deepEqual(result, {
    chainId: 16661,
    to: '0x2f74d603f7b7d8b7bfc78ef04e09905b862be86a',
    data: EXPECTED_DATA,
    value: '123',
    description: 'Launch "MCPL" ("MCP Launch") on 0G mainnet; unsigned and not submitted.',
    approvals_needed: [],
    policy: {
      block_number: '0x2b7cd00', block_timestamp: '1800000000',
      source_commit: '6fd0ccb8853cc5834a1b4dafd4257cba36239cad',
      config_hash: '0x048b20eb7e5c35018d1df89737d228963cae2dcd495bda93a2bbe4a8bb099317',
      launch_fee_wei: '123', supply: '1000000000000000000000000000', deadline: '1800000300',
    },
  });
  assert.deepEqual(rpc.methods, ['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_call', 'eth_call']);
  assert.ok(rpc.methods.every((method) => !['eth_sendTransaction', 'eth_sendRawTransaction'].includes(method)));
});

test('keeps every SDK launch ladder preset and opening-tick boundary in parity', MONOREPO_ONLY, () => {
  const presets = [...SDK_LADDER.LADDER_PRESETS];
  const minTick = SDK_LADDER.MIN_OPENING_TICK;
  const maxTick = SDK_LADDER.MAX_OPENING_TICK;
  assert.deepEqual(subject.LADDER_PRESETS, presets);
  assert.deepEqual([subject.MIN_OPENING_TICK, subject.MAX_OPENING_TICK], [minTick, maxTick]);
  for (const preset of presets) {
    for (const openingTick of [minTick, minTick + 60, 97_980, 103_080, maxTick - 60, maxTick]) {
      assert.deepEqual(
        subject.launchLadder(openingTick, preset),
        JSON.parse(JSON.stringify(SDK_LADDER.launchLadder(openingTick, preset))),
        `${preset} at opening tick ${openingTick}`,
      );
    }
  }
  for (const outside of [minTick - 60, maxTick + 60]) {
    assert.throws(() => subject.launchLadder(outside), (error) => error?.outcome === 'invalid_request');
    assert.throws(() => SDK_LADDER.launchLadder(outside), /invalid_opening_price/);
  }
});

test('keeps the SDK minimum delay, floor ceiling, and nonzero-decay term rules', MONOREPO_ONLY, async () => {
  const minDelay = Number(SDK_LAUNCH_SOURCE.match(/export const MIN_LAUNCH_DELAY_SECONDS = ([\d_]+)/)?.[1]
    ?.replaceAll('_', ''));
  const floorCap = Number(SDK_LAUNCH_SOURCE.match(/Math\.min\(([\d_]+), terms\.openingBps\)/)?.[1]
    ?.replaceAll('_', ''));
  assert.match(
    SDK_LAUNCH_SOURCE,
    /terms\.openingBps !== terms\.floorBps && terms\.decaySeconds === 0/,
  );
  const invalidTerms = [
    { ...INPUT.terms, delay_seconds: minDelay - 1 },
    { ...INPUT.terms, opening_bps: floorCap + 200, floor_bps: floorCap + 1 },
    { ...INPUT.terms, opening_bps: 900, floor_bps: 100, decay_seconds: 0 },
  ];
  for (const terms of invalidTerms) {
    let called = false;
    await assert.rejects(
      subject.buildLaunchTransaction(CONFIG, { ...INPUT, terms }, async () => { called = true; }),
      (error) => error?.outcome === 'invalid_request',
    );
    assert.equal(called, false);
  }
});

test('quotes user-provided token text in the wallet description', async () => {
  const rpc = rpcFixture();
  const result = await subject.buildLaunchTransaction(CONFIG, {
    ...INPUT,
    name: 'Name (looks like context)',
    symbol: 'SYM); approve',
  }, rpc.fetchImpl);
  assert.equal(
    result.description,
    'Launch "SYM); approve" ("Name (looks like context)") on 0G mainnet; unsigned and not submitted.',
  );
});

test('refuses inputs outside the public launch policy before reading RPC', async () => {
  assert.equal(typeof subject?.buildLaunchTransaction, 'function');
  let called = false;
  await assert.rejects(
    subject.buildLaunchTransaction(CONFIG, { ...INPUT, terms: { ...INPUT.terms, delay_seconds: 29 } }, async () => { called = true; }),
    (error) => error?.outcome === 'invalid_request',
  );
  assert.equal(called, false);
});

test('launch rejects every contract-forbidden fee wallet before upstream reads', async () => {
  for (const wallet of [
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000001002',
    '0x2f74d603f7b7d8b7bfc78ef04e09905b862be86a',
    '0x500acfbb2199d35ab1aa87736665d76c56bf633e',
    '0x5809c1ff809cfc6fca8518016cdffa8339ba2a3a',
  ]) {
    for (const input of [
      { ...INPUT, creator: wallet.toUpperCase() },
      { ...INPUT, recipients: [{ ...INPUT.recipients[0], account_wallet: wallet.toUpperCase() }] },
    ]) {
      let calls = 0;
      const rpc = rpcFixture();
      await assert.rejects(() => subject.buildLaunchTransaction(CONFIG, input,
        (...args) => { calls++; return rpc.fetchImpl(...args); }), e => e.outcome === 'invalid_request', wallet);
      assert.equal(calls, 0);
    }
  }
});
