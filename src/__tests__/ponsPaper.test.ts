import { describe, it, expect, beforeEach } from 'vitest';
import { openPaperPosition, tickPaper, paperOpen, paperClosed, paperSummary, paperHolds } from '../pons/paper.js';

/**
 * Paper book — the half that says whether the strategy makes money.
 *
 * The exits pinned here are the wide/runner shape the replay evidence chose (stop 40 / trail 50 /
 * recoup 3×), NOT the feed sniper's defaults. Getting these wrong doesn't fail loudly; it quietly
 * produces a PnL number for a strategy nobody is running.
 */

const drain = async () => {
  // close everything left open so each test starts clean
  for (let i = 0; i < 4 && paperOpen().length; i++) await tickPaper(async () => 0);
};

beforeEach(async () => { await drain(); });

const openOne = (token: string, ethIn = 0.001, tokens = 100_000) =>
  openPaperPosition({ token, symbol: 'T', deployer: '0xdead', ethIn, tokens });

describe('paper positions', () => {
  it('opens on a simulated fill and marks at cost', () => {
    openOne('0xaaa');
    const p = paperOpen().find((x) => x.token === '0xaaa');
    expect(p).toBeDefined();
    expect(p!.entryPrice).toBeCloseTo(0.001 / 100_000);
    expect(paperHolds('0xAAA')).toBe(true); // case-insensitive
  });

  it('refuses a duplicate and refuses a zero-token fill', () => {
    openOne('0xbbb');
    openOne('0xbbb');
    expect(paperOpen().filter((x) => x.token === '0xbbb')).toHaveLength(1);
    openPaperPosition({ token: '0xzero', symbol: 'Z', deployer: '0x', ethIn: 0.001, tokens: 0 });
    expect(paperHolds('0xzero')).toBe(false);
  });

  it('stops out at −40%', async () => {
    openOne('0xccc');
    await tickPaper(async () => 0.0005); // −50%
    expect(paperHolds('0xccc')).toBe(false);
    expect(paperClosed().find((c) => c.token === '0xccc')!.exitReason).toBe('stop');
  });

  it('holds through a dip shallower than the stop', async () => {
    openOne('0xddd');
    await tickPaper(async () => 0.0007); // −30%, inside the 40% stop
    expect(paperHolds('0xddd')).toBe(true);
  });

  it('recoups the stake at 3x and keeps riding', async () => {
    openOne('0xeee');
    await tickPaper(async () => 0.003); // 3x
    const p = paperOpen().find((x) => x.token === '0xeee')!;
    expect(p.recoupDone).toBe(true);
    expect(p.bankedEth).toBeGreaterThan(0);
    expect(p.remainingFrac).toBeLessThan(1);
  });

  /** A null quote is liquidity leaving, but ONE failed RPC must not book a total loss. */
  it('needs two consecutive unquotable ticks before calling a rug', async () => {
    openOne('0xfff');
    await tickPaper(async () => null);
    expect(paperHolds('0xfff')).toBe(true);
    await tickPaper(async () => null);
    expect(paperHolds('0xfff')).toBe(false);
    expect(paperClosed().find((c) => c.token === '0xfff')!.exitReason).toBe('rug');
  });

  it('a single null then a recovery does not close the position', async () => {
    openOne('0xf10');
    await tickPaper(async () => null);
    await tickPaper(async () => 0.0012);
    expect(paperHolds('0xf10')).toBe(true);
  });

  it('trails 50% off the peak', async () => {
    openOne('0x111');
    await tickPaper(async () => 0.002); // peak 2x
    await tickPaper(async () => 0.0009); // −55% off peak
    expect(paperClosed().find((c) => c.token === '0x111')!.exitReason).toBe('trailing');
  });

  it('books a loss net of gas and reports it in the summary', async () => {
    openOne('0x222');
    await tickPaper(async () => 0.0004);
    const c = paperClosed().find((x) => x.token === '0x222')!;
    expect(c.pnlEth).toBeLessThan(0);
    expect(c.multiple).toBeLessThan(1);
    const s = paperSummary();
    expect(s.closed).toBeGreaterThan(0);
    expect(s.winRatePct).not.toBeNull();
  });
});
