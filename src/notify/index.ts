import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { NotificationDelivery, Swarm } from '../types.js';
import type { TrackedCall } from '../engine/performance.js';
import {
  headline,
  telegramHtml,
  textBody,
  usd,
  milestoneHeadline,
  milestoneTextBody,
  telegramHtmlWithResult,
} from './format.js';
import { explorerUrl, sigmaBuyUrl, basedBuyUrl, mascotUrl, mascotUrlForLane } from '../links.js';
import type { V2Match } from '../v2/emit.js';
import {
  v2TelegramHtml,
  v2TextBody,
  v2Title,
  v2TelegramHtmlWithResult,
  type V2Result,
} from './formatV2.js';

const TIMEOUT_MS = 4000;

/**
 * Telegram renders the artwork as a link preview, not an attachment, on purpose:
 * a sendPhoto message can only ever be edited as a caption (1024 chars, and a
 * different endpoint), which would break the running result footer editAlertResult()
 * writes onto the same message. link_preview_options keeps the card a normal text
 * message while still showing the cat above it.
 */
function previewOptions(kind: string, prime: boolean): Record<string, unknown> {
  return {
    url: mascotUrl(kind, prime),
    prefer_large_media: true,
    show_above_text: true,
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function sendDiscord(url: string, s: Swarm): Promise<NotificationDelivery> {
  const color = s.prime
    ? 0xffd700 // gold — PRIME overrides the kind color, loudest tier
    : s.kind === 'BUY'
      ? 0x16a34a
      : s.kind === 'SELL'
        ? 0xdc2626
        : s.kind === 'SOLO'
          ? 0xf0b429
          : s.kind === 'ENTRY'
            ? 0x22c55e
            : 0x7c3aed;
  const embed = {
    title: headline(s),
    url: s.dexUrl, // makes the title a clickable DexScreener link
    color,
    fields: [
      { name: 'Conviction', value: `${s.conviction}/100`, inline: true },
      { name: 'Notional', value: usd(s.totalUsd), inline: true },
      {
        name: s.kind === 'SELL' ? 'Sold at MC' : 'Bought at MC',
        value: usd(s.marketCap),
        inline: true,
      },
      { name: 'Window', value: `${s.windowSeconds}s`, inline: true },
      { name: `Wallets (${s.walletCount})`, value: s.walletSummary, inline: true },
      ...(s.athMarketCap != null
        ? [
            {
              name: '🏔️ ATH MC',
              value: `${usd(s.athMarketCap)}${s.athMarketCap > 0 && s.marketCap != null && s.marketCap > 0 ? ` (${Math.round(((s.marketCap - s.athMarketCap) / s.athMarketCap) * 1000) / 10}%)` : ''}`,
              inline: true,
            },
          ]
        : []),
      ...(s.momentum?.volumeUsd != null
        ? [
            {
              name: `Vol 24h${s.momentum.confirmed ? ' 🔥' : ''}`,
              value: `${usd(s.momentum.volumeUsd)}${s.momentum.priceChangePct != null ? ` (${s.momentum.priceChangePct >= 0 ? '+' : ''}${s.momentum.priceChangePct.toFixed(1)}%)` : ''}`,
              inline: true,
            },
          ]
        : []),
      ...(s.newToken ? [{ name: '🆕 Contract', value: s.token }] : []),
      {
        name: 'Links',
        value: [
          `[📊 Chart](${s.dexUrl})`,
          `[🔎 Explorer](${explorerUrl(s.token)})`,
          ...(sigmaBuyUrl(s.token) ? [`[🎯 Buy SGM](${sigmaBuyUrl(s.token)})`] : []),
          ...(basedBuyUrl(s.token) ? [`[🎲 Buy BSD](${basedBuyUrl(s.token)})`] : []),
        ].join(' · '),
        inline: true,
      },
    ],
    footer: { text: 'Snipurr · Robinhood Chain' },
    timestamp: new Date(s.lastSeen).toISOString(),
  };
  try {
    const res = await postJson(url, { username: 'Snipurr', embeds: [embed] });
    return delivery('discord', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('discord', false, (err as Error).message);
  }
}

/** Called with the Telegram message id of each alert card as it lands, so the
 *  performance tracker can later edit that same message with the call's result
 *  instead of posting a separate milestone card. Wired in index.ts. */
let onCardSent: ((swarmId: string, messageId: number, cardHtml: string) => void) | null = null;
export function onAlertCardSent(fn: typeof onCardSent): void {
  onCardSent = fn;
}

async function sendTelegram(
  token: string,
  chatId: string,
  s: Swarm,
): Promise<NotificationDelivery> {
  try {
    const cardHtml = telegramHtml(s);
    const res = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: cardHtml,
      parse_mode: 'HTML',
      // A v2 match has no legacy kind; its lane names the mascot instead.
      link_preview_options: previewOptions(s.kind ?? s.lanes?.[0] ?? 'SOLO', s.prime === true),
    });
    if (res.ok) {
      // Remember which message this call owns. Failing to read the id only costs
      // the running result footer — the alert itself has already been delivered.
      const messageId = await res
        .json()
        .then((b) => (b as { result?: { message_id?: number } }).result?.message_id)
        .catch(() => undefined);
      if (messageId != null && onCardSent) onCardSent(s.id, messageId, cardHtml);
      return delivery('telegram', true);
    }
    // Surface Telegram's own reason (e.g. "chat not found", "not enough rights
    // to send text messages") — the common failures when posting to a channel
    // the bot hasn't been made an admin of yet.
    const reason = await res
      .json()
      .then((b) => (b as { description?: string }).description ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    return delivery('telegram', false, reason);
  } catch (err) {
    return delivery('telegram', false, (err as Error).message);
  }
}

/**
 * Re-render a call's alert card with its current result and edit it in place.
 * One message per call, updated as it runs — no separate milestone posts.
 * Telegram rejects an edit whose text is byte-identical ("message is not
 * modified"); the caller only edits on a material move, so that is a no-op we
 * log at debug rather than a failure.
 */
export async function editAlertResult(
  call: TrackedCall,
  messageId: number,
  cardHtml: string,
): Promise<boolean> {
  const tg = config.notifications.telegram;
  if (!tg) return false;
  try {
    const res = await postJson(`https://api.telegram.org/bot${tg.token}/editMessageText`, {
      chat_id: tg.chatId,
      message_id: messageId,
      text: telegramHtmlWithResult(cardHtml, call, Date.now()),
      parse_mode: 'HTML',
      // Same preview the card was sent with — omitting it would strip the mascot
      // off the message the first time a result footer lands.
      link_preview_options: previewOptions(call.kind ?? 'SOLO', cardHtml.includes('PRIME SIGNAL')),
    });
    if (res.ok) return true;
    const reason = await res
      .json()
      .then((b) => (b as { description?: string }).description ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    if (reason.includes('not modified')) {
      logger.debug({ token: call.tokenSymbol }, 'result footer unchanged');
      return true;
    }
    logger.warn({ token: call.tokenSymbol, messageId, detail: reason }, 'result edit failed');
    return false;
  } catch (err) {
    logger.warn({ token: call.tokenSymbol, detail: (err as Error).message }, 'result edit failed');
    return false;
  }
}

async function sendWebhook(url: string, s: Swarm): Promise<NotificationDelivery> {
  try {
    const res = await postJson(url, { type: 'swarm.alert', text: textBody(s), swarm: s });
    return delivery('webhook', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('webhook', false, (err as Error).message);
  }
}

function delivery(
  channel: NotificationDelivery['channel'],
  ok: boolean,
  detail?: string,
): NotificationDelivery {
  return { channel, ok, detail, at: Date.now() };
}

/**
 * Fan a swarm out to every configured channel in parallel. Unconfigured
 * channels are silently skipped; a failing channel never blocks the others.
 */
export async function dispatch(s: Swarm): Promise<NotificationDelivery[]> {
  const jobs: Promise<NotificationDelivery>[] = [];
  if (config.notifications.discord) jobs.push(sendDiscord(config.notifications.discord, s));
  // The channel mirrors the alerts feed: every alert AlertEngine fires posts a card,
  // so what you see in /api/alerts is what lands in Telegram. This was PRIME-only from
  // 8838e01, but PRIME_KINDS is ENTRY-only while SOLO is what actually fires — so the
  // channel went silent for a day. s.prime is left alone; it still gates the sniper.
  //
  // …and from 2026-08-09 it is OFF by default (LEGACY_TELEGRAM_ENABLED). The channel
  // speaks v2 now — see dispatchV2() below and the flag's own note in config/env.ts.
  // Discord and generic webhooks are deliberately untouched: they are not the public
  // channel, and anyone consuming them was consuming the legacy shape on purpose.
  if (config.notifications.telegram && config.LEGACY_TELEGRAM_ENABLED) {
    jobs.push(
      sendTelegram(config.notifications.telegram.token, config.notifications.telegram.chatId, s),
    );
  }
  if (config.notifications.webhook) jobs.push(sendWebhook(config.notifications.webhook, s));

  if (jobs.length === 0) {
    logger.debug({ swarm: s.id }, 'no notification channels configured; alert stored only');
    return [];
  }
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (!r.ok) logger.warn({ channel: r.channel, detail: r.detail }, 'notification failed');
  }
  return results;
}

// ── v2 match cards ──────────────────────────────────────────────────────────
// The channel's live stream. Everything above this line is the legacy engine's
// path, kept intact but no longer reaching Telegram.

/**
 * Which Telegram message carries which match, so a result can be edited onto the
 * card that made the call instead of arriving as a new post.
 *
 * Keyed by txHash, which is the match id AND the ledger record id — the join is
 * free and stable across restarts of everything except this map. Bounded: a
 * process that has been up for days must not accumulate a message id for every
 * call it ever made, and a card old enough to be evicted is old enough that
 * nobody is watching it move.
 */
const v2Cards = new Map<string, { messageId: number; html: string }>();
const V2_CARD_LIMIT = 500;

function rememberCard(id: string, messageId: number, html: string): void {
  v2Cards.set(id, { messageId, html });
  if (v2Cards.size > V2_CARD_LIMIT) {
    const oldest = v2Cards.keys().next().value;
    if (oldest != null) v2Cards.delete(oldest);
  }
}

async function sendTelegramV2(
  token: string,
  chatId: string,
  m: V2Match,
): Promise<NotificationDelivery> {
  try {
    const cardHtml = v2TelegramHtml(m);
    const res = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: cardHtml,
      parse_mode: 'HTML',
      link_preview_options: {
        url: mascotUrlForLane(m.lanes[0]),
        prefer_large_media: true,
        show_above_text: true,
      },
    });
    if (res.ok) {
      const messageId = await res
        .json()
        .then((b) => (b as { result?: { message_id?: number } }).result?.message_id)
        .catch(() => undefined);
      if (messageId != null) rememberCard(m.id, messageId, cardHtml);
      return delivery('telegram', true);
    }
    const reason = await res
      .json()
      .then((b) => (b as { description?: string }).description ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    return delivery('telegram', false, reason);
  } catch (err) {
    return delivery('telegram', false, (err as Error).message);
  }
}

/**
 * Fan a v2 match out to every configured channel.
 *
 * Deliberately NOT gated on score, lane, or grade. The gate already ran: v2 only
 * emits a match when a lane wanted it, and adding a second opinion here is how
 * the channel went silent for a day in August — the PRIME-only filter was
 * ENTRY-only while SOLO was what actually fired. One gate, in the place that
 * owns the decision.
 */
export async function dispatchV2(m: V2Match): Promise<NotificationDelivery[]> {
  const jobs: Promise<NotificationDelivery>[] = [];
  if (config.notifications.telegram) {
    jobs.push(
      sendTelegramV2(config.notifications.telegram.token, config.notifications.telegram.chatId, m),
    );
  }
  if (config.notifications.webhook) {
    jobs.push(
      (async () => {
        try {
          const res = await postJson(config.notifications.webhook!, {
            type: 'v2.match',
            text: v2TextBody(m),
            match: m,
          });
          return delivery('webhook', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
        } catch (err) {
          return delivery('webhook', false, (err as Error).message);
        }
      })(),
    );
  }
  if (jobs.length === 0) return [];
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (!r.ok) logger.warn({ channel: r.channel, detail: r.detail, match: m.id }, 'v2 notification failed');
  }
  logger.info(
    { token: m.tokenSymbol, lanes: m.lanes, title: v2Title(m), ok: results.every((r) => r.ok) },
    'v2 match dispatched',
  );
  return results;
}

/**
 * Edit the running result onto a match's own card.
 *
 * Returns false when there is nothing to edit — no card was ever sent, or this
 * process did not send it (a restart empties the map). That is a normal outcome,
 * not a failure: the call still stands, it just stops narrating itself.
 *
 * Telegram rejects an edit whose text is byte-identical ("message is not
 * modified"), so the caller is expected to only edit on a material move; that
 * rejection is logged at debug rather than treated as an error.
 */
export async function editV2Result(id: string, result: V2Result, now: number): Promise<boolean> {
  const tg = config.notifications.telegram;
  const card = v2Cards.get(id);
  if (!tg || !card) return false;
  const text = v2TelegramHtmlWithResult(card.html, result, now);
  try {
    const res = await postJson(`https://api.telegram.org/bot${tg.token}/editMessageText`, {
      chat_id: tg.chatId,
      message_id: card.messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false },
    });
    if (res.ok) return true;
    const reason = await res
      .json()
      .then((b) => (b as { description?: string }).description ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    if (reason.includes('not modified')) {
      logger.debug({ id }, 'v2 result edit: nothing changed');
      return false;
    }
    logger.warn({ id, reason }, 'v2 result edit failed');
    return false;
  } catch (err) {
    logger.warn({ id, err: String(err).slice(0, 200) }, 'v2 result edit threw');
    return false;
  }
}

/** Test seam: does this process hold a card for `id`? Used by the result hook to
 *  skip work for calls it could never edit anyway. */
export function hasV2Card(id: string): boolean {
  return v2Cards.has(id);
}

// ── PnL milestone cards ─────────────────────────────────────────────────────

async function sendMilestoneDiscord(
  url: string,
  call: TrackedCall,
  milestonePct: number,
  dexUrl: string,
): Promise<NotificationDelivery> {
  const embed = {
    title: milestoneHeadline(call, milestonePct),
    url: dexUrl,
    color: 0xffd700, // gold — a celebration card, same tone as PRIME
    fields: [
      { name: 'Peak', value: `+${milestonePct}%`, inline: true },
      { name: 'Now', value: `${call.lastGainPct >= 0 ? '+' : ''}${call.lastGainPct}%`, inline: true },
      { name: 'Entry MC → Now', value: `${usd(call.entryMarketCap)} → ${usd(call.lastMarketCap)}`, inline: true },
      { name: 'Conviction', value: `${call.conviction}/100`, inline: true },
      ...(call.walletLabels.length
        ? [{ name: 'Called by', value: call.walletLabels.join(', '), inline: true }]
        : []),
      { name: 'Links', value: `[📊 Chart](${dexUrl}) · [🔎 Explorer](${explorerUrl(call.token)})`, inline: true },
    ],
    footer: { text: 'Snipurr · PnL milestone' },
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await postJson(url, { username: 'Snipurr', embeds: [embed] });
    return delivery('discord', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('discord', false, (err as Error).message);
  }
}

// Telegram gets NO milestone message. The channel is alerts only — a call's
// result is edited onto its own alert card by editAlertResult() above, so one
// message per call carries both the call and how it went. Discord and generic
// webhooks are unchanged and still receive milestone events as their own posts.

async function sendMilestoneWebhook(
  url: string,
  call: TrackedCall,
  milestonePct: number,
  dexUrl: string,
): Promise<NotificationDelivery> {
  try {
    const res = await postJson(url, {
      type: 'performance.milestone',
      text: milestoneTextBody(call, milestonePct, dexUrl),
      milestonePct,
      call,
    });
    return delivery('webhook', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('webhook', false, (err as Error).message);
  }
}

/**
 * Fan a PnL milestone out to every configured channel in parallel, same
 * shape as dispatch() for swarm alerts. Called by PerformanceTracker's
 * 'milestone' event each time a tracked call's peak crosses a new interval.
 */
export async function dispatchMilestone(
  call: TrackedCall,
  milestonePct: number,
  dexUrl: string,
): Promise<NotificationDelivery[]> {
  // Only genuine runners notify: the +50/+100/+150 crossings are pure spam (they
  // fire on every tracked call, most of which the operator never bought). Below
  // the floor we record the milestone silently and send nothing.
  if (config.PERF_MILESTONE_MIN_PCT > 0 && milestonePct < config.PERF_MILESTONE_MIN_PCT) return [];
  const jobs: Promise<NotificationDelivery>[] = [];
  if (config.notifications.discord) {
    jobs.push(sendMilestoneDiscord(config.notifications.discord, call, milestonePct, dexUrl));
  }
  if (config.notifications.webhook) {
    jobs.push(sendMilestoneWebhook(config.notifications.webhook, call, milestonePct, dexUrl));
  }
  if (jobs.length === 0) return [];
  const results = await Promise.all(jobs);
  for (const r of results) {
    if (!r.ok) logger.warn({ channel: r.channel, detail: r.detail }, 'milestone notification failed');
  }
  return results;
}

export function configuredChannels(): string[] {
  const out: string[] = [];
  if (config.notifications.discord) out.push('discord');
  if (config.notifications.telegram) out.push('telegram');
  if (config.notifications.webhook) out.push('webhook');
  return out;
}
