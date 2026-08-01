import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/env.js';
import { logger } from '../logger.js';

export type SniperMode = 'off' | 'live';

export interface StoredSniperState {
  version: 1;
  /** Execution mode is durable per owner: once an operator turns their sniper on it stays on
   *  across restarts (the wallet still starts locked, so no trade runs until they unlock). */
  mode?: SniperMode;
  positions: unknown[];
  settings: unknown;
  buys: { at: number; eth: number }[];
  recentLosses: [string, number][];
  decisions: unknown[];
  removedLog: unknown[];
  /** Daily equity high-water / realized loss accounting is intentionally durable. */
  day?: { date: string; startingEquityEth: number; realizedLossEth: number };
}

type KeyRow = { cipher: string; iv: string; tag: string; version: number };

/**
 * The sniper has one small, local SQLite source of truth. It replaces the
 * position-only JSON persistence without requiring an external DB. SQLite WAL
 * makes state writes atomic across crashes and records an immutable audit row
 * for every decision/transaction transition.
 */
export class SniperStateStore {
  private readonly db: DatabaseSync | null;
  private readonly key: Buffer | null;

  constructor(path = config.SNIPER_STATE_PATH || '') {
    if (!path) {
      this.db = null;
      this.key = null;
      logger.warn('sniper: durable state disabled (set SNIPER_STATE_PATH)');
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS sniper_state (owner TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sniper_keys (owner TEXT PRIMARY KEY, cipher TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sniper_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      -- Global, not per operator: this is the canonical history behind the
      -- “New coins only” setting. A token is consumed as soon as it appears in
      -- the Signals feed, even when no sniper has the setting enabled.
      CREATE TABLE IF NOT EXISTS sniper_signal_tokens (token TEXT PRIMARY KEY, first_alert_at INTEGER NOT NULL, first_alert_id TEXT, symbol TEXT);
    `);
    this.key = parseEncryptionKey(config.SNIPER_KEY_ENCRYPTION_KEY);
    if (!this.key) logger.warn('sniper: key enrolment disabled (SNIPER_KEY_ENCRYPTION_KEY is unset or invalid)');
  }

  get enabled(): boolean { return this.db !== null; }
  get keyEnabled(): boolean { return this.key !== null && this.db !== null; }

  /**
   * Atomically record a token's first appearance in the Signals feed.
   *
   * The boolean belongs to the emitted alert, rather than to an operator: every
   * operator is allowed to evaluate the same initial alert, while any later
   * signal for this token is permanently marked as a repeat. SQLite's primary
   * key makes concurrent duplicate emissions deterministic.
   */
  claimFirstSignal(token: string, alertId?: string, symbol?: string): boolean {
    if (!this.db) return false;
    const normalized = token.trim().toLowerCase();
    if (!normalized) return false;
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO sniper_signal_tokens(token,first_alert_at,first_alert_id,symbol) VALUES(?,?,?,?)',
    ).run(normalized, Date.now(), alertId ?? null, symbol ?? null);
    return result.changes > 0;
  }

  load(owner: string): StoredSniperState | null {
    const row = this.db?.prepare('SELECT payload FROM sniper_state WHERE owner = ?').get(owner) as { payload?: string } | undefined;
    if (!row?.payload) return null;
    try { return JSON.parse(row.payload) as StoredSniperState; } catch { return null; }
  }

  save(owner: string, state: StoredSniperState): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO sniper_state(owner,payload,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(owner, JSON.stringify(state), Date.now());
  }

  audit(owner: string, type: string, payload: unknown): void {
    this.db?.prepare('INSERT INTO sniper_audit(owner,at,type,payload) VALUES(?,?,?,?)')
      .run(owner, Date.now(), type, JSON.stringify(payload));
  }

  enrollKey(owner: string, privateKey: string): void {
    if (!this.db || !this.key) throw new Error('encrypted key storage is not configured');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
    this.db.prepare(`INSERT INTO sniper_keys(owner,cipher,iv,tag,version,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(owner) DO UPDATE SET cipher=excluded.cipher,iv=excluded.iv,tag=excluded.tag,version=excluded.version,updated_at=excluded.updated_at`)
      .run(owner, encrypted.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), Date.now());
    this.audit(owner, 'key-enrolled', {});
  }

  unlockKey(owner: string): string {
    if (!this.db || !this.key) throw new Error('encrypted key storage is not configured');
    const row = this.db.prepare('SELECT cipher,iv,tag,version FROM sniper_keys WHERE owner=?').get(owner) as KeyRow | undefined;
    if (!row) throw new Error('no encrypted key enrolled');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const pk = Buffer.concat([decipher.update(Buffer.from(row.cipher, 'base64')), decipher.final()]).toString('utf8');
    this.audit(owner, 'key-unlocked', {});
    return pk;
  }

  hasKey(owner: string): boolean {
    return Boolean(this.db?.prepare('SELECT 1 FROM sniper_keys WHERE owner=?').get(owner));
  }

  deleteKey(owner: string): void {
    this.db?.prepare('DELETE FROM sniper_keys WHERE owner=?').run(owner);
    this.audit(owner, 'key-erased', {});
  }
}

function parseEncryptionKey(value: string): Buffer | null {
  if (!value) return null;
  try {
    const key = Buffer.from(value, 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}
