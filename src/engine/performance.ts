import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { PriceOracle } from '../chain/price.js';
import type { Swarm, SwarmKind } from '../types.js';

/**
 * A single alert being followed after it fired, so we can measure whether it
 * actually turned into a runner. Entry price is captured at alert time; the
 * tracker re-samples the live price on a timer and records the peak and the
 * milestone returns. No wallet addresses are retained — safe to expose.
 */
export interface TrackedCall {
  id: string;
  token: string;
  tokenSymbol: string;
  kind: SwarmKind;
  conviction: number;
  walletCount: number;
  walletSummary: string;
  /** Labels of the tracked wallets behind this call (e.g. ["tendies", "hmm"]).
   *  Display only — labels mutate and collide, so never key a record on them. */
  walletLabels: string[];
  /** Stable opaque wallet ids, index-aligned with `walletLabels` — the key the per-wallet
   *  track record is grouped by. Absent on calls persisted before walletIds existed. */
  walletIds: string[];
  /** Distinct-wallet repeat signal at alert time (from the repeat counter). */
  repeatCount: number;
  repeatWallets: number;
  newHolder: boolean;
  entryPrice: number;
  entryMarketCap: number;
  /** Age of the token's DEX pair (hours) at alert time, or null if unknown. */
  pairAgeHours: number | null;
  entryAt: number;
  lastPrice: number;
  /** Live market cap now (derived from the price move), for display. */
  lastMarketCap: number;
  /** Current return vs entry (%). */
  lastGainPct: number;
  maxPrice: number;
  /** Best return seen since the alert (%). */
  maxGainPct: number;
  maxGainAt: number;
  /** Highest 50%-interval milestone already announced (0 = none yet), so a
   *  restart or a flat tick never re-fires the same milestone card. */
  lastMilestoneAnnounced: number;
  /** Milestone returns (%), filled as the token ages past each mark. */
  gain1hPct: number | null;
  gain6hPct: number | null;
  gain24hPct: number | null;
  updatedAt: number;
  /** True once tracking has run its course (past PERF_TRACK_HOURS). */
  closed: boolean;
}

interface Bucket {
  label: string;
  count: number;
  avgMaxGainPct: number;
  medianMaxGainPct: number;
  bestMaxGainPct: number;
  /** Share that reached the win threshold (%). */
  winRatePct: number;
}

/** A per-wallet bucket. `label` is display-only and drifts; `walletId` is the stable key. */
interface WalletBucket extends Bucket {
  walletId: string;
}

const gainPct = (entry: number, now: number): number =>
  entry > 0 ? Math.round(((now - entry) / entry) * 1000) / 10 : 0;

function convictionBand(c: number): string {
  if (c < 60) return '<60';
  if (c < 70) return '60-69';
  if (c < 80) return '70-79';
  if (c < 90) return '80-89';
  return '90-100';
}
const CONVICTION_BANDS = ['<60', '60-69', '70-79', '80-89', '90-100'];

function marketCapBand(mc: number): string {
  if (mc < 50_000) return '<50K';
  if (mc < 150_000) return '50K-150K';
  if (mc < 500_000) return '150K-500K';
  if (mc < 2_000_000) return '500K-2M';
  return '2M+';
}
const MARKETCAP_BANDS = ['<50K', '50K-150K', '150K-500K', '500K-2M', '2M+'];

function tokenAgeBand(hours: number | null): string {
  if (hours == null) return 'unknown';
  if (hours < 1) return '<1h';
  if (hours < 6) return '1-6h';
  if (hours < 24) return '6-24h';
  if (hours < 168) return '1-7d';
  return '7d+';
}
const TOKEN_AGE_BANDS = ['<1h', '1-6h', '6-24h', '1-7d', '7d+', 'unknown'];

/** Offset (minutes, e.g. -300) of `tz` at `at`, derived from Intl's short GMT
 *  offset — handles daylight saving without a date library. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(part ?? '');
  if (!m) return 0;
  const sign = m[1]!.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(m[1])) * 60 + Number(m[2] ?? 0));
}

/** Ms until the next wall-clock `hour`:00:00 in `tz` (tomorrow if already past
 *  today). Self-correcting across DST since the offset is recomputed each call. */
function msUntilNextLocalHour(tz: string, hour: number): number {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, p) => {
      if (p.type === 'year' || p.type === 'month' || p.type === 'day') acc[p.type] = Number(p.value);
      return acc;
    }, {});
  const offsetMin = tzOffsetMinutes(tz, now);
  let target = Date.UTC(ymd.year!, ymd.month! - 1, ymd.day!, hour, 0, 0) - offsetMin * 60_000;
  if (target <= now.getTime()) target += 24 * 3_600_000;
  return target - now.getTime();
}

function bucket(label: string, calls: TrackedCall[], winThreshold: number): Bucket {
  if (calls.length === 0) {
    return { label, count: 0, avgMaxGainPct: 0, medianMaxGainPct: 0, bestMaxGainPct: 0, winRatePct: 0 };
  }
  const gains = calls.map((c) => c.maxGainPct).sort((a, b) => a - b);
  const sum = gains.reduce((s, g) => s + g, 0);
  const mid = Math.floor(gains.length / 2);
  const median = gains.length % 2 ? gains[mid]! : (gains[mid - 1]! + gains[mid]!) / 2;
  const wins = calls.filter((c) => c.maxGainPct >= winThreshold).length;
  return {
    label,
    count: calls.length,
    avgMaxGainPct: Math.round((sum / calls.length) * 10) / 10,
    medianMaxGainPct: Math.round(median * 10) / 10,
    bestMaxGainPct: gains[gains.length - 1]!,
    winRatePct: Math.round((wins / calls.length) * 1000) / 10,
  };
}

/**
 * Follows every fired alert and records how the token actually performed, so
 * signal quality can be measured from real outcomes instead of guessed. The
 * summary breaks results down by the dimensions that matter for catching
 * runners — multi-wallet vs solo, and repeat vs single — so the operator can
 * see which setups pay. Emits `'milestone'` with `{ call, milestonePct }`
 * each time a call's peak return crosses a new PERF_MILESTONE_STEP_PCT
 * interval, for the notification layer to turn into a PnL card.
 */
export class PerformanceTracker extends EventEmitter {
  private readonly calls = new Map<string, TrackedCall>();
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(private readonly price: PriceOracle) {
    super();
  }

  /** Register a fired alert for follow-up. No-op unless we have a live entry
   *  price (synthetic prices can't be measured against the market). */
  track(swarm: Swarm): void {
    if (!config.PERFORMANCE_TRACKING) return;
    const entryPrice = swarm.priceUsd ?? 0;
    if (!swarm.priceLive || !(entryPrice > 0)) return;
    if (this.calls.has(swarm.id)) return;
    const now = Date.now();
    this.calls.set(swarm.id, {
      id: swarm.id,
      token: swarm.token,
      tokenSymbol: swarm.tokenSymbol,
      kind: swarm.kind,
      conviction: swarm.conviction,
      walletCount: swarm.walletCount,
      walletSummary: swarm.walletSummary,
      walletLabels: swarm.walletLabels,
      walletIds: swarm.walletIds,
      repeatCount: swarm.repeatCount ?? 1,
      repeatWallets: swarm.repeatWallets ?? swarm.walletCount,
      newHolder: swarm.repeatNewWallet ?? false,
      entryPrice,
      entryMarketCap: swarm.marketCap,
      pairAgeHours: swarm.pairAgeHours ?? null,
      entryAt: now,
      lastPrice: entryPrice,
      lastMarketCap: swarm.marketCap,
      lastGainPct: 0,
      maxPrice: entryPrice,
      maxGainPct: 0,
      maxGainAt: now,
      lastMilestoneAnnounced: 0,
      gain1hPct: null,
      gain6hPct: null,
      gain24hPct: null,
      updatedAt: now,
      closed: false,
    });
    // Bound memory: drop the oldest closed calls once we exceed the cap.
    if (this.calls.size > 500) {
      for (const [id, c] of this.calls) {
        if (c.closed) this.calls.delete(id);
        if (this.calls.size <= 500) break;
      }
    }
  }

  start(): void {
    if (!config.PERFORMANCE_TRACKING) return;
    const everyMs = Math.max(1, config.PERF_SAMPLE_MINUTES) * 60_000;
    this.timer = setInterval(() => void this.sample(), everyMs);
    logger.info(
      { sampleMinutes: config.PERF_SAMPLE_MINUTES, trackHours: config.PERF_TRACK_HOURS },
      'performance tracker: following alert outcomes',
    );
    this.scheduleReset();
  }

  /** Clear every tracked call (open + closed) and persist the empty state.
   *  Used by both the daily auto-reset and the admin's manual Reset button. */
  reset(): void {
    this.calls.clear();
    void this.persist();
    logger.info('performance: Best Calls list reset');
  }

  private scheduleReset(): void {
    if (!config.PERFORMANCE_TRACKING || !config.PERF_AUTO_RESET) return;
    const ms = msUntilNextLocalHour(config.PERF_RESET_TZ, config.PERF_RESET_HOUR);
    this.resetTimer = setTimeout(() => {
      this.reset();
      this.scheduleReset();
    }, ms);
    logger.info(
      { tz: config.PERF_RESET_TZ, hour: config.PERF_RESET_HOUR, inMinutes: Math.round(ms / 60_000) },
      'performance: next daily reset scheduled',
    );
  }

  /** Sample once shortly (used right after a burst of alerts so the card
   *  reflects the current price within seconds instead of waiting a full
   *  interval). Debounced so a burst schedules just one extra sample. */
  sampleSoon(): void {
    if (!config.PERFORMANCE_TRACKING || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.sample();
    }, 20_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.timer = null;
    this.soonTimer = null;
    this.resetTimer = null;
  }

  private async sample(): Promise<void> {
    const now = Date.now();
    const trackMs = config.PERF_TRACK_HOURS * 3_600_000;
    const open = [...this.calls.values()].filter((c) => !c.closed);
    for (const c of open) {
      try {
        await this.price.refreshNow(c.token);
      } catch {
        /* ignore transient fetch errors */
      }
      // Only sample a LIVE price. When DexScreener momentarily has no pair,
      // priceOf() falls back to a synthetic placeholder unrelated to the real
      // price — which would spike the peak to a garbage number that then sticks.
      // Skip those ticks and keep the last good values.
      const p = this.price.isLive(c.token) ? this.price.priceOf(c.token) : 0;
      if (p > 0) {
        c.lastPrice = p;
        c.lastGainPct = gainPct(c.entryPrice, p);
        c.lastMarketCap = c.entryPrice > 0 ? Math.round(c.entryMarketCap * (p / c.entryPrice)) : c.entryMarketCap;
        if (p > c.maxPrice) {
          c.maxPrice = p;
          c.maxGainPct = gainPct(c.entryPrice, p);
          c.maxGainAt = now;
          this.announceMilestones(c);
        }
      }
      const age = now - c.entryAt;
      if (c.gain1hPct == null && age >= 3_600_000) c.gain1hPct = c.lastGainPct;
      if (c.gain6hPct == null && age >= 6 * 3_600_000) c.gain6hPct = c.lastGainPct;
      if (c.gain24hPct == null && age >= 24 * 3_600_000) c.gain24hPct = c.lastGainPct;
      if (age >= trackMs) c.closed = true;
      c.updatedAt = now;
    }
    void this.persist();
  }

  /** Emit one `'milestone'` event per PERF_MILESTONE_STEP_PCT interval newly
   *  crossed by this call's peak return — a jump that skips several intervals
   *  between samples still announces each one, not just the highest. */
  private announceMilestones(c: TrackedCall): void {
    if (!config.PERF_MILESTONES_ENABLED) return;
    const step = config.PERF_MILESTONE_STEP_PCT;
    if (step <= 0) return;
    const reached = Math.floor(c.maxGainPct / step) * step;
    const last = c.lastMilestoneAnnounced ?? 0;
    for (let m = last + step; m <= reached; m += step) {
      c.lastMilestoneAnnounced = m;
      this.emit('milestone', { call: { ...c }, milestonePct: m });
    }
  }

  /** Load a previously persisted snapshot so redeploys don't lose outcome data.
   *  No-op unless PERF_STORE_PATH is set (point it at a Railway Volume). */
  async load(): Promise<void> {
    if (!config.PERFORMANCE_TRACKING || !config.PERF_STORE_PATH) return;
    logger.info({ path: config.PERF_STORE_PATH }, 'performance: persistence enabled');
    try {
      const raw = await readFile(config.PERF_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed) ? (parsed as TrackedCall[]) : [];
      for (const c of arr) if (c && c.id) this.calls.set(c.id, c);
      logger.info({ loaded: this.calls.size, path: config.PERF_STORE_PATH }, 'performance: restored snapshot');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') logger.warn({ err: String(err) }, 'performance: could not load snapshot');
    }
  }

  /** Atomically write the current calls to disk (temp file + rename). */
  async flush(): Promise<void> {
    if (!config.PERFORMANCE_TRACKING || !config.PERF_STORE_PATH) return;
    const path = config.PERF_STORE_PATH;
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.calls.values()]));
      await rename(tmp, path);
    } catch (err) {
      logger.warn({ err: String(err) }, 'performance: could not save snapshot');
    }
  }

  private persisting = false;
  /** Debounced persist so overlapping samples don't race on the file. */
  private async persist(): Promise<void> {
    if (this.persisting) return;
    this.persisting = true;
    try {
      await this.flush();
    } finally {
      this.persisting = false;
    }
  }

  /** All tracked calls, best peak gain first. */
  list(): TrackedCall[] {
    return [...this.calls.values()].sort((a, b) => b.maxGainPct - a.maxGainPct);
  }

  /** Aggregate outcomes by the dimensions that matter for catching runners. */
  summary(): {
    total: number;
    winThresholdPct: number;
    byWalletCount: Bucket[];
    byRepeat: Bucket[];
    byKind: Bucket[];
    byConviction: Bucket[];
    byMarketCap: Bucket[];
    byTokenAge: Bucket[];
    byWallet: WalletBucket[];
  } {
    const all = [...this.calls.values()];
    const win = config.PERF_WIN_THRESHOLD_PCT;
    const multi = all.filter((c) => c.walletCount >= 2);
    const solo = all.filter((c) => c.walletCount < 2);
    const repeat = all.filter((c) => c.repeatCount >= 2);
    const single = all.filter((c) => c.repeatCount < 2);
    const kinds: SwarmKind[] = ['BUY', 'SELL', 'ROTATION', 'SOLO', 'ENTRY'];

    // Not mutually exclusive: a call with 2+ wallets counts in EACH of its
    // wallets' buckets, so "which named wallet actually calls winners" is
    // visible per-wallet rather than only as an aggregate wallet-count stat.
    //
    // Grouped by walletId, NOT by label. Labels are derived from holdings, so keying on them
    // merged two wallets that happened to share a label and split one wallet's record in half
    // the moment it bought another coin — either way the per-wallet win rate was wrong.
    // Calls tracked before walletIds existed have none and are skipped here (their labels can't
    // be resolved back to a wallet); every other bucket still counts them.
    const byId = new Map<string, { label: string; labelAt: number; calls: TrackedCall[] }>();
    for (const c of all) {
      const ids = c.walletIds ?? [];
      for (const [i, id] of ids.entries()) {
        const entry = byId.get(id);
        const label = c.walletLabels[i] ?? id.slice(0, 6);
        if (!entry) {
          byId.set(id, { label, labelAt: c.entryAt, calls: [c] });
          continue;
        }
        entry.calls.push(c);
        // Labels drift; show the most recent one so the wallet reads as it looks today.
        // `>=` not `>`: two calls can land in the same millisecond, and on a tie the
        // later-processed call is the newer one (`calls` iterates in insertion order).
        if (c.entryAt >= entry.labelAt) {
          entry.label = label;
          entry.labelAt = c.entryAt;
        }
      }
    }
    const byWallet: WalletBucket[] = [...byId.entries()]
      .map(([walletId, { label, calls }]) => ({ walletId, ...bucket(label, calls, win) }))
      .sort((a, b) => b.count - a.count);

    return {
      total: all.length,
      winThresholdPct: win,
      byWalletCount: [
        bucket('multi-wallet (2+)', multi, win),
        bucket('solo (1 wallet)', solo, win),
      ],
      byRepeat: [
        bucket('repeat (2+ alerts)', repeat, win),
        bucket('single alert', single, win),
      ],
      byKind: kinds.map((k) => bucket(k, all.filter((c) => c.kind === k), win)),
      byConviction: CONVICTION_BANDS.map((label) =>
        bucket(label, all.filter((c) => convictionBand(c.conviction) === label), win),
      ),
      byMarketCap: MARKETCAP_BANDS.map((label) =>
        bucket(label, all.filter((c) => marketCapBand(c.entryMarketCap) === label), win),
      ),
      byTokenAge: TOKEN_AGE_BANDS.map((label) =>
        bucket(label, all.filter((c) => tokenAgeBand(c.pairAgeHours) === label), win),
      ),
      byWallet,
    };
  }

  /** Info for the dashboard: when the next auto-reset fires (or null if off). */
  resetInfo(): { enabled: boolean; hour: number; tz: string } {
    return { enabled: config.PERF_AUTO_RESET, hour: config.PERF_RESET_HOUR, tz: config.PERF_RESET_TZ };
  }
}
