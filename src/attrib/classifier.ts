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

  // 2. LIQUIDITY AND FEES BEFORE SWAP. A single-sided / zap liquidity add swaps
  //    half the input first and therefore emits a Swap in the same transaction.
  //    `chain/receipt.ts` checks swap-presence with no liquidity test at all, so
  //    it accepts exactly this shape and emits it as a wallet BUY. Ordering the
  //    checks this way is the fix.
  //
  //    Attribution still matters: in a batched transaction the liquidity may
  //    belong to someone else, in which case we fall through rather than
  //    mislabel this wallet's leg.
  const oursLiq = liq.filter((f) => f.beneficiary == null || isWallet(f.beneficiary, ctx.wallet));
  if (oursLiq.length > 0) {
    const removing = oursLiq.some((f) => f.kind === 'liquidity_remove');
    return result(
      removing ? 'liquidity_remove' : 'liquidity_add',
      ev('liquidity event present; checked before swap because zap adds also emit a Swap'),
    );
  }
  const oursFees = fees.filter((f) => f.beneficiary == null || isWallet(f.beneficiary, ctx.wallet));
  if (oursFees.length > 0 && swaps.length === 0) {
    return result('fee_collection', ev('fee/collect event with no swap'));
  }

  // 3. THE ECONOMIC-EXCHANGE GATE.
  const up = deltas.filter((d) => BigInt(d.rawDelta) > 0n);
  const down = deltas.filter((d) => BigInt(d.rawDelta) < 0n);
  const wrapped = findings.filter(
    (f) => (f.kind === 'wrap' || f.kind === 'unwrap') && isWallet(f.beneficiary, ctx.wallet),
  );
  const nativeLeg = wrapped.length > 0 || (ctx.nativeValueWei != null && ctx.nativeValueWei !== '0');
  const bothSides = up.length > 0 && down.length > 0;
  const oneSidePlusNative = (up.length > 0 || down.length > 0) && nativeLeg;

  if (swaps.length > 0) {
    if (bothSides || oneSidePlusNative) {
      const isPons = findings.some((f) => f.kind === 'launch');
      const isV4 = swaps.some((f) => f.protocolId === 'uniswap-v4');
      const hooked = findings.some((f) => f.protocolId === 'uniswap-v4-bags-hook');
      const category = isPons
        ? 'pons_launch_buy'
        : isV4
          ? hooked
            ? 'swap_v4_hooked'
            : 'swap_v4_poolmanager'
          : 'swap_v3_router';
      return result(category, ev('swap present and wallet asset deltas demonstrate an exchange'));
    }
    if (up.length === 0 && down.length === 0) {
      // A swap happened; this wallet's balances did not move. Someone else traded.
      return result(
        'ambiguous_multiparty',
        ev('swap present but no net asset movement for this wallet'),
      );
    }
    // One leg only and no visible native counter-leg. The missing side may have
    // moved as internal native value, which receipts cannot show — `tx.value`
    // covers only the top-level call. Refuse to guess in either direction.
    return result(
      'insufficient_trace_data',
      ev('swap present, only one asset leg visible for this wallet; native/internal flow unprovable from receipts'),
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
