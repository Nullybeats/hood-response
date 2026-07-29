import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { MemoryStore } from '../store/memory.js';
import { recordWalletUpsert, recordWalletRemove } from '../store/walletOverrides.js';
import type { AlertEngine } from '../engine/alertEngine.js';
import type { Aggregator } from '../engine/aggregator.js';
import type { PerformanceTracker } from '../engine/performance.js';
import type { SniperRegistry } from '../sniper/registry.js';
import { configuredChannels, dispatch } from '../notify/index.js';
import type { Alert, AlertRule, Swarm, SwapEvent, WalletCategory } from '../types.js';
import { DASHBOARD_HTML } from './dashboard.js';

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
  kinds: z.string().optional(),
});

export async function buildServer(
  store: MemoryStore,
  engine: AlertEngine,
  aggregator: Aggregator,
  performance?: PerformanceTracker,
  sniper?: SniperRegistry,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    mode: store.metrics.mode,
    wsConnected: store.metrics.wsConnected,
    lastBlock: store.metrics.lastBlock,
    rpcLatencyMs: store.metrics.rpcLatencyMs,
    totals: store.totals,
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
    const showAddr =
      config.ADMIN_PASSWORD.length === 0 || req.headers['x-admin-password'] === config.ADMIN_PASSWORD;
    return wallets.map(({ address, ...w }) => ({
      ...w,
      address: showAddr ? address : undefined,
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
  // endpoints can't be hit without it. Empty ADMIN_PASSWORD disables the gate.
  const adminOk = (req: { headers: Record<string, unknown>; query?: unknown }): boolean => {
    if (config.ADMIN_PASSWORD.length === 0) return true;
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
    engine.updateSettings({ enabled: !engine.settings.enabled });
    return engine.snapshot();
  });
  // Set the hot-wallet key in-app (memory only; never persisted or echoed back).
  app.post('/api/sniper/wallet', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const pk = (req.body as { privateKey?: string } | undefined)?.privateKey;
    if (!pk || typeof pk !== 'string') return reply.code(400).send({ error: 'privateKey required' });
    try {
      const engine = await sniper.get(userIdOf(req));
      const address = engine.setPrivateKey(pk);
      logger.info({ owner: engine.owner, address }, 'sniper: wallet key set in-app');
      return { ok: true, address };
    } catch {
      return reply.code(400).send({ error: 'invalid private key' });
    }
  });
  // Manual "sell now" for an open position (before take-profit is reached).
  app.post('/api/sniper/sell/:id', async (req, reply) => {
    if (!adminOk(req)) return denyAdmin(reply);
    if (!sniper) return reply.code(503).send({ error: 'sniper not available' });
    const id = (req.params as { id: string }).id;
    try {
      const engine = await sniper.get(userIdOf(req));
      const pos = await engine.sellNow(id);
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
    return store.recentSwaps(limit).map(redactSwap);
  });
  app.get('/api/swarms', async (req) => {
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return store.recentSwarms(limit).map(redactSwarm);
  });
  app.get('/api/alerts', async (req) => {
    const limit = clampLimit((req.query as { limit?: string }).limit);
    return store.recentAlerts(limit).map(redactAlert);
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
    const onSwap = (e: SwapEvent) => send('swap')(redactSwap(e));
    const onSwarm = (s: Swarm) => send('swarm')(redactSwarm(s));
    const onAlert = (a: Alert) => send('alert')(redactAlert(a));
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
