import { addressWord, formatUnits, selector, uint, word, words } from './abi.js';
import type { McpConfig } from './config.js';
import { ensureDeployment, MAINNET } from './deployment.js';
import { feeTokens } from './market.js';
import { ReadError, Rpc } from './rpc.js';
import type { FetchLike } from './upstream.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const BYTES32 = /^0x[0-9a-f]{64}$/i;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const MAX_LEGS = 16;
const WALLET_SCAN_CONCURRENCY = 8;
const WALLET_RPC_CONCURRENCY = 8;
const WALLET_SCAN_BUDGET_MS = 20_000;

const SELECTOR = {
  splitOf: selector('splitOf(bytes32)'),
  legsOf: selector('legsOf(bytes32)'),
  legIdOf: selector('legIdOf(bytes32,bytes32)'),
  bindingOf: selector('bindingOf(bytes32)'),
  claimable: selector('claimable(bytes32,address)'),
  credits: selector('credits(bytes32,address)'),
  pendingOf: selector('pendingOf(bytes32,address)'),
  remainder: selector('remainder(bytes32,address)'),
} as const;

type Amount = { raw: string; formatted: string | null };
type CurrencyLedger = {
  earned: Amount; claimed: Amount; reassigned: Amount; claimable: Amount; pending: Amount;
};
type Credit = { earned: bigint; claimed: bigint; reassigned: bigint; lastEarnedAt: bigint };
type Pending = { baseFee: bigint; tax: bigint; remainder: bigint };
type FeeToken = { token: string; poolId: string; decimals: number | null };
type Split = {
  configured: boolean; protocolBps: number; creatorBps: number; computeBps: number; creatorIdentity: string;
};
type Leg = { kind: number; shareBps: number; identity: string };

const calldata = (name: keyof typeof SELECTOR, ...args: string[]) =>
  SELECTOR[name] + args.map((arg) => word(arg)).join('');

function amount(value: bigint, decimals: number | null): Amount {
  return { raw: value.toString(), formatted: decimals === null ? null : formatUnits(value, decimals) };
}

function tupleWords(data: string): string[] {
  if (!/^0x(?:[0-9a-f]{64})+$/i.test(data)) throw new ReadError('bad_payload');
  return words(data, (data.length - 2) / 64);
}

function decodeSplit(data: string): Split {
  const value = words(data, 5);
  const configured = uint(value[0]!);
  if (configured > 1n) throw new ReadError('bad_payload');
  const protocolBps = Number(uint(value[1]!, 16));
  const creatorBps = Number(uint(value[2]!, 16));
  const computeBps = Number(uint(value[3]!, 16));
  const creatorIdentity = `0x${value[4]!.toLowerCase()}`;
  if (configured === 0n) {
    if (protocolBps !== 0 || creatorBps !== 0 || computeBps !== 0 || uint(value[4]!) !== 0n) throw new ReadError('bad_payload');
  } else if (protocolBps + creatorBps !== 10_000 || computeBps > 10_000) throw new ReadError('bad_payload');
  return { configured: configured === 1n, protocolBps, creatorBps, computeBps, creatorIdentity };
}

function decodeLegs(data: string, allowEmpty = false): Leg[] {
  const value = tupleWords(data);
  if (value.length < 2 || uint(value[0]!) !== 32n) throw new ReadError('bad_payload');
  const count = Number(uint(value[1]!));
  if ((!allowEmpty && count < 1) || count > MAX_LEGS || value.length !== 2 + count * 3) throw new ReadError('bad_payload');
  const legs = Array.from({ length: count }, (_, index) => {
    const offset = 2 + index * 3;
    return {
      kind: Number(uint(value[offset]!, 8)),
      shareBps: Number(uint(value[offset + 1]!, 16)),
      identity: `0x${value[offset + 2]!.toLowerCase()}`,
    };
  });
  const walletLegs = legs.filter((leg) => leg.kind === 0);
  const identities = new Set(walletLegs.map((leg) => leg.identity));
  if (walletLegs.length !== legs.length || walletLegs.some((leg) => leg.shareBps < 1)
    || identities.size !== walletLegs.length
    || (!allowEmpty && walletLegs.reduce((sum, leg) => sum + leg.shareBps, 0) !== 10_000)) throw new ReadError('bad_payload');
  return walletLegs;
}

function decodeBinding(data: string): string {
  const value = words(data, 5);
  const wallet = addressWord(value[0]!);
  uint(value[1]!, 8); uint(value[2]!, 64); addressWord(value[3]!); uint(value[4]!, 64);
  if (wallet === ZERO_ADDRESS) throw new ReadError('bad_payload');
  return wallet;
}

function decodeCredit(data: string): Credit {
  const value = words(data, 4);
  return {
    earned: uint(value[0]!, 128), claimed: uint(value[1]!, 128),
    reassigned: uint(value[2]!, 128), lastEarnedAt: uint(value[3]!, 64),
  };
}

function decodePending(data: string): Omit<Pending, 'remainder'> {
  const value = words(data, 2);
  return { baseFee: uint(value[0]!, 128), tax: uint(value[1]!, 128) };
}

function project(pending: Pending, split: Split, shareBps: number): bigint {
  // Contract source (comfy-infinity @ 6fd0ccb8),
  // contracts/src/fees/FeeSplitter.sol:sweep L224-L270 (no-op at L243-L245),
  // contracts/src/fees/lib/Waterfall.sol:divide L55-L87. Protocol takes baseFee
  // only; compute precedes wallet legs; each division floors, carrying residue.
  // FeeSplitter does not sweep a carried remainder on its own.
  if (pending.baseFee === 0n && pending.tax === 0n) return 0n;
  const pot = pending.baseFee + pending.tax + pending.remainder;
  const protocol = pending.baseFee * BigInt(split.protocolBps) / 10_000n;
  const creatorPot = pot - protocol;
  const compute = creatorPot * BigInt(split.computeBps) / 10_000n;
  return (creatorPot - compute) * BigInt(shareBps) / 10_000n;
}

function ledger(credit: Credit, claimable: bigint, pending: bigint, decimals: number | null): CurrencyLedger {
  if (credit.claimed + credit.reassigned > credit.earned
    || credit.earned - credit.claimed - credit.reassigned !== claimable) throw new ReadError('bad_payload');
  return {
    earned: amount(credit.earned, decimals), claimed: amount(credit.claimed, decimals),
    reassigned: amount(credit.reassigned, decimals), claimable: amount(claimable, decimals),
    pending: amount(pending, decimals),
  };
}

async function readPool(
  rpc: Pick<Rpc, 'call'>,
  block: string,
  row: { token: string; poolId: string; decimals: number | null },
  walletFilter?: string,
) {
  if (!ADDRESS.test(row.token) || !BYTES32.test(row.poolId)
    || (row.decimals !== null && (!Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 255))) {
    throw new ReadError('bad_payload', 'indexer');
  }
  const token = row.token.toLowerCase();
  const poolId = row.poolId.toLowerCase();
  const [splitRaw, legsRaw] = await Promise.all([
    rpc.call(MAINNET.splitter, calldata('splitOf', poolId), block),
    rpc.call(MAINNET.splitter, calldata('legsOf', poolId), block),
  ]);
  const split = decodeSplit(splitRaw);
  const legs = decodeLegs(legsRaw, !split.configured);
  if (!split.configured) {
    if (legs.length !== 0) throw new ReadError('bad_payload');
    throw new ReadError('fees_not_configured');
  }
  const creator = legs.find((leg) => leg.identity === split.creatorIdentity);
  if (!creator) throw new ReadError('bad_payload');

  const bound: Array<{ leg: Leg; legId: string; wallet: string }> = [];
  for (let start = 0; start < legs.length; start += 2) {
    const pair = await Promise.all(legs.slice(start, start + 2).map(async (leg) => {
      const legIdRaw = await rpc.call(MAINNET.splitter, calldata('legIdOf', poolId, leg.identity), block);
      const legId = `0x${words(legIdRaw, 1)[0]!.toLowerCase()}`;
      const bindingRaw = await rpc.call(MAINNET.splitter, calldata('bindingOf', legId), block);
      return { leg, legId, wallet: decodeBinding(bindingRaw) };
    }));
    bound.push(...pair);
  }
  const selected = walletFilter ? bound.filter((entry) => entry.wallet === walletFilter) : bound;
  if (walletFilter && selected.length === 0) return null;

  const currencies = [ZERO_ADDRESS, token] as const;
  const pendingReads = await Promise.all(currencies.flatMap((currency) => [
    rpc.call(MAINNET.splitter, calldata('pendingOf', poolId, currency), block),
    rpc.call(MAINNET.splitter, calldata('remainder', poolId, currency), block),
  ]));
  const pending = currencies.map((_, index): Pending => ({
    ...decodePending(pendingReads[index * 2]!),
    remainder: uint(words(pendingReads[index * 2 + 1]!, 1)[0]!),
  }));

  const resolved = [];
  for (const { leg, legId, wallet } of selected) {
    const [nativeCreditRaw, nativeClaimableRaw, tokenCreditRaw, tokenClaimableRaw] = await Promise.all([
      rpc.call(MAINNET.splitter, calldata('credits', legId, ZERO_ADDRESS), block),
      rpc.call(MAINNET.splitter, calldata('claimable', legId, ZERO_ADDRESS), block),
      rpc.call(MAINNET.splitter, calldata('credits', legId, token), block),
      rpc.call(MAINNET.splitter, calldata('claimable', legId, token), block),
    ]);
    resolved.push({
      role: leg === creator ? 'creator' as const : 'recipient' as const,
      wallet, share_bps: leg.shareBps, leg_id: legId,
      native: ledger(decodeCredit(nativeCreditRaw), uint(words(nativeClaimableRaw, 1)[0]!), project(pending[0]!, split, leg.shareBps), 18),
      token: ledger(decodeCredit(tokenCreditRaw), uint(words(tokenClaimableRaw, 1)[0]!), project(pending[1]!, split, leg.shareBps), row.decimals),
    });
  }
  const pendingOutput = (value: Pending, decimals: number | null) => ({
    base_fee: amount(value.baseFee, decimals), tax: amount(value.tax, decimals), remainder: amount(value.remainder, decimals),
  });
  return {
    token, pool_id: poolId, decimals: row.decimals,
    split: { protocol_bps: split.protocolBps, creator_bps: split.creatorBps, compute_bps: split.computeBps },
    pending: { native: pendingOutput(pending[0]!, 18), token: pendingOutput(pending[1]!, row.decimals) },
    legs: resolved,
  };
}

/** Public, same-block FeeSplitter view. It never signs, sends, or estimates a lifetime
 * total from the bounded wallet scan; credits and the next-sweep projection stay apart. */
export async function readCreatorFees(
  config: McpConfig,
  input: { wallet?: string; token?: string },
  fetchImpl: FetchLike,
) {
  const wallet = input.wallet?.trim().toLowerCase();
  const token = input.token?.trim().toLowerCase();
  if ((!wallet && !token) || (wallet !== undefined && !ADDRESS.test(wallet))
    || (token !== undefined && !ADDRESS.test(token))) throw new ReadError('invalid_request');
  ensureDeployment(config);
  const controller = new AbortController();
  // Combine the whole-scan deadline with each upstream's own request timeout.
  // The outer race also bounds a transport/body reader that ignores cancellation.
  const boundedFetch: FetchLike = (url, init) => {
    controller.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: init?.signal
      ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  };
  let rows: FeeToken[] = [];
  let discoveryComplete = false;
  let scanned = 0;
  let excluded = 0;
  let blockNumber: string | null = null;
  const pools = new Map<number, NonNullable<Awaited<ReturnType<typeof readPool>>>>();
  const failed = new Map<number, { token: string; reason: string }>();
  const completed = new Set<number>();
  const scan = async () => {
    const listed = await feeTokens(config, token, boundedFetch);
    if (!listed.ok) throw new ReadError(listed.outcome, 'indexer');
    if (controller.signal.aborted) return;
    rows = listed.value.rows;
    discoveryComplete = listed.value.complete;
    scanned = listed.value.scanned;
    excluded = listed.value.excluded;
    listed.value.failed.forEach((failure, index) => failed.set(-index - 1, failure));
    const rpc = new Rpc(config, boundedFetch);
    const head = await rpc.head();
    if (controller.signal.aborted) return;
    blockNumber = BigInt(head.number).toString();
    // A pool's Promise.all can reject while sibling calls are still pending.
    // Keep their slots until the full RPC request (including JSON) settles.
    let activeCalls = 0;
    const waiting: Array<() => void> = [];
    const poolRpc: Pick<Rpc, 'call'> = token ? rpc : {
      call: async (to, data, block) => {
        if (activeCalls >= WALLET_RPC_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
        else activeCalls++;
        try {
          controller.signal.throwIfAborted();
          return await rpc.call(to, data, block);
        } finally {
          const nextCall = waiting.shift();
          if (nextCall) nextCall();
          else activeCalls--;
        }
      },
    };
    let next = 0;
    const worker = async () => {
      while (!controller.signal.aborted && next < rows.length) {
        const index = next++;
        const row = rows[index]!;
        try {
          const pool = await readPool(poolRpc, head.number, row, wallet);
          if (controller.signal.aborted) return;
          if (pool !== null) pools.set(index, pool);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (token) throw error;
          failed.set(index, { token: row.token, reason: error instanceof ReadError ? error.outcome : 'bad_payload' });
        }
        completed.add(index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(token ? 1 : WALLET_SCAN_CONCURRENCY, rows.length) }, worker));
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (token) await scan();
    else {
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve();
        }, WALLET_SCAN_BUDGET_MS);
      });
      await Promise.race([scan(), deadline]);
    }
    if (timedOut) {
      rows.forEach((row, index) => {
        if (!completed.has(index)) failed.set(index, { token: row.token, reason: 'timeout' });
      });
    }
    return {
      source: 'rpc' as const,
      chain_id: MAINNET.chainId,
      block_number: blockNumber,
      complete: discoveryComplete && !timedOut && failed.size === 0,
      scanned,
      excluded,
      scan_outcome: timedOut ? 'timeout' : failed.size ? 'partial' : 'ok',
      failed: [...failed.values()].sort((a, b) => a.token.localeCompare(b.token)),
      basis: 'Bounded indexed token window in ascending deployment:address order (by address, not launch time); admitted LP pools and tokens without launch pools are excluded. Claimable is credited now; pending is a separate next-sweep projection, not a lifetime total.',
      pools: [...pools].sort(([a], [b]) => a - b).map(([, pool]) => pool),
    };
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError('bad_payload');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
