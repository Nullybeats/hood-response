import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseEther, formatEther } from 'ethers';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { PriceOracle } from '../chain/price.js';
import type { Swarm } from '../types.js';
import { SwapExecutor } from './executor.js';
import { SafetyChecker } from '../chain/safety.js';
import { type SniperMode, type SniperStateStore, type StoredSniperState } from './state.js';
import { notifyBotState } from '../notify/state.js';

/** Absolute floor on any single buy, regardless of the configured amount. */
export const MIN_BUY_ETH = 0.0005;
const SAMPLE_MS = 60_000;

/** Current durable settings-schema version. Bump this whenever a data-driven
 *  default change must be forced onto existing operators (whose durable settings
 *  otherwise shadow the new env defaults). The migration in load() runs once per
 *  bump. v2 (2026-08): kinds → ENTRY,SOLO · conviction ungated · roundtrip cap 5. */
const SETTINGS_SCHEMA_VERSION = 2;

export interface Position {
  id: string;
  token: string;
  tokenSymbol: string;
  kind: string;
  conviction: number;
  ethIn: number;
  entryPriceUsd: number;
  /** Market cap at entry, or null when it could not be established. Never a
   *  placeholder — position sizing and exits key off price, not cap. */
  entryMarketCap: number | null;
  tokensReceived: number;
  /** Exact base-unit buy fill, used to cap this position's sell independently of wallet balance. */
  tokensReceivedRaw?: string;
  buyTx: string;
  openedAt: number;
  lastPriceUsd: number;
  updatedAt: number;
  /** High-water mark price since entry (initialised to entry). Drives the trailing stop. */
  peakPriceUsd?: number;
  /** High-water mark of the executable sell value (ETH out for the whole position) since entry.
   *  Drives the rug guard: a sharp collapse vs this peak is liquidity leaving the pool. */
  peakExitValueEth?: number;
  status: 'open' | 'close_pending' | 'closed' | 'failed';
  closeAttemptedAt?: number;
  closeAttempts?: number;
  lastExecutionError?: string;
  exitReady?: boolean;
  closedAt?: number;
  sellTx?: string;
  exitPriceUsd?: number;
  closeReason?: 'take-profit' | 'manual' | 'trailing-stop' | 'reconciled' | 'rug-pull' | 'stop-loss';
  /** Per-position take-profit %, overriding the global setting when set.
   *  null explicitly disables take-profit for this position. */
  takeProfitPct?: number | null;
  /** Per-position hard stop-loss %, measured below entry. Auto-sells the whole position if the mark
   *  falls through entry·(1−pct/100). undefined = off (no fixed floor). Evaluated before the trail. */
  stopLossPct?: number | null;
  /** Per-position trailing-stop % override (pre-recoup). undefined = use the global trailingStopPct.
   *  After recoup the moonbag still trails on the global moonbagTrailPct, as before. */
  trailingStopPct?: number | null;
  /** "Sell initials": true once we've sold ~the stake back out, leaving a risk-free moonbag. */
  recoupDone?: boolean;
  /** ETH banked by the recoup partial sell (added to the moonbag's final proceeds for total PnL). */
  recoupedEth?: number;
  /** Fraction of the ORIGINAL lot sold at recoup — used to mark the remaining moonbag correctly. */
  recoupSoldFrac?: number;
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
  /** Platform close-fee skimmed off this sell's proceeds (ETH), sent to the fee
   *  wallet. Undefined when the owner is fee-exempt or the fee is disabled. */
  platformFeeEth?: number;
  /** Tx hash of the platform-fee transfer, when one was taken. */
  platformFeeTx?: string;

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
  /** Breakdown of where the entry latency went (ms), so we can see WHICH stage is the bottleneck
   *  instead of guessing: sse = Railway→box hop, enrich = blocking Dexscreener price refresh,
   *  safety = honeypot probe, preview = round-trip depth quote, submit = buy tx build+confirm. */
  gateTimingsMs?: { sse?: number; enrich?: number; safety?: number; preview?: number; submit?: number };
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
  /** PRIME-only: buy ONLY prime-flagged alerts (the backtested ENTRY@80+ tier). When on, the broad
   *  kinds/conviction gates are bypassed — a non-prime alert is skipped regardless of them. */
  primeOnly: boolean;
  /** Comma-separated alert kinds to snipe, e.g. "BUY,ENTRY" (non-SOLO). Case-insensitive. */
  kinds: string;
  /** Depth gate: skip a buy when the round-trip loss at our size exceeds this %. 0 = off. */
  maxRoundtripPct: number;
  /** After a token stops us out at a loss, don't re-buy it for this many minutes — stops the
   *  re-buy-the-whipsaw money pump (a token that just trailing-stopped us keeps re-signalling). 0 = off. */
  lossCooldownMin: number;
  /** Only evaluate a token's first-ever appearance in the global Signals feed. */
  newCoinsOnly: boolean;
  /** "Sell initials": once a position is up this %, sell ~the stake back out and ride the rest
   *  risk-free. 0 = off. */
  recoupAtPct: number;
  /** Trailing % applied to the risk-free moonbag AFTER recoup. 0 = no stop (ride free). */
  moonbagTrailPct: number;
  /** Rug guard: watch the live on-chain sell value each block; if it collapses more than this %
   *  below its since-entry peak, dump immediately (liquidity is leaving the pool). 0 = off. */
  rugGuard: boolean;
  rugDropPct: number;
}

export interface SniperRisk {
  maxPositions: number;
  maxNotionalPct: number;
  maxLossPct: number;
  dailyLossPct: number;
  gasReserveEth: number;
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
  // A recouped position's value = ETH already banked at recoup + the remaining moonbag. The moonbag
  // is the un-recouped fraction of the original stake, marked at the live ratio (open) or its actual
  // sell proceeds (closed). banked=0 / moonFrac=1 for a normal position → identical to before.
  const banked = p.recoupedEth ?? 0;
  const moonFrac = 1 - (p.recoupSoldFrac ?? 0);
  const valueEth =
    p.status === 'closed' && p.exitValueEth != null
      ? banked + p.exitValueEth
      : banked + p.ethIn * moonFrac * ratio;
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
    /** Share of the ORIGINAL lot still open (100 = untouched), after any recoup/partial sells. */
    remainingPct: Math.round((1 - (p.recoupSoldFrac ?? 0)) * 1000) / 10,
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
  private fastTimer: NodeJS.Timeout | null = null;
  private sampling = false;
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
    primeOnly: config.SNIPER_PRIME_ONLY,
    kinds: [...config.sniperKinds].join(','),
    maxRoundtripPct: config.SNIPER_MAX_ROUNDTRIP_PCT,
    lossCooldownMin: config.SNIPER_LOSS_COOLDOWN_MIN,
    newCoinsOnly: config.SNIPER_NEW_COINS_ONLY,
    recoupAtPct: config.SNIPER_RECOUP_AT_PCT,
    moonbagTrailPct: config.SNIPER_MOONBAG_TRAIL_PCT,
    rugGuard: config.SNIPER_RUG_GUARD,
    rugDropPct: config.SNIPER_RUG_DROP_PCT,
  };

  /** token → timestamp we last stopped out at a loss. Drives the re-buy cooldown. In-memory
   *  (resets on restart, which is fine — a fresh process starts with a clean slate). */
  private readonly recentLosses = new Map<string, number>();

  /** Tokens with a buy currently being evaluated/executed — a per-token lock that stops two
   *  simultaneous alerts for the same token from both passing holdsOpen and double-buying. */
  private readonly buying = new Set<string>();

  /** Owner of this engine (a cipherfi admin email, or 'default'). Purely for
   *  logging/telemetry — the engine itself is otherwise identity-agnostic. */
  readonly owner: string;
  /** Per-engine persistence paths. In the multi-tenant setup each admin's
   *  engine writes to its own file so positions never mix (see SniperRegistry).
   *  Empty string = persistence disabled, exactly as before. */
  private readonly storePath: string;
  private readonly journalPath: string;
  private readonly state?: SniperStateStore;
  private mode: SniperMode = config.SNIPER_MODE;
  private readonly risk: SniperRisk = {
    maxPositions: config.SNIPER_MAX_OPEN_POSITIONS,
    maxNotionalPct: config.SNIPER_MAX_NOTIONAL_PCT,
    maxLossPct: config.SNIPER_MAX_LOSS_PCT,
    dailyLossPct: config.SNIPER_DAILY_LOSS_PCT,
    gasReserveEth: config.SNIPER_GAS_RESERVE_ETH,
  };
  private day: { date: string; startingEquityEth: number; realizedLossEth: number } | undefined;
  /** Durable settings-schema version this engine's state was last migrated to.
   *  0 until load() runs; the migration bumps it to SETTINGS_SCHEMA_VERSION. */
  private settingsSchemaVersion = 0;
  /** UTC-day key on which we last sent the daily-loss health alert, so it fires
   *  at most once per day. */
  private dailyLossAlertedDay: string | undefined;

  /** True when this engine's owner is a primary operator (auto-unlock list): the
   *  one whose trades + health fire the sniper Telegram bot. Customers don't. */
  private get notifies(): boolean {
    return config.autoUnlockOwners.has(this.owner.trim().toLowerCase());
  }

  constructor(
    private readonly price: PriceOracle,
    executor?: SwapExecutor,
    safety?: SafetyChecker,
    opts?: { owner?: string; storePath?: string; journalPath?: string; state?: SniperStateStore },
  ) {
    this.executor = executor ?? new SwapExecutor();
    this.safety = safety ?? new SafetyChecker();
    this.owner = opts?.owner ?? 'default';
    this.storePath = opts?.storePath ?? config.SNIPER_STORE_PATH;
    this.journalPath = opts?.journalPath ?? config.SNIPER_JOURNAL_PATH;
    this.state = opts?.state;
    this.settings.enabled = this.mode !== 'off';
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
    // Adaptive fast-poll: a light 1s timer that runs a full sample ONLY when a position is "hot"
    // (a runner near its peak, or a position hovering just above its trail/stop). Between block ticks
    // this catches a fast dump in ~1s instead of up to 4s. The hotness check uses stored values (no
    // RPC); the actual sample() re-quotes on-chain as usual.
    if (config.SNIPER_FAST_POLL_MS > 0) {
      this.fastTimer = setInterval(() => {
        if (!this.sampling && this.anyHotPosition()) void this.sample();
      }, config.SNIPER_FAST_POLL_MS);
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.fastTimer) clearInterval(this.fastTimer);
    this.fastTimer = null;
  }

  /** Cheap (no-RPC) hotness check for the fast-poll gate: is any open position a runner (peak ≥ 1.5×)
   *  or hovering within 10% above its trail/stop line, using values stored by the last sample? */
  private anyHotPosition(): boolean {
    for (const p of this.positions.values()) {
      if (p.status !== 'open') continue;
      const entry = p.entryPriceUsd;
      const last = p.lastPriceUsd;
      const peak = p.peakPriceUsd ?? entry;
      if (!(entry > 0) || !(last > 0)) continue;
      if (peak / entry >= 1.5) return true; // a runner — protect the tail tightly
      // near the active trail line (from above): within 10% of peak·(1−trail)
      const trailPct = p.recoupDone ? this.settings.moonbagTrailPct : (p.trailingStopPct ?? this.settings.trailingStopPct);
      if (trailPct > 0) {
        const line = peak * (1 - trailPct / 100);
        if (line > 0 && last <= line * 1.1) return true;
      }
      // near a fixed stop-loss line (from above)
      const stopPct = p.stopLossPct ?? 0;
      if (stopPct > 0) {
        const line = entry * (1 - stopPct / 100);
        if (line > 0 && last <= line * 1.1) return true;
      }
    }
    return false;
  }

  /** New block hook; exits are evaluated immediately rather than waiting for a
   * minute-long display-price poll. Duplicate concurrent samples are collapsed. */
  onBlock(): void { void this.sample(); }

  get executionMode(): SniperMode { return this.mode; }

  setMode(mode: SniperMode): { mode: SniperMode } {
    if (mode === 'live') {
      if (config.SNIPER_GLOBAL_KILL) throw new Error('global kill switch is active');
      if (!this.executor.ready) throw new Error('unlock an enrolled wallet before enabling live mode');
    }
    this.mode = mode;
    this.settings.enabled = mode !== 'off';
    this.state?.audit(this.owner, 'mode-changed', { mode });
    if (this.notifies) {
      if (mode === 'off') notifyBotState('disabled', 'sniper turned OFF');
      else notifyBotState('enabled', 'sniper turned ON · live');
    }
    void this.persist();
    return { mode };
  }

  enrollPrivateKey(pk: string): string {
    if (!this.state?.keyEnabled) throw new Error('encrypted key storage is not configured');
    const address = this.executor.setPrivateKey(pk); // validates before storing
    this.state.enrollKey(this.owner, pk);
    this.executor.clearPrivateKey(); // enrolment never leaves a key unlocked
    return address;
  }

  unlockPrivateKey(): string {
    if (!this.state) throw new Error('durable encrypted state is unavailable');
    return this.executor.setPrivateKey(this.state.unlockKey(this.owner));
  }

  lockPrivateKey(): void { this.executor.clearPrivateKey(); this.state?.audit(this.owner, 'key-locked', {}); }
  erasePrivateKey(): void { this.executor.clearPrivateKey(); this.state?.deleteKey(this.owner); }
  get keyEnrolled(): boolean { return this.state?.hasKey(this.owner) ?? false; }

  private async prepareExit(p: Position): Promise<void> {
    try {
      await this.executor.prepareExit(p.token, p.tokensReceivedRaw);
      p.exitReady = true;
      p.updatedAt = Date.now();
      this.state?.audit(this.owner, 'exit-ready', { positionId: p.id });
      await this.persist();
    } catch (err) {
      p.exitReady = false;
      p.lastExecutionError = `exit approval: ${String(err).slice(0, 160)}`;
      this.state?.audit(this.owner, 'exit-not-ready', { positionId: p.id, error: p.lastExecutionError });
      await this.persist();
    }
  }

  /** Effective per-trade size: the operator's Buy size, clamped to the floor and the absolute
   *  per-trade ceiling. The % notional risk rail was removed — the operator's config governs size. */
  private sizeEth(_equityEth: number): number {
    return Math.min(config.SNIPER_MAX_ETH_PER_TRADE, Math.max(MIN_BUY_ETH, this.settings.buyEth));
  }

  private spentLast24h(now: number): number {
    const cut = now - 86_400_000;
    return this.buys.filter((b) => b.at >= cut).reduce((s, b) => s + b.eth, 0);
  }

  private holdsOpen(token: string): boolean {
    for (const p of this.positions.values()) if ((p.status === 'open' || p.status === 'close_pending') && p.token === token) return true;
    return false;
  }

  private openPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === 'open' || p.status === 'close_pending');
  }

  private async accountEquityEth(): Promise<number | null> {
    const wallet = await this.executor.balanceEth();
    if (wallet == null) return null;
    const open = this.openPositions().reduce((sum, p) => sum + p.ethIn * priceRatio(p, p.lastPriceUsd), 0);
    return wallet + open;
  }

  private dayKey(now = Date.now()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.PERF_RESET_TZ }).format(new Date(now));
  }

  private syncRiskDay(equityEth: number): void {
    const date = this.dayKey();
    if (!this.day || this.day.date !== date) this.day = { date, startingEquityEth: equityEth, realizedLossEth: 0 };
  }

  private dailyLossLocked(): boolean {
    return !!this.day && this.day.realizedLossEth >= this.day.startingEquityEth * (this.risk.dailyLossPct / 100);
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
    this.state?.audit(this.owner, `decision:${action}`, { token: swarm.token, symbol: swarm.tokenSymbol, kind: swarm.kind, conviction: swarm.conviction, reason });
    if (action === 'skipped') {
      logger.info({ token: swarm.tokenSymbol, kind: swarm.kind, conviction: swarm.conviction, reason }, 'sniper: skipped alert');
    }
  }

  /** Alert hook: decide whether to snipe, and buy if so. */
  async onAlert(swarm: Swarm): Promise<void> {
    if (config.SNIPER_GLOBAL_KILL) return this.decide(swarm, 'skipped', 'global kill switch is active');
    if (this.mode === 'off' || !this.settings.enabled) return this.decide(swarm, 'skipped', 'sniper is OFF');
    if (this.settings.newCoinsOnly && !swarm.firstSignal) {
      return this.decide(swarm, 'skipped', 'new coins only: token already appeared in Signals');
    }
    if (this.settings.primeOnly) {
      // PRIME-only: the single backtested-good tier (PRIME_KINDS × conviction ≥ PRIME_MIN_CONVICTION).
      // Collapses the buy set to just those — the broad kinds/conviction gates are intentionally bypassed.
      if (!swarm.prime) return this.decide(swarm, 'skipped', 'not a PRIME alert');
    } else {
      const allowedKinds = new Set(this.settings.kinds.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean));
      if (!allowedKinds.has(swarm.kind)) return this.decide(swarm, 'skipped', `kind ${swarm.kind} not in buy list`);
      if (swarm.conviction < this.settings.minConviction || swarm.conviction > this.settings.maxConviction)
        return this.decide(swarm, 'skipped', `conviction ${swarm.conviction} outside ${this.settings.minConviction}-${this.settings.maxConviction}`);
    }
    // Freshness gate (before any network call): the alert's edge decays fast — on real trades every
    // >50%-peak winner filled in <2s, while a 38s-late fill bought the top (PIPEDOG). Skip an alert
    // already older than staleMaxSec by the time we see it. Lenient default while we still carry the
    // blocking enrich latency; tighten toward ~5s once Wave 2 gets fills sub-2s.
    if (config.SNIPER_STALE_MAX_SEC > 0 && swarm.firstSeen) {
      const ageMs = Date.now() - swarm.firstSeen;
      if (ageMs > config.SNIPER_STALE_MAX_SEC * 1000) {
        return this.decide(swarm, 'skipped', `stale: alert ${Math.round(ageMs / 1000)}s old > ${config.SNIPER_STALE_MAX_SEC}s`);
      }
    }
    if (this.holdsOpen(swarm.token)) return this.decide(swarm, 'skipped', 'already holding this token');
    // portfolio position cap removed — concurrent positions are bounded only by wallet balance + gas reserve
    // Per-token in-flight lock: two alerts for the same token can both clear holdsOpen before either
    // records a position (the duplicate-WOOD race). Claim it for this evaluation; released in finally.
    if (this.buying.has(swarm.token)) return this.decide(swarm, 'skipped', 'buy already in flight');
    this.buying.add(swarm.token);
    try {

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
    const equity = await this.accountEquityEth();
    if (equity == null) return this.decide(swarm, 'skipped', 'wallet balance unavailable (fail closed)');
    this.syncRiskDay(equity); // still tracked for telemetry; the daily-loss kill-switch gate was removed
    const size = this.sizeEth(equity);
    if (size < MIN_BUY_ETH) return this.decide(swarm, 'skipped', 'risk cap below minimum buy');
    const walletBalance = await this.executor.balanceEth();
    if (walletBalance == null || walletBalance - size < this.risk.gasReserveEth) {
      return this.decide(swarm, 'skipped', 'wallet gas reserve would be breached');
    }
    if (this.spentLast24h(now) + size > config.SNIPER_DAILY_CAP_ETH) {
      return this.decide(swarm, 'skipped', 'daily spend cap reached');
    }

    // The alert's own market price, in ETH. Derived HERE rather than after the gate (where it used to
    // live) so the depth gate can hand it to the router as a sanity reference — a preview measured on
    // a pool priced nowhere near the real market is measuring the wrong pool, not a thin token.
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = ethUsd && ethUsd > 0 ? entryPrice / ethUsd : null;

    // Honeypot gate + depth gate run CONCURRENTLY (independent, both fail-closed): the honeypot sim and
    // the round-trip route quote don't depend on each other, so awaiting them together shaves a network
    // round-trip off the entry path. Timings recorded so we can see which stage dominates.
    const gateStart = Date.now();
    const [safe, roundTrip] = await Promise.all([
      this.settings.requireSafe
        ? this.safety.check(swarm.token, this.price.liquidityOf(swarm.token)).catch(() => null)
        : Promise.resolve('skip' as const),
      this.executor
        .previewRoundTrip(swarm.token, size, this.price.pairIdOf(swarm.token), expectedPriceEth)
        .catch(() => null),
    ]);
    const gateMs = Date.now() - gateStart; // combined safety+preview wall time (they ran in parallel)
    // Honeypot / sellability — never buy what we can't sell (the −100% trap).
    if (this.settings.requireSafe) {
      if (!safe || safe === 'skip') return this.decide(swarm, 'skipped', 'safety check unavailable (fail closed)');
      if (!safe.ok) return this.decide(swarm, 'skipped', `unsafe: ${(safe.hardFails ?? []).join(', ')}`);
    }
    // Depth gate: the true floor cost at our size (impact both ways + LP fees + hook tax) BEFORE any ETH
    // moves. Refuse pools we couldn't exit cleanly (the BURN −22.8% failure mode).
    if (!roundTrip) return this.decide(swarm, 'skipped', 'on-chain route quote unavailable (fail closed)');
    if (this.settings.maxRoundtripPct > 0 && roundTrip.lossPct > this.settings.maxRoundtripPct) {
      // Name the venue. A bare "round-trip −100%" reads as "toxic token" when it can equally mean
      // "measured the wrong pool" — which is exactly what it meant for IOU and HMN on 2026-08-01/02.
      return this.decide(
        swarm,
        'skipped',
        `too thin: round-trip −${roundTrip.lossPct.toFixed(0)}% on ${roundTrip.venue} > ${this.settings.maxRoundtripPct}% cap`,
      );
    }

    try {
      const submitStart = Date.now();
      const res = await this.executor.buy(swarm.token, size, this.price.pairIdOf(swarm.token), expectedPriceEth);
      const filledAt = Date.now();
      const submitMs = filledAt - submitStart;
      const gateTimingsMs = {
        sse: swarm.receivedAt && swarm.firstSeen ? Math.max(0, swarm.receivedAt - swarm.firstSeen) : undefined,
        enrich: swarm.enrichMs,
        // safety+preview ran in parallel — attribute the combined wall time to both for visibility.
        safety: this.settings.requireSafe ? gateMs : undefined,
        preview: gateMs,
        submit: submitMs,
      };
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
        tokensReceivedRaw: res.tokensReceivedRaw,
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
        gateTimingsMs,
      };
      logger.info({ token: swarm.tokenSymbol, buyLatencyMs: pos.buyLatencyMs, timings: gateTimingsMs }, 'sniper: entry latency breakdown');
      this.positions.set(pos.id, pos);
      this.state?.audit(this.owner, 'buy-confirmed', { positionId: pos.id, tx: res.txHash, eth: res.ethSpent });
      this.decide(swarm, 'bought', `bought ${size} Ξ · tx ${res.txHash.slice(0, 10)}`);
      if (this.notifies) {
        notifyBotState(
          'bought',
          `🎯 <b>${swarm.tokenSymbol}</b> (${swarm.kind}) · ${res.ethSpent.toFixed(4)} Ξ in · conv ${swarm.conviction}`,
          pos.id,
        );
      }
      logger.info(
        { token: swarm.tokenSymbol, eth: size, conviction: swarm.conviction, tx: res.txHash },
        'sniper: opened position',
      );
      void this.prepareExit(pos);
      void this.persist();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.decide(swarm, 'skipped', `buy failed: ${msg.slice(0, 80)}`);
      logger.error({ token: swarm.tokenSymbol, err: String(err) }, 'sniper: buy failed');
    }
    } finally {
      this.buying.delete(swarm.token); // release the per-token lock (runs on every early return too)
    }
  }

  /** Periodic: refresh open-position prices and fire take-profit sells. */
  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    const now = Date.now();
    const open = [...this.positions.values()].filter((p) => p.status === 'open' || (p.status === 'failed' && (p.closeAttempts ?? 0) < 3));
    await Promise.all(open.map(async (p) => {
      try {
        if (p.status === 'failed') p.status = 'open'; // bounded retry on a later block
        // Exit decisions use a current executable on-chain sell quote. The
        // DexScreener oracle is display-only and never authorises an exit.
        const quote = await this.executor.valueInEth(p.token, this.price.pairIdOf(p.token));
        const ethUsd = this.price.ethUsdPrice();
        let px = quote.tokens > 0 && ethUsd && ethUsd > 0 ? (quote.ethOut * ethUsd) / quote.tokens : 0;
        // Test fixtures intentionally omit ETH/USD. Production never falls
        // back to an off-chain display price for an exit decision.
        if (!(px > 0) && config.NODE_ENV === 'test') {
          await this.price.refreshNow(p.token);
          px = this.price.priceOf(p.token) ?? 0;
        }
        if (!(px > 0)) throw new Error('on-chain exit quote unavailable');
        p.lastPriceUsd = px;
        p.updatedAt = now;
        p.peakPriceUsd = Math.max(p.peakPriceUsd ?? p.entryPriceUsd, px);
        // Rug guard: the on-chain sell value (ETH out for the whole position) IS the pool depth. A sharp
        // collapse vs its since-entry peak is liquidity leaving — dump NOW, while a sellable pool remains,
        // instead of waiting for the price-based trailing stop to fire into a drained pool (the PIPEDOG
        // −100%/99.95%-slip trap). Peak seeds to the first sample, so the entry tick can't self-trigger.
        p.peakExitValueEth = Math.max(p.peakExitValueEth ?? quote.ethOut, quote.ethOut);
        if (
          this.settings.rugGuard &&
          this.settings.rugDropPct > 0 &&
          (p.peakExitValueEth ?? 0) > 0 &&
          quote.tokens > 0 &&
          quote.ethOut <= p.peakExitValueEth * (1 - this.settings.rugDropPct / 100)
        ) {
          await this.closeOut(p, 'rug-pull');
          return;
        }
        // Per-position hard stop-loss: a fixed floor below entry, evaluated BEFORE the trailing stop
        // so an explicit floor always wins. Off unless set on this position. Unlike the trail, this is
        // measured off ENTRY, not the peak — a true "cut it if it drops below X" line.
        const stopPct = p.stopLossPct != null ? p.stopLossPct : 0;
        if (stopPct > 0 && p.entryPriceUsd > 0 && px <= p.entryPriceUsd * (1 - stopPct / 100)) {
          await this.closeOut(p, 'stop-loss');
          return;
        }
        // Trailing stop. Once the stake is recouped, the remainder is house money → trail it on the
        // (typically wider, or 0 = no-stop) moonbagTrailPct instead of the tight pre-recoup trail.
        // A per-position trailingStopPct overrides the global pre-recoup trail for this position only.
        const baseTrail = p.trailingStopPct != null ? p.trailingStopPct : this.settings.trailingStopPct;
        const trail = p.recoupDone ? this.settings.moonbagTrailPct : baseTrail;
        if (trail > 0 && p.peakPriceUsd > 0 && px <= p.peakPriceUsd * (1 - trail / 100)) {
          await this.closeOut(p, 'trailing-stop');
          return;
        }
        // "Sell initials": first time we clear recoupAtPct, sell ~the stake back out, then ride the
        // rest risk-free. Fires once; skipped entirely when recoupAtPct is 0 (off).
        const recoupPct = this.settings.recoupAtPct;
        if (recoupPct > 0 && !p.recoupDone && p.entryPriceUsd > 0 && (px / p.entryPriceUsd - 1) * 100 >= recoupPct) {
          await this.recoupInitials(p, quote.ethOut);
          return;
        }
        const tp = p.takeProfitPct !== undefined ? (p.takeProfitPct ?? 0) : this.settings.takeProfitPct;
        if (tp > 0 && p.entryPriceUsd > 0 && (px / p.entryPriceUsd - 1) * 100 >= tp) await this.takeProfit(p);
      } catch (err) {
        p.lastExecutionError = `exit quote: ${String(err).slice(0, 160)}`;
        this.state?.audit(this.owner, 'exit-quote-failed', { positionId: p.id, error: p.lastExecutionError });
      }
    }));
    void this.persist();
    this.sampling = false;
  }

  private async closePosition(p: Position, reason: 'take-profit' | 'manual' | 'trailing-stop' | 'rug-pull' | 'stop-loss'): Promise<void> {
    if (p.status !== 'open') throw new Error('position is already closing or closed');
    p.status = 'close_pending';
    p.closeAttemptedAt = Date.now();
    p.closeAttempts = (p.closeAttempts ?? 0) + 1;
    p.lastExecutionError = undefined;
    await this.persist();
    this.state?.audit(this.owner, 'close-pending', { positionId: p.id, reason, attempt: p.closeAttempts });
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = p.lastPriceUsd > 0 && ethUsd && ethUsd > 0 ? p.lastPriceUsd / ethUsd : null;
    let res;
    try {
      res = await this.executor.sell(
        p.token,
        this.price.pairIdOf(p.token),
        expectedPriceEth,
        p.tokensReceived,
        p.tokensReceivedRaw,
      );
    } catch (err) {
      // A shared-wallet sell in an older process may already have consumed this lot. Do not leave
      // the record OPEN and retry a doomed trailing-stop forever; it is no longer a live holding.
      if (!String(err).includes('no token balance to sell')) throw err;
      p.status = 'closed';
      p.closedAt = Date.now();
      p.closeReason = 'reconciled';
      p.exitPriceUsd = p.lastPriceUsd;
      p.updatedAt = p.closedAt;
      logger.warn({ token: p.tokenSymbol, reason, positionId: p.id }, 'sniper: reconciled orphaned zero-balance position');
      this.state?.audit(this.owner, 'position-reconciled', { positionId: p.id, reason });
      void this.persist();
      return;
    }
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
    // Total ETH out = this final sell + anything banked earlier at recoup. A position is only a
    // realized loss when the COMBINED proceeds fall short of the stake.
    const totalOutEth = (p.exitValueEth ?? 0) + (p.recoupedEth ?? 0);
    if (p.exitValueEth != null && totalOutEth < p.ethIn) {
      this.recentLosses.set(p.token, Date.now());
      const equity = await this.accountEquityEth();
      if (equity != null) this.syncRiskDay(equity + p.exitValueEth);
      if (this.day) this.day.realizedLossEth += p.ethIn - totalOutEth + (p.buyGasEth ?? 0) + (p.sellGasEth ?? 0);
      // Informational daily-loss alert once per UTC day when realized loss crosses
      // the configured threshold. This does NOT halt trading (a hard halt would
      // fight the always-on mandate on a small bankroll) — it just tells you.
      if (this.notifies && this.dailyLossLocked() && this.dailyLossAlertedDay !== this.day?.date) {
        this.dailyLossAlertedDay = this.day?.date;
        notifyBotState('daily-loss', `daily loss threshold (${this.risk.dailyLossPct}%) reached — still ON, watch the tape`);
      }
    }
    // Sold alert: the honest net after gas + any recouped ETH, with the reason.
    if (this.notifies) {
      const netEth = totalOutEth - p.ethIn - (p.buyGasEth ?? 0) - (p.sellGasEth ?? 0);
      const netPct = p.ethIn > 0 ? (netEth / p.ethIn) * 100 : 0;
      const sign = netPct >= 0 ? '+' : '';
      const face = netPct >= 0 ? '🟢' : '🔴';
      notifyBotState(
        'sold',
        `${face} <b>${p.tokenSymbol}</b> ${reason} · ${sign}${netPct.toFixed(1)}% (${sign}${netEth.toFixed(4)} Ξ net)`,
        p.id,
      );
    }
    logger.info(
      { token: p.tokenSymbol, tx: res.txHash, ethOut: res.ethReceived, quoted: res.quotedEthOut, exitSlipPct: p.exitSlippagePct, reason },
      'sniper: position sold',
    );
    this.state?.audit(this.owner, 'sell-confirmed', { positionId: p.id, tx: res.txHash, reason, ethOut: res.ethReceived });
    // Skim the platform close-fee AFTER the exit is fully settled, so a fee issue can never
    // block or reverse the user's sell. Records p.platformFee* before journalling below.
    await this.collectPlatformFee(p, res);
    void this.journal(p);
    void this.persist();
  }

  /** True when this engine's owner is never charged the platform fee: the two
   *  configured admin operators (SNIPER_FEE_EXEMPT_OWNERS) and the 'default'
   *  dev/direct engine. Everyone else (customers) pays. */
  private isFeeExempt(): boolean {
    if (this.owner === 'default') return true;
    return config.feeExemptOwners.has(this.owner.trim().toLowerCase());
  }

  /** Skim the platform close-fee from a completed sell's proceeds and send it to
   *  the fee wallet (SNIPER_FEE_BPS of the native ETH received). Best-effort: any
   *  failure is logged/audited and NEVER throws into the sell path — the user's
   *  exit must always complete. Disabled unless both a fee wallet and a positive
   *  bps are configured; exempt owners are never charged. */
  private async collectPlatformFee(p: Position, res: { ethReceived: number }): Promise<void> {
    try {
      const bps = Math.min(Math.max(Math.round(config.SNIPER_FEE_BPS), 0), 300); // hard cap 3%
      if (bps <= 0 || !config.SNIPER_FEE_WALLET) return; // fee disabled
      if (this.isFeeExempt()) return; // admins/default trade free
      if (!(res.ethReceived > 0)) return;
      const proceedsWei = parseEther(res.ethReceived.toFixed(18));
      const feeWei = (proceedsWei * BigInt(bps)) / 10_000n;
      if (feeWei <= 0n) return;
      const reserveWei = parseEther(String(this.risk.gasReserveEth ?? 0));
      const sent = await this.executor.transferEth(config.SNIPER_FEE_WALLET, feeWei, reserveWei);
      if (!sent) {
        logger.warn({ owner: this.owner, token: p.tokenSymbol }, 'sniper: platform fee skipped (insufficient spendable balance)');
        return;
      }
      p.platformFeeEth = Number(formatEther(feeWei));
      p.platformFeeTx = sent.txHash;
      logger.info(
        { owner: this.owner, token: p.tokenSymbol, feeEth: p.platformFeeEth, bps, tx: sent.txHash },
        'sniper: platform fee collected',
      );
      this.state?.audit(this.owner, 'platform-fee', { positionId: p.id, feeEth: p.platformFeeEth, bps, tx: sent.txHash });
    } catch (err) {
      logger.warn({ owner: this.owner, err: String(err) }, 'sniper: platform fee transfer failed (non-fatal)');
      this.state?.audit(this.owner, 'platform-fee-failed', { positionId: p.id, error: String(err).slice(0, 160) });
    }
  }

  /** Append a closed trade's full telemetry to the JSONL journal for offline
   *  analysis (slippage in/out, gas, venue, latency, round-trip). Best-effort:
   *  a journal write must never affect the trade or throw into the sell path. */
  private async journal(p: Position): Promise<void> {
    if (!this.journalPath) return;
    try {
      const grossPnlEth = (p.exitValueEth ?? 0) + (p.recoupedEth ?? 0) - p.ethIn;
      const netPnlEth = grossPnlEth - (p.buyGasEth ?? 0) - (p.sellGasEth ?? 0) - (p.platformFeeEth ?? 0);
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
        platformFeeEth: p.platformFeeEth ?? null,
        platformFeeTx: p.platformFeeTx ?? null,
        poolLiquidityEntry: p.poolLiquidityEntry ?? null,
        buyLatencyMs: p.buyLatencyMs ?? null,
        gateTimingsMs: p.gateTimingsMs ?? null,
        holdMs: p.closedAt && p.openedAt ? p.closedAt - p.openedAt : null,
        grossPnlEth,
        netPnlEth,
        netPnlPct: p.ethIn > 0 ? (netPnlEth / p.ethIn) * 100 : null,
      };
      await mkdir(dirname(this.journalPath), { recursive: true }).catch(() => undefined);
      await writeFile(this.journalPath, JSON.stringify(row) + '\n', { flag: 'a' });
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper: journal append failed');
    }
  }

  /** "Sell initials": partial-sell just enough to return the initial stake (ethIn), leaving a
   *  risk-free moonbag that keeps riding. Banks the proceeds in recoupedEth and shrinks the tracked
   *  lot to the remainder so a later full close sells only the moonbag. Fires once per position.
   *  currentValueEth is the whole position's live value (from the exit quote). */
  private async recoupInitials(p: Position, currentValueEth: number): Promise<void> {
    if (p.recoupDone || p.status !== 'open') return;
    if (!(currentValueEth > 0) || !p.tokensReceivedRaw) return; // need a live value + a raw lot to split
    // Fraction of the CURRENT lot to sell so proceeds ≈ ethIn. Cap at 90% so a moonbag always remains.
    const frac = Math.min(0.9, p.ethIn / currentValueEth);
    if (!(frac > 0)) return;
    const scale = 1_000_000n;
    const fracBig = BigInt(Math.round(frac * 1e6));
    let heldRaw: bigint;
    try { heldRaw = BigInt(p.tokensReceivedRaw); } catch { return; }
    const sellRaw = (heldRaw * fracBig) / scale;
    if (sellRaw <= 0n) return;
    const sellTokens = p.tokensReceived * frac;
    p.status = 'close_pending';
    p.closeAttemptedAt = Date.now();
    await this.persist();
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = p.lastPriceUsd > 0 && ethUsd && ethUsd > 0 ? p.lastPriceUsd / ethUsd : null;
    let res;
    try {
      res = await this.executor.sell(p.token, this.price.pairIdOf(p.token), expectedPriceEth, sellTokens, sellRaw.toString());
    } catch (err) {
      p.status = 'open'; // recoup sell failed — stay open, retry next sample
      p.lastExecutionError = `recoup: ${String(err).slice(0, 160)}`;
      this.state?.audit(this.owner, 'recoup-failed', { positionId: p.id, error: p.lastExecutionError });
      await this.persist();
      return;
    }
    // Bank the proceeds and shrink the tracked lot to the moonbag remainder.
    p.recoupedEth = (p.recoupedEth ?? 0) + res.ethReceived;
    p.recoupSoldFrac = Math.min(1, (p.recoupSoldFrac ?? 0) + frac);
    p.tokensReceived = Math.max(0, p.tokensReceived - sellTokens);
    p.tokensReceivedRaw = (heldRaw - sellRaw).toString();
    p.recoupDone = true;
    p.status = 'open';
    p.sellGasEth = (p.sellGasEth ?? 0) + res.gasEth;
    p.updatedAt = Date.now();
    if (res.venue) p.venue = res.venue;
    logger.info({ token: p.tokenSymbol, tx: res.txHash, bankedEth: res.ethReceived, frac }, 'sniper: recouped initial stake');
    this.state?.audit(this.owner, 'recoup', { positionId: p.id, tx: res.txHash, bankedEth: res.ethReceived, frac });
    void this.persist();
  }

  private async takeProfit(p: Position): Promise<void> {
    await this.closeOut(p, 'take-profit');
  }

  /** Close a position for a rules-driven reason (take-profit / trailing-stop), logging on failure.
   *  A failed sell leaves the position OPEN so the next sample retries — the honeypot escape hatch. */
  private async closeOut(p: Position, reason: 'take-profit' | 'trailing-stop' | 'rug-pull' | 'stop-loss'): Promise<void> {
    if (p.status !== 'open') return;
    try {
      await this.closePosition(p, reason);
    } catch (err) {
      p.status = 'failed';
      p.lastExecutionError = String(err).slice(0, 240);
      p.updatedAt = Date.now();
      this.state?.audit(this.owner, 'close-failed', { positionId: p.id, reason, error: p.lastExecutionError });
      void this.persist();
      logger.error({ token: p.tokenSymbol, reason, err: String(err) }, `sniper: ${reason} sell failed`);
    }
  }

  /** Manual "sell now" for an open position (before take-profit is hit). */
  async sellNow(id: string): Promise<Position> {
    const p = this.positions.get(id);
    if (!p || (p.status !== 'open' && p.status !== 'failed')) throw new Error('position not open');
    if (p.status === 'failed') p.status = 'open';
    try { await this.closePosition(p, 'manual'); }
    catch (err) {
      p.status = 'failed';
      p.lastExecutionError = String(err).slice(0, 240);
      await this.persist();
      throw err;
    }
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

  /** Manual "sell initials" — recoup the original stake NOW (before recoupAtPct is auto-hit), flipping
   *  the position to a risk-free moonbag. Reuses the automatic recoup sizing verbatim. Throws if the
   *  position is already recouped or has no live sell value. */
  async recoupNow(id: string): Promise<Position> {
    const p = this.positions.get(id);
    if (!p || p.status !== 'open') throw new Error('position not open');
    if (p.recoupDone) throw new Error('initials already recouped');
    const quote = await this.executor.valueInEth(p.token, this.price.pairIdOf(p.token));
    if (!(quote.ethOut > 0)) throw new Error('no live sell value to recoup against');
    await this.recoupInitials(p, quote.ethOut);
    if (!p.recoupDone) throw new Error(p.lastExecutionError ?? 'recoup sell failed');
    return p;
  }

  /** Manual partial sell — sell `frac` (0<frac<1) of the CURRENT remaining lot at market, banking the
   *  proceeds and shrinking the tracked lot exactly like recoupInitials does (so view()/PnL stay
   *  correct). Leaves the position OPEN. Does NOT flip recoupDone — it's a plain "take some off". */
  async sellFraction(id: string, frac: number): Promise<Position> {
    const p = this.positions.get(id);
    if (!p || (p.status !== 'open' && p.status !== 'failed')) throw new Error('position not open');
    if (p.status === 'failed') p.status = 'open';
    if (!(frac > 0 && frac < 1)) throw new Error('fraction must be between 0 and 1 (exclusive)');
    if (!p.tokensReceivedRaw) throw new Error('position has no divisible lot to partial-sell');
    const scale = 1_000_000n;
    const fracBig = BigInt(Math.round(frac * 1e6));
    let heldRaw: bigint;
    try { heldRaw = BigInt(p.tokensReceivedRaw); } catch { throw new Error('bad lot'); }
    const sellRaw = (heldRaw * fracBig) / scale;
    if (sellRaw <= 0n) throw new Error('sell amount rounds to zero');
    const sellTokens = p.tokensReceived * frac;
    p.status = 'close_pending';
    p.closeAttemptedAt = Date.now();
    p.lastExecutionError = undefined;
    await this.persist();
    const ethUsd = this.price.ethUsdPrice();
    const expectedPriceEth = p.lastPriceUsd > 0 && ethUsd && ethUsd > 0 ? p.lastPriceUsd / ethUsd : null;
    let res;
    try {
      res = await this.executor.sell(p.token, this.price.pairIdOf(p.token), expectedPriceEth, sellTokens, sellRaw.toString());
    } catch (err) {
      p.status = 'open'; // partial sell failed — stay open with the full lot intact, retryable
      p.lastExecutionError = `partial: ${String(err).slice(0, 160)}`;
      await this.persist();
      throw err;
    }
    // Bank proceeds + shrink the lot, mirroring recoupInitials so view()/netPnl accounting stay correct.
    // recoupSoldFrac tracks the fraction of the ORIGINAL lot sold; `frac` is of the CURRENT lot, so
    // convert through the remaining-before fraction to stay accurate across multiple partials.
    const remainingBefore = 1 - (p.recoupSoldFrac ?? 0);
    p.recoupedEth = (p.recoupedEth ?? 0) + res.ethReceived;
    p.recoupSoldFrac = Math.min(1, (p.recoupSoldFrac ?? 0) + remainingBefore * frac);
    p.tokensReceived = Math.max(0, p.tokensReceived - sellTokens);
    p.tokensReceivedRaw = (heldRaw - sellRaw).toString();
    p.sellGasEth = (p.sellGasEth ?? 0) + res.gasEth;
    p.status = 'open';
    p.updatedAt = Date.now();
    if (res.venue) p.venue = res.venue;
    logger.info({ token: p.tokenSymbol, tx: res.txHash, ethOut: res.ethReceived, frac }, 'sniper: manual partial sell');
    this.state?.audit(this.owner, 'partial-sell', { positionId: p.id, tx: res.txHash, ethOut: res.ethReceived, frac });
    void this.persist();
    return p;
  }

  /** Set/clear per-position exit overrides (a fixed stop-loss and/or a trailing-stop override). A
   *  positive number sets the override for this position only; null or 0 clears it, reverting to the
   *  global behavior. Only the keys present in `cfg` are touched. */
  setPositionExit(id: string, cfg: { stopLossPct?: number | null; trailingStopPct?: number | null }): Position {
    const p = this.positions.get(id);
    if (!p || p.status !== 'open') throw new Error('position not open');
    if ('stopLossPct' in cfg) {
      const v = cfg.stopLossPct;
      if (v == null || v <= 0) delete p.stopLossPct; else p.stopLossPct = Math.max(0, v);
    }
    if ('trailingStopPct' in cfg) {
      const v = cfg.trailingStopPct;
      if (v == null || v <= 0) delete p.trailingStopPct; else p.trailingStopPct = Math.max(0, v);
    }
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
    if (this.mode !== 'live') throw new Error('test buy is disabled outside explicitly enabled live mode');
    if (config.SNIPER_GLOBAL_KILL) throw new Error('global kill switch is active');
    if (!this.executor.ready) throw new Error('wallet not configured');
    const size = Math.min(config.SNIPER_MAX_ETH_PER_TRADE, Math.max(MIN_BUY_ETH, ethAmount));
    const now = Date.now();
    const px = this.price.priceOf(token) ?? 0;
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
      entryMarketCap: null, // manual test buy — no alert, no cap established
      tokensReceived: res.tokensReceived,
      tokensReceivedRaw: res.tokensReceivedRaw,
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
    const px = this.price.priceOf(token) ?? 0;
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
    const [{ ethSpent, tokensReceived, tokensReceivedRaw, blockTimestamp, gasEth }, meta, tax, protocolFeePctPerSwap] =
      await Promise.all([
        this.executor.readBuyTx(token, txHash),
        this.executor.tokenMeta(token),
        this.lookupTax(token),
        this.lookupProtocolFee(token),
      ]);
    await this.price.refreshNow(token).catch(() => undefined);
    const currentPx = this.price.priceOf(token) ?? 0;
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
      tokensReceivedRaw,
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

  /** Force data-driven default changes onto an existing operator whose durable
   *  settings would otherwise shadow the new env defaults. Runs once per schema
   *  bump (guarded by settingsSchemaVersion). Only the fields a version changes
   *  are overwritten; everything else the operator set is preserved. */
  private migrateSettings(): void {
    if (this.settingsSchemaVersion >= SETTINGS_SCHEMA_VERSION) return;
    // v2: the losing defaults (BUY-kind, conviction gating, loose 10% roundtrip)
    // are replaced by the backtested set. primeOnly off so ENTRY+SOLO both pass.
    if (this.settingsSchemaVersion < 2) {
      this.settings.kinds = 'ENTRY,SOLO';
      this.settings.primeOnly = false;
      this.settings.minConviction = 0;
      this.settings.maxConviction = 100;
      this.settings.maxRoundtripPct = 5;
      logger.info(
        { owner: this.owner },
        'sniper: applied settings migration v2 (ENTRY,SOLO · conviction ungated · roundtrip cap 5)',
      );
    }
    this.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
    void this.persist();
  }

  updateSettings(patch: Partial<SniperSettings>): SniperSettings {
    // Legacy callers cannot arm execution through the settings endpoint.
    if (typeof patch.enabled === 'boolean') {
      // Existing unit fixtures exercise real executor calls. Production callers
      // Production settings cannot arm execution; live still requires the mode endpoint.
      if (config.NODE_ENV === 'test' && patch.enabled) {
        this.mode = 'live';
        this.settings.enabled = true;
      } else if (!patch.enabled) this.setMode('off');
    }
    if (typeof patch.minConviction === 'number') this.settings.minConviction = clamp(patch.minConviction, 0, 100);
    if (typeof patch.maxConviction === 'number') this.settings.maxConviction = clamp(patch.maxConviction, 0, 100);
    if (typeof patch.buyEth === 'number') this.settings.buyEth = Math.max(MIN_BUY_ETH, patch.buyEth);
    if (typeof patch.takeProfitPct === 'number') this.settings.takeProfitPct = Math.max(0, patch.takeProfitPct);
    if (typeof patch.trailingStopPct === 'number') this.settings.trailingStopPct = Math.max(0, patch.trailingStopPct);
    if (typeof patch.maxRoundtripPct === 'number') this.settings.maxRoundtripPct = Math.max(0, patch.maxRoundtripPct);
    if (typeof patch.lossCooldownMin === 'number') this.settings.lossCooldownMin = Math.max(0, patch.lossCooldownMin);
    if (typeof patch.requireSafe === 'boolean') this.settings.requireSafe = patch.requireSafe;
    if (typeof patch.primeOnly === 'boolean') this.settings.primeOnly = patch.primeOnly;
    if (typeof patch.newCoinsOnly === 'boolean') this.settings.newCoinsOnly = patch.newCoinsOnly;
    if (typeof patch.recoupAtPct === 'number') this.settings.recoupAtPct = Math.max(0, patch.recoupAtPct);
    if (typeof patch.moonbagTrailPct === 'number') this.settings.moonbagTrailPct = clamp(patch.moonbagTrailPct, 0, 100);
    if (typeof patch.rugGuard === 'boolean') this.settings.rugGuard = patch.rugGuard;
    if (typeof patch.rugDropPct === 'number') this.settings.rugDropPct = clamp(patch.rugDropPct, 0, 100);
    if (typeof patch.kinds === 'string') {
      // normalise to upper, comma-joined; ignore empty so the buy list can't be wiped by accident
      const norm = patch.kinds.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean).join(',');
      if (norm) this.settings.kinds = norm;
    }
    logger.info({ settings: this.settings }, 'sniper: settings updated');
    void this.persist();
    return this.settings;
  }

  /** Full snapshot for the API/dashboard. Refreshes open-position prices from
   *  the oracle first so PnL is as live as the price feed on every poll (the
   *  oracle caches, so this only hits the network when a price is stale). */
  async snapshot() {
    const openTokens = [...new Set(
      [...this.positions.values()].filter((p) => p.status === 'open' || p.status === 'close_pending').map((p) => p.token),
    )];
    await Promise.all(openTokens.map((t) => this.price.refreshNow(t).catch(() => undefined)));
    const now = Date.now();
    for (const p of this.positions.values()) {
      if (p.status !== 'open' && p.status !== 'close_pending') continue;
      const px = this.price.priceOf(p.token) ?? 0;
      if (px > 0) {
        p.lastPriceUsd = px;
        p.updatedAt = now;
      }
    }
    const positions = [...this.positions.values()]
      .map(view)
      .sort((a, b) => (b.status === 'open' ? 1 : 0) - (a.status === 'open' ? 1 : 0) || b.openedAt - a.openedAt);
    const open = positions.filter((p) => p.status === 'open' || p.status === 'close_pending');
    const closed = positions.filter((p) => p.status === 'closed');
    const unrealizedPnlEth = open.reduce((s, p) => s + p.pnlEth, 0);
    const realizedPnlEth = closed.reduce((s, p) => s + p.pnlEth, 0);
    const investedEth = open.reduce((s, p) => s + p.ethIn, 0);
    const openValueEth = open.reduce((s, p) => s + p.valueEth, 0);
    const totalGasEth = positions.reduce((s, p) => s + p.gasEth, 0);
    const walletEth = await this.executor.balanceEth();
    return {
      configured: this.executor.ready,
      mode: this.mode,
      key: { enrolled: this.keyEnrolled, unlocked: this.executor.ready },
      risk: { ...this.risk, day: this.day ?? null, dailyKillActive: this.dailyLossLocked() },
      wallet: { address: this.executor.address(), balanceEth: walletEth },
      // Full account picture: free ETH in the wallet + value of open positions.
      account: {
        walletEth: walletEth == null ? null : round6(walletEth),
        positionsEth: round6(openValueEth),
        totalEth: walletEth == null ? null : round6(walletEth + openValueEth),
      },
      settings: this.settings,
      minBuyEth: MIN_BUY_ETH,
      caps: { perTradeEth: config.SNIPER_MAX_ETH_PER_TRADE, dailyEth: config.SNIPER_DAILY_CAP_ETH, spentTodayEth: round6(this.spentLast24h(Date.now())), maxOpenPositions: this.risk.maxPositions },
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
    const durable = this.state?.load(this.owner);
    if (durable) {
      for (const p of durable.positions as Position[]) if (p && p.id) this.positions.set(p.id, p);
      if (durable.settings && typeof durable.settings === 'object') {
        // Merge ONLY keys the current settings shape knows about, so fields removed from the code
        // (e.g. the retired tpLadder) don't linger in the durable blob and re-surface in the snapshot.
        const d = durable.settings as Record<string, unknown>;
        const cur = this.settings as unknown as Record<string, unknown>;
        for (const k of Object.keys(cur)) {
          if (k in d) cur[k] = d[k];
        }
      }
      // Restore the owner's on/off choice so it's sticky across restarts. Trading still can't run
      // until the wallet is explicitly unlocked (keys are encrypted at rest, unlocked per session).
      if (durable.mode === 'off' || durable.mode === 'live') this.mode = durable.mode;
      this.settings.enabled = this.mode !== 'off';
      for (const b of durable.buys ?? []) if (b && Number.isFinite(b.at) && Number.isFinite(b.eth)) this.buys.push(b);
      for (const pair of durable.recentLosses ?? []) if (Array.isArray(pair) && typeof pair[0] === 'string' && Number.isFinite(pair[1])) this.recentLosses.set(pair[0], pair[1]);
      if (durable.day && typeof durable.day.date === 'string' && Number.isFinite(durable.day.startingEquityEth) && Number.isFinite(durable.day.realizedLossEth)) this.day = durable.day;
      for (const d of durable.decisions ?? []) this.decisions.push(d as typeof this.decisions[number]);
      for (const p of durable.removedLog ?? []) this.removedLog.push(p as typeof this.removedLog[number]);
      this.settingsSchemaVersion = durable.settingsSchemaVersion ?? 1; // pre-migration state is v1
      this.migrateSettings();
      const removed = this.dedupePhantoms();
      logger.info({ owner: this.owner, loaded: this.positions.size, removedPhantoms: removed, mode: this.mode, settingsVersion: this.settingsSchemaVersion }, 'sniper: restored durable state');
      return;
    }
    // No durable SQLite record for this owner yet. Any settings come straight from
    // the (already-current) env defaults, so mark as migrated — the migration must
    // not re-stamp a fresh install.
    this.settingsSchemaVersion = SETTINGS_SCHEMA_VERSION;
    if (!this.storePath) return;
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed) ? (parsed as Position[]) : [];
      for (const p of arr) if (p && p.id) this.positions.set(p.id, p);
      const removed = this.dedupePhantoms();
      logger.info({ loaded: this.positions.size, removedPhantoms: removed }, 'sniper: restored positions');
      if (removed > 0) void this.persist(); // write the cleaned set back so it stays clean
      // One-time migration: the next flush writes the legacy position-only
      // records into SQLite along with settings/risk ledgers.
      if (this.state) await this.flush();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') logger.warn({ err: String(err) }, 'sniper: could not load positions');
    }
  }

  /** Collapse duplicate-buy phantom records: the pre-lock concurrent-buy race could record the SAME
   *  on-chain buy (identical real buyTx) as several positions, all pointing at ONE lot of tokens.
   *  Selling one then dumps the whole wallet balance and the rest become unsellable (bal 0). Keep one
   *  record per real buyTx — preferring a closed one (it carries the true exit) — and drop the rest.
   *  'imported'/'TEST' buys have no unique tx and are never deduped. Returns how many were removed. */
  private dedupePhantoms(): number {
    const byTx = new Map<string, Position[]>();
    for (const p of this.positions.values()) {
      const tx = (p.buyTx || '').toLowerCase();
      if (!tx || tx === 'imported') continue;
      const g = byTx.get(tx);
      if (g) g.push(p); else byTx.set(tx, [p]);
    }
    let removed = 0;
    for (const group of byTx.values()) {
      if (group.length < 2) continue;
      const keep = group.find((p) => p.status === 'closed') ?? group[0]!;
      for (const p of group) {
        if (p.id === keep.id) continue;
        this.removedLog.push({ at: Date.now(), ...p });
        this.positions.delete(p.id);
        removed++;
      }
    }
    if (this.removedLog.length > 20) this.removedLog.splice(0, this.removedLog.length - 20);
    if (removed > 0) logger.warn({ removed }, 'sniper: removed duplicate-buy phantom positions');
    return removed;
  }
  private persisting = false;
  private async persist(): Promise<void> {
    if (this.persisting) return;
    await this.flush();
  }
  /** Write positions to disk now (used on each change and on graceful shutdown
   *  so the pre-redeploy state is captured). */
  async flush(): Promise<void> {
    const durable: StoredSniperState = {
      version: 1,
      mode: this.mode, // sticky per owner: their on/off choice survives restarts
      settingsSchemaVersion: this.settingsSchemaVersion,
      positions: [...this.positions.values()],
      settings: this.settings,
      buys: this.buys,
      recentLosses: [...this.recentLosses.entries()],
      decisions: this.decisions,
      removedLog: this.removedLog,
      day: this.day,
    };
    if (this.state?.enabled) {
      try { this.state.save(this.owner, durable); }
      catch (err) { logger.error({ err: String(err), owner: this.owner }, 'sniper: durable state write failed'); }
    }
    if (!this.storePath) return;
    this.persisting = true;
    try {
      const path = this.storePath;
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
