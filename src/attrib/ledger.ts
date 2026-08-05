import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

// `node:sqlite` via createRequire, not a static import.
//
// Vite (and therefore Vitest) rewrites the `node:sqlite` specifier to a bare
// `sqlite` and then cannot resolve it, so ANY suite that transitively imports
// this module fails to collect — the tests would silently not run, which is the
// same class of invisible failure this whole subsystem exists to eliminate.
// Resolving through Node's own require keeps the import out of Vite's static
// analysis. Mirrors the indirect-import trick already used for Prisma in
// store/persistence.ts.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { redact, rpcHost } from '../chain/rpcLog.js';
import type { AttributionResult, FailureCategory, WalletDelta } from './taxonomy.js';

/**
 * The canonical transaction ledger.
 *
 * SQLite/WAL, following `src/sniper/state.ts` — already a proven in-repo
 * dependency with no new packages, and its `INSERT OR IGNORE` + `changes > 0`
 * idiom is exactly the first-writer-wins primitive an append-only ledger keyed
 * on `(tx_hash, log_index)` needs, so a replay can never double-count.
 *
 * Chosen over the JSON-snapshot store (`store/feedState.ts`) because that
 * rewrites the whole file per save and its validator DROPS malformed rows
 * silently — the precise opposite of the no-silent-drops requirement. Chosen
 * over append-only JSONL because JSONL has no unique constraint, so replaying a
 * range would duplicate every row in it.
 *
 * `attrib_result` is keyed by `(tx_hash, log_index, classifier_version)`, so a
 * classifier change ADDS rows rather than overwriting them. Old verdicts stay
 * queryable, which is what makes "did this rule change help?" answerable at all.
 */

/** Bumped when the schema changes; gates migrations via `PRAGMA user_version`. */
const SCHEMA_VERSION = 1;

export interface CandidateKey {
  txHash: string;
  logIndex: number;
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
  /** A URL, which is reduced to its host before storage — never stored whole. */
  sourceUrl: string;
  kind: FailureCategory;
  detail: string;
  txHash?: string;
}

export interface CoverageRow {
  outcome: string;
  category: string;
  n: number;
}

export class AttributionLedger {
  private readonly db: DatabaseSync | null;
  /** True when persistence is OFF. Surfaced so an empty ledger is never read as
   *  a quiet chain — the same failure `rpcLog.ts` exists to prevent. */
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

      -- The trigger log. INSERT OR IGNORE makes replay idempotent.
      CREATE TABLE IF NOT EXISTS attrib_candidate (
        tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        watched_wallet TEXT NOT NULL, token TEXT,
        direction_hint TEXT, raw_value TEXT,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS attrib_wallet_delta (
        tx_hash TEXT NOT NULL, wallet TEXT NOT NULL, token TEXT NOT NULL,
        net_raw_delta TEXT NOT NULL, decimals INTEGER, delta_source TEXT NOT NULL,
        PRIMARY KEY (tx_hash, wallet, token)
      );

      CREATE TABLE IF NOT EXISTS attrib_protocol_hit (
        tx_hash TEXT NOT NULL, contract TEXT NOT NULL, event_sig TEXT NOT NULL,
        protocol_id TEXT, adapter_version INTEGER,
        PRIMARY KEY (tx_hash, contract, event_sig)
      );

      -- Append-only ACROSS classifier versions: re-classification never
      -- overwrites a prior verdict, it records a new one beside it.
      CREATE TABLE IF NOT EXISTS attrib_result (
        tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        classifier_version INTEGER NOT NULL, adapter_registry_version INTEGER NOT NULL,
        outcome TEXT NOT NULL,          -- NOT NULL: no candidate without a verdict
        category TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index, classifier_version)
      );

      CREATE TABLE IF NOT EXISTS attrib_failure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL, from_block INTEGER, to_block INTEGER,
        source_host TEXT NOT NULL, failure_kind TEXT NOT NULL,
        safe_detail TEXT, tx_hash TEXT, at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attrib_cursor (
        stream_id TEXT PRIMARY KEY,
        covered_through_block INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_result_outcome ON attrib_result (outcome, category);
      CREATE INDEX IF NOT EXISTS idx_candidate_block ON attrib_candidate (block_number);
      CREATE INDEX IF NOT EXISTS idx_hit_sig ON attrib_protocol_hit (event_sig);
      CREATE INDEX IF NOT EXISTS idx_failure_kind ON attrib_failure (failure_kind, at);
    `);
    const v = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    if (!v?.user_version) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    logger.info({ schemaVersion: SCHEMA_VERSION }, 'attrib: ledger open');
  }

  close(): void {
    this.db?.close();
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
        tx.txFrom,
        tx.txTo,
        tx.selector,
        tx.nativeValueWei,
        tx.receiptStatus,
        tx.receiptJson,
        rpcHost(tx.sourceHost),
        Date.now(),
      );
  }

  /** Returns true when this candidate was newly claimed (first-writer-wins). */
  recordCandidate(
    key: CandidateKey,
    blockNumber: number,
    wallet: string,
    token: string | null,
    directionHint: string | null,
    rawValue: string | null,
  ): boolean {
    if (!this.db) return false;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO attrib_candidate
         (tx_hash, log_index, block_number, watched_wallet, token, direction_hint, raw_value, first_seen_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        key.txHash.toLowerCase(),
        key.logIndex,
        blockNumber,
        wallet.toLowerCase(),
        token?.toLowerCase() ?? null,
        directionHint,
        rawValue,
        Date.now(),
      );
    return Number(r.changes) > 0;
  }

  /**
   * The only way a verdict is written. `outcome` is derived inside
   * {@link AttributionResult}, never passed separately, so it cannot drift from
   * the category.
   */
  recordResult(key: CandidateKey, res: AttributionResult): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attrib_result
         (tx_hash, log_index, classifier_version, adapter_registry_version,
          outcome, category, evidence_json, decided_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        key.txHash.toLowerCase(),
        key.logIndex,
        res.classifierVersion,
        res.adapterRegistryVersion,
        res.outcome,
        res.category,
        JSON.stringify(res.evidence),
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

  recordProtocolHits(
    txHash: string,
    hits: { contract: string; eventSig: string; protocolId: string | null; adapterVersion: number | null }[],
  ): void {
    if (!this.db) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO attrib_protocol_hit
       (tx_hash, contract, event_sig, protocol_id, adapter_version) VALUES (?,?,?,?,?)`,
    );
    for (const h of hits) {
      stmt.run(
        txHash.toLowerCase(),
        h.contract.toLowerCase(),
        h.eventSig.toLowerCase(),
        h.protocolId,
        h.adapterVersion,
      );
    }
  }

  /**
   * Every external call records here on failure. `sourceUrl` is reduced to its
   * host and `detail` is passed through `redact()` — a node echoing our request
   * back must not reprint an API key into the ledger.
   */
  recordFailure(f: FailureRecord): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO attrib_failure
         (operation, from_block, to_block, source_host, failure_kind, safe_detail, tx_hash, at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.operation,
        f.fromBlock,
        f.toBlock,
        rpcHost(f.sourceUrl),
        f.kind,
        redact(f.detail).slice(0, 400),
        f.txHash?.toLowerCase() ?? null,
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

  /**
   * The block through which EVERY registered stream has safely reported.
   *
   * Generalises the rule already correct in `chain/shadow.ts`: two paginated
   * queries over the same range reach different blocks — measured, a swap-log
   * query stopped at 261 of 1000 while the transfer query covered all 1000.
   * Advancing on the furthest would mark blocks scanned whose classification
   * context was never fetched. Only this value is ever persisted as progress.
   */
  safeCursor(): number | null {
    const c = Object.values(this.cursors());
    return c.length ? Math.min(...c) : null;
  }

  // ── Readers ────────────────────────────────────────────────────────────────

  coverage(classifierVersion: number): CoverageRow[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT outcome, category, COUNT(*) AS n FROM attrib_result
         WHERE classifier_version = ? GROUP BY outcome, category ORDER BY n DESC`,
      )
      .all(classifierVersion) as unknown as CoverageRow[];
  }

  /** Unknown event signatures ranked by frequency — the adapter work queue. */
  unknownTopics(limit = 50): { event_sig: string; contract: string; n: number }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT event_sig, contract, COUNT(*) AS n FROM attrib_protocol_hit
         WHERE protocol_id IS NULL GROUP BY event_sig, contract ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as unknown as { event_sig: string; contract: string; n: number }[];
  }

  failureRates(): { operation: string; source_host: string; failure_kind: string; n: number }[] {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT operation, source_host, failure_kind, COUNT(*) AS n FROM attrib_failure
         GROUP BY operation, source_host, failure_kind ORDER BY n DESC`,
      )
      .all() as unknown as { operation: string; source_host: string; failure_kind: string; n: number }[];
  }

  /**
   * The no-silent-drops alarm: every candidate must have a verdict.
   * A non-zero `drift` means something was observed and never accounted for.
   */
  accountedFor(classifierVersion: number): { candidates: number; results: number; drift: number } {
    if (!this.db) return { candidates: 0, results: 0, drift: 0 };
    const c = this.db.prepare('SELECT COUNT(*) AS n FROM attrib_candidate').get() as unknown as { n: number };
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM attrib_result WHERE classifier_version = ?')
      .get(classifierVersion) as unknown as { n: number };
    return { candidates: c.n, results: r.n, drift: c.n - r.n };
  }

  /** Prune old rows. Failures are never pruned — they are the record of what we
   *  could not see, and that record is the point. */
  pruneBefore(block: number): number {
    if (!this.db) return 0;
    const r = this.db.prepare('DELETE FROM attrib_candidate WHERE block_number < ?').run(block);
    this.db.prepare('DELETE FROM attrib_tx WHERE block_number < ?').run(block);
    return Number(r.changes);
  }
}
