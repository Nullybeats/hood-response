/**
 * The fact sheet: one verified trade, described as evidence.
 *
 * This replaces the legacy "kind" taxonomy outright. There, a single buy spawned
 * competing SOLO and ENTRY candidates that raced through a shared, kind-blind
 * dedup ledger — and the microcap alert routinely consumed the first-buy alert's
 * new-wallet credit, silently suppressing the very signal PRIME was defined on.
 * Live production showed the result: zero PRIME alerts in twenty-four hours.
 *
 * A fact sheet cannot have that bug, because there is nothing to race. One trade
 * produces one sheet. What used to be a kind is now an attribute on it:
 *
 *   SOLO      → wallets === 1 && capBand === 'micro'
 *   ENTRY     → wallets === 1 && firstBuy && pairAgeHours < 48
 *   BUY swarm → wallets >= 2, with crowd quality attached
 *   ROTATION  → rotatedFrom, recorded on the BOUGHT token's sheet
 *
 * Lanes select over these attributes, so any number of lanes may match the same
 * sheet without competing. The legacy names survive only as derived labels for
 * wire compatibility (see `deriveKindLabel`), never as control flow.
 *
 * Every field is a `Fact`, so "we did not check" can never be read as "fine".
 */

import type { WalletTier } from '../../types.js';
import { gradeWallet, crowdGpa, type Outcome } from './grade.js';
import { measured, unknown, type Fact, type Grade } from './types.js';

/**
 * What kind of event this sheet describes. A plain field, not a Fact — the
 * pipeline always knows how an event entered.
 *
 * 'distribution' exists because of the 47e1 finding: the untouched instance's
 * best calls (+435%, +359%) were top-seed wallets RECEIVING fresh allocations,
 * not buying. Calling those "buys" was a lie; discarding them was a waste. A
 * typed event keeps the fact honest and the signal.
 */
export type SheetEventType = 'verified-buy' | 'distribution' | 'verified-sell';

/** Market-cap band. Named rather than numeric so a lane reads as a sentence. */
export type CapBand = 'micro' | 'small' | 'mid' | 'large';

/** [config] Band edges in USD. Tunable from the journal; `micro` matches the legacy SOLO window. */
export const CAP_BANDS: readonly { max: number; band: CapBand }[] = [
  { max: 125_000, band: 'micro' },
  { max: 1_000_000, band: 'small' },
  { max: 10_000_000, band: 'mid' },
  { max: Infinity, band: 'large' },
] as const;

/**
 * The pipeline's only legitimate input: a trade the attribution layer PROVED.
 *
 * Not a Transfer. The shadow measured that ~90% of watched-wallet activity is
 * `airdrop_receive` and only ~1.5% is a real swap, so admitting raw transfers
 * here would make the entire brain roughly 98% noise — which is what the legacy
 * engine did with the verified-trade gate switched off.
 */
export interface VerifiedTrade {
  txHash: string;
  wallet: string;
  token: string;
  tokenSymbol: string;
  blockNumber: number;
  /** ms epoch of the block. Drives every age calculation; never Date.now(). */
  at: number;
  /** attrib's trade category, e.g. 'swap_v4_poolmanager'. Names the venue that was proven. */
  venue: string;
  /** USD value of the buy when priced. Null means unpriced — NOT zero. */
  usdValue: number | null;
}

/** Enrichment gathered around a trade. Each field may legitimately be absent. */
export interface SheetInputs {
  /** Verified market cap, or null when supply or price could not be established. */
  marketCap: number | null;
  /** Hours since the pool was created on chain, or null when unestablished. */
  pairAgeHours: number | null;
  /** Where the pair age came from — an on-chain Initialize outranks an indexer. */
  pairAgeSource: string | null;
  /**
   * Sellability. `true`/`false` only when a check actually RAN; null when it did
   * not. The legacy report returned ok:true on no data at all, which is how an
   * unchecked token rendered "🛡️ Safe".
   */
  canSell: boolean | null;
  /** Outcome history per wallet, for grading. Missing wallet ⇒ ungraded. */
  outcomesByWallet: ReadonlyMap<string, readonly Outcome[]>;
  /** Other watched wallets that bought this token inside the crowd window. */
  crowdWallets: readonly string[];
  /**
   * Distinct watched wallets that TOUCHED this token in the window, by buying or
   * by being allocated it.
   *
   * Deliberately separate from `crowdWallets`: that one describes wallets which
   * CHOSE to buy and feeds crowdSize/crowdGpa, and folding allocation recipients
   * into it would restate "forty wallets were airdropped" as "forty wallets
   * bought" — the exact 47e1 lie. This one exists so a lane can tell a single
   * deliberate seeding from a mass airdrop, which 47e1's record says is the
   * difference between a 90% and a 0% win rate.
   */
  cohortSize?: number;
  /** Whether this (wallet, token) pair had never been claimed before. */
  firstBuy: boolean;
  /** Token this wallet sold to fund the buy, when the rotation was established. */
  rotatedFrom: string | null;
  /** How the event entered the pipeline. Defaults to 'verified-buy'. */
  eventType?: SheetEventType;
  /**
   * Static holder-rank tier (alpha/beta/chroma/delta) from the seed catalog, or
   * null when the wallet is not in it. Honest sourcing: this is NOT a measured
   * grade — it is who held a big bag when the catalog was generated. It exists
   * because the allocation signal keyed on alpha/beta seed wallets and measured
   * grades are still mostly U; [config] until grades mature, then tighten.
   */
  seedTier?: WalletTier | null;
  /**
   * USD value of the buy when the trade itself carried none.
   *
   * A SwapEvent's usdValue is computed at detection time, before the pair has a
   * price — so on exactly the brand-new coins this system hunts, it is null and
   * stays null forever. Recomputing later recovers the dial, but the number is
   * then a price from AFTER the trade, so it is sourced distinctly rather than
   * passed off as the executed value.
   */
  usdValueLate?: number | null;
}

export interface FactSheet {
  txHash: string;
  wallet: string;
  token: string;
  tokenSymbol: string;
  blockNumber: number;
  at: number;
  venue: string;
  eventType: SheetEventType;

  walletGrade: Fact<Grade>;
  /** Seed holder-rank tier — labelled as seed data, never passed off as a grade. */
  walletSeedTier: Fact<WalletTier>;
  /** Human-readable justification of the grade, for the card and the report page. */
  walletGradeReason: string;
  firstBuy: Fact<boolean>;
  pairAgeHours: Fact<number>;
  capBand: Fact<CapBand>;
  marketCap: Fact<number>;
  canSell: Fact<boolean>;
  buyUsd: Fact<number>;
  crowdSize: Fact<number>;
  /** Watched wallets that touched the token at all — buys AND allocations. */
  cohortSize: Fact<number>;
  /** Grade-point average of the crowd. Unknown when nobody in it is graded. */
  crowdGpa: Fact<number>;
  rotatedFrom: Fact<string>;
}

/**
 * Build a fact sheet. Pure: every time-dependent input is passed in, so a replay
 * of the journal reproduces the sheet exactly as it was built live.
 */
export function buildFactSheet(trade: VerifiedTrade, inputs: SheetInputs, now: number): FactSheet {
  const walletOutcomes = inputs.outcomesByWallet.get(trade.wallet.toLowerCase()) ?? [];
  const graded = gradeWallet(walletOutcomes, now);

  const crowd = inputs.crowdWallets.map((w) => {
    const o = inputs.outcomesByWallet.get(w.toLowerCase()) ?? [];
    return gradeWallet(o, now).grade;
  });
  const gpa = crowdGpa(crowd);

  return {
    txHash: trade.txHash,
    wallet: trade.wallet.toLowerCase(),
    token: trade.token.toLowerCase(),
    tokenSymbol: trade.tokenSymbol,
    blockNumber: trade.blockNumber,
    at: trade.at,
    venue: trade.venue,
    eventType: inputs.eventType ?? 'verified-buy',

    // `U` is a genuine gap in evidence, so it is reported as unknown rather than
    // as a grade — a wallet without a record must never be scored as average.
    walletGrade:
      graded.grade === 'U'
        ? unknown<Grade>(graded.reason, 'outcomes')
        : measured(graded.grade, 'outcomes'),
    walletGradeReason: graded.reason,

    walletSeedTier:
      inputs.seedTier == null
        ? unknown<WalletTier>('wallet is not in the seed holder catalog')
        : measured(inputs.seedTier, 'holder-rank-seed'),

    // firstBuy is measured only when the durable registry answered. A disabled
    // registry yields `false`, which is the conservative reading; see firstBuy.ts.
    firstBuy: measured(inputs.firstBuy, 'first-buy-registry'),

    pairAgeHours:
      inputs.pairAgeHours == null
        ? unknown<number>('pool creation block not established')
        : measured(inputs.pairAgeHours, inputs.pairAgeSource ?? 'unknown-source'),

    capBand:
      inputs.marketCap == null || inputs.marketCap <= 0
        ? unknown<CapBand>('market cap requires verified supply and a live price')
        : measured(bandFor(inputs.marketCap), 'marketcap'),

    marketCap:
      inputs.marketCap == null || inputs.marketCap <= 0
        ? unknown<number>('market cap requires verified supply and a live price')
        : measured(inputs.marketCap, 'marketcap'),

    canSell:
      inputs.canSell == null
        ? unknown<boolean>('sellability not checked — no honeypot data for this token')
        : measured(inputs.canSell, 'safety'),

    // An unpriced buy is unknown, never $0. Scoring it as zero is what made a real
    // five-figure buy on a brand-new pair contribute nothing to the legacy score.
    buyUsd:
      trade.usdValue != null
        ? measured(trade.usdValue, 'price-at-trade')
        : inputs.usdValueLate != null
          ? measured(inputs.usdValueLate, 'price-after-trade')
          : unknown<number>('no price for this pair, at trade time or since'),

    crowdSize: measured(inputs.crowdWallets.length, 'crowd-window'),
    cohortSize: measured(inputs.cohortSize ?? inputs.crowdWallets.length, 'cohort-window'),
    crowdGpa:
      gpa.gpa == null
        ? unknown<number>(`no graded wallets among ${gpa.ungraded} in the crowd`)
        : measured(gpa.gpa, 'outcomes'),

    rotatedFrom:
      inputs.rotatedFrom == null
        ? unknown<string>('no funding rotation established')
        : measured(inputs.rotatedFrom, 'attrib'),
  };
}

export function bandFor(marketCap: number): CapBand {
  return CAP_BANDS.find((b) => marketCap <= b.max)!.band;
}

/**
 * Legacy kind label, derived for wire compatibility only.
 *
 * snipurr v1 and the cipherfi archive consume `kind`, so v2 keeps emitting one —
 * but it is computed FROM the attributes here, at the edge, and nothing inside v2
 * branches on it. That is the whole difference: the label is now a rendering of
 * the facts, not a competing classification that can suppress another.
 */
export function deriveKindLabel(sheet: FactSheet): 'ENTRY' | 'SOLO' | 'BUY' {
  const crowd = sheet.crowdSize.value ?? 0;
  if (crowd >= 2) return 'BUY';
  const fresh = sheet.firstBuy.value === true;
  const young = sheet.pairAgeHours.value != null && sheet.pairAgeHours.value < 48;
  if (fresh && young) return 'ENTRY';
  return 'SOLO';
}
