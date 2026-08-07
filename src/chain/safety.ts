import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { SafetyReport } from '../types.js';

/**
 * Token safety screen.
 *
 * Combines GoPlus token-security (honeypot, buy/sell tax, mintable, ownership,
 * LP lock — supported on Robinhood Chain, id 4663) with the live DEX liquidity
 * from DexScreener. Produces a hard pass/fail plus soft warnings, used to
 * suppress alerts on rugs/honeypots before they reach Telegram. Every network
 * call is best-effort: if GoPlus is unreachable we degrade to a liquidity-only
 * verdict rather than blocking every alert.
 */

/** Raw GoPlus fields we care about (all strings: "0" / "1" / "" / "0.05"). */
export interface GoPlusToken {
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  buy_tax?: string;
  sell_tax?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  transfer_pausable?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  is_open_source?: string;
  is_blacklisted?: string;
  lp_holders?: { is_locked?: number | string; percent?: string }[];
}

const isFlag = (v: string | undefined): boolean => v === '1';
const asPct = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : null;
};

export interface SafetyThresholds {
  minLiquidityUsd: number;
  maxTaxPct: number;
}

/**
 * Pure evaluation — no network — so it is fully unit-testable. `gp` is null when
 * GoPlus data is unavailable.
 */
export interface BlockscoutMeta {
  verified: boolean | null;
}

export function evaluateSafety(
  gp: GoPlusToken | null,
  liquidityUsd: number | null,
  t: SafetyThresholds,
  bs?: BlockscoutMeta | null,
): SafetyReport {
  const hardFails: string[] = [];
  const warnings: string[] = [];

  // Liquidity applies regardless of GoPlus availability.
  if (liquidityUsd != null) {
    if (liquidityUsd < t.minLiquidityUsd) {
      hardFails.push(`low liquidity $${Math.round(liquidityUsd).toLocaleString()}`);
    }
  } else {
    warnings.push('liquidity unknown');
  }

  let buyTaxPct: number | null = null;
  let sellTaxPct: number | null = null;
  let honeypot = false;

  if (gp) {
    buyTaxPct = asPct(gp.buy_tax);
    sellTaxPct = asPct(gp.sell_tax);
    honeypot = isFlag(gp.is_honeypot);

    if (honeypot) hardFails.push('honeypot');
    if (isFlag(gp.cannot_sell_all)) hardFails.push('cannot sell all');
    if (isFlag(gp.cannot_buy)) hardFails.push('cannot buy');
    if (isFlag(gp.selfdestruct)) hardFails.push('self-destruct');
    if (isFlag(gp.can_take_back_ownership)) hardFails.push('owner can reclaim');
    if (isFlag(gp.is_blacklisted)) hardFails.push('blacklist function');
    if (sellTaxPct != null && sellTaxPct > t.maxTaxPct) hardFails.push(`sell tax ${sellTaxPct.toFixed(0)}%`);
    if (buyTaxPct != null && buyTaxPct > t.maxTaxPct) hardFails.push(`buy tax ${buyTaxPct.toFixed(0)}%`);

    if (isFlag(gp.is_mintable)) warnings.push('mintable');
    if (isFlag(gp.transfer_pausable)) warnings.push('pausable');
    if (isFlag(gp.hidden_owner)) warnings.push('hidden owner');
    if (isFlag(gp.honeypot_with_same_creator)) warnings.push('creator made a honeypot before');
    if (gp.is_open_source === '0') warnings.push('unverified source');

    const lockedPct = (gp.lp_holders ?? [])
      .filter((h) => String(h.is_locked) === '1')
      .reduce((s, h) => s + Number(h.percent ?? 0), 0);
    if (gp.lp_holders && gp.lp_holders.length > 0 && lockedPct < 0.5) {
      warnings.push('LP not locked');
    }
  } else if (bs) {
    // GoPlus had no data yet (common for brand-new tokens): fall back to the
    // explorer's contract-verification status as a partial signal.
    if (bs.verified === false) warnings.push('unverified contract');
  } else {
    warnings.push('safety data unavailable');
  }

  const source: SafetyReport['source'] = gp
    ? 'goplus'
    : bs
      ? 'blockscout'
      : liquidityUsd != null
        ? 'liquidity-only'
        : 'none';

  return {
    ok: hardFails.length === 0,
    checkedAt: Date.now(),
    liquidityUsd,
    buyTaxPct,
    sellTaxPct,
    honeypot,
    hardFails,
    warnings,
    source,
  };
}

export class SafetyChecker {
  private readonly cache = new Map<string, SafetyReport>();
  private static readonly TTL_MS = 10 * 60_000; // safety changes slowly

  private thresholds(): SafetyThresholds {
    return {
      minLiquidityUsd: config.SAFETY_MIN_LIQUIDITY_USD,
      maxTaxPct: config.SAFETY_MAX_TAX_PCT,
    };
  }

  private async goPlusOnce(address: string): Promise<GoPlusToken | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const url = `https://api.gopluslabs.io/api/v1/token_security/${config.CHAIN_ID}?contract_addresses=${address}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: Record<string, GoPlusToken> };
      const row = json.result?.[address.toLowerCase()];
      // GoPlus returns an empty object for a token it hasn't scanned yet.
      return row && Object.keys(row).length > 0 ? row : null;
    } catch (err) {
      logger.debug({ err: String(err) }, 'goplus fetch failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GoPlus scans unseen tokens on first request, so retry once after a beat. */
  private async fetchGoPlus(address: string): Promise<GoPlusToken | null> {
    const first = await this.goPlusOnce(address);
    if (first) return first;
    await new Promise((r) => setTimeout(r, 2500));
    return this.goPlusOnce(address);
  }

  /** Explorer contract-verification status, as a partial fallback signal. */
  private async fetchBlockscout(address: string): Promise<BlockscoutMeta | null> {
    const base = config.EXPLORER_BASE.replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${base}/api/v2/smart-contracts/${address}`, { signal: ctrl.signal });
      if (res.status === 404) return { verified: false };
      if (!res.ok) return null;
      const json = (await res.json()) as { is_verified?: boolean };
      return { verified: json.is_verified ?? true };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The cached verdict, or null when none has been established yet.
   *
   * Synchronous and non-fetching on purpose. The v2 pipeline must be able to ask
   * "do we KNOW whether this can be sold?" without blocking, and get an honest
   * null when the answer has not landed — which its gate turns into a retry
   * rather than an assumption. A fetching variant here would reintroduce exactly
   * the pressure that made the legacy screen report `ok` on no data at all.
   */
  cached(tokenAddress: string): SafetyReport | null {
    const hit = this.cache.get(tokenAddress.toLowerCase());
    if (!hit) return null;
    return Date.now() - hit.checkedAt < SafetyChecker.TTL_MS ? hit : null;
  }

  /** Screen a token, using a cached verdict when fresh. */
  async check(tokenAddress: string, liquidityUsd: number | null): Promise<SafetyReport> {
    const key = tokenAddress.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.checkedAt < SafetyChecker.TTL_MS) return cached;

    const gp = await this.fetchGoPlus(key);
    const bs = gp ? null : await this.fetchBlockscout(key);
    const report = evaluateSafety(gp, liquidityUsd, this.thresholds(), bs);
    this.cache.set(key, report);
    while (this.cache.size > 5_000) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return report;
  }
}
