/**
 * Durable "has this wallet ever bought this token before?" registry.
 *
 * The legacy ENTRY rule called this "the wallet's first-ever buy", but the
 * backing store was an in-memory `Set` that was never persisted and was cleared
 * wholesale at 200,000 entries. Since Railway redeploys on every push to main,
 * "first-ever" in practice meant "first since the last deploy" — so after any
 * push, every wallet's next buy of any token looked like a debut. The single
 * most load-bearing word in the premium signal was measuring uptime.
 *
 * Two properties this must have that the Set did not:
 *
 *  - Survive a restart. It lives on the durable volume alongside the sniper state.
 *  - Claim atomically. Two alerts for the same pair can race; `claim` uses an
 *    INSERT that either wins or reports the pair as already seen, so exactly one
 *    caller is ever told "first" — the same discipline the sniper's per-token
 *    in-flight lock exists to enforce for buys.
 *
 * Bounded by first-seen block, not by row count, so pruning cannot revive a pair
 * as "first" while newer pairs survive.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../../config/env.js';
import { logger } from '../../logger.js';

// `node:sqlite` via createRequire, not a static import — same reason as
// attrib/ledger.ts: Vite rewrites the specifier to a bare `sqlite` it cannot
// resolve, and the suite then collects ZERO tests while still exiting 0. A test
// file that silently runs nothing is worse than one that fails.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export interface FirstBuyRecord {
  wallet: string;
  token: string;
  /** ms epoch when the pair was first claimed. */
  firstAt: number;
  /** Chain block of the first buy, when known — the durable ordering key for pruning. */
  firstBlock: number | null;
}

export class FirstBuyRegistry {
  private readonly db: DatabaseSync | null;

  constructor(path = config.V2_FIRST_BUY_PATH || '') {
    if (!path) {
      // Same contract as the other stores: a blank path disables persistence so
      // tests can never write into a live registry. A disabled registry reports
      // every pair as NOT first — the conservative direction, since a false
      // "first" manufactures the premium signal out of nothing.
      this.db = null;
      logger.info('v2 first-buy: durable registry disabled (no path configured)');
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS first_buy (
        wallet      TEXT NOT NULL,
        token       TEXT NOT NULL,
        first_at    INTEGER NOT NULL,
        first_block INTEGER,
        PRIMARY KEY (wallet, token)
      );
      CREATE INDEX IF NOT EXISTS first_buy_block ON first_buy (first_block);
    `);
  }

  get enabled(): boolean {
    return this.db != null;
  }

  /**
   * Record this pair and report whether it had never been seen before.
   *
   * Returns true at most once per (wallet, token) for the life of the registry.
   * A disabled registry always returns false: without durable proof that a pair
   * is new, claiming it is new would be a fabricated fact.
   */
  claim(wallet: string, token: string, at: number, block: number | null = null): boolean {
    if (!this.db) return false;
    const w = wallet.toLowerCase();
    const t = token.toLowerCase();
    try {
      const r = this.db
        .prepare(
          `INSERT INTO first_buy (wallet, token, first_at, first_block)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (wallet, token) DO NOTHING`,
        )
        .run(w, t, at, block);
      return Number(r.changes) > 0;
    } catch (err) {
      // Never let bookkeeping fabricate a "first". On any doubt, say no.
      logger.warn({ err: String(err).slice(0, 160), wallet: w }, 'v2 first-buy: claim failed, reporting not-first');
      return false;
    }
  }

  /** Read-only check, for building a fact sheet without claiming. */
  seen(wallet: string, token: string): boolean {
    if (!this.db) return false;
    const row = this.db
      .prepare('SELECT 1 AS hit FROM first_buy WHERE wallet = ? AND token = ?')
      .get(wallet.toLowerCase(), token.toLowerCase()) as { hit: number } | undefined;
    return row != null;
  }

  get(wallet: string, token: string): FirstBuyRecord | null {
    if (!this.db) return null;
    const row = this.db
      .prepare('SELECT wallet, token, first_at AS firstAt, first_block AS firstBlock FROM first_buy WHERE wallet = ? AND token = ?')
      .get(wallet.toLowerCase(), token.toLowerCase()) as FirstBuyRecord | undefined;
    return row ?? null;
  }

  count(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM first_buy').get() as { n: number };
    return Number(row.n);
  }

  /**
   * Drop pairs first seen below `block`.
   *
   * Pruning by block rather than by age or row count keeps the registry
   * consistent with the attribution ledger's retention: both answer questions
   * about the same window of chain history, and a registry that forgot a pair
   * the ledger still remembers would re-issue a "first buy" for it.
   */
  pruneBefore(block: number): number {
    if (!this.db) return 0;
    const r = this.db.prepare('DELETE FROM first_buy WHERE first_block IS NOT NULL AND first_block < ?').run(block);
    return Number(r.changes);
  }

  close(): void {
    this.db?.close();
  }
}
