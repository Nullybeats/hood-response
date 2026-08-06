import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { redact, rpcHost } from '../chain/rpcLog.js';
import {
  FAILURE_DISPOSITION,
  OUTCOME_OF,
  type AttributionResult,
  type FailureCategory,
  type WalletDelta,
} from './taxonomy.js';

// `node:sqlite` via createRequire, not a static import.
//
// Vite (and therefore Vitest) rewrites the `node:sqlite` specifier to a bare
// `sqlite` and cannot resolve it, so ANY suite transitively importing this
// module silently collected ZERO tests and still exited 0 — the same
// absence-as-data failure this subsystem exists to remove. Mirrors the
// indirect-import trick already used for Prisma in store/persistence.ts.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/**
 * The canonical transaction ledger.
 *
 * THE UNIT OF TRUTH IS `(tx_hash, watched_wallet)`.
 *
 * `attrib_observation` records raw triggering signals — one transaction can
 * hold many, across several watched wallets. `attrib_attribution` holds exactly
 * ONE canonical outcome per `(tx, wallet, classifier_version)`. Keying the
 * verdict on a log index instead would let a single transaction carry several
 * contradictory answers for the same wallet, because a log index identifies an
 * EMISSION, not an economic action.
 *
 * SQLite/WAL following `src/sniper/state.ts` — no new dependency, and its
 * `INSERT OR IGNORE` + `changes > 0` idiom makes replaying an overlapping range
 * idempotent.
 *
 * CONSTRAINTS LIVE IN THE SCHEMA, not only in the API. A `CHECK` on outcome,
 * category, trigger source and failure disposition means a bug in calling code
 * cannot persist an impossible row, and the guarantee survives anything that
 * writes to this file without going through this class.
 */

/** Bumped when the schema changes; recorded via `PRAGMA user_version`. */
const SCHEMA_VERSION = 4;

const sqlList = (vals: string[]): string => vals.map((v) => `'${v}'`).join(',');
const OUTCOMES = sqlList([...new Set(Object.values(OUTCOME_OF))]);
const CATEGORIES = sqlList(Object.keys(OUTCOME_OF));

/**
 * How a watched wallet came to our attention in a transaction.
 *
 * Transfer logs are a DISCOVERY INDEX, not the coverage universe. Defining
 * coverage by them alone would leave pure native-ETH interactions, approvals,
 * failed calls, unusual token contracts and some launchpad flows permanently
 * invisible — and invisible is exactly what we are trying to stop.
 */
export type TriggerSource =
  | 'transfer_log'
  /** The wallet sent the transaction. Catches native-only sends and approvals. */
  | 'tx_sender'
  /** The transaction's top-level destination was the wallet. */
  | 'tx_recipient'
  /** Internal call frames named the wallet. Only where the source has traces. */
  | 'trace';

export interface ObservationKey {
  txHash: string;
  wallet: string;
}

export interface TxRecord {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number | null;
  txFrom: string | null;
  txTo: string | null;
  selector: string | null;
  nativeValueWei: string | null;
  receiptStatus: string | null;
  /** Full receipt JSON, so replay can re-classify with zero network calls. */
  receiptJson: string | null;
  sourceHost: string;
}

export interface FailureRecord {
  operation: string;
  fromBlock: number | null;
  toBlock: number | null;
  /** Reduced to its host before storage — never stored whole. */
  sourceUrl: string;
  kind: FailureCategory;
  detail: string;
  txHash?: string;
  wallet?: string;
}

export interface CoverageRow {
  outcome: string;
  category: string;
  n: number;
}

export interface AccountedFor {
  /** Distinct observed (tx, wallet) pairs — the coverage universe. */
  pairs: number;
  /** Pairs with a canonical attribution at this classifier version. */
  attributed: number;
  /** Pairs awaiting a retriable retry. Legitimately unresolved, NOT drift. */
  pending: number;
  /** pairs - attributed - pending. Non-zero means something fell through. */
  drift: number;
}

/** Canonical V4 PoolKey provenance recovered from PoolManager.Initialize. */
export interface V4PoolInitialization {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  blockNumber: number;
  logIndex: number;
  txHash: string | null;
}

/** One canonical `(tx, wallet)` observation awaiting attribution. */
export interface UnsettledObservation {
  txHash: string;
  wallet: string;
  blockNumber: number;
  logIndex: number;
  triggerSource: 'transfer_log' | 'tx_sender' | 'tx_recipient' | 'trace';
  token: string | null;
}

export class AttributionLedger {
  private readonly db: DatabaseSync | null;
  private txDepth = 0;
  /** True when persistence is OFF — surfaced so an empty ledger is never read
   *  as a quiet chain. */
  readonly degraded: boolean;

  constructor(path = config.ATTRIB_LEDGER_PATH || '') {
    if (!path) {
      this.db = null;
      this.degraded = true;
      logger.warn(
        'attrib: ledger DISABLED (set ATTRIB_LEDGER_PATH) — coverage numbers will be absent, not zero',
      );
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.degraded = false;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS attrib_tx (
        tx_hash TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        block_timestamp INTEGER,
        tx_from TEXT, tx_to TEXT, selector TEXT,
        native_value_wei TEXT, receipt_status TEXT,
        receipt_json TEXT, source_host TEXT NOT NULL,
        ingested_at INTEGER NOT NULL
      );

      -- Raw provenance: one row per triggering signal. Many rows may share a
      -- (tx_hash, wallet) pair; log_index is -1 for non-log involvement.
      CREATE TABLE IF NOT EXISTS attrib_observation (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        watched_wallet TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        trigger_source TEXT NOT NULL
          CHECK (trigger_source IN ('transfer_log','tx_sender','tx_recipient','trace')),
        token TEXT, direction_hint TEXT, raw_value TEXT,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index, watched_wallet)
      );

      -- THE canonical verdict. Exactly one per (tx, wallet, classifier_version).
      -- Append-only ACROSS versions: re-classification adds a row beside the old
      -- one, so "did that rule change help?" stays answerable.
      CREATE TABLE IF NOT EXISTS attrib_attribution (
        tx_hash TEXT NOT NULL,
        watched_wallet TEXT NOT NULL,
        classifier_version INTEGER NOT NULL,
        adapter_registry_version INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOMES})),
        category TEXT NOT NULL CHECK (category IN (${CATEGORIES})),
        evidence_json TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, watched_wallet, classifier_version)
      );

      -- Retriable work. A failed receipt fetch lands HERE, never in
      -- attrib_attribution: terminalising an infrastructure failure to zero the
      -- drift count would launder "we have not looked yet" into "we looked and
      -- found nothing". Rows are removed when the pair is attributed.
      CREATE TABLE IF NOT EXISTS attrib_pending (
        tx_hash TEXT NOT NULL,
        watched_wallet TEXT NOT NULL,
        reason TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        first_failed_at INTEGER NOT NULL,
        last_failed_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, watched_wallet)
      );

      -- What the LIVE listener emitted, for reconciliation. Written by an
      -- observer whose return value is never consumed, so it cannot alter
      -- listener control flow.
      CREATE TABLE IF NOT EXISTS attrib_emission (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        watched_wallet TEXT NOT NULL,
        direction TEXT NOT NULL,
        token TEXT, emitted_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index, watched_wallet)
      );

      CREATE TABLE IF NOT EXISTS attrib_wallet_delta (
        tx_hash TEXT NOT NULL, wallet TEXT NOT NULL, token TEXT NOT NULL,
        net_raw_delta TEXT NOT NULL, decimals INTEGER,
        -- trace_native (positive proof) and insufficient_trace_data (absence of
        -- proof) are opposites; the CHECK keeps any writer from inventing a
        -- third meaning for either.
        delta_source TEXT NOT NULL CHECK (delta_source IN
          ('erc20_logs','weth_wrap_logs','trace_native','insufficient_trace_data')),
        PRIMARY KEY (tx_hash, wallet, token)
      );

      -- The verified column records whether the emitter's protocol identity was
      -- ESTABLISHED (a pool confirmed against its factory) rather than merely
      -- matching a topic hash anyone can emit.
      CREATE TABLE IF NOT EXISTS attrib_protocol_hit (
        tx_hash TEXT NOT NULL, contract TEXT NOT NULL, event_sig TEXT NOT NULL,
        protocol_id TEXT, adapter_version INTEGER,
        verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
        PRIMARY KEY (tx_hash, contract, event_sig)
      );

      CREATE TABLE IF NOT EXISTS attrib_failure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL, from_block INTEGER, to_block INTEGER,
        source_host TEXT NOT NULL, failure_kind TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('retriable','terminal')),
        safe_detail TEXT, tx_hash TEXT, wallet TEXT, at INTEGER NOT NULL
      );

      -- Chain continuity. A cursor alone only promises we READ some blocks; it
      -- says nothing about whether those blocks are still canonical. Persisting
      -- the hash at each checkpoint is what lets a reorg be detected instead of
      -- silently inherited.
      CREATE TABLE IF NOT EXISTS attrib_checkpoint (
        stream_id TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, block_number)
      );

      CREATE TABLE IF NOT EXISTS attrib_reorg (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        at_block INTEGER NOT NULL,
        expected_hash TEXT, actual_parent_hash TEXT,
        rolled_back_to INTEGER NOT NULL,
        observations_removed INTEGER NOT NULL,
        attributions_removed INTEGER NOT NULL
      );

      -- ENRICHMENT STATE, per pair. What we have FETCHED, as distinct from what
      -- we have CONCLUDED.
      --
      -- Without this a restart cannot tell "receipt fetched, classifier ran,
      -- verdict is unknown" from "receipt never fetched" — both look like an
      -- absent attribution. The first is settled work; the second is a gap, and
      -- re-fetching the first wastes the rate limit we are trying to protect.
      CREATE TABLE IF NOT EXISTS attrib_enrichment (
        tx_hash TEXT NOT NULL,
        watched_wallet TEXT NOT NULL,
        receipt_fetched INTEGER NOT NULL DEFAULT 0 CHECK (receipt_fetched IN (0,1)),
        pools_seen INTEGER NOT NULL DEFAULT 0,
        pools_unresolved INTEGER NOT NULL DEFAULT 0,
        classifier_version INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, watched_wallet)
      );

      -- DURABLE single-flight for pool verification.
      --
      -- The in-process coalescing map dies with the process. Across a restart,
      -- a pool that was mid-verification would be requested again by every
      -- pair referencing it — the same stampede, just once per boot. This table
      -- is what makes "one queued verification per unknown pool" survive.
      --
      -- state 'pending' is NEVER a conclusion: it is cleared and retried. Only
      -- 'verified'/'unverified' are settled answers about an immutable fact.
      CREATE TABLE IF NOT EXISTS attrib_pool_verification (
        pool TEXT PRIMARY KEY,
        protocol TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending','verified','unverified')),
        reason TEXT,
        evidence_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- V4 has no per-pool contract.  Its durable provenance is the Initialize
      -- log emitted by the trusted singleton PoolManager, keyed by PoolId.
      -- Keep the block coordinate separate so a reorg removes a proof that
      -- belonged only to the discarded chain.
      CREATE TABLE IF NOT EXISTS attrib_v4_pool_initialization (
        pool_id TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        tx_hash TEXT,
        evidence_json TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attrib_cursor (
        stream_id TEXT PRIMARY KEY,
        covered_through_block INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attr_outcome ON attrib_attribution (outcome, category);
      CREATE INDEX IF NOT EXISTS idx_obs_pair ON attrib_observation (tx_hash, watched_wallet);
      CREATE INDEX IF NOT EXISTS idx_obs_block ON attrib_observation (block_number);
      CREATE INDEX IF NOT EXISTS idx_hit_sig ON attrib_protocol_hit (event_sig, verified);
      CREATE INDEX IF NOT EXISTS idx_failure_kind ON attrib_failure (failure_kind, at);
      CREATE INDEX IF NOT EXISTS idx_pool_state ON attrib_pool_verification (state);
      CREATE INDEX IF NOT EXISTS idx_v4_init_block ON attrib_v4_pool_initialization (block_number);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    logger.info({ schemaVersion: SCHEMA_VERSION }, 'attrib: ledger open');
  }

  close(): void {
    this.db?.close();
  }

  /**
   * Run a unit of work atomically. Multi-table writes must not half-apply.
   *
   * NESTING-SAFE: an inner call JOINS the outer transaction rather than opening
   * a second one (SQLite would throw) or committing early. That matters because
   * the per-pair settle wraps helpers like `recordAttribution` which are
   * themselves transactional — an inner COMMIT would publish a half-written
   * pair, which is exactly the atomicity this exists to provide.
   */
  transaction<T>(fn: () => T): T {
    if (!this.db) return fn();
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  // ── Writers ────────────────────────────────────────────────────────────────

  recordTx(tx: TxRecord): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attrib_tx
         (tx_hash, block_number, block_timestamp, tx_from, tx_to, selector,
          native_value_wei, receipt_status, receipt_json, source_host, ingested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        tx.txHash.toLowerCase(),
        tx.blockNumber,
        tx.blockTimestamp,
        tx.txFrom?.toLowerCase() ?? null,
        tx.txTo?.toLowerCase() ?? null,
        tx.selector,
        tx.nativeValueWei,
        tx.receiptStatus,
        tx.receiptJson,
        rpcHost(tx.sourceHost),
        Date.now(),
      );
  }

  /** Record a raw involvement signal. Returns true when newly claimed. */
  recordObservation(
    txHash: string,
    logIndex: number,
    wallet: string,
    blockNumber: number,
    triggerSource: TriggerSource,
    token: string | null = null,
    directionHint: string | null = null,
    rawValue: string | null = null,
  ): boolean {
    if (!this.db) return false;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO attrib_observation
         (tx_hash, log_index, watched_wallet, block_number, trigger_source, token,
          direction_hint, raw_value, first_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        txHash.toLowerCase(),
        logIndex,
        wallet.toLowerCase(),
        blockNumber,
        triggerSource,
        token?.toLowerCase() ?? null,
        directionHint,
        rawValue,
        Date.now(),
      );
    return Number(r.changes) > 0;
  }

  /**
   * Write the canonical verdict for a `(tx, wallet)` pair and clear any pending
   * retry for it, atomically — a resolved pair must never remain queued.
   */
  recordAttribution(key: ObservationKey, res: AttributionResult): void {
    if (!this.db) return;
    const tx = key.txHash.toLowerCase();
    const w = key.wallet.toLowerCase();
    this.transaction(() => {
      this.db!.prepare(
        `INSERT OR REPLACE INTO attrib_attribution
         (tx_hash, watched_wallet, classifier_version, adapter_registry_version,
          outcome, category, evidence_json, decided_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        tx,
        w,
        res.classifierVersion,
        res.adapterRegistryVersion,
        res.outcome,
        res.category,
        JSON.stringify(res.evidence),
        Date.now(),
      );
      this.db!.prepare('DELETE FROM attrib_pending WHERE tx_hash = ? AND watched_wallet = ?').run(
        tx,
        w,
      );
    });
  }

  /**
   * Park a pair for retry.
   *
   * The failure HISTORY in `attrib_failure` is written separately and never
   * deleted, so a pair that later resolves still shows it took N attempts and
   * why — both the failure record and the eventual classification survive.
   */
  markPending(key: ObservationKey, reason: FailureCategory | 'verification_pending'): void {
    if (!this.db) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attrib_pending
         (tx_hash, watched_wallet, reason, attempts, first_failed_at, last_failed_at)
         VALUES (?,?,?,1,?,?)
         ON CONFLICT(tx_hash, watched_wallet) DO UPDATE SET
           attempts = attempts + 1, reason = excluded.reason,
           last_failed_at = excluded.last_failed_at`,
      )
      .run(key.txHash.toLowerCase(), key.wallet.toLowerCase(), reason, now, now);
  }

  pendingWork(limit = 100): { tx_hash: string; watched_wallet: string; attempts: number }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT tx_hash, watched_wallet, attempts FROM attrib_pending
         ORDER BY attempts ASC, last_failed_at ASC LIMIT ?`,
      )
      .all(limit) as unknown as { tx_hash: string; watched_wallet: string; attempts: number }[];
  }

  /**
   * Has this pair already reached a verdict at this classifier version?
   *
   * The restart-idempotency check. A re-run must not write a second attribution
   * for settled work, and must not spend the rate limit re-fetching its receipt.
   */
  isAttributed(key: ObservationKey, classifierVersion: number): boolean {
    if (!this.db) return false;
    const r = this.db
      .prepare(
        `SELECT 1 FROM attrib_attribution
         WHERE tx_hash = ? AND watched_wallet = ? AND classifier_version = ?`,
      )
      .get(key.txHash.toLowerCase(), key.wallet.toLowerCase(), classifierVersion);
    return r != null;
  }

  /** Enrichment progress for a pair, so a restart knows what it already fetched. */
  recordEnrichment(
    key: ObservationKey,
    e: { receiptFetched: boolean; poolsSeen: number; poolsUnresolved: number; classifierVersion?: number },
  ): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO attrib_enrichment
         (tx_hash, watched_wallet, receipt_fetched, pools_seen, pools_unresolved,
          classifier_version, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tx_hash, watched_wallet) DO UPDATE SET
           receipt_fetched = excluded.receipt_fetched,
           pools_seen = excluded.pools_seen,
           pools_unresolved = excluded.pools_unresolved,
           classifier_version = excluded.classifier_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        key.txHash.toLowerCase(),
        key.wallet.toLowerCase(),
        e.receiptFetched ? 1 : 0,
        e.poolsSeen,
        e.poolsUnresolved,
        e.classifierVersion ?? null,
        Date.now(),
      );
  }

  enrichment(key: ObservationKey): {
    receipt_fetched: number;
    pools_seen: number;
    pools_unresolved: number;
  } | null {
    if (!this.db) return null;
    return (this.db
      .prepare(
        `SELECT receipt_fetched, pools_seen, pools_unresolved FROM attrib_enrichment
         WHERE tx_hash = ? AND watched_wallet = ?`,
      )
      .get(key.txHash.toLowerCase(), key.wallet.toLowerCase()) ?? null) as unknown as {
      receipt_fetched: number;
      pools_seen: number;
      pools_unresolved: number;
    } | null;
  }

  /**
   * Claim the right to verify a pool. Returns false when someone already holds
   * it or the answer is already settled.
   *
   * DURABLE single-flight: the in-process coalescing map dies with the process,
   * so without this a restart re-requests every pool that was mid-flight — the
   * same stampede, once per boot.
   */
  claimPoolVerification(pool: string): boolean {
    if (!this.db) return true;
    const p = pool.toLowerCase();
    const now = Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO attrib_pool_verification (pool, state, attempts, first_seen_at, updated_at)
         VALUES (?, 'pending', 1, ?, ?)
         ON CONFLICT(pool) DO NOTHING`,
      )
      .run(p, now, now);
    return Number(r.changes) > 0;
  }

  poolVerificationState(pool: string): 'pending' | 'verified' | 'unverified' | null {
    if (!this.db) return null;
    const r = this.db
      .prepare('SELECT state FROM attrib_pool_verification WHERE pool = ?')
      .get(pool.toLowerCase()) as unknown as { state: string } | undefined;
    return (r?.state as 'pending' | 'verified' | 'unverified') ?? null;
  }

  /**
   * Record a verification outcome.
   *
   * A `pending` result bumps attempts and stays claimed — it is not an answer.
   * Only verified/unverified settle the row.
   */
  resolvePoolVerification(
    pool: string,
    state: 'pending' | 'verified' | 'unverified',
    protocol: string | null,
    reason: string,
    evidence: unknown,
  ): void {
    if (!this.db) return;
    const p = pool.toLowerCase();
    if (state === 'pending') {
      this.db
        .prepare(
          `UPDATE attrib_pool_verification
           SET attempts = attempts + 1, reason = ?, updated_at = ? WHERE pool = ?`,
        )
        .run(reason, Date.now(), p);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO attrib_pool_verification
         (pool, protocol, state, reason, evidence_json, attempts, first_seen_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?)
         ON CONFLICT(pool) DO UPDATE SET
           protocol = excluded.protocol, state = excluded.state,
           reason = excluded.reason, evidence_json = excluded.evidence_json,
           updated_at = excluded.updated_at`,
      )
      .run(p, protocol, state, reason, JSON.stringify(evidence ?? null), Date.now(), Date.now());
  }

  /** Pools with a settled `verified` answer — safe as `verifiedContracts`. */
  verifiedPools(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db
      .prepare("SELECT pool FROM attrib_pool_verification WHERE state = 'verified'")
      .all() as unknown as { pool: string }[];
    return new Set(rows.map((r) => r.pool));
  }

  /** Pools still awaiting an answer — `pendingContracts`, never `unsupported`. */
  pendingPools(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db
      .prepare("SELECT pool FROM attrib_pool_verification WHERE state = 'pending'")
      .all() as unknown as { pool: string }[];
    return new Set(rows.map((r) => r.pool));
  }

  poolVerificationStats(): { verified: number; unverified: number; pending: number } {
    const out = { verified: 0, unverified: 0, pending: 0 };
    if (!this.db) return out;
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM attrib_pool_verification GROUP BY state')
      .all() as unknown as { state: string; n: number }[];
    for (const r of rows) {
      if (r.state === 'verified') out.verified = r.n;
      else if (r.state === 'unverified') out.unverified = r.n;
      else out.pending = r.n;
    }
    return out;
  }

  /** Persist a verified V4 Initialize proof.  PoolIds are not addresses. */
  recordV4Initialization(init: {
    poolId: string;
    blockNumber: number;
    logIndex: number;
    txHash: string | null;
    evidence: unknown;
  }): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attrib_v4_pool_initialization
         (pool_id, block_number, log_index, tx_hash, evidence_json, recorded_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        init.poolId.toLowerCase(),
        init.blockNumber,
        init.logIndex,
        init.txHash?.toLowerCase() ?? null,
        JSON.stringify(init.evidence),
        Date.now(),
      );
  }

  v4InitializationCount(): number {
    if (!this.db) return 0;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attrib_v4_pool_initialization').get() as unknown as { n: number }).n;
  }

  /**
   * Read a canonical V4 PoolKey proof. PoolId is a hash and cannot be reversed;
   * the persisted Initialize event is therefore the only safe source for its
   * currencies. Invalid historic rows read as absent rather than guessed.
   */
  v4PoolInitialization(poolId: string): V4PoolInitialization | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT pool_id, block_number, log_index, tx_hash, evidence_json
       FROM attrib_v4_pool_initialization WHERE pool_id = ?`,
    ).get(poolId.toLowerCase()) as unknown as {
      pool_id: string; block_number: number; log_index: number; tx_hash: string | null; evidence_json: string;
    } | undefined;
    if (!row) return null;
    try {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      const address = (v: unknown): string | null =>
        typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null;
      const currency0 = address(evidence.currency0);
      const currency1 = address(evidence.currency1);
      if (!currency0 || !currency1) return null;
      return {
        poolId: row.pool_id.toLowerCase(), currency0, currency1,
        fee: typeof evidence.fee === 'number' && Number.isFinite(evidence.fee) ? evidence.fee : null,
        tickSpacing: typeof evidence.tickSpacing === 'number' && Number.isFinite(evidence.tickSpacing) ? evidence.tickSpacing : null,
        hooks: address(evidence.hooks), blockNumber: row.block_number, logIndex: row.log_index,
        txHash: row.tx_hash?.toLowerCase() ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The block a pending pair sits at, so the cursor can be held behind it.
   *
   * MIN, not MAX: a pair may be observed by several streams at different
   * blocks, and the cursor must be held behind the EARLIEST of them or the
   * later stream's cursor would advance past unresolved work.
   */
  pendingBlock(txHash: string, wallet: string): number | null {
    if (!this.db) return null;
    const r = this.db
      .prepare(
        `SELECT MIN(block_number) AS b FROM attrib_observation
         WHERE tx_hash = ? AND watched_wallet = ?`,
      )
      .get(txHash.toLowerCase(), wallet.toLowerCase()) as unknown as { b: number | null } | undefined;
    return r?.b ?? null;
  }

  recordEmission(
    txHash: string,
    logIndex: number,
    wallet: string,
    direction: string,
    token: string | null,
  ): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attrib_emission
         (tx_hash, log_index, watched_wallet, direction, token, emitted_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        txHash.toLowerCase(),
        logIndex,
        wallet.toLowerCase(),
        direction,
        token?.toLowerCase() ?? null,
        Date.now(),
      );
  }

  recordDeltas(txHash: string, wallet: string, deltas: WalletDelta[]): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO attrib_wallet_delta
       (tx_hash, wallet, token, net_raw_delta, decimals, delta_source) VALUES (?,?,?,?,?,?)`,
    );
    for (const d of deltas) {
      stmt.run(
        txHash.toLowerCase(),
        wallet.toLowerCase(),
        d.token.toLowerCase(),
        d.rawDelta,
        d.decimals,
        d.source,
      );
    }
  }

  /** Record every topic/emitter seen, classified or not — the leaderboard is
   *  generated from this, so nothing observed can go uncounted. */
  recordProtocolHits(
    txHash: string,
    hits: {
      contract: string;
      eventSig: string;
      protocolId: string | null;
      adapterVersion: number | null;
      verified?: boolean;
    }[],
  ): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO attrib_protocol_hit
       (tx_hash, contract, event_sig, protocol_id, adapter_version, verified) VALUES (?,?,?,?,?,?)`,
    );
    for (const h of hits) {
      stmt.run(
        txHash.toLowerCase(),
        h.contract.toLowerCase(),
        h.eventSig.toLowerCase(),
        h.protocolId,
        h.adapterVersion,
        h.verified ? 1 : 0,
      );
    }
  }

  recordFailure(f: FailureRecord): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO attrib_failure
         (operation, from_block, to_block, source_host, failure_kind, disposition,
          safe_detail, tx_hash, wallet, at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.operation,
        f.fromBlock,
        f.toBlock,
        rpcHost(f.sourceUrl),
        f.kind,
        FAILURE_DISPOSITION[f.kind],
        redact(f.detail).slice(0, 400),
        f.txHash?.toLowerCase() ?? null,
        f.wallet?.toLowerCase() ?? null,
        Date.now(),
      );
  }

  // ── Cursors ────────────────────────────────────────────────────────────────

  advanceCursor(streamId: string, block: number): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO attrib_cursor (stream_id, covered_through_block, updated_at) VALUES (?,?,?)
         ON CONFLICT(stream_id) DO UPDATE SET
           covered_through_block = MAX(covered_through_block, excluded.covered_through_block),
           updated_at = excluded.updated_at`,
      )
      .run(streamId, block, Date.now());
  }

  cursors(): Record<string, number> {
    if (!this.db) return {};
    const rows = this.db
      .prepare('SELECT stream_id, covered_through_block FROM attrib_cursor')
      .all() as unknown as { stream_id: string; covered_through_block: number }[];
    return Object.fromEntries(rows.map((r) => [r.stream_id, r.covered_through_block]));
  }

  /** Minimum across streams. Measured motivation: a swap-log query over 1000
   *  blocks truncated at 261 while the transfer query covered all 1000. */
  private minStreamCursor(): number | null {
    const c = Object.values(this.cursors());
    return c.length ? Math.min(...c) : null;
  }

  /**
   * The block it is safe to persist as progress.
   *
   * Held back by the OLDEST unresolved retriable pair as well as by the stream
   * minimum. Advancing past a transaction whose receipt we never fetched would
   * strand it permanently, because nothing would revisit that range.
   */
  safeCursor(): number | null {
    const streams = this.minStreamCursor();
    if (streams == null || !this.db) return streams;
    const row = this.db
      .prepare(
        `SELECT MIN(o.block_number) AS b FROM attrib_pending p
         JOIN attrib_observation o
           ON o.tx_hash = p.tx_hash AND o.watched_wallet = p.watched_wallet`,
      )
      .get() as unknown as { b: number | null } | undefined;
    const oldestPending = row?.b ?? null;
    // Observation and cursor advancement occur in different operations: a
    // process can die after recording an observation but before the ingester
    // writes either its attribution or retriable pending marker.  Treat that
    // "drift" as a cursor hold, not merely a metric, or a restart would start
    // after work the ledger knows it never finished.
    const drift = this.db
      .prepare(
        `SELECT MIN(o.block_number) AS b FROM attrib_observation o
         WHERE NOT EXISTS (
           SELECT 1 FROM attrib_attribution a
           WHERE a.tx_hash = o.tx_hash AND a.watched_wallet = o.watched_wallet
         ) AND NOT EXISTS (
           SELECT 1 FROM attrib_pending p
           WHERE p.tx_hash = o.tx_hash AND p.watched_wallet = o.watched_wallet
         )`,
      )
      .get() as unknown as { b: number | null } | undefined;
    const oldestDrift = drift?.b ?? null;
    const heldAt = [oldestPending, oldestDrift].filter((b): b is number => b != null);
    if (heldAt.length === 0) return streams;
    return Math.min(streams, Math.min(...heldAt) - 1);
  }

  /**
   * Canonical pairs that need the current classifier version.  We select one
   * representative observation for each pair because log indices are
   * provenance, not the unit of economic truth.
   */
  unsettledObservations(
    classifierVersion: number,
    limit = 500,
    beforeBlockExclusive?: number,
  ): UnsettledObservation[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT o.tx_hash, o.watched_wallet, MIN(o.block_number) AS block_number,
                MIN(o.log_index) AS log_index, MIN(o.trigger_source) AS trigger_source,
                MIN(o.token) AS token
         FROM attrib_observation o
         WHERE (? IS NULL OR o.block_number < ?)
           AND NOT EXISTS (
           SELECT 1 FROM attrib_attribution a
           WHERE a.tx_hash = o.tx_hash AND a.watched_wallet = o.watched_wallet
             AND a.classifier_version = ?
         )
         GROUP BY o.tx_hash, o.watched_wallet
         ORDER BY block_number ASC
         LIMIT ?`,
      )
      .all(beforeBlockExclusive ?? null, beforeBlockExclusive ?? null, classifierVersion, limit) as unknown as {
        tx_hash: string;
        watched_wallet: string;
        block_number: number;
        log_index: number;
        trigger_source: UnsettledObservation['triggerSource'];
        token: string | null;
      }[];
    return rows.map((r) => ({
      txHash: r.tx_hash,
      wallet: r.watched_wallet,
      blockNumber: r.block_number,
      logIndex: r.log_index,
      triggerSource: r.trigger_source,
      token: r.token,
    }));
  }

  // ── Readers ────────────────────────────────────────────────────────────────

  coverage(classifierVersion: number): CoverageRow[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT outcome, category, COUNT(*) AS n FROM attrib_attribution
         WHERE classifier_version = ? GROUP BY outcome, category ORDER BY n DESC`,
      )
      .all(classifierVersion) as unknown as CoverageRow[];
  }

  /** Category totals constrained to the report's observed block window. */
  coverageRange(classifierVersion: number, fromBlock: number, toBlock: number): CoverageRow[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT a.outcome, a.category, COUNT(*) AS n
         FROM attrib_attribution a
         WHERE a.classifier_version = ?
           AND EXISTS (SELECT 1 FROM attrib_observation o
             WHERE o.tx_hash = a.tx_hash AND o.watched_wallet = a.watched_wallet
               AND o.block_number >= ? AND o.block_number <= ?)
         GROUP BY a.outcome, a.category ORDER BY n DESC`,
      )
      .all(classifierVersion, fromBlock, toBlock) as unknown as CoverageRow[];
  }

  /** Unclaimed OR unverified signatures, ranked — the adapter work queue. */
  unknownTopics(limit = 50): { event_sig: string; contract: string; n: number }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT event_sig, contract, COUNT(*) AS n FROM attrib_protocol_hit
         WHERE protocol_id IS NULL OR verified = 0
         GROUP BY event_sig, contract ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as unknown as { event_sig: string; contract: string; n: number }[];
  }

  failureRates(): {
    operation: string;
    source_host: string;
    failure_kind: string;
    disposition: string;
    n: number;
  }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT operation, source_host, failure_kind, disposition, COUNT(*) AS n
         FROM attrib_failure GROUP BY operation, source_host, failure_kind, disposition
         ORDER BY n DESC`,
      )
      .all() as unknown as {
      operation: string;
      source_host: string;
      failure_kind: string;
      disposition: string;
      n: number;
    }[];
  }

  /**
   * The no-silent-drops alarm, over observed `(tx, wallet)` PAIRS.
   *
   * `pending` is broken out deliberately. A pair awaiting a retriable retry is
   * legitimately unresolved and must NOT count as drift — otherwise the
   * invariant becomes an incentive to terminalise infrastructure failures into
   * permanent verdicts. Only `drift` — observed, not attributed, not pending —
   * is a bug.
   */
  accountedFor(classifierVersion: number): AccountedFor {
    if (!this.db) return { pairs: 0, attributed: 0, pending: 0, drift: 0 };
    const pairs = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM (SELECT DISTINCT tx_hash, watched_wallet FROM attrib_observation)',
        )
        .get() as unknown as { n: number }
    ).n;
    const attributed = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM attrib_attribution WHERE classifier_version = ?')
        .get(classifierVersion) as unknown as { n: number }
    ).n;
    const pending = (
      this.db.prepare('SELECT COUNT(*) AS n FROM attrib_pending').get() as unknown as { n: number }
    ).n;
    return { pairs, attributed, pending, drift: pairs - attributed - pending };
  }

  // ── Finality / reorg ───────────────────────────────────────────────────────

  /** Persist the hash of a checkpointed block, so continuity is provable later. */
  recordCheckpoint(streamId: string, blockNumber: number, blockHash: string): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attrib_checkpoint (stream_id, block_number, block_hash, at)
         VALUES (?,?,?,?)`,
      )
      .run(streamId, blockNumber, blockHash.toLowerCase(), Date.now());
    // Keep a bounded window of recent checkpoints — deep history is not useful
    // for continuity and unbounded growth is.
    this.db
      .prepare(
        `DELETE FROM attrib_checkpoint WHERE stream_id = ? AND block_number <
           (SELECT MIN(block_number) FROM
             (SELECT block_number FROM attrib_checkpoint WHERE stream_id = ?
              ORDER BY block_number DESC LIMIT 500))`,
      )
      .run(streamId, streamId);
  }

  checkpointAt(streamId: string, blockNumber: number): string | null {
    if (!this.db) return null;
    const r = this.db
      .prepare(
        'SELECT block_hash FROM attrib_checkpoint WHERE stream_id = ? AND block_number = ?',
      )
      .get(streamId, blockNumber) as unknown as { block_hash?: string } | undefined;
    return r?.block_hash ?? null;
  }

  latestCheckpoint(streamId: string): { block_number: number; block_hash: string } | null {
    if (!this.db) return null;
    const r = this.db
      .prepare(
        `SELECT block_number, block_hash FROM attrib_checkpoint WHERE stream_id = ?
         ORDER BY block_number DESC LIMIT 1`,
      )
      .get(streamId) as unknown as { block_number: number; block_hash: string } | undefined;
    return r ?? null;
  }

  /**
   * Roll back everything at or after `block` and rewind the cursor.
   *
   * Observations, attributions, pending work, deltas, protocol hits and
   * emissions for the affected blocks are all removed — a reorged block's
   * transactions may simply not exist on the canonical chain, so leaving their
   * verdicts in place would report classifications for events that never
   * happened. The reorg itself is recorded permanently.
   */
  rollbackTo(streamId: string, block: number, expectedHash: string | null, actualParent: string | null): {
    observationsRemoved: number;
    attributionsRemoved: number;
  } {
    if (!this.db) return { observationsRemoved: 0, attributionsRemoved: 0 };
    return this.transaction(() => {
      const txs = this.db!
        .prepare('SELECT DISTINCT tx_hash FROM attrib_observation WHERE block_number >= ?')
        .all(block) as unknown as { tx_hash: string }[];
      const hashes = txs.map((t) => t.tx_hash);
      let attributionsRemoved = 0;
      for (const h of hashes) {
        attributionsRemoved += Number(
          this.db!.prepare('DELETE FROM attrib_attribution WHERE tx_hash = ?').run(h).changes,
        );
        this.db!.prepare('DELETE FROM attrib_pending WHERE tx_hash = ?').run(h);
        this.db!.prepare('DELETE FROM attrib_wallet_delta WHERE tx_hash = ?').run(h);
        this.db!.prepare('DELETE FROM attrib_protocol_hit WHERE tx_hash = ?').run(h);
        this.db!.prepare('DELETE FROM attrib_emission WHERE tx_hash = ?').run(h);
        this.db!.prepare('DELETE FROM attrib_tx WHERE tx_hash = ?').run(h);
      }
      const observationsRemoved = Number(
        this.db!.prepare('DELETE FROM attrib_observation WHERE block_number >= ?').run(block).changes,
      );
      this.db!.prepare('DELETE FROM attrib_v4_pool_initialization WHERE block_number >= ?').run(block);
      this.db!.prepare('DELETE FROM attrib_checkpoint WHERE block_number >= ?').run(block);
      // Rewind every stream: a reorg invalidates the range for all of them.
      this.db!
        .prepare('UPDATE attrib_cursor SET covered_through_block = ?, updated_at = ? WHERE covered_through_block > ?')
        .run(block - 1, Date.now(), block - 1);
      this.db!
        .prepare(
          `INSERT INTO attrib_reorg
           (stream_id, detected_at, at_block, expected_hash, actual_parent_hash,
            rolled_back_to, observations_removed, attributions_removed)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(streamId, Date.now(), block, expectedHash, actualParent, block - 1, observationsRemoved, attributionsRemoved);
      return { observationsRemoved, attributionsRemoved };
    });
  }

  reorgCount(): number {
    if (!this.db) return 0;
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attrib_reorg').get() as unknown as { n: number }).n;
  }

  /**
   * The same invariant, scoped to a BLOCK RANGE.
   *
   * The global form silently describes all-time when a caller asks about a
   * window, which lets a report claim to cover [from, to] while quoting numbers
   * from every block ever ingested. Every count here is constrained to pairs
   * whose OBSERVATION falls inside the interval, so the denominator and the
   * drift both mean what the range says they mean.
   */
  accountedForRange(classifierVersion: number, fromBlock: number, toBlock: number): AccountedFor {
    if (!this.db) return { pairs: 0, attributed: 0, pending: 0, drift: 0 };
    const inRange =
      `SELECT DISTINCT tx_hash, watched_wallet FROM attrib_observation
       WHERE block_number >= ? AND block_number <= ?`;
    const pairs = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM (${inRange})`).get(fromBlock, toBlock) as unknown as {
        n: number;
      }
    ).n;
    const attributed = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM attrib_attribution a
           WHERE a.classifier_version = ?
             AND EXISTS (SELECT 1 FROM attrib_observation o
               WHERE o.tx_hash = a.tx_hash AND o.watched_wallet = a.watched_wallet
                 AND o.block_number >= ? AND o.block_number <= ?)`,
        )
        .get(classifierVersion, fromBlock, toBlock) as unknown as { n: number }
    ).n;
    const pending = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM attrib_pending p
           WHERE EXISTS (SELECT 1 FROM attrib_observation o
             WHERE o.tx_hash = p.tx_hash AND o.watched_wallet = p.watched_wallet
               AND o.block_number >= ? AND o.block_number <= ?)`,
        )
        .get(fromBlock, toBlock) as unknown as { n: number }
    ).n;
    return { pairs, attributed, pending, drift: pairs - attributed - pending };
  }

  /**
   * Rows needed for the trace-provider decision: every `insufficient_trace_data`
   * verdict, with whether the LIVE listener emitted a swap for the same pair.
   *
   * The join to attrib_emission is what turns "how many are trace-blocked" into
   * "how many LIVE SIGNALS would change", which is the number the decision
   * actually rests on.
   */
  traceGapRows(
    classifierVersion: number,
    fromBlock?: number,
    toBlock?: number,
  ): { evidence_json: string; liveEmitted: number }[] {
    if (!this.db) return [];
    const inRange = fromBlock != null && toBlock != null;
    return this.db
      .prepare(
        `SELECT a.evidence_json AS evidence_json,
                EXISTS (SELECT 1 FROM attrib_emission e
                  WHERE e.tx_hash = a.tx_hash AND e.watched_wallet = a.watched_wallet) AS liveEmitted
         FROM attrib_attribution a
         WHERE a.classifier_version = ? AND a.category = 'insufficient_trace_data'
           AND (? = 0 OR EXISTS (SELECT 1 FROM attrib_observation o
             WHERE o.tx_hash = a.tx_hash AND o.watched_wallet = a.watched_wallet
               AND o.block_number >= ? AND o.block_number <= ?))`,
      )
      .all(classifierVersion, inRange ? 1 : 0, fromBlock ?? 0, toBlock ?? 0) as unknown as {
        evidence_json: string;
        liveEmitted: number;
      }[];
  }

  /** How many attributed pairs the live listener also emitted a swap for. */
  liveEmittedCount(fromBlock?: number, toBlock?: number): number {
    if (!this.db) return 0;
    const inRange = fromBlock != null && toBlock != null;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT DISTINCT e.tx_hash, e.watched_wallet FROM attrib_emission e
             WHERE (? = 0 OR EXISTS (SELECT 1 FROM attrib_observation o
               WHERE o.tx_hash = e.tx_hash AND o.watched_wallet = e.watched_wallet
                 AND o.block_number >= ? AND o.block_number <= ?))
           )`,
        )
        .get(inRange ? 1 : 0, fromBlock ?? 0, toBlock ?? 0) as unknown as { n: number }
    ).n;
  }

  /** Prune old rows. Failures and still-pending pairs are never auto-pruned. */
  pruneBefore(block: number): number {
    if (!this.db) return 0;
    const r = this.db
      .prepare(
        `DELETE FROM attrib_observation WHERE block_number < ?
         AND NOT EXISTS (SELECT 1 FROM attrib_pending p
           WHERE p.tx_hash = attrib_observation.tx_hash
             AND p.watched_wallet = attrib_observation.watched_wallet)`,
      )
      .run(block);
    this.db.prepare('DELETE FROM attrib_tx WHERE block_number < ?').run(block);
    return Number(r.changes);
  }
}
