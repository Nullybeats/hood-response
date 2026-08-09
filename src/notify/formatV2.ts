/**
 * The Telegram card for a v2 match.
 *
 * Separate from format.ts on purpose, and the reason is the same one emit.ts
 * opens with: a `V2Match` is NOT a `Swarm`. format.ts is built around `kind` and
 * `conviction`, and reaching for it here would mean inventing both. The two
 * renderers are allowed to look similar; they must not share a type.
 *
 * WHAT THIS CARD MAY NOT SAY. The legacy card carries price, liquidity, 24h
 * volume, buy/sell counts and a safety block. A match carries none of those —
 * they were never facts on the sheet, never scored, and v2 dropped `liq`
 * everywhere for that reason (the web feed did the same). So they are absent
 * here rather than filled in from a second lookup: a number fetched at render
 * time is not the number the lane decided on, and a card that mixes the two is
 * how "1 alpha bought @ $101k MC" came to be printed over a transfer.
 *
 * Unknown reads as unknown. `usd()` is reused from format.ts precisely because
 * it renders null as "unknown" instead of "$0.00".
 */

import type { V2Match } from '../v2/emit.js';
import { DEFAULT_LANES } from '../v2/lanes.js';
import { usd } from './format.js';
import { explorerUrl, dexScreenerUrl, sigmaBuyUrl, basedBuyUrl } from '../links.js';

/** Brand title. Marked v2 so a screenshot is self-identifying while both
 *  brains could still, in principle, be posting. */
const BRAND = 'SNIPURR SIGNAL';

const LANE_BY_ID = new Map(DEFAULT_LANES.map((l) => [l.id, l]));

/**
 * A lane the catalogue does not know must LOOK unknown, exactly as the web feed
 * treats it. The engine owns the lane list and can ship a new one before this
 * renderer hears about it; that should read as unrecognised, not be silently
 * dressed up as one of the four we happen to have hardcoded.
 */
function laneTitle(id: string): string {
  const lane = LANE_BY_ID.get(id);
  return lane ? `${lane.emoji} ${lane.name.toUpperCase()}` : `❓ ${id.toUpperCase()}`;
}

/** The mark shown above the card. First matched lane wins — lanes are ordered
 *  by the engine, and a card has one face. */
function laneEmoji(m: V2Match): string {
  const lane = LANE_BY_ID.get(m.lanes[0] ?? '');
  return lane?.emoji ?? '🐾';
}

/**
 * How the event entered. Rendered in the event's OWN vocabulary — an allocation
 * is a wallet RECEIVING a token, which is not a buy, and calling it one is the
 * specific lie this whole rebuild exists to stop telling.
 */
function eventLabel(eventType: string): string {
  switch (eventType) {
    case 'verified-buy':
      return 'bought';
    case 'distribution':
      return 'received';
    case 'verified-sell':
      return 'sold';
    default:
      return eventType;
  }
}

function compact(n: number | null | undefined): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function fmtAge(hours: number | null | undefined): string {
  if (hours == null) return 'unknown';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** 5-segment score bar. Null score gets an empty bar, never a full one. */
function scoreBar(score: number | null): string {
  if (score == null) return '⬜⬜⬜⬜⬜';
  const filled = Math.max(0, Math.min(5, Math.round(score / 20)));
  return '🟩'.repeat(filled) + '⬜'.repeat(5 - filled);
}

/**
 * The wallet's EARNED grade, with `U` spelled out.
 *
 * `U` is not a bad grade, it is the absence of one — the wallet is under the
 * sample floor and has not earned a judgement yet. Rendering it as a bare "U"
 * next to A/B/C/D/F invites reading it as the bottom of the scale, which would
 * quietly penalise every wallet the ledger has not seen enough of.
 */
function gradeLine(m: V2Match): string {
  const cohort = m.cohortSize <= 1 ? 'solo' : `${m.cohortSize} wallets in window`;
  const grade = m.walletGrade === 'U' ? 'ungraded (too few closed calls)' : `grade ${m.walletGrade}`;
  return `🎓 Wallet ${grade} · ${cohort}`;
}

/** Seed tier is catalogue data, never a performance judgement — and is labelled
 *  that way on the card so the two can never be read as the same thing. */
function seedLine(m: V2Match): string[] {
  if (!m.seedTier) return [];
  return [`🌱 Seed tier ${m.seedTier} (holder rank, not a grade)`];
}

/**
 * The uncertainty travels with the match, so it travels onto the card.
 *
 * v2 is allowed to fire on a coin no honeypot screen has answered for — blocking
 * on it cost 14% of decisions to a check that resolves ~1% of the time. What it
 * is never allowed to do is present an unscreened coin as a checked one. The
 * sniper refuses to buy these; a human reading the channel deserves the same
 * warning the sniper acts on.
 */
function sellabilityLines(m: V2Match): string[] {
  return m.sellabilityUnverified
    ? ['⚠️ SELLABILITY UNVERIFIED — no honeypot screen has answered for this coin']
    : ['🛡️ Screened sellable'];
}

/** The card's stacked display lines (no links; shared by plain + HTML). */
function cardLines(m: V2Match): string[] {
  const sym = m.tokenSymbol;
  return [
    `${laneEmoji(m)} ${sym} [${compact(m.marketCap)}] $${sym}`,
    `⛓️ Robinhood · a watched wallet ${eventLabel(m.eventType)} it`,
    `💎 MC ${usd(m.marketCap)}${m.capBand ? ` · ${m.capBand} cap` : ''}`,
    `⏳ Pair age ${fmtAge(m.pairAgeHours)}`,
    ``,
    `🏁 SCORE ${m.score != null ? `${Math.round(m.score)}/100` : 'unscored'}`,
    scoreBar(m.score),
    gradeLine(m),
    ...seedLine(m),
    ...sellabilityLines(m),
    ``,
    // The lane's own sentence, as the gate recorded it. This is the audit trail:
    // it is why the coin is in the channel, in the words the rule used.
    ...m.laneReasons.map((r) => `· ${r}`),
  ];
}

/** Title line: every matched lane, so a two-lane match is not shown as one. */
export function v2Title(m: V2Match): string {
  return m.lanes.map(laneTitle).join(' + ');
}

// ── plain text (generic webhooks) ─────────────────────────────────────────────
export function v2TextBody(m: V2Match): string {
  const lines = [
    `😼 ${BRAND} 😼`,
    v2Title(m),
    ``,
    ...cardLines(m),
    ``,
    m.token,
    `📊 Chart: ${dexScreenerUrl(m.token)}`,
    `🔎 Explorer: ${explorerUrl(m.token)}`,
  ];
  const sigma = sigmaBuyUrl(m.token);
  if (sigma) lines.push(`🎯 Buy SGM: ${sigma}`);
  const based = basedBuyUrl(m.token);
  if (based) lines.push(`🎲 Buy BSD: ${based}`);
  return lines.join('\n');
}

// ── Telegram HTML card ────────────────────────────────────────────────────────
const esc = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function v2TelegramHtml(m: V2Match): string {
  const body = cardLines(m).map(esc).join('\n');
  const sigma = sigmaBuyUrl(m.token);
  const based = basedBuyUrl(m.token);
  const buyLinks = [
    sigma ? `<a href="${esc(sigma)}">🎯 Buy SGM</a>` : null,
    based ? `<a href="${esc(based)}">🎲 Buy BSD</a>` : null,
  ].filter((x): x is string => x != null);
  return (
    `😼 <b>${BRAND}</b> 😼\n` +
    `<b>${esc(v2Title(m))}</b>\n\n` +
    `${body}\n\n` +
    `<code>${esc(m.token)}</code>\n` +
    `📊 <a href="${esc(dexScreenerUrl(m.token))}">Chart</a>  ·  🔎 <a href="${esc(explorerUrl(m.token))}">Explorer</a>` +
    (buyLinks.length ? `\n${buyLinks.join('  ·  ')}` : '')
  );
}

// ── the running result footer, edited onto the card itself ───────────────────
// One message per call, as legacy did: the outcome is edited onto the original
// card rather than posted as a new one, so the channel stays a track record
// instead of becoming a milestone firehose.

const signed = (pct: number): string => `${pct >= 0 ? '+' : ''}${Math.round(pct)}%`;

function since(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}min`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
}

/** What a card's result line needs. Deliberately a narrow shape rather than the
 *  whole `LedgerRecord`: the renderer has no business reading the control-group
 *  fields, and a small contract is one a test can build by hand. */
export interface V2Result {
  firedAt: number;
  /** Best gain seen since the call. Null until a price ever resolved. */
  maxGainPct: number | null;
  /** Gain at the last sample — what the call is worth NOW. */
  lastGainPct: number | null;
  closed: boolean;
  closedReason?: string;
}

/**
 * PEAK IS NOT A RESULT ON ITS OWN.
 *
 * The ledger learned this the hard way on 2026-08-09: MEW peaked +756% and sits
 * at −95%, and scoring the peak recorded it as a win. So the footer always shows
 * `now` beside `peak` — a gain you cannot exit is not a gain, and a card that
 * showed only the high-water mark would be advertising exactly that.
 */
export function v2ResultFooter(r: V2Result, now: number): string {
  const age = since(Math.max(0, now - r.firedAt));
  if (r.maxGainPct == null || r.lastGainPct == null) {
    // No quote ever resolved. That is itself a finding about the signal — a
    // token nobody ever traded — and is worth saying rather than hiding.
    return r.closed ? `📕 No price in ${age} — never traded` : `⏳ Awaiting first quote · ${age}`;
  }
  const peak = signed(r.maxGainPct);
  const nowPct = signed(r.lastGainPct);
  const face = r.lastGainPct >= 0 ? '😼' : '🙀';
  const state = r.closed ? '📕 FINAL' : '📈 LIVE';
  return `${state} ${face} peak ${peak} · now ${nowPct} · ${age}`;
}

/**
 * Re-render a card with its current result appended.
 *
 * The original card HTML is kept verbatim and the footer swapped, so a card
 * edited a dozen times still reads like an alert rather than a log. The marker
 * is a literal string rather than a regex over the body: the body contains
 * user-ish text (token symbols, lane reasons) and must never be able to look
 * like the delimiter.
 */
const FOOTER_MARK = '\n\n— — —\n';

export function v2TelegramHtmlWithResult(cardHtml: string, r: V2Result, now: number): string {
  const base = cardHtml.split(FOOTER_MARK)[0] ?? cardHtml;
  return `${base}${FOOTER_MARK}${esc(v2ResultFooter(r, now))}`;
}
