import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { config } from '../config/env.js';
import { ponsDecisions, ponsJournalSummary } from '../pons/journal.js';
import { paperOpen, paperClosed, paperSummary } from '../pons/paper.js';
import { logger } from '../logger.js';
import type { MemoryStore } from '../store/memory.js';
import { recordWalletUpsert, recordWalletRemove } from '../store/walletOverrides.js';
import type { AlertEngine } from '../engine/alertEngine.js';
import type { Aggregator } from '../engine/aggregator.js';
import type { PerformanceTracker } from '../engine/performance.js';
import type { SniperRegistry } from '../sniper/registry.js';
import type { HyperSyncShadow } from '../chain/shadow.js';
import type { AttributionShadow } from '../attrib/runtime.js';
import { liveTradeShadowTally } from '../chain/liveTradeVerifier.js';
import type { V2Shadow } from '../v2/runtime.js';
import { DEFAULT_LANES, describeCondition } from '../v2/lanes.js';
import { addressOfPrivateKey } from '../sniper/executor.js';
import type { PriceOracle } from '../chain/price.js';
import { configuredChannels, dispatch } from '../notify/index.js';
import { walletId } from '../walletId.js';
import type { Alert, AlertRule, Swarm, SwapEvent, WalletCategory } from '../types.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { DASHBOARD_V2_HTML } from './dashboardV2.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

// ── Address redaction ─────────────────────────────────────────────────────────
// Wallet addresses are never exposed on activity feeds, alerts, or the SSE
// stream. Only counts and the category makeup (walletSummary) are surfaced.
function redactSwap(s: SwapEvent): Omit<SwapEvent, 'wallet'> {
  const { wallet: _wallet, ...rest } = s;
  return rest;
}
function redactSwarm(s: Swarm): Omit<Swarm, 'wallets'> {
  const { wallets: _wallets, ...rest } = s;
  return rest;
}
function redactAlert(a: Alert): Omit<Alert, 'swarm'> & { swarm: Omit<Swarm, 'wallets'> } {
  return { ...a, swarm: redactSwarm(a.swarm) };
}

const CATEGORIES: WalletCategory[] = [
  'developer',
  'vc',
  'whale',
  'market_maker',
  'influencer',
  'retail',
  'internal',
  'unknown',
];

const walletBody = z.object({
  address: z.string().regex(ADDR),
  label: z.string().min(1).max(120).default('Manual wallet'),
  category: z.enum(CATEGORIES as [WalletCategory, ...WalletCategory[]]).default('unknown'),
  tier: z.enum(['alpha', 'beta', 'chroma', 'delta']).default('delta'),
  rank: z.number().int().min(1).max(999).default(10),
  confidence: z.number().min(0).max(1).default(0.5),
  notes: z.string().max(500).optional(),
  holdsTokens: z.array(z.string()).default([]),
});

const ruleBody = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  minWallets: z.number().int().min(1).max(1000),
  windowSeconds: z.number().min(1).max(3600),
  minUsd: z.number().min(0).default(0),
  minConviction: z.number().min(0).max(100).default(0),
  cooldownSeconds: z.number().min(0).max(86400).default(120),
  maxMarketCap: z.number().min(0).optional(),
  kinds: z.array(z.enum(['BUY', 'SELL', 'ROTATION', 'SOLO', 'ENTRY'])).min(1),
  ignoredTokens: z.array(z.string()).default([]),
  ignoredWallets: z.array(z.string()).default([]),
});

const sniperSettingsBody = z.object({
  enabled: z.boolean().optional(),
  minConviction: z.number().min(0).max(100).optional(),
  maxConviction: z.number().min(0).max(100).optional(),
  buyEth: z.number().positive().optional(),
  takeProfitPct: z.number().min(0).optional(),
  trailingStopPct: z.number().min(0).max(100).optional(),
  maxRoundtripPct: z.number().min(0).max(100).optional(),
  lossCooldownMin: z.number().min(0).max(10_080).optional(),
  requireSafe: z.boolean().optional(),
  primeOnly: z.boolean().optional(),
  newCoinsOnly: z.boolean().optional(),
  recoupAtPct: z.number().min(0).optional(),
  moonbagTrailPct: z.number().min(0).max(100).optional(),
  rugGuard: z.boolean().optional(),
  rugDropPct: z.number().min(0).max(100).optional(),
  kinds: z.string().optional(),
});
const sniperModeBody = z.object({ mode: z.enum(['off', 'live']) });
// Per-position exit overrides. A positive number sets the override; null/0 clears it (→ global).
const sniperPositionConfigBody = z.object({
  stopLossPct: z.number().min(0).max(100).nullable().optional(),
  trailingStopPct: z.number().min(0).max(100).nullable().optional(),
});
// Optional { fraction } on a sell — <1 ⇒ partial sell of the remaining lot, else a full close.
const sniperSellBody = z.object({ fraction: z.number().gt(0).lte(1).optional() });

export async function buildServer(
  store: MemoryStore,
  engine: AlertEngine,
  aggregator: Aggregator,
  performance?: PerformanceTracker,
  sniper?: SniperRegistry,
  shadow?: HyperSyncShadow,
  attribution?: AttributionShadow,
  price?: PriceOracle,
  v2?: V2Shadow,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Historical signals retain the price facts known at the time they fired.
  // A current quote is deliberately a separate overlay: overwriting an old
  // unknown with today's price would falsely claim it was the entry price.
  const quoteFor = (token: string) => {
    if (!price) return { state: 'unavailable' as const, priceUsd: null, marketCap: null };
    const tracked = store.tokensByAddress.get(token.toLowerCase());
    const priceUsd = price.priceOf(token);
    const marketCap = tracked ? price.marketCap(tracked) : null;
    return {
      state: price.quoteState(token),
      priceUsd,
      marketCap,
    };
  };
  const displaySwap = (s: SwapEvent) => ({ ...redactSwap(s), quote: quoteFor(s.token) });
  const displaySwarm = (s: Swarm) => ({ ...redactSwarm(s), quote: quoteFor(s.token) });
  const displayAlert = (a: Alert) => ({ ...a, swarm: displaySwarm(a.swarm) });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    sha: process.env.GIT_SHA || 'dev', // deploy stamp — deploy/status.sh + hood.sh verify against this
    uptimeSeconds: Math.round(process.uptime()),
    mode: store.metrics.mode,
    wsConnected: store.metrics.wsConnected,
    lastBlock: store.metrics.lastBlock,
    rpcLatencyMs: store.metrics.rpcLatencyMs,
    totals: store.totals,
    // Scan health. `lastBlock` is the chain head and advances regardless of
    // whether we read it, so these are what actually say the feed is keeping
    // up: cursorLag near 0 and consecutiveFailures 0 is healthy.
    scan: {
      cursor: store.metrics.cursor,
      cursorLag: store.metrics.cursorLag,
      consecutiveFailures: store.metrics.consecutiveFailures,
      lastScanAt: store.metrics.lastScanAt,
      skippedBlocks: store.metrics.skippedBlocks,
      trackedTokens: store.tokensByAddress.size,
    },
  }));

  // ── Shadow comparison (read-only measurement, never affects detection) ─────
  // Deliberately its own endpoint rather than a field on /health: this is an
  // experiment's output, and folding it into the health contract would invite
  // treating it as production truth before it has been reviewed.
  app.get('/api/shadow', async () => {
    if (!shadow) return { enabled: false, reason: 'shadow listener not constructed' };
    const s = shadow.stats();
    const elapsedMin = s.startedAt ? (Date.now() - s.startedAt) / 60_000 : 0;
    return {
      ...s,
      elapsedMinutes: Math.round(elapsedMin * 10) / 10,
      // Named for what it measures. A V3/V4 Swap in the same transaction proves a
      // swap happened there — NOT that this transfer was the trader's purchase.
      note: 'swap-cooccurrence = a V3/V4 Swap event shares the transaction; it is evidence, not proof',
      live: { swaps: store.totals.swaps, swarms: store.totals.swarms, alerts: store.totals.alerts },
    };
  });

  // ── Attribution accounting (aggregate, measurement-only) ─────────────────
  // This endpoint intentionally exposes no tx hashes or wallet addresses. The
  // ledger is an audit tool, not a new public wallet-tracking feed; aggregate
  // numbers are enough to distinguish ingestion failure, unsupported venues,
  // and genuinely quiet wallets without deanonymising the watched set.
  app.get('/api/attrib', async () => {
    if (!attribution) return { enabled: false, reason: 'attribution shadow not constructed' };
    return {
      status: attribution.status(),
      report: attribution.report(),
      // What promoting LIVE_VERIFIED_TRADE_GATE would actually change, counted
      // rather than inferred from a log tail. `wouldSuppress` is the number the
      // promotion decision turns on.
      liveGateShadow: liveTradeShadowTally(),
    };
  });

  // ── v2 shadow: decisions, lanes, coverage ───────────────────────────────────
  // The diary is the whole point of the rebuild being observable: every leak the
  // audit found was invisible because decisions were silent, so a suppressed
  // signal looked exactly like a quiet market. These endpoints are aggregate and
  // carry no wallet addresses, matching the attribution endpoint's rule.
  app.get('/api/v2/status', async () => {
    if (!v2) return { enabled: false, reason: 'v2 shadow not constructed' };
    return v2.status();
  });

  app.get('/api/v2/decisions', async (req) => {
    if (!v2) return { enabled: false, decisions: [] };
    const q = req.query as { limit?: string; outcome?: string };
    const limit = Math.min(Number(q.limit) || 100, 500);
    const outcome = q.outcome as 'matched' | 'skipped' | 'waiting' | 'blocked' | 'observed' | undefined;
    const entries = v2.diary.recent(limit, outcome).map((e) => ({
      at: e.at,
      token: e.token,
      tokenSymbol: e.tokenSymbol,
      eventType: e.eventType ?? 'verified-buy',
      outcome: e.outcome,
      reason: e.reason,
      score: e.score,
      matchedLanes: e.matchedLanes,
      nearMiss: e.nearMiss,
      // Per-condition detail, minus anything identifying the wallet.
      lanes: e.lanes.map((l) => ({
        laneId: l.laneId,
        matched: l.matched,
        blockedByUnknown: l.blockedByUnknown,
        reason: l.reason,
      })),
    }));
    return { enabled: true, decisions: entries };
  });

  // The scoreboard: what actually happened after each lane matched.
  //
  // Until this existed the diary could say "Allocation matched MANDATE" and
  // nothing more, so every tightening question (alpha vs beta, 3h vs 48h, solo vs
  // wave) was opinion. Buckets carry `unpriced` and `lateEntryPct` alongside the
  // win rate on purpose: a bucket whose entries were all priced late is
  // systematically understating the move, and hiding that would make the
  // scoreboard the same kind of confident-and-wrong number the audit found.
  app.get('/api/v2/outcomes', async (req) => {
    const ledger = v2?.outcomes;
    if (!ledger) return { enabled: false, reason: 'v2 ledger not enabled' };
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit) || 200, 1_000);
    return {
      enabled: true,
      summary: ledger.summary(),
      // No wallet addresses, matching the rule the other aggregate endpoints follow.
      records: ledger.list(limit).map(({ wallet: _w, ...rest }) => rest),
    };
  });

  // ── Metric diagnostics ──────────────────────────────────────────────────────
  // Every number the dashboards show, WITH its freshness and a plain verdict.
  // Exists because "block – / rpc –ms / swaps 0" after a restart was
  // indistinguishable from a dead listener: values without ages cannot tell
  // "just booted" from "broken". Each entry answers: what is it, when did it
  // last move, and is that normal?
  app.get('/api/debug/metrics', async () => {
    const now = Date.now();
    const bootedAt = now - Math.round(process.uptime() * 1000);
    const m = store.metrics;
    const age = (key: string) => store.metricAgeMs(key);
    const verdict = (ageMs: number | null, staleMs: number, neverHint: string): string => {
      if (ageMs == null) return `never this boot — ${neverHint}`;
      return ageMs > staleMs ? `STALE (${Math.round(ageMs / 1000)}s old)` : 'ok';
    };

    const v2s = v2 ? (v2.status() as Record<string, unknown>) : null;
    return {
      bootedAt,
      uptimeSeconds: Math.round(process.uptime()),
      metrics: {
        wsConnected: { value: m.wsConnected, note: 'socket state only — says nothing about data flowing' },
        lastBlock: {
          value: m.lastBlock || null,
          ageMs: age('lastBlock'),
          verdict: verdict(age('lastBlock'), 30_000, 'no head/log processed yet; renders as "block –"'),
        },
        rpcLatencyMs: {
          value: m.rpcLatencyMs,
          ageMs: age('rpcLatencyMs'),
          verdict: verdict(age('rpcLatencyMs'), 120_000, 'not measured yet; renders as "rpc –ms"'),
        },
        swaps: {
          sinceBoot: store.totals.swaps,
          ageMs: age('swaps'),
          verdict: verdict(age('swaps'), 3_600_000, 'none accepted this boot — counters reset on restart'),
        },
        swarms: {
          sinceBoot: store.totals.swarms,
          restoredHistory: store.recentSwarms(500).length,
          ageMs: age('swarms'),
          note: 'dashboard lists restored history; totals count this boot only — the "swarms 40, swaps 0" confusion',
        },
        alerts: {
          sinceBoot: store.totals.alerts,
          restoredHistory: store.recentAlerts(500).length,
          ageMs: age('alerts'),
        },
      },
      price: price ? (price as unknown as { debug?: () => Record<string, unknown> }).debug?.() ?? null : null,
      v2: v2s
        ? {
            enabled: v2s.enabled,
            intake: v2s.intake,
            intakeAges: v2s.intakeAges,
            pending: v2s.pending,
            journalEnabled: v2s.journalEnabled,
            journalStopped: v2s.journalStopped,
          }
        : null,
    };
  });

  app.get('/api/v2/lanes', async () => ({
    lanes: DEFAULT_LANES.map((l) => ({
      id: l.id,
      emoji: l.emoji,
      name: l.name,
      sentence: l.sentence,
      conditions: l.conditions.map(describeCondition),
    })),
  }));

  // ── Stats / config ──────────────────────────────────────────────────────────
  app.get('/api/stats', async () => ({
    totals: store.totals,
    metrics: store.metrics,
    trackedWallets: store.wallets.size,
    trackedTokens: store.tokensByAddress.size,
    rules: store.rules.size,
    channels: configuredChannels(),
  }));

  app.get('/api/config', async () => ({
    chainMode: config.chainMode,
    chainId: config.CHAIN_ID || null,
    detectionFloor: aggregator.detectionFloor,
    maxWindowSeconds: aggregator.maxWindowSeconds,
    ignoreDustUsd: config.IGNORE_DUST_USD,
    ignoreStablecoins: config.IGNORE_STABLECOINS,
    channels: configuredChannels(),
    persistence: { database: config.hasDatabase, redis: config.hasRedis },
    dexscreenerChain: config.DEXSCREENER_CHAIN || null,
    explorerBase: config.EXPLORER_BASE.replace(/\/$/, ''),
    sigmaRef: config.SIGMA_REF || null,
    basedRef: config.BASED_REF || null,
  }));

  // ── Tokens ──────────────────────────────────────────────────────────────────
  app.get('/api/tokens', async () => {
    return [...store.tokensByAddress.values()].map((t) => ({
      ...t,
      stats: store.tokenStats.get(t.address) ?? null,
    }));
  });

  // ── Wallets ──────────────────────────────────────────────────────────────────
  app.get('/api/wallets', async (req) => {
    const { category, tier } = req.query as { category?: string; tier?: string };
    let wallets = [...store.wallets.values()];
    if (category) wallets = wallets.filter((w) => w.category === category);
    if (tier) wallets = wallets.filter((w) => w.tier === tier);
    // Address is redacted for the PUBLIC list; the authenticated admin (the cipherfi
    // wallet-manager) gets it so it can identify wallets to retier/remove.
    // Same rule as adminOk: an unconfigured password must not reveal addresses to everyone.
    const showAddr =
      config.ADMIN_PASSWORD.length > 0 && req.headers['x-admin-password'] === config.ADMIN_PASSWORD;
    return wallets.map(({ address, ...w }) => ({
      ...w,
      address: showAddr ? address : undefined,
      // Opaque stable handle — lets a consumer track one wallet across alerts without the
      // address. `label` cannot do this: it mutates with holdings and collides across wallets.
      walletId: walletId(address),
      stats: store.walletStats.get(address) ?? null,
    }));
  });

  app.get('/api/wallets/:address', async (req, reply) => {
    const address = (req.params as { address: string }).address.toLowerCase();
    const wallet = store.wallets.get(address);
    if (!wallet) return reply.code(404).send({ error: 'wallet not tracked' });
    return {
      ...wallet,
      stats: store.walletStats.get(address) ?? null,
      recentSwaps: store
        .recentSwaps(500)
        .filter((s) => s.wallet === address)
        .slice(0, 50)
        .map(redactSwap),
    };
  });

  app.post('/api/wallets', async (req, reply) => {
    const parsed = walletBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const w = { ...parsed.data, address: parsed.data.address.toLowerCase() };
    store.wallets.set(w.address, w);
    recordWalletUpsert(w); // persist so the add/retier survives a restart (seed re-runs on boot)
    return reply.code(201).send(w);
  });

  app.delete('/api/wallets/:address', async (req, reply) => {
    const address = (req.params as { address: string }).address.toLowerCase();
    const ok = store.wallets.delete(address);
    if (!ok) return reply.code(404).send({ error: 'wallet not tracked' });
    recordWalletRemove(address); // persist the removal (even of a seed wallet) across restarts
    return { deleted: address };
  });

  // ── Admin gate ──────────────────────────────────────────────────────────────
  // Admin controls (Alert Filters, Wallet Groups) sit behind a password checked
  // server-side, so the secret is never in the page source and the toggle
  // endpoints can't be hit without it.
  //
  // There is deliberately NO "empty password opens the gate" escape any more. It read as a
  // convenience and behaved as a backdoor: the worst possible value silently granted everyone
  // admin. config.ADMIN_PASSWORD is now never empty (unset → random per boot), so an unconfigured
  // deployment is locked, not open.
  const adminOk = (req: { headers: Record<string, unknown>; query?: unknown }): boolean => {
    if (config.ADMIN_PASSWORD.length === 0) return false; // unreachable by construction; fail closed anyway
    const header = req.headers['x-admin-password'];
    const fromHeader = typeof header === 'string' ? header : undefined;
    const fromQuery = (req.query as { pw?: string } | undefined)?.pw;
    return (fromHeader ?? fromQuery) === config.ADMIN_PASSWORD;
  };
  const denyAdmin = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }): unknown =>
    reply.code(401).send({ error: 'unauthorized' });

  // Which admin's sniper this request targets. cipherfi injects `x-user-id` (the
  // logged-in operator's email) after authenticating the browser; absent it we
  // fall back to the single 'default' engine (dev / direct access). Each owner
  // gets a fully independent engine + hot wallet (see SniperRegistry).
  const userIdOf = (req: { headers: Record<string, unknown> }): string => {
    const h = req.headers['x-user-id'];
    return (typeof h === 'string' && h.trim()) || 'default';
  };

  app.post('/api/admin/verify', async (req, reply) =>
    adminOk(req) ? { ok: true } : denyAdmin(reply),
  );

  // ── Muted wallet groups (turn a coin's wallets off/on at runtime) ──────────────
  const mutedState = () => {
    const muted = [...store.mutedTokens].sort();
    let mutedWalletCount = 0;
    for (const w of store.wallets.values()) {
      if (store.isWalletMuted(w.address)) mutedWalletCount += 1;
    }
    const groups = [...store.tokensBySymbol.keys()].sort();
    return { muted, mutedWalletCount, groups };
  };
  app.get('/api/muted', async (req, reply) => (adminOk(req) ? mutedState() : denyAdmin(reply)));

  // ── Pons launchpad decision journal ───────────────────────────────────────────
  // What the launchpad executor decided and why, including skips. Admin-gated like every other
  // operational surface. Read-only: it reports the journal, it never influences a trade.
  app.get('/api/pons/decisions', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    const q = req.query as { limit?: string; owner?: string };
    const limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
    return {
      dryRun: config.PONS_DRY_RUN,
      enabled: config.PONS_ENABLED,
      buyEth: config.PONS_BUY_ETH,
      maxOpen: config.PONS_MAX_OPEN,
      dailyCapEth: config.PONS_DAILY_CAP_ETH,
      summary: ponsJournalSummary(q.owner),
      decisions: ponsDecisions(limit, q.owner),
      paper: { summary: paperSummary(), open: paperOpen(), closed: paperClosed(50) },
    };
  });

  // ── Blue-chip buy/sell filter (weed out whales rotating known coins) ───────────
  const filterState = () => ({ blueChipBuys: store.blueChipBuys, blueChipSells: store.blueChipSells });
  app.get('/api/filters', async (req, reply) => (adminOk(req) ? filterState() : denyAdmin(reply)));
  app.post('/api/bluechip/buys', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    store.blueChipBuys = !store.blueChipBuys;
    logger.info({ blueChipBuys: store.blueChipBuys }, 'toggled blue-chip buys');
    void store.saveSettings();
    return filterState();
  });
  app.post('/api/bluechip/sells', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    store.blueChipSells = !store.blueChipSells;
    logger.info({ blueChipSells: store.blueChipSells }, 'toggled blue-chip sells');
    void store.saveSettings();
    return filterState();
  });
  app.post('/api/muted/:symbol', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    const sym = (req.params as { symbol: string }).symbol.toUpperCase();
    store.mutedTokens.add(sym);
    logger.info({ symbol: sym }, 'muted wallet group');
    void store.saveSettings();
    return mutedState();
  });
  app.delete('/api/muted/:symbol', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    const sym = (req.params as { symbol: string }).symbol.toUpperCase();
    store.mutedTokens.delete(sym);
    logger.info({ symbol: sym }, 'unmuted wallet group');
    void store.saveSettings();
    return mutedState();
  });

  // ── Sniper (auto-buy) — admin only, one independent hot wallet per operator ────
  // Every route resolves the caller's OWN engine from `x-user-id` (SniperRegistry),
  // so two admins run fully separate snipers — separate wallets, positions, settings.
  app.get('/api/sniper', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return { enabled: false, configured: false, positions: [] };
    const engine = await sniper.get(userIdOf(req));
    return engine.snapshot();
  });
  app.post('/api/sniper/settings', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const parsed = sniperSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const engine = await sniper.get(userIdOf(req));
    engine.updateSettings(parsed.data);
    return engine.snapshot();
  });
  app.post('/api/sniper/toggle', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const engine = await sniper.get(userIdOf(req));
    engine.setMode(engine.executionMode === 'off' ? 'live' : 'off');
    return engine.snapshot();
  });
  app.post('/api/sniper/mode', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const parsed = sniperModeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const engine = await sniper.get(userIdOf(req));
      return { ok: true, ...engine.setMode(parsed.data.mode), snapshot: await engine.snapshot() };
    } catch (err) { return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) }); }
  });
  // Enrol encrypted-at-rest key material. This does not unlock it or permit a trade.
  app.post('/api/sniper/wallet', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const body = req.body as { privateKey?: string; allowShared?: boolean } | undefined;
    const pk = body?.privateKey;
    if (!pk || typeof pk !== 'string') return reply.code(400).send({ error: 'privateKey required' });

    // Derive the address BEFORE committing anything. Two owners on one wallet share a BALANCE:
    // the per-position sell cap stops one dumping the other's lot, but both engines size their
    // buys against the same ETH, so one owner's fill silently spends what the other's sizing
    // counted on. Nothing downstream can fix that — so refuse to create it here. `allowShared`
    // is the deliberate override for an operator who really does mean it (e.g. the same person
    // on two accounts); it enrols AND announces the condition immediately.
    let address: string;
    try {
      address = addressOfPrivateKey(pk);
    } catch {
      return reply.code(400).send({ error: 'invalid private key' });
    }
    const engine = await sniper.get(userIdOf(req));
    const otherOwner = sniper.ownerOfWallet(address, engine.owner);
    if (otherOwner && !body?.allowShared) {
      logger.warn({ owner: engine.owner, address, otherOwner }, 'sniper: refused shared-wallet enrolment');
      return reply.code(409).send({
        error: 'wallet already enrolled by another operator — balances would not be isolated',
        address,
        conflictsWith: otherOwner,
        hint: 'use a separate wallet, or resend with allowShared:true to accept a shared balance',
      });
    }

    try {
      const enrolled = engine.enrollPrivateKey(pk);
      logger.info({ owner: engine.owner, address: enrolled, shared: !!otherOwner }, 'sniper: encrypted wallet key enrolled');
      if (otherOwner) sniper.announceSharedWallets(); // deliberate override — say so now, not next boot
      return { ok: true, address: enrolled, sharedWith: otherOwner ?? undefined };
    } catch {
      return reply.code(400).send({ error: 'invalid private key' });
    }
  });
  app.post('/api/sniper/unlock', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    try { const e = await sniper.get(userIdOf(req)); return { ok: true, address: e.unlockPrivateKey() }; }
    catch (err) { return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) }); }
  });
  app.post('/api/sniper/lock', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const e = await sniper.get(userIdOf(req)); e.lockPrivateKey(); return { ok: true };
  });
  app.delete('/api/sniper/wallet', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const e = await sniper.get(userIdOf(req)); e.erasePrivateKey(); return { ok: true };
  });
  // Manual "sell now" for an open position (before take-profit is reached).
  app.post('/api/sniper/sell/:id', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    const parsed = sniperSellBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid sell body' });
    const fraction = parsed.data.fraction ?? 1;
    try {
      const engine = await sniper.get(userIdOf(req));
      // fraction < 1 → manual partial sell of the remaining lot; otherwise a full close (the default).
      const pos = fraction < 1 ? await engine.sellFraction(id, fraction) : await engine.sellNow(id);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // Set a per-position take-profit override: { pct: number } to set a custom
  // value, { pct: null } to disable TP for this position, or { pct: "default" }
  // to clear the override and fall back to the global setting.
  app.post('/api/sniper/position/:id/tp', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    const b = req.body as { pct?: number | null | 'default' } | undefined;
    const pct = b?.pct === 'default' ? undefined : (b?.pct ?? null);
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = engine.setPositionTakeProfit(id, pct);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // Manual "sell initials": recoup the original stake now, flipping the position to a risk-free moonbag.
  app.post('/api/sniper/recoup/:id', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = await engine.recoupNow(id);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // Per-position exit-config override: { stopLossPct?, trailingStopPct? } (null/0 clears → global).
  app.post('/api/sniper/config/:id', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    const parsed = sniperPositionConfigBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid config body' });
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = engine.setPositionExit(id, parsed.data);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // Stop tracking a position without selling (e.g. to clear a bad import and
  // re-import cleanly). Wallet holdings are untouched.
  app.delete('/api/sniper/position/:id', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    const engine = await sniper.get(userIdOf(req));
    const ok = engine.untrack(id);
    if (!ok) return reply.code(404).send({ error: 'position not found' });
    return { ok: true };
  });
  // Recover/import a holding the wallet already has (e.g. a position lost to a
  // redeploy) so it can be sold or TP-managed in the bot.
  app.post('/api/sniper/import', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const b = req.body as { token?: string } | undefined;
    if (!b?.token || !ADDR.test(b.token)) return reply.code(400).send({ error: 'valid token address required' });
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = await engine.importPosition(b.token.toLowerCase());
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // Restore a position from a REAL buy tx hash — reads the actual ETH spent
  // and tokens received on-chain, so the entry data is exact (not re-valued).
  app.post('/api/sniper/restore', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const b = req.body as { token?: string; txHash?: string } | undefined;
    if (!b?.token || !ADDR.test(b.token)) return reply.code(400).send({ error: 'valid token address required' });
    if (!b?.txHash || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) {
      return reply.code(400).send({ error: 'valid 32-byte tx hash required' });
    }
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = await engine.restoreFromTx(b.token.toLowerCase(), b.txHash);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });
  // One controlled test buy to validate the router before trusting auto-fire.
  app.post('/api/sniper/test-buy', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const b = req.body as { token?: string; eth?: number } | undefined;
    if (!b?.token || !ADDR.test(b.token)) return reply.code(400).send({ error: 'valid token address required' });
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = await engine.testBuy(b.token.toLowerCase(), b.eth && b.eth > 0 ? b.eth : 0.0005);
      return { ok: true, position: pos };
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ── Performance / outcomes ─────────────────────────────────────────────────────
  app.get('/api/performance', async (req) => {
    const persist = { enabled: config.PERF_STORE_PATH.length > 0, path: config.PERF_STORE_PATH || null };
    if (!performance) return { enabled: false, persist, calls: [], summary: null, resetsAt: null };
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return {
      enabled: true,
      persist,
      summary: performance.summary(),
      calls: performance.list().slice(0, limit),
      resetsAt: performance.resetInfo(),
    };
  });

  // Manually clear the Best Calls tracker and start it over (also runs on its
  // own once a day — see PERF_AUTO_RESET / PERF_RESET_HOUR / PERF_RESET_TZ).
  app.post('/api/performance/reset', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!performance) return reply.code(400).send({ error: 'performance tracking disabled' });
    performance.reset();
    return { enabled: true, summary: performance.summary(), calls: performance.list(), resetsAt: performance.resetInfo() };
  });

  // CSV snapshot of every tracked call — grab this before a redeploy, since the
  // outcome data lives in memory and resets when the process restarts.
  app.get('/api/performance.csv', async (_req, reply) => {
    const cols = [
      'symbol', 'kind', 'walletCount', 'walletLabels', 'repeatCount', 'repeatWallets', 'newHolder',
      'conviction', 'entryMarketCap', 'pairAgeHours', 'entryAt', 'maxGainPct', 'lastGainPct',
      'gain1hPct', 'gain6hPct', 'gain24hPct', 'token',
    ];
    const rows = (performance?.list() ?? []).map((c) =>
      [
        c.tokenSymbol, c.kind, c.walletCount, c.walletLabels.join('|'), c.repeatCount,
        c.repeatWallets, c.newHolder, c.conviction, c.entryMarketCap, c.pairAgeHours ?? '',
        new Date(c.entryAt).toISOString(), c.maxGainPct,
        c.lastGainPct, c.gain1hPct ?? '', c.gain6hPct ?? '', c.gain24hPct ?? '', c.token,
      ]
        .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : String(v)))
        .join(','),
    );
    return reply
      .header('content-type', 'text/csv')
      .header('content-disposition', 'attachment; filename="swarm-performance.csv"')
      .send([cols.join(','), ...rows].join('\n'));
  });

  // ── Feeds ────────────────────────────────────────────────────────────────────
  app.get('/api/swaps', async (req) => {
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return store.recentSwaps(limit).map(displaySwap);
  });
  app.get('/api/swarms', async (req) => {
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return store.recentSwarms(limit).map(displaySwarm);
  });
  app.get('/api/alerts', async (req) => {
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return store.recentAlerts(limit).map(displayAlert);
  });

  // Send a sample alert to every configured channel so a new Telegram channel /
  // Discord webhook can be verified instantly instead of waiting for a real gem.
  app.post('/api/test-alert', async (_req, reply) => {
    const now = Date.now();
    const sample: Swarm = {
      id: cryptoId(),
      kind: 'BUY',
      token: '0x000000000000000000000000000000000000dead',
      tokenSymbol: 'TESTGEM',
      walletCount: 3,
      wallets: [],
      walletSummary: '2 alpha · 1 beta',
      walletLabels: ['tendies', 'hmm'],
      walletIds: ['0000000000000001', '0000000000000002'],
      totalUsd: 4200,
      marketCap: 68_000,
      newToken: false,
      dexUrl: 'https://dexscreener.com/robinhood',
      priceLive: true,
      priceUsd: 0.0042,
      liquidityUsd: 31_000,
      dex: 'uniswap',
      pairAgeHours: 3.2,
      freshPair: false,
      conviction: 74,
      convictionBreakdown: {
        walletQuality: 0,
        walletCount: 0,
        totalCapital: 0,
        velocity: 0,
        liquidity: 0,
        marketCap: 0,
        historicalAccuracy: 0,
        buySellRatio: 0,
      },
      windowSeconds: 42,
      firstSeen: now,
      lastSeen: now,
    };
    const channels = configuredChannels();
    if (channels.length === 0) {
      return reply.code(400).send({ error: 'no notification channels configured' });
    }
    const deliveries = await dispatch(sample);
    return { sent: true, channels, deliveries };
  });

  // ── Leaderboards ──────────────────────────────────────────────────────────────
  app.get('/api/leaderboard/wallets', async () => {
    return [...store.walletStats.entries()]
      .map(([address, s]) => {
        const w = store.wallets.get(address);
        return {
          walletId: walletId(address),
          label: w?.label ?? 'tracked wallet',
          category: w?.category ?? 'unknown',
          ...s,
          netUsd: s.usdIn - s.usdOut,
          activity: s.buys + s.sells,
        };
      })
      .sort((a, b) => b.activity - a.activity)
      .slice(0, 25);
  });

  app.get('/api/leaderboard/tokens', async () => {
    return [...store.tokenStats.entries()]
      .map(([address, s]) => ({
        address,
        symbol: store.tokensByAddress.get(address)?.symbol ?? null,
        ...s,
        netUsd: s.usdIn - s.usdOut,
      }))
      .sort((a, b) => b.swarms - a.swarms || b.usdIn - a.usdIn)
      .slice(0, 25);
  });

  // ── Alert rules ────────────────────────────────────────────────────────────────
  app.get('/api/rules', async () => engine.listRules());

  app.post('/api/rules', async (req, reply) => {
    const parsed = ruleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const rule: AlertRule = { ...parsed.data, id: parsed.data.id ?? cryptoId() };
    return reply.code(201).send(engine.upsertRule(rule));
  });

  app.put('/api/rules/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = ruleBody.safeParse({ ...(req.body as object), id });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return engine.upsertRule({ ...parsed.data, id });
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = engine.deleteRule(id);
    if (!ok) return reply.code(404).send({ error: 'rule not found' });
    return { deleted: id };
  });

  // ── SSE live feed ──────────────────────────────────────────────────────────────
  app.get('/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const send = (event: string) => (payload: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    // Redact wallet addresses before they leave the server over SSE.
    const onSwap = (e: SwapEvent) => send('swap')(displaySwap(e));
    const onSwarm = (s: Swarm) => send('swarm')(displaySwarm(s));
    const onAlert = (a: Alert) => send('alert')(displayAlert(a));
    const onMetrics = send('metrics');
    store.on('swap', onSwap);
    store.on('swarm', onSwarm);
    store.on('alert', onAlert);
    store.on('metrics', onMetrics);

    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(keepAlive);
      store.off('swap', onSwap);
      store.off('swarm', onSwarm);
      store.off('alert', onAlert);
      store.off('metrics', onMetrics);
    });
  });

  // ── Dashboard ────────────────────────────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    // Never let a browser/proxy cache a stale dashboard build.
    reply.header('cache-control', 'no-store').type('text/html').send(DASHBOARD_HTML);
  });

  // The v2 brain's view, served ALONGSIDE the legacy dashboard rather than
  // replacing it: the old engine is still the one on the wire, so the old view
  // stays authoritative until it isn't.
  // Browsers request /favicon.ico unconditionally; a 404 in every console
  // session reads as breakage next to real diagnostics. 204 is the quiet truth.
  app.get('/favicon.ico', async (_req, reply) => {
    reply.code(204).send();
  });

  app.get('/v2', async (_req, reply) => {
    reply.header('cache-control', 'no-store').type('text/html').send(DASHBOARD_V2_HTML);
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'request error',
    );
    reply.code(500).send({ error: 'internal error' });
  });

  return app;
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : 100;
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function cryptoId(): string {
  return 'rule_' + Math.random().toString(36).slice(2, 10);
}
