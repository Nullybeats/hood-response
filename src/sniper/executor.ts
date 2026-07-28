import {
  JsonRpcProvider,
  Wallet,
  Contract,
  AbiCoder,
  keccak256,
  parseEther,
  formatEther,
  formatUnits,
  getAddress,
  dataSlice,
  zeroPadValue,
  concat,
  ZeroAddress,
  MaxUint256,
} from 'ethers';
import { config } from '../config/env.js';
import { logger } from '../logger.js';

// ── Robinhood Chain Uniswap-v4 constants (verified from official + Bags docs) ──
// The UniversalRouter is Robinhood's MODIFIED fork: its v4 swap struct carries
// an extra `minHopPriceX36` field (always 0), so stock Uniswap SDK calldata
// reverts. Pool params VARY per token, so the executor resolves each token's
// real PoolKey on-chain instead of assuming one shape.
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
// PoolManager.Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
// topics: [sig, id, currency0, currency1]; data: fee,tickSpacing,hooks,sqrtPriceX96,tick
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BAGS_HOOK = '0x2380aBf72C17aABAb76480244759AC7E2932EEcC';
// Documented in Bags' own docs: "Singleton Uniswap v4 hook; takes the 2%
// post-migration fee." Applies on EVERY swap through a Bags-launched pool —
// buy and sell both — separate from gas and from any ERC-20-level tax GoPlus
// can see (this fee lives in the pool's hook contract, not the token).
const BAGS_HOOK_FEE_PCT = 2;
const DYNAMIC_FEE = 0x800000;
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // UR: the router itself

// UniversalRouter command bytes
const CMD_WRAP_ETH = '0x0b';
const CMD_UNWRAP_WETH = '0x0c';
const CMD_V4_SWAP = '0x10';
// v4 action bytes
const ACT_SWAP_EXACT_IN_SINGLE = '06';
const ACT_SETTLE_ALL = '0c';
const ACT_TAKE_ALL = '0f';

const ROUTER_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
// V4Quoter.quoteExactInputSingle takes ONE struct arg.
const QUOTER_ABI = [
  'function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes) params) returns (uint256 amountOut, uint256 gasEstimate)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const PERMIT2_ABI = [
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];
// v4-periphery: PositionManager keeps a poolId(first 25 bytes) -> PoolKey map.
const POSM_ABI = [
  'function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
];
const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

// ── Uniswap V3 (genuine, unmodified Uniswap deployment) ────────────────────────
// Some tokens' real liquidity lives on V3, not V4 — V4-only routing can silently
// resolve a near-empty V4 pool (see PRICE_SANITY_MULTIPLE below) while missing
// the actual deep pool entirely. These three addresses are verified on-chain,
// not assumed: the factory is read directly from a known-liquid V3 pool's own
// factory() getter; the router/quoter are matched by calling factory() /
// WETH9() on every "SwapRouter02"/"QuoterV2" contract on this chain and keeping
// only the one whose factory() equals that same address (this chain has many
// unrelated token-specific clones of both names, so name matching alone is not
// safe) — then cross-checked by confirming Factory.getPool() for a known pool
// returns that pool's real address, and the quote it gives is in the right
// ballpark of the token's live DexScreener price.
const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const V3_ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2'; // SwapRouter02
const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7'; // QuoterV2
const V3_FEE_TIERS = [500, 3000, 10000, 100]; // 0.05% / 0.3% / 1% / 0.01%

const V3_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
const V3_POOL_ABI = ['function liquidity() view returns (uint128)'];
const V3_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const V3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
];

export interface BuyResult {
  txHash: string;
  tokensReceived: number;
  ethSpent: number;
  /** Real network fee paid for this tx (gasUsed × effective gas price), ETH. */
  gasEth: number;
  /** Tokens the pre-trade quote promised — realized vs this = entry slippage. */
  quotedTokens: number;
  /** Which venue actually executed the fill. */
  venue: 'v4' | 'v3';
}
export interface SellResult {
  txHash: string;
  /** ACTUAL ETH the wallet received (native balance delta + gas), not the quote. */
  ethReceived: number;
  /** ETH the pre-trade quote promised — actual vs this = exit slippage. */
  quotedEthOut: number;
  tokensSold: number;
  gasEth: number;
  venue: 'v4' | 'v3';
}

/** Round-trip preview: buy `ethIn`, immediately sell the tokens back. `lossPct`
 *  is the true floor cost of a trade at this size — price impact both ways + LP
 *  fees + any hook/protocol tax — the single number the entry gate keys on. */
export interface RoundTrip {
  venue: 'v4' | 'v3';
  ethIn: number;
  quotedTokens: number;
  ethBack: number;
  lossPct: number;
  /** Raw on-chain pool liquidity (uint128 L) at preview time, as a relative depth proxy. */
  poolLiquidity: number | null;
}

/** gasUsed × effective gas price, in ETH — the real network fee for a tx. */
function gasCostEth(receipt: { gasUsed: bigint; gasPrice: bigint }): number {
  return Number(formatEther(receipt.gasUsed * receipt.gasPrice));
}

/** A token's resolved v4 pool: the exact key plus which side the token is. */
interface ResolvedPool {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  /** The pool's quote side (what ETH enters as): WETH or native (0x0). */
  ethCurrency: string;
  /** True when the token is currency0. */
  tokenIs0: boolean;
}

const abi = AbiCoder.defaultAbiCoder();

/** Trim an ethers/RPC error down to a short, human reason for the decision log. */
function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return (e.shortMessage || e.reason || e.message || String(err)).slice(0, 90);
}

/** How far the quoted price may diverge from the alert's known market price
 *  before a buy is refused outright. A token can have several ETH-paired
 *  pools — fee-tier variants, or a near-empty pool created moments before a
 *  snipe specifically to trap bots that trade whatever pool they resolve —
 *  and quoting/executing against the wrong one can silently cost 90%+ of the
 *  trade's value even though nothing "reverted". This catches that regardless
 *  of which pool ends up resolved. */
export const PRICE_SANITY_MULTIPLE = 3;

/** Null when the quote is within tolerance of the expected market price;
 *  otherwise a human-readable reason to refuse the trade. Pulled out as a pure
 *  function so the exact boundary math is unit-testable without ethers. Used
 *  for both buys (quote too expensive) and sells (quote pays out too little)
 *  — the same "this pool is bad" signal either direction. */
export function checkPriceSanity(
  quotedPriceEth: number,
  expectedPriceEth: number,
  maxMultiple: number = PRICE_SANITY_MULTIPLE,
  action: 'buy' | 'sell' = 'buy',
): string | null {
  const ratio = quotedPriceEth / expectedPriceEth;
  if (ratio <= maxMultiple && ratio >= 1 / maxMultiple) return null;
  const off = ratio >= 1 ? `${ratio.toFixed(1)}x higher` : `${(1 / ratio).toFixed(1)}x lower`;
  return `quoted price is ${off} than market — refusing ${action} (likely a bad/decoy pool)`;
}

const keyTuple = (p: ResolvedPool) =>
  [p.currency0, p.currency1, p.fee, p.tickSpacing, p.hooks] as const;

const poolIdOf = (p: ResolvedPool): string =>
  keccak256(
    abi.encode(['address', 'address', 'uint24', 'int24', 'address'], [...keyTuple(p)]),
  );

/**
 * Executes ETH↔token swaps on Robinhood Chain. Tries the modified v4
 * UniversalRouter first (each token's PoolKey RESOLVED on-chain — DexScreener
 * pool id → PositionManager registry, else candidate probing via StateView —
 * so we trade the pool that actually exists instead of assuming its
 * parameters). Some tokens' real liquidity lives on plain Uniswap V3 instead;
 * when v4 has no pool, or the best pool it finds prices wildly off the token's
 * known market price (see PRICE_SANITY_MULTIPLE), falls back to v3 rather
 * than execute into — or get stuck unable to exit — a bad v4 pool.
 */
export class SwapExecutor {
  private provider: JsonRpcProvider | null = null;
  private wallet: Wallet | null = null;
  private runtimeKey: string | null = null;
  private readonly pools = new Map<string, ResolvedPool>();
  /** token → its best v3 fee tier, or null when no v3 pool exists at all. */
  private readonly v3Pools = new Map<string, { fee: number } | null>();

  private key(): string {
    return this.runtimeKey ?? config.SNIPER_PRIVATE_KEY;
  }

  get ready(): boolean {
    return this.key().length > 0 && config.SNIPER_ROUTER.length > 0 && config.SNIPER_WETH.length > 0;
  }

  /** Set the hot-wallet key at runtime (from the dashboard). Not persisted. */
  setPrivateKey(pk: string): string {
    const clean = pk.trim();
    const w = new Wallet(clean); // throws on a bad key
    this.runtimeKey = clean;
    this.wallet = null; // force rebuild with the new key
    return w.address;
  }

  private init(): void {
    if (this.wallet || !this.ready) return;
    const rpc = config.CHAIN_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
    this.provider = new JsonRpcProvider(rpc);
    this.wallet = new Wallet(this.key(), this.provider);
  }

  address(): string | null {
    this.init();
    return this.wallet?.address ?? null;
  }

  async balanceEth(): Promise<number | null> {
    this.init();
    if (!this.wallet || !this.provider) return null;
    try {
      return Number(formatEther(await this.provider.getBalance(this.wallet.address)));
    } catch {
      return null;
    }
  }

  // ── Pool discovery ──────────────────────────────────────────────────────────

  /** Resolve a pool from the PoolManager's Initialize event (the definitive
   *  source — every v4 pool emits its full PoolKey at creation). Prefers a pool
   *  paired with WETH or native ETH when a token has several. */
  private async resolveFromInitEvent(token: string): Promise<ResolvedPool | null> {
    if (!this.provider) return null;
    const t = getAddress(token);
    const padded = zeroPadValue(t, 32);
    const weth = getAddress(config.SNIPER_WETH);
    const base = { address: POOL_MANAGER, fromBlock: 0, toBlock: 'latest' as const };
    const found: ResolvedPool[] = [];
    for (const topics of [
      [INIT_TOPIC, null, padded], // currency0 == token
      [INIT_TOPIC, null, null, padded], // currency1 == token
    ]) {
      let logs;
      try {
        logs = await this.provider.getLogs({ ...base, topics });
      } catch (err) {
        logger.debug({ token, err: String(err) }, 'sniper: Initialize getLogs failed');
        continue;
      }
      for (const log of logs) {
        try {
          const c0 = getAddress(dataSlice(log.topics[2]!, 12));
          const c1 = getAddress(dataSlice(log.topics[3]!, 12));
          const decoded = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], log.data);
          const fee = decoded[0] as bigint;
          const tickSpacing = decoded[1] as bigint;
          const hooks = decoded[2] as string;
          const tokenIs0 = c0.toLowerCase() === t.toLowerCase();
          found.push({
            currency0: c0,
            currency1: c1,
            fee: Number(fee),
            tickSpacing: Number(tickSpacing),
            hooks: getAddress(hooks),
            ethCurrency: tokenIs0 ? c1 : c0,
            tokenIs0,
          });
        } catch {
          /* skip malformed log */
        }
      }
    }
    if (found.length === 0) return null;
    // Only ETH/WETH-paired pools are buyable with a single-hop ETH swap.
    const ethPaired = found.filter((p) => p.ethCurrency === weth || p.ethCurrency === ZeroAddress);
    if (ethPaired.length === 0) {
      throw new Error(
        `token has a pool but it's not ETH/WETH-paired (vs ${found[0]!.ethCurrency.slice(0, 10)}…) — can't buy with ETH`,
      );
    }
    // A token can have several ETH-paired pools (fee-tier variants, or — seen
    // in the wild — near-empty decoy pools created after the real one). The
    // most-recently-initialized pool is NOT a reliable proxy for "the real
    // one": pick by actual on-chain liquidity instead, so a fresh junk pool
    // can never outrank the pool that's actually being traded.
    const pick = await this.deepestPool(ethPaired);
    logger.info(
      { token, pool: { fee: pick.fee, tickSpacing: pick.tickSpacing, hooks: pick.hooks, eth: pick.ethCurrency }, pools: found.length, candidates: ethPaired.length },
      'sniper: pool resolved from Initialize event',
    );
    return pick;
  }

  /** Pick the candidate with the most on-chain liquidity right now (0 for any
   *  that fail to read). Falls back to the last candidate only if every read
   *  fails or ties at zero, so a single flaky RPC call can't wrongly demote
   *  the real pool. */
  private async deepestPool(candidates: ResolvedPool[]): Promise<ResolvedPool> {
    if (candidates.length === 1) return candidates[0]!;
    const sv = new Contract(STATE_VIEW, STATE_VIEW_ABI, this.provider!);
    const liquidity = await Promise.all(
      candidates.map(async (p) => {
        try {
          return (await sv.getFunction('getLiquidity')(poolIdOf(p))) as bigint;
        } catch {
          return 0n;
        }
      }),
    );
    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (liquidity[i]! > liquidity[best]!) best = i;
    }
    return liquidity[best]! > 0n ? candidates[best]! : candidates[candidates.length - 1]!;
  }

  private buildPool(token: string, eth: string, fee: number, tickSpacing: number, hooks: string): ResolvedPool {
    const t = getAddress(token);
    const c0 = eth.toLowerCase() < t.toLowerCase() ? eth : t;
    const c1 = c0 === t ? eth : t;
    return { currency0: c0, currency1: c1, fee, tickSpacing, hooks, ethCurrency: eth, tokenIs0: c0 === t };
  }

  /** Raw on-chain liquidity (uint128 L) for a resolved v4 pool; 0n on failure. */
  private async readLiquidity(p: ResolvedPool): Promise<bigint> {
    try {
      const sv = new Contract(STATE_VIEW, STATE_VIEW_ABI, this.provider!);
      return (await sv.getFunction('getLiquidity')(poolIdOf(p))) as bigint;
    } catch {
      return 0n;
    }
  }

  /**
   * Round-trip preview: quote buying `ethAmount` of `token`, then quote selling
   * those exact tokens straight back. The gap is the true floor cost of a trade
   * at THIS size — price impact both directions + LP fees + hook/protocol tax —
   * captured before a single wei is spent. This is the entry gate's key signal
   * and also the entry-slippage baseline recorded in the trade journal. Returns
   * null only when neither venue can quote (caller decides how to treat that).
   */
  async previewRoundTrip(
    token: string,
    ethAmount: number,
    poolIdHint?: string | null,
  ): Promise<RoundTrip | null> {
    this.init();
    if (!this.wallet) return null;
    const amountIn = parseEther(ethAmount.toString());
    // v4 first (the venue we'll almost always trade), then v3 fallback.
    try {
      const pool = await this.resolvePool(token, poolIdHint);
      const tokensOut = await this.quoteOut(pool, amountIn, true);
      if (tokensOut <= 0n) throw new Error('zero buy quote');
      const ethBackWei = await this.quoteOut(pool, tokensOut, false);
      const liq = await this.readLiquidity(pool);
      const ethIn = Number(formatEther(amountIn));
      const ethBack = Number(formatEther(ethBackWei));
      return {
        venue: 'v4',
        ethIn,
        quotedTokens: Number(tokensOut),
        ethBack,
        lossPct: ethIn > 0 ? (1 - ethBack / ethIn) * 100 : 100,
        poolLiquidity: liq > 0n ? Number(liq) : null,
      };
    } catch {
      const v3 = await this.resolveV3Pool(token).catch(() => null);
      if (!v3) return null;
      try {
        const weth = getAddress(config.SNIPER_WETH);
        const t = getAddress(token);
        const tokensOut = await this.quoteV3(weth, t, v3.fee, amountIn);
        if (tokensOut <= 0n) return null;
        const ethBackWei = await this.quoteV3(t, weth, v3.fee, tokensOut);
        const ethIn = Number(formatEther(amountIn));
        const ethBack = Number(formatEther(ethBackWei));
        return {
          venue: 'v3',
          ethIn,
          quotedTokens: Number(tokensOut),
          ethBack,
          lossPct: ethIn > 0 ? (1 - ethBack / ethIn) * 100 : 100,
          poolLiquidity: null,
        };
      } catch {
        return null;
      }
    }
  }

  /** True when this pool id is initialized on the PoolManager. */
  private async poolLive(p: ResolvedPool): Promise<boolean> {
    try {
      const sv = new Contract(STATE_VIEW, STATE_VIEW_ABI, this.provider!);
      const [sqrtPrice] = (await sv.getFunction('getSlot0')(poolIdOf(p))) as [bigint];
      return sqrtPrice > 0n;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the token's actual pool. Order:
   *  1. `poolIdHint` (DexScreener's v4 pair id) → PositionManager.poolKeys —
   *     exact key, zero guessing.
   *  2. Probe likely candidates (WETH or native × Bags-dynamic or standard
   *     static fee tiers) against StateView until one is initialized.
   */
  /** Which hook (if any) governs this token's pool, and the documented % fee
   *  it takes per swap — so the UI can show the real protocol fee alongside
   *  gas and token tax, not just guess at where value went. */
  async protocolFeeInfo(
    token: string,
    poolIdHint?: string | null,
  ): Promise<{ hook: string; feePctPerSwap: number | null }> {
    try {
      const pool = await this.resolvePool(token, poolIdHint);
      const isBags = pool.hooks.toLowerCase() === BAGS_HOOK.toLowerCase();
      return { hook: pool.hooks, feePctPerSwap: isBags ? BAGS_HOOK_FEE_PCT : null };
    } catch (v4Err) {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw v4Err;
      return { hook: 'uniswap-v3', feePctPerSwap: null };
    }
  }

  private async resolvePool(token: string, poolIdHint?: string | null): Promise<ResolvedPool> {
    const cached = this.pools.get(token.toLowerCase());
    if (cached) return cached;

    // 1) Authoritative: the PoolManager's Initialize event carries the full
    // PoolKey for every pool ever created — works for Bags pools that never
    // touch the PositionManager registry.
    const fromEvent = await this.resolveFromInitEvent(token);
    if (fromEvent) {
      this.pools.set(token.toLowerCase(), fromEvent);
      return fromEvent;
    }

    // 2) Exact lookup from the on-chain registry via the DexScreener pool id.
    if (poolIdHint && /^0x[0-9a-fA-F]{64}$/.test(poolIdHint)) {
      try {
        const posm = new Contract(POSITION_MANAGER, POSM_ABI, this.provider!);
        const res = (await posm.getFunction('poolKeys')(dataSlice(poolIdHint, 0, 25))) as [
          string, string, bigint, bigint, string,
        ];
        const [c0, c1, fee, tickSpacing, hooks] = res;
        const t = getAddress(token);
        if (getAddress(c0) === t || getAddress(c1) === t) {
          const eth = getAddress(c0) === t ? getAddress(c1) : getAddress(c0);
          const pool: ResolvedPool = {
            currency0: getAddress(c0),
            currency1: getAddress(c1),
            fee: Number(fee),
            tickSpacing: Number(tickSpacing),
            hooks: getAddress(hooks),
            ethCurrency: eth,
            tokenIs0: getAddress(c0) === t,
          };
          this.pools.set(token.toLowerCase(), pool);
          logger.info({ token, pool: { fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks, eth } }, 'sniper: pool resolved from registry');
          return pool;
        }
      } catch (err) {
        logger.debug({ token, err: String(err) }, 'sniper: registry lookup failed, probing candidates');
      }
    }

    // 2) Candidate probing.
    const weth = getAddress(config.SNIPER_WETH);
    const candidates: [string, number, number, string][] = [
      [weth, DYNAMIC_FEE, 50, BAGS_HOOK],
      [ZeroAddress, DYNAMIC_FEE, 50, BAGS_HOOK],
      [weth, 3000, 60, ZeroAddress],
      [ZeroAddress, 3000, 60, ZeroAddress],
      [weth, 10000, 200, ZeroAddress],
      [ZeroAddress, 10000, 200, ZeroAddress],
      [weth, 500, 10, ZeroAddress],
    ];
    for (const [eth, fee, ts, hooks] of candidates) {
      const pool = this.buildPool(token, eth, fee, ts, hooks);
      if (await this.poolLive(pool)) {
        this.pools.set(token.toLowerCase(), pool);
        logger.info({ token, pool: { fee, tickSpacing: ts, hooks, eth } }, 'sniper: pool resolved by probing');
        return pool;
      }
    }
    throw new Error('no initialized v4 pool found for this token');
  }

  /** Find the token's deepest ETH-paired v3 pool across the standard fee
   *  tiers (by actual on-chain liquidity, same reasoning as deepestPool for
   *  v4), or null if it has none. Cached for the process lifetime like v4. */
  private async resolveV3Pool(token: string): Promise<{ fee: number } | null> {
    const key = token.toLowerCase();
    if (this.v3Pools.has(key)) return this.v3Pools.get(key)!;
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const factory = new Contract(V3_FACTORY, V3_FACTORY_ABI, this.provider!);
    let best: { fee: number; liquidity: bigint } | null = null;
    for (const fee of V3_FEE_TIERS) {
      try {
        const poolAddr = (await factory.getFunction('getPool')(t, weth, fee)) as string;
        if (!poolAddr || poolAddr === ZeroAddress) continue;
        const poolContract = new Contract(poolAddr, V3_POOL_ABI, this.provider!);
        const liq = (await poolContract.getFunction('liquidity')()) as bigint;
        if (liq > 0n && (!best || liq > best.liquidity)) best = { fee, liquidity: liq };
      } catch {
        /* this fee tier's pool doesn't exist or isn't readable — skip */
      }
    }
    const result = best ? { fee: best.fee } : null;
    this.v3Pools.set(key, result);
    if (result) logger.info({ token, fee: result.fee }, 'sniper: v3 pool resolved');
    return result;
  }

  /** V3 quote via QuoterV2 (not view — must be staticCall'd, same as v4's quoter). */
  private async quoteV3(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<bigint> {
    const quoter = new Contract(V3_QUOTER, V3_QUOTER_ABI, this.wallet!);
    const fn = (quoter.getFunction('quoteExactInputSingle') as unknown as {
      staticCall: (params: unknown) => Promise<[bigint, bigint, number, bigint]>;
    }).staticCall;
    const [amountOut] = await fn([tokenIn, tokenOut, amountIn, fee, 0n]);
    return amountOut;
  }

  /** Standard ERC-20 approve (v3's SwapRouter02 pulls via transferFrom, not
   *  Permit2) — approve once for max so repeat sells don't re-approve. */
  private async ensureErc20Approval(token: string, spender: string, amount: bigint): Promise<void> {
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const allowance = (await token20.getFunction('allowance')(this.wallet!.address, spender)) as bigint;
    if (allowance < amount) {
      await (await token20.getFunction('approve')(spender, MaxUint256)).wait(1);
    }
  }

  // ── Quotes ──────────────────────────────────────────────────────────────────

  /** Quote amount-out for an exact amount-in. `ethIn` = ETH→token direction. */
  private async quoteOut(pool: ResolvedPool, amountIn: bigint, ethIn: boolean): Promise<bigint> {
    const zeroForOne = ethIn ? !pool.tokenIs0 : pool.tokenIs0;
    const quoter = new Contract(V4_QUOTER, QUOTER_ABI, this.wallet!);
    const fn = (quoter.getFunction('quoteExactInputSingle') as unknown as {
      staticCall: (params: unknown) => Promise<[bigint, bigint]>;
    }).staticCall;
    const [amountOut] = await fn([keyTuple(pool), zeroForOne, amountIn, '0x']);
    return amountOut;
  }

  private minOut(quoted: bigint, slippagePct: number = config.SNIPER_SLIPPAGE_PCT): bigint {
    const bps = BigInt(Math.round((100 - slippagePct) * 100));
    return (quoted * bps) / 10_000n;
  }

  /** Encode the modified v4 SWAP_EXACT_IN_SINGLE params (extra minHopPriceX36). */
  private encodeSwapParams(pool: ResolvedPool, zeroForOne: boolean, amountIn: bigint, amountOutMin: bigint): string {
    return abi.encode(
      ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'uint256', 'bytes'],
      [[...keyTuple(pool)], zeroForOne, amountIn, amountOutMin, 0n, '0x'],
    );
  }

  // ── Trades ──────────────────────────────────────────────────────────────────

  /** Buy `ethAmount` ETH worth of `token`. Tries v4 first; if v4 has no pool,
   *  or the best one it finds prices wildly off `expectedPriceEth` (the
   *  alert's own known market price), falls back to v3 rather than execute
   *  into — or simply fail on — a bad v4 pool. No ETH is spent on a v4 attempt
   *  that gets refused before broadcasting; a v4 attempt that reverts
   *  on-chain does spend gas before the v3 fallback runs. */
  async buy(
    token: string,
    ethAmount: number,
    poolIdHint?: string | null,
    expectedPriceEth?: number | null,
  ): Promise<BuyResult> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    try {
      return await this.buyV4(token, ethAmount, poolIdHint, expectedPriceEth);
    } catch (v4Err) {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw v4Err;
      logger.warn({ token, v4Err: shortErr(v4Err), fee: v3.fee }, 'sniper: v4 buy unavailable, trying v3');
      return await this.buyV3(token, ethAmount, expectedPriceEth, v3.fee);
    }
  }

  private async buyV4(
    token: string,
    ethAmount: number,
    poolIdHint: string | null | undefined,
    expectedPriceEth: number | null | undefined,
  ): Promise<BuyResult> {
    const pool = await this.resolvePool(token, poolIdHint);
    const amountIn = parseEther(ethAmount.toString());
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);

    let quoted: bigint;
    try {
      quoted = await this.quoteOut(pool, amountIn, true);
    } catch (err) {
      throw new Error(`quote reverted (${shortErr(err)})`);
    }
    if (quoted <= 0n) throw new Error('no route (zero quote)');

    if (expectedPriceEth != null && expectedPriceEth > 0) {
      const quotedPriceEth = Number(formatEther(amountIn)) / Number(formatUnits(quoted, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'buy');
      if (sanityErr) throw new Error(sanityErr);
    }

    const amountOutMin = this.minOut(quoted);
    const zeroForOne = !pool.tokenIs0; // ETH side → token

    const actions = '0x' + ACT_SWAP_EXACT_IN_SINGLE + ACT_SETTLE_ALL + ACT_TAKE_ALL;
    const params = [
      this.encodeSwapParams(pool, zeroForOne, amountIn, amountOutMin),
      abi.encode(['address', 'uint256'], [pool.ethCurrency, amountIn]), // SETTLE_ALL(eth side)
      abi.encode(['address', 'uint256'], [getAddress(token), amountOutMin]), // TAKE_ALL(token)
    ];
    const v4Input = abi.encode(['bytes', 'bytes[]'], [actions, params]);

    // WETH pools: wrap the sent ETH inside the router first. Native pools: the
    // router settles native directly from msg.value.
    const nativePool = pool.ethCurrency === ZeroAddress;
    const commands = nativePool ? CMD_V4_SWAP : concat([CMD_WRAP_ETH, CMD_V4_SWAP]);
    const inputs = nativePool
      ? [v4Input]
      : [abi.encode(['address', 'uint256'], [ADDRESS_THIS, amountIn]), v4Input];

    const before = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;

    const router = new Contract(config.SNIPER_ROUTER, ROUTER_ABI, this.wallet!);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    let tx;
    try {
      tx = await router.getFunction('execute')(commands, inputs, deadline, { value: amountIn });
    } catch (err) {
      throw new Error(`swap reverted (${shortErr(err)})`);
    }
    logger.info({ token, ethAmount, tx: tx.hash, venue: 'v4' }, 'sniper: buy sent');
    const receipt = await tx.wait(1);

    let tokensReceived = 0;
    try {
      const after = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
      tokensReceived = Number(formatUnits(after - before, decimals));
    } catch {
      /* balance read failed — tx still landed */
    }
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      tokensReceived,
      ethSpent: ethAmount,
      gasEth,
      quotedTokens: Number(formatUnits(quoted, decimals)),
      venue: 'v4',
    };
  }

  private async buyV3(
    token: string,
    ethAmount: number,
    expectedPriceEth: number | null | undefined,
    fee: number,
  ): Promise<BuyResult> {
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const amountIn = parseEther(ethAmount.toString());
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);

    let quoted: bigint;
    try {
      quoted = await this.quoteV3(weth, t, fee, amountIn);
    } catch (err) {
      throw new Error(`v3 quote reverted (${shortErr(err)})`);
    }
    if (quoted <= 0n) throw new Error('no v3 route (zero quote)');

    if (expectedPriceEth != null && expectedPriceEth > 0) {
      const quotedPriceEth = Number(formatEther(amountIn)) / Number(formatUnits(quoted, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'buy');
      if (sanityErr) throw new Error(`v3: ${sanityErr}`);
    }

    const amountOutMin = this.minOut(quoted);
    const router = new Contract(V3_ROUTER, V3_ROUTER_ABI, this.wallet!);
    const params = [weth, t, fee, this.wallet!.address, amountIn, amountOutMin, 0n];

    const before = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    let tx;
    try {
      tx = await router.getFunction('exactInputSingle')(params, { value: amountIn });
    } catch (err) {
      throw new Error(`v3 swap reverted (${shortErr(err)})`);
    }
    logger.info({ token, ethAmount, tx: tx.hash, venue: 'v3', fee }, 'sniper: buy sent');
    const receipt = await tx.wait(1);

    let tokensReceived = 0;
    try {
      const after = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
      tokensReceived = Number(formatUnits(after - before, decimals));
    } catch {
      /* balance read failed — tx still landed */
    }
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      tokensReceived,
      ethSpent: ethAmount,
      gasEth,
      quotedTokens: Number(formatUnits(quoted, decimals)),
      venue: 'v3',
    };
  }

  /** Read the token's real symbol + total supply straight from the contract —
   *  used so an imported/recovered position shows its actual name, not a
   *  placeholder. */
  async tokenMeta(token: string): Promise<{ symbol: string; totalSupply: number }> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    const token20 = new Contract(token, ERC20_ABI, this.wallet);
    const [symbol, decimals, supply] = await Promise.all([
      token20.getFunction('symbol')() as Promise<string>,
      token20.getFunction('decimals')() as Promise<bigint>,
      token20.getFunction('totalSupply')() as Promise<bigint>,
    ]);
    return { symbol, totalSupply: Number(formatUnits(supply, Number(decimals))) };
  }

  /**
   * Read the REAL ETH spent and tokens received from an actual on-chain buy
   * transaction — used to restore a position with its true cost basis instead
   * of a re-valued guess. ethSpent comes straight from the tx's `value` field
   * (the router receives ETH as msg.value); tokensReceived comes from the
   * ERC-20 Transfer log paying the wallet, decoded with the token's decimals.
   */
  async readBuyTx(
    token: string,
    txHash: string,
  ): Promise<{ ethSpent: number; tokensReceived: number; blockTimestamp: number; gasEth: number }> {
    this.init();
    if (!this.wallet || !this.provider) throw new Error('sniper wallet not configured');
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) throw new Error('transaction not found on this chain');
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error('transaction receipt not found');
    if (receipt.status !== 1) throw new Error('transaction did not succeed on-chain');

    const t = getAddress(token);
    const walletTopic = zeroPadValue(this.wallet.address, 32).toLowerCase();
    const tokenLog = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === t.toLowerCase() &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase() &&
        l.topics[2]?.toLowerCase() === walletTopic,
    );
    if (!tokenLog) throw new Error('no matching token transfer to this wallet found in that tx');

    const decimals = Number(
      (await new Contract(token, ERC20_ABI, this.wallet).getFunction('decimals')()) as bigint,
    );
    const rawAmount = BigInt(tokenLog.data);
    const block = await this.provider.getBlock(receipt.blockNumber);
    return {
      ethSpent: Number(formatEther(tx.value)),
      tokensReceived: Number(formatUnits(rawAmount, decimals)),
      blockTimestamp: (block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      gasEth: gasCostEth(receipt),
    };
  }

  /** Current sellable value of the wallet's balance of `token`, in ETH, plus
   *  the human token balance — used to recover/import an existing holding. */
  async valueInEth(token: string, poolIdHint?: string | null): Promise<{ tokens: number; ethOut: number }> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    try {
      return await this.valueInEthV4(token, poolIdHint);
    } catch (v4Err) {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw v4Err;
      return await this.valueInEthV3(token, v3.fee);
    }
  }

  private async valueInEthV4(
    token: string,
    poolIdHint: string | null | undefined,
  ): Promise<{ tokens: number; ethOut: number }> {
    const pool = await this.resolvePool(token, poolIdHint);
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('wallet holds none of this token');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);
    let out = 0n;
    try {
      out = await this.quoteOut(pool, bal, false);
    } catch (err) {
      throw new Error(`quote failed (${shortErr(err)})`);
    }
    return { tokens: Number(formatUnits(bal, decimals)), ethOut: Number(formatEther(out)) };
  }

  private async valueInEthV3(token: string, fee: number): Promise<{ tokens: number; ethOut: number }> {
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('wallet holds none of this token');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);
    let out = 0n;
    try {
      out = await this.quoteV3(t, weth, fee, bal);
    } catch (err) {
      throw new Error(`v3 quote failed (${shortErr(err)})`);
    }
    return { tokens: Number(formatUnits(bal, decimals)), ethOut: Number(formatEther(out)) };
  }

  /** Ensure Permit2's two-leg allowance so the router can pull the token. */
  private async ensurePermit2(token: string, amount: bigint): Promise<void> {
    if (!this.wallet) return;
    const token20 = new Contract(token, ERC20_ABI, this.wallet);
    const erc20Allowance = (await token20.getFunction('allowance')(this.wallet.address, PERMIT2)) as bigint;
    if (erc20Allowance < amount) {
      await (await token20.getFunction('approve')(PERMIT2, MaxUint256)).wait(1);
    }
    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, this.wallet);
    const [allowed] = (await permit2.getFunction('allowance')(
      this.wallet.address,
      token,
      config.SNIPER_ROUTER,
    )) as [bigint, bigint, bigint];
    if (allowed < amount) {
      const maxUint160 = (1n << 160n) - 1n;
      const expiration = Math.floor(Date.now() / 1000) + 30 * 86_400;
      await (await permit2.getFunction('approve')(token, config.SNIPER_ROUTER, maxUint160, expiration)).wait(1);
    }
  }

  /** Sell the wallet's entire balance of `token`. Tries v4 first (including a
   *  slippage retry on a mid-flight price move — see SNIPER_MAX_SELL_SLIPPAGE_PCT);
   *  if v4 has no pool or prices wildly off `expectedPriceEth`, falls back to
   *  v3. This is also how a position bought into a bad v4 pool (see buy())
   *  gets OUT correctly: the v4 leg fails the same sanity check on the way out
   *  and v3 — the pool that's actually liquid — takes over automatically. */
  async sell(token: string, poolIdHint?: string | null, expectedPriceEth?: number | null): Promise<SellResult> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    try {
      return await this.sellV4(token, poolIdHint, expectedPriceEth);
    } catch (v4Err) {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw v4Err;
      logger.warn({ token, v4Err: shortErr(v4Err), fee: v3.fee }, 'sniper: v4 sell unavailable, trying v3');
      return await this.sellV3(token, expectedPriceEth, v3.fee);
    }
  }

  private async sellV4(
    token: string,
    poolIdHint: string | null | undefined,
    expectedPriceEth: number | null | undefined,
  ): Promise<SellResult> {
    const pool = await this.resolvePool(token, poolIdHint);
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('no token balance to sell');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);

    await this.ensurePermit2(token, bal);

    // Sanity-check BEFORE attempting any swap/retry — a bad pool should hand
    // off to v3, not burn gas retrying at wider slippage on the same bad pool.
    if (expectedPriceEth != null && expectedPriceEth > 0) {
      let preQuote: bigint;
      try {
        preQuote = await this.quoteOut(pool, bal, false);
      } catch (err) {
        throw new Error(`sell quote reverted (${shortErr(err)})`);
      }
      const quotedPriceEth = Number(formatEther(preQuote)) / Number(formatUnits(bal, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'sell');
      if (sanityErr) throw new Error(sanityErr);
    }

    try {
      return await this.attemptSellV4(pool, token, bal, decimals, config.SNIPER_SLIPPAGE_PCT);
    } catch (err) {
      // A token crashing (or just thin) can move past normal slippage between
      // the quote and the mined block. Getting out matters more than price
      // here, so retry ONCE at a much wider tolerance instead of leaving the
      // position stuck — re-quoting fresh since the price has already moved.
      logger.warn(
        { token, err: shortErr(err), retryPct: config.SNIPER_MAX_SELL_SLIPPAGE_PCT },
        'sniper: sell reverted, retrying at max slippage',
      );
      return await this.attemptSellV4(pool, token, bal, decimals, config.SNIPER_MAX_SELL_SLIPPAGE_PCT);
    }
  }

  private async attemptSellV4(
    pool: ResolvedPool,
    token: string,
    bal: bigint,
    decimals: number,
    slippagePct: number,
  ): Promise<SellResult> {
    let quotedOut = 0n;
    try {
      quotedOut = await this.quoteOut(pool, bal, false);
    } catch (err) {
      throw new Error(`sell quote reverted (${shortErr(err)})`);
    }
    const amountOutMin = this.minOut(quotedOut, slippagePct);
    const zeroForOne = pool.tokenIs0; // token → ETH side

    const actions = '0x' + ACT_SWAP_EXACT_IN_SINGLE + ACT_SETTLE_ALL + ACT_TAKE_ALL;
    const params = [
      this.encodeSwapParams(pool, zeroForOne, bal, amountOutMin),
      abi.encode(['address', 'uint256'], [getAddress(token), bal]), // SETTLE_ALL(token)
      abi.encode(['address', 'uint256'], [pool.ethCurrency, amountOutMin]), // TAKE_ALL(eth side)
    ];
    const v4Input = abi.encode(['bytes', 'bytes[]'], [actions, params]);

    // WETH pools: unwrap the WETH back to native for the wallet. Native pools:
    // the router takes native straight to the recipient — no unwrap needed.
    const nativePool = pool.ethCurrency === ZeroAddress;
    const commands = nativePool ? CMD_V4_SWAP : concat([CMD_V4_SWAP, CMD_UNWRAP_WETH]);
    const inputs = nativePool
      ? [v4Input]
      : [v4Input, abi.encode(['address', 'uint256'], [this.wallet!.address, amountOutMin])];

    const router = new Contract(config.SNIPER_ROUTER, ROUTER_ABI, this.wallet!);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    // Native balance before the sell — the sell sends no value, so the only ETH
    // movement is (received − gas); actual received = Δbalance + gas. This is the
    // REAL fill, vs quotedOut which is only what the pre-trade quote promised.
    const balBefore = await this.provider!.getBalance(this.wallet!.address).catch(() => null);
    let tx;
    try {
      tx = await router.getFunction('execute')(commands, inputs, deadline);
    } catch (err) {
      throw new Error(`sell swap reverted (${shortErr(err)})`);
    }
    logger.info({ token, tx: tx.hash, venue: 'v4', slippagePct }, 'sniper: sell sent');
    const receipt = await tx.wait(1);
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      ethReceived: await this.actualEthReceived(balBefore, gasEth, quotedOut),
      quotedEthOut: Number(formatEther(quotedOut)),
      tokensSold: Number(formatUnits(bal, decimals)),
      gasEth,
      venue: 'v4',
    };
  }

  /** Actual ETH the wallet netted from a sell: Δ(native balance) + gas paid.
   *  Falls back to the quote if the post-trade balance read fails. */
  private async actualEthReceived(
    balBefore: bigint | null,
    gasEth: number,
    quotedOut: bigint,
  ): Promise<number> {
    if (balBefore == null) return Number(formatEther(quotedOut));
    try {
      const balAfter = await this.provider!.getBalance(this.wallet!.address);
      const delta = Number(formatEther(balAfter - balBefore));
      const received = delta + gasEth; // add gas back — it left the same balance
      return received > 0 ? received : Number(formatEther(quotedOut));
    } catch {
      return Number(formatEther(quotedOut));
    }
  }

  private async sellV3(
    token: string,
    expectedPriceEth: number | null | undefined,
    fee: number,
  ): Promise<SellResult> {
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('no token balance to sell');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);

    await this.ensureErc20Approval(token, V3_ROUTER, bal);

    if (expectedPriceEth != null && expectedPriceEth > 0) {
      let preQuote: bigint;
      try {
        preQuote = await this.quoteV3(t, weth, fee, bal);
      } catch (err) {
        throw new Error(`v3 sell quote reverted (${shortErr(err)})`);
      }
      const quotedPriceEth = Number(formatEther(preQuote)) / Number(formatUnits(bal, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'sell');
      if (sanityErr) throw new Error(`v3: ${sanityErr}`);
    }

    try {
      return await this.attemptSellV3(t, weth, fee, bal, decimals, config.SNIPER_SLIPPAGE_PCT);
    } catch (err) {
      logger.warn(
        { token, err: shortErr(err), retryPct: config.SNIPER_MAX_SELL_SLIPPAGE_PCT, venue: 'v3' },
        'sniper: v3 sell reverted, retrying at max slippage',
      );
      return await this.attemptSellV3(t, weth, fee, bal, decimals, config.SNIPER_MAX_SELL_SLIPPAGE_PCT);
    }
  }

  private async attemptSellV3(
    token: string,
    weth: string,
    fee: number,
    bal: bigint,
    decimals: number,
    slippagePct: number,
  ): Promise<SellResult> {
    let quoted: bigint;
    try {
      quoted = await this.quoteV3(token, weth, fee, bal);
    } catch (err) {
      throw new Error(`v3 sell quote reverted (${shortErr(err)})`);
    }
    const amountOutMin = this.minOut(quoted, slippagePct);
    const router = new Contract(V3_ROUTER, V3_ROUTER_ABI, this.wallet!);
    // recipient = the router itself: it holds the WETH momentarily, then
    // unwrapWETH9 sweeps it out as native ETH to the wallet, in one multicall.
    const swapCalldata = router.interface.encodeFunctionData('exactInputSingle', [
      [token, weth, fee, V3_ROUTER, bal, amountOutMin, 0n],
    ]);
    const unwrapCalldata = router.interface.encodeFunctionData('unwrapWETH9', [
      amountOutMin,
      this.wallet!.address,
    ]);
    const balBefore = await this.provider!.getBalance(this.wallet!.address).catch(() => null);
    let tx;
    try {
      tx = await router.getFunction('multicall')([swapCalldata, unwrapCalldata]);
    } catch (err) {
      throw new Error(`v3 sell swap reverted (${shortErr(err)})`);
    }
    logger.info({ token, tx: tx.hash, venue: 'v3', fee, slippagePct }, 'sniper: sell sent');
    const receipt = await tx.wait(1);
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      ethReceived: await this.actualEthReceived(balBefore, gasEth, quoted),
      quotedEthOut: Number(formatEther(quoted)),
      tokensSold: Number(formatUnits(bal, decimals)),
      gasEth,
      venue: 'v3',
    };
  }
}
