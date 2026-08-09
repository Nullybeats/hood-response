import {
  JsonRpcProvider,
  Contract,
  AbiCoder,
  keccak256,
  getAddress,
  dataSlice,
  zeroPadValue,
  ZeroAddress,
} from 'ethers';
import type { JsonRpcPayload, JsonRpcResult } from 'ethers';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { schedulerFor } from '../attrib/scheduler.js';
import {
  INIT_TOPIC,
  POOL_MANAGER,
  STATE_VIEW,
  STATE_VIEW_ABI,
  V3_FACTORY,
  V3_FACTORY_ABI,
  V3_FEE_TIERS,
  V3_POOL_CREATED_TOPIC,
  V3_POOL_ABI,
} from './uniswap.js';

/**
 * On-chain price of last resort.
 *
 * DexScreener does not index a pair the moment it is created — which is exactly
 * the window a sniper cares about. The oracle used to paper over that gap with a
 * SYNTHETIC price derived by hashing the token address, and that number then
 * flowed into market caps, alert gates and conviction as if it were real. ANOA
 * (2026-08-04) alerted eight times at a "$13.1M" cap that was literally
 * `hash(address) * 1e9`; its real cap was $2.6k, and the $25k alert floor that
 * should have suppressed it was cleared by the fiction.
 *
 * This module replaces the fiction with the truth: the pool. It reads the token's
 * ETH-paired Uniswap v4 and v3 pools directly, takes the marginal price from the
 * deepest one, and returns null when the token has no readable pool. Null means
 * unknown, and unknown must never be scored, gated, or displayed as a number.
 *
 * Read-only: no wallet, no sends. It runs on both deployments (the Railway feed
 * and the box), unlike the sniper's executor, which needs a signer.
 */

const abi = AbiCoder.defaultAbiCoder();
const Q96 = 2n ** 96n;

/** Pools change hands slowly relative to a price tick; the SET of pools a token
 *  has is what we cache, never the price read off them. Matches the executor's
 *  venue-cache reasoning: a pool created after first resolution (bonding-curve
 *  migration, a second fee tier opening) must not stay invisible forever. */
const POOL_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE = 5_000;

/**
 * Pool-price fallback is display/gating enrichment, never more important than
 * the live wallet scanner. Ethers normally sends directly through its provider,
 * which previously bypassed the shared RPC limiter and could flood the public
 * node with factory, state-view and historic Initialize queries. Disable ethers
 * batching so every HTTP request is charged to the same host bucket.
 */
class ScheduledJsonRpcProvider extends JsonRpcProvider {
  constructor(private readonly scheduledUrl: string) {
    super(scheduledUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
  }

  override async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    const sched = schedulerFor(this.scheduledUrl, {
      ratePerSec: config.PRICE_RPC_RPS,
      burst: Math.max(1, Math.ceil(config.PRICE_RPC_RPS)),
    });
    try {
      // Pool price and creation-time evidence are alert-critical. They outrank
      // attribution backfills but remain inside this small explicit budget.
      //
      // The deadline is what stops a burst from compounding. A quote is wanted
      // by a gate that gives up at `maxPendingMs`; one that surfaces from the
      // queue minutes later cannot be used by anybody, and dispatching it just
      // pushes the next live read further back. Expiring it returns the budget.
      return await sched.run(() => super._send(payload), 'normal', config.PRICE_RPC_DEADLINE_MS, 'pool-price');
    } catch (err) {
      // Ethers wraps HTTP failures. Preserve its error for callers, but make a
      // provider-level 429 cool the same shared bucket as every other caller.
      const status = (err as { info?: { response?: { statusCode?: number } } })?.info?.response?.statusCode;
      if (status === 429 || status === 503) sched.penalise(1_000);
      throw err;
    }
  }
}

export interface PoolPrice {
  /** Token price denominated in ETH (the pool's marginal price). */
  priceEth: number;
  /** Which venue the price came from. */
  venue: 'v4' | 'v3';
  /** Raw pool depth (uint128 L) — comparable only between pools of the same
   *  token, which is all we use it for (picking the deepest). */
  liquidity: bigint;
  /** Address for V3; PoolId for V4. */
  poolAddress: string;
  /** Unix ms when the canonical pool was initialized/created, when available.
   * This is chain evidence for fresh-pair gating; it is never inferred from an
   * indexer timestamp. */
  pairCreatedAt: number | null;
}

interface V4Pool {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  tokenIs0: boolean;
  createdBlock: number;
}

const poolIdOf = (p: V4Pool): string =>
  keccak256(
    abi.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks],
    ),
  );

/**
 * Convert a Uniswap sqrtPriceX96 into the token's price in ETH.
 *
 * sqrtPriceX96 encodes sqrt(price of currency1 per currency0) in Q64.96, in RAW
 * base units — so the decimal difference between the two sides has to be undone
 * or an 18-decimal token quoted against 18-decimal WETH is right by luck and
 * everything else is wrong by orders of magnitude.
 *
 * Pure and exported so the boundary math is unit-testable without a chain.
 */
export function priceEthFromSqrtX96(
  sqrtPriceX96: bigint,
  tokenIs0: boolean,
  tokenDecimals: number,
  ethDecimals = 18,
): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  // ratio = (sqrtPriceX96 / 2^96)^2 = raw currency1 per raw currency0.
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  if (!Number.isFinite(sqrt) || sqrt <= 0) return null;
  const rawRatio = sqrt * sqrt;
  if (!Number.isFinite(rawRatio) || rawRatio <= 0) return null;
  // Undo decimals: human currency1 per human currency0.
  const [d0, d1] = tokenIs0 ? [tokenDecimals, ethDecimals] : [ethDecimals, tokenDecimals];
  const ratio = rawRatio * 10 ** (d0 - d1);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  // currency0 priced in currency1. When the token is currency0 that ratio IS
  // the token's ETH price; otherwise it is ETH's token price, so invert.
  const price = tokenIs0 ? ratio : 1 / ratio;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export class PoolPriceReader {
  private provider: ScheduledJsonRpcProvider | null = null;
  private readonly v4Cache = new Map<string, { at: number; pools: V4Pool[] }>();
  private readonly v3Cache = new Map<string, { at: number; pools: string[] }>();
  private readonly decimals = new Map<string, number>();
  private readonly blockTimes = new Map<number, number | null>();
  private readonly v3CreatedAt = new Map<string, number | null>();

  /** False when the chain RPC / WETH address isn't configured — the reader then
   *  no-ops rather than guessing, and the oracle reports the price as unknown. */
  get enabled(): boolean {
    return config.POOL_PRICE_FALLBACK && this.rpcUrl().length > 0 && config.SNIPER_WETH.length > 0;
  }

  private rpcUrl(): string {
    return config.PRICE_RPC_URL || config.ATTRIB_RPC_URL || config.CHAIN_HTTP_URL || '';
  }

  private rpc(): ScheduledJsonRpcProvider {
    if (!this.provider) this.provider = new ScheduledJsonRpcProvider(this.rpcUrl());
    return this.provider;
  }

  private async tokenDecimals(token: string): Promise<number | null> {
    const key = token.toLowerCase();
    const memo = this.decimals.get(key);
    if (memo != null) return memo;
    try {
      const erc20 = new Contract(token, ['function decimals() view returns (uint8)'], this.rpc());
      const d = Number((await erc20.getFunction('decimals')()) as bigint);
      if (!Number.isInteger(d) || d < 0 || d > 36) return null;
      this.decimals.set(key, d);
      capMap(this.decimals);
      return d;
    } catch {
      return null;
    }
  }

  /** Every ETH-paired v4 pool for this token, from the PoolManager's Initialize
   *  events (definitive — every v4 pool emits its full PoolKey at creation). */
  private async v4Pools(token: string): Promise<V4Pool[]> {
    const key = token.toLowerCase();
    const memo = this.v4Cache.get(key);
    if (memo && Date.now() - memo.at < POOL_CACHE_TTL_MS) return memo.pools;

    const t = getAddress(token);
    const padded = zeroPadValue(t, 32);
    const weth = getAddress(config.SNIPER_WETH);
    const found: V4Pool[] = [];
    for (const topics of [
      [INIT_TOPIC, null, padded], // currency0 == token
      [INIT_TOPIC, null, null, padded], // currency1 == token
    ]) {
      let logs;
      try {
        logs = await this.rpc().getLogs({
          address: POOL_MANAGER,
          fromBlock: 0,
          toBlock: 'latest',
          topics,
        });
      } catch (err) {
        logger.debug({ token, err: String(err) }, 'poolPrice: Initialize getLogs failed');
        continue;
      }
      for (const log of logs) {
        try {
          const c0 = getAddress(dataSlice(log.topics[2]!, 12));
          const c1 = getAddress(dataSlice(log.topics[3]!, 12));
          const [fee, tickSpacing, hooks] = abi.decode(
            ['uint24', 'int24', 'address', 'uint160', 'int24'],
            log.data,
          ) as unknown as [bigint, bigint, string, bigint, bigint];
          const tokenIs0 = c0.toLowerCase() === t.toLowerCase();
          const other = tokenIs0 ? c1 : c0;
          // Only ETH/WETH-paired pools price the token in ETH in one hop.
          if (other !== weth && other !== ZeroAddress) continue;
          found.push({
            currency0: c0,
            currency1: c1,
            fee: Number(fee),
            tickSpacing: Number(tickSpacing),
            hooks: getAddress(hooks),
            tokenIs0,
            createdBlock: Number(log.blockNumber),
          });
        } catch {
          /* skip malformed log */
        }
      }
    }
    this.v4Cache.set(key, { at: Date.now(), pools: found });
    capMap(this.v4Cache);
    return found;
  }

  /** Every live v3 pool address for the token/quote pair across fee tiers. */
  private async v3Pools(token: string, quote = config.SNIPER_WETH): Promise<string[]> {
    const key = `${token.toLowerCase()}:${quote.toLowerCase()}`;
    const memo = this.v3Cache.get(key);
    if (memo && Date.now() - memo.at < POOL_CACHE_TTL_MS) return memo.pools;

    const factory = new Contract(V3_FACTORY, V3_FACTORY_ABI, this.rpc());
    const quoteAddress = getAddress(quote);
    const t = getAddress(token);
    const addresses = await Promise.all(
      V3_FEE_TIERS.map(async (fee) => {
        try {
          const pool = (await factory.getFunction('getPool')(t, quoteAddress, fee)) as string;
          return pool && pool !== ZeroAddress ? pool : null;
        } catch {
          return null;
        }
      }),
    );
    const pools = addresses.filter((a): a is string => a != null);
    this.v3Cache.set(key, { at: Date.now(), pools });
    capMap(this.v3Cache);
    return pools;
  }

  private async blockTime(blockNumber: number): Promise<number | null> {
    const memo = this.blockTimes.get(blockNumber);
    if (memo !== undefined) return memo;
    try {
      const block = await this.rpc().getBlock(blockNumber);
      const value = block?.timestamp != null ? Number(block.timestamp) * 1_000 : null;
      this.blockTimes.set(blockNumber, value);
      capMap(this.blockTimes);
      return value;
    } catch {
      this.blockTimes.set(blockNumber, null);
      capMap(this.blockTimes);
      return null;
    }
  }

  private async readV4(token: string, decimals: number): Promise<PoolPrice[]> {
    const pools = await this.v4Pools(token);
    if (pools.length === 0) return [];
    const sv = new Contract(STATE_VIEW, STATE_VIEW_ABI, this.rpc());
    const reads = await Promise.all(
      pools.map(async (p): Promise<PoolPrice | null> => {
        const id = poolIdOf(p);
        try {
          const [slot0, liquidity] = await Promise.all([
            sv.getFunction('getSlot0')(id) as Promise<[bigint, bigint, bigint, bigint]>,
            sv.getFunction('getLiquidity')(id).catch(() => 0n) as Promise<bigint>,
          ]);
          const priceEth = priceEthFromSqrtX96(slot0[0], p.tokenIs0, decimals);
          return priceEth == null
            ? null
            : {
                priceEth,
                venue: 'v4',
                liquidity,
                poolAddress: id,
                pairCreatedAt: await this.blockTime(p.createdBlock),
              };
        } catch {
          return null;
        }
      }),
    );
    return reads.filter((r): r is PoolPrice => r != null);
  }

  /** Resolve a V3 pool's factory event into a chain timestamp. The factory
   * event is canonical creation evidence; no indexer timestamp is involved. */
  private async v3PairCreatedAt(token: string, quote: string, poolAddress: string): Promise<number | null> {
    const key = poolAddress.toLowerCase();
    const cached = this.v3CreatedAt.get(key);
    if (cached !== undefined) return cached;
    try {
      const tokenAddress = getAddress(token);
      const quoteAddress = getAddress(quote);
      const [a, b] = tokenAddress.toLowerCase() < quoteAddress.toLowerCase()
        ? [tokenAddress, quoteAddress]
        : [quoteAddress, tokenAddress];
      const logs = await this.rpc().getLogs({
        address: V3_FACTORY,
        fromBlock: 0,
        toBlock: 'latest',
        topics: [V3_POOL_CREATED_TOPIC, zeroPadValue(a, 32), zeroPadValue(b, 32)],
      });
      const target = getAddress(poolAddress).toLowerCase();
      const match = logs.find((log) => {
        try {
          return getAddress(dataSlice(log.data, 44)).toLowerCase() === target;
        } catch {
          return false;
        }
      });
      const result = match ? await this.blockTime(Number(match.blockNumber)) : null;
      this.v3CreatedAt.set(key, result);
      capMap(this.v3CreatedAt);
      return result;
    } catch {
      this.v3CreatedAt.set(key, null);
      capMap(this.v3CreatedAt);
      return null;
    }
  }

  private async readV3(token: string, decimals: number, quote = config.SNIPER_WETH, quoteDecimals = 18): Promise<PoolPrice[]> {
    const pools = await this.v3Pools(token, quote);
    if (pools.length === 0) return [];
    const t = token.toLowerCase();
    const quoteAddress = quote.toLowerCase();
    // v3 orders currencies by address, same as v4 — derive which side we are on.
    const tokenIs0 = t < quoteAddress;
    const reads = await Promise.all(
      pools.map(async (addr): Promise<PoolPrice | null> => {
        try {
          const pool = new Contract(addr, V3_POOL_ABI, this.rpc());
          const [slot0, liquidity] = await Promise.all([
            pool.getFunction('slot0')() as Promise<[bigint, ...unknown[]]>,
            pool.getFunction('liquidity')().catch(() => 0n) as Promise<bigint>,
          ]);
          const priceEth = priceEthFromSqrtX96(slot0[0], tokenIs0, decimals, quoteDecimals);
          return priceEth == null
            ? null
            : { priceEth, venue: 'v3', liquidity, poolAddress: addr, pairCreatedAt: null };
        } catch {
          return null;
        }
      }),
    );
    return reads.filter((r): r is PoolPrice => r != null);
  }

  /**
   * The token's marginal price in ETH from its deepest ETH-paired pool, or null
   * when it has none we can read. Deliberately ranks on raw depth rather than a
   * quote: this is a DISPLAY/gating price, never a trade decision — the sniper
   * still routes by quoting every venue (see executor.pickBestQuote), which is
   * the only thing that can see a decoy pool's fee.
   */
  async priceEthOf(token: string): Promise<PoolPrice | null> {
    if (!this.enabled) return null;
    const decimals = await this.tokenDecimals(token);
    if (decimals == null) return null;
    const [v4, v3] = await Promise.all([
      this.readV4(token, decimals).catch(() => [] as PoolPrice[]),
      this.readV3(token, decimals).catch(() => [] as PoolPrice[]),
    ]);
    const all = [...v4, ...v3];
    if (all.length === 0) return null;
    const best = all.reduce((winner, p) => (p.liquidity > winner.liquidity ? p : winner), all[0]!);
    if (best.venue !== 'v3') return best;
    return {
      ...best,
      pairCreatedAt: await this.v3PairCreatedAt(token, config.SNIPER_WETH, best.poolAddress),
    };
  }

  /** Canonical on-chain ETH/USD reference from Robinhood Chain's WETH/USDG market. */
  async ethUsdFromUsdG(): Promise<number | null> {
    if (!this.enabled || !config.PRICE_USD_QUOTE) return null;
    try {
      const weth = getAddress(config.SNIPER_WETH);
      const usdg = getAddress(config.PRICE_USD_QUOTE);
      const [wethDecimals, usdgDecimals] = await Promise.all([
        this.tokenDecimals(weth),
        this.tokenDecimals(usdg),
      ]);
      if (wethDecimals == null || usdgDecimals == null) return null;
      const quotes = await this.readV3(weth, wethDecimals, usdg, usdgDecimals);
      if (!quotes.length) return null;
      const best = quotes.reduce((winner, q) => (q.liquidity > winner.liquidity ? q : winner), quotes[0]!);
      return Number.isFinite(best.priceEth) && best.priceEth > 0 ? best.priceEth : null;
    } catch {
      return null;
    }
  }
}

function capMap(map: Map<unknown, unknown>, max = MAX_CACHE): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
