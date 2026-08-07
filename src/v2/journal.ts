/**
 * v2 journal — the append-only record every later phase is measured against.
 *
 * The v2 brain is built on a rule the legacy engine broke repeatedly: a claim is
 * only worth as much as the evidence behind it. So before any classifier, score
 * or lane exists, the input and every artifact derived from it are written down.
 * That buys two things nothing else can:
 *
 *  - Replay. `scripts/replay.mjs` pipes a journal back through the pipeline, so a
 *    rule change is evaluated against real recorded traffic instead of a fixture
 *    someone invented. The legacy engine had no such harness, which is why a
 *    dedup collision could swallow ENTRY alerts for months unnoticed.
 *  - Calibration. "Do higher-scored alerts actually peak higher" is answerable
 *    only if the score AND the input that produced it were both persisted.
 *
 * Determinism is the contract. Records carry the wall clock so replay can inject
 * it; nothing downstream of this file may call Date.now() inside a rule, or the
 * same journal would produce two different answers and the harness would be
 * worthless.
 *
 * BOUNDED BY CONSTRUCTION. The Railway volume this writes to sits at ~85% used
 * with no pruning anywhere in production (`AttributionLedger.pruneBefore` is
 * never called outside a test), and a full volume does not degrade gracefully —
 * it fails the sniper state, the performance store and the feed state at once,
 * with SQLite write errors of the kind that produced the orphan-WAL corruption
 * scare. So the journal enforces a hard total byte budget itself rather than
 * trusting an operator to notice: oldest segments are deleted to stay under it,
 * and if it cannot, it stops writing rather than consume the last free byte.
 * Losing the tail of an observational record is recoverable. Filling the volume
 * that holds the trade record is not.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { config } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * What produced the record. Kept as a closed union so a replay can dispatch on
 * it without guessing, and so a new artifact type is a deliberate schema change
 * rather than a silently-ignored field.
 */
export type JournalKind =
  /** A verified trade entering the pipeline — the only legitimate v2 input. */
  | 'trade'
  /** The fact sheet built from a trade, with each fact's tri-state provenance. */
  | 'facts'
  /** The unknown-law verdict: pass | retry | block, and why. */
  | 'gate'
  /** Score with its per-dial breakdown. */
  | 'score'
  /** A lane's verdict on an alert, including the near-misses. */
  | 'verdict';

export interface JournalRecord {
  /** Monotonic within a process run; makes ordering explicit rather than implied by file position. */
  seq: number;
  /** Wall clock at write. Replay injects this back as the pipeline's clock — rules never read it themselves. */
  at: number;
  kind: JournalKind;
  /** Schema version of `body`, so an old journal stays readable after the shape moves. */
  v: number;
  body: unknown;
}

/** Bumped when a body shape changes incompatibly. Replay refuses versions it does not know. */
export const JOURNAL_SCHEMA_VERSION = 1;

const SEGMENT_PREFIX = 'journal-v2';
const SEGMENT_SUFFIX = '.ndjson';

/**
 * Append-only NDJSON writer with size-based rotation and a hard total budget.
 *
 * Synchronous writes on purpose: the journal must record the input BEFORE the
 * pipeline acts on it, or a crash mid-decision leaves an artifact whose cause
 * was never written. At this volume (single-digit records per alert, and the
 * live feed produces alerts in the single digits per day) the cost is noise.
 */
export interface JournalOptions {
  path: string;
  /**
   * Injected rather than read from `config` inside the class, so a test can run
   * a real journal against a tmp path. Reading the global here would make the
   * class untestable in exactly the environment that blanks store paths to keep
   * tests off the live volume.
   */
  enabled: boolean;
  maxSegmentBytes: number;
  maxTotalBytes: number;
}

export class Journal {
  private seq = 0;
  private currentBytes = 0;
  private disabledReason: string | null = null;
  private readonly path: string;
  private readonly configured: boolean;
  private readonly maxSegmentBytes: number;
  private readonly maxTotalBytes: number;

  constructor(opts: Partial<JournalOptions> = {}) {
    this.path = opts.path ?? config.V2_JOURNAL_PATH;
    this.configured = opts.enabled ?? config.V2_JOURNAL_ENABLED;
    this.maxSegmentBytes = opts.maxSegmentBytes ?? config.V2_JOURNAL_MAX_SEGMENT_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? config.V2_JOURNAL_MAX_TOTAL_BYTES;
  }

  /** False when journaling is off or has shut itself down; callers need not branch, `write` is a no-op. */
  get enabled(): boolean {
    return this.configured && this.path.length > 0 && this.disabledReason == null;
  }

  /** Why writing stopped, for the health endpoint. Null while healthy. */
  get stoppedBecause(): string | null {
    return this.disabledReason;
  }

  /**
   * Record one artifact. Never throws: a journal failure must not take down the
   * feed it is observing. A write that cannot be made safely disables the
   * journal and says so once, rather than failing on every subsequent alert.
   */
  write(kind: JournalKind, body: unknown): void {
    if (!this.enabled) return;
    const record: JournalRecord = {
      seq: this.seq++,
      at: Date.now(),
      kind,
      v: JOURNAL_SCHEMA_VERSION,
      body,
    };
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (err) {
      // A body carrying a cycle or a BigInt is a bug in the caller, not a reason
      // to stop journaling everything else.
      logger.warn({ kind, err: String(err).slice(0, 200) }, 'v2 journal: unserializable body, record dropped');
      return;
    }
    const bytes = Buffer.byteLength(line);
    try {
      this.ensureDir();
      if (this.currentBytes === 0) this.currentBytes = this.sizeOf(this.path);
      if (this.currentBytes + bytes > this.maxSegmentBytes) this.rotate();
      if (!this.enforceBudget(bytes)) return;
      appendFileSync(this.path, line);
      this.currentBytes += bytes;
    } catch (err) {
      this.stop(`write failed: ${String(err).slice(0, 160)}`);
    }
  }

  /** Segment files oldest-first. Exposed for the replay harness and for tests. */
  segments(): string[] {
    const dir = dirname(this.path);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_SUFFIX) && f !== basenameOf(this.path))
      .sort()
      .map((f) => join(dir, f));
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private sizeOf(p: string): number {
    try {
      return existsSync(p) ? statSync(p).size : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Close the active segment under a sortable name.
   *
   * Named from the record sequence and the clock rather than a counter, so two
   * segments never collide after a restart resets the counter — the failure that
   * would silently overwrite recorded history.
   */
  private rotate(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = join(dirname(this.path), `${SEGMENT_PREFIX}-${stamp}${SEGMENT_SUFFIX}`);
    try {
      if (existsSync(this.path)) renameSync(this.path, rotated);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 160) }, 'v2 journal: rotate failed');
    }
    this.currentBytes = 0;
  }

  /**
   * Delete oldest segments until the incoming write fits inside the budget.
   *
   * Returns false when it cannot get there — at which point writing stops
   * entirely. The alternative, writing "just this one more", is how a volume
   * fills: every individual record looks affordable.
   */
  private enforceBudget(incoming: number): boolean {
    let total = this.totalBytes();
    if (total + incoming <= this.maxTotalBytes) return true;
    for (const seg of this.segments()) {
      const size = this.sizeOf(seg);
      try {
        unlinkSync(seg);
        total -= size;
        logger.info({ seg, freed: size }, 'v2 journal: dropped oldest segment to stay under budget');
      } catch (err) {
        logger.warn({ seg, err: String(err).slice(0, 160) }, 'v2 journal: could not drop segment');
      }
      if (total + incoming <= this.maxTotalBytes) return true;
    }
    this.stop(
      `budget exhausted: ${total + incoming} bytes needed, ${this.maxTotalBytes} allowed, no segments left to drop`,
    );
    return false;
  }

  private totalBytes(): number {
    return this.segments().reduce((n, s) => n + this.sizeOf(s), 0) + this.sizeOf(this.path);
  }

  private stop(reason: string): void {
    if (this.disabledReason) return;
    this.disabledReason = reason;
    logger.error({ reason }, 'v2 journal: STOPPED writing (the feed continues; the record does not)');
  }
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Process-wide journal, configured from env. */
export const journal = new Journal();
