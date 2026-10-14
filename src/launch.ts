import { z } from 'zod';
import { keccak256, selector, uint, word, words } from './abi.js';
import type { McpConfig } from './config.js';
import { ensureDeployment, MAINNET } from './deployment.js';
import { ReadError, Rpc } from './rpc.js';
import type { FetchLike } from './upstream.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DISGUISE_IN_SYMBOL = /[\p{Cc}\p{Cf}]/u;
const DISGUISE_IN_NAME = /\p{Cc}|(?![\u200C\u200D])\p{Cf}/u;
const SUPPLY = 10n ** 27n;
const MIN_DELAY_SECONDS = 30;
const MAX_RECIPIENT_BPS = 9_500;
// Retain both presets for SDK parity; MCP launches use only the project ladder for now.
export const LADDER_PRESETS = ['project', 'comfy-hype-phase'] as const;
type LadderPreset = (typeof LADDER_PRESETS)[number];
export const MIN_OPENING_TICK = -258_720;
export const MAX_OPENING_TICK = 887_220;
const encoder = new TextEncoder();

// ComfyLauncher._checkLegs and FeeSplitter._requirePayable apply to every fee wallet.
const address = z.string().regex(ADDRESS).refine((value) => ADDRESS.test(value) && BigInt(value) > 0x1002n
  && ![MAINNET.launcher, MAINNET.splitter, MAINNET.vault].some(account => account === value.toLowerCase()));
const hash = z.string().regex(HASH);
const termsSchema = z.object({
  creator_tax_bps: z.number().int().min(0).max(65_535),
  delay_seconds: z.number().int().min(MIN_DELAY_SECONDS).max(0xffff_ffff),
  opening_bps: z.number().int().min(0).max(65_535),
  floor_bps: z.number().int().min(0).max(65_535),
  decay_seconds: z.number().int().min(0).max(0xffff_ffff),
}).strict();
const recipientSchema = z.object({
  identity: hash,
  account_wallet: address,
  share_bps: z.number().int().min(1).max(10_000),
}).strict();

/** Raw Zod shape: server.ts passes this directly to registerTool. */
export const launchInputSchema = {
  creator: address.describe('Creator wallet that will submit the unsigned launch transaction.'),
  name: z.string().describe('Token name (UTF-8, at most 64 bytes).'),
  symbol: z.string().describe('Token ticker (UTF-8, at most 16 bytes).'),
  salt: hash.describe('CREATE2 salt, exactly 32 bytes.'),
  opening_tick: z.number().int().describe('Opening tick, aligned to the launcher tick spacing of 60.'),
  terms: termsSchema,
  image: z.string().default(''),
  metadata: z.string().default(''),
  context: z.string().default(''),
  recipients: z.array(recipientSchema).max(15).default([]),
} satisfies z.ZodRawShape;

const inputSchema = z.object(launchInputSchema).strict();
type LaunchInput = z.infer<typeof inputSchema>;

type LaunchConfig = {
  maxTaxBps: number;
  maxDelaySeconds: number;
  maxOpeningBps: number;
  maxDecaySeconds: number;
};

const invalid = (): never => { throw new ReadError('invalid_request'); };
function parseInput(value: unknown): LaunchInput {
  try {
    return inputSchema.parse(value) as LaunchInput;
  } catch {
    return invalid();
  }
}
const safeNumber = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(value);
};
const unsigned = (value: string, bits: number): number => safeNumber(uint(value, bits));

function parseConfig(data: string): { config: LaunchConfig; hash: string } {
  const row = words(data, 11);
  /* Decode every field, including fields this builder does not branch on. A
   * shifted legacy tuple must fail instead of becoming a plausible policy. */
  unsigned(row[0]!, 16);
  const maxTaxBps = unsigned(row[1]!, 16);
  const maxDelaySeconds = unsigned(row[2]!, 32);
  const maxOpeningBps = unsigned(row[3]!, 16);
  const maxDecaySeconds = unsigned(row[4]!, 32);
  unsigned(row[5]!, 16);
  unsigned(row[6]!, 16);
  unsigned(row[7]!, 16);
  uint(row[8]!, 160);
  uint(row[9]!, 160);
  return {
    config: { maxTaxBps, maxDelaySeconds, maxOpeningBps, maxDecaySeconds },
    hash: `0x${row[10]!.toLowerCase()}`,
  };
}

function validateInput(input: LaunchInput, config?: LaunchConfig): void {
  if (!input.name.trim() || !input.symbol.trim()) invalid();
  for (const [text, limit] of [[input.name, 64], [input.symbol, 16], [input.image, 4096], [input.metadata, 4096], [input.context, 4096]] as const)
    if (encoder.encode(text).length > limit) invalid();
  if (DISGUISE_IN_NAME.test(input.name) || DISGUISE_IN_SYMBOL.test(input.symbol)) invalid();
  if (input.opening_tick < MIN_OPENING_TICK || input.opening_tick > MAX_OPENING_TICK || input.opening_tick % 60 !== 0) invalid();
  const terms = input.terms;
  if (terms.floor_bps > Math.min(1_000, terms.opening_bps)) invalid();
  if (terms.opening_bps !== terms.floor_bps && terms.decay_seconds === 0) invalid();
  if (config && (
    terms.creator_tax_bps > config.maxTaxBps ||
    terms.delay_seconds > config.maxDelaySeconds ||
    terms.opening_bps > config.maxOpeningBps ||
    terms.decay_seconds > config.maxDecaySeconds
  )) invalid();
  const creatorIdentity = recipientIdentity(input.creator);
  const seen = new Set([creatorIdentity]);
  let taken = 0;
  for (const recipient of input.recipients) {
    const identity = recipient.identity.toLowerCase();
    if (seen.has(identity)) invalid();
    seen.add(identity);
    taken += recipient.share_bps;
  }
  if (taken > MAX_RECIPIENT_BPS) invalid();
}

function signedWord(value: number, bits: number): string {
  const n = BigInt(value);
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (n < min || n > max) invalid();
  return BigInt.asUintN(256, n).toString(16).padStart(64, '0');
}
const dynamicBytes = (bytes: Uint8Array): string => {
  const data = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return word(bytes.length) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');
};
const dynamicText = (value: string): string => dynamicBytes(encoder.encode(value));
const recipientIdentity = (account: string): string =>
  keccak256(encoder.encode(`wallet:${account.toLowerCase()}`));

export function launchLadder(openingTick: number, preset: LadderPreset = 'project') {
  if (!(LADDER_PRESETS as readonly unknown[]).includes(preset)) invalid();
  if (openingTick < MIN_OPENING_TICK || openingTick > MAX_OPENING_TICK || openingTick % 60 !== 0) invalid();
  if (preset === 'comfy-hype-phase') {
    const edge = openingTick - 25_080;
    return [
      { tickLower: edge, tickUpper: openingTick, supplyBps: 7_143 },
      { tickLower: -300_000, tickUpper: edge, supplyBps: 2_041 },
      { tickLower: -360_000, tickUpper: -300_000, supplyBps: 816 },
    ];
  }
  const edges = [0, 16_380, 28_380, 75_420, 89_400, 110_400];
  const shares = [999, 2_382, 4_123, 1_216, 1_280];
  return shares.map((supplyBps, index) => ({
    tickLower: openingTick - edges[index + 1]!,
    tickUpper: openingTick - edges[index]!,
    supplyBps,
  }));
}

function dynamicArray(rows: string[]): string { return word(rows.length) + rows.join(''); }

function encodeLaunch(input: LaunchInput, configHash: string, deadline: bigint): string {
  const creatorIdentity = recipientIdentity(input.creator);
  const taken = input.recipients.reduce((sum, recipient) => sum + recipient.share_bps, 0);
  const legs = [
    { identity: creatorIdentity, shareBps: 10_000 - taken },
    ...input.recipients.map((recipient) => ({ identity: recipient.identity.toLowerCase(), shareBps: recipient.share_bps })),
  ];
  const dynamic = [
    dynamicText(input.name), dynamicText(input.symbol), dynamicText(input.image),
    dynamicText(input.metadata), dynamicText(input.context),
    dynamicArray(launchLadder(input.opening_tick, 'project').map((rung) =>
      signedWord(rung.tickLower, 24) + signedWord(rung.tickUpper, 24) + word(rung.supplyBps))),
    dynamicArray(legs.map((leg) => word(0) + word(leg.shareBps) + word(leg.identity))),
    dynamicArray([input.creator, ...input.recipients.map((recipient) => recipient.account_wallet)].map((wallet) => word(wallet))),
  ];
  const headBytes = 19 * 32;
  let cursor = headBytes;
  const offset = (index: number): string => {
    const at = cursor;
    cursor += dynamic[index]!.length / 2;
    return word(at);
  };
  const head = [
    offset(0), offset(1), offset(2), offset(3), offset(4),
    word(input.salt), signedWord(60, 24), signedWord(input.opening_tick, 24), offset(5),
    word(input.terms.creator_tax_bps), word(input.terms.delay_seconds), word(input.terms.opening_bps),
    word(input.terms.floor_bps), word(input.terms.decay_seconds), word(creatorIdentity),
    offset(6), offset(7), word(configHash), word(deadline),
  ];
  return selector('launch((string,string,string,string,string,bytes32,int24,int24,(int24,int24,uint16)[],(uint16,uint32,uint16,uint16,uint32),bytes32,(uint8,uint16,bytes32)[],address[],bytes32,uint256))')
    + word(32) + head.join('') + dynamic.join('');
}

export async function buildLaunchTransaction(
  config: McpConfig,
  rawInput: unknown,
  fetchImpl: FetchLike = fetch,
) {
  ensureDeployment(config);
  const input = parseInput(rawInput);
  validateInput(input);

  const rpc = new Rpc(config, fetchImpl);
  const head = await rpc.head();
  const [configData, feeData, supplyData] = await Promise.all([
    rpc.call(MAINNET.launcher, selector('launchConfig()'), head.number),
    rpc.call(MAINNET.launcher, selector('launchFee()'), head.number),
    rpc.call(MAINNET.launcher, selector('SUPPLY()'), head.number),
  ]);
  const policy = parseConfig(configData);
  const fee = uint(words(feeData, 1)[0]!);
  const supply = uint(words(supplyData, 1)[0]!);
  if (supply !== SUPPLY) invalid();
  validateInput(input, policy.config);
  const deadline = head.timestamp + 300n;

  return {
    chainId: MAINNET.chainId,
    to: MAINNET.launcher,
    data: encodeLaunch(input, policy.hash, deadline),
    value: fee.toString(),
    description: `Launch ${JSON.stringify(input.symbol)} (${JSON.stringify(input.name)}) on 0G mainnet; unsigned and not submitted.`,
    approvals_needed: [] as never[],
    policy: {
      block_number: head.number,
      block_timestamp: head.timestamp.toString(),
      source_commit: MAINNET.sourceCommit,
      config_hash: policy.hash,
      launch_fee_wei: fee.toString(),
      supply: supply.toString(),
      deadline: deadline.toString(),
    },
  };
}
