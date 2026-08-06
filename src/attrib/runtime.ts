import { config } from '../config/env.js';
import { addressToTopic } from '../chain/decoder.js';
import { V3_SWAP_TOPIC } from '../chain/receipt.js';
import { logHttpFailure, logRpcError, logRpcThrow, rpcHost } from '../chain/rpcLog.js';
import { HyperSyncClient, type HyperSyncFailure } from '../chain/hypersync.js';
import { logger } from '../logger.js';
import { finalityStatus } from './finality.js';
import { Ingester, type Enricher, type EnrichedTx, type PairObservation } from './ingest.js';
import { AttributionLedger } from './ledger.js';
import { observeUniverse } from './observe.js';
import { PoolVerifier, makeEthCall } from './poolVerify.js';
import { buildReport, type AccountingReport } from './report.js';
import { schedulerFor } from './scheduler.js';
import { CLASSIFIER_VERSION, type Evidence, type FailureCategory } from './taxonomy.js';

/**
 * The attribution runtime is deliberately a SHADOW service.  It has a durable
 * ledger and its own cursors, but it does not receive or emit SwapEvents and is
 * never consulted by the live listener, aggregator, alert engine, or sniper.
 */
export class AttributionShadow {
  readonly ledger = new AttributionLedger();
  private readonly verifier = new PoolVerifier(makeEthCall(config.CHAIN_HTTP_URL));
  private readonly hs = new HyperSyncClient({
    url: config.FEED_HYPERSYNC_URL,
    token: config.FEED_HYPERSYNC_TOKEN,
    op: 'attrib',
    onFailure: (failure) => this.recordHyperSyncFailure(failure),
  });
  private readonly ingester = new Ingester({
    ledger: this.ledger,
    verifier: this.verifier,
    enrich: (txHash, wallet) => this.enrich(txHash, wallet),
    sourceHost: config.CHAIN_HTTP_URL,
  });
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private observedHead: number | null = null;
  private lastWindow: { from: number; to: number } | null = null;
  private lastError: string | null = null;
  private lastTickAt: number | null = null;

  constructor(private readonly watchedWallets: string[]) {}

  get enabled(): boolean {
    return config.ATTRIB_ENABLED && !this.ledger.degraded && this.hs.enabled;
  }

  start(): void {
    if (!config.ATTRIB_ENABLED) {
      logger.info('attrib: shadow runtime disabled (set ATTRIB_ENABLED=true to enable)');
      return;
    }
    if (this.ledger.degraded || !this.hs.enabled) {
      logger.warn(
        { ledgerDegraded: this.ledger.degraded, hypersyncEnabled: this.hs.enabled },
        'attrib: shadow runtime not started — ledger path or HyperSync token missing',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), config.ATTRIB_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
    logger.info(
      { host: rpcHost(config.FEED_HYPERSYNC_URL), wallets: this.watchedWallets.length },
      'attrib: shadow runtime started (measurement only)',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ledger.close();
  }

  status(): Record<string, unknown> {
    const safe = this.ledger.safeCursor();
    return {
      enabled: this.enabled,
      degraded: this.ledger.degraded,
      running: this.running,
      observedHead: this.observedHead,
      safeCursor: safe,
      cursorLag: this.observedHead != null && safe != null ? Math.max(0, this.observedHead - safe) : null,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      accounting: this.ledger.accountedFor(CLASSIFIER_VERSION),
      pools: this.ledger.poolVerificationStats(),
    };
  }

  report(): AccountingReport | { enabled: false; reason: string } {
    if (!this.enabled || this.observedHead == null || this.lastWindow == null) {
      return { enabled: false, reason: this.ledger.degraded ? 'ledger disabled' : 'shadow has not completed a window' };
    }
    const finality = finalityStatus(this.ledger, this.observedHead);
    const report = buildReport({
      ledger: this.ledger,
      finality,
      traceMatrix: [], // The configured public RPC is known trace-unavailable; a future trace source is probed separately.
      traceRows: this.ledger.traceGapRows(CLASSIFIER_VERSION, this.lastWindow.from, this.lastWindow.to).flatMap((row) => {
        try {
          return [{ evidence: JSON.parse(row.evidence_json) as Evidence, liveEmitted: row.liveEmitted === 1 }];
        } catch {
          return [];
        }
      }),
      fromBlock: this.lastWindow.from,
      toBlock: this.lastWindow.to,
      liveEmitted: this.ledger.liveEmittedCount(this.lastWindow.from, this.lastWindow.to),
      poolStats: this.verifier.stats(),
    });
    // The classifier can represent verified V4 evidence, but this first
    // runtime only obtains V3 pool proofs.  Keep that distinction visible in
    // every report until PoolManager/Initialize provenance is wired here.
    report.scope += '; verified-pool confirmation: V3 only in this runtime';
    report.caveats.push(
      'V4 PoolManager/Initialize provenance is not wired into this runtime yet. V4 activity may be observed, but cannot become `confirmed_trade` here.',
    );
    return report;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      const head = await this.hs.height();
      if (head == null) return;
      this.observedHead = head;
      const existing = this.ledger.safeCursor();
      const from = existing ?? Math.max(0, head - config.ATTRIB_INITIAL_BACKFILL_BLOCKS);
      const to = Math.min(head + 1, from + config.ATTRIB_INITIAL_BACKFILL_BLOCKS);
      if (to <= from) return;

      const universe = await observeUniverse(
        this.hs,
        this.ledger,
        new Set(this.watchedWallets.map((w) => w.toLowerCase())),
        from,
        to,
      );
      if (universe.safeCovered <= from) return;

      // Never classify the part of a range where any required observation
      // stream fell short.  Earlier drift/pending pairs are retried when they
      // are inside the same safe prefix.
      const work = this.ledger
        .unsettledObservations(CLASSIFIER_VERSION, config.ATTRIB_BATCH_SIZE, universe.safeCovered)
        .map((o) => o as PairObservation);
      const settled = await this.ingester.ingestBatch(work, universe.safeCovered);
      this.lastWindow = { from, to: universe.safeCovered };
      this.lastTickAt = Date.now();
      logger.info(
        {
          from,
          to: universe.safeCovered,
          observed: work.length,
          attributed: settled.attributed,
          pending: settled.pending,
          safeThrough: settled.safeThroughBlock,
        },
        'attrib: shadow sweep complete',
      );
    } catch (err) {
      this.lastError = String(err).slice(0, 200);
      logger.error({ err: this.lastError }, 'attrib: shadow tick failed');
    } finally {
      this.running = false;
    }
  }

  private recordHyperSyncFailure(failure: HyperSyncFailure): void {
    const range = failure.range.split('-').map((x) => Number(x));
    const from = range[0];
    const to = range[1];
    this.ledger.recordFailure({
      operation: failure.op,
      fromBlock: typeof from === 'number' && Number.isFinite(from) ? from : null,
      toBlock: typeof to === 'number' && Number.isFinite(to) ? to : null,
      sourceUrl: config.FEED_HYPERSYNC_URL,
      kind: failure.kind === 'http' ? 'rpc_http_error' : 'rpc_transport_error',
      detail: failure.status != null ? `http ${failure.status}` : failure.detail ?? 'transport failure',
    });
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<{ ok: true; value: T } | { ok: false; kind: FailureCategory; detail: string }> {
    const url = config.CHAIN_HTTP_URL;
    const sched = schedulerFor(url);
    try {
      return await sched.run(async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        const ctx = { op: 'attrib-enrich', url, method };
        if (!res.ok) {
          logHttpFailure(ctx, res.status, res.statusText);
          if (res.status === 429 || res.status === 503) sched.penalise(1000);
          return { ok: false as const, kind: 'rpc_http_error' as const, detail: `http ${res.status}` };
        }
        const body = (await res.json()) as { result?: T; error?: unknown };
        if (body.error) {
          logRpcError(ctx, body.error);
          return { ok: false as const, kind: 'rpc_jsonrpc_error' as const, detail: 'json-rpc error' };
        }
        return { ok: true as const, value: body.result as T };
      });
    } catch (err) {
      logRpcThrow({ op: 'attrib-enrich', url, method }, err);
      return { ok: false, kind: 'rpc_transport_error', detail: String(err).slice(0, 160) };
    }
  }

  private async enrich(txHash: string, wallet: string): ReturnType<Enricher> {
    type RawLog = { address?: string; topics?: string[]; data?: string; logIndex?: string | number };
    type RawReceipt = { status?: string; blockNumber?: string; logs?: RawLog[] } | null;
    type RawTx = { from?: string; to?: string | null; input?: string; value?: string; blockNumber?: string } | null;
    const [receipt, tx] = await Promise.all([
      this.rpc<RawReceipt>('eth_getTransactionReceipt', [txHash]),
      this.rpc<RawTx>('eth_getTransactionByHash', [txHash]),
    ]);
    if (!receipt.ok) return receipt;
    if (!tx.ok) return tx;
    if (!receipt.value || !tx.value || !Array.isArray(receipt.value.logs)) {
      return { ok: false, kind: 'receipt_missing', detail: 'transaction or receipt unavailable' };
    }
    const logs = receipt.value.logs.map((l, index) => ({
      address: (l.address ?? '').toLowerCase(),
      topic0: l.topics?.[0]?.toLowerCase() ?? null,
      topic1: l.topics?.[1]?.toLowerCase() ?? null,
      topic2: l.topics?.[2]?.toLowerCase() ?? null,
      topic3: l.topics?.[3]?.toLowerCase() ?? null,
      data: l.data ?? null,
      logIndex: typeof l.logIndex === 'string' ? Number.parseInt(l.logIndex, 16) : l.logIndex ?? index,
    }));
    const candidatePools = logs
      .filter((l) => l.topic0 === V3_SWAP_TOPIC && l.address)
      .map((l) => l.address);
    const blockNumber = Number.parseInt(receipt.value.blockNumber ?? tx.value.blockNumber ?? '0x0', 16);
    const value: EnrichedTx = {
      tx: {
        txHash,
        blockNumber,
        blockTimestamp: null,
        txFrom: tx.value.from?.toLowerCase() ?? null,
        txTo: tx.value.to?.toLowerCase() ?? null,
        selector: tx.value.input?.slice(0, 10).toLowerCase() ?? null,
        nativeValueWei: tx.value.value ?? null,
        receiptStatus: receipt.value.status ?? null,
        receiptJson: JSON.stringify(receipt.value),
        sourceHost: rpcHost(config.CHAIN_HTTP_URL),
      },
      ctx: {
        txHash,
        logs,
        wallet: wallet.toLowerCase(),
        walletTopic: addressToTopic(wallet).toLowerCase(),
        txTo: tx.value.to?.toLowerCase() ?? null,
        selector: tx.value.input?.slice(0, 10).toLowerCase() ?? null,
        nativeValueWei: tx.value.value ?? null,
        receiptStatus: receipt.value.status ?? null,
      },
      candidatePools,
    };
    return { ok: true, value };
  }
}
