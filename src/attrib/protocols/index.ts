import { id } from 'ethers';
import { config } from '../../config/env.js';
import { POOL_MANAGER, V3_FACTORY, V3_ROUTER, PERMIT2, POSITION_MANAGER } from '../../chain/uniswap.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from '../../chain/receipt.js';
import { PONS_FACTORY, TOKEN_LAUNCHED_TOPIC } from '../../pons/config.js';
import { ADAPTER_REGISTRY_VERSION } from '../taxonomy.js';
import type { ProtocolAdapter, ProtocolFinding, TxContext, TxLogView } from './types.js';

/**
 * The protocol registry — an array that is iterated, not a chain of `if`s.
 *
 * Every constant here is imported from the module that already owns it
 * (`chain/uniswap.ts`, `chain/receipt.ts`, `pons/config.ts`). Re-deriving an
 * address or a topic hash in a second place is how two copies drift.
 *
 * NOTE ON UNISWAP V2: deliberately absent. This repo has no V2 knowledge and
 * inventing topic hashes for a venue we have not observed would create the
 * illusion of coverage. The unknown-topic leaderboard is the trigger: if the V2
 * Swap signature shows up there, that is the evidence to write the adapter.
 */

const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const topicAddr = (t: string | null | undefined): string | null =>
  t && t.length >= 42 ? `0x${t.slice(-40)}`.toLowerCase() : null;

// ── Event signatures ────────────────────────────────────────────────────────
const V3_MINT = id('Mint(address,address,int24,int24,uint128,uint256,uint256)').toLowerCase();
const V3_BURN = id('Burn(address,int24,int24,uint128,uint256,uint256)').toLowerCase();
const V3_COLLECT = id('Collect(address,address,int24,int24,uint128,uint128)').toLowerCase();
const V4_MODIFY_LIQUIDITY = id(
  'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)',
).toLowerCase();
const V4_DONATE = id('Donate(bytes32,address,uint256,uint256)').toLowerCase();
const NPM_INCREASE = id('IncreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const NPM_DECREASE = id('DecreaseLiquidity(uint256,uint128,uint256,uint256)').toLowerCase();
const NPM_COLLECT = id('Collect(uint256,address,uint256,uint256)').toLowerCase();
/** Observed 157× in a 30k-block sample; a fee claim, not a trade. */
const FEES_CLAIMED = id('FeesClaimed(address,address,address,address,uint256,uint256)').toLowerCase();
/** Observed 101×. A payout leg. */
const PAID = id('Paid(address,uint256)').toLowerCase();
const APPROVAL = id('Approval(address,address,uint256)').toLowerCase();
const WETH_DEPOSIT = id('Deposit(address,uint256)').toLowerCase();
const WETH_WITHDRAWAL = id('Withdrawal(address,uint256)').toLowerCase();
/**
 * Robinhood tokenized equities emit this beside every ERC-20 Transfer — a
 * UI-scaled MIRROR of a movement, not a movement. 4,781 occurrences in a
 * 30k-block sample, by far the largest single unknown before it was decoded.
 */
export const TRANSFER_WITH_SCALED_UI = id(
  'TransferWithScaledUI(address,address,uint256,uint256)',
).toLowerCase();

const find = (ctx: TxContext, sigs: string[]): TxLogView[] =>
  ctx.logs.filter((l) => sigs.includes(lc(l.topic0)));
const isBytes32 = (v: string | null | undefined): v is string => !!v && /^0x[0-9a-f]{64}$/i.test(v);

/**
 * The third non-indexed word of V4 ModifyLiquidity is `int256 liquidityDelta`.
 * Its sign distinguishes an add from a removal. Do not call every manager
 * modification an add: that would turn LP exits into a misleading label.
 */
function v4LiquidityKind(data: string | null | undefined): 'liquidity_add' | 'liquidity_remove' {
  if (!data || !/^0x[0-9a-f]*$/i.test(data) || data.length < 2 + 64 * 3) return 'liquidity_add';
  try {
    const raw = BigInt(`0x${data.slice(2 + 64 * 2, 2 + 64 * 3)}`);
    const signed = raw >= (1n << 255n) ? raw - (1n << 256n) : raw;
    return signed < 0n ? 'liquidity_remove' : 'liquidity_add';
  } catch {
    // An event shape we cannot decode is still non-trade evidence. Defaulting
    // the subtype affects reporting only; it never permits a BUY/SELL.
    return 'liquidity_add';
  }
}

/** Was this emitter's protocol identity actually established for this tx? */
function isVerified(ctx: TxContext, address: string, canonical: string[] = []): boolean {
  const a = lc(address);
  if (canonical.some((c) => c && lc(c) === a)) return true;
  return ctx.verifiedContracts?.has(a) ?? false;
}

function mk(
  a: Pick<ProtocolAdapter, 'id' | 'adapterVersion'>,
  ctx: TxContext,
  l: TxLogView,
  kind: ProtocolFinding['kind'],
  extra: Partial<ProtocolFinding> = {},
  canonical: string[] = [],
): ProtocolFinding {
  return {
    kind,
    protocolId: a.id,
    adapterVersion: a.adapterVersion,
    contract: lc(l.address),
    eventSig: lc(l.topic0),
    logIndex: l.logIndex,
    verified: isVerified(ctx, l.address, canonical),
    ...extra,
  };
}

// ── Uniswap V3 ──────────────────────────────────────────────────────────────
const uniswapV3: ProtocolAdapter = {
  id: 'uniswap-v3',
  name: 'Uniswap',
  version: 'v3',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { factory: lc(V3_FACTORY), router: lc(V3_ROUTER), positionManager: lc(POSITION_MANAGER) },
  events: {
    Swap: V3_SWAP_TOPIC,
    Mint: V3_MINT,
    Burn: V3_BURN,
    Collect: V3_COLLECT,
    IncreaseLiquidity: NPM_INCREASE,
    DecreaseLiquidity: NPM_DECREASE,
    CollectFees: NPM_COLLECT,
  },
  interpret(ctx) {
    const out: ProtocolFinding[] = [];
    const npm = lc(POSITION_MANAGER);
    // V3 Swap: topic2 is the recipient. Presence of a Swap proves nothing on its
    // own — the classifier checks the wallet's deltas, and `verified` records
    // whether this emitter is actually a pool of this factory.
    for (const l of find(ctx, [V3_SWAP_TOPIC])) {
      out.push(mk(this, ctx, l, 'swap', { beneficiary: topicAddr(l.topic2) }));
    }
    // Pool-emitted liquidity: only meaningful from a verified pool.
    for (const l of find(ctx, [V3_MINT])) {
      out.push(mk(this, ctx, l, 'liquidity_add', { beneficiary: topicAddr(l.topic1) }));
    }
    for (const l of find(ctx, [V3_BURN])) {
      out.push(mk(this, ctx, l, 'liquidity_remove', { beneficiary: topicAddr(l.topic1) }));
    }
    // Position-manager events are only ours when the POSITION MANAGER emitted
    // them. Anyone can deploy a contract emitting IncreaseLiquidity.
    for (const l of find(ctx, [NPM_INCREASE])) {
      if (lc(l.address) !== npm) continue;
      out.push(mk(this, ctx, l, 'liquidity_add', { beneficiary: topicAddr(l.topic1) }, [npm]));
    }
    for (const l of find(ctx, [NPM_DECREASE])) {
      if (lc(l.address) !== npm) continue;
      out.push(mk(this, ctx, l, 'liquidity_remove', { beneficiary: topicAddr(l.topic1) }, [npm]));
    }
    for (const l of find(ctx, [V3_COLLECT])) {
      out.push(mk(this, ctx, l, 'fee', { beneficiary: topicAddr(l.topic1) }));
    }
    for (const l of find(ctx, [NPM_COLLECT])) {
      if (lc(l.address) !== npm) continue;
      out.push(mk(this, ctx, l, 'fee', { beneficiary: null }, [npm]));
    }
    return out;
  },
};

/**
 * `FeesClaimed` and `Paid` are GENERIC signatures.
 *
 * They were originally claimed by the Uniswap V3 adapter from ANY emitter,
 * which would have made "some contract emitted Paid" globally mean "this wallet
 * collected fees" — the same class of error as "a Transfer means a buy". They
 * are now a separate, deliberately UNVERIFIED adapter: the findings are
 * recorded so the events are never invisible, but they carry `verified: false`
 * unless the emitter is independently established, and the classifier will not
 * settle a verdict on them alone.
 */
const genericFeeEvents: ProtocolAdapter = {
  id: 'generic-fee-events',
  name: 'Generic fee-like events',
  version: 'unscoped',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'observed-but-unsupported',
  contracts: {},
  events: { FeesClaimed: FEES_CLAIMED, Paid: PAID },
  interpret(ctx) {
    return find(ctx, [FEES_CLAIMED, PAID]).map((l) =>
      mk(this, ctx, l, 'fee', {
        beneficiary: topicAddr(l.topic1),
        note: 'generic fee signature; emitter identity not established',
      }),
    );
  },
};

// ── Uniswap V4 ──────────────────────────────────────────────────────────────
const uniswapV4: ProtocolAdapter = {
  id: 'uniswap-v4',
  name: 'Uniswap',
  version: 'v4',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { poolManager: lc(POOL_MANAGER) },
  events: { Swap: V4_SWAP_TOPIC, ModifyLiquidity: V4_MODIFY_LIQUIDITY, Donate: V4_DONATE },
  interpret(ctx) {
    const out: ProtocolFinding[] = [];
    // V4 is a singleton.  topic1 is the PoolId and topic2 is the sender (often
    // a router, not the user).  The PoolManager's identity, plus this complete
    // event shape, proves the protocol action; the wallet's net flow proves
    // who traded.  Never call topic2 the beneficiary.
    for (const l of find(ctx, [V4_SWAP_TOPIC])) {
      const poolId = isBytes32(l.topic1) ? lc(l.topic1) : null;
      const manager = lc(l.address) === lc(POOL_MANAGER);
      out.push(
        mk(this, ctx, l, 'swap', {
          beneficiary: null,
          poolId,
          // A topic match from another contract, or a malformed manager log,
          // is not V4 proof.  This overrides the generic canonical shortcut.
          verified: manager && poolId != null,
          note: manager
            ? poolId
              ? 'v4 PoolManager Swap; sender is not assumed to be the user'
              : 'malformed PoolManager Swap: missing PoolId'
            : 'Swap-shaped event from a non-PoolManager emitter',
        }),
      );
    }
    for (const l of find(ctx, [V4_MODIFY_LIQUIDITY])) {
      const poolId = isBytes32(l.topic1) ? lc(l.topic1) : null;
      const manager = lc(l.address) === lc(POOL_MANAGER);
      out.push(
        mk(this, ctx, l, v4LiquidityKind(l.data), {
          // IPoolManager calls this the address that modified the pool. It is
          // frequently a router, so it is never *assumed* to be the wallet;
          // classifier.ts only treats it as ours when it exactly matches.
          beneficiary: topicAddr(l.topic2),
          poolId,
          verified: manager && poolId != null,
          note: 'v4 ModifyLiquidity sender is not assumed to be the user',
        }),
      );
    }
    for (const l of find(ctx, [V4_DONATE])) {
      const poolId = isBytes32(l.topic1) ? lc(l.topic1) : null;
      const manager = lc(l.address) === lc(POOL_MANAGER);
      out.push(
        mk(this, ctx, l, 'donation', {
          beneficiary: topicAddr(l.topic2),
          poolId,
          verified: manager && poolId != null,
          note: 'v4 PoolManager Donate; sender is not assumed to be the user',
        }),
      );
    }
    return out;
  },
};

// ── Bags hook (V4) ──────────────────────────────────────────────────────────
const bagsHook: ProtocolAdapter = {
  id: 'uniswap-v4-bags-hook',
  name: 'Bags hook',
  version: 'v4-hook',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { hook: '0x2380abf72c17aabab76480244759ac7e2932eecc' },
  events: {},
  interpret(ctx) {
    // Hooked swaps still emit the standard V4 Swap; this only annotates that the
    // hook took its 2% cut, so fee-adjusted reconciliation can allow for it.
    const hit = ctx.logs.find((l) => lc(l.address) === this.contracts.hook);
    return hit
      ? [mk(this, ctx, hit, 'routing', { note: 'bags hook present (2% fee)' }, [this.contracts.hook ?? ''])]
      : [];
  },
};

// ── Universal router ────────────────────────────────────────────────────────
const universalRouter: ProtocolAdapter = {
  id: 'uniswap-universal-router',
  name: 'Universal Router',
  version: 'rh-fork',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { router: lc(config.SNIPER_ROUTER || '') },
  events: {},
  interpret(ctx) {
    // ROUTING EVIDENCE ONLY, never a swap finding. A transaction going to a
    // router says the caller used a router; it says nothing about whether this
    // wallet ended up with more or less of anything.
    if (!this.contracts.router || lc(ctx.txTo) !== this.contracts.router) return [];
    return [
      {
        kind: 'routing',
        protocolId: this.id,
        adapterVersion: this.adapterVersion,
        contract: this.contracts.router,
        eventSig: '',
        logIndex: -1,
        verified: true,
        note: 'tx destination is the universal router — routing only, not a trade',
      },
    ];
  },
};

// ── Pons launchpad ──────────────────────────────────────────────────────────
const ponsLaunch: ProtocolAdapter = {
  id: 'pons-launch',
  name: 'Pons',
  version: 'launchpad',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  // UNVERIFIED until fixtures from real Pons wallet transactions prove the
  // called contracts, the event signatures, the V3 pool/factory relationship
  // and the wallet's net asset exchange. "Pons has no bonding curve" is a claim
  // that has not been tested against a watched-wallet transaction yet, so it
  // must not be load-bearing.
  status: 'observed-but-unsupported',
  contracts: { factory: lc(PONS_FACTORY) },
  events: { TokenLaunched: lc(TOKEN_LAUNCHED_TOPIC) },
  interpret(ctx) {
    // Pons has NO bonding curve — it mints straight into a Uniswap V3 pool at
    // fee 10000, so a Pons buy IS a V3 swap. This only TAGS that swap; it never
    // produces a trade finding of its own.
    return find(ctx, [lc(TOKEN_LAUNCHED_TOPIC)]).map((l) =>
      mk(this, ctx, l, 'launch', { note: 'UNVERIFIED: no real Pons wallet fixture yet' }, [
        lc(PONS_FACTORY),
      ]),
    );
  },
};

// ── Permit2 (explicitly non-economic) ───────────────────────────────────────
const permit2: ProtocolAdapter = {
  id: 'permit2',
  name: 'Permit2',
  version: 'v1',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { permit2: lc(PERMIT2) },
  events: { Approval: APPROVAL },
  interpret(ctx) {
    return find(ctx, [APPROVAL]).map((l) => mk(this, ctx, l, 'approval'));
  },
};

// ── WETH wrap/unwrap ────────────────────────────────────────────────────────
const wrappedNative: ProtocolAdapter = {
  id: 'wrapped-native',
  name: 'WETH',
  version: 'v1',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'supported',
  contracts: { weth: lc(config.SNIPER_WETH || '') },
  events: { Deposit: WETH_DEPOSIT, Withdrawal: WETH_WITHDRAWAL },
  interpret(ctx) {
    const out: ProtocolFinding[] = [];
    const weth = this.contracts.weth;
    // Only the canonical WETH contract proves a native leg. Any token can emit
    // Deposit(address,uint256).
    for (const l of find(ctx, [WETH_DEPOSIT])) {
      if (weth && lc(l.address) !== weth) continue;
      out.push(mk(this, ctx, l, 'wrap', { beneficiary: topicAddr(l.topic1) }, [weth ?? '']));
    }
    for (const l of find(ctx, [WETH_WITHDRAWAL])) {
      if (weth && lc(l.address) !== weth) continue;
      out.push(mk(this, ctx, l, 'unwrap', { beneficiary: topicAddr(l.topic1) }, [weth ?? '']));
    }
    return out;
  },
};

// ── Robinhood tokenized equity mirror ───────────────────────────────────────
const rhScaledUi: ProtocolAdapter = {
  id: 'rh-scaled-ui-token',
  name: 'Robinhood tokenized equity',
  version: 'scaled-ui',
  adapterVersion: ADAPTER_REGISTRY_VERSION,
  status: 'observed-but-unsupported',
  contracts: {},
  events: { TransferWithScaledUI: TRANSFER_WITH_SCALED_UI },
  interpret(ctx) {
    return find(ctx, [TRANSFER_WITH_SCALED_UI]).map((l) => mk(this, ctx, l, 'no-op-mirror'));
  },
};

export const PROTOCOL_REGISTRY: ProtocolAdapter[] = [
  uniswapV3,
  genericFeeEvents,
  uniswapV4,
  bagsHook,
  universalRouter,
  ponsLaunch,
  permit2,
  wrappedNative,
  rhScaledUi,
];

/** Every event signature any adapter claims. Anything else is `unknown_topic`. */
export const KNOWN_EVENT_SIGS: Set<string> = new Set(
  PROTOCOL_REGISTRY.flatMap((p) => Object.values(p.events)).filter(Boolean),
);

export function runAdapters(ctx: TxContext): ProtocolFinding[] {
  return PROTOCOL_REGISTRY.flatMap((p) => {
    try {
      return p.interpret(ctx);
    } catch {
      // An adapter that throws must not take the transaction down with it; the
      // classifier will see fewer findings and fall through to unknown, which is
      // the honest result rather than a crash or a guess.
      return [];
    }
  });
}
