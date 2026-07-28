import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { PriceOracle } from '../chain/price.js';
import type { Swarm } from '../types.js';
import { SwapExecutor } from './executor.js';
import { SafetyChecker } from '../chain/safety.js';

/** Absolute floor on any single buy, regardless of the configured amount. */
export const MIN_BUY_ETH = 0.0005;
const SAMPLE_MS = 60_000;

export interface Position {
  id: string;
  token: string;
  tokenSymbol: string;
  kind: string;
  conviction: number;
  ethIn: number;
  entryPriceUsd: number;
  entryMarketCap: number;
  tokensReceived: number;
  buyTx: string;
  openedAt: number;
  lastPriceUsd: number;
  updatedAt: number;
  /** High-water mark price since entry (initialised to entry). Drives the trailing stop. */
  peakPriceUsd?: number;
  status: 'open' | 'closed';
  closedAt?: number;
  sellTx?: string;
  exitPriceUsd?: number;
  closeReason?: 'take-profit' | 'manual' | 'trailing-stop';
  /** Per-position take-profit %, overriding the global setting when set.
   *  null explicitly disables take-profit for this position. */
  takeProfitPct?: number | null;
  /** Real network fee paid for the buy tx, ETH. Undefined for 'imported'
   *  positions (no real buy tx to read gas from). */
  buyGasEth?: number;
  /** Real network fee paid for the sell tx, ETH — set once closed. */
  sellGasEth?: number;
  /** GoPlus buy/sell tax % at buy time, for reference (null = unknown/unscanned). */
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  /** Documented DEX-hook protocol fee taken per swap (e.g. Bags' 2%), separate
   *  from gas and from any ERC-20 tax GoPlus can see. null = no known hook fee. */
  protocolFeePctPerSwap?: number | null;

  // ── Execution telemetry (Track 1) — the microstructure that tells a bad signal
  //    from a bad fill. All best-effort; undefined on imported/legacy positions. ──
  /** Round-trip loss % estimated at entry (buy→instant-sell): the pool's floor cost at our size. */
  entryRoundTripPct?: number;
  /** Buy fill vs the pre-trade quote: (1 − tokensReceived/quotedTokens)·100. */
  entrySlippagePct?: number;
  /** Sell fill vs the pre-trade quote: (1 − actualEthOut/quotedEthOut)·100 — the gap BURN hid. */
  exitSlippagePct?: number;
  /** ACTUAL ETH received on the sell (native Δ + gas), not the quote. */
  exitValueEth?: number;
  /** Which venue executed (v4 / v3). */
  venue?: 'v4' | 'v3';
  /** Raw on-chain pool liquidity (uint128 L) at entry — relative depth proxy. */
  poolLiquidityEntry?: number | null;
  /** Alert-timestamp → buy-confirmed latency, ms (how late we entered the swarm). */
  buyLatencyMs?: number;
}

/** Runtime-adjustable knobs (seeded from env, editable via the API). */
export interface SniperSettings {
  enabled: boolean;
  minConviction: number;
  maxConviction: number;
  buyEth: number;
  takeProfitPct: number;
  /** Trailing stop % off the high-water mark. Because the high-water starts at entry, this doubles
   *  as the stop-loss: a coin that never runs exits at −trailingStopPct; a runner exits that far
   *  below its peak. 0 = off. This is the validated edge (tight ~15% on non-SOLO swarms). */
  trailingStopPct: number;
  /** Require the honeypot/sellability check to pass before buying (never buy what we can't sell). */
  requireSafe: boolean;
  /** Comma-separated alert kinds to snipe, e.g. "BUY,ENTRY" (non-SOLO). Case-insensitive. */
  kinds: string;
  /** Depth gate: skip a buy when the round-trip loss at our size exceeds this %. 0 = off. */
  maxRoundtripPct: number;
  /** After a token stops us out at a loss, don't re-buy it for this many minutes — stops the
   *  re-buy-the-whipsaw money pump (a token that just trailing-stopped us keeps re-signalling). 0 = off. */
  lossCooldownMin: number;
}

const priceRatio = (p: Position, price: number): number =>
  p.entryPriceUsd > 0 ? price / p.entryPriceUsd : 1;

/** Live-computed view of a position for the API/dashboard. */
function view(p: Position) {
  const ref = p.status === 'closed' ? (p.exitPriceUsd ?? p.lastPriceUsd) : p.lastPriceUsd;
  const ratio = priceRatio(p, ref);
  // Closed positions value at the ACTUAL ETH received when we have it (the real
  // fill, slippage and all) — not the price-ratio estimate. Open positions still
  // mark-to-market off the live price.
  const valueEth =
    p.status === 'closed' && p.exitValueEth != null ? p.exitValueEth : p.ethIn * ratio;
  const pnlEth = valueEth - p.ethIn;
  const gasEth = (p.buyGasEth ?? 0) + (p.sellGasEth ?? 0);
  return {
    ...p,
    valueEth: Math.round(valueEth * 1e6) / 1e6,
    pnlEth: Math.round(pnlEth * 1e6) / 1e6,
    pnlPct: p.ethIn > 0 ? Math.round((pnlEth / p.ethIn) * 1000) / 10 : 0,
    gasEth: Math.round(gasEth * 1e6) / 1e6,
    /** PnL after subtracting real network fees paid so far (buy gas always,
     *  sell gas once closed) — the honest "what did I actually net" number. */
    netPnlEth: Math.round((pnlEth - gasEth) * 1e6) / 1e6,
  };
}

/**
 * Auto-buys qualifying alerts with a server hot wallet and manages the open
 * positions (live value, PnL, take-profit auto-sell). Off by default; when on
 * it places REAL swaps through the SwapExecutor. All spending is bounded by the
 * per-trade and daily caps and the absolute MIN_BUY_ETH floor.
 */
export class SniperEngine {
  private readonly positions = new Map<string, Position>();
  private readonly buys: { at: number; eth: number }[] = [];
  /** Last 20 untracked positions (audit trail — the real buy tx / cost basis
   *  is never lost just because a position was untracked, only when sold). */
  private readonly removedLog: (Position & { at: number })[] = [];
  /** Recent buy/skip decisions with reasons — powers the "why didn't it buy?"
   *  list on the dashboard. Newest is last. */
  private readonly decisions: {
    at: number;
    tokenSymbol: string;
    kind: string;
    conviction: number;
    action: 'bought' | 'skipped';
    reason: string;
  }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private warnedUnconfigured = false;
  readonly executor: SwapExecutor;
  private readonly safety: SafetyChecker;

  settings: SniperSettings = {
    enabled: config.SNIPER_ENABLED,
    minConviction: config.SNIPER_MIN_CONVICTION,
    maxConviction: config.SNIPER_MAX_CONVICTION,
    buyEth: config.SNIPER_BUY_ETH,
    takeProfitPct: config.SNIPER_TAKE_PROFIT_PCT,
    trailingStopPct: config.SNIPER_TRAILING_STOP_PCT,
    requireSafe: config.SNIPER_REQUIRE_SAFE,
    kinds: [...config.sniperKinds].join(','),
    maxRoundtripPct: config.SNIPER_MAX_ROUNDTRIP_PCT,
    lossCooldownMin: config.SNIPER_LOSS_COOLDOWN_MIN,
  };

  /** token → timestamp we last stopped out at a loss. Drives the re-buy cooldown. In-memory
   *  (resets on restart, which is fine — a fresh process starts with a clean slate). */
  private readonly recentLosses = new Map<string, number>();

  constructor(
    private readonly price: PriceOracle,
    executor?: SwapExecutor,
    safety?: SafetyChecker,
  ) {
    this.executor = executor ?? new SwapExecutor();
    this.safety = safety ?? new SafetyChecker();
  }

  /** Best-effort buy/sell tax lookup — never blocks or fails the caller. */
  private async lookupTax(token: string): Promise<{ buyTaxPct: number | null; sellTaxPct: number | null }> {
    try {
      const liq = this.price.liquidityOf(token);
      const report = await this.safety.check(token, liq);
      return { buyTaxPct: report.buyTaxPct, sellTaxPct: report.sellTaxPct };
    } catch {
      return { buyTaxPct: null, sellTaxPct: null };
    }
  }

  /** Best-effort documented DEX-hook fee lookup (e.g. Bags' 2%/swap). */
  private async lookupProtocolFee(token: string): Promise<number | null> {
    try {
      const info = await this.executor.protocolFeeInfo(token, this.price.pairIdOf(token));
      return info.feePctPerSwap;
    } catch {
      return null;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Effective per-trade size after the floor and per-trade ceiling. */
  private sizeEth(): number {
    return Math.min(config.SNIPER_MAX_ETH_PER_TRADE, Math.max(MIN_BUY_ETH, this.settings.buyEth));
  }

  private spentLast24h(now: number): number {
    const cut = now - 86_400_000;
    return this.buys.filter((b) => b.at >= cut).reduce((s, b) => s + b.eth, 0);
  }

  private holdsOpen(token: string): boolean {
    for (const p of this.positions.values()) if (p.status === 'open' && p.token === token) return true;
    return false;
  }

  /** Record why the sniper did or didn't act on an alert (newest kept last). */
  private decide(swarm: Swarm, action: 'bought' | 'skipped', reason: string): void {
    this.decisions.push({
      at: Date.now(),
      tokenSymbol: swarm.tokenSymbol,
      kind: swarm.kind,
      conviction: swarm.conviction,
      action,
      reason,
    });
    if (this.decisions.length > 30) this.decisions.shift();
    if (action === 'skipped') {
      logger.info({ token: swarm.tokenSymbol, kind: swarm.kind, conviction: swarm.conviction, reason }, 'sniper: skipped alert');
    }
  }

  /** Alert hook: decide whether to snipe, and buy if so. */
  async onAlert(swarm: Swarm): Promise<void> {
    if (!this.settings.enabled) return this.decide(swarm, 'skipped', 'sniper is OFF');
    const allowedKinds = new Set(this.settings.kinds.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean));
    if (!allowedKinds.has(swarm.kind)) return this.decide(swarm, 'skipped', `kind ${swarm.kind} not in buy list`);
    if (swarm.conviction < this.settings.minConviction || swarm.conviction > this.settings.maxConviction)
      return this.decide(swarm, 'skipped', `conviction ${swarm.conviction} outside ${this.settings.minConviction}-${this.settings.maxConviction}`);
    if (this.holdsOpen(swarm.token)) return this.decide(swarm, 'skipped', 'already holding this token');

    // Recent-loss cooldown: a token that just stopped us out keeps re-signalling; re-buying it
    // into the same whipsaw is a money pump (see BURN: repeated −22%/−27% trailing-stop losses).
    const cool = this.settings.lossCooldownMin;
    if (cool > 0) {
      const lostAt = this.recentLosses.get(swarm.token);
      if (lostAt && Date.now() - lostAt < cool * 60_000) {
        const mins = Math.ceil((cool * 60_000 - (Date.now() - lostAt)) / 60_000);
        return this.decide(swarm, 'skipped', `loss cooldown: stopped out recently, ${mins}m left`);
      }
    }

    const entryPrice = swarm.priceUsd ?? 0;
    if (!swarm.priceLive || !(entryPrice > 0)) return this.decide(swarm, 'skipped', 'no live price');

    if (!this.executor.ready) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        logger.warn('sniper is ON but the wallet/router/WETH are not configured — no buys will run');
      }
      return this.decide(swarm, 'skipped', 'wallet not connected');
    }

    const now = Date.now();
    const size = this.sizeEth();
    if (this.spentLast24h(now) + size > config.SNIPER_DAILY_CAP_ETH) {
      return this.decide(swarm, 'skipped', 'daily spend cap reached');
    }

    // Honeypot / sellability gate — never buy something we can't sell (the −100% trap). Cached, cheap.
    if (this.settings.requireSafe) {
      const safe = await this.safety.check(swarm.token, this.price.liquidityOf(swarm.token)).catch(() => null);
      if (safe && safe.ok === false) return this.decide(swarm, 'skipped', `unsafe: ${(safe.hardFails ?? []).join(', ')}`);
    }

    // Depth gate (Track 1): a round-trip preview measures the true floor cost of a
    // trade at our size — price impact both ways + LP fees + hook tax — BEFORE any
    // ETH moves. Refuse pools we couldn't exit cleanly (the BURN −22.8% failure mode).
    const roundTrip = await this.executor.previewRoundTrip(swarm.token, size, this.price.pairIdOf(swarm.token)).catch(() => null);
    if (this.settings.maxRoundtripPct > 0 && roundTrip && roundTrip.lossPct > this.settings.maxRoundtripPct) {
      return this.decide(swarm, 'skipped', `too thin: round-trip −${roundTrip.lossPct.toFixed(0)}% > ${this.settings.maxRoundtripPct}% cap`);
    }

    try {
      const ethUsd = this.price.ethUsdPrice();
      const expectedPriceEth = ethUsd && ethUsd > 0 ? entryPrice / ethUsd : null;
      const res = await this.executor.buy(swarm.token, size, this.price.pairIdOf(swarm.token), expectedPriceEth);
      const filledAt = Date.now();
      this.buys.push({ at: now, eth: res.ethSpent });
      const [tax, protocolFeePctPerSwap] = await Promise.all([
        this.lookupTax(swarm.token),
        this.lookupProtocolFee(swarm.token),
      ]);
      const entrySlippagePct =
        res.quotedTokens > 0 ? (1 - res.tokensReceived / res.quotedTokens) * 100 : undefined;
      const alertTs = swarm.firstSeen || now;
      const pos: Position = {
        id: randomUUID(),
        token: swarm.token,
        tokenSymbol: swarm.tokenSymbol,
        kind: swarm.kind,
        conviction: swarm.conviction,
        ethIn: res.ethSpent,
        entryPriceUsd: entryPrice,
        entryMarketCap: swarm.marketCap,
        tokensReceived: res.tokensReceived,
        buyTx: res.txHash,
        openedAt: now,
        lastPriceUsd: entryPrice,
        updatedAt: now,
        status: 'open',
        buyGasEth: res.gasEth,
        buyTaxPct: tax.buyTaxPct,
        sellTaxPct: tax.sellTaxPct,
        protocolFeePctPerSwap,
        venue: res.venue,
        entrySlippagePct,
        entryRoundTripPct: roundTrip?.lossPct,
        poolLiquidityEntry: roundTrip?.poolLiquidity ?? null,
        buyLatencyMs: filledAt - alertTs,
      };
      this.positions.set(pos.id, pos);
      this.decide(swarm, 'bought', `bought ${size} Ξ · tx ${res.txHash.slice(0, 10)}`);
      logger.info(
        { token: swarm.tokenSymbol, eth: size, conviction: swarm.conviction, tx: res.txHash },
        'sniper: opened position',
      );
      void this.persist();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.decide(swarm, 'skipped', `buy failed: ${msg.slice(0, 80)}`);
      logger.error({ token: swarm.tokenSymbol, err: String(err) }, 'sniper: buy failed');
    }
  }

  /** Periodic: refresh open-position prices and fire take-profit sells. */
  private async sample(): Promise<void> {
    const now = Date.now();
    const open = [...this.positions.values()].filter((p) => p.status === 'open');
    for (const p of open) {
      try {
        await this.price.refreshNow(p.token);
      } catch {
        /* transient */
      }
      const px = this.price.isLive(p.token) ? this.price.priceOf(p.token) : 0;
      if (px > 0) {
        p.lastPriceUsd = px;
        p.updatedAt = now;
        // High-water mark (starts at entry) — drives the trailing stop.
        p.peakPriceUsd = Math.max(p.peakPriceUsd ?? p.entryPriceUsd, px);
        // 1) Trailing stop (downside first). Peak starts at entry, so this also caps the loss at
        //    −trailingStopPct on coins that never run — the validated tight-stop edge.
        const trail = this.settings.trailingStopPct;
        if (trail > 0 && p.peakPriceUsd > 0 && px <= p.peakPriceUsd * (1 - trail / 100)) {
          await this.closeOut(p, 'trailing-stop');
          continue;
        }
        // 2) Take-profit (upside cap). Per-position TP overrides the global; null disables it.
        const tp = p.takeProfitPct !== undefined ? (p.takeProfitPct ?? 0) : this.settings.takeProfitPct;
        if (tp > 0 && p.entryPriceUsd > 0 && (px / p.entryPriceUsd - 1) * 100 >= tp) {
          await this.takeProfit(p);
        }
      }
    }
    void this.persist();
  }

  private async closePosition(p: Position, reason: 'take-profit' | 'manual' | 'trailing-stop'): Promise<void> {
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = p.lastPriceUsd > 0 && ethUsd && ethUsd > 0 ? p.lastPriceUsd / ethUsd : null;
    const res = await this.executor.sell(p.token, this.price.pairIdOf(p.token), expectedPriceEth);
    p.status = 'closed';
    p.closedAt = Date.now();
    p.sellTx = res.txHash;
    // Exit price from the ACTUAL eth received (not the quote): the realized fill.
    if (p.tokensReceived > 0 && ethUsd && ethUsd > 0) {
      p.exitPriceUsd = (res.ethReceived * ethUsd) / p.tokensReceived;
    } else {
      p.exitPriceUsd = p.lastPriceUsd;
    }
    p.closeReason = reason;
    p.sellGasEth = res.gasEth;
    p.exitValueEth = res.ethReceived;
    p.exitSlippagePct =
      res.quotedEthOut > 0 ? (1 - res.ethReceived / res.quotedEthOut) * 100 : undefined;
    if (res.venue) p.venue = res.venue;
    // Record a loss for the re-buy cooldown: real ETH out < ETH in (net of nothing — the raw fill).
    if (p.exitValueEth != null && p.exitValueEth < p.ethIn) {
      this.recentLosses.set(p.token, Date.now());
    }
    logger.info(
      { token: p.tokenSymbol, tx: res.txHash, ethOut: res.ethReceived, quoted: res.quotedEthOut, exitSlipPct: p.exitSlippagePct, reason },
      'sniper: position sold',
    );
    void this.journal(p);
    void this.persist();
  }

  /** Append a closed trade's full telemetry to the JSONL journal for offline
   *  analysis (slippage in/out, gas, venue, latency, round-trip). Best-effort:
   *  a journal write must never affect the trade or throw into the sell path. */
  private async journal(p: Position): Promise<void> {
    if (!config.SNIPER_JOURNAL_PATH) return;
    try {
      const grossPnlEth = (p.exitValueEth ?? 0) - p.ethIn;
      const netPnlEth = grossPnlEth - (p.buyGasEth ?? 0) - (p.sellGasEth ?? 0);
      const row = {
        at: p.closedAt ?? Date.now(),
        token: p.token,
        symbol: p.tokenSymbol,
        kind: p.kind,
        conviction: p.conviction,
        venue: p.venue ?? null,
        ethIn: p.ethIn,
        exitValueEth: p.exitValueEth ?? null,
        entryPriceUsd: p.entryPriceUsd,
        exitPriceUsd: p.exitPriceUsd ?? null,
        peakPriceUsd: p.peakPriceUsd ?? null,
        peakPct: p.peakPriceUsd && p.entryPriceUsd > 0 ? (p.peakPriceUsd / p.entryPriceUsd - 1) * 100 : null,
        closeReason: p.closeReason ?? null,
        entryRoundTripPct: p.entryRoundTripPct ?? null,
        entrySlippagePct: p.entrySlippagePct ?? null,
        exitSlippagePct: p.exitSlippagePct ?? null,
        buyGasEth: p.buyGasEth ?? null,
        sellGasEth: p.sellGasEth ?? null,
        buyTaxPct: p.buyTaxPct ?? null,
        sellTaxPct: p.sellTaxPct ?? null,
        protocolFeePctPerSwap: p.protocolFeePctPerSwap ?? null,
        poolLiquidityEntry: p.poolLiquidityEntry ?? null,
        buyLatencyMs: p.buyLatencyMs ?? null,
        holdMs: p.closedAt && p.openedAt ? p.closedAt - p.openedAt : null,
        grossPnlEth,
        netPnlEth,
        netPnlPct: p.ethIn > 0 ? (netPnlEth / p.ethIn) * 100 : null,
      };
      await mkdir(dirname(config.SNIPER_JOURNAL_PATH), { recursive: true }).catch(() => undefined);
      await writeFile(config.SNIPER_JOURNAL_PATH, JSON.stringify(row) + '\n', { flag: 'a' });
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper: journal append failed');
    }
  }

  private async takeProfit(p: Position): Promise<void> {
    await this.closeOut(p, 'take-profit');
  }

  /** Close a position for a rules-driven reason (take-profit / trailing-stop), logging on failure.
   *  A failed sell leaves the position OPEN so the next sample retries — the honeypot escape hatch. */
  private async closeOut(p: Position, reason: 'take-profit' | 'trailing-stop'): Promise<void> {
    if (p.status !== 'open') return;
    try {
      await this.closePosition(p, reason);
    } catch (err) {
      logger.error({ token: p.tokenSymbol, reason, err: String(err) }, `sniper: ${reason} sell failed`);
    }
  }

  /** Manual "sell now" for an open position (before take-profit is hit). */
  async sellNow(id: string): Promise<Position> {
    const p = this.positions.get(id);
    if (!p || p.status !== 'open') throw new Error('position not open');
    await this.closePosition(p, 'manual');
    return p;
  }

  /** Set a per-position take-profit override. A number overrides the global
   *  setting for this position only; null explicitly disables TP for it;
   *  undefined clears the override, reverting to the global default. */
  setPositionTakeProfit(id: string, pct: number | null | undefined): Position {
    const p = this.positions.get(id);
    if (!p || p.status !== 'open') throw new Error('position not open');
    if (pct === undefined) delete p.takeProfitPct;
    else p.takeProfitPct = pct === null ? null : Math.max(0, pct);
    void this.persist();
    return p;
  }

  /** Stop tracking a position WITHOUT selling — for clearing a bad/duplicate
   *  import (e.g. one recorded before a metadata fix). The wallet's tokens are
   *  untouched; re-import to pick it back up correctly. The removed record
   *  (including its buy tx) is kept in a short audit log so an accidental
   *  Untrack of a REAL bought position never loses the tx hash / cost basis. */
  untrack(id: string): boolean {
    const p = this.positions.get(id);
    if (!p) return false;
    this.removedLog.push({ at: Date.now(), ...p });
    if (this.removedLog.length > 20) this.removedLog.shift();
    this.positions.delete(id);
    void this.persist();
    return true;
  }

  /** Set the hot-wallet key at runtime (from the dashboard). Returns the derived
   *  address. Never persisted; lives in memory until restart. */
  setPrivateKey(pk: string): string {
    return this.executor.setPrivateKey(pk);
  }

  /** Manual one-off buy to validate the router before trusting auto-fire. Still
   *  bounded by the min-buy floor and per-trade cap. */
  async testBuy(token: string, ethAmount: number): Promise<Position> {
    if (!this.executor.ready) throw new Error('wallet not configured');
    const size = Math.min(config.SNIPER_MAX_ETH_PER_TRADE, Math.max(MIN_BUY_ETH, ethAmount));
    const now = Date.now();
    const px = this.price.isLive(token) ? this.price.priceOf(token) : 0;
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = px > 0 && ethUsd && ethUsd > 0 ? px / ethUsd : null;
    const res = await this.executor.buy(token, size, this.price.pairIdOf(token), expectedPriceEth);
    this.buys.push({ at: now, eth: res.ethSpent });
    const [tax, protocolFeePctPerSwap] = await Promise.all([
      this.lookupTax(token),
      this.lookupProtocolFee(token),
    ]);
    const pos: Position = {
      id: randomUUID(),
      token,
      tokenSymbol: 'TEST-' + token.slice(2, 8).toUpperCase(),
      kind: 'TEST',
      conviction: 0,
      ethIn: res.ethSpent,
      entryPriceUsd: px > 0 ? px : 0,
      entryMarketCap: 0,
      tokensReceived: res.tokensReceived,
      buyTx: res.txHash,
      openedAt: now,
      lastPriceUsd: px > 0 ? px : 0,
      updatedAt: now,
      status: 'open',
      buyGasEth: res.gasEth,
      buyTaxPct: tax.buyTaxPct,
      sellTaxPct: tax.sellTaxPct,
      protocolFeePctPerSwap,
    };
    this.positions.set(pos.id, pos);
    void this.persist();
    return pos;
  }

  /** Recover/import a holding the wallet already has (e.g. a position lost to a
   *  redeploy, or a manual buy) so it shows up and can be sold / TP-managed.
   *  Pulls the real symbol/supply from the token contract and forces a live
   *  price fetch — without a real entryPriceUsd, PnL/take-profit can't work.
   *  ethIn is set to the current sellable value, so PnL tracks from import. */
  /** Clear any existing OPEN record for `token` before creating a new one —
   *  but only when that record is itself a previous import/restore (or the
   *  exact same real tx being re-confirmed). A REAL bought position with a
   *  DIFFERENT real tx is never silently replaced. */
  private clearReplaceableRecord(token: string, incomingTx: string): void {
    for (const [id, p] of this.positions) {
      if (p.status !== 'open' || p.token.toLowerCase() !== token.toLowerCase()) continue;
      const isRealDifferentTx = p.buyTx !== 'imported' && p.buyTx.toLowerCase() !== incomingTx.toLowerCase();
      if (isRealDifferentTx) {
        throw new Error(
          `already tracking a REAL bought position for this token (tx ${p.buyTx.slice(0, 10)}…, ${p.ethIn} Ξ in) — Untrack it first if you really want to replace it`,
        );
      }
      this.positions.delete(id);
    }
  }

  async importPosition(token: string): Promise<Position> {
    if (!this.executor.ready) throw new Error('wallet not connected');
    this.clearReplaceableRecord(token, 'imported');
    const [{ tokens, ethOut: onChainEthOut }, meta] = await Promise.all([
      this.executor.valueInEth(token, this.price.pairIdOf(token)),
      this.executor.tokenMeta(token),
    ]);
    // Force a fresh price fetch — this token may never have been priced before
    // (bought directly via the sniper, bypassing normal discovery).
    await this.price.refreshNow(token).catch(() => undefined);
    const px = this.price.isLive(token) ? this.price.priceOf(token) : 0;
    if (px <= 0) {
      throw new Error('no live price available for this token yet — try again in a few seconds');
    }
    // Value the holding from the trusted market price (tokens × USD price ÷ ETH
    // USD price) rather than the raw on-chain swap quote — a thin/odd v4 route
    // can quote near-zero even when the token has a real, priced market value.
    // ETH's own USD rate is derived from any live pair's priceUsd/priceNative
    // ratio (see PriceOracle.ethUsdPrice) — DexScreener never returns a direct
    // listing for WETH itself, since it's the quote side of virtually every
    // pair here, never the base.
    let ethOut = onChainEthOut;
    const ethUsd = this.price.ethUsdPrice();
    if (ethUsd && ethUsd > 0) {
      const marketEthValue = (tokens * px) / ethUsd;
      if (marketEthValue > onChainEthOut) ethOut = marketEthValue;
    }
    const now = Date.now();
    const pos: Position = {
      id: randomUUID(),
      token,
      tokenSymbol: meta.symbol,
      kind: 'IMPORT',
      conviction: 0,
      ethIn: Math.round(ethOut * 1e8) / 1e8,
      entryPriceUsd: px,
      entryMarketCap: Math.round(px * meta.totalSupply),
      tokensReceived: tokens,
      buyTx: 'imported',
      openedAt: now,
      lastPriceUsd: px,
      updatedAt: now,
      status: 'open',
    };
    this.positions.set(pos.id, pos);
    void this.persist();
    logger.info({ token, tokens, ethOut }, 'sniper: imported position');
    return pos;
  }

  /**
   * Restore a position from a REAL buy transaction hash — reads the actual
   * ETH spent and tokens received straight from the chain, so the entry data
   * is exact (not a re-valued guess like importPosition). entryPriceUsd is
   * derived from the real spend ratio (ethSpent×ETH-USD ÷ tokensReceived)
   * using the current ETH/USD rate as the best available approximation, which
   * gives an accurate PnL baseline immediately instead of starting at +0%.
   */
  async restoreFromTx(token: string, txHash: string): Promise<Position> {
    if (!this.executor.ready) throw new Error('wallet not connected');
    this.clearReplaceableRecord(token, txHash);
    const [{ ethSpent, tokensReceived, blockTimestamp, gasEth }, meta, tax, protocolFeePctPerSwap] =
      await Promise.all([
        this.executor.readBuyTx(token, txHash),
        this.executor.tokenMeta(token),
        this.lookupTax(token),
        this.lookupProtocolFee(token),
      ]);
    await this.price.refreshNow(token).catch(() => undefined);
    const currentPx = this.price.isLive(token) ? this.price.priceOf(token) : 0;
    const ethUsd = this.price.ethUsdPrice();
    let entryPriceUsd = 0;
    if (ethUsd && ethUsd > 0 && tokensReceived > 0) {
      entryPriceUsd = (ethSpent * ethUsd) / tokensReceived; // real cost basis
    } else if (currentPx > 0) {
      entryPriceUsd = currentPx; // no ETH/USD rate yet — fall back, PnL starts at 0%
    } else {
      throw new Error('no price data available yet to value this position — try again in a few seconds');
    }
    const now = Date.now();
    const pos: Position = {
      id: randomUUID(),
      token,
      tokenSymbol: meta.symbol,
      kind: 'BUY',
      conviction: 0,
      ethIn: Math.round(ethSpent * 1e8) / 1e8,
      entryPriceUsd,
      entryMarketCap: Math.round(entryPriceUsd * meta.totalSupply),
      tokensReceived,
      buyTx: txHash,
      openedAt: blockTimestamp,
      lastPriceUsd: currentPx > 0 ? currentPx : entryPriceUsd,
      updatedAt: now,
      status: 'open',
      buyGasEth: gasEth,
      buyTaxPct: tax.buyTaxPct,
      sellTaxPct: tax.sellTaxPct,
      protocolFeePctPerSwap,
    };
    this.positions.set(pos.id, pos);
    void this.persist();
    logger.info({ token, txHash, ethSpent, tokensReceived }, 'sniper: restored position from real tx');
    return pos;
  }

  updateSettings(patch: Partial<SniperSettings>): SniperSettings {
    if (typeof patch.enabled === 'boolean') this.settings.enabled = patch.enabled;
    if (typeof patch.minConviction === 'number') this.settings.minConviction = clamp(patch.minConviction, 0, 100);
    if (typeof patch.maxConviction === 'number') this.settings.maxConviction = clamp(patch.maxConviction, 0, 100);
    if (typeof patch.buyEth === 'number') this.settings.buyEth = Math.max(MIN_BUY_ETH, patch.buyEth);
    if (typeof patch.takeProfitPct === 'number') this.settings.takeProfitPct = Math.max(0, patch.takeProfitPct);
    if (typeof patch.trailingStopPct === 'number') this.settings.trailingStopPct = Math.max(0, patch.trailingStopPct);
    if (typeof patch.maxRoundtripPct === 'number') this.settings.maxRoundtripPct = Math.max(0, patch.maxRoundtripPct);
    if (typeof patch.lossCooldownMin === 'number') this.settings.lossCooldownMin = Math.max(0, patch.lossCooldownMin);
    if (typeof patch.requireSafe === 'boolean') this.settings.requireSafe = patch.requireSafe;
    if (typeof patch.kinds === 'string') {
      // normalise to upper, comma-joined; ignore empty so the buy list can't be wiped by accident
      const norm = patch.kinds.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean).join(',');
      if (norm) this.settings.kinds = norm;
    }
    logger.info({ settings: this.settings }, 'sniper: settings updated');
    return this.settings;
  }

  /** Full snapshot for the API/dashboard. Refreshes open-position prices from
   *  the oracle first so PnL is as live as the price feed on every poll (the
   *  oracle caches, so this only hits the network when a price is stale). */
  async snapshot() {
    const openTokens = [...new Set(
      [...this.positions.values()].filter((p) => p.status === 'open').map((p) => p.token),
    )];
    await Promise.all(openTokens.map((t) => this.price.refreshNow(t).catch(() => undefined)));
    const now = Date.now();
    for (const p of this.positions.values()) {
      if (p.status !== 'open') continue;
      const px = this.price.isLive(p.token) ? this.price.priceOf(p.token) : 0;
      if (px > 0) {
        p.lastPriceUsd = px;
        p.updatedAt = now;
      }
    }
    const positions = [...this.positions.values()]
      .map(view)
      .sort((a, b) => (b.status === 'open' ? 1 : 0) - (a.status === 'open' ? 1 : 0) || b.openedAt - a.openedAt);
    const open = positions.filter((p) => p.status === 'open');
    const closed = positions.filter((p) => p.status === 'closed');
    const unrealizedPnlEth = open.reduce((s, p) => s + p.pnlEth, 0);
    const realizedPnlEth = closed.reduce((s, p) => s + p.pnlEth, 0);
    const investedEth = open.reduce((s, p) => s + p.ethIn, 0);
    const openValueEth = open.reduce((s, p) => s + p.valueEth, 0);
    const totalGasEth = positions.reduce((s, p) => s + p.gasEth, 0);
    const walletEth = await this.executor.balanceEth();
    return {
      configured: this.executor.ready,
      wallet: { address: this.executor.address(), balanceEth: walletEth },
      // Full account picture: free ETH in the wallet + value of open positions.
      account: {
        walletEth: walletEth == null ? null : round6(walletEth),
        positionsEth: round6(openValueEth),
        totalEth: walletEth == null ? null : round6(walletEth + openValueEth),
      },
      settings: this.settings,
      minBuyEth: MIN_BUY_ETH,
      caps: { perTradeEth: config.SNIPER_MAX_ETH_PER_TRADE, dailyEth: config.SNIPER_DAILY_CAP_ETH, spentTodayEth: round6(this.spentLast24h(Date.now())) },
      pnl: {
        investedEth: round6(investedEth),
        openValueEth: round6(openValueEth),
        unrealizedPnlEth: round6(unrealizedPnlEth),
        realizedPnlEth: round6(realizedPnlEth),
        totalPnlEth: round6(unrealizedPnlEth + realizedPnlEth),
        totalGasEth: round6(totalGasEth),
        netPnlEth: round6(unrealizedPnlEth + realizedPnlEth - totalGasEth),
      },
      decisions: [...this.decisions].reverse(),
      removedLog: [...this.removedLog].reverse(),
      positions,
    };
  }

  // ── Persistence (survive redeploys via SNIPER_STORE_PATH) ─────────────────────
  async load(): Promise<void> {
    if (!config.SNIPER_STORE_PATH) return;
    try {
      const raw = await readFile(config.SNIPER_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed) ? (parsed as Position[]) : [];
      for (const p of arr) if (p && p.id) this.positions.set(p.id, p);
      logger.info({ loaded: this.positions.size }, 'sniper: restored positions');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') logger.warn({ err: String(err) }, 'sniper: could not load positions');
    }
  }
  private persisting = false;
  private async persist(): Promise<void> {
    if (this.persisting) return;
    await this.flush();
  }
  /** Write positions to disk now (used on each change and on graceful shutdown
   *  so the pre-redeploy state is captured). */
  async flush(): Promise<void> {
    if (!config.SNIPER_STORE_PATH) return;
    this.persisting = true;
    try {
      const path = config.SNIPER_STORE_PATH;
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.positions.values()]));
      await rename(tmp, path);
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper: could not save positions');
    } finally {
      this.persisting = false;
    }
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
