import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from './src/config.ts';

test('RPC override requires HTTPS except for explicit loopback development hosts', () => {
  for (const url of [
    'https://rpc.example',
    'http://localhost:8545',
    'http://127.0.0.1:8545',
    'http://[::1]:8545',
  ]) assert.equal(resolveConfig({ COMFY_RPC_URL: `${url}/` }).rpcUrl, url);

  for (const url of [
    'http://rpc.example',
    'http://127.0.0.2:8545',
    'ftp://localhost/rpc',
    'not a URL',
  ]) assert.throws(() => resolveConfig({ COMFY_RPC_URL: url }), /COMFY_RPC_URL/);
});

test('ABI words reject truncation and Keccak uses Ethereum padding', async () => {
  const { word, words, uint, addressWord, keccak256, selector } = await import('./src/abi.ts');
  assert.equal(keccak256(new Uint8Array()), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(word(1), '0'.repeat(63) + '1');
  assert.throws(() => words('0x', 1));
  assert.throws(() => uint('f'.repeat(64), 128));
  assert.throws(() => addressWord('f'.repeat(64)));
});

test('RPC pins a mainnet head, bounds requests and never permits a write method', async () => {
  const { Rpc } = await import('./src/rpc.ts');
  const calls = [];
  const rpc = new Rpc(resolveConfig({ COMFY_RPC_URL: 'https://rpc.test' }), async (url, init) => {
    const request = JSON.parse(init.body); calls.push(request);
    assert.equal(url, 'https://rpc.test'); assert.ok(init.signal);
    const result = request.method === 'eth_chainId' ? '0x4115'
      : request.method === 'eth_getBlockByNumber' ? { number: '0x123', timestamp: '0x456' } : '0x' + '0'.repeat(64);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  assert.deepEqual(await rpc.head(), { number: '0x123', timestamp: 1110n });
  await rpc.call('0x' + 'aa'.repeat(20), '0x12345678', '0x123');
  await assert.rejects(() => rpc.request('eth_sendTransaction', []), /unsupported_rpc_method/);
  await assert.rejects(() => rpc.request('eth_sendRawTransaction', []), /unsupported_rpc_method/);
  assert.deepEqual(calls.map(c => c.method), ['eth_chainId', 'eth_getBlockByNumber', 'eth_call']);
  assert.equal(calls[2].params[1], '0x123');
});

test('RPC failures remain named and never expose upstream error text', async () => {
  const { Rpc } = await import('./src/rpc.ts');
  for (const [payload, outcome] of [
    [{ error: { code: -32000, message: 'secret upstream text' } }, 'rpc_error'],
    [{ result: null }, 'bad_payload'], [{ result: '0x1' }, 'chain_mismatch'],
  ]) {
    const rpc = new Rpc(resolveConfig({}), async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, ...payload })));
    await assert.rejects(() => rpc.head(), e => e.outcome === outcome && !e.message.includes('secret'));
  }
});

test('Keccak matches independent viem vectors across rate-block boundaries', async () => {
  const { keccak256 } = await import('./src/abi.ts');
  for (const [length, expected] of [
    [135, '0x3d28d08c3dacab77392064a939f3e7f8d03f2e02e2c664ac08a05f63ac652626'],
    [136, '0xb82d89d96e5575d11a9e1f4cabb2a45e60899e69a19a724cd796bdcf13511018'],
    [137, '0xec8008a74e50bc7d6b22c3ad85402bf10e6d4449f3c8618e36c461b8a44eeafb'],
    [272, '0xa657381e5615f539cac71f13c74473a5e77eaa2bd8348422dcac221c8f13da94'],
  ]) assert.equal(keccak256(new Uint8Array(length).fill(0xa3)),expected);
});
