/**
 * The outcome ledger's contract: it follows matched decisions honestly, it never
 * invents a baseline, and its buckets say when the numbers are conservative.
 *
 * The failure this suite exists to prevent is a confident scoreboard built on
 * adopted entry prices — a win rate that looks measured but is quietly comparing
 * a token to itself an hour after the signal.
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { OutcomeLedger, DEFAULT_LEDGER_OPTIONS, type LedgerEntryInput } from '../../v2/ledger.js';

const NOW = 1_786_000_000_000;
const TOKEN = '0xtoken0000000000000000000000000000000001';

/**
 * Every test here except the epoch suite predates the rules epoch on the wall clock, and none of
 * them is ABOUT it. `rulesEpochMs: 0` opts them out so a future epoch bump cannot silently turn
 * this whole file green-by-vacancy — a fixture the ledger refuses still "passes" every assertion
 * that only checks what is absent.
 */
const TEST_OPTIONS = { ...DEFAULT_LEDGER_OPTIONS, rulesEpochMs: 0 };

/** A price book we can move between samples. */
function priceBook(initial: Record<string, number | null> = {}) {
  const prices = new Map<string, number | null>(Object.entries(initial));
  return {
    set(token: string, p: number | null) {
      prices.set(token.toLowerCase(), p);
    },
    provider: {
      priceOf: (t: string) => prices.get(t.toLowerCase()) ?? null,
      refreshNow: async () => undefined,
    },
  };
}

function input(over: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    txHash: '0xtx1',
    token: TOKEN,
    tokenSymbol: 'WOOF',
    lanes: ['allocation'],
    eventType: 'distribution',
    wallet: '0xwallet1',
    score: 68,
    seedTier: 'alpha',
    capBand: 'micro',
    marketCap: 100_000,
    pairAgeHours: 1.2,
    firedAt: NOW,
    // Sellability is MEASURED TRUE by default in these fixtures so the win-rate assertions below have
    // something to judge. That is a choice about fixtures, not a default in the code: `open()` treats
    // an absent canSell as 'unknown' and excludes it, which `ledgerSellability.test.ts` pins. Tests
    // about sellability itself belong there; these are about bucketing.
    canSell: { value: true, provenance: 'measured' },
    ...over,
  };
}

/** Drive one sampling pass at a chosen wall-clock time. */
async function sampleAt(ledger: OutcomeLedger, at: number): Promise<void> {
  vi.setSystemTime(at);
  await (ledger as unknown as { sample: () => Promise<void> }).sample();
}

function make(book = priceBook({ [TOKEN]: 1 })) {
  return new OutcomeLedger(book.provider, { ...TEST_OPTIONS, storePath: '' });
}

describe('OutcomeLedger', () => {
  it('stamps the entry price at match time and tracks the peak', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: 1 });
    const ledger = make(book);
    ledger.open(input(), NOW);

    book.set(TOKEN, 3); // +200%
    await sampleAt(ledger, NOW + 120_000);
    book.set(TOKEN, 2); // fell back; the PEAK must survive
    await sampleAt(ledger, NOW + 600_000);

    const r = ledger.list()[0]!;
    expect(r.entryPrice).toBe(1);
    expect(r.entryDelayMs).toBe(0);
    expect(r.maxGainPct).toBe(200);
    expect(r.lastGainPct).toBe(100);
    vi.useRealTimers();
  });

  /**
   * The reason this ledger exists rather than reusing the performance tracker:
   * that one drops any call it cannot price, which here would discard ~97% of
   * allocations — market cap resolves for 3% of them.
   */
  it('keeps a match that has no price yet, and adopts the first quote as a LATE entry', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: null });
    const ledger = make(book);
    ledger.open(input(), NOW);

    let r = ledger.list()[0]!;
    expect(r.entryPrice).toBeNull();
    expect(r.entryDelayMs).toBeNull();

    book.set(TOKEN, 5);
    await sampleAt(ledger, NOW + 300_000);

    r = ledger.list()[0]!;
    expect(r.entryPrice).toBe(5);
    // Flagged, not hidden: this baseline is 5 minutes late and understates the move.
    expect(r.entryDelayMs).toBe(300_000);
    expect(r.maxGainPct).toBe(0);
    vi.useRealTimers();
  });

  /** Negative control: without the adoption branch the record would stay unpriced forever. */
  it('never back-dates an adopted entry as if it were known at match time', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: null });
    const ledger = make(book);
    ledger.open(input(), NOW);
    book.set(TOKEN, 5);
    await sampleAt(ledger, NOW + 300_000);
    const r = ledger.list()[0]!;
    expect(r.entryDelayMs).toBeGreaterThan(0);
    // A late entry must never claim a gain it did not observe.
    expect(r.maxGainPct).toBe(0);
    vi.useRealTimers();
  });

  it('closes a match that never becomes quotable, with the reason kept', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: null });
    const ledger = new OutcomeLedger(book.provider, {
      ...TEST_OPTIONS,
      storePath: '',
      priceGraceHours: 1,
    });
    ledger.open(input(), NOW);
    await sampleAt(ledger, NOW + 2 * 3_600_000);
    const r = ledger.list()[0]!;
    expect(r.closed).toBe(true);
    expect(r.closedReason).toBe('no-price');
    vi.useRealTimers();
  });

  /** A retried trade re-matches; counting it twice would inflate every bucket. */
  it('is idempotent per trade, merging lanes matched on a later evaluation', () => {
    const ledger = make();
    ledger.open(input(), NOW);
    ledger.open(input({ lanes: ['earliest-entry'] }), NOW + 5_000);
    expect(ledger.size).toBe(1);
    expect(ledger.list()[0]!.lanes.sort()).toEqual(['allocation', 'earliest-entry']);
  });

  /**
   * A record opens on the FIRST event, when a wave of one and a wave of forty
   * look identical — so the cohort is told to it as the wave arrives.
   */
  it('grows the cohort as a wave arrives and never shrinks it', () => {
    const ledger = make();
    ledger.open(input(), NOW);
    expect(ledger.list()[0]!.cohortSize).toBe(1);
    // 12 others, plus the trigger wallet the record opened with.
    ledger.noteCohort(TOKEN, Array.from({ length: 12 }, (_, i) => '0xw' + i));
    expect(ledger.list()[0]!.cohortSize).toBe(13);
    ledger.noteCohort(TOKEN, ['0xw0', '0xw1']); // window emptied; the wave still happened
    expect(ledger.list()[0]!.cohortSize).toBe(13);
  });

  /** An outcome has to be attributable to every wallet in the wave, not just the trigger. */
  it('keeps the cohort MEMBERS, so a wave outcome can credit each participant', () => {
    const ledger = make();
    ledger.open(input({ wallet: '0xTrigger' }), NOW);
    ledger.noteCohort(TOKEN, ['0xAAA', '0xBBB']);
    const r = ledger.list()[0]!;
    expect(r.cohortWallets.sort()).toEqual(['0xaaa', '0xbbb', '0xtrigger']);
    expect(r.cohortSize).toBe(3);
  });

  describe('summary', () => {
    it('buckets solo against wave — the 47e1 claim, testable on our own data', async () => {
      vi.useFakeTimers();
      const book = priceBook({ [TOKEN]: 1, '0xtok2': 1 });
      const ledger = make(book);
      ledger.open(input({ txHash: '0xsolo' }), NOW);
      ledger.open(input({ txHash: '0xwave', token: '0xtok2' }), NOW);
      ledger.noteCohort('0xtok2', Array.from({ length: 8 }, (_, i) => '0xw' + i));

      book.set(TOKEN, 4); // solo runs +300%
      book.set('0xtok2', 1.1); // wave goes nowhere
      await sampleAt(ledger, NOW + 120_000);

      const s = ledger.summary();
      const solo = s.byCohort.find((b) => b.label.startsWith('solo'))!;
      const wave = s.byCohort.find((b) => b.label.startsWith('wave'))!;
      expect(solo.count).toBe(1);
      expect(solo.winRatePct).toBe(100);
      expect(wave.count).toBe(1);
      expect(wave.winRatePct).toBe(0);
      vi.useRealTimers();
    });

    it('excludes unpriced records from the averages and counts them separately', () => {
      const book = priceBook({ [TOKEN]: null });
      const ledger = make(book);
      ledger.open(input(), NOW);
      const alloc = ledger.summary().byLane.find((b) => b.label === 'allocation')!;
      expect(alloc.count).toBe(1);
      expect(alloc.unpriced).toBe(1);
      // Never 0% "win rate" off a record that was never measured — and now the type can SAY so.
      // This assertion used to read `toBe(0)` directly under that comment, contradicting it: the
      // intent was always "unknown", but a bare `number` could only spell it as zero. Zero means
      // "none of them won"; null means "none could be judged", and reporting the first when you mean
      // the second is the `safety.ok === true on no data` mistake (facts/types.ts) in another costume.
      expect(alloc.winRatePct).toBeNull();
      expect(alloc.winRateBasis).toBe(0);
      expect(alloc.avgMaxGainPct).toBe(0);
    });

    it('reports how much of a bucket rests on late entries', async () => {
      vi.useFakeTimers();
      const book = priceBook({ [TOKEN]: null });
      const ledger = make(book);
      ledger.open(input(), NOW);
      book.set(TOKEN, 2);
      await sampleAt(ledger, NOW + 600_000);
      const alloc = ledger.summary().byLane.find((b) => b.label === 'allocation')!;
      expect(alloc.lateEntryPct).toBe(100);
      vi.useRealTimers();
    });

    it('splits by seed tier, so alpha vs beta stops being an argument', async () => {
      vi.useFakeTimers();
      const book = priceBook({ [TOKEN]: 1, '0xtok2': 1 });
      const ledger = make(book);
      ledger.open(input({ txHash: '0xa', seedTier: 'alpha' }), NOW);
      ledger.open(input({ txHash: '0xb', token: '0xtok2', seedTier: 'beta' }), NOW);
      book.set(TOKEN, 5);
      await sampleAt(ledger, NOW + 120_000);
      const s = ledger.summary();
      expect(s.bySeedTier.find((b) => b.label === 'alpha')!.bestMaxGainPct).toBe(400);
      expect(s.bySeedTier.find((b) => b.label === 'beta')!.bestMaxGainPct).toBe(0);
      vi.useRealTimers();
    });
  });

  /**
   * Records written before `matched` existed were, by definition, matches — the
   * ledger only followed matches then. Reading them as unmatched would file real
   * matches under the control group and corrupt the comparison it exists for.
   */
  describe('loading older records', () => {
    const legacyShape = (over: Record<string, unknown> = {}) => ({
      id: '0xold',
      token: TOKEN,
      tokenSymbol: 'OLD',
      lanes: ['allocation'],
      eventType: 'distribution',
      wallet: '0xw1',
      score: 68,
      seedTier: 'beta',
      capBand: 'micro',
      entryMarketCap: 90_000,
      pairAgeHours: 1,
      firedAt: NOW,
      entryPrice: 1,
      entryDelayMs: 0,
      lastPrice: 1,
      lastGainPct: 0,
      maxPrice: 1,
      maxGainPct: 0,
      maxGainAt: NOW,
      gain1hPct: null,
      gain6hPct: null,
      gain24hPct: null,
      cohortSize: 1,
      updatedAt: NOW,
      nextSampleAt: NOW,
      closed: false,
      closedReason: null,
      ...over,
    });

    async function loadWith(records: Record<string, unknown>[]) {
      const dir = await mkdtemp(join(tmpdir(), 'v2-ledger-'));
      const path = join(dir, 'outcomes.json');
      await writeFile(path, JSON.stringify(records));
      const ledger = new OutcomeLedger(priceBook().provider, { ...TEST_OPTIONS, storePath: path });
      await ledger.load();
      return ledger;
    }

    it('treats a pre-`matched` record with lanes as a match', async () => {
      const ledger = await loadWith([legacyShape()]);
      expect(ledger.list()[0]!.matched).toBe(true);
      expect(ledger.summary().matched).toBe(1);
    });

    it('backfills the cohort and the grade-at-fire without inventing either', async () => {
      const ledger = await loadWith([legacyShape()]);
      const r = ledger.list()[0]!;
      expect(r.cohortWallets).toEqual(['0xw1']);
      expect(r.walletGradeAtFire).toBe('U');
    });

    /**
     * A record must reach disk without waiting for the next 60s sample tick.
     *
     * [verified 2026-08-09] A `fresh-entry` match on BLINK was written to the diary at 03:50:43 and
     * a deploy restarted the process at 03:50:54. The diary survived — the journal is written
     * synchronously — and the ledger record did not, because `persist()` only ran at the end of
     * `sample()`. So the call appeared in the decision log and was absent from the signal record
     * that exists to follow it to an outcome, and the two disagreed about whether it happened.
     */
    it('writes a newly opened record without waiting for a sample tick', async () => {
      vi.useFakeTimers();
      const dir = await mkdtemp(join(tmpdir(), 'v2-persist-'));
      const path = join(dir, 'outcomes.json');
      const ledger = new OutcomeLedger(priceBook({ [TOKEN]: 1 }).provider, { ...TEST_OPTIONS, storePath: path });
      ledger.open(input(), NOW);

      // The debounce, and nothing else — no sample() call anywhere in this test.
      await vi.advanceTimersByTimeAsync(2_500);
      vi.useRealTimers();
      // Fake timers flush microtasks, not thread-pool file I/O, so the write is still in flight here.
      await new Promise((r) => setTimeout(r, 100));

      const written = JSON.parse(await readFile(path, 'utf8')) as { id: string }[];
      expect(written).toHaveLength(1);
      expect(written[0]!.id).toBe('0xtx1');
    });

    /**
     * The rules epoch. A snapshot outlives a rule change, so without this the ledger keeps serving
     * decisions the current lanes would reject — which is not a stale number but a false one: they
     * land in the scoreboard's averages and in the wallet grades computed off it.
     */
    describe('the rules epoch', () => {
      const HOUR_MS = 3_600_000;
      const EPOCH = NOW + 10 * HOUR_MS;

      /** Same fixture, same load path — only the epoch moves. */
      async function loadAt(epochMs: number, firedAt: number) {
        const dir = await mkdtemp(join(tmpdir(), 'v2-epoch-'));
        const path = join(dir, 'outcomes.json');
        await writeFile(path, JSON.stringify([legacyShape({ firedAt })]));
        const ledger = new OutcomeLedger(priceBook().provider, { ...TEST_OPTIONS, storePath: path, rulesEpochMs: epochMs });
        await ledger.load();
        return ledger;
      }

      it('drops a snapshot record decided under retired rules', async () => {
        const ledger = await loadAt(EPOCH, EPOCH - 1);
        expect(ledger.size).toBe(0);
        expect(ledger.summary().total).toBe(0);
        expect(ledger.summary().matched).toBe(0);
      });

      /**
       * NEGATIVE CONTROL. The same record, one millisecond the other side of the same epoch, must
       * survive — otherwise "drops it" above would also pass on a ledger that loads nothing at all,
       * which is the failure mode a load-time filter is most likely to have.
       */
      it('keeps the same record when it falls on or after the epoch', async () => {
        const ledger = await loadAt(EPOCH, EPOCH);
        expect(ledger.size).toBe(1);
        expect(ledger.summary().matched).toBe(1);
      });

      /**
       * The retry queue re-evaluates trades long after their block time, so the load-time drop is
       * only half the guard: without this a retired decision walks straight back in seconds later.
       */
      it('refuses to open a record whose event predates the epoch', () => {
        const ledger = new OutcomeLedger(priceBook().provider, { ...TEST_OPTIONS, storePath: '', rulesEpochMs: EPOCH });
        ledger.open(input({ txHash: '0xold', firedAt: EPOCH - 1 }), EPOCH + HOUR_MS);
        expect(ledger.size).toBe(0);
        // Judged late, but the EVENT is under current rules — kept, because what matters is which
        // rules were live when it happened, not when we got around to deciding.
        ledger.open(input({ txHash: '0xnew', firedAt: EPOCH }), EPOCH + HOUR_MS);
        expect(ledger.size).toBe(1);
      });
    });
  });

  /** The rate-limit guard: a wave of allocations of one coin must cost one quote. */
  it('dedupes quotes by token and caps refreshes per tick', async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    const prices = new Map<string, number>();
    const ledger = new OutcomeLedger(
      {
        priceOf: (t) => prices.get(t.toLowerCase()) ?? 1,
        refreshNow: async (t) => {
          refreshes++;
          prices.set(t.toLowerCase(), 1);
        },
      },
      { ...TEST_OPTIONS, storePath: '', maxRefreshPerTick: 3 },
    );
    // 10 allocations of ONE token, plus 10 distinct tokens.
    for (let i = 0; i < 10; i++) ledger.open(input({ txHash: `0xsame${i}` }), NOW);
    for (let i = 0; i < 10; i++) {
      ledger.open(input({ txHash: `0xdiff${i}`, token: `0xtok${i}` }), NOW);
    }
    await sampleAt(ledger, NOW + 60_000);
    expect(refreshes).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });

  it('does not sample a record more often than its age tier allows', async () => {
    vi.useFakeTimers();
    let refreshes = 0;
    const ledger = new OutcomeLedger(
      { priceOf: () => 1, refreshNow: async () => void refreshes++ },
      { ...TEST_OPTIONS, storePath: '' },
    );
    ledger.open(input(), NOW);
    await sampleAt(ledger, NOW + 1_000);
    const after = refreshes;
    // A fresh record samples every 60s; a tick 10s later must not re-quote it.
    await sampleAt(ledger, NOW + 11_000);
    expect(refreshes).toBe(after);
    vi.useRealTimers();
  });
});

/**
 * The tracking window is the measurement window.
 *
 * A record stops sampling when the window ends, so its peak FREEZES there — and peak is the whole
 * measurement, and now the whole basis for a wallet grade. At 24h a coin that ran on day two was
 * recorded as flat, and every wallet behind it was graded on a number that never happened.
 *
 * This became the binding constraint once grading stopped waiting for a record to close: `closed`
 * no longer means "ready to judge", only "we stopped looking".
 */
describe('a peak that arrives after the first day', () => {
  const HOUR = 3_600_000;

  it('is caught inside the window', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: 1 });
    const ledger = make(book);
    ledger.open(input(), NOW);

    // Flat for a day and a half, then it runs.
    await sampleAt(ledger, NOW + 36 * HOUR);
    book.set(TOKEN, 4);
    await sampleAt(ledger, NOW + 48 * HOUR);

    const r = ledger.list(10)[0]!;
    expect(r.closed).toBe(false);
    expect(r.maxGainPct).toBeCloseTo(300, 0);
    vi.useRealTimers();
  });

  it('is missed once the window has ended, which is what bounds the cost', async () => {
    vi.useFakeTimers();
    const book = priceBook({ [TOKEN]: 1 });
    const ledger = make(book);
    ledger.open(input(), NOW);

    // Past the 72h window: the record closes, and a later run is not recorded.
    await sampleAt(ledger, NOW + 73 * HOUR);
    book.set(TOKEN, 10);
    await sampleAt(ledger, NOW + 96 * HOUR);

    const r = ledger.list(10)[0]!;
    expect(r.closed).toBe(true);
    expect(r.closedReason).toBe('tracked-out');
    expect(r.maxGainPct).toBeCloseTo(0, 0);
    vi.useRealTimers();
  });
});
