/**
 * What v2 puts on the wire when a lane matches.
 *
 * Until now the shadow emitted nothing by design — the legacy engine was the
 * only thing consumers could see. This is the first thing v2 says out loud, so
 * the shape matters more than usual.
 *
 * THREE RULES IT FOLLOWS.
 *
 * 1. It is NOT a `Swarm`. The legacy shape is built around `kind`
 *    (SOLO/ENTRY/BUY) and `conviction`, and a v2 match has neither: an
 *    allocation is a wallet RECEIVING a token, which is not any of those kinds.
 *    `deriveKindLabel()` exists and was deliberately not used — it covers one of
 *    ~twenty wire fields, cannot express a distribution or a sell, and collapses
 *    unknowns to 'SOLO'. Emitting a fake kind is how 47e1 came to print
 *    "1 alpha bought @ $101k MC" over a transfer, and re-adding it here would
 *    reintroduce that exact lie one layer downstream.
 *
 * 2. Field NAMES are chosen to land in snipurr's existing normalizer without a
 *    new mapping — `firedAt` (not `at`, which it does not read), `tokenSymbol`,
 *    `score`, `marketCap`. That normalizer also stores the payload verbatim and
 *    re-normalizes it on boot, so a name that already has an alias makes history
 *    correct retroactively too.
 *
 * 3. TWO timestamps. `firedAt` is block time — when the event actually happened,
 *    which is what a human should see. `emittedAt` is when we decided, which is
 *    the only defensible input to a freshness gate: v2 retries a sheet for up to
 *    180s while its facts land, and an allocation additionally settles for ~90s
 *    so the wave can be counted. Gating entry on `firedAt` would therefore skip
 *    essentially everything, and the gate module predicts exactly this.
 */

import type { DiaryEntry } from './diary.js';
import type { CapBand, FactSheet } from './facts/sheet.js';
import type { Grade } from './facts/types.js';
import type { ScoreResult } from './score.js';

/** One matched decision, as it crosses the wire. */
export interface V2Match {
  /** Discriminator. Present ⇒ this came from the v2 brain, not the legacy engine. */
  source: 'v2';
  /** txHash. Stable across restarts and re-evaluations — the dedupe key everywhere. */
  id: string;
  token: string;
  tokenSymbol: string;
  /** Block time of the underlying event. Display and history. */
  firedAt: number;
  /** When the decision was made. Freshness gates must use THIS. */
  emittedAt: number;
  /** How the event entered: verified-buy | distribution | verified-sell. */
  eventType: string;
  /** Lane ids that matched. Never empty — an unmatched decision is not emitted. */
  lanes: string[];
  /** One human line per matched lane, e.g. "distribution, beta-seed wallet, pair 0h old". */
  laneReasons: string[];
  /**
   * 0–100. Null is possible in principle but every emitting lane carries a score
   * floor, so in practice it is a number — which matters because a null would
   * render as "—" and silently fall below every downstream alert tier.
   */
  score: number | null;
  marketCap: number | null;
  pairAgeHours: number | null;
  capBand: CapBand | null;
  /** Static holder-rank tier, NOT a performance grade. Labelled as such everywhere. */
  seedTier: string | null;
  /** Earned grade at fire time. `U` while a wallet is under the sample floor. */
  walletGrade: Grade;
  /** Distinct watched wallets on this token in the window. 1 = solo. */
  cohortSize: number;
  /**
   * TRUE when no honeypot screen has produced an answer for this token.
   *
   * The signal is allowed to fire on an unscreened coin — the reference engine does the same, and
   * blocking on it cost 14% of decisions to a check that resolves ~1% of the time. But an unscreened
   * coin must never be presented as a checked one, so the uncertainty travels WITH the match instead
   * of being dropped at the gate. Every surface that renders a match is expected to show it, and the
   * sniper refuses to buy it. False means a screen ran and said the token is sellable.
   */
  sellabilityUnverified: boolean;
  /**
   * Opaque wallet handle. The address itself is never emitted — same rule the
   * aggregate endpoints follow.
   */
  walletId: string;
}

/**
 * Build the wire payload for a matched decision.
 *
 * Pure, and takes its clock: a replay must reproduce the emitted bytes exactly,
 * which is the same determinism contract the scorer and the grader hold to.
 */
export function buildMatch(
  sheet: FactSheet,
  score: ScoreResult,
  entry: DiaryEntry,
  walletIdOf: (address: string) => string,
  now: number,
): V2Match {
  const reasons = entry.lanes.filter((l) => l.matched).map((l) => l.reason);
  return {
    source: 'v2',
    id: sheet.txHash,
    token: sheet.token,
    tokenSymbol: sheet.tokenSymbol,
    firedAt: sheet.at,
    emittedAt: now,
    eventType: sheet.eventType,
    lanes: [...entry.matchedLanes],
    laneReasons: reasons,
    score: score.score,
    marketCap: sheet.marketCap.value ?? null,
    pairAgeHours: sheet.pairAgeHours.value ?? null,
    capBand: sheet.capBand.value ?? null,
    seedTier: sheet.walletSeedTier.value ?? null,
    walletGrade: sheet.walletGrade.value ?? 'U',
    cohortSize: sheet.cohortSize.value ?? 1,
    // `isKnown` is the only honest test here: a null value with 'unknown' provenance means nothing
    // screened it, which is exactly what this flag reports.
    sellabilityUnverified: sheet.canSell.provenance !== 'measured',
    walletId: walletIdOf(sheet.wallet),
  };
}
