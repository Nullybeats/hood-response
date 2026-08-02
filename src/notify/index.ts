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
  milestoneTelegramHtml,
  milestoneTextBody,
} from './format.js';
import { explorerUrl, sigmaBuyUrl, basedBuyUrl } from '../links.js';

const TIMEOUT_MS = 4000;

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
        value: `${usd(s.marketCap)}${s.priceLive ? '' : ' (est)'}`,
        inline: true,
      },
      { name: 'Window', value: `${s.windowSeconds}s`, inline: true },
      { name: `Wallets (${s.walletCount})`, value: s.walletSummary, inline: true },
      ...(s.athMarketCap != null
        ? [
            {
              name: '🏔️ ATH MC',
              value: `${usd(s.athMarketCap)}${s.athMarketCap > 0 && s.marketCap > 0 ? ` (${Math.round(((s.marketCap - s.athMarketCap) / s.athMarketCap) * 1000) / 10}%)` : ''}`,
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
    footer: { text: 'Swarm the Fly · Robinhood Chain' },
    timestamp: new Date(s.lastSeen).toISOString(),
  };
  try {
    const res = await postJson(url, { username: 'Swarm the Fly', embeds: [embed] });
    return delivery('discord', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('discord', false, (err as Error).message);
  }
}

async function sendTelegram(
  token: string,
  chatId: string,
  s: Swarm,
): Promise<NotificationDelivery> {
  try {
    const res = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: telegramHtml(s),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (res.ok) return delivery('telegram', true);
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
  if (config.notifications.telegram) {
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
    footer: { text: 'Swarm the Fly · PnL milestone' },
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await postJson(url, { username: 'Swarm the Fly', embeds: [embed] });
    return delivery('discord', res.ok, res.ok ? undefined : `HTTP ${res.status}`);
  } catch (err) {
    return delivery('discord', false, (err as Error).message);
  }
}

async function sendMilestoneTelegram(
  token: string,
  chatId: string,
  call: TrackedCall,
  milestonePct: number,
  dexUrl: string,
): Promise<NotificationDelivery> {
  try {
    const res = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: milestoneTelegramHtml(call, milestonePct, dexUrl),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (res.ok) return delivery('telegram', true);
    const reason = await res
      .json()
      .then((b) => (b as { description?: string }).description ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    return delivery('telegram', false, reason);
  } catch (err) {
    return delivery('telegram', false, (err as Error).message);
  }
}

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
  if (config.notifications.telegram) {
    jobs.push(
      sendMilestoneTelegram(
        config.notifications.telegram.token,
        config.notifications.telegram.chatId,
        call,
        milestonePct,
        dexUrl,
      ),
    );
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
