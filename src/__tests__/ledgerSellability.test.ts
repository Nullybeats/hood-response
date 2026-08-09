import { describe, it, expect } from 'vitest';
import { OutcomeLedger, DEFAULT_LEDGER_OPTIONS, type LedgerPrice } from '../v2/ledger.js';

/**
 * Sellability in the outcome ledger.
 *
 * The ledger scored peak PRICE and called it performance. A coin whose price moons precisely BECAUSE
 * nobody can sell it therefore counted as a win, and nothing in `ledger.ts` referenced canSell,
 * honeypots or rugs at all.
 *
 * [verified 2026-08-09, live feed] the concrete damage:
 *   • MEW fired UNSCREENED, peaked +756%, sat at -95%, and was recorded as a win.
 *   • 16 F-grade "wins" were 11 distinct coins — one address counted SIX times.
 *   • F-grade win rate read 1.9% on peak and 1.1% on current value.
 *
 * Three rules follow, and this file pins each one:
 *   1. `measured false` — checked and trapped — can never be a win. A gain you cannot exit is not one.
 *   2. `unknown` — nobody checked — is neither a win NOR a loss. domain.md rule 1: never penalise a
 *      coin for what merely could not be verified. It is set aside and COUNTED, so a small basis
 *      under a large count is visible instead of flattering.
 *   3. One coin is one vote in the per-token rate, so a repeated fire cannot carry a bucket.
 *
 * Tokens are referenced by ADDRESS throughout, per verification.md: ~68 distinct tokens in the index
 * share the symbol BRODIE, so a symbol is not an identifier.
 */

/** Known-good runner — verification.md, grade `runner`, canSell = true. */
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const IF_TOKEN = '0x232cdfc415d10b673845d83dc02ba2eabe7e30d1';
/** Known rugs / honeypots — verification.md negative controls. */
const PIPEDOG = '0x5cb6f181081301b44905f3ae15419112ecabd8a6';
const ANSEMCAT = '0x9727b500ac8726c716f018e5d3ca871481245065';

const T0 = 1_800_000_000_000;

/** Prices are injected, so these tests are about SCORING and never touch a network. */
function priceStub(prices: Record<string, number>): LedgerPrice {
  return {
    priceOf: (t: string) => prices[t.toLowerCase()] ?? null,
    marketCapOf: () => null,
    refreshNow: async () => undefined,
  } as unknown as LedgerPrice;
}

function ledger(prices: Record<string, number>) {
  return new OutcomeLedger(priceStub(prices), {
    ...DEFAULT_LEDGER_OPTIONS,
    storePath: '',
    rulesEpochMs: 0,
    winThresholdPct: 50,
  });
}

type Sell = { value: boolean | null; provenance: 'measured' | 'unknown' | 'failed' };

function fire(
  l: OutcomeLedger,
  opts: { id: string; token: string; canSell?: Sell; grade?: 'A' | 'F' },
) {
  l.open(
    {
      txHash: opts.id,
      token: opts.token,
      tokenSymbol: 'SYM',
      lanes: ['allocation'],
      eventType: 'buy',
      wallet: '0x' + '1'.repeat(40),
      walletGradeAtFire: opts.grade ?? 'F',
      score: 80,
      seedTier: 'alpha',
      capBand: 'micro',
      marketCap: 100_000,
      pairAgeHours: 1,
      firedAt: T0,
      canSell: opts.canSell,
    },
    T0,
  );
}

describe('outcome ledger — sellability gates the win rate', () => {
  it('a coin CHECKED and unsellable is never a win, however far its price ran', async () => {
    // The honeypot case, with a real honeypot address as the control (PIPEDOG, verification.md).
    const l = ledger({ [PIPEDOG]: 1 });
    fire(l, { id: '0xa', token: PIPEDOG, canSell: { value: false, provenance: 'measured' } });
    fire(l, { id: '0xb', token: CASHCAT, canSell: { value: true, provenance: 'measured' } });

    const recs = l.list(10);
    // Both ran +900%. Only the sellable one may count.
    for (const r of recs) {
      r.entryPrice = 1;
      r.maxPrice = 10;
      r.maxGainPct = 900;
      r.lastGainPct = 900;
    }
    const g = l.summary().byWalletGrade.find((b) => b.label === 'F')!;

    expect(g.count).toBe(2);
    expect(g.unsellable).toBe(1);
    expect(g.winRateBasis).toBe(1); // the honeypot is not judgeable
    expect(g.winRatePct).toBe(100); // and the one sellable coin did win
  });

  it('an UNSCREENED coin is set aside, not counted against it', async () => {
    // MEW's shape: fired unscreened, ran hard. domain.md rule 1 — unknown is not a loss.
    const l = ledger({ [ANSEMCAT]: 1 });
    fire(l, { id: '0xc', token: ANSEMCAT, canSell: { value: null, provenance: 'unknown' } });
    const r = l.list(1)[0]!;
    r.entryPrice = 1; r.maxPrice = 8.56; r.maxGainPct = 756; r.lastGainPct = -95;

    const g = l.summary().byWalletGrade.find((b) => b.label === 'F')!;
    expect(g.count).toBe(1);
    expect(g.unverified).toBe(1);
    // Neither a win nor a loss: there is nothing to compute a rate over, so the rate is NULL rather
    // than 0. A 0% next to a count of 1 would read as "it lost", which is the penalty domain.md
    // rule 1 forbids for something merely unverified.
    expect(g.winRateBasis).toBe(0);
    expect(g.winRatePct).toBeNull();
    // But the +756% peak still shows in the descriptive stats — it did happen.
    expect(g.bestMaxGainPct).toBe(756);
  });

  it('omitting sellability entirely defaults to unknown, never to sellable', async () => {
    // The dangerous default. A cheerful one would silently readmit every unscreened coin.
    const l = ledger({ [CASHCAT]: 1 });
    fire(l, { id: '0xd', token: CASHCAT }); // no canSell passed at all
    const r = l.list(1)[0]!;
    expect(r.canSellProvenanceAtFire).toBe('unknown');
    expect(r.canSellAtFire).toBeNull();
  });

  it('one coin is one vote — six fires on the same address cannot carry a bucket', async () => {
    // [verified 2026-08-09] ROB accounted for 6 of 16 F-grade "wins".
    const l = ledger({ [CASHCAT]: 1, [IF_TOKEN]: 1 });
    for (let i = 0; i < 6; i++) {
      fire(l, { id: '0xrob' + i, token: CASHCAT, canSell: { value: true, provenance: 'measured' } });
    }
    fire(l, { id: '0xloser', token: IF_TOKEN, canSell: { value: true, provenance: 'measured' } });

    for (const r of l.list(20)) {
      r.entryPrice = 1;
      const winner = r.token === CASHCAT;
      r.maxPrice = winner ? 3 : 1;
      r.maxGainPct = winner ? 200 : 0;
      r.lastGainPct = r.maxGainPct;
    }
    const g = l.summary().byWalletGrade.find((b) => b.label === 'F')!;

    expect(g.count).toBe(7);
    expect(g.distinctTokens).toBe(2);
    // Per DECISION the repeated coin dominates: 6 of 7.
    expect(g.winRatePct).toBeCloseTo(85.7, 0);
    // Per TOKEN it is one win out of two coins — the honest read of "which coins ran".
    expect(g.winRateByTokenBasis).toBe(2);
    expect(g.winRateByTokenPct).toBe(50);
  });

  it('reports realizable separately from peak', async () => {
    // HORACE's shape: +104% peak, -73% now. The ledger called that a win.
    const l = ledger({ [CASHCAT]: 1 });
    fire(l, { id: '0xe', token: CASHCAT, canSell: { value: true, provenance: 'measured' } });
    const r = l.list(1)[0]!;
    r.entryPrice = 1; r.maxPrice = 2.04; r.maxGainPct = 104; r.lastGainPct = -73;

    const g = l.summary().byWalletGrade.find((b) => b.label === 'F')!;
    expect(g.winRatePct).toBe(100); // by peak, it "won"
    expect(g.winRateRealizedPct).toBe(0); // by current value, it did not
    expect(g.medianLastGainPct).toBe(-73);
  });

  it('a rate always ships with the n behind it', async () => {
    // A 100% win rate over one record and over two hundred must not read alike.
    const l = ledger({ [CASHCAT]: 1 });
    fire(l, { id: '0xf', token: CASHCAT, canSell: { value: true, provenance: 'measured' } });
    const r = l.list(1)[0]!;
    r.entryPrice = 1; r.maxPrice = 5; r.maxGainPct = 400; r.lastGainPct = 400;

    const g = l.summary().byWalletGrade.find((b) => b.label === 'F')!;
    expect(g.winRatePct).toBe(100);
    expect(g.winRateBasis).toBe(1);
  });
});
