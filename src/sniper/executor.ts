import {
  JsonRpcProvider,
  Wallet,
  Contract,
  AbiCoder,
  keccak256,
  parseEther,
  parseUnits,
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
// Addresses/ABIs shared with the price oracle, which reads the same pools when
// DexScreener has not indexed a pair yet — see chain/uniswap.ts.
import {
  PERMIT2,
  V4_QUOTER,
  POSITION_MANAGER,
  POOL_MANAGER,
  STATE_VIEW,
  STATE_VIEW_ABI,
  INIT_TOPIC,
  V3_FACTORY,
  V3_FACTORY_ABI,
  V3_POOL_ABI,
  V3_ROUTER,
  V3_QUOTER,
  V3_FEE_TIERS,
} from '../chain/uniswap.js';

// ── Trade-path constants (the shared addresses live in chain/uniswap.ts) ──────
// The UniversalRouter is Robinhood's MODIFIED fork: its v4 swap struct carries
// an extra `minHopPriceX36` field (always 0), so stock Uniswap SDK calldata
// reverts. Pool params VARY per token, so the executor resolves each token's
// real PoolKey on-chain instead of assuming one shape.
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

// ── Uniswap V3 (genuine, unmodified Uniswap deployment) ────────────────────────
// Some tokens' real liquidity lives on V3, not V4 — V4-only routing can silently
// resolve a near-empty V4 pool (see PRICE_SANITY_MULTIPLE below) while missing
// the actual deep pool entirely. How the V3 addresses were verified on-chain is
// documented alongside them in chain/uniswap.ts.

/** How long a token's discovered VENUE SET stays valid.
 *
 *  These sets were cached for the whole process lifetime, which is backwards for a sniper: we first
 *  resolve a token seconds after launch, and the pool that ends up carrying its liquidity is often
 *  created LATER (migration off a bonding curve, a second fee tier opening). A pool that appears
 *  after the first resolution was invisible forever — bestVenue() can only quote what enumeration
 *  hands it, so a stale set silently caps routing quality no matter how good the quoting is.
 *  5 minutes keeps the all-history log scan off the hot path while letting a new pool be seen. */
const VENUE_CACHE_TTL_MS = 5 * 60_000;

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
  /** Exact base-unit fill delta. Keeps a position's sell cap free of JS float rounding. */
  tokensReceivedRaw?: string;
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

/** The venue that won the quote race, and the quote that won it. Both the gate
 *  and the trade consume THIS — one routing decision per trade, so the pool we
 *  price can never differ from the pool we execute against. */
export interface VenueQuote {
  venue: 'v4' | 'v3';
  /** v4 only: the exact PoolKey to execute against. */
  pool?: ResolvedPool;
  /** The winning pool's fee, in hundredths of a bip (v4) or v3 tier units. */
  fee?: number;
  /** Tokens out when buying, ETH wei out when selling. */
  amountOut: bigint;
  /** Buys only: ETH wei recovered by selling `amountOut` straight back on this
   *  same venue. This is what a buy is RANKED on — see pickBestQuote. */
  ethBack?: bigint;
}

/** gasUsed × effective gas price, in ETH — the real network fee for a tx. */
function gasCostEth(receipt: { gasUsed: bigint; gasPrice: bigint }): number {
  return Number(formatEther(receipt.gasUsed * receipt.gasPrice));
}

/** A token's resolved v4 pool: the exact key plus which side the token is. */
export interface ResolvedPool {
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

/**
 * Choose between quoted venues. Pure, so the decoy cases that motivated it are
 * unit-testable without a chain — same reasoning as checkPriceSanity above.
 *
 * A BUY is ranked on `ethBack` (what the round trip returns), NOT on tokens
 * out, and that distinction is the whole point. A decoy pool prices the token
 * far below market, so its buy quote stays competitive even behind a 95% fee —
 * IOU's decoy quoted 0.81× the real pool's tokens, so ranking on output alone
 * it loses by only 19%, and a decoy priced slightly cheaper would have WON and
 * left us holding tokens we could not sell. Priced on the round trip the same
 * two pools separate by ~45× (−100% vs −2.19%), because a pool you cannot exit
 * returns nothing by definition. Rank on the number that encodes tradeability.
 *
 * A SELL has no round trip to price — it is ranked on ETH out directly.
 *
 * Price sanity is a FILTER, not a veto: buyV4 throws on an insane quote because
 * it has already committed to one pool, whereas the router just drops that
 * candidate and keeps looking, so one bad pool cannot sink the trade. If it
 * rejects everything we fall back to the raw best rather than refusing —
 * a stale DexScreener price must not be able to ground the sniper.
 */
export function pickBestQuote(
  quotes: VenueQuote[],
  opts: {
    amountIn: bigint;
    decimals: number;
    direction: 'buy' | 'sell';
    expectedPriceEth?: number | null;
  },
): { pick: VenueQuote | null; rejectedBySanity: number } {
  const { amountIn, decimals, direction, expectedPriceEth } = opts;
  const buying = direction === 'buy';
  if (quotes.length === 0) return { pick: null, rejectedBySanity: 0 };

  const sane =
    expectedPriceEth != null && expectedPriceEth > 0
      ? quotes.filter((q) => {
          const tokens = Number(formatUnits(buying ? q.amountOut : amountIn, decimals));
          const eth = Number(formatEther(buying ? amountIn : q.amountOut));
          if (!(tokens > 0) || !(eth > 0)) return false;
          return checkPriceSanity(eth / tokens, expectedPriceEth, PRICE_SANITY_MULTIPLE, direction) === null;
        })
      : quotes;

  const pool = sane.length > 0 ? sane : quotes;
  const score = (q: VenueQuote): bigint => (buying ? (q.ethBack ?? 0n) : q.amountOut);
  const pick = pool.reduce<VenueQuote | null>((best, q) => {
    if (best === null) return q;
    const [a, b] = [score(q), score(best)];
    // Ties (e.g. every exit quote failed and scored 0n) fall back to raw output,
    // so a chain hiccup on the sell leg degrades to the old behaviour, not to
    // an arbitrary pick.
    if (a > b) return q;
    if (a === b && q.amountOut > best.amountOut) return q;
    return best;
  }, null);
  return { pick, rejectedBySanity: quotes.length - sane.length };
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
  /** token → EVERY eth-paired v4 pool it has. The candidate SET, cached because
   *  the Initialize log scan walks all history; the pick is never cached, since
   *  which pool wins depends on size and on current state. */
  private readonly v4Candidates = new Map<string, { at: number; val: ResolvedPool[] }>();
  /** token → every v3 fee tier with a live pool. Same reasoning as above. */
  private readonly v3Candidates = new Map<string, { at: number; val: number[] }>();
  /** token → ERC-20 decimals. Read once; needed on every price-sanity check. */
  private readonly decimals = new Map<string, number>();

  private key(): string {
    // Server keys must be explicitly unlocked from the encrypted keystore.
    // Do not fall back to SNIPER_PRIVATE_KEY: that would silently re-arm a
    // wallet after restart and bypass the authenticated unlock requirement.
    return this.runtimeKey ?? '';
  }

  get ready(): boolean {
    return this.key().length > 0 && config.SNIPER_ROUTER.length > 0 && config.SNIPER_WETH.length > 0;
  }

  /** Set the hot-wallet key at runtime (from the dashboard). Not persisted. */
  // (see addressOfPrivateKey below for the non-mutating derivation used by enrolment checks)
  setPrivateKey(pk: string): string {
    const clean = pk.trim();
    const w = new Wallet(clean); // throws on a bad key
    this.runtimeKey = clean;
    this.wallet = null; // force rebuild with the new key
    return w.address;
  }

  /** Drop the decrypted runtime key and all signer/provider references. */
  clearPrivateKey(): void {
    this.runtimeKey = null;
    this.wallet = null;
    this.provider = null;
  }

  /** Pre-flight the route-specific token allowance immediately after entry.
   * This is deliberately called only after a live entry. */
  async prepareExit(token: string, maxTokensRaw?: string): Promise<void> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    const token20 = new Contract(token, ERC20_ABI, this.wallet);
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);
    const balance = (await token20.getFunction('balanceOf')(this.wallet.address)) as bigint;
    const requested = maxTokensRaw ? BigInt(maxTokensRaw) : balance;
    const amount = requested < balance ? requested : balance;
    if (amount <= 0n) throw new Error('no token balance to prepare for exit');
    // Resolve before authorising so a completely unrouteable token is surfaced
    // immediately. V4 uses Permit2, V3 uses the router allowance.
    try {
      await this.resolvePool(token);
      await this.ensurePermit2(token, amount);
    } catch {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw new Error('no executable exit route');
      await this.ensureErc20Approval(token, V3_ROUTER, amount);
    }
    void decimals; // validates non-standard decimal calls alongside the allowance path
  }

  private init(): void {
    if (this.wallet || !this.ready) return;
    // Executor uses its own RPC when set (a reliable metered node for tx sends) so the continuous
    // chain listener can stay on the free public node. Falls back to CHAIN_HTTP_URL for back-compat.
    const rpc = config.SNIPER_EXECUTOR_RPC || config.CHAIN_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
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

  /** EVERY eth-paired v4 pool for this token, from the PoolManager's Initialize
   *  events (the definitive source — every v4 pool emits its full PoolKey at
   *  creation). Returns the whole candidate SET deliberately: choosing between
   *  them belongs to the router, which chooses by quoting them, not by ranking
   *  them on a proxy metric. Cached — the scan walks all history. */
  private async enumerateV4Pools(token: string): Promise<ResolvedPool[]> {
    const cacheKey = token.toLowerCase();
    const memo = this.v4Candidates.get(cacheKey);
    if (memo && Date.now() - memo.at < VENUE_CACHE_TTL_MS) return memo.val;
    if (!this.provider) return [];
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
    if (found.length === 0) return [];
    // Only ETH/WETH-paired pools are buyable with a single-hop ETH swap.
    const ethPaired = found.filter((p) => p.ethCurrency === weth || p.ethCurrency === ZeroAddress);
    if (ethPaired.length === 0) {
      throw new Error(
        `token has a pool but it's not ETH/WETH-paired (vs ${found[0]!.ethCurrency.slice(0, 10)}…) — can't buy with ETH`,
      );
    }
    this.v4Candidates.set(cacheKey, { at: Date.now(), val: ethPaired });
    return ethPaired;
  }

  /** Legacy single-pool resolution, kept for the paths that genuinely need one
   *  pool and have no amount to quote with (prepareExit's warm-up,
   *  protocolFeeInfo's fee read). Everything that spends or prices money goes
   *  through bestVenue() instead — see the note on deepestPool. */
  private async resolveFromInitEvent(token: string): Promise<ResolvedPool | null> {
    const ethPaired = await this.enumerateV4Pools(token);
    if (ethPaired.length === 0) return null;
    const pick = await this.deepestPool(ethPaired);
    logger.info(
      { token, pool: { fee: pick.fee, tickSpacing: pick.tickSpacing, hooks: pick.hooks, eth: pick.ethCurrency }, candidates: ethPaired.length },
      'sniper: pool resolved from Initialize event',
    );
    return pick;
  }

  /** Pick the candidate with the most on-chain liquidity right now (0 for any
   *  that fail to read). Falls back to the last candidate only if every read
   *  fails or ties at zero, so a single flaky RPC call can't wrongly demote
   *  the real pool.
   *
   *  NOT a venue-selection metric, and never use it as one. Raw uint128 L is
   *  depth measured at each pool's OWN current price, so it isn't comparable
   *  between pools sitting at different prices — and it says nothing at all
   *  about fee. IOU (2026-08-02) had three eth-paired v4 pools charging 95.01%,
   *  99.88% and 75%; this function correctly returned the deepest of them and
   *  the sniper then priced a round trip at −100% and skipped a token that was
   *  perfectly tradeable at 2.19% on v3. Depth alone cannot see that. Only a
   *  quote can, which is what bestVenue() does. */
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

  /** ERC-20 decimals, read once per token. Needed on every price-sanity check,
   *  and it never changes. */
  private async decimalsOf(token: string): Promise<number> {
    const key = token.toLowerCase();
    const memo = this.decimals.get(key);
    if (memo !== undefined) return memo;
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const d = Number((await token20.getFunction('decimals')()) as bigint);
    this.decimals.set(key, d);
    return d;
  }

  /** Every v3 fee tier with a live eth-paired pool. The SET, like
   *  enumerateV4Pools — the winner is decided by quoting, not by liquidity. */
  private async enumerateV3Fees(token: string): Promise<number[]> {
    const cacheKey = token.toLowerCase();
    const memo = this.v3Candidates.get(cacheKey);
    if (memo && Date.now() - memo.at < VENUE_CACHE_TTL_MS) return memo.val;
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const factory = new Contract(V3_FACTORY, V3_FACTORY_ABI, this.provider!);
    const live = await Promise.all(
      V3_FEE_TIERS.map(async (fee) => {
        try {
          const addr = (await factory.getFunction('getPool')(t, weth, fee)) as string;
          if (!addr || addr === ZeroAddress) return null;
          const liq = (await new Contract(addr, V3_POOL_ABI, this.provider!).getFunction('liquidity')()) as bigint;
          return liq > 0n ? fee : null;
        } catch {
          return null;
        }
      }),
    );
    const fees = live.filter((f): f is number => f !== null);
    this.v3Candidates.set(cacheKey, { at: Date.now(), val: fees });
    return fees;
  }

  /**
   * Smart order routing, the standard way: enumerate every venue the token has
   * (v4 pools + v3 fee tiers), quote them ALL concurrently at the real trade
   * size, and take whichever actually returns the most — gated on a price
   * sanity check against the token's known market price where we have one.
   *
   * The point is that the winner is decided by the quote and nothing else. The
   * previous design picked a pool by a proxy metric (deepest L) and then quoted
   * only that pool, which is unrecoverable when the proxy is wrong: on
   * 2026-08-02 IOU resolved to a 95%-fee decoy, priced at −100%, and was
   * skipped despite trading fine at 2.19% on v3 — and HMN the day before, the
   * same way. Quoting everything makes a decoy lose on its own numbers, so it
   * needs no detection, no blacklist, and no market-price feed to beat.
   *
   * `amountIn` is ETH wei when buying and token base units when selling.
   * Returns null when nothing quotes — callers treat that as fail-closed.
   */
  async bestVenue(
    token: string,
    amountIn: bigint,
    direction: 'buy' | 'sell',
    poolIdHint?: string | null,
    expectedPriceEth?: number | null,
  ): Promise<VenueQuote | null> {
    this.init();
    if (!this.wallet || amountIn <= 0n) return null;
    const buying = direction === 'buy';
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);

    const [v4Pools, v3Fees, decimals] = await Promise.all([
      this.enumerateV4Pools(token).catch(() => [] as ResolvedPool[]),
      this.enumerateV3Fees(token).catch(() => [] as number[]),
      this.decimalsOf(token).catch(() => 18),
    ]);
    // A hinted pool the log scan somehow missed still deserves a quote.
    const hinted = await this.hintedV4Pool(token, poolIdHint);
    const pools = hinted && !v4Pools.some((p) => poolIdOf(p) === poolIdOf(hinted)) ? [...v4Pools, hinted] : v4Pools;
    if (pools.length === 0 && v3Fees.length === 0) return null;

    const quotes = await Promise.all([
      ...pools.map(async (pool): Promise<VenueQuote | null> => {
        try {
          const out = await this.quoteOut(pool, amountIn, buying);
          if (out <= 0n) return null;
          // Buying: also price the exit, concurrently-cheap and decisive (below).
          const ethBack = buying ? await this.quoteOut(pool, out, false).catch(() => 0n) : undefined;
          return { venue: 'v4', pool, fee: pool.fee, amountOut: out, ethBack };
        } catch {
          return null;
        }
      }),
      ...v3Fees.map(async (fee): Promise<VenueQuote | null> => {
        try {
          const out = buying
            ? await this.quoteV3(weth, t, fee, amountIn)
            : await this.quoteV3(t, weth, fee, amountIn);
          if (out <= 0n) return null;
          const ethBack = buying ? await this.quoteV3(t, weth, fee, out).catch(() => 0n) : undefined;
          return { venue: 'v3', fee, amountOut: out, ethBack };
        } catch {
          return null;
        }
      }),
    ]);

    const priced = quotes.filter((q): q is VenueQuote => q !== null);
    const { pick, rejectedBySanity } = pickBestQuote(priced, {
      amountIn,
      decimals,
      direction,
      expectedPriceEth,
    });
    if (!pick) return null;
    if (priced.length > 1) {
      logger.info(
        {
          token,
          direction,
          chose: pick.venue,
          fee: pick.fee,
          candidates: priced.map((q) => ({
            venue: q.venue,
            fee: q.fee,
            out: q.amountOut.toString(),
            ethBack: q.ethBack?.toString(),
          })),
          rejectedBySanity,
        },
        'sniper: venue chosen by quote',
      );
    }
    return pick;
  }

  /** The DexScreener pool-id hint as a v4 PoolKey, when it is one. A v3 pair is
   *  a 20-byte address and simply isn't resolvable here — that shape is covered
   *  by enumerateV3Fees, which is exactly the gap that hid IOU's real pool. */
  private async hintedV4Pool(token: string, poolIdHint?: string | null): Promise<ResolvedPool | null> {
    if (!poolIdHint || !/^0x[0-9a-fA-F]{64}$/.test(poolIdHint)) return null;
    try {
      const posm = new Contract(POSITION_MANAGER, POSM_ABI, this.provider!);
      const [c0, c1, fee, tickSpacing, hooks] = (await posm.getFunction('poolKeys')(
        dataSlice(poolIdHint, 0, 25),
      )) as [string, string, bigint, bigint, string];
      const t = getAddress(token);
      if (getAddress(c0) !== t && getAddress(c1) !== t) return null;
      const tokenIs0 = getAddress(c0) === t;
      return {
        currency0: getAddress(c0),
        currency1: getAddress(c1),
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
        hooks: getAddress(hooks),
        ethCurrency: tokenIs0 ? getAddress(c1) : getAddress(c0),
        tokenIs0,
      };
    } catch {
      return null;
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
    expectedPriceEth?: number | null,
  ): Promise<RoundTrip | null> {
    this.init();
    if (!this.wallet) return null;
    const amountIn = parseEther(ethAmount.toString());
    // Route first, THEN price the round trip on whatever won. Previously this
    // measured a single v4 pool chosen by depth and reported its round trip as
    // the token's — which is how a 95%-fee decoy got to veto IOU and HMN.
    const entry = await this.bestVenue(token, amountIn, 'buy', poolIdHint, expectedPriceEth);
    if (!entry || entry.amountOut <= 0n) return null;
    const tokensOut = entry.amountOut;
    // The router already priced the exit on this same venue to rank it, so the
    // round trip costs no extra call here — and it is by construction the round
    // trip of the pool we would actually trade, not of some other pool.
    if (entry.ethBack === undefined) return null;
    const ethBackWei = entry.ethBack;
    const liq = entry.venue === 'v4' ? await this.readLiquidity(entry.pool!) : 0n;
    const ethIn = Number(formatEther(amountIn));
    const ethBack = Number(formatEther(ethBackWei));
    return {
      venue: entry.venue,
      ethIn,
      quotedTokens: Number(tokensOut),
      ethBack,
      lossPct: ethIn > 0 ? (1 - ethBack / ethIn) * 100 : 100,
      poolLiquidity: liq > 0n ? Number(liq) : null,
    };
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
    const amountIn = parseEther(ethAmount.toString());
    const best = await this.bestVenue(token, amountIn, 'buy', poolIdHint, expectedPriceEth).catch(() => null);
    if (best) {
      try {
        return best.venue === 'v4'
          ? await this.buyV4(token, ethAmount, poolIdHint, expectedPriceEth, best.pool)
          : await this.buyV3(token, ethAmount, expectedPriceEth, best.fee!);
      } catch (err) {
        // The router's pick failed to execute (reverted, or moved under us).
        // Fall through to the legacy try-both path rather than abandon the buy.
        logger.warn({ token, venue: best.venue, err: shortErr(err) }, 'sniper: routed venue failed, retrying both');
      }
    }
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
    routed?: ResolvedPool,
  ): Promise<BuyResult> {
    const pool = routed ?? (await this.resolvePool(token, poolIdHint));
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
    let tokensReceivedRaw: string | undefined;
    try {
      const after = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
      const received = after - before;
      tokensReceived = Number(formatUnits(received, decimals));
      tokensReceivedRaw = received.toString();
    } catch {
      /* balance read failed — tx still landed */
    }
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      tokensReceived,
      tokensReceivedRaw,
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
    let tokensReceivedRaw: string | undefined;
    try {
      const after = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
      const received = after - before;
      tokensReceived = Number(formatUnits(received, decimals));
      tokensReceivedRaw = received.toString();
    } catch {
      /* balance read failed — tx still landed */
    }
    const gasEth = receipt ? gasCostEth(receipt) : 0;
    return {
      txHash: tx.hash,
      tokensReceived,
      tokensReceivedRaw,
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
  ): Promise<{ ethSpent: number; tokensReceived: number; tokensReceivedRaw: string; blockTimestamp: number; gasEth: number }> {
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
      tokensReceivedRaw: rawAmount.toString(),
      blockTimestamp: (block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      gasEth: gasCostEth(receipt),
    };
  }

  /** Current sellable value of the wallet's balance of `token`, in ETH, plus
   *  the human token balance — used to recover/import an existing holding. */
  async valueInEth(token: string, poolIdHint?: string | null): Promise<{ tokens: number; ethOut: number }> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    // This is the position MARK — it drives trailing stops, recoup and every
    // PnL number on the page. Marking against a decoy pool is how a healthy
    // position gets stopped out on a price that exists nowhere real, so it gets
    // the same routing as a trade: quote every venue, mark on the best.
    const token20 = new Contract(token, ERC20_ABI, this.wallet);
    const bal = (await token20.getFunction('balanceOf')(this.wallet.address)) as bigint;
    if (bal <= 0n) throw new Error('wallet holds none of this token');
    const best = await this.bestVenue(token, bal, 'sell', poolIdHint).catch(() => null);
    if (best && best.amountOut > 0n) {
      const decimals = await this.decimalsOf(token);
      return { tokens: Number(formatUnits(bal, decimals)), ethOut: Number(formatEther(best.amountOut)) };
    }
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

  /** Sell only this position's recorded token amount (capped to its actual wallet balance).
   *  This prevents one position-map from selling a sibling map's same-token lot when both happen
   *  to use the same wallet. Tries v4 first (including a
   *  slippage retry on a mid-flight price move — see SNIPER_MAX_SELL_SLIPPAGE_PCT);
   *  if v4 has no pool or prices wildly off `expectedPriceEth`, falls back to
   *  v3. This is also how a position bought into a bad v4 pool (see buy())
   *  gets OUT correctly: the v4 leg fails the same sanity check on the way out
   *  and v3 — the pool that's actually liquid — takes over automatically. */
  async sell(
    token: string,
    poolIdHint?: string | null,
    expectedPriceEth?: number | null,
    maxTokens?: number,
    maxTokensRaw?: string,
  ): Promise<SellResult> {
    this.init();
    if (!this.wallet) throw new Error('sniper wallet not configured');
    // Route the exit the same way as the entry. Getting this wrong is worse
    // than a missed buy: a position whose real market is v3 would try v4 first
    // and only reach v3 after a failed attempt — burning gas, and burning the
    // seconds that decide what a trailing stop actually realizes.
    const best = await this.sellVenue(token, expectedPriceEth, maxTokens, maxTokensRaw);
    if (best) {
      try {
        return best.venue === 'v4'
          ? await this.sellV4(token, poolIdHint, expectedPriceEth, maxTokens, maxTokensRaw, best.pool)
          : await this.sellV3(token, expectedPriceEth, best.fee!, maxTokens, maxTokensRaw);
      } catch (err) {
        logger.warn({ token, venue: best.venue, err: shortErr(err) }, 'sniper: routed sell venue failed, retrying both');
      }
    }
    try {
      return await this.sellV4(token, poolIdHint, expectedPriceEth, maxTokens, maxTokensRaw);
    } catch (v4Err) {
      const v3 = await this.resolveV3Pool(token);
      if (!v3) throw v4Err;
      logger.warn({ token, v4Err: shortErr(v4Err), fee: v3.fee }, 'sniper: v4 sell unavailable, trying v3');
      return await this.sellV3(token, expectedPriceEth, v3.fee, maxTokens, maxTokensRaw);
    }
  }

  /** Route an exit: quote every venue for the exact size we're about to sell.
   *  Best-effort — a null just means the caller uses the legacy try-both path. */
  private async sellVenue(
    token: string,
    expectedPriceEth?: number | null,
    maxTokens?: number,
    maxTokensRaw?: string,
  ): Promise<VenueQuote | null> {
    try {
      const token20 = new Contract(token, ERC20_ABI, this.wallet!);
      const held = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
      if (held <= 0n) return null;
      const decimals = await this.decimalsOf(token);
      const amount = this.cappedSellAmount(held, decimals, maxTokens, maxTokensRaw);
      if (amount <= 0n) return null;
      return await this.bestVenue(token, amount, 'sell', null, expectedPriceEth);
    } catch {
      return null;
    }
  }

  /** Send native ETH from the hot wallet to `to` — used to skim the platform
   *  close-fee off a sell's proceeds. Never spends into `reserveWei` (the trading
   *  gas reserve) or the headroom this transfer's own gas needs; if the requested
   *  amount doesn't fit, it's clamped down, and if nothing fits, returns null.
   *  Returns null for a non-positive amount too. */
  async transferEth(
    to: string,
    amountWei: bigint,
    reserveWei: bigint = 0n,
  ): Promise<{ txHash: string; gasEth: number } | null> {
    this.init();
    if (!this.wallet || !this.provider) throw new Error('sniper wallet not configured');
    if (amountWei <= 0n) return null;
    const dest = getAddress(to);
    const bal = await this.provider.getBalance(this.wallet.address);
    // Leave the trading gas reserve untouched plus a little headroom for this
    // 21k-gas transfer itself, so skimming the fee can never strand the wallet.
    const gasHeadroom = parseEther('0.0003');
    const spendable = bal - reserveWei - gasHeadroom;
    if (spendable <= 0n) return null;
    const value = amountWei < spendable ? amountWei : spendable;
    if (value <= 0n) return null;
    const tx = await this.wallet.sendTransaction({ to: dest, value });
    const receipt = await tx.wait(1);
    return { txHash: tx.hash, gasEth: receipt ? gasCostEth(receipt) : 0 };
  }

  /** Convert a position's recorded amount to base units and never exceed its wallet balance.
   *  Raw fills are authoritative. Legacy positions fall back to their human-readable float amount.
   *  A transfer-tax or prior partial transfer simply sells the smaller actual balance. */
  private cappedSellAmount(
    held: bigint,
    decimals: number,
    maxTokens?: number,
    maxTokensRaw?: string,
  ): bigint {
    let wanted: bigint | null = null;
    if (maxTokensRaw != null) {
      try {
        wanted = BigInt(maxTokensRaw);
      } catch {
        throw new Error('invalid recorded token amount');
      }
      if (wanted < 0n) throw new Error('invalid recorded token amount');
    } else if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
      // Ethers limits toFixed to 100 decimals; real ERC-20s use far less (typically 18).
      wanted = parseUnits(maxTokens.toFixed(Math.min(decimals, 100)), decimals);
    }
    return wanted != null && wanted < held ? wanted : held;
  }

  private async sellV4(
    token: string,
    poolIdHint: string | null | undefined,
    expectedPriceEth: number | null | undefined,
    maxTokens: number | undefined,
    maxTokensRaw: string | undefined,
    routed?: ResolvedPool,
  ): Promise<SellResult> {
    const pool = routed ?? (await this.resolvePool(token, poolIdHint));
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('no token balance to sell');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);
    const sellAmount = this.cappedSellAmount(bal, decimals, maxTokens, maxTokensRaw);
    if (sellAmount <= 0n) throw new Error('no token balance to sell');

    await this.ensurePermit2(token, sellAmount);

    // Sanity-check BEFORE attempting any swap/retry — a bad pool should hand
    // off to v3, not burn gas retrying at wider slippage on the same bad pool.
    if (expectedPriceEth != null && expectedPriceEth > 0) {
      let preQuote: bigint;
      try {
        preQuote = await this.quoteOut(pool, sellAmount, false);
      } catch (err) {
        throw new Error(`sell quote reverted (${shortErr(err)})`);
      }
      const quotedPriceEth = Number(formatEther(preQuote)) / Number(formatUnits(sellAmount, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'sell');
      if (sanityErr) throw new Error(sanityErr);
    }

    try {
      return await this.attemptSellV4(pool, token, sellAmount, decimals, config.SNIPER_SLIPPAGE_PCT);
    } catch (err) {
      // A token crashing (or just thin) can move past normal slippage between
      // the quote and the mined block. Getting out matters more than price
      // here, so retry ONCE at a much wider tolerance instead of leaving the
      // position stuck — re-quoting fresh since the price has already moved.
      logger.warn(
        { token, err: shortErr(err), retryPct: config.SNIPER_MAX_SELL_SLIPPAGE_PCT },
        'sniper: sell reverted, retrying at max slippage',
      );
      return await this.attemptSellV4(pool, token, sellAmount, decimals, config.SNIPER_MAX_SELL_SLIPPAGE_PCT);
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
    maxTokens: number | undefined,
    maxTokensRaw: string | undefined,
  ): Promise<SellResult> {
    const weth = getAddress(config.SNIPER_WETH);
    const t = getAddress(token);
    const token20 = new Contract(token, ERC20_ABI, this.wallet!);
    const bal = (await token20.getFunction('balanceOf')(this.wallet!.address)) as bigint;
    if (bal <= 0n) throw new Error('no token balance to sell');
    const decimals = Number((await token20.getFunction('decimals')()) as bigint);
    const sellAmount = this.cappedSellAmount(bal, decimals, maxTokens, maxTokensRaw);
    if (sellAmount <= 0n) throw new Error('no token balance to sell');

    await this.ensureErc20Approval(token, V3_ROUTER, sellAmount);

    if (expectedPriceEth != null && expectedPriceEth > 0) {
      let preQuote: bigint;
      try {
        preQuote = await this.quoteV3(t, weth, fee, sellAmount);
      } catch (err) {
        throw new Error(`v3 sell quote reverted (${shortErr(err)})`);
      }
      const quotedPriceEth = Number(formatEther(preQuote)) / Number(formatUnits(sellAmount, decimals));
      const sanityErr = checkPriceSanity(quotedPriceEth, expectedPriceEth, PRICE_SANITY_MULTIPLE, 'sell');
      if (sanityErr) throw new Error(`v3: ${sanityErr}`);
    }

    try {
      return await this.attemptSellV3(t, weth, fee, sellAmount, decimals, config.SNIPER_SLIPPAGE_PCT);
    } catch (err) {
      logger.warn(
        { token, err: shortErr(err), retryPct: config.SNIPER_MAX_SELL_SLIPPAGE_PCT, venue: 'v3' },
        'sniper: v3 sell reverted, retrying at max slippage',
      );
      return await this.attemptSellV3(t, weth, fee, sellAmount, decimals, config.SNIPER_MAX_SELL_SLIPPAGE_PCT);
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

/**
 * The address a private key controls, WITHOUT enrolling or unlocking anything.
 *
 * Enrolment needs to answer "is another owner already using this wallet?" before it commits, and
 * the only other way to learn the address was `setPrivateKey`, which loads the key into a live
 * executor. Throws on a malformed key, exactly as enrolment does.
 */
export function addressOfPrivateKey(pk: string): string {
  return new Wallet(pk.trim()).address;
}
