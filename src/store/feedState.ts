import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Alert, Swarm, TrackedToken } from '../types.js';
import { logger } from '../logger.js';

/**
 * Durable feed state — the minimum a restart must not lose.
 *
 * The Railway feed runs with `database=false, redis=false`, so before this
 * everything lived in process memory. Two of those things were load-bearing:
 *
 *   - the **listener cursor**. On boot the poller set `lastBlock = head`, so
 *     every block between the crash and the restart was never scanned. Not
 *     "scanned late" — never.
 *   - the **discovered-token registry**. Tokens are learned by observing them,
 *     so a restart dropped the feed to the seed set and it rebuilt from zero.
 *     Measured 2026-08-05: the feed knew 73 tokens against the box's 1,894 on
 *     identical code, purely because the box had not restarted.
 *
 * Swarms and alerts are carried too, but for display only — see `restoreHistory`
 * on MemoryStore, which deliberately does NOT re-emit them. Re-emitting a
 * persisted alert on boot would push it back down the SSE feed to the sniper,
 * which is a duplicate-buy bug, not a durability feature.
 *
 * Schema-versioned: an unknown version is discarded rather than coerced. A
 * snapshot is a cache, so throwing it away costs a rebuild, and mis-reading one
 * costs a wrong cursor — the asymmetry says discard.
 */
export const FEED_STATE_VERSION = 3;

/** Only the fields we can restore meaningfully; everything else re-enriches. */
export interface PersistedToken {
  address: string;
  symbol: string;
  name: string;
  totalSupply: number;
  supplyVerified: boolean;
  stable: boolean;
  discovered: boolean;
  firstSeen: number;
  decimals?: number;
}

/** A receipt log held only because token decimals were temporarily unreadable. */
export interface PersistedMetadataCandidate {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
}

/** A real chain candidate held until its proof/price/age evidence resolves. */
export interface PersistedSignalCandidate {
  swarm: Swarm;
  mode: 'swarm' | 'solo' | 'entry';
  attempts: number;
  nextAt: number;
}

export interface FeedStateSnapshot {
  version: number;
  savedAt: number;
  /** Last block fully scanned. The next poll resumes at cursor + 1. */
  cursor: number;
  tokens: PersistedToken[];
  swarms: Swarm[];
  alerts: Alert[];
  /** Bounded deferred candidates; replayed after a restart before new blocks. */
  pendingMetadata?: PersistedMetadataCandidate[];
  /** Candidates are data, not alerts: restoring them retries verification but
   * never re-emits an alert that was already recorded. */
  pendingSignals?: PersistedSignalCandidate[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Narrow one token entry, rejecting anything we cannot use. */
function parseToken(v: unknown): PersistedToken | null {
  if (!isObj(v)) return null;
  const { address, symbol, name, totalSupply, firstSeen } = v;
  if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(address)) return null;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  return {
    address: address.toLowerCase(),
    symbol,
    name: typeof name === 'string' ? name : symbol,
    totalSupply: finiteNum(totalSupply) && totalSupply > 0 ? totalSupply : 1_000_000_000,
    // Absent/!== true reads as false: an unverified supply must never be
    // restored as verified, or the oracle would treat a placeholder as measured.
    supplyVerified: v.supplyVerified === true,
    stable: v.stable === true,
    discovered: v.discovered !== false,
    firstSeen: finiteNum(firstSeen) ? firstSeen : Date.now(),
    ...(finiteNum(v.decimals) ? { decimals: v.decimals } : {}),
  };
}

function parseMetadataCandidate(v: unknown): PersistedMetadataCandidate | null {
  if (!isObj(v)) return null;
  if (typeof v.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(v.address)) return null;
  if (!Array.isArray(v.topics) || v.topics.length < 3 || !v.topics.every((t) => typeof t === 'string' && /^0x[0-9a-f]*$/i.test(t))) return null;
  if (typeof v.data !== 'string' || !/^0x[0-9a-f]*$/i.test(v.data)) return null;
  if (v.transactionHash !== undefined && typeof v.transactionHash !== 'string') return null;
  if (v.logIndex !== undefined && typeof v.logIndex !== 'string') return null;
  if (v.blockNumber !== undefined && typeof v.blockNumber !== 'string') return null;
  return {
    address: v.address.toLowerCase(), topics: [...v.topics], data: v.data,
    ...(typeof v.blockNumber === 'string' ? { blockNumber: v.blockNumber } : {}),
    ...(typeof v.transactionHash === 'string' ? { transactionHash: v.transactionHash } : {}),
    ...(typeof v.logIndex === 'string' ? { logIndex: v.logIndex } : {}),
  };
}

function parseSignalCandidate(v: unknown): PersistedSignalCandidate | null {
  if (!isObj(v) || !isObj(v.swarm)) return null;
  if (v.mode !== 'swarm' && v.mode !== 'solo' && v.mode !== 'entry') return null;
  const swarm = v.swarm as unknown as Swarm;
  if (typeof swarm.id !== 'string' || typeof swarm.token !== 'string' || !/^0x[0-9a-f]{40}$/i.test(swarm.token)) return null;
  return {
    swarm,
    mode: v.mode,
    attempts: finiteNum(v.attempts) && v.attempts >= 0 ? Math.floor(v.attempts) : 0,
    nextAt: finiteNum(v.nextAt) ? v.nextAt : Date.now(),
  };
}

/**
 * Read a snapshot. Returns null for "nothing usable" — missing file, unreadable,
 * malformed JSON, wrong version, or a cursor that is not a real block number.
 * Never throws: a bad snapshot must degrade to a cold start, not a crash loop.
 */
export async function loadFeedState(path: string): Promise<FeedStateSnapshot | null> {
  if (!path) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      logger.warn({ err: String(err), path }, 'feed state: could not read snapshot');
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: String(err), path }, 'feed state: snapshot is not valid JSON — cold start');
    return null;
  }

  if (!isObj(parsed)) {
    logger.warn({ path }, 'feed state: snapshot is not an object — cold start');
    return null;
  }
  // v1 had no metadata-retry queue. It remains readable so this safety upgrade
  // never throws away a valid production cursor merely because the snapshot
  // gained an optional field.
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== FEED_STATE_VERSION) {
    logger.warn(
      { path, found: parsed.version, expected: FEED_STATE_VERSION },
      'feed state: snapshot version mismatch — cold start',
    );
    return null;
  }
  if (!finiteNum(parsed.cursor) || parsed.cursor < 0) {
    logger.warn({ path, cursor: parsed.cursor }, 'feed state: snapshot cursor invalid — cold start');
    return null;
  }

  const tokens = Array.isArray(parsed.tokens)
    ? parsed.tokens.map(parseToken).filter((t): t is PersistedToken => t !== null)
    : [];
  const swarms = Array.isArray(parsed.swarms) ? (parsed.swarms as Swarm[]) : [];
  const alerts = Array.isArray(parsed.alerts) ? (parsed.alerts as Alert[]) : [];
  const pendingMetadata = Array.isArray(parsed.pendingMetadata)
    ? parsed.pendingMetadata.map(parseMetadataCandidate).filter((x): x is PersistedMetadataCandidate => x !== null).slice(0, 512)
    : [];
  const pendingSignals = Array.isArray(parsed.pendingSignals)
    ? parsed.pendingSignals.map(parseSignalCandidate).filter((x): x is PersistedSignalCandidate => x !== null).slice(0, 256)
    : [];

  return {
    version: FEED_STATE_VERSION,
    savedAt: finiteNum(parsed.savedAt) ? parsed.savedAt : 0,
    cursor: Math.floor(parsed.cursor),
    tokens,
    swarms,
    alerts,
    pendingMetadata,
    pendingSignals,
  };
}

/**
 * Write a snapshot atomically (temp file + rename), matching the pattern the
 * settings and performance stores already use. A torn snapshot would be read
 * back as corrupt on the next boot, which is precisely the case this is for.
 */
export async function saveFeedState(
  path: string,
  snapshot: Omit<FeedStateSnapshot, 'version' | 'savedAt'>,
): Promise<void> {
  if (!path) return;
  const data: FeedStateSnapshot = {
    version: FEED_STATE_VERSION,
    savedAt: Date.now(),
    ...snapshot,
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  } catch (err) {
    logger.warn({ err: String(err), path }, 'feed state: could not save snapshot');
  }
}

/** Project a live token down to the persisted shape. */
export function toPersistedToken(t: TrackedToken): PersistedToken {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    totalSupply: t.totalSupply,
    supplyVerified: t.supplyVerified === true,
    stable: t.stable === true,
    discovered: t.discovered === true,
    firstSeen: typeof t.firstSeen === 'number' ? t.firstSeen : Date.now(),
    ...(typeof t.decimals === 'number' ? { decimals: t.decimals } : {}),
  };
}
