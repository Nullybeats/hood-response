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

function mk(
  a: Pick<ProtocolAdapter, 'id' | 'adapterVersion'>,
  l: TxLogView,
  kind: ProtocolFinding['kind'],
  extra: Partial<ProtocolFinding> = {},
): ProtocolFinding {
  return {
    kind,
    protocolId: a.id,
    adapterVersion: a.adapterVersion,
    contract: lc(l.address),
    eventSig: lc(l.topic0),
    logIndex: l.logIndex,
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
    // V3 Swap: topic2 is the recipient. That is the address the classifier will
    // check against the wallet — presence of a Swap alone proves nothing.
    for (const l of find(ctx, [V3_SWAP_TOPIC])) {
      out.push(mk(this, l, 'swap', { beneficiary: topicAddr(l.topic2) }));
    }
    for (const l of find(ctx, [V3_MINT, NPM_INCREASE])) {
      out.push(mk(this, l, 'liquidity_add', { beneficiary: topicAddr(l.topic1) }));
    }
    for (const l of find(ctx, [V3_BURN, NPM_DECREASE])) {
      out.push(mk(this, l, 'liquidity_remove', { beneficiary: topicAddr(l.topic1) }));
    }
    for (const l of find(ctx, [V3_COLLECT, NPM_COLLECT, FEES_CLAIMED, PAID])) {
      out.push(mk(this, l, 'fee', { beneficiary: topicAddr(l.topic1) }));
    }
    return out;
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
  events: { Swap: V4_SWAP_TOPIC, ModifyLiquidity: V4_MODIFY_LIQUIDITY },
  interpret(ctx) {
    const out: ProtocolFinding[] = [];
    // V4 is a singleton: topic1 is the sender, which for a routed swap is the
    // ROUTER, not the user. So beneficiary is intentionally left null — the
    // classifier must fall back to the wallet's own asset deltas. Claiming the
    // router as beneficiary here is exactly the mislabel this design forbids.
    for (const l of find(ctx, [V4_SWAP_TOPIC])) {
      out.push(mk(this, l, 'swap', { beneficiary: null, note: 'v4 sender is the router, not the user' }));
    }
    for (const l of find(ctx, [V4_MODIFY_LIQUIDITY])) {
      out.push(mk(this, l, 'liquidity_add', { beneficiary: null, note: 'sign of liquidityDelta not decoded' }));
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
    return hit ? [mk(this, hit, 'routing', { note: 'bags hook present (2% fee)' })] : [];
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
  status: 'supported',
  contracts: { factory: lc(PONS_FACTORY) },
  events: { TokenLaunched: lc(TOKEN_LAUNCHED_TOPIC) },
  interpret(ctx) {
    // Pons has NO bonding curve — it mints straight into a Uniswap V3 pool at
    // fee 10000, so a Pons buy IS a V3 swap. This only TAGS that swap; it never
    // produces a trade finding of its own.
    return find(ctx, [lc(TOKEN_LAUNCHED_TOPIC)]).map((l) => mk(this, l, 'launch'));
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
    return find(ctx, [APPROVAL]).map((l) => mk(this, l, 'approval'));
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
    for (const l of find(ctx, [WETH_DEPOSIT])) {
      out.push(mk(this, l, 'wrap', { beneficiary: topicAddr(l.topic1) }));
    }
    for (const l of find(ctx, [WETH_WITHDRAWAL])) {
      out.push(mk(this, l, 'unwrap', { beneficiary: topicAddr(l.topic1) }));
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
    return find(ctx, [TRANSFER_WITH_SCALED_UI]).map((l) => mk(this, l, 'no-op-mirror'));
  },
};

export const PROTOCOL_REGISTRY: ProtocolAdapter[] = [
  uniswapV3,
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
