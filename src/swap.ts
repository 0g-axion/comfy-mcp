import { z } from 'zod';
import type { McpConfig } from './config.js';
import type { FetchLike } from './upstream.js';
import { swapMarket } from './market.js';
import { MAINNET, ensureDeployment } from './deployment.js';
import { Rpc, ReadError } from './rpc.js';
import { word, words, uint, addressWord, formatUnits, keccak256, selector } from './abi.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const POOL = '(address,address,address,address,uint24,bytes32)';
/** ABI fragments copied from shared/infinity-sdk/swap/abi.ts, pinned by fixtures. */
const QUOTE = selector(`quoteExactInputSingle((${POOL},bool,uint128,bytes))`);
const BUY = selector(`buyWithNative(${POOL},uint256,address,uint256)`);
const SELL = selector(`sellForNative(${POOL},uint256,uint256,address,uint256,(((address,uint160,uint48,uint48),address,uint256),bytes))`);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export const swapInputSchema = {
  token: z.string().regex(ADDRESS),
  side: z.enum(['buy', 'sell']),
  amount: z.string().max(80).describe('Exact decimal human units: native 0G for buys, tokens for sells. No exponents.'),
  slippage_bps: z.number().int().min(0).max(5000).default(100),
};
type SwapInput = { token: string; side: 'buy' | 'sell'; amount: string; slippage_bps?: number };
const parsedInput = (input: SwapInput) => {
  const parsed = z.object(swapInputSchema).safeParse(input);
  if (!parsed.success || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(input.amount)) throw new ReadError('invalid_request');
  const [whole, fraction = ''] = input.amount.split('.');
  const amount = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (amount < 1n || amount >= 1n << 128n || input.token.toLowerCase() === ZERO) throw new ReadError('invalid_request');
  return { ...parsed.data, token: input.token.toLowerCase(), amountRaw: amount };
};

async function context(config: McpConfig, input: SwapInput, fetchImpl: FetchLike) {
  const parsed = parsedInput(input);
  ensureDeployment(config);
  const found = await swapMarket(config, parsed.token, fetchImpl);
  if (!found.ok) throw new ReadError(found.outcome, 'indexer');
  if (!found.value) throw new ReadError('pool_unavailable', 'indexer');
  const poolId = found.value.pool.poolId;
  if (typeof poolId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(poolId)) throw new ReadError('bad_payload', 'indexer');
  const rpc = new Rpc(config, fetchImpl), head = await rpc.head();
  const [keyResult, managerResult, permitResult, decimalsResult] = await Promise.all([
    rpc.call(MAINNET.manager, selector('poolIdToPoolKey(bytes32)') + word(poolId), head.number),
    rpc.call(MAINNET.router, selector('poolManager()'), head.number),
    rpc.call(MAINNET.router, selector('permit2()'), head.number),
    rpc.call(parsed.token, selector('decimals()'), head.number),
  ]);
  const key = words(keyResult, 6);
  const [currency0, currency1, hook, manager] = key.slice(0, 4).map(addressWord);
  const fee = Number(uint(key[4], 24));
  if (keccak256(Buffer.from(key.join(''), 'hex')) !== poolId.toLowerCase()
    || currency0 !== ZERO || currency1 !== parsed.token || manager !== MAINNET.manager
    || addressWord(words(managerResult, 1)[0]) !== MAINNET.manager
    || addressWord(words(permitResult, 1)[0]) !== MAINNET.permit2) throw new ReadError('venue_mismatch');
  if (uint(words(decimalsResult, 1)[0], 8) !== 18n || found.value.token.decimals !== 18) throw new ReadError('unsupported_decimals');
  const iai = fee === 0x800000 && hook === MAINNET.iaiHook && parsed.token === MAINNET.iaiToken;
  if (!(fee === 0 && hook === MAINNET.hook) && !iai) throw new ReadError('unsupported_pool');
  return { ...parsed, poolId, rpc, head, key, fee, hook, iai };
}
type Context = Awaited<ReturnType<typeof context>>;

async function feeBreakdown(c: Context, slot: string[]) {
  const { rpc, head, poolId, hook, side } = c;
  const packed = Number(uint(slot[2], 24));
  const protocolPips = side === 'buy' ? packed & 0xfff : packed >> 12;
  if (protocolPips > 4000) throw new ReadError('bad_payload');
  if (c.iai) {
    const rates = words(await rpc.call(hook, selector('currentFees(bytes32)') + word(poolId), head.number), 2);
    const lpPips = Number(uint(rates[side === 'buy' ? 0 : 1], 24));
    if (lpPips > 1_000_000) throw new ReadError('bad_payload');
    return { kind: 'IAI_OPENING_FEE', hook: null, split: null,
      core: { lp_fee_pips: lpPips, protocol_fee_pips: protocolPips,
        swap_fee_pips: protocolPips + lpPips - Math.floor(protocolPips * lpPips / 1_000_000), denominator: 1_000_000 },
      basis: 'Dynamic LP fee on swap input; this is not a Comfy launch-hook charge or FeeSplitter split.' };
  }
  const [snapshotResult, pausedResult, splitResult] = await Promise.all([
    rpc.call(hook, selector('launchSnapshot(bytes32)') + word(poolId), head.number),
    rpc.call(hook, selector('chargingPaused()'), head.number),
    rpc.call(MAINNET.splitter, selector('splitOf(bytes32)') + word(poolId), head.number),
  ]);
  const s = words(snapshotResult, 12), split = words(splitResult, 5);
  if (s.slice(0, 3).some(v => uint(v, 1) !== 1n) || uint(split[0], 1) !== 1n) throw new ReadError('fees_unconfigured');
  addressWord(s[3]); uint(s[5], 64);
  let base = Number(uint(s[6], 16)), tax = Number(uint(s[7], 16));
  const initial = Number(uint(s[9], 16)), floor = Number(uint(s[10], 16)), decay = uint(s[11], 32);
  const elapsed = head.timestamp - uint(s[4], 64) - uint(s[8], 32);
  if (elapsed < 0n || base > 1000 || tax > 1000 || initial > 9900 || floor > Math.min(1000, initial)
    || (initial > floor && decay === 0n)) throw new ReadError('bad_payload');
  let opening = side === 'sell' ? 0 : elapsed === 0n ? initial : elapsed >= decay ? floor
    : initial - Number(BigInt(initial - floor) * elapsed / decay);
  let excess = Math.max(0, base + tax + opening - 9900);
  const openingCut = Math.min(excess, opening); opening -= openingCut; excess -= openingCut;
  const taxCut = Math.min(excess, tax); tax -= taxCut; base -= excess - taxCut;
  const paused = uint(words(pausedResult, 1)[0], 1) === 1n;
  if (paused) base = tax = opening = 0;
  const protocol = Number(uint(split[1], 16)), creator = Number(uint(split[2], 16)), compute = Number(uint(split[3], 16));
  if (protocol + creator !== 10000 || compute > 10000 || uint(slot[3], 24) !== 0n) throw new ReadError('bad_payload');
  return { kind: 'COMFY_LAUNCH',
    hook: { base_bps: base, creator_tax_bps: tax, opening_bps: opening, total_bps: base + tax + opening, denominator: 10000, paused },
    core: { lp_fee_pips: 0, protocol_fee_pips: protocolPips, denominator: 1_000_000 },
    split: { protocol_bps: protocol, creator_bps: creator, creator_compute_bps: compute },
    basis: 'Hook bps apply to the native quote leg. Core pips apply to AMM input. Protocol split applies only to base plus opening revenue; all creator tax joins the creator pot; compute is then taken before wallet legs. These rates must not be added into a universal percentage.',
  };
}

async function quoted(c: Context) {
  // One dynamic tuple: its head is 9 words (6 pool fields + direction + amount + bytes offset).
  const data = QUOTE + word(32) + c.key.join('') + word(c.side === 'buy' ? 1 : 0) + word(c.amountRaw) + word(9 * 32) + word(0);
  const result = words(await c.rpc.call(MAINNET.quoter, data, c.head.number), 2);
  const out = uint(result[0], 128), gas = uint(result[1]);
  if (out === 0n) throw new ReadError('insufficient_output');
  const min = (out * BigInt(10000 - c.slippage_bps) + 9999n) / 10000n;
  let fees: Awaited<ReturnType<typeof feeBreakdown>> | null = null;
  let feesStatus: { outcome: string; source: string } | null = null;
  let impact: number | null = null;
  let impactStatus = { outcome: 'ok', source: 'rpc' };
  let slot: string[] | null = null;
  try {
    slot = words(await c.rpc.call(MAINNET.manager, selector('getSlot0(bytes32)') + word(c.poolId), c.head.number), 4);
    const sqrt = uint(slot[0], 160);
    if (sqrt === 0n) throw new ReadError('price_unknown');
    const square = sqrt * sqrt, q192 = 1n << 192n;
    const idealNumerator = c.amountRaw * (c.side === 'buy' ? square : q192);
    const idealDenominator = c.side === 'buy' ? q192 : square;
    impact = Number((idealNumerator - out * idealDenominator) * 1_000_000n / idealNumerator) / 100;
  } catch (error) {
    impactStatus = { outcome: error instanceof ReadError ? error.outcome : 'bad_payload', source: 'rpc' };
  }
  try { if (!slot) throw new ReadError(impactStatus.outcome); fees = await feeBreakdown(c, slot); }
  catch (error) { feesStatus = { outcome: error instanceof ReadError ? error.outcome : 'bad_payload', source: 'rpc' }; }
  return { out, min, data: {
    chainId: MAINNET.chainId, token: c.token, side: c.side, amount: c.amount, amount_raw: c.amountRaw.toString(),
    expected_out: formatUnits(out, 18), expected_out_raw: out.toString(),
    min_out: formatUnits(min, 18), min_out_raw: min.toString(), output_currency: c.side === 'buy' ? c.token : '0G',
    slippage_bps: c.slippage_bps, block_number: BigInt(c.head.number).toString(), block_timestamp: c.head.timestamp.toString(),
    gas_estimate: gas.toString(), pool_id: c.poolId, quoter: MAINNET.quoter,
    price_impact_bps: impact, price_impact_includes_fees: true, price_impact_status: impactStatus,
    price_impact_basis: 'Execution output deviation from pre-swap slot0 spot at the quote block, including hook/core fees and curve movement. Negative means improved output; this is not isolated curve impact.',
    fees, fees_status: feesStatus ?? { outcome: 'ok', source: 'rpc' },
  } };
}

export async function readSwapQuote(config: McpConfig, input: SwapInput, fetchImpl: FetchLike) {
  return (await quoted(await context(config, input, fetchImpl))).data;
}

export async function buildSwapTransaction(config: McpConfig, input: SwapInput & { recipient: string }, fetchImpl: FetchLike) {
  const recipient = input.recipient?.toLowerCase();
  // ComfyRouter._frame rejects these destinations on both buy and sell routes.
  if (!ADDRESS.test(recipient) || BigInt(recipient) <= 0x1002n
    || [MAINNET.router, MAINNET.vault, MAINNET.w0g].some(address => address === recipient)
    || input.slippage_bps === undefined) throw new ReadError('invalid_request');
  const c = await context(config, input, fetchImpl), quote = await quoted(c);
  const deadline = c.head.timestamp + 600n;
  // Same SDK empty Permit used with a pre-existing (or unsigned approval-created) allowance.
  const data = c.side === 'buy'
    ? BUY + c.key.join('') + word(quote.min) + word(recipient) + word(deadline)
    : SELL + c.key.join('') + word(c.amountRaw) + word(quote.min) + word(recipient) + word(deadline)
      + word(11 * 32) + word(0).repeat(6) + word(7 * 32) + word(0);
  const approvals = c.side === 'buy' ? [] : [
    { chainId: MAINNET.chainId, to: c.token, data: selector('approve(address,uint256)') + word(MAINNET.permit2) + word(c.amountRaw), value: '0',
      description: 'ERC20 approve Permit2 for the exact sell amount. Required if the sending wallet has insufficient allowance; some tokens require resetting a nonzero allowance first.' },
    { chainId: MAINNET.chainId, to: MAINNET.permit2, data: selector('approve(address,address,uint160,uint48)') + word(c.token) + word(MAINNET.router) + word(c.amountRaw) + word(deadline), value: '0',
      description: 'Permit2 approve the ComfyRouter for the exact sell amount until the swap deadline. Required unless an existing allowance covers both; execute after ERC20 approval.' },
  ];
  return { chainId: MAINNET.chainId, to: MAINNET.router, data, value: c.side === 'buy' ? c.amountRaw.toString() : '0',
    description: `UNSIGNED ${c.side} of ${c.amount} ${c.side === 'buy' ? '0G' : 'tokens'}; minimum output ${quote.data.min_out}. Sign and submit separately before the deadline.`,
    approvals_needed: approvals, approval_basis: 'Conditional prerequisites for the sending wallet; recipient is only the output destination, not proof of the sender. No allowance assumed or signature requested.',
    deadline: deadline.toString(), quote: quote.data };
}
