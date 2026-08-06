import { TRANSFER_TOPIC } from '../chain/decoder.js';
import { KNOWN_EVENT_SIGS, runAdapters } from './protocols/index.js';
import type { ProtocolFinding, TxContext, TxLogView } from './protocols/types.js';
import {
  emptyEvidence,
  result,
  type AttributionResult,
  type Evidence,
  type WalletDelta,
} from './taxonomy.js';

/**
 * The canonical classifier — a PURE function over an already-fetched bundle.
 *
 * Purity is deliberate: it means a replay over stored receipts produces exactly
 * the verdict the live path produced, so "did this rule change help?" is
 * answerable without re-fetching the chain, and fixtures are trivial.
 *
 * The rule that governs everything below: a `confirmed_trade` requires a
 * DEMONSTRATED ECONOMIC EXCHANGE ATTRIBUTABLE TO THE WATCHED WALLET — assets
 * given up and assets received. Not "a Swap happened nearby". Not "the
 * destination was a router". Not "a tracked wallet received a token". Those
 * three inferences are, respectively, the bug in `chain/receipt.ts`, the trap
 * the universal-router adapter exists to avoid, and the entire behaviour of the
 * old engine, which turned 453 non-trade movements into BUY/SELL labels.
 */

const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const topicAddr = (t: string | null | undefined): string | null =>
  t && t.length >= 42 ? `0x${t.slice(-40)}`.toLowerCase() : null;

export interface ClassifyInput {
  ctx: TxContext;
  /** Decimals per token, when known. Absent decimals never block a verdict. */
  decimals?: Record<string, number>;
  /**
   * Deltas the receipt cannot show — native movement recovered from an
   * execution trace, or an explicit `insufficient_trace_data` marker recording
   * that a leg exists but could not be read. Supplied by the ingester, which is
   * the only component that knows whether the source has traces at all.
   */
  extraDeltas?: WalletDelta[];
}

/**
 * Net ERC-20 movement for the watched wallet, computed from ALL Transfer logs in
 * the transaction — never from the single trigger log, which by construction
 * shows only one leg and so can never demonstrate an exchange.
 */
export function walletDeltas(ctx: TxContext, decimals: Record<string, number> = {}): WalletDelta[] {
  const net = new Map<string, bigint>();
  for (const l of ctx.logs) {
    if (lc(l.topic0) !== TRANSFER_TOPIC) continue;
    const from = topicAddr(l.topic1);
    const to = topicAddr(l.topic2);
    // A 4-topic Transfer is ERC-721 (tokenId indexed) — a position NFT, not a
    // fungible amount. Counting its tokenId as a balance would be nonsense.
    if (l.topic3) continue;
    let v: bigint;
    try {
      v = BigInt(l.data && l.data !== '0x' ? l.data : '0x0');
    } catch {
      continue;
    }
    const token = lc(l.address);
    if (to === ctx.wallet) net.set(token, (net.get(token) ?? 0n) + v);
    if (from === ctx.wallet) net.set(token, (net.get(token) ?? 0n) - v);
  }
  return [...net.entries()]
    .filter(([, v]) => v !== 0n)
    .map(([token, v]) => ({
      token,
      rawDelta: v.toString(),
      decimals: decimals[token] ?? null,
      source: 'erc20_logs' as const,
    }));
}

function buildEvidence(ctx: TxContext, findings: ProtocolFinding[], deltas: WalletDelta[], note?: string): Evidence {
  const e = emptyEvidence();
  e.topics = [...new Set(ctx.logs.map((l) => lc(l.topic0)).filter(Boolean))];
  e.contracts = [...new Set(findings.map((f) => f.contract).filter(Boolean))];
  e.logIndices = findings.map((f) => f.logIndex).filter((i) => i >= 0);
  e.selector = ctx.selector;
  e.protocols = [...new Set(findings.map((f) => f.protocolId))];
  e.deltas = deltas;
  if (note) e.note = note;
  return e;
}

const isWallet = (a: string | null | undefined, wallet: string): boolean => !!a && lc(a) === wallet;

/** Did the watched wallet send anything at all in this transaction? */
function walletSentSomething(ctx: TxContext): boolean {
  return ctx.logs.some(
    (l) => lc(l.topic0) === TRANSFER_TOPIC && topicAddr(l.topic1) === ctx.wallet,
  );
}

export function classifyTransaction(input: ClassifyInput): AttributionResult {
  const { ctx } = input;
  const findings = runAdapters(ctx);
  const deltas = [...walletDeltas(ctx, input.decimals ?? {}), ...(input.extraDeltas ?? [])];
  const ev = (note?: string): Evidence => buildEvidence(ctx, findings, deltas, note);

  // 1. A reverted transaction moved nothing, whatever its logs suggest.
  if (ctx.receiptStatus != null && ctx.receiptStatus !== '0x1') {
    return result('failed_tx', ev('receipt status is not 0x1'));
  }

  const liq = findings.filter((f) => f.kind === 'liquidity_add' || f.kind === 'liquidity_remove');
  const donations = findings.filter((f) => f.kind === 'donation');
  const fees = findings.filter((f) => f.kind === 'fee');
  const swaps = findings.filter((f) => f.kind === 'swap');

  // Scope every protocol finding to THIS wallet and to a VERIFIED emitter.
  //
  // A topic hash is not an identity — anyone can deploy a contract emitting
  // `Paid(address,uint256)` or `Swap(...)`. And in a batched transaction the
  // liquidity may belong to a third party. Both filters are required before a
  // finding may influence a verdict.
  const ours = (f: ProtocolFinding): boolean =>
    f.verified && (f.beneficiary == null || isWallet(f.beneficiary, ctx.wallet));
  // V4 ModifyLiquidity's indexed sender is typically a router.  With no
  // explicit beneficiary, it cannot be charged to this wallet; otherwise a
  // third party adding liquidity in the same batch would suppress a real swap.
  const oursLiq = liq.filter((f) => ours(f) && !(f.protocolId === 'uniswap-v4' && f.beneficiary == null));
  const oursDonations = donations.filter(ours);
  const oursFees = fees.filter(ours);
  const oursSwaps = swaps.filter((f) => f.verified);

  // 2. NET FLOW DECIDES — there is no blanket "liquidity present ⇒ not a trade".
  //    A zap, a rebalance or a multi-action batch legitimately contains BOTH a
  //    liquidity modification and a swap. Declaring such a transaction a
  //    non-trade would hide a real trade; declaring it a trade would resurrect
  //    the `chain/receipt.ts` defect. So protocol findings are gathered first,
  //    and the wallet's own net flow is what resolves which it was.
  // Token legs only. A native trace delta proves the NATIVE side and must not
  // also be counted as one of the two token legs, or a single-sided trade would
  // appear to have both.
  const tokenDeltas = deltas.filter(
    (d) => d.source === 'erc20_logs' || d.source === 'weth_wrap_logs',
  );
  const up = tokenDeltas.filter((d) => BigInt(d.rawDelta) > 0n);
  const down = tokenDeltas.filter((d) => BigInt(d.rawDelta) < 0n);
  const wrapped = findings.filter(
    (f) => (f.kind === 'wrap' || f.kind === 'unwrap') && f.verified && isWallet(f.beneficiary, ctx.wallet),
  );

  // Native proof is broader than WETH events. A user may legitimately pay native
  // ETH straight to a verified protocol entry point, where there is no
  // Deposit/Withdrawal to find; requiring one would misclassify a real buy.
  //
  // Accepted proofs, in order of directness:
  //   a) a canonical WETH Deposit/Withdrawal crediting this wallet
  //   b) top-level tx.value sent to a VERIFIED entry point
  //   c) an execution trace showing native value moving to/from this wallet
  //
  // (c) is POSITIVE proof and is distinct from `insufficient_trace_data`, which
  // is the ABSENCE of proof. Conflating them — as an earlier revision did by
  // reading the failure marker as evidence — would confirm trades on data we
  // explicitly could not read.
  const paidNativeToProtocol =
    ctx.nativeValueWei != null &&
    ctx.nativeValueWei !== '0' &&
    ctx.txTo != null &&
    (ctx.verifiedContracts?.has(lc(ctx.txTo)) ?? false);
  const traceNativeProven = deltas.some(
    (d) => d.source === 'trace_native' && BigInt(d.rawDelta) !== 0n,
  );
  const traceUnreadable = deltas.some((d) => d.source === 'insufficient_trace_data');
  const nativeLeg = wrapped.length > 0 || paidNativeToProtocol || traceNativeProven;

  const bothSides = up.length > 0 && down.length > 0;
  const exchangeProven = bothSides || ((up.length > 0 || down.length > 0) && nativeLeg);
  const liqOrFee = oursLiq.length > 0 || oursDonations.length > 0 || oursFees.length > 0;
  // V4's unlock model permits multiple pool actions under a router. When a
  // verified manager liquidity/donation action shares a receipt with a swap,
  // even an un-attributable `sender` is enough to make wallet-level deltas
  // ambiguous. Suppress it until we can decompose actions, rather than letting
  // a zap or router batch through as a clean trade.
  const undecomposedV4Action = [...liq, ...donations].some(
    (f) => f.verified && f.protocolId === 'uniswap-v4',
  );

  if (oursSwaps.length > 0 && (liqOrFee || undecomposedV4Action)) {
    // MIXED PROTOCOL ACTIONS ARE CURRENTLY SUPPRESSED PENDING ACTION-LEVEL
    // DECOMPOSITION.
    //
    // Stated precisely, because it is easy to overclaim: this branch does NOT
    // attempt to resolve the transaction from net flow. Net flow alone cannot
    // separate the swap leg of a zap from its liquidity leg — both legs net
    // into the same wallet-level delta vector, so a rebalance and a buy-then-LP
    // are indistinguishable without attributing individual asset movements to
    // individual protocol actions.
    //
    // Until an adapter can decompose them, the honest answer is "unresolved",
    // and unresolved is suppressed for live alerts. Do not read this as
    // "zap/rebalance trades are classified accurately" — they are not
    // classified at all yet, and the size of this bucket is the measure of how
    // much that costs.
    return result(
      'mixed_or_ambiguous_activity',
      ev('verified swap and verified liquidity/fee both attributable to this wallet; not decomposed'),
    );
  }

  if (liqOrFee && oursSwaps.length === 0) {
    if (oursLiq.length > 0) {
      const removing = oursLiq.some((f) => f.kind === 'liquidity_remove');
      return result(removing ? 'liquidity_remove' : 'liquidity_add', ev('liquidity event, no swap'));
    }
    if (oursDonations.length > 0) {
      return result('pool_donation', ev('verified V4 donation, no swap'));
    }
    return result('fee_collection', ev('verified fee/collect event, no swap'));
  }

  // 3. THE ECONOMIC-EXCHANGE GATE.
  if (oursSwaps.length > 0) {
    if (exchangeProven) {
      const isPons = findings.some((f) => f.kind === 'launch' && f.verified);
      const isV4 = oursSwaps.some((f) => f.protocolId === 'uniswap-v4');
      const hooked = findings.some((f) => f.protocolId === 'uniswap-v4-bags-hook' && f.verified);
      const category = isPons
        ? 'pons_launch_buy'
        : isV4
          ? hooked
            ? 'swap_v4_hooked'
            : 'swap_v4_poolmanager'
          : 'swap_v3_router';
      return result(category, ev('verified swap and wallet asset deltas demonstrate an exchange'));
    }
    if (up.length === 0 && down.length === 0) {
      return result(
        'ambiguous_multiparty',
        ev('swap present but no net asset movement for this wallet'),
      );
    }
    const gapEv = ev(
      traceUnreadable
        ? 'swap present; a native leg is known to exist but the trace could not be read'
        : 'swap present, one asset leg only; native/internal flow unprovable from receipts',
    );
    // Quantify the gap so the trace-provider decision is arithmetic, not taste.
    gapEv.traceGap = {
      oneSidedDelta: up.length + down.length === 1,
      hadTopLevelValue: ctx.nativeValueWei != null && ctx.nativeValueWei !== '0',
      hadVerifiedSwap: oursSwaps.length > 0,
    };
    return result('insufficient_trace_data', gapEv);
  }

  // An unverified swap is evidence of something, but never of a trade.
  //
  // WHY THIS SPLITS IN TWO. Both branches decline to confirm a trade, so the
  // live behaviour is identical — but they are opposite claims about why, and
  // only one of them is an answer. `unsupported_protocol` says verification ran
  // and the trusted anchor disowned this emitter; that is settled and cacheable.
  // `verification_pending` says we never got to ask, because of a throttle, a
  // timeout, or queue lag. Reporting the second as the first would convert an
  // infrastructure backlog into a permanent verdict about a contract's identity
  // — the same absence-as-data error the old engine made, with the sign flipped.
  if (swaps.length > 0 && oursSwaps.length === 0) {
    const stillPending = ctx.pendingContracts;
    const unresolved = stillPending
      ? swaps.filter((f) => !f.verified && stillPending.has(lc(f.contract)))
      : [];
    if (unresolved.length > 0) {
      return result(
        'verification_pending',
        ev(
          `swap-shaped event from ${unresolved.length} emitter(s) whose verification has not completed — retry, do not conclude`,
        ),
      );
    }
    return result(
      'unsupported_protocol',
      ev('swap-shaped event from an emitter whose protocol identity was checked and not established'),
    );
  }

  // 4. No swap, no liquidity. Tokens arrived and nothing left → given, not bought.
  const incomingOnly = up.length > 0 && down.length === 0 && !walletSentSomething(ctx);
  if (incomingOnly) return result('airdrop_receive', ev('incoming transfer with no counter-leg'));

  // 5. Approvals and wraps with no other economic content.
  if (findings.length > 0 && findings.every((f) => f.kind === 'approval')) {
    return result('approval_or_permit_only', ev('approval only'));
  }
  if (wrapped.length > 0 && deltas.length <= 1) {
    return result('wrap_or_unwrap', ev('native wrap/unwrap'));
  }

  // 6. Unrecognised, potentially-economic events must not be laundered into
  //    "plain transfer". Whatever we cannot name stays unknown, and is counted
  //    with its signature so the leaderboard says which adapter to write next.
  const unknownSigs = ctx.logs
    .map((l) => lc(l.topic0))
    .filter((t) => t && t !== TRANSFER_TOPIC && !KNOWN_EVENT_SIGS.has(t));
  if (unknownSigs.length > 0) {
    return result('unknown_topic', ev(`unrecognised event signatures: ${unknownSigs.slice(0, 4).join(',')}`));
  }

  // 7. Only Transfers (and no-op mirrors) remain.
  if (deltas.length === 0) {
    return result('unrelated_or_no_net_trade', ev('no net movement for this wallet'));
  }
  const mirrorOnly = findings.length > 0 && findings.every((f) => f.kind === 'no-op-mirror');
  if (mirrorOnly) {
    return result('ui_scaled_mirror', ev('scaled-UI mirror of a plain transfer'));
  }
  return result('plain_transfer', ev('token movement with no DEX event in the transaction'));
}
