/**
 * The fact sheet is the structural fix for the legacy kind race. The first test
 * below is the one that matters most: the exact scenario where the old engine
 * silently dropped its premium signal must now produce a single sheet carrying
 * BOTH sets of attributes, with nothing suppressed.
 */
import { describe, expect, it } from 'vitest';

import { buildFactSheet, bandFor, deriveKindLabel, type SheetInputs, type VerifiedTrade } from '../../v2/facts/sheet.js';
import { isKnown } from '../../v2/facts/types.js';
import type { Outcome } from '../../v2/facts/grade.js';

const NOW = 1_786_000_000_000;
const DAY = 86_400_000;
const WALLET = '0xaaaa000000000000000000000000000000000001';

const trade: VerifiedTrade = {
  txHash: '0xtx',
  wallet: WALLET,
  token: '0xtoken0000000000000000000000000000000001',
  tokenSymbol: 'WOOF',
  blockNumber: 1000,
  at: NOW,
  venue: 'swap_v4_poolmanager',
  usdValue: 5000,
};

function strongOutcomes(): Outcome[] {
  return Array.from({ length: 10 }, (_, i) => ({ at: NOW - (i + 1) * DAY, peakMultiple: 2.5 }));
}

function inputs(over: Partial<SheetInputs> = {}): SheetInputs {
  return {
    marketCap: 80_000,
    pairAgeHours: 3,
    pairAgeSource: 'onchain-initialize',
    canSell: true,
    outcomesByWallet: new Map([[WALLET, strongOutcomes()]]),
    crowdWallets: [],
    firstBuy: true,
    rotatedFrom: null,
    ...over,
  };
}

describe('buildFactSheet', () => {
  /**
   * THE REGRESSION. In the legacy engine a first buy of a microcap produced both
   * a SOLO and an ENTRY candidate; SOLO fired first and consumed the shared
   * per-token new-wallet credit, so the ENTRY alert — the only kind PRIME was
   * defined on — was dropped as a duplicate. Production showed the outcome: zero
   * PRIME alerts in 24 hours. One sheet carrying both attributes makes the race
   * impossible to express.
   */
  it('carries first-buy AND microcap attributes on ONE sheet — neither suppresses the other', () => {
    const s = buildFactSheet(trade, inputs({ marketCap: 80_000, firstBuy: true, pairAgeHours: 3 }), NOW);

    expect(s.firstBuy.value).toBe(true); // what ENTRY meant
    expect(s.capBand.value).toBe('micro'); // what SOLO meant
    expect(s.pairAgeHours.value).toBe(3);
    // Both readings are simultaneously true of the same event.
    expect(isKnown(s.firstBuy) && isKnown(s.capBand)).toBe(true);
  });

  it('reports an ungraded wallet as unknown, never as an average grade', () => {
    const s = buildFactSheet(trade, inputs({ outcomesByWallet: new Map() }), NOW);
    expect(s.walletGrade.provenance).toBe('unknown');
    expect(s.walletGrade.value).toBeNull();
    expect(s.walletGradeReason).toMatch(/needed to grade/);
  });

  it('grades a wallet with a real track record', () => {
    const s = buildFactSheet(trade, inputs(), NOW);
    expect(s.walletGrade.value).toBe('A');
    expect(s.walletGrade.source).toBe('outcomes');
  });

  /** The "🛡️ Safe" bug: an unchecked token must not read as sellable. */
  it('marks sellability unknown when no honeypot check ran', () => {
    const s = buildFactSheet(trade, inputs({ canSell: null }), NOW);
    expect(s.canSell.provenance).toBe('unknown');
    expect(s.canSell.value).toBeNull();
    expect(s.canSell.reason).toMatch(/not checked/);
  });

  it('distinguishes a failed sellability check from an absent one', () => {
    const absent = buildFactSheet(trade, inputs({ canSell: null }), NOW);
    const checkedBad = buildFactSheet(trade, inputs({ canSell: false }), NOW);
    expect(absent.canSell.provenance).toBe('unknown');
    expect(checkedBad.canSell.provenance).toBe('measured');
    expect(checkedBad.canSell.value).toBe(false);
  });

  /** The `totalCapital` bug: an unpriced buy is unknown, not $0. */
  it('treats an unpriced buy as unknown rather than zero', () => {
    const s = buildFactSheet({ ...trade, usdValue: null }, inputs(), NOW);
    expect(s.buyUsd.provenance).toBe('unknown');
    expect(s.buyUsd.value).toBeNull();
  });

  it('leaves cap band unknown when market cap could not be established', () => {
    const s = buildFactSheet(trade, inputs({ marketCap: null }), NOW);
    expect(s.capBand.provenance).toBe('unknown');
    expect(s.marketCap.provenance).toBe('unknown');
  });

  it('names the source of pair age so an on-chain fact outranks an indexer', () => {
    const onchain = buildFactSheet(trade, inputs(), NOW);
    expect(onchain.pairAgeHours.source).toBe('onchain-initialize');
    const indexed = buildFactSheet(trade, inputs({ pairAgeSource: 'dexscreener' }), NOW);
    expect(indexed.pairAgeHours.source).toBe('dexscreener');
  });

  /** The "3 wallets accumulating" bug: crowd quality, not crowd headcount. */
  it('reports crowd quality, and admits when the crowd is entirely ungraded', () => {
    const peer = '0xbbbb000000000000000000000000000000000002';
    const graded = buildFactSheet(
      trade,
      inputs({
        crowdWallets: [WALLET, peer],
        outcomesByWallet: new Map([
          [WALLET, strongOutcomes()],
          [peer, strongOutcomes()],
        ]),
      }),
      NOW,
    );
    expect(graded.crowdSize.value).toBe(2);
    expect(graded.crowdGpa.value).toBe(4); // two A wallets

    const anonymous = buildFactSheet(trade, inputs({ crowdWallets: [peer], outcomesByWallet: new Map() }), NOW);
    expect(anonymous.crowdSize.value).toBe(1);
    expect(anonymous.crowdGpa.provenance).toBe('unknown');
  });

  it('is pure — the same inputs always build the same sheet', () => {
    expect(buildFactSheet(trade, inputs(), NOW)).toEqual(buildFactSheet(trade, inputs(), NOW));
  });
});

describe('bandFor', () => {
  it('places caps in the documented bands', () => {
    expect(bandFor(80_000)).toBe('micro');
    expect(bandFor(125_000)).toBe('micro');
    expect(bandFor(125_001)).toBe('small');
    expect(bandFor(5_000_000)).toBe('mid');
    expect(bandFor(50_000_000)).toBe('large');
  });
});

describe('deriveKindLabel', () => {
  it('renders a legacy label from attributes, for the wire only', () => {
    const entry = buildFactSheet(trade, inputs({ firstBuy: true, pairAgeHours: 3 }), NOW);
    expect(deriveKindLabel(entry)).toBe('ENTRY');

    const solo = buildFactSheet(trade, inputs({ firstBuy: false }), NOW);
    expect(deriveKindLabel(solo)).toBe('SOLO');

    const swarm = buildFactSheet(trade, inputs({ crowdWallets: ['0x1', '0x2'] }), NOW);
    expect(deriveKindLabel(swarm)).toBe('BUY');
  });

  it('does not lose the underlying attributes when it picks one label', () => {
    // A label is a rendering, not a classification: the sheet still knows it was
    // both a first buy and a microcap, whatever single word goes on the wire.
    const s = buildFactSheet(trade, inputs({ firstBuy: true, pairAgeHours: 3, marketCap: 80_000 }), NOW);
    expect(deriveKindLabel(s)).toBe('ENTRY');
    expect(s.capBand.value).toBe('micro');
    expect(s.firstBuy.value).toBe(true);
  });
});
