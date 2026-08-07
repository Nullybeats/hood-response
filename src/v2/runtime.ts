/**
 * The v2 shadow pipeline: verified trade → facts → gate → score → lanes → diary.
 *
 * It observes and records. It emits nothing, dispatches nothing, and buys
 * nothing. The legacy engine remains the only thing on the wire until its
 * replacement has a measured record worth trusting — which is the entire point
 * of running it in shadow first, and the discipline the attribution work already
 * established in this repo.
 *
 * Enrichment arrives through injected providers rather than direct imports, for
 * the same reason the scorer takes its clock as an argument: a replay must be
 * able to substitute recorded values and reproduce the decision exactly. It also
 * keeps this module testable without a chain.
 *
 * The retry queue is what makes the unknown-law affordable. A sheet whose facts
 * have not landed yet is re-evaluated on a timer instead of being decided on
 * absent evidence — and if it never resolves, it is dropped with a reason
 * recorded, never quietly promoted to a pass.
 */

import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { SwapEvent } from '../types.js';
import { buildEntry, Diary, type DiaryEntry } from './diary.js';
import type { Outcome } from './facts/grade.js';
import { buildFactSheet, type FactSheet, type SheetInputs } from './facts/sheet.js';
import { gate, type GateVerdict } from './gate.js';
import { journal, type Journal } from './journal.js';
import { DEFAULT_LANES, evaluateLanes, type Lane } from './lanes.js';
import { scoreSheet } from './score.js';

/**
 * Everything the pipeline needs from the outside world.
 *
 * Each may legitimately answer "I don't know" (null), and the gate is what turns
 * that into a retry rather than a guess.
 */
export interface V2Providers {
  /** Verified market cap, or null when supply or price is unestablished. */
  marketCap(token: string): number | null;
  /** Hours since the pool was created, with the source that established it. */
  pairAge(token: string): { hours: number; source: string } | null;
  /** Sellability — null when no honeypot check has actually run. */
  canSell(token: string): boolean | null;
  /** Resolved outcome history for a wallet. Empty ⇒ ungraded (`U`). */
  outcomes(wallet: string): readonly Outcome[];
  /** Durable first-buy claim. Returns true at most once per (wallet, token). */
  claimFirstBuy(wallet: string, token: string, at: number, block: number): boolean;
}

export interface V2RuntimeOptions {
  /** How long other watched buys of the same token count as one crowd. */
  crowdWindowMs: number;
  /** How often pending sheets are re-evaluated. */
  retryIntervalMs: number;
  lanes: readonly Lane[];
}

export const DEFAULT_V2_RUNTIME_OPTIONS: V2RuntimeOptions = {
  crowdWindowMs: 300_000,
  retryIntervalMs: 3_000,
  lanes: DEFAULT_LANES,
};

interface Pending {
  trade: SwapEvent;
  firstSeenAt: number;
  attempts: number;
}

/** A recent verified buy, for crowd assembly. */
interface CrowdMark {
  wallet: string;
  at: number;
}

export class V2Shadow {
  readonly diary = new Diary();
  private readonly pending: Pending[] = [];
  private readonly crowd = new Map<string, CrowdMark[]>();
  private timer: NodeJS.Timeout | null = null;
  private seen = 0;
  private evaluated = 0;
  /** Per-fact tallies, so "which enrichment is actually landing" is answerable. */
  private coverage = new Map<string, { measured: number; unknown: number; failed: number }>();

  constructor(
    private readonly providers: V2Providers,
    private readonly opts: V2RuntimeOptions = DEFAULT_V2_RUNTIME_OPTIONS,
    private readonly jrnl: Journal = journal,
  ) {}

  get enabled(): boolean {
    return config.V2_SHADOW_ENABLED;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.drainPending(), this.opts.retryIntervalMs);
    this.timer.unref?.();
    logger.info(
      { lanes: this.opts.lanes.map((l) => l.id), journal: this.jrnl.enabled },
      'v2 shadow: observing verified trades (emits nothing)',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Offer a swap to the pipeline.
   *
   * Only strictly-verified trades are accepted. Anything else is not merely
   * lower quality — the shadow measured that ~90% of watched-wallet activity is
   * an airdrop the wallet never chose to receive.
   */
  onSwap(swap: SwapEvent): void {
    if (!this.enabled) return;
    if (swap.verifiedTrade !== true) return;
    if (swap.direction !== 'BUY') return;
    this.seen++;
    this.markCrowd(swap);
    this.jrnl.write('trade', swap);
    this.evaluate({ trade: swap, firstSeenAt: Date.now(), attempts: 0 }, Date.now());
  }

  /** Newest-first decisions, for the dashboard. */
  recent(limit = 100): DiaryEntry[] {
    return this.diary.recent(limit);
  }

  status(): Record<string, unknown> {
    const summary = this.diary.summary();
    return {
      enabled: this.enabled,
      journalEnabled: this.jrnl.enabled,
      journalStopped: this.jrnl.stoppedBecause,
      seen: this.seen,
      evaluated: this.evaluated,
      pending: this.pending.length,
      diarySize: this.diary.size,
      outcomes: summary.counts,
      nearMissesByLane: summary.nearMissesByLane,
      // Which facts are actually landing. A fact that is never measured is a
      // broken enrichment, and without this it would look like a quiet market.
      factCoverage: Object.fromEntries(
        [...this.coverage.entries()].map(([fact, c]) => {
          const total = c.measured + c.unknown + c.failed;
          return [fact, { ...c, measuredPct: total === 0 ? 0 : Math.round((c.measured / total) * 100) }];
        }),
      ),
      lanes: this.opts.lanes.map((l) => ({ id: l.id, emoji: l.emoji, name: l.name, sentence: l.sentence })),
    };
  }

  /** Build, gate, score, judge, record. */
  private evaluate(p: Pending, now: number): void {
    const sheet = this.buildSheet(p.trade, now);
    const verdict = gate(sheet, p.attempts, now - p.firstSeenAt);

    if (verdict.decision === 'retry') {
      p.attempts++;
      // Journal the wait too: a sheet that never resolves is itself a finding
      // about enrichment, not an absence to be inferred later.
      this.pending.push(p);
      this.record(sheet, verdict, now, true);
      return;
    }
    this.record(sheet, verdict, now, false);
  }

  private record(sheet: FactSheet, verdict: GateVerdict, now: number, pendingOnly: boolean): void {
    this.tallyCoverage(sheet);
    const score = scoreSheet(sheet);
    const lanes = verdict.decision === 'pass' ? evaluateLanes(sheet, score, this.opts.lanes) : [];
    const entry = buildEntry(sheet, verdict, score, lanes, {
      lanes: this.opts.lanes.map((l) => l.id),
      crowdWindowMs: this.opts.crowdWindowMs,
    });

    this.jrnl.write('facts', sheet);
    this.jrnl.write('gate', verdict);
    if (!pendingOnly) {
      this.jrnl.write('score', score);
      this.jrnl.write('verdict', entry);
      this.evaluated++;
    }
    this.diary.record(entry);

    if (entry.outcome === 'matched') {
      logger.info(
        { token: sheet.tokenSymbol, score: score.score, lanes: entry.matchedLanes },
        'v2 shadow: WOULD HAVE ALERTED (nothing emitted)',
      );
    }
  }

  private buildSheet(trade: SwapEvent, now: number): FactSheet {
    const age = this.providers.pairAge(trade.token);
    const inputs: SheetInputs = {
      marketCap: this.providers.marketCap(trade.token),
      pairAgeHours: age?.hours ?? null,
      pairAgeSource: age?.source ?? null,
      canSell: this.providers.canSell(trade.token),
      outcomesByWallet: this.outcomesFor(trade, now),
      crowdWallets: this.crowdFor(trade.token, trade.wallet, now),
      // Claimed once, on first sight; a retry must not re-ask and get `false`
      // the second time, which would erase the very fact it is waiting on.
      firstBuy: this.firstBuyMemo(trade),
      rotatedFrom: null,
    };
    return buildFactSheet(
      {
        txHash: trade.txHash,
        wallet: trade.wallet,
        token: trade.token,
        tokenSymbol: trade.tokenSymbol,
        blockNumber: trade.blockNumber,
        at: trade.timestamp,
        venue: trade.verifiedCategory ?? 'verified_swap',
        usdValue: trade.usdValue,
      },
      inputs,
      now,
    );
  }

  private readonly firstBuyClaims = new Map<string, boolean>();

  private firstBuyMemo(trade: SwapEvent): boolean {
    const key = `${trade.wallet.toLowerCase()}:${trade.token.toLowerCase()}:${trade.txHash}`;
    const cached = this.firstBuyClaims.get(key);
    if (cached != null) return cached;
    const claimed = this.providers.claimFirstBuy(trade.wallet, trade.token, trade.timestamp, trade.blockNumber);
    this.firstBuyClaims.set(key, claimed);
    if (this.firstBuyClaims.size > 5_000) {
      // Bounded; the durable registry is the real memory, this only spans retries.
      const oldest = this.firstBuyClaims.keys().next().value;
      if (oldest) this.firstBuyClaims.delete(oldest);
    }
    return claimed;
  }

  private outcomesFor(trade: SwapEvent, now: number): Map<string, readonly Outcome[]> {
    const m = new Map<string, readonly Outcome[]>();
    m.set(trade.wallet.toLowerCase(), this.providers.outcomes(trade.wallet));
    for (const w of this.crowdFor(trade.token, trade.wallet, now)) {
      m.set(w.toLowerCase(), this.providers.outcomes(w));
    }
    return m;
  }

  private markCrowd(swap: SwapEvent): void {
    const key = swap.token.toLowerCase();
    const marks = this.crowd.get(key) ?? [];
    marks.push({ wallet: swap.wallet.toLowerCase(), at: swap.timestamp });
    this.crowd.set(key, marks);
    if (this.crowd.size > 2_000) {
      const oldest = this.crowd.keys().next().value;
      if (oldest) this.crowd.delete(oldest);
    }
  }

  /** Distinct watched wallets that bought this token inside the window, including this one. */
  private crowdFor(token: string, wallet: string, now: number): string[] {
    const marks = this.crowd.get(token.toLowerCase()) ?? [];
    const fresh = marks.filter((m) => now - m.at <= this.opts.crowdWindowMs);
    this.crowd.set(token.toLowerCase(), fresh);
    const set = new Set(fresh.map((m) => m.wallet));
    set.add(wallet.toLowerCase());
    return [...set];
  }

  private drainPending(): void {
    if (this.pending.length === 0) return;
    const now = Date.now();
    const batch = this.pending.splice(0, this.pending.length);
    for (const p of batch) this.evaluate(p, now);
  }

  private tallyCoverage(sheet: FactSheet): void {
    const facts: [string, { provenance: string }][] = [
      ['walletGrade', sheet.walletGrade],
      ['pairAgeHours', sheet.pairAgeHours],
      ['marketCap', sheet.marketCap],
      ['canSell', sheet.canSell],
      ['buyUsd', sheet.buyUsd],
      ['crowdGpa', sheet.crowdGpa],
    ];
    for (const [name, f] of facts) {
      const c = this.coverage.get(name) ?? { measured: 0, unknown: 0, failed: 0 };
      if (f.provenance === 'measured') c.measured++;
      else if (f.provenance === 'failed') c.failed++;
      else c.unknown++;
      this.coverage.set(name, c);
    }
  }
}
