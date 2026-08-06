import { CLASSIFIER_VERSION, RETRIABLE_UNKNOWN, type Category, type Evidence } from './taxonomy.js';
import { allSchedulerStats, type SchedulerStats } from './scheduler.js';
import type { PoolVerifierStats } from './poolVerify.js';
import type { AttributionLedger } from './ledger.js';
import type { FinalityStatus } from './finality.js';
import { traceCoverageLabel, tracesUsable, type TraceCapability } from './traces.js';

/**
 * The accounting report.
 *
 * FIVE STATES, KEPT SEPARATE ON PURPOSE. Collapsing any two of them is how a
 * correct pipeline gets misread as a broken one:
 *
 *   observed        a (tx, wallet) pair entered the universe at all
 *   attributed      it reached a verdict of any kind
 *   eligibleTrade   that verdict was a confirmed trade
 *   liveEmitted     the LIVE listener emitted a swap for it
 *   unprovenNoTrace it could not be decided because traces do not exist here
 *
 * A low `eligibleTrade` count means one of several very different things, and
 * the difference matters enormously:
 *
 *   many observed, many attributed, few trades   -> the wallets are not trading
 *   many observed, few attributed                -> ingestion is failing
 *   many attributed, many unprovenNoTrace        -> a SOURCE limitation, not a
 *                                                   quiet chain and not a bug
 *
 * Only the first is a fact about the market. The other two are facts about us.
 * This file exists so nobody has to guess which one they are looking at.
 */

export interface TraceDecision {
  /** Cases that could not be decided for want of a trace. */
  insufficientTraceCount: number;
  /** As a share of attributed pairs. */
  insufficientTracePct: number;
  /**
   * One token leg moved and `tx.value` was zero — the classic shape of a native
   * counter-leg travelling through internal calls, invisible to receipts.
   */
  oneSidedNoTopLevelValue: number;
  /**
   * Of those, how many also had a VERIFIED pool emit a Swap. These are the
   * plausible trades a trace provider would actually recover.
   */
  plausibleSwaps: number;
  /** No verified swap present — traces would most likely not help. */
  clearlyUnrelated: number;
  /**
   * How many currently-live signals would change verdict if traces existed.
   * This is the number that decides whether a trace provider is worth it.
   */
  liveSignalsAffected: number;
  /** Plain-language verdict for the report header. */
  recommendation: string;
}

/**
 * First-run operational picture.
 *
 * These exist to answer the question a first run always raises: is a low
 * confirmed-trade count a fact about the chain, or about how hard we were
 * throttling ourselves? Without queue depth and cache hit rate recorded while
 * they happen, that is unanswerable afterwards.
 */
export interface PipelineHealth {
  schedulers: SchedulerStats[];
  pools: PoolVerifierStats | null;
  /**
   * Pairs whose verdict is retriable — `verification_pending` and
   * `no_receipt_available`. NOT settled unknowns. Reported separately so a
   * backlog is never read as a conclusion.
   */
  retriableUnknownPairs: number;
  /** Settled unknowns: verification ran, no trusted provenance. */
  unsupportedProtocolPairs: number;
}

export interface SourceHealth {
  /** Per (operation, host, kind) failure counts. */
  failures: { operation: string; source_host: string; failure_kind: string; disposition: string; n: number }[];
  retriableFailures: number;
  terminalFailures: number;
  /** Pairs waiting on a retriable fetch. */
  pendingPairs: number;
}

export interface AccountingReport {
  /** EXACTLY what this report covers. Never "full coverage". */
  scope: string;
  classifierVersion: number;
  window: { fromBlock: number; toBlock: number };

  observed: number;
  attributed: number;
  eligibleTrade: number;
  liveEmitted: number;
  unprovenNoTrace: number;

  /** attributed / (attributed + pending + drift) — pending IS in the denominator. */
  accountedRatio: number;
  drift: number;
  unknownRate: number;

  byCategory: { outcome: string; category: string; n: number }[];
  unknownTopics: { event_sig: string; contract: string; n: number }[];

  finality: FinalityStatus;
  traceCapability: { label: string; usable: boolean; matrix: TraceCapability[] };
  traceDecision: TraceDecision;
  source: SourceHealth;
  pipeline: PipelineHealth;

  /** Everything this report does NOT establish. Read before the numbers. */
  caveats: string[];
}

/** Rows the ledger hands back for the trace analysis. */
export interface TraceGapRow {
  evidence: Evidence;
  /** Did the live listener emit a swap for this same pair? */
  liveEmitted: boolean;
}

export function traceDecision(rows: TraceGapRow[], attributed: number): TraceDecision {
  const gaps = rows.filter((r) => r.evidence.traceGap);
  const oneSidedNoValue = gaps.filter(
    (r) => r.evidence.traceGap!.oneSidedDelta && !r.evidence.traceGap!.hadTopLevelValue,
  );
  const plausible = oneSidedNoValue.filter((r) => r.evidence.traceGap!.hadVerifiedSwap);
  const unrelated = gaps.length - plausible.length;
  const liveAffected = plausible.filter((r) => r.liveEmitted).length;
  const pct = attributed > 0 ? (gaps.length / attributed) * 100 : 0;

  // The decision is arithmetic, not taste. A structural floor only justifies a
  // dedicated provider if it actually contains plausible trades.
  let recommendation: string;
  if (gaps.length === 0) {
    recommendation = 'no trace-blocked cases in this window — a trace provider would add nothing';
  } else if (plausible.length === 0) {
    recommendation =
      'trace-blocked cases exist but none carry a verified swap — they look unrelated, so traces would likely not recover trades';
  } else if (pct < 2 && plausible.length < 5) {
    recommendation =
      'the trace-blocked floor is small; a dedicated provider is complexity for little gain';
  } else {
    recommendation =
      'a meaningful share of plausible watched-wallet trades is trace-blocked — worth sourcing a trace-capable provider for ASYNCHRONOUS attribution only, never the live detection hot path';
  }

  return {
    insufficientTraceCount: gaps.length,
    insufficientTracePct: Math.round(pct * 10) / 10,
    oneSidedNoTopLevelValue: oneSidedNoValue.length,
    plausibleSwaps: plausible.length,
    clearlyUnrelated: unrelated,
    liveSignalsAffected: liveAffected,
    recommendation,
  };
}

export interface BuildReportInput {
  ledger: AttributionLedger;
  finality: FinalityStatus;
  traceMatrix: TraceCapability[];
  traceRows: TraceGapRow[];
  fromBlock: number;
  toBlock: number;
  liveEmitted: number;
  classifierVersion?: number;
  /** Omitted in offline/replay runs, where no scheduler ran. */
  poolStats?: PoolVerifierStats | null;
  schedulerStats?: SchedulerStats[];
}

export function buildReport(input: BuildReportInput): AccountingReport {
  const cv = input.classifierVersion ?? CLASSIFIER_VERSION;
  const { ledger } = input;
  const a = ledger.accountedForRange(cv, input.fromBlock, input.toBlock);
  const byCategory = ledger.coverageRange(cv, input.fromBlock, input.toBlock);
  const total = byCategory.reduce((s, r) => s + r.n, 0);
  const trades = byCategory
    .filter((r) => r.outcome === 'confirmed_trade')
    .reduce((s, r) => s + r.n, 0);
  const unknown = byCategory
    .filter((r) => r.outcome === 'unknown_unsupported')
    .reduce((s, r) => s + r.n, 0);
  const noTrace = byCategory
    .filter((r) => r.category === 'insufficient_trace_data')
    .reduce((s, r) => s + r.n, 0);

  const failures = ledger.failureRates();
  const denom = a.attributed + a.pending + a.drift;
  const usable = tracesUsable(input.traceMatrix);
  const traceProbed = input.traceMatrix.length > 0;

  const catCount = (c: Category): number =>
    byCategory.filter((r) => r.category === c).reduce((s, r) => s + r.n, 0);
  const retriableUnknownPairs = [...RETRIABLE_UNKNOWN].reduce((s, c) => s + catCount(c), 0);
  const unsupportedProtocolPairs = catCount('unsupported_protocol');
  const pools = input.poolStats ?? null;

  const caveats: string[] = [
    'SCOPE: top-level transaction coverage (sender + recipient) plus ERC-20 Transfer-log coverage. Not "full coverage".',
    !traceProbed
      ? 'Trace capability has not been probed for this source. Native/internal value flow must remain unproven; do not read this as trace support being unavailable.'
      : usable
      ? 'Traces are available on this source; native/internal flow is resolvable.'
      : 'Traces are UNAVAILABLE on this source, so native/internal value flow is PERMANENTLY unprovable here. `insufficient_trace_data` is a structural floor, not a backlog.',
    'These are ACCOUNTING COVERAGE numbers. They are not trade recall and not precision — neither is measurable without an independently adjudicated set.',
    'A confirmed trade requires a VERIFIED pool. Pools whose identity could not be established are reported as unsupported, not as non-trades.',
    'Mixed protocol actions (liquidity + swap in one transaction) are SUPPRESSED pending action-level decomposition, not classified.',
  ];
  if (input.finality.provisional) {
    caveats.push(
      `PROVISIONAL: ${input.finality.provisionalBlocks} blocks of this window sit above the safe head and may be invalidated by a reorg.`,
    );
  }
  if (a.pending > 0) {
    caveats.push(
      `${a.pending} pairs are awaiting a retriable fetch. They are counted in the denominator, not excluded.`,
    );
  }
  if (retriableUnknownPairs > 0) {
    caveats.push(
      `${retriableUnknownPairs} pairs are unknown because VERIFICATION OR FETCH HAS NOT COMPLETED (throttle, timeout, queue lag) — this is a backlog, NOT a finding about those contracts. It is reported separately from the ${unsupportedProtocolPairs} pairs where verification ran and established no trusted provenance.`,
    );
  }
  if (pools && pools.uniqueAwaitingVerification > 0) {
    caveats.push(
      `${pools.uniqueAwaitingVerification} unique pools still await verification; their swaps cannot yet be confirmed or denied.`,
    );
  }
  const throttled = (input.schedulerStats ?? allSchedulerStats()).reduce(
    (s, x) => s + x.rateLimitRetries,
    0,
  );
  if (throttled > 0) {
    caveats.push(
      `${throttled} rate-limit retries occurred. A depressed confirmed-trade count in this window may reflect ingestion throughput, not market activity.`,
    );
  }
  if (a.drift !== 0) {
    caveats.push(`DRIFT ${a.drift}: observed pairs with neither a verdict nor a pending retry. This is a bug.`);
  }

  return {
    scope:
      'top-level transaction coverage (sender + recipient) + ERC-20 Transfer-log coverage; trace coverage: ' +
      (!traceProbed ? 'not probed' : usable ? 'available' : 'unavailable'),
    classifierVersion: cv,
    window: { fromBlock: input.fromBlock, toBlock: input.toBlock },
    observed: a.pairs,
    attributed: a.attributed,
    eligibleTrade: trades,
    liveEmitted: input.liveEmitted,
    unprovenNoTrace: noTrace,
    accountedRatio: denom > 0 ? a.attributed / denom : 0,
    drift: a.drift,
    unknownRate: total > 0 ? unknown / total : 0,
    byCategory,
    unknownTopics: ledger.unknownTopics(20),
    finality: input.finality,
    traceCapability: {
      label: traceCoverageLabel(input.traceMatrix),
      usable,
      matrix: input.traceMatrix,
    },
    traceDecision: traceDecision(input.traceRows, a.attributed),
    source: {
      failures,
      retriableFailures: failures.filter((f) => f.disposition === 'retriable').reduce((s, f) => s + f.n, 0),
      terminalFailures: failures.filter((f) => f.disposition === 'terminal').reduce((s, f) => s + f.n, 0),
      pendingPairs: a.pending,
    },
    pipeline: {
      schedulers: input.schedulerStats ?? allSchedulerStats(),
      pools,
      retriableUnknownPairs,
      unsupportedProtocolPairs,
    },
    caveats,
  };
}
