import { describe, it, expect } from 'vitest';
import {
  headline,
  textBody,
  telegramHtml,
  KIND_EMOJI,
  milestoneHeadline,
  milestoneTextBody,
  milestoneTelegramHtml,
  resultFooter,
  telegramHtmlWithResult,
} from '../notify/format.js';
import type { Swarm } from '../types.js';
import type { TrackedCall } from '../engine/performance.js';

function swarm(over: Partial<Swarm> = {}): Swarm {
  return {
    id: 'a-' + Math.random().toString(36).slice(2),
    kind: 'ENTRY',
    token: '0xtok',
    tokenSymbol: 'GEM',
    walletCount: 1,
    wallets: [],
    walletSummary: '1 alpha',
    walletLabels: [],
    totalUsd: 3000,
    marketCap: 60_000,
    newToken: false,
    dexUrl: 'x',
    priceLive: true,
    priceUsd: 1,
    conviction: 85,
    convictionBreakdown: {
      walletQuality: 0,
      walletCount: 0,
      totalCapital: 0,
      velocity: 0,
      liquidity: 0,
      marketCap: 0,
      historicalAccuracy: 0,
      buySellRatio: 0,
    },
    windowSeconds: 10,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    ...over,
  };
}

describe('PRIME formatting', () => {
  it('leaves non-PRIME alerts unchanged', () => {
    const s = swarm({ prime: false });
    expect(headline(s)).not.toContain('PRIME');
    expect(headline(s)).toContain(KIND_EMOJI.ENTRY);
    expect(textBody(s)).toContain('🪰 SWARM THE FLY 🪰');
    expect(telegramHtml(s)).not.toContain('👑');
  });

  it('crowns the headline and multiplies the kind icon for PRIME alerts', () => {
    const s = swarm({ prime: true });
    const h = headline(s);
    expect(h).toContain('👑 PRIME 👑');
    expect(h).toContain(KIND_EMOJI.ENTRY.repeat(3));
  });

  it('triples the fly in plain text and Telegram headers for PRIME alerts', () => {
    const s = swarm({ prime: true });
    expect(textBody(s)).toContain('🪰🪰🪰 SWARM THE FLY 🪰🪰🪰');
    const html = telegramHtml(s);
    expect(html).toContain('🪰🪰🪰 <b>SWARM THE FLY</b> 🪰🪰🪰');
    expect(html).toContain('👑 PRIME SIGNAL 👑');
  });

  it('does not add PRIME treatment when prime is undefined', () => {
    const s = swarm();
    delete (s as Partial<Swarm>).prime;
    expect(headline(s)).not.toContain('PRIME');
  });
});

describe('ATH market cap on the card', () => {
  it('shows the ATH and % off it when known', () => {
    const s = swarm({ marketCap: 50_000, athMarketCap: 200_000 });
    const body = textBody(s);
    expect(body).toContain('🏔️ ATH');
    expect(body).toContain('(-75%)');
  });

  it('omits the ATH line when unknown', () => {
    const s = swarm({ athMarketCap: null });
    expect(textBody(s)).not.toContain('🏔️');
  });
});

describe('buy bot links', () => {
  it('includes SGM and BSD buy links templated with the token address', () => {
    const s = swarm({ token: '0xdeadbeef' });
    const text = textBody(s);
    expect(text).toContain('Sigma_buyBot?start=x');
    expect(text).toContain('0xdeadbeef');
    expect(text).toContain('based_eth_bot?start=r_');
    const html = telegramHtml(s);
    expect(html).toContain('🎯 Buy SGM');
    expect(html).toContain('🎲 Buy BSD');
  });
});

function trackedCall(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'c-' + Math.random().toString(36).slice(2),
    token: '0xtok',
    tokenSymbol: 'GEM',
    kind: 'SOLO',
    conviction: 70,
    walletCount: 1,
    walletSummary: '1 alpha',
    walletLabels: [],
    repeatCount: 1,
    repeatWallets: 1,
    newHolder: false,
    entryPrice: 1,
    entryMarketCap: 60_000,
    pairAgeHours: 2,
    entryAt: Date.now(),
    lastPrice: 1.5,
    lastMarketCap: 90_000,
    lastGainPct: 50,
    maxPrice: 1.5,
    maxGainPct: 50,
    maxGainAt: Date.now(),
    lastMilestoneAnnounced: 50,
    gain1hPct: null,
    gain6hPct: null,
    gain24hPct: null,
    updatedAt: Date.now(),
    closed: false,
    ...over,
  };
}

describe('PnL milestone cards', () => {
  it('scales the rocket count with the milestone size', () => {
    expect(milestoneHeadline(trackedCall(), 50)).toContain('🚀 +50% — $GEM 🚀');
    expect(milestoneHeadline(trackedCall(), 100)).toContain('🚀🚀 +100% — $GEM 🚀🚀');
    expect(milestoneHeadline(trackedCall(), 300)).toContain('🚀🚀🚀🚀🚀🚀');
  });

  it('includes the wallets that called it, market cap move, and links', () => {
    const call = trackedCall({ walletLabels: ['tendies', 'hmm'] });
    const text = milestoneTextBody(call, 50, 'https://dexscreener.com/x');
    expect(text).toContain('$GEM');
    expect(text).toContain('60.0K');
    expect(text).toContain('90.0K');
    expect(text).toContain('tendies, hmm');
    expect(text).toContain('📊 Chart: https://dexscreener.com/x');

    const html = milestoneTelegramHtml(call, 50, 'https://dexscreener.com/x');
    expect(html).toContain('Called by: tendies, hmm');
    expect(html).toContain('<a href="https://dexscreener.com/x">Chart</a>');
  });

  it('omits the "called by" line when there are no wallet labels', () => {
    const call = trackedCall({ walletLabels: [] });
    expect(milestoneTextBody(call, 50, 'x')).not.toContain('Called by');
  });
});

describe('result footer (the running result edited onto the alert card)', () => {
  const now = Date.now();

  it('shows the current return, the market cap move, and how long it has run', () => {
    const call = trackedCall({ entryAt: now - 2 * 3_600_000 });
    const footer = resultFooter(call, now);
    expect(footer).toContain('Now +50%');
    expect(footer).toContain('$60.0k → $90.0k');
    expect(footer).toContain('2h');
  });

  it('adds the peak only once the call has come off it', () => {
    // At its peak: repeating the same number twice reads as noise.
    expect(resultFooter(trackedCall(), now)).not.toContain('peak');
    // Pulled back from +120% to +30%: the peak is now the interesting part.
    const off = trackedCall({ lastGainPct: 30, maxGainPct: 120 });
    expect(resultFooter(off, now)).toContain('peak +120%');
  });

  it('reads as final once tracking has closed, and signs a loss', () => {
    const done = trackedCall({ closed: true, lastGainPct: -22, maxGainPct: -22 });
    const footer = resultFooter(done, now);
    expect(footer).toContain('Final -22%');
    expect(footer).not.toContain('Now');
  });

  it('appends to the original card rather than replacing it', () => {
    const html = telegramHtmlWithResult('<b>SWARM THE FLY</b>', trackedCall(), now);
    expect(html.startsWith('<b>SWARM THE FLY</b>')).toBe(true);
    expect(html).toContain('Now +50%');
  });
});
