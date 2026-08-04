import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { MemoryStore } from '../store/memory.js';
import type { Alert, AlertRule, Swarm } from '../types.js';
import { dispatch } from '../notify/index.js';
import type { Aggregator } from './aggregator.js';

function defaultRules(): AlertRule[] {
  const rules: AlertRule[] = [
    {
      id: 'default',
      name: 'Default swarm rule',
      enabled: true,
      minWallets: config.ALERT_MIN_WALLETS,
      windowSeconds: config.ALERT_WINDOW_SECONDS,
      minUsd: config.ALERT_MIN_USD,
      minConviction: config.ALERT_MIN_CONVICTION,
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
      kinds: ['BUY', 'SELL', 'ROTATION'],
      ignoredTokens: [],
      ignoredWallets: [],
    },
  ];
  if (config.SOLO_ALERTS) {
    rules.push({
      id: 'solo-lowcap',
      name: 'Solo low-cap buy',
      enabled: true,
      minWallets: 1,
      windowSeconds: config.ALERT_WINDOW_SECONDS,
      minUsd: config.ALERT_MIN_USD,
      minConviction: 0,
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
      minMarketCap: config.SOLO_MIN_MARKETCAP,
      maxMarketCap: config.SOLO_MAX_MARKETCAP,
      kinds: ['SOLO'],
      ignoredTokens: [],
      ignoredWallets: [],
    });
  }
  if (config.FRESH_ENTRY_ALERTS) {
    rules.push({
      id: 'fresh-entry',
      name: 'Fresh-pair first entry',
      enabled: true,
      minWallets: 1,
      windowSeconds: config.ALERT_WINDOW_SECONDS,
      minUsd: config.ALERT_MIN_USD,
      minConviction: 0,
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
      kinds: ['ENTRY'],
      ignoredTokens: [],
      ignoredWallets: [],
    });
  }
  return rules;
}

/** Kinds that describe a single-wallet event, excluded from the swarm floor. */
const SINGLE_WALLET_KINDS = new Set(['SOLO', 'ENTRY']);

/**
 * Turns raw swarm candidates into alerts by evaluating them against the set of
 * configurable rules, enforcing per-rule cooldowns, and fanning out to the
 * notification channels. Rule changes are pushed back into the aggregator so
 * its detection floor / window always covers the least-restrictive rule.
 */
export class AlertEngine {
  /** cooldown key -> last fire timestamp (ms). */
  private readonly cooldowns = new Map<string, number>();
  /** token -> one entry per alert fired for it inside the repeat window, each
   *  carrying its timestamp and the wallets that drove it. Powers both the
   *  repeat count and the DISTINCT-wallet count, and lets a brand-new wallet
   *  bypass the cooldown so one busy wallet can't hide the others. */
  private readonly repeats = new Map<
    string,
    { at: number; wallets: string[]; price: number | null }[]
  >();

  constructor(
    private readonly store: MemoryStore,
    private readonly aggregator: Aggregator,
  ) {
    if (this.store.rules.size === 0) {
      for (const r of defaultRules()) this.store.rules.set(r.id, r);
    }
    this.syncAggregator();
  }

  /** Keep the aggregator's detection floor/window aligned with enabled rules.
   *  Solo-only rules (SOLO kind) are excluded from the multi-wallet floor so a
   *  1-wallet solo rule never lowers the swarm threshold to 1. */
  private syncAggregator(): void {
    const enabled = [...this.store.rules.values()].filter((r) => r.enabled);
    if (enabled.length === 0) return;
    const multi = enabled.filter((r) => r.kinds.some((k) => !SINGLE_WALLET_KINDS.has(k)));
    if (multi.length > 0) {
      this.aggregator.detectionFloor = Math.max(1, Math.min(...multi.map((r) => r.minWallets)));
      this.aggregator.maxWindowSeconds = Math.max(...multi.map((r) => r.windowSeconds));
    }
  }

  listRules(): AlertRule[] {
    return [...this.store.rules.values()];
  }

  upsertRule(rule: AlertRule): AlertRule {
    this.store.rules.set(rule.id, rule);
    this.syncAggregator();
    return rule;
  }

  deleteRule(id: string): boolean {
    const ok = this.store.rules.delete(id);
    if (ok) this.syncAggregator();
    return ok;
  }

  private matches(rule: AlertRule, swarm: Swarm): boolean {
    if (!rule.enabled) return false;
    if (!rule.kinds.includes(swarm.kind)) return false;
    if (rule.ignoredTokens.includes(swarm.token)) return false;
    if (swarm.windowSeconds > rule.windowSeconds) return false;

    const ignored = new Set(rule.ignoredWallets.map((w) => w.toLowerCase()));
    const effective = swarm.wallets.filter((w) => !ignored.has(w));
    if (effective.length < rule.minWallets) return false;
    if (swarm.totalUsd < rule.minUsd) return false;
    if (swarm.conviction < rule.minConviction) return false;
    // Market-cap band rules (solo buys): require a KNOWN cap within the band.
    // Null is unknown, not "passes" — a rule that targets low caps must not fire
    // on a coin whose cap nobody can establish.
    if (rule.maxMarketCap != null || rule.minMarketCap != null) {
      if (swarm.marketCap == null || swarm.marketCap <= 0) return false;
      if (rule.maxMarketCap != null && swarm.marketCap > rule.maxMarketCap) return false;
      if (rule.minMarketCap != null && swarm.marketCap < rule.minMarketCap) return false;
    }
    return true;
  }

  /** Whether the per-rule/token/kind cooldown has elapsed. Pure — no mutation,
   *  so it can be combined with the new-wallet bypass before committing. */
  private isCooled(rule: AlertRule, swarm: Swarm, now: number): boolean {
    const key = `${rule.id}:${swarm.token}:${swarm.kind}`;
    const last = this.cooldowns.get(key) ?? 0;
    return now - last >= rule.cooldownSeconds * 1000;
  }

  /** Stamp the cooldown for this rule/token/kind at `now`. */
  private touchCooldown(rule: AlertRule, swarm: Swarm, now: number): void {
    this.cooldowns.set(`${rule.id}:${swarm.token}:${swarm.kind}`, now);
  }

  /** This token's alerts still inside the repeat window (pruned + stored). */
  private freshEntries(
    token: string,
    now: number,
  ): { at: number; wallets: string[]; price: number | null }[] {
    const windowMs = config.REPEAT_WINDOW_MINUTES * 60_000;
    const fresh = (this.repeats.get(token) ?? []).filter((e) => now - e.at < windowMs);
    this.repeats.set(token, fresh);
    // Bound memory on a long-running process with many discovered tokens.
    if (this.repeats.size > 5_000) {
      for (const [tok, entries] of this.repeats) {
        if (entries.every((e) => now - e.at >= windowMs)) this.repeats.delete(tok);
      }
    }
    return fresh;
  }

  /** The distinct wallets that have already driven this token's alerts. */
  private knownWallets(entries: { wallets: string[] }[]): Set<string> {
    const set = new Set<string>();
    for (const e of entries) for (const w of e.wallets) set.add(w);
    return set;
  }

  /** Escalation conviction bonus keyed on DISTINCT wallets: +4 per wallet past
   *  the first, capped at +12 — so one busy wallet re-buying earns nothing, but
   *  a coin drawing several different top holders climbs the rankings. */
  private escalationBoost(distinctWallets: number): number {
    return Math.min(12, Math.max(0, distinctWallets - 1) * 4);
  }

  /** Evaluate a detected swarm against all rules and fire alerts as needed. */
  async evaluate(swarm: Swarm): Promise<Alert[]> {
    const now = Date.now();
    const fired: Alert[] = [];
    const isMulti = !SINGLE_WALLET_KINDS.has(swarm.kind);
    let counted = false;
    for (const rule of this.store.rules.values()) {
      if (!this.matches(rule, swarm)) continue;

      // Wallet-aware gating so one busy wallet can't hog the bot and hide the
      // others: a swarm carrying a NEW distinct wallet for this token always
      // gets through (that's the "what are the other wallets doing" signal),
      // even inside the cooldown. Otherwise a multi-wallet swarm may re-fire on
      // the normal cooldown, but a lone repeat from an already-seen wallet (the
      // busy solo buyer) is suppressed.
      const entries = this.freshEntries(swarm.token, now);
      const known = this.knownWallets(entries);
      const hasNewWallet = swarm.wallets.some((w) => !known.has(w));
      const cooledNow = this.isCooled(rule, swarm, now);
      if (!hasNewWallet && !(isMulti && cooledNow)) continue;
      this.touchCooldown(rule, swarm, now);

      // First rule that actually fires for this swarm does the repeat accounting
      // once: count of alerts + DISTINCT wallets in the window, price change
      // since the previous alert, and whether a new holder drove this one.
      if (!counted) {
        counted = true;
        const prev = entries[entries.length - 1];
        const prevPrice = prev?.price ?? null;
        const nowPrice = swarm.priceUsd ?? null;
        swarm.repeatPriceChangePct =
          entries.length > 0 && prevPrice != null && nowPrice != null && prevPrice > 0
            ? Math.round(((nowPrice - prevPrice) / prevPrice) * 1000) / 10
            : null;
        swarm.repeatNewWallet = entries.length > 0 && hasNewWallet;

        entries.push({ at: now, wallets: swarm.wallets, price: nowPrice });
        this.repeats.set(swarm.token, entries);

        swarm.repeatCount = entries.length;
        swarm.repeatWallets = this.knownWallets(entries).size;
        swarm.repeatWindowMinutes = config.REPEAT_WINDOW_MINUTES;

        // Escalate on distinct wallets, with an extra nudge when a brand-new
        // top holder just joined (a different holder is more attractive than
        // the same wallet buying again).
        const boost =
          this.escalationBoost(swarm.repeatWallets) + (swarm.repeatNewWallet ? 4 : 0);
        if (boost > 0) swarm.conviction = Math.min(100, swarm.conviction + boost);
      }

      const alert: Alert = {
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        swarm,
        createdAt: now,
        deliveries: [],
      };
      this.store.recordAlert(alert);
      logger.info(
        {
          rule: rule.name,
          kind: swarm.kind,
          token: swarm.tokenSymbol,
          conviction: swarm.conviction,
          repeat: swarm.repeatCount,
          repeatWallets: swarm.repeatWallets,
          newWallet: swarm.repeatNewWallet,
        },
        'ALERT fired',
      );
      // Deliver asynchronously; attach results when they land.
      void dispatch(swarm).then((deliveries) => {
        alert.deliveries = deliveries;
      });
      fired.push(alert);
    }
    return fired;
  }
}
