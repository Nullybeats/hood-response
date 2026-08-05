import { logHttpFailure, logRpcThrow } from './rpcLog.js';

/**
 * One HyperSync client, shared.
 *
 * There were two independent implementations — `chain/shadow.ts` and
 * `pons/watch.ts` — each with its own height call, query call and pagination
 * loop. Two copies of a pagination contract is two chances to get `next_block`
 * wrong, and getting it wrong is silent: the query returns fewer blocks than it
 * was asked for and the caller reads the shortfall as a quiet chain.
 *
 * The pagination loop below is lifted VERBATIM from shadow.ts, which is the one
 * that was field-verified. Measured on this chain: a swap-log query over 1000
 * blocks stopped at 261 while a transfer query over the same range covered all
 * 1000. `covered` is therefore returned alongside the logs and is the ONLY
 * value a caller may treat as scanned.
 *
 * Two tokens stay deliberately separate (see config/env.ts): the feed's shadow
 * hammers HyperSync with paginated sweeps, and sharing a token would draw down
 * the quota the box's Pons watcher depends on.
 */

export interface HsLog {
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  data?: string;
  block_number?: number;
  transaction_hash?: string;
  address?: string;
  log_index?: number;
}

export interface HsBlock {
  number?: number;
  timestamp?: string | number;
  /** Arbitrum-style L1 clock. Pons' entry gate is measured in these. */
  l1_block_number?: number;
}

export interface HsTransaction {
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
  input?: string;
  status?: number;
  block_number?: number;
}

/**
 * HyperSync's reorg primitive, verified present on this chain 2026-08-05.
 *
 *   first_block_number / first_parent_hash — lets a caller prove the page joins
 *     onto the chain it last checkpointed. A mismatch IS a reorg.
 *   block_number / hash — the new checkpoint to persist.
 *
 * Without this, a durable cursor is only a promise that we read some blocks; it
 * says nothing about whether those blocks are still on the canonical chain.
 */
export interface RollbackGuard {
  block_number?: number;
  hash?: string;
  timestamp?: number;
  first_block_number?: number;
  first_parent_hash?: string;
}

export interface HsResponse {
  data?: { blocks?: HsBlock[]; logs?: HsLog[]; transactions?: HsTransaction[] }[];
  next_block?: number;
  archive_height?: number;
  rollback_guard?: RollbackGuard;
}

/** Result of a fully-paginated sweep. `covered` may be < `to` on failure. */
export interface SweepResult<T> {
  items: T[];
  /**
   * The block through which this sweep is genuinely complete.
   *
   * Observations may be recorded ONLY up to here, and coverage may never be
   * claimed beyond here. A partial query contributes what it returned and
   * nothing more.
   */
  covered: number;
  pages: number;
  /** True when the sweep stopped early — the caller must not treat the
   *  remainder as empty. */
  truncated: boolean;
  /** Continuity/checkpoint data from the LAST page, when the source supplies it. */
  guard: RollbackGuard | null;
  /** Continuity data from the FIRST page — what must join onto our checkpoint. */
  firstGuard: RollbackGuard | null;
}

export interface HyperSyncFailure {
  op: string;
  range: string;
  kind: 'http' | 'transport';
  status?: number;
  detail?: string;
}

export interface HyperSyncOptions {
  url: string;
  token: string;
  /** Prefix for log lines, e.g. 'shadow' or 'pons'. */
  op: string;
  /** Called on every failure, so a caller can record it in a ledger as well as
   *  log it. Never throws into the client. */
  onFailure?: (f: HyperSyncFailure) => void;
  /** Page cap per sweep — a runaway-loop backstop, not a coverage limit. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 40;

export class HyperSyncClient {
  private readonly url: string;
  private readonly token: string;
  private readonly op: string;
  private readonly onFailure?: (f: HyperSyncFailure) => void;
  private readonly maxPages: number;
  /** Cumulative page count, for metrics. */
  pagesFetched = 0;

  constructor(opts: HyperSyncOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.op = opts.op;
    this.onFailure = opts.onFailure;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /** False when no token is configured. HyperSync answers 401 without one, and
   *  the old `!res.ok → null` handling turned that into "0 logs" — an
   *  unauthenticated client would manufacture a confident zero. */
  get enabled(): boolean {
    return this.url.length > 0 && this.token.length > 0;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.token}` };
  }

  private fail(f: HyperSyncFailure): void {
    try {
      this.onFailure?.(f);
    } catch {
      // A failure sink must never break the fetch path.
    }
  }

  async height(): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.url}/height`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logHttpFailure({ op: `${this.op}-height`, url: this.url }, res.status, res.statusText);
        this.fail({ op: `${this.op}-height`, range: '', kind: 'http', status: res.status });
        return null;
      }
      const j = (await res.json()) as { height?: number };
      return typeof j.height === 'number' ? j.height : null;
    } catch (err) {
      logRpcThrow({ op: `${this.op}-height`, url: this.url }, err);
      this.fail({ op: `${this.op}-height`, range: '', kind: 'transport', detail: String(err) });
      return null;
    }
  }

  /** One raw query. Callers needing full coverage must use {@link sweep}. */
  async query(body: unknown, range = ''): Promise<HsResponse | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.url}/query`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        logHttpFailure({ op: `${this.op}-query`, url: this.url, range }, res.status, res.statusText);
        this.fail({ op: `${this.op}-query`, range, kind: 'http', status: res.status });
        return null;
      }
      return (await res.json()) as HsResponse;
    } catch (err) {
      logRpcThrow({ op: `${this.op}-query`, url: this.url, range }, err);
      this.fail({ op: `${this.op}-query`, range, kind: 'transport', detail: String(err) });
      return null;
    }
  }

  /**
   * Paginate `[from, to)` to completion, following `next_block`.
   *
   * Returns what was genuinely covered. A caller that advances a cursor past
   * `covered` marks blocks as scanned whose contents were never fetched — the
   * exact failure this returns `covered` to prevent.
   */
  async sweep(
    from: number,
    to: number,
    body: Record<string, unknown>,
    extract: (r: HsResponse) => HsLog[] | HsBlock[] | HsTransaction[],
  ): Promise<SweepResult<HsLog | HsBlock | HsTransaction> | null> {
    if (!this.enabled) return null;
    const out: (HsLog | HsBlock | HsTransaction)[] = [];
    let cur = from;
    let pages = 0;
    let guard: RollbackGuard | null = null;
    let firstGuard: RollbackGuard | null = null;
    while (cur < to && pages < this.maxPages) {
      const r = await this.query({ ...body, from_block: cur, to_block: to }, `${cur}-${to}`);
      if (!r) {
        // Partial coverage is still coverage; report exactly how far we got.
        return pages > 0
          ? { items: out, covered: cur, pages, truncated: true, guard, firstGuard }
          : null;
      }
      if (r.rollback_guard) {
        if (firstGuard === null) firstGuard = r.rollback_guard;
        guard = r.rollback_guard;
      }
      // Spread would blow the stack on a large page; measured at ~200k logs.
      for (const item of extract(r)) out.push(item);
      pages += 1;
      this.pagesFetched += 1;
      // No forward progress means the endpoint cannot serve this range; stop
      // rather than spin, and report only what was genuinely covered.
      if (typeof r.next_block !== 'number' || r.next_block <= cur) {
        return { items: out, covered: Math.min(cur, to), pages, truncated: cur < to, guard, firstGuard };
      }
      cur = r.next_block;
    }
    const covered = Math.min(cur, to);
    return { items: out, covered, pages, truncated: covered < to, guard, firstGuard };
  }

  /** Sweep returning logs, the common case. */
  async sweepLogs(
    from: number,
    to: number,
    logs: unknown[],
    fields: string[] = ['topic0', 'topic1', 'topic2', 'block_number', 'transaction_hash', 'address'],
  ): Promise<SweepResult<HsLog> | null> {
    const r = await this.sweep(
      from,
      to,
      { logs, field_selection: { log: fields } },
      (res) => (res.data ?? []).flatMap((d) => d.logs ?? []),
    );
    return r as SweepResult<HsLog> | null;
  }
}
