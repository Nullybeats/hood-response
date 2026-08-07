import { config } from './config/env.js';
import { logger } from './logger.js';
import { MemoryStore } from './store/memory.js';
import {
  loadFeedState,
  saveFeedState,
  toPersistedToken,
  type PersistedSignalCandidate,
} from './store/feedState.js';
import { PriceOracle } from './chain/price.js';
import { createListener } from './chain/listener.js';
import { HyperSyncShadow } from './chain/shadow.js';
import { AttributionShadow } from './attrib/runtime.js';
import { Aggregator } from './engine/aggregator.js';
import { AlertEngine } from './engine/alertEngine.js';
import { attachPersistence } from './store/persistence.js';
import { buildServer } from './api/server.js';
import {
  configuredChannels,
  dispatchMilestone,
  editAlertResult,
  onAlertCardSent,
} from './notify/index.js';
import { SafetyChecker } from './chain/safety.js';
import { FirstBuyRegistry } from './v2/facts/firstBuy.js';
import { WalletOutcomes } from './v2/facts/outcomes.js';
import { V2Shadow } from './v2/runtime.js';
import { PerformanceTracker, type TrackedCall } from './engine/performance.js';
import { SniperRegistry } from './sniper/registry.js';
import { FeedSubscriber, SNIPER_FEED_URL } from './sniper/feed.js';
import { PonsWatcher } from './pons/watch.js';
import { tickPaper, paperEnabled } from './pons/paper.js';
import { TelegramCommands } from './telegram/commands.js';
import type { Swarm, SwapEvent } from './types.js';
import { walletIdSaltMissing } from './walletId.js';

type CandidateMode = PersistedSignalCandidate['mode'];
type CandidateResult = 'resolved' | 'retry' | 'discard';

/**
 * A bounded, durable retry lane for real chain candidates whose authoritative
 * pool price, supply, or creation age was temporarily unavailable. It never
 * replays a recorded alert; it only retains the pre-alert decision.
 */
class PendingSignalQueue {
  private readonly pending = new Map<string, PersistedSignalCandidate>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly evaluate: (candidate: PersistedSignalCandidate) => Promise<CandidateResult>) {}

  enqueue(swarm: Swarm, mode: CandidateMode): void {
    if (this.stopped) return;
    const key = swarm.id;
    const existing = this.pending.get(key);
    if (existing) return;
    if (this.pending.size >= 256) {
      logger.warn({ queued: this.pending.size, token: swarm.tokenSymbol }, 'signal retry queue full; candidate retained in chain ledger only');
      return;
    }
    const candidate: PersistedSignalCandidate = { swarm, mode, attempts: 0, nextAt: Date.now() + 1_000 };
    this.pending.set(key, candidate);
    this.schedule(key, candidate);
    logger.info({ token: swarm.tokenSymbol, mode }, 'signal pending: awaiting canonical price/age evidence');
  }

  restore(candidates: readonly PersistedSignalCandidate[]): void {
    for (const candidate of candidates.slice(0, 256)) {
      if (this.pending.has(candidate.swarm.id)) continue;
      this.pending.set(candidate.swarm.id, candidate);
      this.schedule(candidate.swarm.id, candidate);
    }
  }

  snapshot(): PersistedSignalCandidate[] {
    return [...this.pending.values()].map((candidate) => ({ ...candidate, swarm: candidate.swarm }));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(key: string, candidate: PersistedSignalCandidate): void {
    if (this.stopped || this.pending.get(key) !== candidate) return;
    const delay = Math.max(250, candidate.nextAt - Date.now());
    const timer = setTimeout(() => void this.retry(key, candidate), delay);
    timer.unref();
    this.timers.set(key, timer);
  }

  private async retry(key: string, candidate: PersistedSignalCandidate): Promise<void> {
    this.timers.delete(key);
    if (this.stopped || this.pending.get(key) !== candidate) return;
    const result = await this.evaluate(candidate).catch((err) => {
      logger.warn({ err: String(err), token: candidate.swarm.tokenSymbol }, 'signal retry evaluation failed');
      return 'retry' as const;
    });
    if (result !== 'retry') {
      this.pending.delete(key);
      return;
    }
    candidate.attempts += 1;
    // Quick first recovery, then a bounded one-minute cadence. The record is
    // never discarded merely because an external provider stayed unavailable.
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(candidate.attempts, 6));
    candidate.nextAt = Date.now() + delay;
    this.schedule(key, candidate);
  }
}

async function main(): Promise<void> {
  logger.info(
    {
      mode: config.chainMode,
      channels: configuredChannels(),
      database: config.hasDatabase,
      redis: config.hasRedis,
    },
    'starting Swarm the Fly',
  );

  if (walletIdSaltMissing) {
    logger.warn(
      'WALLET_ID_SALT is unset — public wallet ids use a built-in salt and can be reversed to ' +
        'addresses by brute force. Set it to a long random string, once, and never rotate it.',
    );
  }

  const store = new MemoryStore();
  await store.loadSettings();

  // Durable feed state. Restored BEFORE the price oracle is constructed, since
  // the oracle is seeded from the token map — a registry restored after it would
  // leave every recovered token unpriced until the next refresh.
  const feedState = await loadFeedState(config.FEED_STATE_PATH);
  let resumeCursor: number | null = null;
  if (feedState) {
    const added = store.importTokens(feedState.tokens);
    store.restoreHistory(feedState.swarms, feedState.alerts);
    resumeCursor = feedState.cursor;
    logger.info(
      {
        cursor: feedState.cursor,
        tokensRestored: added,
        swarms: feedState.swarms.length,
        alerts: feedState.alerts.length,
        ageSeconds: feedState.savedAt ? Math.round((Date.now() - feedState.savedAt) / 1000) : null,
        path: config.FEED_STATE_PATH,
      },
      'feed state: restored snapshot',
    );
  } else if (config.FEED_STATE_PATH) {
    logger.info({ path: config.FEED_STATE_PATH }, 'feed state: no usable snapshot — cold start');
  }

  const price = new PriceOracle([...store.tokensByAddress.values()], store);
  // The durable UI may contain a handful of signals created while a new pair
  // was still unindexed. Give those visible tokens priority over the broad
  // restored-token sweep; this is display enrichment only, never alert input.
  const visibleTokens = [
    ...store.recentSwarms(50).map((swarm) => swarm.token),
    ...store.recentAlerts(30).map((alert) => alert.swarm.token),
  ];
  for (const token of visibleTokens) price.requestRefresh(token);
  price.start();
  void price.warmVisible(visibleTokens).then(() => {
    if (visibleTokens.length) logger.info({ tokens: new Set(visibleTokens).size }, 'price: visible feed warm-up complete');
  });
  const aggregator = new Aggregator(store, price);
  const engine = new AlertEngine(store, aggregator);

  // Follow every fired alert and record how the token actually performed, so we
  // can measure which signals produce runners (multi-wallet vs solo, repeat vs
  // single) from real outcomes.
  const performance = new PerformanceTracker(price);
  await performance.load();
  performance.start();
  performance.on('milestone', ({ call, milestonePct }: { call: TrackedCall; milestonePct: number }) => {
    void dispatchMilestone(call, milestonePct, price.dexUrl(call.token));
  });
  // The Telegram channel is alerts only: a call's result is edited onto its own
  // alert card rather than posted as a separate milestone message. These two
  // hooks are the round trip — remember the message we sent, then update it.
  onAlertCardSent((swarmId, messageId, cardHtml) => {
    performance.attachTelegramCard(swarmId, messageId, cardHtml);
  });
  performance.on('card', ({ call }: { call: TrackedCall }) => {
    if (call.telegramMessageId == null || !call.telegramCardHtml) return;
    void editAlertResult(call, call.telegramMessageId, call.telegramCardHtml);
  });

  // Sniper: one independent hot-wallet engine per admin (off by default). The
  // registry restores every known operator's engine on boot so their positions
  // survive redeploys and stay viewable; the live alert stream fans out to all.
  const sniper = new SniperRegistry(price);
  await sniper.loadAll();
  // Resume trading immediately after a restart/deploy: auto-unlock the primary
  // operator's wallet (SNIPER_AUTO_UNLOCK_OWNERS) so an ON sniper isn't left dark
  // waiting for a manual unlock, and fire a health alert either way.
  sniper.resumeAll();
  sniper.start();
  // The sniper buys ONLY from the canonical swarm feed (the source of truth the
  // operator watches), never from this box engine's own local alerts. This
  // subscribes to the feed's SSE stream and drives every operator's engine.
  const feed = new FeedSubscriber(sniper, price, SNIPER_FEED_URL);
  feed.start();

  // Pons launchpad — a second, independent entry source. No-ops unless PONS_ENABLED, and is
  // DRY-RUN by default even then; it polls the free public node, so it adds no metered RPC load.
  const pons = new PonsWatcher((l) => sniper.onPonsLaunch(l));
  pons.start();

  // Paper book monitor. Carries each simulated fill to a real exit on real executable sell quotes,
  // which is the half that says whether the strategy MAKES MONEY — simulating the buy only proves
  // it executes. Only runs in dry run; once live, real positions own the exit path instead.
  if (paperEnabled()) {
    const quoteSell = async (token: string, tokens: number) => {
      const engine = sniper.any();
      return engine ? await engine.quotePonsSell(token, tokens) : null;
    };
    setInterval(() => void tickPaper(quoteSell), 20_000);
  }
  // New heads drive the exit monitor. The engines collapse concurrent samples,
  // so an RPC latency metric update can never create duplicate sell attempts.
  let lastSniperBlock = 0;
  store.on('metrics', (m) => {
    if (m.lastBlock > lastSniperBlock) {
      lastSniperBlock = m.lastBlock;
      for (const e of sniper.all()) e.onBlock();
    }
  });

  // Inbound Telegram commands (/t5, /t10, /l5) answered from live performance data.
  const telegramCommands = new TelegramCommands(performance);
  telegramCommands.start();

  store.on('alert', (a) => {
    performance.track(a.swarm);
    performance.sampleSoon();
    // NOTE: the sniper is NOT driven from this box engine's own alerts. It buys
    // exclusively from the canonical swarm feed (see FeedSubscriber above), so it
    // can never act on a coin the operator's Signals Feed didn't call.
  });

  const detachPersistence = await attachPersistence(store);

  // Refresh a swarm's market cap from the live source before it is recorded or
  // alerted, so the market cap shown is the real one (not the synthetic
  // placeholder) even for tokens the background refresher hasn't reached yet.
  const safety = new SafetyChecker();

  // ── v2 shadow ──────────────────────────────────────────────────────────────
  // Providers answer only from what is ALREADY established, synchronously. A
  // null here is honest ("not known yet"), and the v2 gate turns it into a retry
  // — which is why none of them fetch. Blocking the listener to enrich a shadow
  // would let a measurement-only path slow the thing it is measuring.
  const firstBuyRegistry = new FirstBuyRegistry();
  const walletOutcomes = new WalletOutcomes(performance);

  /**
   * Screen a token for the shadow, at most once at a time.
   *
   * The in-flight set matters: a token being retried every few seconds would
   * otherwise queue a fresh GoPlus/Blockscout call on every pass, turning a
   * measurement-only path into a burst of duplicated external requests against
   * providers that rate-limit. Failures are swallowed — an unscreened token
   * stays unknown, which is exactly what the gate expects.
   */
  const safetyInFlight = new Set<string>();
  const warmSafety = (token: string): void => {
    const key = token.toLowerCase();
    if (safetyInFlight.has(key)) return;
    safetyInFlight.add(key);
    void safety
      .check(key, price.liquidityOf(key))
      .catch(() => null)
      .finally(() => safetyInFlight.delete(key));
  };
  /**
   * Pull a token's quote on the SAME path the alert engine uses.
   *
   * `requestRefresh` only nudges a bounded background queue, and the shadow was
   * relying on it alone: market cap resolved on none of the trades it saw, and
   * they were dropped with "marketCap still unresolved after 8 attempts" while
   * the queue was still working through hundreds of restored tokens.
   * `refreshOnChainNow` reads the canonical V3/V4 pool directly — it is what
   * enrichSwarm calls, and it already de-duplicates in flight, so calling it per
   * retry costs one read per token rather than one per attempt.
   */
  const warmQuote = (token: string): void => {
    void price.refreshOnChainNow(token.toLowerCase()).catch(() => null);
  };
  const v2Shadow = new V2Shadow({
    marketCap: (token) => {
      const t = store.tokensByAddress.get(token.toLowerCase());
      const cap = t ? price.marketCap(t) : null;
      if (cap == null) warmQuote(token);
      return cap;
    },
    pairAge: (token) => {
      const created = price.pairCreatedAt(token);
      if (created == null) {
        // pairCreatedAt comes with the DexScreener record, which the same quote
        // path fetches when the pool read cannot answer on its own.
        warmQuote(token);
        return null;
      }
      // Sourced from the indexer, and labelled as such: an on-chain Initialize
      // block is strictly better evidence and will supersede this.
      return { hours: (Date.now() - created) / 3_600_000, source: 'dexscreener-paircreated' };
    },
    canSell: (token) => {
      const report = safety.cached(token);
      if (!report) {
        // Nothing has screened this token, and nothing would have: the legacy
        // path only screens tokens that become swarms, while v2 evaluates every
        // verified trade. Without this the retry lane could never succeed —
        // measured live as canSell resolving on 1% of trades, with the rest
        // waiting out the budget and being dropped. The gate was right to refuse
        // to assume; the pipeline was wrong to never go and look.
        //
        // Kicked off without awaiting: the listener must not block on a shadow,
        // and the retry a few seconds later is what reads the result.
        warmSafety(token);
        return null;
      }
      // `source: 'none'` means nothing was actually checked. Reporting that as
      // sellable is the exact bug that printed "🛡️ Safe" over unchecked tokens.
      if (report.source === 'none') return null;
      if (report.honeypot === true) return false;
      if (report.honeypot === false) return true;
      return null;
    },
    // Grades come from the tracked-call record, joined on the salted walletId
    // the performance module already records — NOT on labels, which mutate and
    // collide. A wallet with no closed calls returns nothing and grades `U`,
    // which is unknown rather than bad.
    outcomes: (wallet) => walletOutcomes.for(wallet),
    claimFirstBuy: (wallet, token, at, block) => firstBuyRegistry.claim(wallet, token, at, block),
    // Recovers the buy-size dial on brand-new pairs, whose usdValue is null at
    // detection because the pair had no price yet. Sourced as a later price, not
    // as the executed value.
    usdValueNow: (token, amount) => price.usdValue(token, amount),
    outcomeStats: () => {
      const s = walletOutcomes.stats();
      return { wallets: s.wallets, calls: s.calls };
    },
  });
  v2Shadow.start();

  const enrichSwarm = async (swarm: Swarm): Promise<void> => {
    // Alert-critical pricing is pool-first. DexScreener may fill optional
    // display data later, but its rate limits cannot postpone this signal.
    await price.refreshOnChainNow(swarm.token);
    const token = store.tokensByAddress.get(swarm.token);
    if (token) {
      // Re-sync the symbol in case DexScreener enriched a placeholder since detection.
      swarm.tokenSymbol = token.symbol;
      swarm.marketCap = price.marketCap(token);
      swarm.priceLive = price.isLive(swarm.token);
      swarm.priceSource = price.sourceOf(swarm.token);
      swarm.dexUrl = price.dexUrl(swarm.token);
      swarm.priceUsd = price.priceOf(swarm.token);
      swarm.liquidityUsd = price.liquidityOf(swarm.token);
      swarm.dex = price.dexIdOf(swarm.token);
      swarm.athMarketCap = price.athMarketCapOf(swarm.token);
    }
    swarm.momentum = price.momentumOf(swarm.token) ?? undefined;

    // Pair age / freshness.
    const createdAt = price.pairCreatedAt(swarm.token);
    if (createdAt) {
      swarm.pairAgeHours = Math.round(((Date.now() - createdAt) / 3_600_000) * 10) / 10;
      swarm.freshPair = swarm.pairAgeHours <= config.FRESH_PAIR_MAX_AGE_HOURS;
    } else {
      swarm.pairAgeHours = null;
      swarm.freshPair = false;
    }

    // Refine conviction with REAL data now that price/liquidity/momentum are in:
    // reward low caps (more room to run), healthy liquidity, and momentum;
    // penalise dangerously thin liquidity.
    let adj = 0;
    const mc = swarm.marketCap;
    if (mc != null && mc > 0) {
      if (mc < 50_000) adj += 10;
      else if (mc < 150_000) adj += 7;
      else if (mc < 500_000) adj += 4;
      else if (mc < 2_000_000) adj += 2;
    }
    const liq = swarm.liquidityUsd;
    if (liq != null) {
      if (liq >= 25_000) adj += 3;
      else if (liq < 5_000) adj -= 6;
    }
    if (swarm.freshPair) adj += 3;
    if (swarm.momentum?.confirmed) adj += swarm.momentum.boost;
    swarm.conviction = Math.max(0, Math.min(100, swarm.conviction + adj));

    // PRIME: the kind+conviction combo that actually backtested well (ENTRY @
    // conviction 80+ averaged a 79% peak vs 52% baseline — see performance
    // history). Computed last, after conviction is finalized above.
    swarm.prime =
      config.PRIME_ALERTS &&
      config.primeKinds.has(swarm.kind) &&
      swarm.conviction >= config.PRIME_MIN_CONVICTION;
  };

  // Record the swarm, then alert only if it passes the safety screen (honeypot /
  // tax / liquidity). Unsafe swarms still appear on the dashboard, tagged, but
  // never reach the notification channels.
  const recordAndMaybeAlert = async (swarm: Swarm): Promise<void> => {
    // Re-check the ignore list against the (possibly enriched) symbol so a
    // tokenised equity that arrived as a placeholder can't slip through.
    if (config.ignoreSymbols.has(swarm.tokenSymbol.toUpperCase())) return;
    // Blue-chip buy/sell filter: suppress tracked-wallet trades of the coins we
    // already track when that side is toggled off (whales just moving money).
    const blueChipSuppressed = store.blueChipSuppressed(swarm.kind, swarm.token);
    if (config.SAFETY_FILTER && !blueChipSuppressed) {
      swarm.safety = await safety.check(swarm.token, price.liquidityOf(swarm.token));
    }
    store.recordSwarm(swarm);
    if (blueChipSuppressed) {
      logger.info(
        { token: swarm.tokenSymbol, kind: swarm.kind },
        'alert suppressed by blue-chip filter',
      );
      return;
    }
    if (swarm.safety && !swarm.safety.ok) {
      logger.info(
        { token: swarm.tokenSymbol, fails: swarm.safety.hardFails },
        'alert suppressed by safety filter',
      );
      return;
    }
    // Global market-cap floor — no alerts on tokens below this cap.
    //
    // FAILS CLOSED on an unknown cap. This gate used to require `marketCap > 0`
    // to apply, so an unpriced token skipped it entirely; the synthetic oracle
    // then made sure the cap was never 0, so nothing was ever skipped and
    // everything was measured against a fabricated number. A cap we cannot
    // verify is not a cap above the floor.
    if (config.ALERT_MIN_MARKETCAP > 0) {
      if (swarm.marketCap == null) {
        // Say WHICH unknown. "no-price" means nobody has indexed the pair and
        // its pool could not be read; "unverified-supply" means we have a real
        // price but never got totalSupply() off the contract — which is now
        // queued for backfill, so the same coin can resolve on a later pass.
        const tok = store.tokensByAddress.get(swarm.token);
        const cap = tok ? price.resolveCap(tok) : null;
        logger.info(
          { token: swarm.tokenSymbol, priceSource: swarm.priceSource, capReason: cap?.reason },
          'alert suppressed: market cap unknown (fail closed)',
        );
        return;
      }
      if (swarm.marketCap < config.ALERT_MIN_MARKETCAP) {
        logger.info(
          { token: swarm.tokenSymbol, mc: Math.round(swarm.marketCap) },
          'alert suppressed: below minimum market cap',
        );
        return;
      }
    }
    // Global minimum pair age — no alerts on pairs younger than this.
    if (
      config.PAIR_MIN_AGE_MINUTES > 0 &&
      swarm.pairAgeHours != null &&
      swarm.pairAgeHours * 60 < config.PAIR_MIN_AGE_MINUTES
    ) {
      logger.info(
        { token: swarm.tokenSymbol, ageMin: Math.round((swarm.pairAgeHours ?? 0) * 60) },
        'alert suppressed: pair too new',
      );
      return;
    }
    // Optional volume gate: drop dead tokens when a minimum is configured.
    if (
      config.MOMENTUM_MIN_VOLUME_USD > 0 &&
      swarm.momentum?.volumeUsd != null &&
      swarm.momentum.volumeUsd < config.MOMENTUM_MIN_VOLUME_USD
    ) {
      logger.info(
        { token: swarm.tokenSymbol, volume: swarm.momentum.volumeUsd },
        'alert suppressed: below minimum volume',
      );
      return;
    }
    await engine.evaluate(swarm);
  };

  const evaluateCandidate = async (candidate: PersistedSignalCandidate): Promise<CandidateResult> => {
    const { swarm, mode } = candidate;
    await enrichSwarm(swarm);
    // No real quote yet is transient evidence failure, not a reason to lose a
    // wallet signal. Retry from the durable queue.
    if (!swarm.priceLive) return 'retry';
    if (config.ALERT_MIN_MARKETCAP > 0 && swarm.marketCap == null) return 'retry';
    if (mode === 'entry') {
      // `false` means conclusively too old; `undefined`/null means the
      // canonical creation block has not resolved yet and must be retried.
      if (swarm.pairAgeHours == null) return 'retry';
      if (!swarm.freshPair) return 'discard';
    }
    if (mode === 'solo') {
      if (swarm.marketCap == null) return 'retry';
      if (swarm.marketCap < config.SOLO_MIN_MARKETCAP || swarm.marketCap > config.SOLO_MAX_MARKETCAP) {
        return 'discard';
      }
    }
    await recordAndMaybeAlert(swarm);
    return 'resolved';
  };
  const pendingSignals = new PendingSignalQueue(evaluateCandidate);
  const submitCandidate = async (swarm: Swarm, mode: CandidateMode): Promise<void> => {
    const result = await evaluateCandidate({ swarm, mode, attempts: 0, nextAt: Date.now() });
    if (result === 'retry') pendingSignals.enqueue(swarm, mode);
  };

  // Pipeline: chain → decoder → store → aggregator → alert engine → notify.
  const handleSwap = async (swap: SwapEvent): Promise<void> => {
    // Drop settlement/quote tokens and tokenised equities before anything else —
    // keeps the feed, stats, and token registry focused on real gems.
    if (config.ignoreSymbols.has(swap.tokenSymbol.toUpperCase())) return;
    // Auto-register unknown tokens so brand-new coins flow through the pipeline.
    store.ensureToken(swap.token, swap.tokenSymbol);
    // Log only meaningful (non-dust) live buys/sells — these wallets can be very
    // active in low-value tokenised assets, which would otherwise flood the log.
    if (config.chainMode === 'live' && (swap.usdValue ?? 0) >= config.IGNORE_DUST_USD) {
      logger.info(
        { dir: swap.direction, token: swap.tokenSymbol, usd: Math.round(swap.usdValue ?? 0) },
        'tracked-wallet swap',
      );
    }
    store.recordSwap(swap);
    // v2 shadow: observes strictly-verified trades only, records what it would
    // have done, emits nothing. Deliberately before the legacy pipeline and
    // fully isolated from it — a fault here must never affect what ships today.
    try {
      v2Shadow.onSwap(swap);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200) }, 'v2 shadow: evaluation failed (legacy path unaffected)');
    }
    // The listener intentionally emits before price discovery finishes. Put
    // this visible row at the front of the bounded background price queue so
    // the UI can fill it on its next poll without slowing detection.
    price.requestRefresh(swap.token);

    // Multi-wallet swarms (BUY / SELL / ROTATION).
    for (const swarm of aggregator.ingest(swap)) {
      await submitCandidate(swarm, 'swarm');
    }

    // Solo low-cap buy: record + alert only when the real market cap is low.
    const solo = aggregator.soloCandidate(swap);
    if (solo) {
      await submitCandidate(solo, 'solo');
    }

    // Fresh-pair first entry: a qualifying-tier wallet's first buy of a token
    // whose pair is only hours old — record + alert only when the pair is fresh.
    const entry = aggregator.firstEntryCandidate(swap);
    if (entry) {
      await submitCandidate(entry, 'entry');
    }
  };

  // A second, durable measurement lane.  It is default-off and has no path
  // into handleSwap/alerts/sniper; it exists solely to account for what the
  // live detector did and did not observe.
  const attribution = new AttributionShadow([...store.wallets.keys()]);
  attribution.start();

  const listener = createListener(store, price, (swap) => {
    // Measurement-only observer.  `recordLiveEmission` is exception-contained
    // and returns no value, so it cannot alter the live handler's control flow.
    attribution.recordLiveEmission(swap);
    void handleSwap(swap);
  }, (poolId, token) => attribution.v4PoolContainsToken(poolId, token));
  if (resumeCursor != null) listener.resumeAt?.(resumeCursor);
  if (feedState?.pendingMetadata?.length) listener.restorePendingMetadata?.(feedState.pendingMetadata);
  if (feedState?.pendingSignals?.length) {
    pendingSignals.restore(feedState.pendingSignals);
    logger.info({ candidates: feedState.pendingSignals.length }, 'signal retry queue: restored pending candidates');
  }
  listener.start();

  // Shadow measurement. Reads the chain independently and classifies what it
  // finds; it is handed NOTHING from the live pipeline and hands nothing back.
  const shadow = new HyperSyncShadow([...store.wallets.keys()]);
  shadow.start();

  // Periodic snapshot. The cursor is the part that matters — a process killed
  // without a signal (OOM, platform restart) never reaches shutdown(), and the
  // gap between the last write and the death is the only window still lost.
  const persistFeedState = async (): Promise<void> => {
    if (!config.FEED_STATE_PATH) return;
    const history = store.exportHistory();
    await saveFeedState(config.FEED_STATE_PATH, {
      cursor: listener.cursor ?? 0,
      tokens: store.exportDiscoveredTokens().map(toPersistedToken),
      swarms: history.swarms,
      alerts: history.alerts,
      pendingMetadata: listener.pendingMetadata?.() ?? [],
      pendingSignals: pendingSignals.snapshot(),
    });
  };
  const feedStateTimer = config.FEED_STATE_PATH
    ? setInterval(() => void persistFeedState(), config.FEED_STATE_SAVE_MS)
    : null;
  feedStateTimer?.unref();

  const app = await buildServer(store, engine, aggregator, performance, sniper, shadow, attribution, price, v2Shadow);
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    { url: `http://${config.HOST}:${config.PORT}`, wallets: store.wallets.size },
    'Swarm the Fly is live',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down gracefully');
    listener.stop();
    pendingSignals.stop();
    shadow.stop();
    attribution.stop();
    if (feedStateTimer) clearInterval(feedStateTimer);
    // Flush the cursor before anything else can take time — this is the write
    // that decides whether the restart resumes or rescans from the head.
    await persistFeedState().catch(() => undefined);
    price.stop();
    performance.stop();
    feed.stop();
    sniper.stop();
    telegramCommands.stop();
    await performance.flush().catch(() => undefined);
    await sniper.flushAll().catch(() => undefined);
    await app.close().catch(() => undefined);
    await detachPersistence();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'fatal startup error');
  process.exit(1);
});
