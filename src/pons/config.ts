/**
 * Pons launchpad — constants and decoding.
 *
 * Pons is a memecoin launch factory on this chain running ~4,400 launches/day [verified 2026-08-05
 * by full backfill: 250,524 TokenLaunched events over 22.4 days]. Each launch deploys a fresh ERC-20
 * via CREATE2, creates a Uniswap **V3** WETH pool at fee 10000, mints the whole supply as liquidity,
 * and optionally executes an atomic initial buy for the deployer — all in one transaction.
 *
 * Every address here is verified on-chain, and the factory is source-verified on Blockscout as
 * `PonsLaunchFactory`.
 */

/** Source-verified `PonsLaunchFactory`. */
export const PONS_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB';

/** TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256) */
export const TOKEN_LAUNCHED_TOPIC = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

/**
 * The only DEX config Pons uses (`dexConfigCount() === 1`) — Uniswap V3, 1% fee, tickSpacing 200,
 * routed through SwapRouter02 at 0xCaf681a66D020601342297493863E78C959E5cb2, which is already
 * `V3_ROUTER` in src/chain/uniswap.ts.
 */
export const PONS_POOL_FEE = 10_000;

/**
 * `restrictionBlocks` from the live launch config, in L1 blocks.
 *
 * Owner-mutable on the factory, so the watcher re-reads it and this is only the boot default. Two
 * L1 blocks ≈ 24s of capped trading after a ~12s dead window.
 */
export const DEFAULT_RESTRICTION_BLOCKS = 2;

export interface PonsLaunch {
  token: string;
  deployer: string;
  pool: string;
  /** The deployer's own atomic buy inside the launch tx, in wei. Ranges 0.0006–3.6 Ξ in practice. */
  initialBuyWei: bigint;
  /** From the event, already in L1 block units. */
  restrictionsEndBlock: number;
  /** L2 block the launch landed in. */
  block: number;
  txHash: string;
  /** Date.now() when we decoded it — the other half of the detect-latency measurement. */
  seenAt: number;
}

const addrFromWord = (w: string): string => `0x${w.slice(24)}`.toLowerCase();

/**
 * Decode a raw `TokenLaunched` log.
 *
 * Three indexed params arrive as topics (token, deployer, dexFactory); the remaining seven are
 * packed into `data` in declaration order — pairToken, pool, dexId, launchConfigId, positionId,
 * restrictionsEndBlock, initialBuyAmount. Returns null rather than throwing so one malformed log
 * can never stall the poll loop.
 */
export function decodeTokenLaunched(log: {
  topics: string[];
  data: string;
  blockNumber?: string | number;
  transactionHash?: string;
}): PonsLaunch | null {
  try {
    if (!log.topics?.[1] || !log.topics[2] || !log.data) return null;
    const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
    const word = (n: number) => d.slice(64 * n, 64 * (n + 1));
    if (d.length < 64 * 7) return null;
    return {
      token: `0x${log.topics[1].slice(26)}`.toLowerCase(),
      deployer: `0x${log.topics[2].slice(26)}`.toLowerCase(),
      pool: addrFromWord(word(1)),
      initialBuyWei: BigInt(`0x${word(6)}`),
      restrictionsEndBlock: Number(BigInt(`0x${word(5)}`)),
      block: typeof log.blockNumber === 'string' ? Number(BigInt(log.blockNumber)) : Number(log.blockNumber ?? 0),
      txHash: log.transactionHash ?? '',
      seenAt: Date.now(),
    };
  } catch {
    return null;
  }
}
