import { classifyTransaction, walletDeltas } from '../attrib/classifier.js';
import { makeEthCall, PoolVerifier } from '../attrib/poolVerify.js';
import type { TxContext, TxLogView } from '../attrib/protocols/types.js';
import { isValidCallTrace, nativeDeltasFromCallTrace } from '../attrib/traces.js';
import type { AttributionResult } from '../attrib/taxonomy.js';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { Direction } from '../types.js';
import { addressToTopic, type DecodedTransfer, type EthLog } from './decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from './receipt.js';
import { logHttpFailure, logRpcError, logRpcThrow } from './rpcLog.js';
import { schedulerFor } from '../attrib/scheduler.js';

type RawLog = { address?: string; topics?: string[]; data?: string; logIndex?: string | number };
type RawReceipt = { status?: string; blockNumber?: string; logs?: RawLog[] } | null;
type RawTx = { to?: string | null; input?: string; value?: string } | null;

export interface LiveTradeVerdict {
  /** The old receipt rule, retained only for shadow reconciliation. */
  legacyCandidate: boolean;
  /** The single authoritative live decision: only this may reach alerts/snipes. */
  confirmed: boolean;
  category: string;
  reason: string;
  /**
   * The two facts that distinguish an allocation from garbage, carried out of
   * the verifier because the listener cannot re-derive them without refetching
   * the receipt. A DISTRIBUTION (allocation/airdrop worth routing to the v2
   * shadow) is: receipt succeeded, the trigger transfer is genuinely in it, and
   * there is no swap event. A reverted tx or a transfer absent from its own
   * receipt is neither a trade nor a distribution — it is nothing.
   */
  receiptOk?: boolean;
  exactTransfer?: boolean;
}

export type V4PoolMembershipResolver = (poolId: string, token: string) => Promise<'verified' | 'mismatch' | 'pending'>;

interface Bundle {
  receipt: Exclude<RawReceipt, null>;
  tx: Exclude<RawTx, null>;
}

const lc = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const hexNumber = (n: string | number | undefined): number => {
  if (typeof n === 'number') return n;
  if (!n) return -1;
  try { return Number(BigInt(n)); } catch { return -1; }
};

/** A small semaphore keeps receipt and trace work bounded even when a WS burst arrives. */
class BoundedWork {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function exactReceiptTransfer(receipt: Exclude<RawReceipt, null>, log: EthLog): boolean {
  const wantedIndex = hexNumber(log.logIndex);
  return (receipt.logs ?? []).some((candidate) =>
    lc(candidate.address) === lc(log.address) &&
    lc(candidate.topics?.[0]) === lc(log.topics[0]) &&
    lc(candidate.topics?.[1]) === lc(log.topics[1]) &&
    lc(candidate.topics?.[2]) === lc(log.topics[2]) &&
    lc(candidate.data) === lc(log.data) &&
    (wantedIndex < 0 || hexNumber(candidate.logIndex) === wantedIndex),
  );
}

function toContext(bundle: Bundle, transfer: DecodedTransfer, wallet: string, verifiedContracts: Set<string>): TxContext {
  const logs: TxLogView[] = (bundle.receipt.logs ?? []).map((l, index) => ({
    address: lc(l.address),
    topic0: l.topics?.[0] ? lc(l.topics[0]) : null,
    topic1: l.topics?.[1] ? lc(l.topics[1]) : null,
    topic2: l.topics?.[2] ? lc(l.topics[2]) : null,
    topic3: l.topics?.[3] ? lc(l.topics[3]) : null,
    data: l.data ? lc(l.data) : null,
    logIndex: hexNumber(l.logIndex) >= 0 ? hexNumber(l.logIndex) : index,
  }));
  return {
    txHash: transfer.txHash,
    logs,
    wallet: lc(wallet),
    walletTopic: addressToTopic(wallet).toLowerCase(),
    txTo: bundle.tx.to ? lc(bundle.tx.to) : null,
    selector: bundle.tx.input?.slice(0, 10).toLowerCase() ?? null,
    nativeValueWei: bundle.tx.value ?? null,
    receiptStatus: bundle.receipt.status ?? null,
    verifiedContracts,
  };
}

/**
 * Pure terminal check shared by the live RPC path and fixtures.  It deliberately
 * checks direction against the NET token delta: a receipt can contain several
 * transfers of the same token, so the trigger log alone is never an economic
 * direction proof.
 */
export function verifiedTransferVerdict(
  ctx: TxContext,
  transfer: DecodedTransfer,
  direction: Direction,
  exactReceiptMatch: boolean,
  extraDeltas: ReturnType<typeof nativeDeltasFromCallTrace> = [],
): LiveTradeVerdict {
  if (!exactReceiptMatch) return { legacyCandidate: false, confirmed: false, category: 'no_exact_receipt_transfer', reason: 'trigger transfer is absent from receipt' };
  const legacyCandidate =
    ctx.receiptStatus === '0x1' &&
    ctx.logs.some((l) => l.topic0 === V3_SWAP_TOPIC || l.topic0 === V4_SWAP_TOPIC);
  if (!legacyCandidate) return { legacyCandidate, confirmed: false, category: 'no_successful_swap_receipt', reason: 'receipt is reverted or has no V3/V4 Swap topic' };

  const result: AttributionResult = classifyTransaction({ ctx, extraDeltas });
  const triggerDelta = walletDeltas(ctx).find((d) => lc(d.token) === lc(transfer.token));
  let directionMatches = false;
  try {
    const net = triggerDelta ? BigInt(triggerDelta.rawDelta) : 0n;
    directionMatches = direction === 'BUY' ? net > 0n : net < 0n;
  } catch {
    directionMatches = false;
  }
  const confirmed = result.outcome === 'confirmed_trade' && directionMatches;
  return {
    legacyCandidate,
    confirmed,
    category: confirmed ? result.category : directionMatches ? result.category : 'trigger_direction_not_net_exchange',
    reason: confirmed
      ? 'successful receipt, canonical/verified V3/V4 swap, and wallet net exchange proved'
      : directionMatches
        ? `strict classifier suppressed: ${result.category}`
        : 'trigger transfer direction does not match wallet net token exchange',
  };
}

/**
 * Per-process transaction verifier for the live listener.
 *
 * Receipt+transaction context is single-flight and bounded, V3 provenance is
 * cached by PoolVerifier, and traces are requested only after receipt evidence
 * proves that a one-sided native/internal leg could change the verdict.
 */
export class LiveTradeVerifier {
  private readonly pools = new PoolVerifier(makeEthCall(config.CHAIN_HTTP_URL));
  private readonly bundles = new Map<string, Promise<Bundle | null>>();
  private readonly receiptWork = new BoundedWork(4);
  private readonly traceWork = new BoundedWork(2);
  private readonly maxBundles = 2_048;

  constructor(private readonly v4PoolContainsToken?: V4PoolMembershipResolver) {}

  async verify(log: EthLog, transfer: DecodedTransfer, wallet: string, direction: Direction): Promise<LiveTradeVerdict> {
    const bundle = await this.bundle(transfer.txHash);
    if (!bundle) return { legacyCandidate: false, confirmed: false, category: 'no_receipt_available', reason: 'receipt or transaction unavailable' };
    // Stamped on every bundle-backed verdict below via `facts`: the listener
    // needs these to tell a distribution from a revert without a second fetch.
    const exact = exactReceiptTransfer(bundle.receipt, log);
    const facts = { receiptOk: bundle.receipt.status === '0x1', exactTransfer: exact };
    if (bundle.receipt.status !== '0x1' || !exact) {
      return { ...verifiedTransferVerdict(toContext(bundle, transfer, wallet, new Set()), transfer, direction, exact), ...facts };
    }

    const provisional = toContext(bundle, transfer, wallet, new Set());
    const v3Emitters = [...new Set(provisional.logs
      .filter((l) => l.topic0 === V3_SWAP_TOPIC && /^0x[0-9a-f]{40}$/.test(l.address))
      .map((l) => l.address))];
    // A transaction with an absurd number of V3-shaped emitters is not normal
    // swap traffic. Bound work and leave the classifier in its safe unverified
    // state instead of making an attacker control our RPC bill.
    for (const pool of v3Emitters.slice(0, 8)) await this.pools.verifyV3(pool);
    const verified = this.pools.verifiedSet();
    const txTo = provisional.txTo;
    if (txTo && config.liveVerifiedEntryContracts.has(txTo)) verified.add(txTo);
    let ctx = toContext(bundle, transfer, wallet, verified);
    ctx.pendingContracts = this.pools.pendingSet();
    let verdict = verifiedTransferVerdict(ctx, transfer, direction, exact);

    // The V4 Swap event carries a PoolId but not its currencies. Verify the
    // token against the canonical Initialize key before a V4 result can become
    // a live trade: a nearby Manager swap in another pool must not bless an
    // unrelated wallet transfer in a batched transaction.
    if (verdict.confirmed && this.v4PoolContainsToken && ctx.logs.some((l) => l.topic0 === V4_SWAP_TOPIC)) {
      const ids = [...new Set(ctx.logs
        .filter((l) => l.topic0 === V4_SWAP_TOPIC && /^0x[0-9a-f]{64}$/.test(l.topic1 ?? ''))
        .map((l) => lc(l.topic1)))];
      // A routed V4 trade can legitimately cross several pools; the output
      // token belongs to the final pool, not every hop. Require it to appear
      // in AT LEAST one canonical key. A missing proof stays pending unless a
      // different hop has already established the association.
      const memberships = await Promise.all(ids.map((id) => this.v4PoolContainsToken!(id, transfer.token)));
      if (!memberships.includes('verified')) {
        const pending = memberships.includes('pending');
        return {
          legacyCandidate: verdict.legacyCandidate,
          confirmed: false,
          category: pending ? 'v4_pool_key_pending' : 'v4_pool_token_mismatch',
          reason: pending
            ? 'canonical V4 PoolKey provenance is not available yet'
            : 'no canonical V4 PoolKey in this transaction contains the trigger token',
          ...facts,
        };
      }
    }

    // Receipt logs prove two ERC-20 legs themselves. Trace only the narrow
    // one-leg bucket, where native ETH may be the missing payment proof.
    if (verdict.category === 'insufficient_trace_data' && config.liveTradeTraceRpcUrl) {
      const deltas = await this.traceNativeDeltas(transfer.txHash, wallet);
      verdict = verifiedTransferVerdict(ctx, transfer, direction, exact, deltas);
    }
    return { ...verdict, ...facts };
  }

  private async bundle(txHash: string): Promise<Bundle | null> {
    if (!txHash) return null;
    const hit = this.bundles.get(txHash);
    if (hit) return hit;
    const load = this.receiptWork.run(async () => {
      const [receipt, tx] = await Promise.all([
        this.rpc<RawReceipt>(config.CHAIN_HTTP_URL, 'eth_getTransactionReceipt', [txHash], 'live'),
        this.rpc<RawTx>(config.CHAIN_HTTP_URL, 'eth_getTransactionByHash', [txHash], 'live'),
      ]);
      return receipt && tx && Array.isArray(receipt.logs) ? { receipt, tx } : null;
    });
    this.bundles.set(txHash, load);
    if (this.bundles.size > this.maxBundles) this.bundles.delete(this.bundles.keys().next().value as string);
    return load;
  }

  private async traceNativeDeltas(txHash: string, wallet: string) {
    const url = config.liveTradeTraceRpcUrl;
    return this.traceWork.run(async () => {
      const trace = await this.rpc<unknown>(url, 'debug_traceTransaction', [txHash, { tracer: 'callTracer' }], 'normal', 20_000);
      if (!isValidCallTrace(trace)) return [];
      return nativeDeltasFromCallTrace(trace, wallet);
    });
  }

  private async rpc<T>(url: string, method: string, params: unknown[], priority: 'live' | 'normal', timeoutMs = 8_000): Promise<T | null> {
    if (!url) return null;
    const sched = schedulerFor(url);
    try {
      return await sched.run(async () => {
        const response = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
        });
        const rpcCtx = { op: 'live-trade-verify', url, method };
        if (!response.ok) {
          logHttpFailure(rpcCtx, response.status, response.statusText);
          if (response.status === 429 || response.status === 503) sched.penalise(1_000);
          return null;
        }
        const body = await response.json() as { result?: T; error?: unknown };
        if (body.error) {
          logRpcError(rpcCtx, body.error);
          return null;
        }
        return body.result ?? null;
      }, priority);
    } catch (err) {
      logRpcThrow({ op: 'live-trade-verify', url, method }, err);
      return null;
    }
  }
}

/**
 * Running tally of what promoting the gate would actually change.
 *
 * The promotion contract requires a reviewed 24–48h window, but the only record
 * of a mismatch was a log line — and `railway logs` returns a short tail, so the
 * one number the decision depends on ("how many live signals would the strict
 * verifier have suppressed?") was unanswerable in practice. Counting it here
 * makes the review a reading rather than an archaeology exercise.
 *
 * In memory and cheap: it describes this process's observations, and the
 * durable evidence remains the attribution ledger.
 */
interface ShadowTally {
  /** Verdicts seen since boot. */
  evaluated: number;
  /** Passed the legacy receipt test — i.e. what the live path accepts today. */
  legacyCandidate: number;
  /** Proven trades under the strict contract. */
  confirmed: number;
  /**
   * Legacy accepted, strict refused. THIS is what flipping the gate suppresses,
   * and the number that has to be small and explainable before promoting.
   */
  wouldSuppress: number;
  /** Strict confirmed something the legacy test rejected. Expected to be zero. */
  wouldAdd: number;
  /** Why the suppressed ones were refused, most common first. */
  suppressedByCategory: Record<string, number>;
  since: number;
}

const tally: ShadowTally = {
  evaluated: 0,
  legacyCandidate: 0,
  confirmed: 0,
  wouldSuppress: 0,
  wouldAdd: 0,
  suppressedByCategory: {},
  since: Date.now(),
};

/** Snapshot for the attribution endpoint, so the gate review is a lookup. */
export function liveTradeShadowTally(): ShadowTally & { wouldSuppressPct: number; hours: number } {
  const pct = tally.legacyCandidate === 0 ? 0 : (tally.wouldSuppress / tally.legacyCandidate) * 100;
  return {
    ...tally,
    suppressedByCategory: { ...tally.suppressedByCategory },
    wouldSuppressPct: Math.round(pct * 10) / 10,
    hours: Math.round(((Date.now() - tally.since) / 3_600_000) * 10) / 10,
  };
}

export function logLiveTradeShadow(txHash: string, verdict: LiveTradeVerdict): void {
  tally.evaluated++;
  if (verdict.legacyCandidate) tally.legacyCandidate++;
  if (verdict.confirmed) tally.confirmed++;
  if (verdict.legacyCandidate === verdict.confirmed) return;
  if (verdict.legacyCandidate && !verdict.confirmed) {
    tally.wouldSuppress++;
    tally.suppressedByCategory[verdict.category] = (tally.suppressedByCategory[verdict.category] ?? 0) + 1;
  } else {
    tally.wouldAdd++;
  }
  logger.warn(
    { tx: txHash, legacyCandidate: verdict.legacyCandidate, confirmedTrade: verdict.confirmed, category: verdict.category },
    'live trade shadow mismatch',
  );
}
