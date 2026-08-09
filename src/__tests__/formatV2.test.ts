import { describe, it, expect } from 'vitest';
import {
  v2Title,
  v2TextBody,
  v2TelegramHtml,
  v2ResultFooter,
  v2TelegramHtmlWithResult,
  type V2Result,
} from '../notify/formatV2.js';
import type { V2Match } from '../v2/emit.js';

function match(over: Partial<V2Match> = {}): V2Match {
  return {
    source: 'v2',
    id: '0xtx',
    token: '0xtok',
    tokenSymbol: 'GEM',
    firedAt: 1_000_000,
    emittedAt: 1_000_042,
    eventType: 'verified-buy',
    lanes: ['solo-buy'],
    laneReasons: ['one watched wallet bought at $68k'],
    score: 74,
    marketCap: 68_000,
    pairAgeHours: 3.2,
    capBand: 'micro',
    seedTier: null,
    walletGrade: 'U',
    cohortSize: 1,
    sellabilityUnverified: false,
    walletId: 'w1',
    ...over,
  };
}

describe('v2 card', () => {
  it('titles the card with the lane, not a legacy kind', () => {
    expect(v2Title(match())).toBe('🎯 SOLO BUY');
    expect(v2Title(match({ lanes: ['allocation'] }))).toBe('🎁 ALLOCATION');
  });

  it('shows EVERY matched lane, so a two-lane match is not shown as one', () => {
    expect(v2Title(match({ lanes: ['solo-buy', 'fresh-entry'] }))).toBe(
      '🎯 SOLO BUY + 🌱 FRESH ENTRY',
    );
  });

  it('renders a lane it does not recognise AS unrecognised', () => {
    // The engine owns the lane catalogue and can ship one this renderer has
    // never heard of. That must look unknown, never be dressed as a known lane.
    expect(v2Title(match({ lanes: ['some-new-lane'] }))).toBe('❓ SOME-NEW-LANE');
  });

  it('never calls an allocation a buy', () => {
    // The whole reason a match is not a Swarm: a distribution is a wallet
    // RECEIVING a token. Printing "bought" over a transfer is the original lie.
    const html = v2TelegramHtml(
      match({
        eventType: 'distribution',
        lanes: ['allocation'],
        // The lane's own words are quoted verbatim, so they must not be allowed
        // to smuggle "bought" into the assertion below.
        laneReasons: ['alpha-seed wallet received it, pair 0h old'],
      }),
    );
    expect(html).toContain('received it');
    expect(html).not.toContain('bought');
  });

  it('renders an unknown market cap as unknown, never as $0', () => {
    const html = v2TelegramHtml(match({ marketCap: null }));
    expect(html).toContain('MC unknown');
    expect(html).not.toContain('$0.00');
  });

  it('carries the sellability warning onto the card when nothing screened the coin', () => {
    expect(v2TelegramHtml(match({ sellabilityUnverified: true }))).toContain(
      'SELLABILITY UNVERIFIED',
    );
    expect(v2TelegramHtml(match({ sellabilityUnverified: false }))).toContain('Screened sellable');
  });

  it('spells out an ungraded wallet instead of printing a bare U', () => {
    // U is the ABSENCE of a grade, not the bottom of the scale.
    const html = v2TelegramHtml(match({ walletGrade: 'U' }));
    expect(html).toContain('ungraded');
    const graded = v2TelegramHtml(match({ walletGrade: 'A' }));
    expect(graded).toContain('grade A');
  });

  it('labels seed tier as a holder rank, so it cannot be read as a grade', () => {
    const html = v2TelegramHtml(match({ seedTier: 'alpha' }));
    expect(html).toContain('Seed tier alpha');
    expect(html).toContain('not a grade');
  });

  it('does not invent a score when there is none', () => {
    const html = v2TelegramHtml(match({ score: null }));
    expect(html).toContain('unscored');
    expect(html).toContain('⬜⬜⬜⬜⬜');
    expect(html).not.toContain('🟩');
  });

  it('shows the lane reason — the audit trail for why the coin is in the channel', () => {
    expect(v2TelegramHtml(match())).toContain('one watched wallet bought at $68k');
  });

  it('escapes HTML so a hostile token symbol cannot break the card', () => {
    const html = v2TelegramHtml(match({ tokenSymbol: '<b>PWN</b>' }));
    expect(html).toContain('&lt;b&gt;PWN&lt;/b&gt;');
  });

  it('carries the contract and both reference links in the plain-text body', () => {
    const text = v2TextBody(match());
    expect(text).toContain('0xtok');
    expect(text).toContain('Chart:');
    expect(text).toContain('Explorer:');
  });
});

describe('v2 result footer', () => {
  const result = (over: Partial<V2Result> = {}): V2Result => ({
    firedAt: 0,
    maxGainPct: 120,
    lastGainPct: 30,
    closed: false,
    ...over,
  });

  it('always shows NOW beside PEAK', () => {
    // A gain you cannot exit is not a gain: MEW peaked +756% and sits at -95%.
    // A footer showing only the high-water mark advertises exactly that.
    const footer = v2ResultFooter(result(), 0);
    expect(footer).toContain('peak +120%');
    expect(footer).toContain('now +30%');
  });

  it('says a coin never traded rather than hiding it', () => {
    const footer = v2ResultFooter(result({ maxGainPct: null, lastGainPct: null, closed: true }), 0);
    expect(footer).toContain('never traded');
  });

  it('marks a closed call final and an open one live', () => {
    expect(v2ResultFooter(result({ closed: true }), 0)).toContain('FINAL');
    expect(v2ResultFooter(result({ closed: false }), 0)).toContain('LIVE');
  });

  it('REPLACES the footer on re-edit rather than stacking them', () => {
    // A card edited a dozen times must still read like an alert, not a log.
    const card = v2TelegramHtml(match());
    const once = v2TelegramHtmlWithResult(card, result({ lastGainPct: 30 }), 0);
    const twice = v2TelegramHtmlWithResult(once, result({ lastGainPct: 90 }), 0);
    expect(twice).toContain('now +90%');
    expect(twice).not.toContain('now +30%');
    expect(twice.split('— — —')).toHaveLength(2);
  });

  it('keeps the original card body verbatim across edits', () => {
    const card = v2TelegramHtml(match());
    const edited = v2TelegramHtmlWithResult(card, result(), 0);
    expect(edited.startsWith(card)).toBe(true);
  });
});
