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
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import {
  INIT_TOPIC,
  POOL_MANAGER,
  STATE_VIEW,
  STATE_VIEW_ABI,
  V3_FACTORY,
  V3_FACTORY_ABI,
  V3_FEE_TIERS,
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

export interface PoolPrice {
  /** Token price denominated in ETH (the pool's marginal price). */
  priceEth: number;
  /** Which venue the price came from. */
  venue: 'v4' | 'v3';
  /** Raw pool depth (uint128 L) — comparable only between pools of the same
   *  token, which is all we use it for (picking the deepest). */
  liquidity: bigint;
}

interface V4Pool {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  tokenIs0: boolean;
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
  private provider: JsonRpcProvider | null = null;
  private readonly v4Cache = new Map<string, { at: number; pools: V4Pool[] }>();
  private readonly v3Cache = new Map<string, { at: number; pools: string[] }>();
  private readonly decimals = new Map<string, number>();

  /** False when the chain RPC / WETH address isn't configured — the reader then
   *  no-ops rather than guessing, and the oracle reports the price as unknown. */
  get enabled(): boolean {
    return config.POOL_PRICE_FALLBACK && this.rpcUrl().length > 0 && config.SNIPER_WETH.length > 0;
  }

  private rpcUrl(): string {
    return config.CHAIN_HTTP_URL || '';
  }

  private rpc(): JsonRpcProvider {
    if (!this.provider) this.provider = new JsonRpcProvider(this.rpcUrl());
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

  /** Every live v3 pool address for the token/WETH pair across the fee tiers. */
  private async v3Pools(token: string): Promise<string[]> {
    const key = token.toLowerCase();
    const memo = this.v3Cache.get(key);
    if (memo && Date.now() - memo.at < POOL_CACHE_TTL_MS) return memo.pools;

    const factory = new Contract(V3_FACTORY, V3_FACTORY_ABI, this.rpc());
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const addresses = await Promise.all(
      V3_FEE_TIERS.map(async (fee) => {
        try {
          const pool = (await factory.getFunction('getPool')(t, weth, fee)) as string;
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
          return priceEth == null ? null : { priceEth, venue: 'v4', liquidity };
        } catch {
          return null;
        }
      }),
    );
    return reads.filter((r): r is PoolPrice => r != null);
  }

  private async readV3(token: string, decimals: number): Promise<PoolPrice[]> {
    const pools = await this.v3Pools(token);
    if (pools.length === 0) return [];
    const t = token.toLowerCase();
    const weth = config.SNIPER_WETH.toLowerCase();
    // v3 orders currencies by address, same as v4 — derive which side we are on.
    const tokenIs0 = t < weth;
    const reads = await Promise.all(
      pools.map(async (addr): Promise<PoolPrice | null> => {
        try {
          const pool = new Contract(addr, V3_POOL_ABI, this.rpc());
          const [slot0, liquidity] = await Promise.all([
            pool.getFunction('slot0')() as Promise<[bigint, ...unknown[]]>,
            pool.getFunction('liquidity')().catch(() => 0n) as Promise<bigint>,
          ]);
          const priceEth = priceEthFromSqrtX96(slot0[0], tokenIs0, decimals);
          return priceEth == null ? null : { priceEth, venue: 'v3', liquidity };
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
    return all.reduce((best, p) => (p.liquidity > best.liquidity ? p : best), all[0]!);
  }
}

function capMap(map: Map<string, unknown>, max = MAX_CACHE): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
