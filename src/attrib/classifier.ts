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
  const deltas = walletDeltas(ctx, input.decimals ?? {});
  const ev = (note?: string): Evidence => buildEvidence(ctx, findings, deltas, note);

  // 1. A reverted transaction moved nothing, whatever its logs suggest.
  if (ctx.receiptStatus != null && ctx.receiptStatus !== '0x1') {
    return result('failed_tx', ev('receipt status is not 0x1'));
  }

  const liq = findings.filter((f) => f.kind === 'liquidity_add' || f.kind === 'liquidity_remove');
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
  const oursLiq = liq.filter(ours);
  const oursFees = fees.filter(ours);
  const oursSwaps = swaps.filter((f) => f.verified);

  // 2. NET FLOW DECIDES — there is no blanket "liquidity present ⇒ not a trade".
  //    A zap, a rebalance or a multi-action batch legitimately contains BOTH a
  //    liquidity modification and a swap. Declaring such a transaction a
  //    non-trade would hide a real trade; declaring it a trade would resurrect
  //    the `chain/receipt.ts` defect. So protocol findings are gathered first,
  //    and the wallet's own net flow is what resolves which it was.
  const up = deltas.filter((d) => BigInt(d.rawDelta) > 0n);
  const down = deltas.filter((d) => BigInt(d.rawDelta) < 0n);
  const wrapped = findings.filter(
    (f) => (f.kind === 'wrap' || f.kind === 'unwrap') && f.verified && isWallet(f.beneficiary, ctx.wallet),
  );

  // Native proof is broader than WETH events. A user may legitimately pay native
  // ETH straight to a verified protocol entry point, in which case there is no
  // Deposit/Withdrawal to find. Accepted proofs, in order of directness:
  //   a) a WETH Deposit/Withdrawal crediting this wallet
  //   b) top-level tx.value sent BY this wallet TO a verified entry point
  //   c) an internal native transfer from a trace (delta_source === 'trace')
  // Anything else leaves the native leg unproven.
  const paidNativeToProtocol =
    ctx.nativeValueWei != null &&
    ctx.nativeValueWei !== '0' &&
    ctx.txTo != null &&
    (ctx.verifiedContracts?.has(lc(ctx.txTo)) ?? false);
  const traceNative = deltas.some((d) => d.source === 'insufficient_trace_data');
  const nativeLeg = wrapped.length > 0 || paidNativeToProtocol;

  const bothSides = up.length > 0 && down.length > 0;
  const exchangeProven = bothSides || ((up.length > 0 || down.length > 0) && nativeLeg);
  const liqOrFee = oursLiq.length > 0 || oursFees.length > 0;

  if (oursSwaps.length > 0 && liqOrFee) {
    // Both kinds of activity are present and attributable to this wallet.
    // Genuinely unresolved without decomposing the transaction, so it is
    // recorded as unresolved — and suppressed for live alerts — rather than
    // being forced into either bucket.
    return result(
      'mixed_or_ambiguous_activity',
      ev('both liquidity/fee and swap activity attributable to this wallet; net flow does not resolve which'),
    );
  }

  if (liqOrFee && oursSwaps.length === 0) {
    if (oursLiq.length > 0) {
      const removing = oursLiq.some((f) => f.kind === 'liquidity_remove');
      return result(removing ? 'liquidity_remove' : 'liquidity_add', ev('liquidity event, no swap'));
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
    return result(
      'insufficient_trace_data',
      ev(
        traceNative
          ? 'swap present; native leg known to exist but not readable'
          : 'swap present, one asset leg only; native/internal flow unprovable from receipts',
      ),
    );
  }

  // An unverified swap is evidence of something, but never of a trade.
  if (swaps.length > 0 && oursSwaps.length === 0) {
    return result(
      'unsupported_protocol',
      ev('swap-shaped event from an emitter whose protocol identity was not established'),
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
