import { config } from './config/env.js';
import { logger } from './logger.js';
import { MemoryStore } from './store/memory.js';
import { PriceOracle } from './chain/price.js';
import { createListener } from './chain/listener.js';
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
import { PerformanceTracker, type TrackedCall } from './engine/performance.js';
import { SniperRegistry } from './sniper/registry.js';
import { FeedSubscriber, SNIPER_FEED_URL } from './sniper/feed.js';
import { PonsWatcher } from './pons/watch.js';
import { tickPaper, paperEnabled } from './pons/paper.js';
import { TelegramCommands } from './telegram/commands.js';
import type { Swarm, SwapEvent } from './types.js';
import { walletIdSaltMissing } from './walletId.js';

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
  const price = new PriceOracle([...store.tokensByAddress.values()], store);
  price.start();
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

  const enrichSwarm = async (swarm: Swarm): Promise<void> => {
    await price.refreshNow(swarm.token);
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
        logger.info(
          { token: swarm.tokenSymbol, priceSource: swarm.priceSource },
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

    // Multi-wallet swarms (BUY / SELL / ROTATION).
    for (const swarm of aggregator.ingest(swap)) {
      await enrichSwarm(swarm);
      await recordAndMaybeAlert(swarm);
    }

    // Solo low-cap buy: record + alert only when the real market cap is low.
    const solo = aggregator.soloCandidate(swap);
    if (solo) {
      await enrichSwarm(solo);
      // Band membership is unprovable without a cap — an unknown one is out.
      if (
        solo.marketCap != null &&
        solo.marketCap >= config.SOLO_MIN_MARKETCAP &&
        solo.marketCap <= config.SOLO_MAX_MARKETCAP
      ) {
        await recordAndMaybeAlert(solo);
      }
    }

    // Fresh-pair first entry: a qualifying-tier wallet's first buy of a token
    // whose pair is only hours old — record + alert only when the pair is fresh.
    const entry = aggregator.firstEntryCandidate(swap);
    if (entry) {
      await enrichSwarm(entry);
      if (entry.freshPair) {
        await recordAndMaybeAlert(entry);
      }
    }
  };

  const listener = createListener(store, price, (swap) => void handleSwap(swap));
  listener.start();

  const app = await buildServer(store, engine, aggregator, performance, sniper);
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
