import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveConfig } from './src/config.ts';
import { MAINNET } from './src/deployment.ts';
import { word, selector } from './src/abi.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/swap.json', import.meta.url)));
const CONFIG = resolveConfig({ COMFY_RPC_URL: 'https://rpc.test' });
const TOKEN = fixture.key.currency1;
const RECIPIENT = '0x' + 'dd'.repeat(20);
const packed = (...values) => '0x' + values.map(word).join('');
function upstream(over = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b);
    if (url === CONFIG.indexerGraphqlHttp) {
      const rows = b.operationName === 'InfinityTokens' ? [{address:over.token ?? TOKEN,decimals:18,launchedPoolKey:'pool'}]
        : [{id:'pool', poolId:fixture.poolId, ...over.pool}];
      return new Response(JSON.stringify({data:{InfinityDeployment:[{id:CONFIG.deploymentId,rows}]}}));
    }
    assert.ok(['eth_chainId','eth_getBlockByNumber','eth_call'].includes(b.method), b.method);
    let result;
    if (b.method === 'eth_chainId') result = over.chain ?? '0x4115';
    else if (b.method === 'eth_getBlockByNumber') result = {number:'0x123',timestamp:'0x6553f100'};
    else {
      assert.equal(b.params[1], '0x123');
      const {to,data} = b.params[0], sig=data.slice(0,10);
      if (sig === selector('poolIdToPoolKey(bytes32)')) result = over.keyEncoding ?? fixture.poolEncoding;
      else if (sig === selector('poolManager()')) result=packed(MAINNET.manager);
      else if (sig === selector('permit2()')) result=packed(MAINNET.permit2);
      else if (sig === selector('decimals()')) result=packed(over.decimals ?? 18);
      else if (to===MAINNET.quoter) result=over.quote ?? packed(123456789012345678901n,100000);
      else if (sig===selector('getSlot0(bytes32)')) result=packed(2n**96n,0,0,0);
      else if (sig===selector('launchSnapshot(bytes32)')) result=packed(1,1,1,RECIPIENT,1699999900,1,100,50,30,900,100,1000);
      else if (sig===selector('chargingPaused()')) result=packed(0);
      else if (sig===selector('currentFees(bytes32)')) result=packed(5000,1000);
      else if (sig===selector('splitOf(bytes32)')) result=packed(1,3000,7000,2500,'0x'+'11'.repeat(32));
      else throw new Error('unexpected RPC selector '+sig);
      if (over.failSelector===sig) return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,error:{code:-32000,message:'down'}}));
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,result}));
  };
  return {fetchImpl,calls};
}

test('swap quote uses exact quoter calldata and rounds the slippage bound up', async () => {
  const { readSwapQuote }=await import('./src/swap.ts');
  const stub=upstream();
  const q=await readSwapQuote(CONFIG,{token:TOKEN,side:'buy',amount:'1',slippage_bps:100},stub.fetchImpl);
  assert.equal(q.expected_out,'123.456789012345678901');
  assert.equal(q.min_out,'122.222221122222222112');
  assert.equal(q.fees.hook.base_bps,100);
  assert.equal(q.fees.hook.creator_tax_bps,50);
  assert.equal(q.fees.hook.opening_bps,844);
  assert.equal(q.fees.split.protocol_bps,3000);
  assert.equal(stub.calls.find(c=>c.params?.[0]?.to===MAINNET.quoter).params[0].data,fixture.quoteBuy);
});

test('unsigned buy and sell match web ABI with both sell approval layers',async()=>{
  const { buildSwapTransaction }=await import('./src/swap.ts');
  for(const side of ['buy','sell']) {
    const stub=upstream();
    const tx=await buildSwapTransaction(CONFIG,{token:TOKEN,side,amount:'1',slippage_bps:100,recipient:RECIPIENT},stub.fetchImpl);
    assert.equal(tx.data,fixture[side]); assert.equal(tx.to,MAINNET.router); assert.equal(tx.chainId,16661);
    assert.equal(tx.value,side==='buy'?'1000000000000000000':'0');
    assert.deepEqual(tx.approvals_needed.map(a=>a.data),side==='sell'?[fixture.erc20,fixture.permit2]:[]);
    assert.equal(stub.calls.some(c=>['eth_sendRawTransaction','eth_sendTransaction'].includes(c.method)),false);
  }
});

test('slippage boundaries never round minimum output below the requested tolerance', async () => {
  const { readSwapQuote } = await import('./src/swap.ts');
  for (const out of [1n, 10001n, (1n << 128n) - 1n]) {
    for (const bps of [0, 1, 5000]) {
      const q = await readSwapQuote(CONFIG, { token: TOKEN, side: 'buy', amount: '1', slippage_bps: bps },
        upstream({ quote: packed(out, 1) }).fetchImpl);
      const min = BigInt(q.min_out_raw);
      const scaled = out * BigInt(10000 - bps);
      assert.ok(min * 10000n >= scaled, 'minimum never admits excess slippage');
      assert.ok((min - 1n) * 10000n < scaled, 'minimum is the tightest integer ceiling');
      assert.ok(min > 0n && min <= out);
    }
  }
  for (const bps of [-1, 5001, 9999, 10000, 65535, 0.5, NaN, Infinity, '100']) {
    const stub = upstream();
    await assert.rejects(() => readSwapQuote(CONFIG, { token: TOKEN, side: 'buy', amount: '1', slippage_bps: bps }, stub.fetchImpl),
      e => e.outcome === 'invalid_request');
    assert.equal(stub.calls.length, 0);
  }
});

test('swap rejects every contract-forbidden output recipient before upstream reads', async () => {
  const { buildSwapTransaction } = await import('./src/swap.ts');
  for (const recipient of [
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000001002', MAINNET.router,
    '0x5809c1ff809cfc6fca8518016cdffa8339ba2a3a',
    '0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c',
  ]) {
    for (const side of ['buy', 'sell']) {
      const stub = upstream();
      await assert.rejects(() => buildSwapTransaction(CONFIG,
        { token: TOKEN, side, amount: '1', slippage_bps: 100, recipient: recipient.toUpperCase() }, stub.fetchImpl),
      e => e.outcome === 'invalid_request', `${side}: ${recipient}`);
      assert.equal(stub.calls.length, 0);
    }
  }
});

test('quote refuses wrong chain, unsupported decimals, missing pool and malformed quoter result',async()=>{
  const { readSwapQuote }=await import('./src/swap.ts');
  for(const [over,outcome] of [[{chain:'0x1'},'chain_mismatch'],[{decimals:6},'unsupported_decimals'],[{pool:{poolId:null}},'bad_payload'],[{quote:'0x'},'bad_payload']]) {
    await assert.rejects(()=>readSwapQuote(CONFIG,{token:TOKEN,side:'buy',amount:'1'},upstream(over).fetchImpl), e=>e.outcome===outcome);
  }
});

test('bad amounts and recipients fail before any upstream read; optional fees report RPC down',async()=>{
  const { readSwapQuote,buildSwapTransaction }=await import('./src/swap.ts');
  for(const amount of ['0','-1','1e3','0.0000000000000000001','340282366920938463464','NaN']) {
    const stub=upstream(); await assert.rejects(()=>readSwapQuote(CONFIG,{token:TOKEN,side:'buy',amount},stub.fetchImpl),e=>e.outcome==='invalid_request'); assert.equal(stub.calls.length,0);
  }
  const stub=upstream(); await assert.rejects(()=>buildSwapTransaction(CONFIG,{token:TOKEN,side:'buy',amount:'1',slippage_bps:100,recipient:'0x'+'0'.repeat(40)},stub.fetchImpl)); assert.equal(stub.calls.length,0);
  const q=await readSwapQuote(CONFIG,{token:TOKEN,side:'sell',amount:'1'},upstream({failSelector:selector('launchSnapshot(bytes32)')}).fetchImpl);
  assert.equal(q.fees,null); assert.equal(q.fees_status.outcome,'rpc_error'); assert.equal(q.fees_status.source,'rpc');
});

test('computable impact is explicitly fee-inclusive and unavailable slot data stays unknown', async () => {
  const { readSwapQuote } = await import('./src/swap.ts');
  for (const side of ['buy', 'sell']) {
    const q = await readSwapQuote(CONFIG, {token:TOKEN, side, amount:'1'}, upstream({quote:packed(900000000000000000n,1)}).fetchImpl);
    assert.equal(q.price_impact_bps,1000);
    assert.equal(q.price_impact_includes_fees,true);
  }
  const q = await readSwapQuote(CONFIG,{token:TOKEN,side:'buy',amount:'1'},upstream({failSelector:selector('getSlot0(bytes32)')}).fetchImpl);
  assert.equal(q.price_impact_bps,null);
  assert.equal(q.price_impact_status.outcome,'rpc_error');
});

test('admitted iAI quotes disclose dynamic LP fees without inventing a creator split', async () => {
  const { readSwapQuote } = await import('./src/swap.ts');
  const q = await readSwapQuote(CONFIG,{token:MAINNET.iaiToken,side:'buy',amount:'1'},upstream({
    token:MAINNET.iaiToken, pool:{poolId:'0xf88c23c1867ce26b75805570cbb0f5d5cb10c3102a7b46c5f2ca82b95ec17a07'},
    keyEncoding:packed(fixture.key.currency0,MAINNET.iaiToken,MAINNET.iaiHook,MAINNET.manager,0x800000,fixture.key.parameters),
  }).fetchImpl);
  assert.equal(q.fees.kind,'IAI_OPENING_FEE');
  assert.equal(q.fees.core.lp_fee_pips,5000);
  assert.equal(q.fees.split,null);
});
