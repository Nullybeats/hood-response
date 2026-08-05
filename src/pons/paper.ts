import { logger } from '../logger.js';
import { config } from '../config/env.js';

/**
 * Paper trading for the Pons launchpad — the full round trip on real routes, with no capital.
 *
 * Simulating the buy proved the entry EXECUTES. It says nothing about whether the trade makes
 * money, because it stops the moment the buy lands. This carries the position the rest of the way:
 * marks it on a real executable sell quote every tick, runs the exit ladder, and closes it with a
 * realized PnL. That is the number that decides whether this strategy is worth funding, and the
 * replay put it at roughly break-even — so it needs measuring live, not assuming.
 *
 * **Deliberately separate from the real position store.** Paper positions never touch
 * `SniperStateStore`, never appear in the portfolio, and never enter `sniper_closed_trades`. That is
 * not fastidiousness: a synthetic `0xtok`/`GEM` row once leaked into the live store and produced a
 * genuine scare about an open position. Paper stays in its own book, and every field name here says
 * so.
 *
 * In-memory and bounded. A restart loses the open book, which is the correct trade-off for
 * observational data — nothing here is owed to anyone, and the alternative is paper state that
 * outlives its own assumptions.
 */

export interface PaperPosition {
  id: string;
  token: string;
  symbol: string;
  deployer: string;
  /** Notional we pretended to spend. */
  ethIn: number;
  /** Tokens the simulated buy actually returned, at the gate block. */
  tokens: number;
  openedAt: number;
  /** Entry price in ETH per token, from the simulated fill — not a mid. */
  entryPrice: number;
  /** Latest executable sell value of the whole lot, in ETH. */
  markEth: number;
  /** High-water mark of `markEth` since entry — drives the trailing stop. */
  peakEth: number;
  /** ETH banked by the recoup partial, if it fired. */
  bankedEth: number;
  recoupDone: boolean;
  /** Fraction of the original lot still held (1 until a recoup sells part of it). */
  remainingFrac: number;
  updatedAt: number;
  /** Consecutive ticks where the pool could not quote a sell — liquidity is gone. */
  unquotableTicks: number;
}

export interface PaperClosed extends PaperPosition {
  closedAt: number;
  exitReason: 'stop' | 'trailing' | 'time' | 'rug' | 'recoup-then-trail';
  /** Total ETH out: banked recoup + final exit. Gas is subtracted; it is a real cost even on paper. */
  ethOut: number;
  pnlEth: number;
  multiple: number;
  heldMs: number;
}

/**
 * Exit ladder, seeded from the replay evidence rather than the engine's live defaults.
 *
 * Over 195 replayed launches the ONLY positive configuration was a wide/runner shape (+15.8%);
 * bank-early variants lifted win rate to 40% and still lost 9.7%, because they cap the fat tail that
 * is the entire edge. These are intentionally NOT the feed sniper's numbers.
 */
const STOP_PCT = 0.4;
const TRAIL_PCT = 0.5;
/** Trail applied AFTER recoup — wider still, because the remainder is house money. */
const MOONBAG_TRAIL_PCT = 0.6;
const RECOUP_AT_MULT = 3;
const TIME_STOP_MS = 45 * 60_000;
/** Two consecutive unquotable ticks = the pool stopped being able to sell. Treated as a rug. */
const UNQUOTABLE_LIMIT = 2;
/** Gas per simulated leg, in ETH — measured at ~200k gas on live Pons buys. */
const GAS_PER_LEG_ETH = 0.0000002;

const open = new Map<string, PaperPosition>();
const closed: PaperClosed[] = [];
const MAX_CLOSED = 200;

export function paperOpen(): PaperPosition[] {
  return [...open.values()].sort((a, b) => b.openedAt - a.openedAt);
}
export function paperClosed(limit = 100): PaperClosed[] {
  return closed.slice(-limit).reverse();
}
export function paperHolds(token: string): boolean {
  return open.has(token.toLowerCase());
}

export function openPaperPosition(p: {
  token: string; symbol: string; deployer: string; ethIn: number; tokens: number;
}): void {
  const token = p.token.toLowerCase();
  if (open.has(token) || !(p.tokens > 0)) return;
  const now = Date.now();
  open.set(token, {
    id: `paper:${token}:${now}`,
    token,
    symbol: p.symbol,
    deployer: p.deployer,
    ethIn: p.ethIn,
    tokens: p.tokens,
    openedAt: now,
    entryPrice: p.ethIn / p.tokens,
    markEth: p.ethIn,
    peakEth: p.ethIn,
    bankedEth: 0,
    recoupDone: false,
    remainingFrac: 1,
    updatedAt: now,
    unquotableTicks: 0,
  });
}

export interface PaperSummary {
  open: number;
  closed: number;
  wins: number;
  winRatePct: number | null;
  totalPnlEth: number;
  totalInEth: number;
  roiPct: number | null;
  avgMultiple: number | null;
  bestMultiple: number | null;
  medianHeldMin: number | null;
  byReason: Record<string, number>;
}

export function paperSummary(): PaperSummary {
  const wins = closed.filter((c) => c.pnlEth > 0).length;
  const totalIn = closed.reduce((s, c) => s + c.ethIn, 0);
  const totalPnl = closed.reduce((s, c) => s + c.pnlEth, 0);
  const held = closed.map((c) => c.heldMs).sort((a, b) => a - b);
  const byReason: Record<string, number> = {};
  for (const c of closed) byReason[c.exitReason] = (byReason[c.exitReason] ?? 0) + 1;
  return {
    open: open.size,
    closed: closed.length,
    wins,
    winRatePct: closed.length ? (100 * wins) / closed.length : null,
    totalPnlEth: totalPnl,
    totalInEth: totalIn,
    roiPct: totalIn > 0 ? (100 * totalPnl) / totalIn : null,
    avgMultiple: closed.length ? closed.reduce((s, c) => s + c.multiple, 0) / closed.length : null,
    bestMultiple: closed.length ? Math.max(...closed.map((c) => c.multiple)) : null,
    medianHeldMin: held.length ? held[Math.floor(held.length / 2)]! / 60_000 : null,
    byReason,
  };
}

function close(p: PaperPosition, reason: PaperClosed['exitReason'], exitEth: number): void {
  const ethOut = p.bankedEth + exitEth - GAS_PER_LEG_ETH * (p.recoupDone ? 3 : 2);
  const rec: PaperClosed = {
    ...p,
    closedAt: Date.now(),
    exitReason: reason,
    ethOut,
    pnlEth: ethOut - p.ethIn,
    // Floored at 0. Gas can drag ethOut slightly below zero on a total loss, and while "you lost
    // marginally more than the stake" is true, a negative MULTIPLE is not a meaningful quantity —
    // pnlEth already carries that detail honestly.
    multiple: p.ethIn > 0 ? Math.max(0, ethOut / p.ethIn) : 0,
    heldMs: Date.now() - p.openedAt,
  };
  open.delete(p.token);
  closed.push(rec);
  if (closed.length > MAX_CLOSED) closed.splice(0, closed.length - MAX_CLOSED);
  logger.info(
    { token: p.token, reason, pnlEth: rec.pnlEth.toFixed(6), multiple: rec.multiple.toFixed(2), heldMin: (rec.heldMs / 60_000).toFixed(1) },
    'pons paper: closed',
  );
}

/**
 * One monitor tick over the open book.
 *
 * `quoteSell` returns the executable ETH value of a holding, or null when the pool cannot quote —
 * which is itself the signal that liquidity has left. A null is NOT treated as zero: one failed RPC
 * would otherwise register as a total loss and close the position at the worst possible mark.
 */
export async function tickPaper(quoteSell: (token: string, tokens: number) => Promise<number | null>): Promise<void> {
  const now = Date.now();
  for (const p of [...open.values()]) {
    const held = p.tokens * p.remainingFrac;
    const mark = await quoteSell(p.token, held).catch(() => null);

    if (mark === null) {
      p.unquotableTicks += 1;
      if (p.unquotableTicks >= UNQUOTABLE_LIMIT) close(p, 'rug', 0);
      continue;
    }
    p.unquotableTicks = 0;
    p.markEth = mark;
    p.updatedAt = now;
    // Peak tracks the value of what we STILL hold plus what we already banked, so a recoup doesn't
    // reset the high-water mark and instantly trip the trail.
    const total = mark + p.bankedEth;
    if (total > p.peakEth) p.peakEth = total;

    const mult = total / p.ethIn;

    // 1. Rug/stop — the floor.
    if (mult <= 1 - STOP_PCT) {
      close(p, 'stop', mark);
      continue;
    }
    // 2. Recoup: take the stake back out, ride the rest free.
    if (!p.recoupDone && mult >= RECOUP_AT_MULT) {
      const sellFrac = Math.min(0.9, p.ethIn / mark);
      p.bankedEth += mark * sellFrac;
      p.remainingFrac *= 1 - sellFrac;
      p.recoupDone = true;
      logger.info({ token: p.token, bankedEth: p.bankedEth.toFixed(6) }, 'pons paper: recouped stake');
      continue;
    }
    // 3. Trailing stop — widens once the stake is out.
    const trail = p.recoupDone ? MOONBAG_TRAIL_PCT : TRAIL_PCT;
    if (p.peakEth > p.ethIn && total <= p.peakEth * (1 - trail)) {
      close(p, p.recoupDone ? 'recoup-then-trail' : 'trailing', mark);
      continue;
    }
    // 4. Time stop.
    if (now - p.openedAt >= TIME_STOP_MS) close(p, 'time', mark);
  }
}

export const paperEnabled = (): boolean => config.PONS_ENABLED && config.PONS_DRY_RUN;
