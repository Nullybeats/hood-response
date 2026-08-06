/**
 * Robinhood Chain Uniswap deployment addresses — the single source of truth.
 *
 * These were verified on-chain (see the notes in sniper/executor.ts, which
 * consumes the same constants): the v3 factory is read from a known-liquid
 * pool's own `factory()` getter, and the router/quoter are the contracts whose
 * `factory()` matches it — this chain carries many unrelated token-specific
 * clones of the "SwapRouter02"/"QuoterV2" names, so name matching alone is not
 * safe.
 *
 * They live here rather than in the executor because the PRICE ORACLE needs the
 * same pools: when DexScreener has not indexed a pair yet, the only honest
 * source of a token's price is the pool itself (see chain/poolPrice.ts).
 */

// ── Uniswap v4 (Robinhood's modified fork) ───────────────────────────────────
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7';
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';

/** PoolManager.Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
 *  topics: [sig, id, currency0, currency1]; data: fee,tickSpacing,hooks,sqrtPriceX96,tick */
export const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

export const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

// ── Uniswap v3 (genuine, unmodified deployment) ──────────────────────────────
export const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
/** keccak256(PoolCreated(address,address,uint24,int24,address)). */
export const V3_POOL_CREATED_TOPIC = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
export const V3_ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2'; // SwapRouter02
export const V3_QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7'; // QuoterV2
export const V3_FEE_TIERS = [500, 3000, 10000, 100]; // 0.05% / 0.3% / 1% / 0.01%

export const V3_FACTORY_ABI = ['function getPool(address, address, uint24) view returns (address)'];
export const V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];
