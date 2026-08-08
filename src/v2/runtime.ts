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
import type { SwapEvent, WalletTier } from '../types.js';
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
  /** How much of the outcome record is usable, for the status endpoint. Optional. */
  outcomeStats?(): { wallets: number; calls: number };
  /** Static seed holder-rank tier for a wallet, or null when not in the catalog. */
  seedTier?(wallet: string): WalletTier | null;
  /**
   * Value a token amount at the CURRENT price, for trades whose usdValue was
   * null at detection time. Recovers the `howMuch` dial on new pairs; the fact
   * records that it came from a later price.
   */
  usdValueNow?(token: string, amount: number): number | null;
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
  /** What arrived versus what this pipeline acts on. See onSwap. */
  private readonly intake = {
    total: 0,
    unverified: 0,
    verifiedSells: 0,
    verifiedBuys: 0,
    distributions: 0,
    /** Same-token allocations collapsed by the cooldown — an airdrop wave counted once. */
    distributionsCooled: 0,
  };
  /** Last time a distribution sheet was built per token; the airdrop-wave collapser. */
  private readonly distSeenAt = new Map<string, number>();

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
    this.restoreDiary();
    this.timer = setInterval(() => this.drainPending(), this.opts.retryIntervalMs);
    this.timer.unref?.();
    logger.info(
      { lanes: this.opts.lanes.map((l) => l.id), journal: this.jrnl.enabled, restored: this.diary.size },
      'v2 shadow: observing verified trades (emits nothing)',
    );
  }

  /**
   * Repopulate the diary from the journal on boot.
   *
   * The diary is in memory, so a redeploy blanked the dashboard even though the
   * record on disk was intact — during an afternoon of frequent deploys that was
   * indistinguishable from a broken pipeline. The journal is the durable copy;
   * this just makes the page reflect it.
   *
   * Restored entries are NOT re-counted as `seen` or `evaluated`: those describe
   * what this process has done, and inflating them with history would misreport
   * throughput. Only the readable record comes back.
   */
  private restoreDiary(): void {
    if (!this.jrnl.enabled) return;
    try {
      const records = this.jrnl.tail('verdict', 200);
      // tail() is newest-first; record() unshifts, so replay oldest-first to
      // preserve ordering.
      for (const rec of records.reverse()) {
        const entry = rec.body as DiaryEntry;
        if (entry?.txHash && entry.outcome) this.diary.record(entry);
      }
      if (records.length > 0) {
        logger.info({ restored: records.length }, 'v2 shadow: diary restored from journal');
      }
    } catch (err) {
      // A page that starts blank is a nuisance; a boot that fails is an outage.
      logger.warn({ err: String(err).slice(0, 160) }, 'v2 shadow: could not restore diary');
    }
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
    // Counted, not merely dropped. A pipeline that silently discards its input
    // is indistinguishable from a broken one — which is the exact failure the
    // diary exists to prevent, and it applied to intake too: watched wallets
    // spent an evening selling, every sell was correctly verified and correctly
    // ignored, and the dashboard showed a blank page with no way to tell that
    // from an outage.
    this.intake.total++;

    // Distributions: allocations/airdrops — the 47e1 signal, typed honestly.
    if (swap.distribution === true) {
      this.intake.distributions++;
      // An airdrop wave hits many watched wallets with the same token in the
      // same minute. One sheet per token per crowd window is the measurement;
      // 122 identical sheets are a bill (each would warm quotes and safety).
      const key = swap.token.toLowerCase();
      const last = this.distSeenAt.get(key) ?? 0;
      if (Date.now() - last < this.opts.crowdWindowMs) {
        this.intake.distributionsCooled++;
        return;
      }
      this.distSeenAt.set(key, Date.now());
      if (this.distSeenAt.size > 2_000) {
        const oldest = this.distSeenAt.keys().next().value;
        if (oldest) this.distSeenAt.delete(oldest);
      }
      this.seen++;
      this.jrnl.write('trade', swap);
      this.evaluate({ trade: swap, firstSeenAt: Date.now(), attempts: 0 }, Date.now());
      return;
    }

    if (swap.verifiedTrade !== true) {
      this.intake.unverified++;
      return;
    }
    if (swap.direction !== 'BUY') {
      // A verified sell gets a diary line — 'observed', no buy reasoning — so a
      // stretch of selling is visible instead of reading as an outage. Also the
      // raw material the rug radar will consume.
      this.intake.verifiedSells++;
      this.recordSell(swap);
      return;
    }
    this.intake.verifiedBuys++;
    this.seen++;
    this.markCrowd(swap);
    this.jrnl.write('trade', swap);
    this.evaluate({ trade: swap, firstSeenAt: Date.now(), attempts: 0 }, Date.now());
  }

  /** Minimal entry for a verified sell: recorded, journaled, never laned or scored. */
  private recordSell(swap: SwapEvent): void {
    const usd = swap.usdValue ?? this.providers.usdValueNow?.(swap.token, swap.amount) ?? null;
    const entry: DiaryEntry = {
      at: swap.timestamp,
      token: swap.token.toLowerCase(),
      tokenSymbol: swap.tokenSymbol,
      wallet: swap.wallet.toLowerCase(),
      txHash: swap.txHash,
      eventType: 'verified-sell',
      outcome: 'observed',
      reason: `verified sell${usd != null ? ` — ~$${Math.round(usd).toLocaleString()}` : ''} of ${swap.tokenSymbol}`,
      score: null,
      matchedLanes: [],
      nearMiss: null,
      lanes: [],
      configSnapshot: {},
    };
    this.jrnl.write('trade', swap);
    this.jrnl.write('verdict', entry);
    this.diary.record(entry);
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
      // Why the decision list may legitimately be empty: this brain reasons
      // about buying, so a stretch of verified SELLS produces no decisions and
      // is not a fault.
      intake: { ...this.intake },
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
      // How many wallets actually have a track record. While this is 0 every
      // wallet grades U, the `who` dial drops out, and any lane requiring a
      // grade cannot match — so a lane firing nothing is explained here rather
      // than mistaken for a quiet market.
      grades: this.providers.outcomeStats?.() ?? null,
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
      // A distribution is not a buy: it must never claim the (wallet, token)
      // pair in the durable registry, or the wallet's later REAL first buy
      // would no longer read as first.
      firstBuy: trade.distribution === true ? false : this.firstBuyMemo(trade),
      rotatedFrom: null,
      eventType: trade.distribution === true ? 'distribution' : 'verified-buy',
      seedTier: this.providers.seedTier?.(trade.wallet) ?? null,
      usdValueLate:
        trade.usdValue == null ? (this.providers.usdValueNow?.(trade.token, trade.amount) ?? null) : null,
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
