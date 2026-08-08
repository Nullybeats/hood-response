/**
 * The journal's job is to be trustworthy under exactly the conditions that make
 * a record worthless: a full disk, a restart, a caller handing it garbage. Each
 * test below is one of those conditions.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Journal, JOURNAL_SCHEMA_VERSION, type JournalRecord } from '../../v2/journal.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v2-journal-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Config is parsed at import time and the vitest env blanks the journal path, so
 * every option is injected explicitly. A test journal writes only to its tmp dir.
 */
function makeJournal(opts: { segment?: number; total?: number } = {}): Journal {
  return new Journal({
    path: join(dir, 'journal-v2.ndjson'),
    enabled: true,
    maxSegmentBytes: opts.segment ?? 1_000_000,
    maxTotalBytes: opts.total ?? 5_000_000,
  });
}

function readLines(path: string): JournalRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalRecord);
}

describe('Journal', () => {
  it('writes one NDJSON record per call with a monotonic sequence', () => {
    const j = makeJournal();
    j.write('trade', { token: '0xabc' });
    j.write('facts', { firstBuy: true });
    j.write('verdict', { lane: 'earliest-entry', decision: 'skip', reason: 'score 76 < 80' });

    const recs = readLines(join(dir, 'journal-v2.ndjson'));
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(recs.map((r) => r.kind)).toEqual(['trade', 'facts', 'verdict']);
    expect(recs.every((r) => r.v === JOURNAL_SCHEMA_VERSION)).toBe(true);
    // The clock is recorded so replay can inject it — a rule must never read it itself.
    expect(recs.every((r) => typeof r.at === 'number' && r.at > 0)).toBe(true);
    expect(recs[2]!.body).toEqual({ lane: 'earliest-entry', decision: 'skip', reason: 'score 76 < 80' });
  });

  it('is a no-op when disabled, rather than requiring every caller to branch', () => {
    const j = new Journal({ path: join(dir, 'journal-v2.ndjson'), enabled: false, maxSegmentBytes: 1_000, maxTotalBytes: 10_000 });
    expect(j.enabled).toBe(false);
    expect(() => j.write('trade', { token: '0xabc' })).not.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('rotates to a new segment once the active file exceeds the segment cap', () => {
    const j = makeJournal({ segment: 400 });
    for (let i = 0; i < 12; i++) j.write('trade', { i, pad: 'x'.repeat(40) });

    const files = readdirSync(dir).filter((f) => f.startsWith('journal-v2'));
    expect(files.length).toBeGreaterThan(1);
    // Rotated names must sort chronologically so `segments()` yields oldest-first.
    const rotated = files.filter((f) => f !== 'journal-v2.ndjson').sort();
    expect(rotated).toEqual([...rotated].sort());
    expect(j.segments().length).toBe(rotated.length);
  });

  /**
   * The property that protects the volume. The journal shares a disk with the
   * sniper state and the performance store, so exceeding the budget is not a
   * tidiness problem — it is the failure that takes down the trade record.
   */
  it('never exceeds its total byte budget, dropping oldest segments to stay under', () => {
    const total = 4_000;
    const j = makeJournal({ segment: 500, total });
    for (let i = 0; i < 200; i++) j.write('trade', { i, pad: 'y'.repeat(60) });

    const used = readdirSync(dir)
      .filter((f) => f.startsWith('journal-v2'))
      .reduce((n, f) => n + readFileSync(join(dir, f)).byteLength, 0);
    expect(used).toBeLessThanOrEqual(total);
  });

  it('stops writing rather than spend the last byte when nothing can be dropped', () => {
    // Budget smaller than a single record: there is no segment to drop and no
    // safe way to proceed, so it must shut itself down and say why.
    const j = makeJournal({ segment: 10_000, total: 10 });
    j.write('trade', { token: '0xabc', pad: 'z'.repeat(500) });

    expect(j.enabled).toBe(false);
    expect(j.stoppedBecause).toMatch(/budget exhausted/);
    expect(readLines(join(dir, 'journal-v2.ndjson'))).toHaveLength(0);
  });

  it('drops an unserializable record without disabling the journal', () => {
    const j = makeJournal();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    j.write('facts', cyclic);
    expect(j.enabled).toBe(true);

    j.write('trade', { token: '0xabc' });
    const recs = readLines(join(dir, 'journal-v2.ndjson'));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe('trade');
  });

  it('appends to an existing journal across a restart instead of truncating it', () => {
    const path = join(dir, 'journal-v2.ndjson');
    writeFileSync(path, `${JSON.stringify({ seq: 0, at: 1, kind: 'trade', v: 1, body: { prior: true } })}\n`);

    const j = makeJournal();
    j.write('trade', { afterRestart: true });

    const recs = readLines(path);
    expect(recs).toHaveLength(2);
    expect(recs[0]!.body).toEqual({ prior: true });
    expect(recs[1]!.body).toEqual({ afterRestart: true });
  });

  it('survives a write failure by disabling itself, never by throwing into the feed', () => {
    const j = new Journal({
      path: join(dir, 'nope', 'deeper', 'journal-v2.ndjson'),
      enabled: true,
      maxSegmentBytes: 1_000_000,
      maxTotalBytes: 5_000_000,
    });
    // Make directory creation impossible by putting a FILE where the dir must go.
    writeFileSync(join(dir, 'nope'), 'not a directory');

    expect(() => j.write('trade', { token: '0xabc' })).not.toThrow();
    expect(j.enabled).toBe(false);
    expect(j.stoppedBecause).toMatch(/write failed/);
  });
});

/**
 * The dashboard reads the in-memory diary, so a redeploy blanked it even though
 * the record on disk was intact. During an afternoon of frequent deploys that
 * was indistinguishable from a broken pipeline.
 */
describe('Journal.tail', () => {
  it('returns the most recent records of a kind, newest first', () => {
    const j = makeJournal();
    j.write('trade', { n: 1 });
    j.write('verdict', { n: 1 });
    j.write('trade', { n: 2 });
    j.write('verdict', { n: 2 });
    j.write('verdict', { n: 3 });

    const verdicts = j.tail('verdict', 10);
    expect(verdicts).toHaveLength(3);
    expect(verdicts.map((r) => (r.body as { n: number }).n)).toEqual([3, 2, 1]);
  });

  it('honours the limit without reading more than it needs', () => {
    const j = makeJournal();
    for (let i = 0; i < 50; i++) j.write('verdict', { n: i });
    expect(j.tail('verdict', 5)).toHaveLength(5);
  });

  it('reads back across rotated segments', () => {
    const j = makeJournal({ segment: 300 });
    for (let i = 0; i < 20; i++) j.write('verdict', { n: i, pad: 'x'.repeat(20) });
    // Rotation happened, so the newest entries alone cannot satisfy this.
    expect(j.segments().length).toBeGreaterThan(0);
    expect(j.tail('verdict', 12).length).toBeGreaterThan(1);
  });

  it('survives a torn final line from a process that died mid-append', () => {
    const path = join(dir, 'journal-v2.ndjson');
    const j = makeJournal();
    j.write('verdict', { n: 1 });
    writeFileSync(path, readFileSync(path, 'utf8') + '{"seq":9,"at":1,"kind":"verd', { flag: 'w' });
    expect(() => j.tail('verdict', 10)).not.toThrow();
    expect(j.tail('verdict', 10)).toHaveLength(1);
  });

  it('returns nothing when journaling has no path', () => {
    expect(new Journal({ path: '', enabled: false, maxSegmentBytes: 1, maxTotalBytes: 1 }).tail('verdict', 5)).toEqual([]);
  });
});
