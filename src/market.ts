/* The market tools' reads over the Infinity index.
 *
 * The MCP used to read the retired Envio index, which production no longer serves: its
 * queries came back "query is not allowed". These compose the PUBLIC base reads
 * (queries.ts), the way the web's own projections do. (The market collection is served
 * too, but only in its generated form, whose documents are not reproduced here.)
 *
 *   launches   newest first, by widening a timestamp window (the reads page in
 *              ascending cursor order only, so "the latest" is the tail of a window)
 *   tokens     identity, supply and holders, by address
 *   pools      price, FDV, market cap, liquidity, traders, last trade, by pool key
 *   candles    hourly buckets for the 24h change and volume (sdk market/board dayWindow)
 *   trades     one pool's newest trades, by the same widening window
 *
 * One honesty rule for every figure: a pool that has never traded has no measured
 * price, change, volume or market cap. Those are null, not zero. That is stricter than
 * the web, which prints a fresh launch's opening price and FDV; the MCP's callers are
 * programs that would read an opening price as a trade. A figure the index did not carry
 * is null, and an index that cannot be read is an outcome, never an empty list. The
 * affiliate's market (iAI) is listed beside the launches, as on the site's board. */
import type { McpConfig } from './config.js';
import { indexerQuery, type FetchLike, type UpstreamFailure } from './upstream.js';
import { INFINITY_CANDLES, INFINITY_LAUNCHES, INFINITY_POOLS, INFINITY_TOKENS, INFINITY_TRADES } from './queries.js';

type Row = Record<string, unknown>;
type Deployment = { id: string; sourceTimestamp?: string | null; rows: Row[] };
export type MarketFailure = { outcome: UpstreamFailure | 'deployment_unknown' | 'window_overflow'; status?: number };
type Read<T> = { ok: true; value: T } | ({ ok: false } & MarketFailure);

/** The indexer answers at most this many rows a page. */
const PAGE = 100;
/** A read never follows more pages than this, so a tool call stays bounded. */
const MAX_PAGES = 10;
const HOUR = 3_600;
const DAY = 86_400;
/** How far back the newest-first reads look, widening until they have enough. It
 *  starts small because a read that runs out of pages is not the newest: its tail is
 *  wherever the page budget stopped. */
const WINDOWS = [300, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY, 365 * DAY, Number.POSITIVE_INFINITY];

const OPS = {
  InfinityLaunches: INFINITY_LAUNCHES,
  InfinityTokens: INFINITY_TOKENS,
  InfinityPools: INFINITY_POOLS,
  InfinityTrades: INFINITY_TRADES,
  InfinityCandles: INFINITY_CANDLES,
} as const;

/** Every page of one base read under `where`, in the index's own ascending order. The
 *  deployment row comes back with each page; its chain time is the clock of the read. */
async function pages(
  config: McpConfig,
  operation: keyof typeof OPS,
  where: Row,
  fetchImpl: FetchLike,
  cursorField: 'id' | 'cursor',
  maxPages = MAX_PAGES,
): Promise<Read<{ rows: Row[]; through: number | null; complete: boolean }>> {
  const rows: Row[] = [];
  let after = '';
  let through: number | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await indexerQuery<{ InfinityDeployment?: Deployment[] }>(
      config, operation, OPS[operation],
      { deploymentId: config.deploymentId, after, limit: PAGE, where }, fetchImpl,
    );
    if (result.outcome !== 'ok') return { ok: false, outcome: result.outcome, status: result.status };
    const deployment = result.data.InfinityDeployment?.[0];
    /* the key names no deployment the index knows: a configuration fault, said as one */
    if (!deployment || deployment.id !== config.deploymentId) return { ok: false, outcome: 'deployment_unknown' };
    if (!Array.isArray(deployment.rows)) return { ok: false, outcome: 'bad_payload' };
    const seconds = Number(deployment.sourceTimestamp);
    if (Number.isFinite(seconds) && seconds > 0) through = seconds;
    rows.push(...deployment.rows);
    if (deployment.rows.length < PAGE) return { ok: true, value: { rows, through, complete: true } };
    const last = deployment.rows[deployment.rows.length - 1]?.[cursorField];
    if (typeof last !== 'string') return { ok: false, outcome: 'bad_payload' };
    after = last;
  }
  /* the page budget ran out with more rows waiting: what is here is a prefix */
  return { ok: true, value: { rows, through, complete: false } };
}

/** The newest `want` rows of a read ordered by `timestamp`, by widening the window
 *  until it holds enough or reaches the start of the index. */
async function newest(
  config: McpConfig,
  operation: 'InfinityLaunches' | 'InfinityTrades',
  where: Row,
  want: number,
  fetchImpl: FetchLike,
): Promise<Read<Row[]>> {
  const now = Math.floor(Date.now() / 1000);
  let rows: Row[] = [];
  for (const window of WINDOWS) {
    const scoped = Number.isFinite(window)
      ? { _and: [where, { timestamp: { _gt: String(now - window) } }] }
      : where;
    const read = await pages(config, operation, scoped, fetchImpl, 'cursor');
    if (!read.ok) return read;
    /* A cut-off read's tail is not the newest. The smaller window before it was whole,
       so its rows are the newest there are, if fewer than asked; with none, say so. */
    if (!read.value.complete) {
      if (rows.length) break;
      return { ok: false, outcome: 'window_overflow' };
    }
    rows = read.value.rows;
    if (rows.length >= want) break;
  }
  /* ascending cursor order, so the newest are last */
  return { ok: true, value: rows.slice(-want).reverse() };
}

/* --- text a reader sees (web lib/token-text) --------------------------------------- */

const HIDDEN_IN_TICKER = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const HIDDEN_IN_NAME = /(?![‌‍])\p{Cf}/gu;
const CONTROLS = /\p{Cc}+/gu;
const BLANK_LETTERS = /[ᅟᅠㅤﾠ⠀]/g;
const tidy = (text: string) => text.replace(BLANK_LETTERS, '').replace(/\s+/g, ' ').trim();

/** The ticker as a reader sees it, or null when nothing visible is left: a zero-width
 *  space or a right-to-left override must not let one token pass for another. */
export const visibleTicker = (raw: unknown): string | null =>
  typeof raw === 'string' ? tidy(raw.replace(HIDDEN_IN_TICKER, '')) || null : null;
export const visibleName = (raw: unknown): string | null =>
  typeof raw === 'string' ? tidy(raw.replace(CONTROLS, ' ').replace(HIDDEN_IN_NAME, '')) || null : null;
const tickerKey = (raw: unknown) => visibleTicker(raw)?.normalize('NFKC').toUpperCase() ?? null;

/* --- what the site's lists leave out (web lib/test-tokens, reserved-tokens). A pool's
       opening fee or floor hides nothing. tools.test.mjs pins these lists to the
       web's. ------------------------------------------------------------------------ */

export const TEST_TOKEN_ADDRESSES: readonly string[] = [
  '0x9047598b611e8e766ecd7244a672ca22febe82e2',
  '0xe19198e959476d5ad5483c9b76d22210d99f2c14',
];
export const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /^qa[\s_-]/i,
  /^test probe\b/i,
  /\bselftest\b/i,
  /\bhearth probe\b/i,
  /^t13 receipt agent$/i,
  /^demo agent$/i,
];
export const RESERVED_TICKERS: readonly string[] = ['0G', 'W0G', 'AI', 'IAI', 'A0G', '0GM', 'COMFY', 'PC', 'ZIGGY', 'MUHABBIT', 'ZEROSTACK'];
export const OFFICIAL_TOKEN_ADDRESSES: readonly string[] = [];
const IAI_POOL_KIND = 'IAI_OPENING_FEE';

/** Why the site's lists leave a token out, or null when they show it. It stays readable
 *  by its address (comfy_token), and the list says how many it left out. */
export function hiddenReason(token: Row, pool: Row | undefined): 'test' | 'reserved_ticker' | null {
  const address = String(token.address ?? '').toLowerCase();
  const name = visibleName(token.name);
  if (TEST_TOKEN_ADDRESSES.includes(address) || (name && TEST_NAME_PATTERNS.some((p) => p.test(name)))) return 'test';
  const iai = pool?.kind === IAI_POOL_KIND;
  const key = tickerKey(token.symbol)?.replace(/^\$+/, '') || null;
  if (!iai && !OFFICIAL_TOKEN_ADDRESSES.includes(address) && key && RESERVED_TICKERS.includes(key)) return 'reserved_ticker';
  return null;
}

/* --- figures -------------------------------------------------------------------- */

const bigOrNull = (value: unknown): bigint | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try { return BigInt(value); } catch { return null; }
};
/** A fixed-point integer as a decimal number, through its decimal text so that
 *  19000 × 10^18 reads 19000 and not 19000.000000000004. */
const fixed = (n: bigint, decimals = 18): number => {
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(decimals + 1, '0');
  const text = `${digits.slice(0, -decimals) || '0'}.${digits.slice(-decimals)}`;
  return (negative ? -1 : 1) * Number(text);
};
/** An 18-decimal fixed-point figure as a number, or null when the index had none. */
const units = (value: unknown, decimals = 18): number | null => {
  const n = bigOrNull(value);
  return n === null ? null : fixed(n, decimals);
};
const count = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const seconds = (value: unknown): number | null => {
  const n = Number(value);
  return value == null || !Number.isFinite(n) || n <= 0 ? null : n;
};
const lower = (value: unknown): string | null => (typeof value === 'string' && value ? value.toLowerCase() : null);

type Hour = { bucketStart: bigint; openX18: bigint; closeX18: bigint; volumeQuote: bigint; trades: number };

/** 24h change (percent, in 0G) and volume from hourly buckets overlapping
 *  (through - 24h, through], exactly as the web's board computes them
 *  (shared/infinity-sdk market/board dayWindow). */
export function dayWindow(hours: Hour[], price: bigint | null, through: number) {
  const from = BigInt(through) - BigInt(DAY);
  const sorted = [...hours].sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : 1));
  const inside = sorted.filter((h) => h.bucketStart + BigInt(HOUR) > from);
  const volumeQuote = inside.reduce((sum, h) => sum + h.volumeQuote, 0n);
  const traded = inside.some((h) => h.trades > 0);
  let change: number | null = null;
  if (traded && price !== null) {
    const before = sorted.filter((h) => h.bucketStart + BigInt(HOUR) <= from).at(-1);
    const base = before ? before.closeX18 : inside[0]!.openX18;
    if (base > 0n) change = Number(((price - base) * 1_000_000n) / base) / 10_000;
  }
  return { volumeQuote, traded, change };
}

/** 25 hours of hourly buckets cover a 24-hour window that started inside an hour
 *  (sdk market/client hourWindowStart). */
const hourWindowStart = (through: number) => String(Math.max(0, Math.floor((through - 25 * HOUR) / HOUR) * HOUR));

function hoursOf(rows: Row[]): Map<string, Hour[]> {
  const byPool = new Map<string, Hour[]>();
  for (const row of rows) {
    const key = String(row.poolKey ?? '');
    const open = bigOrNull(row.openX18), close = bigOrNull(row.closeX18), start = bigOrNull(row.bucketStart);
    if (!key || open === null || close === null || start === null) continue;
    const list = byPool.get(key) ?? [];
    list.push({ bucketStart: start, openX18: open, closeX18: close, volumeQuote: bigOrNull(row.volumeQuote) ?? 0n, trades: count(row.trades) });
    byPool.set(key, list);
  }
  return byPool;
}

export interface TokenSummary {
  token: string;
  symbol: string | null;
  name: string | null;
  pool: string | null;
  /** true for the affiliate's own market (iAI, "Affiliated" on the site) */
  affiliated: boolean;
  creator: string | null;
  launched_at: number | null;
  price_og: number | null;
  chg_24h: number | null;
  vol_24h: number | null;
  traders: number | null;
  holder_count: number | null;
  fdv_og: number | null;
  mcap_og: number | null;
  /** the 0G actually in the pool: its depth. The index's `liquidityQuote` also counts
   *  the unsold supply at its price, which reads as deep liquidity on a coin that holds
   *  none (a fresh launch's equals its FDV), so it is not what this reports. */
  liquidity_og: number | null;
  total_supply: number | null;
  last_trade_ts: number | null;
}

const maybeCount = (value: unknown): number | null => (value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null);

function summarize(token: Row, pool: Row | undefined, hours: Hour[] | undefined | null, through: number | null): TokenSummary {
  const decimals = count(token.decimals) || 18;
  const traded = pool != null && seconds(pool.lastTradeAt) !== null;
  const price = traded ? bigOrNull(pool!.priceQuotePerTokenX18) : null;
  /* `hours === null`: the buckets could not be read whole, so the day is unknown */
  const day = traded && through !== null && hours !== null ? dayWindow(hours ?? [], price, through) : null;
  return {
    token: String(token.address).toLowerCase(),
    symbol: visibleTicker(token.symbol),
    name: visibleName(token.name),
    pool: pool ? String(pool.id) : lower(token.launchedPoolKey),
    affiliated: pool?.kind === IAI_POOL_KIND,
    creator: lower(token.creator),
    launched_at: pool ? seconds(pool.launchTimestamp) ?? seconds(pool.initializedAt) : null,
    price_og: price === null ? null : fixed(price),
    chg_24h: day?.change ?? null,
    /* a market that never traded has no measured 24h volume: unknown, not 0 */
    vol_24h: day ? fixed(day.volumeQuote) : null,
    /* a count the index did not carry is unknown, not zero */
    traders: pool ? maybeCount(pool.traderCount) : null,
    holder_count: maybeCount(token.holderCount),
    fdv_og: traded ? units(pool!.fdvQuote) : null,
    mcap_og: traded ? units(pool!.marketCapQuote) : null,
    liquidity_og: pool ? units(pool.quoteInPool) : null,
    total_supply: units(token.totalSupply, decimals),
    last_trade_ts: pool ? seconds(pool.lastTradeAt) : null,
  };
}

const EMPTY = { ok: true as const, value: { rows: [] as Row[], through: null as number | null, complete: true } };

/** The affiliate's market the site's board carries beside the launches (sdk market/board:
 *  the latest pool of the iAI kind, its token on the pool's token side, once that token
 *  has a supply snapshot). iAI has no launch row, so a list of launches alone misses it. */
async function iaiMarket(config: McpConfig, fetchImpl: FetchLike): Promise<Read<{ pool: Row; tokenAddress: string } | null>> {
  const pools = await pages(config, 'InfinityPools', { kind: { _eq: IAI_POOL_KIND } }, fetchImpl, 'id');
  if (!pools.ok) return pools;
  const latest = [...pools.value.rows].sort((x, y) =>
    count(y.launchTimestamp ?? y.initializedAt) - count(x.launchTimestamp ?? x.initializedAt))[0];
  if (!latest) return { ok: true, value: null };
  const side = latest.tokenIsCurrency0 === true ? latest.currency0 : latest.currency1;
  const tokenAddress = lower(side);
  return { ok: true, value: tokenAddress ? { pool: latest, tokenAddress } : null };
}

/** Hourly buckets for these pools, or null when they could not be read whole. */
async function hoursFor(config: McpConfig, poolKeys: string[], through: number | null, fetchImpl: FetchLike): Promise<Read<Map<string, Hour[]> | null>> {
  if (!poolKeys.length || through === null) return { ok: true, value: new Map() };
  const candles = await pages(config, 'InfinityCandles', {
    poolKey: { _in: poolKeys }, intervalSeconds: { _eq: HOUR }, bucketStart: { _gte: hourWindowStart(through) },
  }, fetchImpl, 'id');
  if (!candles.ok) return candles;
  /* hours cut off by the page budget would be a wrong day, not a partial one: the 24h
     figures are then unknown rather than quietly low */
  return { ok: true, value: candles.value.complete ? hoursOf(candles.value.rows) : null };
}

/** The newest launches the site lists, newest first, the affiliate's market leading as
 *  it does on the site's board, and how many rows the list left out on the way. */
export async function latestTokens(config: McpConfig, limit: number, fetchImpl: FetchLike): Promise<Read<{ tokens: TokenSummary[]; hidden: number }>> {
  /* read a little past `limit`, since some of the newest may be ones the site leaves out */
  const [launches, iai] = await Promise.all([
    newest(config, 'InfinityLaunches', {}, Math.min(PAGE, limit * 2), fetchImpl),
    iaiMarket(config, fetchImpl),
  ]);
  if (!launches.ok) return launches;
  if (!iai.ok) return iai;
  const addresses = new Set(launches.value.map((r) => String(r.token).toLowerCase()));
  if (iai.value) addresses.add(iai.value.tokenAddress);
  const poolKeys = [...new Set(launches.value.map((r) => String(r.poolKey)))];
  const [tokens, pools] = await Promise.all([
    pages(config, 'InfinityTokens', { address: { _in: [...addresses] } }, fetchImpl, 'id'),
    poolKeys.length ? pages(config, 'InfinityPools', { id: { _in: poolKeys } }, fetchImpl, 'id') : Promise.resolve(EMPTY),
  ]);
  if (!tokens.ok) return tokens;
  if (!pools.ok) return pools;
  const tokenBy = new Map(tokens.value.rows.map((row) => [String(row.address).toLowerCase(), row]));
  const poolBy = new Map(pools.value.rows.map((row) => [String(row.id), row]));

  const chosen: Array<{ token: Row; pool: Row | undefined; launchedAt: number | null }> = [];
  const iaiToken = iai.value ? tokenBy.get(iai.value.tokenAddress) : undefined;
  /* the admitted token is visible at Initialize; its first supply snapshot is block-end */
  if (iai.value && iaiToken && iaiToken.totalSupply != null) chosen.push({ token: iaiToken, pool: iai.value.pool, launchedAt: null });
  let hidden = 0;
  for (const launch of launches.value) {
    const token = tokenBy.get(String(launch.token).toLowerCase());
    if (!token) continue;
    const pool = poolBy.get(String(launch.poolKey));
    if (hiddenReason(token, pool)) { hidden += 1; continue; }
    if (chosen.length < limit) chosen.push({ token, pool, launchedAt: seconds(launch.timestamp) });
  }
  /* buckets for the rows listed only, so hidden and unlisted rows cannot spend the budget */
  const through = pools.value.through ?? tokens.value.through;
  const hours = await hoursFor(config, [...new Set(chosen.flatMap((c) => (c.pool ? [String(c.pool.id)] : [])))], through, fetchImpl);
  if (!hours.ok) return hours;
  return {
    ok: true,
    value: {
      tokens: chosen.map(({ token, pool, launchedAt }) => {
        const summary = summarize(token, pool, hours.value === null ? null : pool ? hours.value.get(String(pool.id)) : undefined, through);
        return launchedAt === null ? summary : { ...summary, launched_at: launchedAt };
      }),
      hidden,
    },
  };
}

/** The pool a token trades in: its launch pool, or for the affiliate's token, the
 *  iAI-kind pool on whose token side it sits. */
async function poolOf(config: McpConfig, token: Row, fetchImpl: FetchLike): Promise<Read<Row | undefined>> {
  const key = typeof token.launchedPoolKey === 'string' && token.launchedPoolKey ? token.launchedPoolKey : null;
  if (key) {
    const pools = await pages(config, 'InfinityPools', { id: { _eq: key } }, fetchImpl, 'id');
    return pools.ok ? { ok: true, value: pools.value.rows[0] } : pools;
  }
  const iai = await iaiMarket(config, fetchImpl);
  if (!iai.ok) return iai;
  return { ok: true, value: iai.value && iai.value.tokenAddress === String(token.address).toLowerCase() ? iai.value.pool : undefined };
}

/** A token by address, and the index's chain time as of that read. */
async function tokenByAddress(config: McpConfig, address: string, fetchImpl: FetchLike): Promise<Read<{ token: Row | undefined; through: number | null }>> {
  const found = await pages(config, 'InfinityTokens', { address: { _eq: address } }, fetchImpl, 'id');
  return found.ok ? { ok: true, value: { token: found.value.rows[0], through: found.value.through } } : found;
}

/** One token by address, or null when the index does not know it. */
export async function tokenDetail(config: McpConfig, address: string, fetchImpl: FetchLike) {
  const found = await tokenByAddress(config, address, fetchImpl);
  if (!found.ok) return found;
  const { token, through } = found.value;
  if (!token) return { ok: true as const, value: null };
  const pooled = await poolOf(config, token, fetchImpl);
  if (!pooled.ok) return pooled;
  const pool = pooled.value;
  const hours = await hoursFor(config, pool ? [String(pool.id)] : [], through, fetchImpl);
  if (!hours.ok) return hours;
  const summary = summarize(token, pool, hours.value === null ? null : pool ? hours.value.get(String(pool.id)) : undefined, through);
  const traded = summary.price_og !== null;
  return {
    ok: true as const,
    value: {
      ...summary,
      image_url: typeof token.image === 'string' && token.image ? token.image : null,
      verified: token.verified === true,
      trade_count: pool ? maybeCount(pool.tradeCount) : null,
      vol_total_og: traded ? units(pool!.executionQuoteVolume) : null,
      buy_vol_total_og: traded ? units(pool!.buyQuoteVolume) : null,
      sell_vol_total_og: traded ? units(pool!.sellQuoteVolume) : null,
      /* the list's own rule, said rather than applied: the address always reads */
      listed: hiddenReason(token, pool) === null,
    },
  };
}

export interface TradePrint {
  id: string;
  tx: string | null;
  ts: number | null;
  side: 'buy' | 'sell' | null;
  trader: string | null;
  token_amount: number | null;
  volume_og: number | null;
  price_og: number | null;
  spot_price_og: number | null;
}

/** One token's newest trades, newest first; null when the index does not know the token. */
export async function tokenTrades(config: McpConfig, address: string, limit: number, fetchImpl: FetchLike): Promise<Read<TradePrint[] | null>> {
  const found = await tokenByAddress(config, address, fetchImpl);
  if (!found.ok) return found;
  const { token } = found.value;
  if (!token) return { ok: true, value: null };
  const pooled = await poolOf(config, token, fetchImpl);
  if (!pooled.ok) return pooled;
  if (!pooled.value) return { ok: true, value: [] };
  const poolKey = String(pooled.value.id);
  const decimals = count(token.decimals) || 18;
  const trades = await newest(config, 'InfinityTrades', { poolKey: { _eq: poolKey } }, limit, fetchImpl);
  if (!trades.ok) return trades;
  return {
    ok: true,
    value: trades.value.map((trade) => ({
      id: String(trade.id),
      tx: typeof trade.transactionHash === 'string' ? trade.transactionHash : null,
      ts: seconds(trade.timestamp),
      /* the index's own flag; anything else stays null rather than defaulting to buy */
      side: trade.isBuy === true ? 'buy' : trade.isBuy === false ? 'sell' : null,
      trader: lower(trade.trader),
      token_amount: units(trade.executionTokenAmount, decimals),
      volume_og: units(trade.executionQuoteAmount),
      price_og: units(trade.effectivePriceX18),
      spot_price_og: units(trade.spotPriceX18),
    })),
  };
}

/** Search the same token/pool projection via the existing allowlisted $where input.
 * Wildcards are literal user text. The bounded matching window is disclosed. */
export async function searchTokens(config: McpConfig, query: string, limit: number, fetchImpl: FetchLike) {
  const pattern = '%' + query.trim().replace(/[\\%_]/g, '\\$&') + '%';
  const found = await pages(config, 'InfinityTokens', { _or: [
    { name: { _ilike: pattern } }, { symbol: { _ilike: pattern } }, { address: { _ilike: pattern } },
  ] }, fetchImpl, 'id');
  if (!found.ok) return found;
  const keys = found.value.rows.flatMap(r => typeof r.launchedPoolKey === 'string' ? [r.launchedPoolKey] : []);
  const [pools, iai] = await Promise.all([
    keys.length ? pages(config, 'InfinityPools', { id: { _in: keys } }, fetchImpl, 'id') : Promise.resolve(EMPTY),
    iaiMarket(config, fetchImpl),
  ]);
  if (!pools.ok) return pools;
  if (!iai.ok) return iai;
  if (!pools.value.complete) return { ok: false as const, outcome: 'window_overflow' as const };
  const byPool = new Map(pools.value.rows.map(r => [String(r.id), r]));
  const selected: Array<{ token: Row; pool: Row }> = [];
  let hidden = 0;
  for (const token of found.value.rows) {
    const pool = byPool.get(String(token.launchedPoolKey)) ?? (iai.value?.tokenAddress === lower(token.address) ? iai.value.pool : undefined);
    if (!pool) {
      if (token.launchedPoolKey) return { ok: false as const, outcome: 'bad_payload' as const };
      continue;
    }
    if (pool.kind === IAI_POOL_KIND && token.totalSupply == null) continue;
    if (hiddenReason(token, pool)) { hidden++; continue; }
    selected.push({ token, pool });
  }
  const through = pools.value.through ?? found.value.through;
  const needle = query.trim().toLowerCase();
  const rank = ({ token }: { token: Row }): number => {
    const symbol = visibleTicker(token.symbol)?.toLowerCase();
    const name = visibleName(token.name)?.toLowerCase();
    if (lower(token.address) === needle) return 0;
    if (symbol === needle) return 1;
    if (name === needle) return 2;
    if (symbol?.startsWith(needle)) return 3;
    if (name?.startsWith(needle)) return 4;
    return 5;
  };
  selected.sort((a, b) => {
    const relevance = rank(a) - rank(b);
    if (relevance) return relevance;
    // liquidity_og uses this 18-decimal reserve; compare raw units without rounding.
    const left = bigOrNull(a.pool.quoteInPool), right = bigOrNull(b.pool.quoteInPool);
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left > right ? -1 : 1;
  });
  const chosen = selected.slice(0, limit);
  const hours = await hoursFor(config, chosen.map(r => String(r.pool.id)), through, fetchImpl);
  if (!hours.ok) return hours;
  return { ok: true as const, value: {
    tokens: chosen.map(({ token, pool }) => summarize(token, pool, hours.value === null ? null : hours.value.get(String(pool.id)), through)),
    scanned: found.value.rows.length, matched: selected.length, hidden,
    complete: found.value.complete, truncated: !found.value.complete || selected.length > limit,
    basis: 'Indexer name/symbol/address substring filter; scanned matches ranked before limit by exact address, exact symbol, exact name, symbol prefix, name prefix, then other matches (case-insensitive); ties by liquidity_og descending, nulls last.',
  } };
}

/** Raw index identity for an RPC read. No market-number coercions at this boundary. */
export async function swapMarket(config: McpConfig, address: string, fetchImpl: FetchLike) {
  const found = await tokenByAddress(config, address, fetchImpl);
  if (!found.ok) return found;
  if (!found.value.token) return { ok: true as const, value: null };
  const pooled = await poolOf(config, found.value.token, fetchImpl);
  if (!pooled.ok) return pooled;
  return { ok: true as const, value: pooled.value ? { token: found.value.token, pool: pooled.value } : null };
}

/** Wallet discovery is a bounded token window, never an assertion of lifetime totals.
 * The first 100 ascending deployment:address ids are ordered by address, not launch time.
 * Bound wallets are verified by the splitter reader, not inferred from token.creator. */
export async function feeTokens(config: McpConfig, token: string | undefined, fetchImpl: FetchLike): Promise<Read<{
  rows: Array<{ token: string; poolId: string; decimals: number | null }>; complete: boolean; scanned: number; excluded: number;
  failed: Array<{ token: string; reason: string }>;
}>> {
  const found = await pages(config, 'InfinityTokens', token ? { address: { _eq: token } } : {}, fetchImpl, 'id', 1);
  if (!found.ok) return found;
  const keys = found.value.rows.flatMap(r => typeof r.launchedPoolKey === 'string' ? [r.launchedPoolKey] : []);
  const pools = keys.length ? await pages(config, 'InfinityPools', { id: { _in: keys } }, fetchImpl, 'id') : EMPTY;
  if (!pools.ok) return pools;
  if (!pools.value.complete) return { ok: false, outcome: 'window_overflow' };
  const byId = new Map(pools.value.rows.map(r => [String(r.id), r]));
  const rows = [];
  const failed = [];
  let excluded = 0;
  for (const row of found.value.rows) {
    if (!row.launchedPoolKey || row.origin === 'ADMITTED_POOL') { excluded++; continue; }
    const pool = byId.get(String(row.launchedPoolKey));
    if (typeof row.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(row.address)) return { ok: false, outcome: 'bad_payload' };
    if (!pool || typeof pool.poolId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(pool.poolId)) {
      if (token) return { ok: false, outcome: 'bad_payload' };
      failed.push({ token: row.address.toLowerCase(), reason: 'bad_payload' });
      continue;
    }
    if (pool.kind === IAI_POOL_KIND) { excluded++; continue; }
    rows.push({ token: row.address.toLowerCase(), poolId: pool.poolId.toLowerCase(),
      decimals: typeof row.decimals === 'number' && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 255 ? row.decimals : null });
  }
  return { ok: true, value: { rows, failed, complete: found.value.complete, scanned: found.value.rows.length, excluded } };
}
