import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { TRANSFER_TOPIC, addressToTopic } from './decoder.js';
import { V3_SWAP_TOPIC, V4_SWAP_TOPIC } from './receipt.js';
import { classifyCandidate, emptyTally, type CandidateClass, type TxLog } from './classify.js';
import { logHttpFailure, logRpcThrow, rpcHost } from './rpcLog.js';

/**
 * HyperSync SHADOW listener — measures, never acts.
 *
 * Its only purpose is to answer a question the live listener cannot answer about
 * itself: of the tracked-wallet transfers on this chain, how many are genuine DEX
 * swaps, how many are liquidity/airdrop/plain movement, and how many real swaps
 * is the live listener missing?
 *
 * STRICTLY SIDE-EFFECT-FREE. It does not emit swaps, touch the aggregator, write
 * to MemoryStore, or influence detection, alerts, or the sniper in any way. It
 * holds counters and a bounded sample of transaction hashes, and nothing else.
 * If this class were deleted mid-run, production behaviour would be identical.
 *
 * Inert without a token: no FEED_HYPERSYNC_TOKEN, no queries at all. HyperSync
 * began requiring auth [verified 2026-08-05: /query answers 401 unauthenticated],
 * and — because the old code returned null on !res.ok — an unauthenticated probe
 * reported "0 logs" rather than "unauthorized". Reading absence as data is the
 * exact failure this whole exercise exists to stop, so a missing token disables
 * the shadow loudly instead of producing a confident zero.
 */

interface HsLog {
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  block_number?: number;
  transaction_hash?: string;
  address?: string;
}
interface HsResponse {
  data?: { logs?: HsLog[] }[];
  next_block?: number;
}

export interface ShadowStats {
  enabled: boolean;
  /** Blocks fully covered so far, and how far behind the chain tip that is. */
  cursor: number;
  head: number;
  cursorLag: number;
  /** Raw tracked-wallet Transfer logs seen. */
  rawTransfers: number;
  /** Classification of those transfers — see chain/classify.ts. */
  byClass: Record<CandidateClass, number>;
  /** Per-source failures, so a quiet result is never mistaken for a quiet chain. */
  failures: { height: number; query: number };
  pagesFetched: number;
  startedAt: number | null;
  lastTickAt: number | null;
  /** Bounded sample of tx hashes per class, for manual spot-checking. */
  samples: Record<CandidateClass, string[]>;
}

const SAMPLE_CAP = 25;
/** Blocks per tick. HyperSync paginates; this only bounds the ask. */
const WINDOW = 500;

export class HyperSyncShadow {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor = 0;
  private head = 0;
  private rawTransfers = 0;
  private pagesFetched = 0;
  private startedAt: number | null = null;
  private lastTickAt: number | null = null;
  private readonly byClass = emptyTally();
  private readonly failures = { height: 0, query: 0 };
  private readonly samples: Record<CandidateClass, string[]> = {
    'swap-cooccurrence': [],
    liquidity: [],
    airdrop: [],
    'plain-transfer': [],
  };
  private walletTopics: string[] = [];

  constructor(private readonly walletAddresses: string[]) {}

  get enabled(): boolean {
    return config.FEED_HYPERSYNC_TOKEN.length > 0 && config.FEED_HYPERSYNC_URL.length > 0;
  }

  start(): void {
    if (!config.FEED_SHADOW_ENABLED) return;
    if (!this.enabled) {
      // Loud, not silent: a disabled shadow must never be mistaken for a shadow
      // that ran and found nothing.
      logger.warn(
        { host: rpcHost(config.FEED_HYPERSYNC_URL) },
        'shadow: FEED_HYPERSYNC_TOKEN is unset — shadow listener DISABLED (HyperSync requires auth)',
      );
      return;
    }
    this.walletTopics = this.walletAddresses.map(addressToTopic).map((t) => t.toLowerCase());
    this.startedAt = Date.now();
    logger.info(
      { host: rpcHost(config.FEED_HYPERSYNC_URL), wallets: this.walletTopics.length },
      'shadow: HyperSync shadow listener started (measures only, emits nothing)',
    );
    this.timer = setInterval(() => void this.tick(), config.FEED_SHADOW_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats(): ShadowStats {
    return {
      enabled: this.enabled && config.FEED_SHADOW_ENABLED,
      cursor: this.cursor,
      head: this.head,
      cursorLag: this.head > this.cursor ? this.head - this.cursor : 0,
      rawTransfers: this.rawTransfers,
      byClass: { ...this.byClass },
      failures: { ...this.failures },
      pagesFetched: this.pagesFetched,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      samples: {
        'swap-cooccurrence': [...this.samples['swap-cooccurrence']],
        liquidity: [...this.samples.liquidity],
        airdrop: [...this.samples.airdrop],
        'plain-transfer': [...this.samples['plain-transfer']],
      },
    };
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${config.FEED_HYPERSYNC_TOKEN}`,
    };
  }

  private async height(): Promise<number | null> {
    try {
      const res = await fetch(`${config.FEED_HYPERSYNC_URL}/height`, {
        headers: { authorization: `Bearer ${config.FEED_HYPERSYNC_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.failures.height += 1;
        logHttpFailure(
          { op: 'shadow-height', url: config.FEED_HYPERSYNC_URL },
          res.status,
          res.statusText,
        );
        return null;
      }
      const j = (await res.json()) as { height?: number };
      return typeof j.height === 'number' ? j.height : null;
    } catch (err) {
      this.failures.height += 1;
      logRpcThrow({ op: 'shadow-height', url: config.FEED_HYPERSYNC_URL }, err);
      return null;
    }
  }

  /**
   * Run one query to completion over [from, to), following `next_block`.
   *
   * Returns the logs AND the block the response actually reached. HyperSync
   * truncates a page on response size — [verified 2026-08-05: a swap-log query
   * over 1000 blocks stopped at 261 while the transfer query over the same range
   * covered all 1000] — so a caller that assumes full coverage silently
   * under-reports and calls it a quiet chain.
   */
  private async queryAll(
    from: number,
    to: number,
    logs: unknown[],
  ): Promise<{ logs: HsLog[]; covered: number } | null> {
    const out: HsLog[] = [];
    let cur = from;
    let pages = 0;
    while (cur < to && pages < 40) {
      let r: HsResponse;
      try {
        const res = await fetch(`${config.FEED_HYPERSYNC_URL}/query`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            from_block: cur,
            to_block: to,
            logs,
            field_selection: {
              log: ['topic0', 'topic1', 'topic2', 'block_number', 'transaction_hash', 'address'],
            },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          this.failures.query += 1;
          logHttpFailure(
            { op: 'shadow-query', url: config.FEED_HYPERSYNC_URL, range: `${cur}-${to}` },
            res.status,
            res.statusText,
          );
          return pages > 0 ? { logs: out, covered: cur } : null;
        }
        r = (await res.json()) as HsResponse;
      } catch (err) {
        this.failures.query += 1;
        logRpcThrow(
          { op: 'shadow-query', url: config.FEED_HYPERSYNC_URL, range: `${cur}-${to}` },
          err,
        );
        return pages > 0 ? { logs: out, covered: cur } : null;
      }

      out.push(...(r.data ?? []).flatMap((d) => d.logs ?? []));
      pages += 1;
      this.pagesFetched += 1;
      // No forward progress means the endpoint cannot serve this range; stop
      // rather than spin, and report only what was genuinely covered.
      if (typeof r.next_block !== 'number' || r.next_block <= cur) break;
      cur = r.next_block;
    }
    return { logs: out, covered: Math.min(cur, to) };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const head = await this.height();
      if (head == null) return;
      this.head = head;
      if (this.cursor === 0) this.cursor = Math.max(0, head - WINDOW);
      if (this.cursor >= head) return;

      const from = this.cursor;
      const to = Math.min(head, from + WINDOW);

      // Two independent queries. Each paginates on its own and can reach a
      // DIFFERENT block — which is exactly why the cursor below takes the MINIMUM.
      const transfers = await this.queryAll(from, to, [
        { topics: [[TRANSFER_TOPIC], [], [...this.walletTopics]] },
        { topics: [[TRANSFER_TOPIC], [...this.walletTopics], []] },
      ]);
      if (!transfers) return;
      const context = await this.queryAll(from, to, [{}]);
      if (!context) return;

      // THE CURSOR RULE. Advance only through the range EVERY query safely
      // covered. Advancing on the furthest would mark blocks scanned whose
      // swap/liquidity context was never fetched, producing candidates that
      // cannot be classified and silently mislabelling them.
      const covered = Math.min(transfers.covered, context.covered);
      if (covered <= from) return;

      // Group the context logs by transaction, once.
      const byTx = new Map<string, TxLog[]>();
      for (const l of context.logs) {
        if (!l.transaction_hash) continue;
        if ((l.block_number ?? 0) >= covered) continue;
        const arr = byTx.get(l.transaction_hash);
        if (arr) arr.push(l);
        else byTx.set(l.transaction_hash, [l]);
      }

      for (const t of transfers.logs) {
        if ((t.block_number ?? 0) >= covered) continue; // outside the safe range
        if (!t.transaction_hash) continue;
        const to2 = (t.topic2 ?? '').toLowerCase();
        const from2 = (t.topic1 ?? '').toLowerCase();
        const incomingTopic = this.walletTopics.find((w) => w === to2);
        const outgoingTopic = this.walletTopics.find((w) => w === from2);
        const walletTopic = incomingTopic ?? outgoingTopic;
        if (!walletTopic) continue; // not ours; the filter is server-side but be strict

        this.rawTransfers += 1;
        const cls = classifyCandidate({
          txLogs: byTx.get(t.transaction_hash) ?? [],
          walletTopic,
          incoming: !!incomingTopic,
        });
        this.byClass[cls] += 1;
        const bucket = this.samples[cls];
        if (bucket.length < SAMPLE_CAP) bucket.push(t.transaction_hash);
      }

      this.cursor = covered;
      this.lastTickAt = Date.now();
    } finally {
      this.running = false;
    }
  }
}

/** Topics re-exported so the shadow's evidence set is greppable from one place. */
export const SHADOW_SWAP_TOPICS = [V3_SWAP_TOPIC, V4_SWAP_TOPIC];
