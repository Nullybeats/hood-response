import type { Swarm } from '../types.js';
import type { TrackedCall } from '../engine/performance.js';
import { explorerUrl, sigmaBuyUrl, basedBuyUrl } from '../links.js';

export const KIND_EMOJI: Record<Swarm['kind'], string> = {
  BUY: '🟢😼',
  SELL: '🔴🙀',
  ROTATION: '🔄🐈',
  SOLO: '🕵️🐱',
  ENTRY: '🌱🐾',
};

/** Brand title every alert card opens with. */
const BRAND = 'SNIPURR ALERT';

/** PRIME multiplies the kind icon itself — the swarm literally gets bigger. */
function primeIcon(s: Swarm): string {
  return s.prime ? KIND_EMOJI[s.kind].repeat(3) : KIND_EMOJI[s.kind];
}

// ── formatting helpers ────────────────────────────────────────────────────────
export function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

/** Compact number without a currency sign: 388100 → "388.1K". */
function compact(n: number | null | undefined): string {
  if (n == null) return '?';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function fmtPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '?';
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4).replace(/0+$/, '');
}

function fmtAge(hours: number | null | undefined): string {
  if (hours == null) return '?';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function pct(v: number | null | undefined): string {
  if (v == null) return '?';
  const dot = v >= 0 ? '🟢' : '🔴';
  return `${dot} ${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** 5-segment conviction bar. */
function convBar(score: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(score / 20)));
  return '🟩'.repeat(filled) + '⬜'.repeat(5 - filled);
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th" … */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Prominent repeat/escalation lines, or [] when this is the first alert on the
 *  token inside the window (nothing to escalate). A repeat driven by a NEW
 *  distinct holder is highlighted harder than the same wallet buying again, and
 *  the price move since the previous alert is shown when known. */
function repeatLines(s: Swarm): string[] {
  const n = s.repeatCount ?? 0;
  if (n < 2) return [];
  const win = s.repeatWindowMinutes ?? 35;
  const w = s.repeatWallets ?? n;
  const lines: string[] = [];
  if (s.repeatNewWallet) {
    // A different top holder just joined — the strongest repeat signal.
    lines.push(`🚨 NEW HOLDER IN 😼🔥 · ${ordinal(n)} alert · ${w} wallet${w > 1 ? 's' : ''} in ${win}m`);
  } else {
    const heat = n >= 4 ? '🔥🔥' : '🔥';
    lines.push(`🔁 REPEAT x${n} ${heat} · ${ordinal(n)} alert in ${win}m`);
  }
  const pc = s.repeatPriceChangePct;
  if (pc != null) {
    const arrow = pc > 0 ? '📈' : pc < 0 ? '📉' : '➡️';
    lines.push(`${arrow} ${pc > 0 ? '+' : ''}${pc}% since last alert`);
  }
  return lines;
}

function typeTitle(s: Swarm): string {
  const nu = s.newToken ? '🆕 NEW COIN · ' : '';
  switch (s.kind) {
    case 'ROTATION':
      return `🔄 ROTATION · ${s.walletCount} wallets → ${s.rotatedIntoSymbol}`;
    case 'SOLO':
      return `${nu}🕵️ SOLO BUY · low-cap ape`;
    case 'ENTRY':
      return `${nu}🌱 FIRST ENTRY · ${fmtAge(s.pairAgeHours)}-old pair`;
    case 'SELL':
      return `${nu}🔴 SELL SWARM · ${s.walletCount} wallets dumping`;
    default:
      return `${nu}🟢 SWARM · ${s.walletCount} wallets accumulating`;
  }
}

export function headline(s: Swarm): string {
  return s.prime
    ? `👑 PRIME 👑 ${primeIcon(s)} ${typeTitle(s)}`
    : `${KIND_EMOJI[s.kind]} ${typeTitle(s)}`;
}

/** The loud, fly-swarming banner PRIME alerts open with — more flies, and the
 *  alert icon itself multiplies (3x), same idea as the header. */
function primeBanner(s: Swarm): string[] {
  if (!s.prime) return [];
  const swarm = '🐾'.repeat(9);
  return [swarm, `👑 PRIME SIGNAL 👑 ${primeIcon(s)}`, swarm];
}

/** All-time-high market cap suffix for the MC line, e.g. " · 🏔️ ATH 500.0K (-80%)".
 *  "" when no ATH has been observed yet (token never had a live price). */
function athLabel(s: Swarm): string {
  const ath = s.athMarketCap;
  if (ath == null) return '';
  const down =
    ath > 0 && s.marketCap > 0 ? Math.round(((s.marketCap - ath) / ath) * 1000) / 10 : null;
  return `  ·  🏔️ ATH ${compact(ath)}${down != null ? ` (${down}%)` : ''}`;
}

/** The card's stacked display lines (no links; shared by plain + HTML). */
function cardLines(s: Swarm): string[] {
  const sym = s.tokenSymbol;
  const marker = s.kind === 'SELL' ? '🔻' : s.kind === 'ENTRY' ? '🌱' : '🎯';
  const buys = s.momentum?.buys ?? null;
  const sells = s.momentum?.sells ?? null;

  const prime = primeBanner(s);
  const repeat = repeatLines(s);
  const lines: string[] = [
    ...(prime.length ? [...prime, ``] : []),
    ...(repeat.length ? [...repeat, ``] : []),
    `${marker} ${sym} [${compact(s.marketCap)}] $${sym}`,
    `⛓️ Robinhood · ${s.dex ?? 'dex'}`,
    `💰 $${fmtPrice(s.priceUsd)}`,
    `💎 MC ${compact(s.marketCap)}${s.priceLive ? '' : ' (est)'}${athLabel(s)}  ·  💧 Liq ${compact(s.liquidityUsd)}`,
    `📊 Vol ${compact(s.momentum?.volumeUsd)}  ·  ⏳ Age ${fmtAge(s.pairAgeHours)}`,
    `📈 24h ${pct(s.momentum?.priceChange24h)}  ·  1h ${pct(s.momentum?.priceChange1h)}  ·  🅑 ${buys ?? '?'} 🅢 ${sells ?? '?'}`,
    ``,
    `😼 CONVICTION ${s.conviction}/100${s.momentum?.confirmed ? ' 🔥' : ''}`,
    convBar(s.conviction),
    `👛 ${s.walletSummary}`,
  ];

  if (s.safety) {
    const bt = s.safety.buyTaxPct != null ? Math.round(s.safety.buyTaxPct) : '?';
    const st = s.safety.sellTaxPct != null ? Math.round(s.safety.sellTaxPct) : '?';
    lines.push(`🛡️ Safe · Tax ${bt}/${st}%${s.safety.warnings.length ? ` · ⚠️ ${s.safety.warnings.join(', ')}` : ''}`);
  }
  if (s.alsoHold && s.alsoHold.length) {
    lines.push(`⭐ Wallets also hold: ${s.alsoHold.join(', ')}`);
  }
  return lines;
}

// ── plain text (generic webhooks) ─────────────────────────────────────────────
export function textBody(s: Swarm): string {
  const cat = s.prime ? '😼'.repeat(3) : '😼';
  const lines = [`${cat} ${BRAND} ${cat}`, typeTitle(s), ``, ...cardLines(s), ``, s.token];
  lines.push(`📊 Chart: ${s.dexUrl}`);
  lines.push(`🔎 Explorer: ${explorerUrl(s.token)}`);
  const sigma = sigmaBuyUrl(s.token);
  if (sigma) lines.push(`🎯 Buy SGM: ${sigma}`);
  const based = basedBuyUrl(s.token);
  if (based) lines.push(`🎲 Buy BSD: ${based}`);
  return lines.join('\n');
}

// ── Telegram HTML card ────────────────────────────────────────────────────────
const esc = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function telegramHtml(s: Swarm): string {
  const body = cardLines(s).map(esc).join('\n');
  const cat = s.prime ? '😼'.repeat(3) : '😼';
  const sigma = sigmaBuyUrl(s.token);
  const based = basedBuyUrl(s.token);
  const buyLinks = [
    sigma ? `<a href="${esc(sigma)}">🎯 Buy SGM</a>` : null,
    based ? `<a href="${esc(based)}">🎲 Buy BSD</a>` : null,
  ].filter((x): x is string => x != null);
  return (
    `${cat} <b>${BRAND}</b> ${cat}\n` +
    `<b>${esc(typeTitle(s))}</b>\n\n` +
    `${body}\n\n` +
    `<code>${esc(s.token)}</code>\n` +
    `📊 <a href="${esc(s.dexUrl)}">Chart</a>  ·  🔎 <a href="${esc(explorerUrl(s.token))}">Explorer</a>` +
    (buyLinks.length ? `\n${buyLinks.join('  ·  ')}` : '')
  );
}

// ── the live result footer, edited onto the alert card itself ────────────────
// The alert is the only message a call ever gets: rather than posting a separate
// milestone card each time it runs, we edit this footer onto the original card so
// one message carries the call AND how it went. Kept to a single line so a card
// that has been updated a dozen times still reads like an alert, not a log.

const signed = (pct: number): string => `${pct >= 0 ? '+' : ''}${Math.round(pct)}%`;

/** "18min" / "4h" / "2d" — how long the call has been running. */
function since(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}min`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
}

export function resultFooter(call: TrackedCall, now: number): string {
  const age = since(Math.max(0, now - call.entryAt));
  const mc = `${usd(call.entryMarketCap)} → ${usd(call.lastMarketCap)}`;
  // Peak is the whole point of a call record, but repeating it when the call IS
  // at its peak just doubles the same number — so only show it once it has come off.
  const peak =
    Math.round(call.maxGainPct) > Math.round(call.lastGainPct)
      ? ` · peak ${signed(call.maxGainPct)}`
      : '';
  const head = call.closed ? `🏁 <b>Final ${signed(call.lastGainPct)}</b>` : `📈 <b>Now ${signed(call.lastGainPct)}</b>`;
  return `${head}${peak} · ${mc} · ${age}`;
}

/** The alert card with its running result appended — what an edit re-sends. */
export function telegramHtmlWithResult(cardHtml: string, call: TrackedCall, now: number): string {
  return `${cardHtml}\n\n${resultFooter(call, now)}`;
}

// ── PnL milestone cards ─────────────────────────────────────────────────────
// Fired by PerformanceTracker every time a tracked call's peak crosses a new
// interval (default 50%: +50%, +100%, +150%, …) — a running celebration of
// which calls actually turned into runners, not just what fired at entry.

/** More rockets the bigger the milestone — same "the swarm gets bigger"
 *  language as PRIME, applied to realized gain instead of entry conviction. */
function milestoneBanner(milestonePct: number): string {
  const tier = Math.max(1, Math.min(6, Math.floor(milestonePct / 50)));
  return '🚀'.repeat(tier);
}

export function milestoneHeadline(call: TrackedCall, milestonePct: number): string {
  const rockets = milestoneBanner(milestonePct);
  return `${rockets} +${milestonePct}% — $${call.tokenSymbol} ${rockets}`;
}

function milestoneLines(call: TrackedCall, milestonePct: number): string[] {
  const ageMin = Math.floor((Date.now() - call.entryAt) / 60_000);
  const age = ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h`;
  const lines: string[] = [
    `😼 $${call.tokenSymbol} just crossed +${milestonePct}% peak`,
    `💎 Entry ${compact(call.entryMarketCap)} MC → now ${compact(call.lastMarketCap)} MC`,
    `📈 Currently ${call.lastGainPct >= 0 ? '+' : ''}${call.lastGainPct}% vs entry`,
    `⏳ ${age} since the call · pair was ${fmtAge(call.pairAgeHours)} old`,
    `😼 Conviction ${call.conviction}/100 · ${call.kind}`,
  ];
  if (call.walletLabels.length) lines.push(`👛 Called by: ${call.walletLabels.join(', ')}`);
  return lines;
}

export function milestoneTextBody(call: TrackedCall, milestonePct: number, dexUrl: string): string {
  const lines = [
    milestoneHeadline(call, milestonePct),
    ``,
    ...milestoneLines(call, milestonePct),
    ``,
    call.token,
    `📊 Chart: ${dexUrl}`,
    `🔎 Explorer: ${explorerUrl(call.token)}`,
  ];
  return lines.join('\n');
}

export function milestoneTelegramHtml(call: TrackedCall, milestonePct: number, dexUrl: string): string {
  const body = milestoneLines(call, milestonePct).map(esc).join('\n');
  return (
    `<b>${esc(milestoneHeadline(call, milestonePct))}</b>\n\n` +
    `${body}\n\n` +
    `<code>${esc(call.token)}</code>\n` +
    `📊 <a href="${esc(dexUrl)}">Chart</a>  ·  🔎 <a href="${esc(explorerUrl(call.token))}">Explorer</a>`
  );
}
