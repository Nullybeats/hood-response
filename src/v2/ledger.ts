/**
 * The outcome ledger: what actually happened after a lane matched.
 *
 * Until this existed, v2 could say "the Allocation lane matched MANDATE" and
 * nothing more. Seventeen matches an hour, no way to tell which one was the next
 * 222 — every argument about tightening the lanes (alpha vs beta seed, 3h vs 48h,
 * micro vs small cap, solo vs wave) was a matter of opinion. This turns each of
 * those into a bucket with a win rate under it.
 *
 * It deliberately mirrors `engine/performance.ts` in its fields — entryPrice,
 * maxGainPct, the +50% win threshold — because the benchmark we are measuring
 * against is 47e1's call record, and a comparison against differently-computed
 * numbers would prove nothing.
 *
 * Three differences from that tracker, each learned the hard way:
 *
 *  1. NO daily reset. 47e1's record wipes at 8am ET, and reading it as a lifetime
 *     total is exactly how the alert-rate comparison came out 5x wrong. This
 *     accumulates until told otherwise.
 *  2. A match with no price is KEPT, not dropped. The performance tracker skips
 *     any call it cannot price, which here would discard ~97% of allocations —
 *     market cap resolves for 3% of them, because the whole point of the signal
 *     is that it fires before a pool is liquid enough to quote. Instead the entry
 *     price is adopted from the first real quote we see, and the delay is recorded
 *     so an adopted entry is never silently read as a true one.
 *  3. Sampling is tiered and capped. An open ledger of several hundred records
 *     polled every couple of minutes is how the last rate-limit runaway started.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { WalletTier } from '../types.js';
import { V2_RULES_EPOCH_MS } from './epoch.js';
import type { CapBand } from './facts/sheet.js';
import type { Provenance, Grade } from './facts/types.js';

/** What the ledger needs to value a token. Injected, like every other v2 provider. */
export interface LedgerPrice {
  /** Last known USD price, or null when none has ever been established. */
  priceOf(token: string): number | null;
  /** Fetch a fresh price now. May reject; the caller treats that as "no sample". */
  refreshNow(token: string): Promise<unknown>;
  /**
   * Current market cap, or null when it cannot be established.
   *
   * Recorded alongside the price so a row can show what the coin is worth NOW next to what it was
   * worth at the call. Without it, "+33,682%" is unfalsifiable on screen: the reader cannot tell a
   * real run from an entry price captured at a launch seed, which is precisely the artifact the
   * $25k floor exists to reject. Deliberately MEASURED and not derived from the price ratio — a
   * derived cap would silently assume a fixed supply and would look identical to a real one.
   */
  marketCapOf?(token: string): number | null;
}

/** One evaluated event, followed until it closes. */
export interface LedgerRecord {
  /** txHash — one record per trade, however many lanes it hit. */
  id: string;
  token: string;
  tokenSymbol: string;
  /** Every lane that matched. EMPTY is normal — see `matched`. */
  lanes: string[];
  /**
   * Whether any lane wanted this. False records are the control group: without
   * them "the lane picks winners" is unfalsifiable, because we would only ever
   * measure what the lane already chose.
   *
   * They also break a circularity. Grades come from outcomes, outcomes came only
   * from matches, and two lanes need a grade to match — so no wallet could ever
   * earn its first grade. Recording every verdict is what lets a wallet OUTSIDE
   * the 122-wallet seed catalog accumulate a record at all.
   */
  matched: boolean;
  eventType: string;
  /** Lowercased address. The grading index keys on it; the API strips it. */
  wallet: string;
  /**
   * Every distinct watched wallet in the cohort window, not just the trigger.
   * `cohortSize` alone cannot attribute a wave's outcome to its participants.
   */
  cohortWallets: string[];
  /**
   * The grade this wallet held WHEN THE RECORD OPENED — never recomputed.
   *
   * This is what makes a grade falsifiable: if records fired by A-graded wallets
   * do not outperform D-graded ones, the grade is noise and must not gate buys.
   * Comparing against today's grade instead would be circular.
   */
  walletGradeAtFire: Grade;
  score: number | null;
  seedTier: WalletTier | null;
  capBand: CapBand | null;
  entryMarketCap: number | null;
  pairAgeHours: number | null;
  /**
   * Could this coin be SOLD, as known WHEN THE RECORD OPENED — frozen, like
   * `walletGradeAtFire` and for the same reason.
   *
   * A gain you cannot exit is not a gain. Without this the ledger scored peak PRICE and called it
   * performance, so an unsellable coin whose price mooned precisely BECAUSE nobody could sell counted
   * as a win. [verified 2026-08-09] MEW fired unscreened, peaked +756%, sits at -95%, and was recorded
   * as a win.
   *
   * Provenance is kept separately because the distinction is the whole point (see facts/types.ts):
   * `measured false` is "we checked, you are trapped", `unknown` is "nobody checked". They must never
   * collapse into one another — domain.md rule 1: unknown is neither safe nor unsafe, and a coin is
   * never penalised for what merely could not be verified.
   */
  canSellAtFire: boolean | null;
  canSellProvenanceAtFire: Provenance;

  /** Block time of the trade — the moment the signal fired. */
  firedAt: number;
  /**
   * Price used as the baseline. Null until one is established; see `entryDelayMs`.
   * Every gain in this record is measured against it.
   */
  entryPrice: number | null;
  /**
   * How long after the signal the entry price was established. 0 means it was
   * known when the lane matched; anything larger means the baseline is a LATER
   * price and the record understates any move that happened in between.
   */
  entryDelayMs: number | null;

  lastPrice: number | null;
  lastGainPct: number;
  /** Market cap at the last sample. Null when it could not be established — never derived. */
  lastMarketCap: number | null;
  maxPrice: number | null;
  maxGainPct: number;
  maxGainAt: number;
  gain1hPct: number | null;
  gain6hPct: number | null;
  gain24hPct: number | null;

  /**
   * Distinct watched wallets that received/bought this token inside the window.
   * 1 = solo. The 47e1 record says solo wins 90% and multi-wallet wins 0%, and
   * this is the field that lets v2 confirm or refute that on its own data.
   */
  cohortSize: number;

  updatedAt: number;
  /** When sampling should next consider this record (tiered by age). */
  nextSampleAt: number;
  closed: boolean;
  /** Why it closed: 'tracked-out' (ran its course) | 'no-price' (never quotable). */
  closedReason: string | null;
}

export interface LedgerBucket {
  label: string;
  count: number;
  /** Records that never got a price — counted, and excluded from the averages. */
  unpriced: number;
  /**
   * Distinct tokens behind `count`. Published because it is the difference between a result and an
   * artefact: [verified 2026-08-09] 16 F-grade "wins" were 11 coins, one of them counted SIX times.
   */
  distinctTokens: number;
  avgMaxGainPct: number;
  medianMaxGainPct: number;
  bestMaxGainPct: number;
  /**
   * Peak-based win rate over records whose sellability was MEASURED TRUE.
   *
   * Three exclusions, each deliberate. Unpriced records have no gain to judge. `measured false` is
   * excluded because a gain you cannot exit is not a gain. `unknown` is excluded because domain.md
   * rule 1 forbids penalising a coin for what merely could not be verified — so it is neither a win
   * nor a loss, and `unverified` below is how you see how much was set aside.
   */
  winRatePct: number | null;
  /** How many records `winRatePct` is computed over. A rate without its n is not a claim. */
  winRateBasis: number;
  /** Same rule, one vote per TOKEN, so a coin fired six times cannot carry a bucket. */
  winRateByTokenPct: number | null;
  winRateByTokenBasis: number;
  /**
   * Win rate on the CURRENT gain rather than the peak — the peak is not something you exited at.
   * Still not true realizable PnL: domain.md's exit-now rule subtracts round-trip cost, which the
   * ledger cannot price for a coin it never bought. So this is an upper bound too, just a much
   * tighter one than the peak.
   */
  winRateRealizedPct: number | null;
  medianLastGainPct: number;
  /** Checked, and CANNOT be sold. Excluded from every rate above. */
  unsellable: number;
  /** Nobody established sellability. Excluded from the rates, never counted against the coin. */
  unverified: number;
  /** Share whose entry price had to be adopted late; high = the numbers are conservative. */
  lateEntryPct: number;
}

export interface LedgerOptions {
  trackHours: number;
  winThresholdPct: number;
  /** How long to keep trying for a first price before closing as unquotable. */
  priceGraceHours: number;
  /** Hard cap on tokens refreshed per tick — the rate-limit guard. */
  maxRefreshPerTick: number;
  tickMs: number;
  maxRecords: number;
  storePath: string;
  /**
   * Decisions older than this are not this build's record — dropped on load, refused on open.
   * See epoch.ts for what bumping it means. Injected rather than read straight from the module so
   * the behaviour is testable at all: a fixed wall-clock constant would otherwise silently reject
   * every fixture the day someone bumps it, which is how a guard turns into a mystery.
   */
  rulesEpochMs: number;
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  // Three days, not one. A record stops sampling when the window ends, so its peak FREEZES there —
  // and peak is the whole measurement. At 24h a coin that ran on day two was recorded as flat, and
  // every wallet behind it was graded on a number that never happened.
  //
  // This mattered more once grading stopped waiting for a record to close: `closed` no longer
  // means "ready to judge", it only means "we stopped looking", so the window is now purely a
  // question of how long we are willing to keep watching.
  trackHours: 72,
  winThresholdPct: 50,
  priceGraceHours: 6,
  // Raised with the window. Steady state at ~10 signals/hr over 72h is ~40 tokens/tick across all
  // four tiers; 20 would have silently starved the tail, which is exactly the late peak the longer
  // window exists to catch. Affordable now that the price bucket runs at its configured 8/s with a
  // zero queue — before that fix this would have compounded the backlog.
  maxRefreshPerTick: 60,
  tickMs: 60_000,
  maxRecords: 5_000,
  storePath: '',
  rulesEpochMs: V2_RULES_EPOCH_MS,
};

const gainPct = (entry: number, now: number): number =>
  entry > 0 ? Math.round(((now - entry) / entry) * 1000) / 10 : 0;

/**
 * How soon to resample, by age.
 *
 * The first hour is where a launch either runs or does not, so it is sampled every tick. Past a
 * day the coin is mostly settled and an hourly sample is enough to notice a late run — the point
 * of watching that long is not precision, it is not MISSING a peak that arrives on day two.
 *
 * The tiers exist so a long tail of old records cannot crowd out the young ones, which are the
 * only records where a minute of resolution changes the number.
 */
function sampleIntervalMs(ageMs: number): number {
  if (ageMs < 3_600_000) return 60_000;
  if (ageMs < 6 * 3_600_000) return 5 * 60_000;
  if (ageMs < 24 * 3_600_000) return 15 * 60_000;
  return 60 * 60_000;
}

/** Sellability, as this record froze it. See LedgerRecord.canSellAtFire. */
function sellability(r: LedgerRecord): 'sellable' | 'unsellable' | 'unverified' {
  if (r.canSellProvenanceAtFire !== 'measured') return 'unverified';
  return r.canSellAtFire === true ? 'sellable' : 'unsellable';
}

/**
 * A rate, or NULL when there is nothing to compute it over.
 *
 * Not zero. Zero means "none of them won"; null means "none of them could be judged", and this
 * codebase has already paid for confusing the two — `safety.ok` returned true when GoPlus had no
 * data, so an unchecked token rendered as "Safe" (facts/types.ts). A 0% win rate under a count of
 * 900 reads as damning evidence when the truth may be that nothing was screened.
 */
function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * One row of the scoreboard.
 *
 * The averages describe every priced record, because they are descriptive. The WIN RATES are
 * deliberately narrower — see LedgerBucket.winRatePct for which records they exclude and why. Keeping
 * both in one row is the point: a big `count` next to a small `winRateBasis` is exactly the shape of
 * "we barely screen anything", and that should be visible rather than hidden behind one number.
 */
function bucket(label: string, records: LedgerRecord[], winPct: number): LedgerBucket {
  const priced = records.filter((r) => r.entryPrice != null && r.maxPrice != null);
  const distinctTokens = new Set(records.map((r) => r.token)).size;
  const unsellable = records.filter((r) => sellability(r) === 'unsellable').length;
  const unverified = records.filter((r) => sellability(r) === 'unverified').length;
  const base: LedgerBucket = {
    label,
    count: records.length,
    unpriced: records.length - priced.length,
    distinctTokens,
    avgMaxGainPct: 0,
    medianMaxGainPct: 0,
    bestMaxGainPct: 0,
    winRatePct: null,
    winRateBasis: 0,
    winRateByTokenPct: null,
    winRateByTokenBasis: 0,
    winRateRealizedPct: null,
    medianLastGainPct: 0,
    unsellable,
    unverified,
    lateEntryPct: 0,
  };
  if (priced.length === 0) return base;

  const gains = priced.map((r) => r.maxGainPct).sort((a, b) => a - b);
  const lastGains = priced.map((r) => r.lastGainPct ?? 0).sort((a, b) => a - b);
  const late = priced.filter((r) => (r.entryDelayMs ?? 0) > 60_000).length;

  // Only coins proven sellable can carry a win rate.
  const judgeable = priced.filter((r) => sellability(r) === 'sellable');
  // One vote per token, keeping its best peak — so six fires on one coin are one data point.
  const bestPerToken = new Map<string, LedgerRecord>();
  for (const r of judgeable) {
    const prev = bestPerToken.get(r.token);
    if (!prev || r.maxGainPct > prev.maxGainPct) bestPerToken.set(r.token, r);
  }
  const byToken = [...bestPerToken.values()];

  return {
    ...base,
    avgMaxGainPct: Math.round((gains.reduce((sum, g) => sum + g, 0) / gains.length) * 10) / 10,
    medianMaxGainPct: Math.round(median(gains) * 10) / 10,
    bestMaxGainPct: gains[gains.length - 1]!,
    winRatePct: pct(judgeable.filter((r) => r.maxGainPct >= winPct).length, judgeable.length),
    winRateBasis: judgeable.length,
    winRateByTokenPct: pct(byToken.filter((r) => r.maxGainPct >= winPct).length, byToken.length),
    winRateByTokenBasis: byToken.length,
    winRateRealizedPct: pct(judgeable.filter((r) => (r.lastGainPct ?? 0) >= winPct).length, judgeable.length),
    medianLastGainPct: Math.round(median(lastGains) * 10) / 10,
    lateEntryPct: pct(late, priced.length) ?? 0,
  };
}

function ageBand(hours: number | null): string {
  if (hours == null) return 'unknown';
  if (hours < 1) return '<1h';
  if (hours < 3) return '1-3h';
  if (hours < 12) return '3-12h';
  if (hours < 48) return '12-48h';
  return '48h+';
}
const AGE_BANDS = ['<1h', '1-3h', '3-12h', '12-48h', '48h+', 'unknown'];
const CAP_BANDS_ORDER: (CapBand | 'unknown')[] = ['micro', 'small', 'mid', 'large', 'unknown'];
const TIERS: (WalletTier | 'unseeded')[] = ['alpha', 'beta', 'chroma', 'delta', 'unseeded'];
const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'F', 'U'];

/** What a caller must supply to open a record. */
export interface LedgerEntryInput {
  txHash: string;
  token: string;
  tokenSymbol: string;
  /** Lanes that matched. Empty is normal and expected — see LedgerRecord.matched. */
  lanes: string[];
  eventType: string;
  wallet: string;
  /** Cohort members known at open time; grows later via noteCohort. */
  cohortWallets?: string[];
  /** The wallet's grade at fire time. 'U' when ungraded, which is most of them. */
  walletGradeAtFire?: Grade;
  score: number | null;
  seedTier: WalletTier | null;
  capBand: CapBand | null;
  marketCap: number | null;
  pairAgeHours: number | null;
  firedAt: number;
  /** Sellability as the fact sheet knew it at fire. Pass `sheet.canSell` straight through. */
  canSell?: { value: boolean | null; provenance: Provenance };
}

/**
 * Follows every matched lane decision and records what the price did afterwards.
 *
 * Observational only: it never emits, never trades, and its numbers feed exactly
 * two things — the lane scoreboard, and the argument about which conditions to
 * tighten.
 */
export class OutcomeLedger {
  private readonly records = new Map<string, LedgerRecord>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;

  constructor(
    private readonly price: LedgerPrice,
    private readonly opts: LedgerOptions = DEFAULT_LEDGER_OPTIONS,
  ) {}

  /**
   * Open a record for an evaluated decision, matched or not.
   *
   * Idempotent per txHash: a trade re-evaluated by the retry queue must not
   * open a second record, or one decision would be counted twice in every
   * bucket. A later evaluation may match MORE lanes — those are merged in, and
   * a record that started unmatched is promoted, since a sheet legitimately
   * goes waiting → matched once its facts land. It is never demoted: a lane DID
   * want it, and erasing that would rewrite history.
   */
  open(input: LedgerEntryInput, now: number): void {
    // The retry queue re-evaluates trades minutes to hours after their block time, so without this
    // a decision retired at load can walk straight back in through the side door. `firedAt` is the
    // BLOCK time, which is the right key: what matters is which rules were live when the event
    // happened, not when we got around to judging it.
    if (input.firedAt < this.opts.rulesEpochMs) return;
    const existing = this.records.get(input.txHash);
    if (existing) {
      for (const lane of input.lanes) {
        if (!existing.lanes.includes(lane)) existing.lanes.push(lane);
      }
      if (input.lanes.length > 0) existing.matched = true;
      return;
    }
    // A price we already hold is a true entry; otherwise the record opens
    // unpriced and adopts the first quote it sees.
    const p = this.price.priceOf(input.token);
    const entryPrice = p != null && p > 0 ? p : null;
    this.records.set(input.txHash, {
      id: input.txHash,
      token: input.token.toLowerCase(),
      tokenSymbol: input.tokenSymbol,
      lanes: [...input.lanes],
      matched: input.lanes.length > 0,
      eventType: input.eventType,
      wallet: input.wallet.toLowerCase(),
      cohortWallets: (input.cohortWallets ?? [input.wallet]).map((w) => w.toLowerCase()),
      walletGradeAtFire: input.walletGradeAtFire ?? 'U',
      // Absent input means nobody told us, which is 'unknown' — never a cheerful default. The Fact
      // invariant holds here too: a value exists only when the provenance is 'measured'.
      canSellAtFire: input.canSell?.provenance === 'measured' ? (input.canSell.value ?? null) : null,
      canSellProvenanceAtFire: input.canSell?.provenance ?? 'unknown',
      score: input.score,
      seedTier: input.seedTier,
      capBand: input.capBand,
      entryMarketCap: input.marketCap,
      pairAgeHours: input.pairAgeHours,
      firedAt: input.firedAt,
      entryPrice,
      entryDelayMs: entryPrice != null ? 0 : null,
      lastPrice: entryPrice,
      lastGainPct: 0,
      lastMarketCap: input.marketCap,
      maxPrice: entryPrice,
      maxGainPct: 0,
      maxGainAt: now,
      gain1hPct: null,
      gain6hPct: null,
      gain24hPct: null,
      cohortSize: 1,
      updatedAt: now,
      nextSampleAt: now,
      closed: false,
      closedReason: null,
    });
    // A new record is the one thing worth writing promptly — see schedulePersist.
    this.schedulePersist();
    this.evict();
  }

  /**
   * Record the distinct watched wallets that touched this token in the window.
   *
   * Called as the wave arrives, AFTER the record opened — a decision fires on the
   * first event, when a wave of one and a wave of forty look identical. Only ever
   * grows, so a later quiet window cannot erase a wave that happened.
   *
   * Members are kept, not just the count: an outcome has to be attributable to
   * every wallet in the wave, or grading can only ever credit whichever wallet
   * happened to trigger first.
   */
  noteCohort(token: string, wallets: readonly string[]): void {
    const key = token.toLowerCase();
    const members = wallets.map((w) => w.toLowerCase());
    for (const r of this.records.values()) {
      if (r.token !== key || r.closed) continue;
      for (const w of members) if (!r.cohortWallets.includes(w)) r.cohortWallets.push(w);
      if (r.cohortWallets.length > r.cohortSize) r.cohortSize = r.cohortWallets.length;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), this.opts.tickMs);
    this.timer.unref?.();
    logger.info(
      { trackHours: this.opts.trackHours, maxRefreshPerTick: this.opts.maxRefreshPerTick },
      'v2 ledger: following matched decisions to outcome',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sampling pass.
   *
   * Only records that are DUE are considered, they are grouped by token so a wave
   * of forty allocations of one coin costs one quote, and the whole pass is capped.
   */
  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const now = Date.now();
      const due = [...this.records.values()]
        .filter((r) => !r.closed && r.nextSampleAt <= now)
        .sort((a, b) => a.nextSampleAt - b.nextSampleAt);
      if (due.length === 0) return;

      const byToken = new Map<string, LedgerRecord[]>();
      for (const r of due) {
        const list = byToken.get(r.token) ?? [];
        list.push(r);
        byToken.set(r.token, list);
      }
      const tokens = [...byToken.keys()].slice(0, this.opts.maxRefreshPerTick);

      for (const token of tokens) {
        try {
          await this.price.refreshNow(token);
        } catch {
          /* a failed quote is a missing sample, not an error worth logging per token */
        }
        const p = this.price.priceOf(token) ?? 0;
        for (const r of byToken.get(token) ?? []) this.applySample(r, p, now);
      }
      // Records that were due but did not fit in this tick's budget keep their
      // due time, so they are first in line next tick rather than starved.
      await this.persist();
    } finally {
      this.sampling = false;
    }
  }

  /** Apply one price observation to one record. */
  private applySample(r: LedgerRecord, p: number, now: number): void {
    const ageMs = now - r.firedAt;

    if (p > 0) {
      if (r.entryPrice == null) {
        // First real quote for a coin that had none when the lane matched. This
        // is the honest compromise: a baseline that exists, flagged as late.
        r.entryPrice = p;
        r.entryDelayMs = ageMs;
        r.maxPrice = p;
        r.maxGainPct = 0;
        r.maxGainAt = now;
      }
      r.lastPrice = p;
      r.lastGainPct = gainPct(r.entryPrice, p);
      const cap = this.price.marketCapOf?.(r.token) ?? null;
      if (cap != null && cap > 0) r.lastMarketCap = cap;
      if (r.maxPrice == null || p > r.maxPrice) {
        r.maxPrice = p;
        r.maxGainPct = gainPct(r.entryPrice, p);
        r.maxGainAt = now;
      }
    }

    if (r.entryPrice != null) {
      if (r.gain1hPct == null && ageMs >= 3_600_000) r.gain1hPct = r.lastGainPct;
      if (r.gain6hPct == null && ageMs >= 6 * 3_600_000) r.gain6hPct = r.lastGainPct;
      if (r.gain24hPct == null && ageMs >= 24 * 3_600_000) r.gain24hPct = r.lastGainPct;
    }

    if (ageMs >= this.opts.trackHours * 3_600_000) {
      r.closed = true;
      r.closedReason = 'tracked-out';
    } else if (r.entryPrice == null && ageMs >= this.opts.priceGraceHours * 3_600_000) {
      // Never quotable. Kept in the record with a reason: "how many allocations
      // never became tradeable at all" is itself a finding about the signal.
      r.closed = true;
      r.closedReason = 'no-price';
    }

    r.nextSampleAt = now + sampleIntervalMs(ageMs);
    r.updatedAt = now;
  }

  /** Drop the oldest closed records once over the cap; open ones are never evicted. */
  private evict(): void {
    if (this.records.size <= this.opts.maxRecords) return;
    const closed = [...this.records.values()]
      .filter((r) => r.closed)
      .sort((a, b) => a.firedAt - b.firedAt);
    for (const r of closed) {
      if (this.records.size <= this.opts.maxRecords) break;
      this.records.delete(r.id);
    }
  }

  /**
   * Drop records by id. Returns how many were actually removed.
   *
   * A deliberately narrow tool for one situation: a record whose numbers are demonstrably WRONG
   * rather than merely old. [verified 2026-08-09] Eight records took pool-derived entry prices
   * 21x-334x below the truth and read as gains up to +33,682% that never happened. The rules epoch
   * is the wrong instrument for that — it is for a change in what would have FIRED, and wiping the
   * whole record to delete eight false rows would take the true ones with it.
   *
   * Deleting measurements is a thing to do rarely and on purpose, which is why this is admin-gated,
   * takes explicit ids, and reports the count instead of accepting a predicate. There is no "delete
   * everything matching" here by design.
   */
  drop(ids: readonly string[]): number {
    let removed = 0;
    for (const id of ids) if (this.records.delete(id)) removed += 1;
    if (removed) {
      logger.warn({ removed, requested: ids.length }, 'v2 ledger: records dropped by an operator');
      this.schedulePersist();
    }
    return removed;
  }

  /** Newest first, paged. `offset` exists so a caller can read the WHOLE set rather than
   *  unknowingly analysing the newest page of it. */
  list(limit = 200, offset = 0): LedgerRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(offset, offset + limit);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * The scoreboard.
   *
   * Buckets are the questions we actually need answered, and a record counts in
   * every bucket it belongs to (a match on two lanes appears under both).
   */
  summary(): {
    total: number;
    open: number;
    priced: number;
    /** How many of `total` any lane actually wanted. The rest are the control group. */
    matched: number;
    winThresholdPct: number;
    trackHours: number;
    byLane: LedgerBucket[];
    bySeedTier: LedgerBucket[];
    byCapBand: LedgerBucket[];
    byPairAge: LedgerBucket[];
    byCohort: LedgerBucket[];
    byEventType: LedgerBucket[];
    byMatched: LedgerBucket[];
    byWalletGrade: LedgerBucket[];
  } {
    const all = [...this.records.values()];
    const win = this.opts.winThresholdPct;
    const laneIds = [...new Set(all.flatMap((r) => r.lanes))].sort();
    return {
      total: all.length,
      open: all.filter((r) => !r.closed).length,
      priced: all.filter((r) => r.entryPrice != null).length,
      matched: all.filter((r) => r.matched).length,
      winThresholdPct: win,
      trackHours: this.opts.trackHours,
      byLane: laneIds.map((id) => bucket(id, all.filter((r) => r.lanes.includes(id)), win)),
      bySeedTier: TIERS.map((t) =>
        bucket(t, all.filter((r) => (r.seedTier ?? 'unseeded') === t), win),
      ),
      byCapBand: CAP_BANDS_ORDER.map((b) =>
        bucket(b, all.filter((r) => (r.capBand ?? 'unknown') === b), win),
      ),
      byPairAge: AGE_BANDS.map((b) => bucket(b, all.filter((r) => ageBand(r.pairAgeHours) === b), win)),
      // The headline comparison against 47e1's record: solo 90% win, multi 0%.
      byCohort: [
        bucket('solo (1 wallet)', all.filter((r) => r.cohortSize < 2), win),
        bucket('wave (2+ wallets)', all.filter((r) => r.cohortSize >= 2), win),
      ],
      byEventType: [...new Set(all.map((r) => r.eventType))].sort().map((t) =>
        bucket(t, all.filter((r) => r.eventType === t), win),
      ),
      // The control group. If matched and unmatched perform the same, the lanes
      // are decoration — and that claim is only checkable because unmatched
      // decisions are recorded too.
      byMatched: [
        bucket('matched a lane', all.filter((r) => r.matched), win),
        bucket('no lane matched', all.filter((r) => !r.matched), win),
      ],
      // Is the grade real? Compared on the grade held AT FIRE, so a wallet's
      // later grade cannot leak backwards into its own evidence. If A ≈ D here,
      // the grade is noise and must not gate a buy.
      byWalletGrade: GRADES.map((g) =>
        bucket(g, all.filter((r) => (r.walletGradeAtFire ?? 'U') === g), win),
      ),
    };
  }

  /** Restore a snapshot. No-op without a store path. */
  async load(): Promise<void> {
    if (!this.opts.storePath) return;
    try {
      const raw = await readFile(this.opts.storePath, 'utf8');
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return;
      let retired = 0;
      for (const r of arr as LedgerRecord[]) {
        if (!r || !r.id) continue;
        // Snapshots outlive rule changes. A record decided under retired rules is not evidence
        // about this build, so it is dropped on the way in rather than filtered on the way out —
        // see epoch.ts. Dropping at load is also what stops it costing a price sample per tick.
        if (r.firedAt < this.opts.rulesEpochMs) {
          retired += 1;
          continue;
        }
        // Backfill fields added after these records were written. `matched` is
        // the one that matters: every record predating it WAS a match (the
        // ledger only followed matches then), and defaulting it to false would
        // file real matches under the control group and corrupt the very
        // comparison the control group exists for.
        if (r.matched === undefined) r.matched = (r.lanes?.length ?? 0) > 0;
        if (!r.cohortWallets) r.cohortWallets = r.wallet ? [r.wallet] : [];
        if (!r.walletGradeAtFire) r.walletGradeAtFire = 'U';
        // Predates sellability tracking. 'unknown' is the only honest backfill: we genuinely do not
        // know whether these were sellable, and inventing `true` would quietly readmit them to the
        // win rate this field exists to protect.
        if (!r.canSellProvenanceAtFire) {
          r.canSellProvenanceAtFire = 'unknown';
          r.canSellAtFire = null;
        }
        // Added after these were written. Seed from the entry cap rather than null so a restored row
        // shows a number until its next sample replaces it with a measured one.
        if (r.lastMarketCap === undefined) r.lastMarketCap = r.entryMarketCap;
        this.records.set(r.id, r);
      }
      logger.info({ loaded: this.records.size, retired }, 'v2 ledger: restored snapshot');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') logger.warn({ err: String(err).slice(0, 160) }, 'v2 ledger: could not load');
    }
  }

  /** Atomic write (temp + rename), so a restart mid-write cannot truncate the record. */
  async flush(): Promise<void> {
    if (!this.opts.storePath) return;
    const path = this.opts.storePath;
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.records.values()]));
      await rename(tmp, path);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 160) }, 'v2 ledger: could not save');
    }
  }

  private persisting = false;
  private async persist(): Promise<void> {
    if (this.persisting) return;
    this.persisting = true;
    try {
      await this.flush();
    } finally {
      this.persisting = false;
    }
  }

  /**
   * Write soon, after a record is opened — not only on the next sample tick.
   *
   * `persist()` used to run only at the end of `sample()`, once every 60s, so a record opened
   * between ticks existed in memory alone. [verified 2026-08-09] A `fresh-entry` match on BLINK was
   * recorded in the diary at 03:50:43 and a deploy restarted the process at 03:50:54 — eleven
   * seconds later. The diary survived, because the journal is written synchronously; the ledger
   * record did not, so the call appeared in the decision log and was missing from the signal record
   * that is supposed to be following it to an outcome. The two disagreed about whether the call
   * happened at all.
   *
   * Debounced rather than immediate because `open()` can fire several times in a burst and each
   * write serialises the whole record set. Two seconds is far below a deploy's window and far above
   * a burst's. Note `persist()` DROPS a concurrent call rather than queueing it, which is why this
   * schedules a later write instead of just calling it again.
   */
  private persistTimer: NodeJS.Timeout | null = null;
  private schedulePersist(): void {
    if (!this.opts.storePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 2_000);
    this.persistTimer.unref?.();
  }
}

/** Build options from config, so index.ts stays a wiring file. */
export function ledgerOptionsFromConfig(): LedgerOptions {
  return {
    ...DEFAULT_LEDGER_OPTIONS,
    trackHours: config.V2_LEDGER_TRACK_HOURS,
    winThresholdPct: config.V2_LEDGER_WIN_PCT,
    maxRefreshPerTick: config.V2_LEDGER_MAX_REFRESH_PER_TICK,
    storePath: config.V2_LEDGER_PATH,
  };
}
