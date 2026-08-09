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
import { V2_RULES_EPOCH_MS } from './epoch.js';
import { buildMatch, type V2Match } from './emit.js';
import type { Outcome } from './facts/grade.js';
import { buildFactSheet, type FactSheet, type SheetInputs } from './facts/sheet.js';
import { gate, type GateVerdict } from './gate.js';
import { journal, type Journal } from './journal.js';
import { DEFAULT_LANES, evaluateLanes, type Lane } from './lanes.js';
import type { OutcomeLedger } from './ledger.js';
import { scoreSheet, type ScoreResult } from './score.js';

/**
 * Everything the pipeline needs from the outside world.
 *
 * Each may legitimately answer "I don't know" (null), and the gate is what turns
 * that into a retry rather than a guess.
 */
export interface V2Providers {
  /**
   * Verified market cap, or null when supply or price is unestablished.
   *
   * `warm` asks whether it is worth spending a network round trip to go and
   * FIND OUT when the answer is not already cached. False never changes the
   * answer — an unknown cap stays unknown either way — it only declines to pay
   * for one that no lane could act on. See `worthPricing`.
   */
  marketCap(token: string, warm?: boolean): number | null;
  /** Hours since the pool was created, with the source that established it. */
  pairAge(token: string, warm?: boolean): { hours: number; source: string } | null;
  /** Sellability — null when no honeypot check has actually run. */
  canSell(token: string): boolean | null;
  /** Resolved outcome history for a wallet. Empty ⇒ ungraded (`U`). */
  outcomes(wallet: string): readonly Outcome[];
  /** Durable first-buy claim. Returns true at most once per (wallet, token). */
  claimFirstBuy(wallet: string, token: string, at: number, block: number): boolean;
  /** How much of the outcome record is usable, for the status endpoint. Optional. */
  outcomeStats?(): { wallets: number; calls: number; basis?: string };
  /**
   * Per-wallet grades with their justification. Optional: a grade nobody can
   * interrogate is not verifiable, and while every wallet reads `U` this is what
   * distinguishes "no record yet" from "the pipeline is broken".
   */
  reportCard?(now: number): { walletId: string; grade: string; index: number | null; sample: number; reason: string }[];
  /** Static seed holder-rank tier for a wallet, or null when not in the catalog. */
  seedTier?(wallet: string): WalletTier | null;
  /** Opaque public handle for an address. Emitted signals never carry the address itself. */
  walletIdOf?(address: string): string;
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
  /**
   * How long an allocation waits before it is judged, so the wave can be counted.
   *
   * A decision fires on the FIRST event, when a seeding of one and an airdrop to
   * forty are indistinguishable — which makes any solo condition a no-op unless
   * we let the window fill first. 47e1's record says that distinction is worth
   * 90% versus 0%, so it is worth the delay.
   *
   * [config] 90s. Well inside the gate's 180s patience, and allocations are a
   * leading indicator measured in hours — the edge is being early to the LAUNCH,
   * not to the airdrop. A live buy path would need a much tighter number.
   */
  distributionSettleMs: number;
  lanes: readonly Lane[];
}

export const DEFAULT_V2_RUNTIME_OPTIONS: V2RuntimeOptions = {
  crowdWindowMs: 300_000,
  retryIntervalMs: 3_000,
  distributionSettleMs: 90_000,
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
  /** When each intake type last arrived — the freshness half of every counter. */
  private readonly intakeLastAt: Record<string, number | null> = {
    any: null,
    verifiedBuy: null,
    verifiedSell: null,
    distribution: null,
    unverified: null,
  };

  /**
   * Distinct watched wallets that touched each token inside the window, whether
   * by buying or by being allocated.
   *
   * Kept separate from `crowd` on purpose: `crowd` feeds the crowdSize/crowdGpa
   * FACTS, which describe wallets that chose to buy. Folding allocation
   * recipients into that would restate "forty wallets were airdropped" as "forty
   * wallets bought" — the exact 47e1 lie this rebuild exists to stop telling.
   * This map is for the ledger's solo-vs-wave measurement only.
   */
  private readonly cohort = new Map<string, CrowdMark[]>();

  /**
   * Transactions already emitted, so one decision produces one signal.
   *
   * A sheet legitimately goes `waiting → matched` as its facts land, and a later
   * re-evaluation can match MORE lanes — without this, each pass would emit
   * again and the sniper would see the same allocation three times. Bounded, and
   * insertion-ordered so the oldest fall out first.
   */
  private readonly emitted = new Set<string>();

  /**
   * What was actually emitted, newest last, for replay after a disconnect.
   *
   * Railway caps an SSE stream at 900s, so every consumer reconnects several
   * times an hour; without a replay source each gap silently swallows whatever
   * matched during it. The legacy feed already solves this with /api/alerts.
   */
  private readonly matches: V2Match[] = [];

  constructor(
    private readonly providers: V2Providers,
    private readonly opts: V2RuntimeOptions = DEFAULT_V2_RUNTIME_OPTIONS,
    private readonly jrnl: Journal = journal,
    /** Follows matched decisions to an outcome. Absent ⇒ decisions are recorded but never scored. */
    private readonly ledger?: OutcomeLedger,
    /**
     * Where a matched decision goes. Absent ⇒ v2 stays a pure shadow, which is
     * what it was built as and what it remains until an operator wires this.
     */
    private readonly onMatch?: (match: V2Match) => void,
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
        // Same rules epoch the ledger enforces. The journal outlives a rule change, and a verdict
        // reached under retired rules is not a reading on this build — restoring one puts a
        // decision back on the dashboard that the current lanes would never reach, next to ones
        // they did. The ledger dropped these on load; without this the diary quietly kept them and
        // the two records disagreed about what the engine had done.
        if (entry?.at != null && entry.at < V2_RULES_EPOCH_MS) continue;
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
    this.intakeLastAt.any = Date.now();

    // Distributions: allocations/airdrops — the 47e1 signal, typed honestly.
    if (swap.distribution === true) {
      this.intake.distributions++;
      this.intakeLastAt.distribution = Date.now();
      // An airdrop wave hits many watched wallets with the same token in the
      // same minute. One sheet per token per crowd window is the measurement;
      // 122 identical sheets are a bill (each would warm quotes and safety).
      const key = swap.token.toLowerCase();
      // Counted BEFORE the cooldown returns: the whole point of the wave measure
      // is the events the cooldown collapses. A record opened on the first
      // allocation cannot know whether it is one of one or one of forty, so the
      // ledger is told as the rest arrive.
      const cohort = this.markCohort(swap);
      this.ledger?.noteCohort(key, cohort);
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
      this.intakeLastAt.unverified = Date.now();
      return;
    }
    if (swap.direction !== 'BUY') {
      // A verified sell gets a diary line — 'observed', no buy reasoning — so a
      // stretch of selling is visible instead of reading as an outage. Also the
      // raw material the rug radar will consume.
      this.intake.verifiedSells++;
      this.intakeLastAt.verifiedSell = Date.now();
      this.recordSell(swap);
      return;
    }
    this.intake.verifiedBuys++;
    this.intakeLastAt.verifiedBuy = Date.now();
    this.seen++;
    this.markCrowd(swap);
    this.ledger?.noteCohort(swap.token, this.markCohort(swap));
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

  /** Emitted matches, oldest first — the SSE catch-up source. */
  recentMatches(): readonly V2Match[] {
    return this.matches;
  }

  /** The outcome ledger, for the scoreboard endpoint. Undefined when disabled. */
  get outcomes(): OutcomeLedger | undefined {
    return this.ledger;
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
      // Ages, not just counts: "0 buys" reads differently when the last one was
      // 4 minutes ago versus never this boot.
      intakeAges: Object.fromEntries(
        Object.entries(this.intakeLastAt).map(([k, at]) => [k, at == null ? null : Date.now() - at]),
      ),
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
      // Top of the wallet report card. Bounded: this is a status payload, and
      // the full list belongs on its own endpoint if it ever grows.
      walletGrades: this.providers.reportCard?.(Date.now())?.slice(0, 25) ?? null,
      // Headline only; the full scoreboard is /api/v2/outcomes. `priced` vs
      // `total` is the number to watch: a ledger full of unpriced records is
      // measuring nothing, however many matches it holds.
      ledger: this.ledger
        ? (({ total, open, priced }) => ({ total, open, priced }))(this.ledger.summary())
        : null,
    };
  }

  /** Build, gate, score, judge, record. */
  private evaluate(p: Pending, now: number): void {
    const sheet = this.buildSheet(p.trade, now);
    const elapsed = now - p.firstSeenAt;

    // Let an allocation's wave land before judging it. Deciding on the first
    // event means a seeding of one and an airdrop to forty look identical, which
    // would make the lane's solo condition silently useless — and solo-vs-wave
    // is the difference between 47e1's 90% and 0% win rates. Deliberately
    // expressed as a retry so it flows through the same pending queue, appears
    // in the diary as 'waiting' with a reason, and is bounded by the same budget.
    // A sheet we deliberately did not price cannot resolve, so waiting on it is incoherent.
    //
    // `worthPricing` declines to fetch a cap for a distribution from a wallet outside the seed
    // catalog, because no lane admits one at any cap — a real saving, and correct. But the sheet then
    // entered the retry loop anyway and burned the full budget (~60 passes over ~177s, each
    // rebuilding the sheet and writing two synchronous journal records) before being dropped as
    // "marketCap still unresolved". That reason was also misleading: nothing failed to resolve, we
    // chose not to ask. Terminal, immediately, with the actual reason.
    if (!this.worthPricing(p.trade, sheet.walletSeedTier.value ?? null)) {
      // Decided, not blocked. `blocked` means the evidence failed us; this is a RULE saying no, and
      // the lanes are evaluated so the diary still shows which condition turned it away rather than
      // asserting a conclusion with nothing behind it.
      this.record(sheet, {
        decision: 'pass',
        fact: null,
        reason: 'not priced: no lane admits a distribution from an unseeded wallet',
      }, now, false);
      return;
    }

    const settling = p.trade.distribution === true && elapsed < this.opts.distributionSettleMs;
    const verdict: GateVerdict = settling
      ? {
          decision: 'retry',
          fact: 'cohortSize',
          reason: `settling — counting how many watched wallets receive this token (${Math.round(
            (this.opts.distributionSettleMs - elapsed) / 1000,
          )}s left)`,
        }
      : gate(sheet, p.attempts, elapsed);

    if (verdict.decision === 'retry') {
      // Settling is NOT a gate attempt, and counting it as one starved the gate of its whole budget.
      // The two windows share this queue but measure different things: `attempts` is "how many times
      // have we asked whether the facts have landed", and during settling we have not asked once.
      // [verified 2026-08-08] With a 90s settle and a 3s retry interval an allocation burned ~30
      // attempts before `gate()` ran at all, hit `maxAttempts: 30` on its FIRST real call, and was
      // dropped as "still unresolved after 31 attempts" with its 180s budget untouched. That was 30
      // of 209 live decisions — facts thrown away that had not yet been given a chance to resolve.
      if (!settling) p.attempts++;
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

    // Follow EVERY settled decision, not only the matches.
    //
    // Two reasons, both structural. First, a scoreboard of only what the lanes
    // chose cannot say whether the lanes chose well — the unmatched decisions
    // are the control group, and without them "the lane picks winners" is
    // unfalsifiable. Second, grades come from outcomes, outcomes came only from
    // matches, and two lanes require a grade to match: no wallet could ever earn
    // a first grade. Recording every verdict is what breaks that circle, and it
    // is what lets a wallet OUTSIDE the seed catalog build a record at all.
    //
    // `waiting` is excluded — its facts have not landed, so its sheet would
    // record an entry price against a decision that has not been made yet. A
    // blocked-on-unknown-marketCap sheet IS recorded: that is a brand-new coin,
    // exactly what we want measured, and the ledger's late-entry adoption exists
    // to price it once a pool appears.
    if (!pendingOnly && entry.outcome !== 'waiting' && entry.outcome !== 'observed') {
      this.ledger?.open(
        {
          txHash: sheet.txHash,
          token: sheet.token,
          tokenSymbol: sheet.tokenSymbol,
          lanes: entry.matchedLanes,
          eventType: sheet.eventType,
          wallet: sheet.wallet,
          cohortWallets: this.cohortFor(sheet.token),
          // The grade held right now, frozen. Comparing outcomes against a grade
          // that keeps moving would let a wallet's later record leak backwards
          // into its own evidence.
          walletGradeAtFire: sheet.walletGrade.value ?? 'U',
          score: score.score,
          seedTier: sheet.walletSeedTier.value ?? null,
          capBand: sheet.capBand.value ?? null,
          marketCap: sheet.marketCap.value ?? null,
          pairAgeHours: sheet.pairAgeHours.value ?? null,
          firedAt: sheet.at,
        },
        now,
      );
    }

    if (entry.outcome === 'matched') {
      this.emit(sheet, score, entry, now);
    }
  }

  /**
   * Put a matched decision on the wire, at most once per transaction.
   *
   * Guarded rather than fired from `record()` directly, because `record()` runs
   * on every retry pass: a sheet that goes `waiting → matched` and then matches
   * an additional lane would otherwise emit two or three times, and the sniper
   * would treat each as a fresh signal for the same token.
   */
  private emit(sheet: FactSheet, score: ScoreResult, entry: DiaryEntry, now: number): void {
    if (!this.onMatch) {
      logger.info(
        { token: sheet.tokenSymbol, score: score.score, lanes: entry.matchedLanes },
        'v2 shadow: WOULD HAVE ALERTED (nothing emitted)',
      );
      return;
    }
    if (this.emitted.has(sheet.txHash)) return;
    this.emitted.add(sheet.txHash);
    if (this.emitted.size > 5_000) {
      const oldest = this.emitted.values().next().value;
      if (oldest) this.emitted.delete(oldest);
    }
    const match = buildMatch(sheet, score, entry, this.providers.walletIdOf ?? ((a) => a), now);
    this.matches.push(match);
    if (this.matches.length > 200) this.matches.shift();
    this.jrnl.write('emit', match);
    try {
      this.onMatch(match);
    } catch (err) {
      // A consumer that throws must not take down the pipeline that fed it.
      logger.warn({ err: String(err).slice(0, 200) }, 'v2: match consumer threw');
    }
    logger.info(
      { token: sheet.tokenSymbol, score: score.score, lanes: entry.matchedLanes, cohort: match.cohortSize },
      'v2: MATCH EMITTED',
    );
  }

  /** Cohort members currently inside the window for a token. */
  private cohortFor(token: string): string[] {
    const now = Date.now();
    const marks = this.cohort.get(token.toLowerCase()) ?? [];
    return [...new Set(marks.filter((m) => now - m.at <= this.opts.crowdWindowMs).map((m) => m.wallet))];
  }

  /**
   * Is a live quote worth a network round trip for this trade?
   *
   * Pricing a token nobody has quoted yet costs a cold Uniswap v4/v3 pool
   * discovery — roughly ten RPC reads through a bucket the whole process
   * shares. That was affordable when v2 saw a handful of verified buys. It is
   * not affordable now: the feed intakes ~500 distributions per boot, almost
   * all of them airdrops, and measured on 2026-08-08 those queued ~2,200 pool
   * reads against a 2/s host. Every gate then timed out waiting, market cap
   * resolved on 0.5% of sheets, and NOTHING matched — including the alpha-seed
   * allocations the whole lane exists for.
   *
   * The saving is safe because it is not a guess. An unknown cap stays unknown
   * and the gate still blocks on it; we simply stop paying to answer a question
   * whose answer could not change any verdict. Every lane that admits a
   * DISTRIBUTION requires an alpha/beta seed wallet (asserted in lanes.test.ts,
   * so adding a lane that breaks the assumption fails the build rather than
   * silently starving), and no lane matches a distribution from anyone else at
   * any cap. Verified buys are always warmed: they are rare here and every lane
   * is open to them.
   */
  private worthPricing(trade: SwapEvent, seedTier: WalletTier | null): boolean {
    if (trade.distribution !== true) return true;
    return seedTier === 'alpha' || seedTier === 'beta';
  }

  private buildSheet(trade: SwapEvent, now: number): FactSheet {
    const seedTier = this.providers.seedTier?.(trade.wallet) ?? null;
    const warm = this.worthPricing(trade, seedTier);
    const age = this.providers.pairAge(trade.token, warm);
    const inputs: SheetInputs = {
      marketCap: this.providers.marketCap(trade.token, warm),
      pairAgeHours: age?.hours ?? null,
      pairAgeSource: age?.source ?? null,
      canSell: this.providers.canSell(trade.token),
      outcomesByWallet: this.outcomesFor(trade, now),
      crowdWallets: this.crowdFor(trade.token, trade.wallet, now),
      // Buys AND allocations. Kept apart from crowdWallets so the crowd facts
      // keep meaning "wallets that chose to buy".
      cohortSize: Math.max(1, this.cohortFor(trade.token).length),
      // Claimed once, on first sight; a retry must not re-ask and get `false`
      // the second time, which would erase the very fact it is waiting on.
      // A distribution is not a buy: it must never claim the (wallet, token)
      // pair in the durable registry, or the wallet's later REAL first buy
      // would no longer read as first.
      firstBuy: trade.distribution === true ? false : this.firstBuyMemo(trade),
      rotatedFrom: null,
      eventType: trade.distribution === true ? 'distribution' : 'verified-buy',
      seedTier,
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

  /**
   * Record this wallet against the token and return every DISTINCT watched
   * wallet that has touched it inside the window — the solo-vs-wave cohort.
   *
   * Members, not a count: an outcome must be attributable to each wallet in a
   * wave, otherwise grading can only ever credit whoever triggered first.
   */
  private markCohort(swap: SwapEvent): string[] {
    const key = swap.token.toLowerCase();
    const now = Date.now();
    const marks = (this.cohort.get(key) ?? []).filter((m) => now - m.at <= this.opts.crowdWindowMs);
    marks.push({ wallet: swap.wallet.toLowerCase(), at: now });
    this.cohort.set(key, marks);
    if (this.cohort.size > 2_000) {
      const oldest = this.cohort.keys().next().value;
      if (oldest) this.cohort.delete(oldest);
    }
    return [...new Set(marks.map((m) => m.wallet))];
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
