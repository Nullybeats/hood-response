import { describe, it, expect } from 'vitest';
import { buildFactSheet, type SheetInputs } from '../../v2/facts/sheet.js';
import { DEFAULT_LANES, evaluateLanes } from '../../v2/lanes.js';
import { scoreSheet } from '../../v2/score.js';
import type { SwapEvent } from '../../types.js';

const TOKEN = '0xaaa0000000000000000000000000000000000001';
const WALLET = '0xbbb0000000000000000000000000000000000002';

function trade(over: Partial<SwapEvent> = {}): SwapEvent {
  return {
    txHash: '0xtx',
    wallet: WALLET,
    token: TOKEN,
    tokenSymbol: 'GEM',
    direction: 'BUY',
    amount: 1000,
    usdValue: 500,
    blockNumber: 1,
    logIndex: 0,
    timestamp: Date.now(),
    ...over,
  } as SwapEvent;
}

function inputs(over: Partial<SheetInputs> = {}): SheetInputs {
  return {
    marketCap: 60_000,
    pairAgeHours: 2,
    pairAgeSource: 'test',
    canSell: true,
    outcomesByWallet: new Map(),
    crowdWallets: [],
    cohortSize: 1,
    firstBuy: true,
    rotatedFrom: null,
    eventType: 'transfer',
    seedTier: 'alpha',
    ...over,
  } as SheetInputs;
}

function verdictFor(laneId: string, over: Partial<SheetInputs>) {
  const sheet = buildFactSheet(trade(), inputs(over));
  const score = scoreSheet(sheet);
  return evaluateLanes(sheet, score, DEFAULT_LANES).find((v) => v.laneId === laneId)!;
}

/**
 * An attribution gap is not evidence the trade did not happen — so a transfer is
 * admitted, but ONLY on the one proof we can actually obtain: sellability.
 */
describe('unattributed transfers are admitted on sellability', () => {
  it('a SELLABLE transfer is allowed past the sellability condition', () => {
    const v = verdictFor('solo-buy', { eventType: 'transfer', canSell: true });
    const sellCheck = v.results.find((r) => r.detail.includes('sellable'));
    expect(sellCheck?.outcome).toBe('met');
  });

  it('a NON-sellable transfer is refused — the honeypot case', () => {
    const v = verdictFor('solo-buy', { eventType: 'transfer', canSell: false });
    expect(v.matched).toBe(false);
    expect(v.reason).toContain('NOT sellable');
  });

  it('an UNKNOWN sellability blocks rather than assumes (rule 7)', () => {
    const v = verdictFor('solo-buy', { eventType: 'transfer', canSell: null });
    expect(v.matched).toBe(false);
    // `unknown`, not `unmet`: a gap to go and close, not a working filter.
    expect(v.blockedByUnknown).toBe(true);
  });

  it('a VERIFIED BUY is NOT gated on sellability — c9dea13 stands', () => {
    // Sellability stops a BUY, not a SIGNAL. A proven purchase still signals
    // with no honeypot answer; the sniper refuses the buy if it cannot sell.
    const v = verdictFor('solo-buy', { eventType: 'verified-buy', canSell: null });
    expect(v.blockedByUnknown).toBe(false);
    const sellCheck = v.results.find((r) => r.detail.includes('sellability not required'));
    expect(sellCheck?.outcome).toBe('met');
  });
});
