import { config } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * Bot HEALTH / STATE notifications — separate from the swarm alert cards in
 * ./index.ts. This is the "is my sniper alive and trading?" channel: it fires on
 * wallet unlock/lock, feed health, daily-loss, and the operator's own buys/sells.
 *
 * The Telegram channel was rebuilt (2026-08) so it carries only (a) PRIME feed
 * alerts (see index.ts gating) and (b) these health/trade lines — never the old
 * milestone-rocket spam. All sends are best-effort and never throw into a trade
 * path. Unconfigured Telegram (no token/chat) silently no-ops.
 */

const TIMEOUT_MS = 4000;

export type BotStateKind =
  | 'resumed' // process booted and an operator wallet auto-unlocked → trading live
  | 'wallet-locked' // sniper is ON but the wallet is locked → it cannot trade (dark)
  | 'feed-dead' // the swarm feed went silent past the stale threshold
  | 'feed-recovered' // the feed started delivering again after a dead spell
  | 'daily-loss' // realized daily loss crossed the configured threshold (informational)
  | 'bought' // the operator's sniper opened a position
  | 'sold' // the operator's sniper closed a position
  | 'disabled' // an operator turned their sniper OFF
  | 'enabled'; // an operator turned their sniper ON

/** Per-kind minimum gap between identical-key alerts, so a flapping condition
 *  (feed briefly quiet, repeated lock checks) can't spam the channel. */
const DEDUP_MS: Partial<Record<BotStateKind, number>> = {
  'wallet-locked': 30 * 60_000,
  'feed-dead': 15 * 60_000,
  'feed-recovered': 60_000,
  'daily-loss': 6 * 60 * 60_000,
  resumed: 60_000,
};
const lastSent = new Map<string, number>();

async function post(text: string): Promise<void> {
  const tg = config.notifications.sniperTelegram;
  if (!tg) return; // dedicated sniper bot not configured on this deployment → no-op
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'notify/state: telegram send failed');
  } finally {
    clearTimeout(t);
  }
}

const ICON: Record<BotStateKind, string> = {
  resumed: '🟢',
  'wallet-locked': '🔒',
  'feed-dead': '📡❌',
  'feed-recovered': '📡✅',
  'daily-loss': '🩸',
  bought: '🟩',
  sold: '🟦',
  disabled: '⏸️',
  enabled: '▶️',
};

/**
 * Fire a health/state alert. `dedupKey` (default = kind) plus the per-kind
 * DEDUP_MS window suppresses repeats — pass a position-specific key for
 * bought/sold so distinct trades always send. Fire-and-forget.
 */
export function notifyBotState(kind: BotStateKind, text: string, dedupKey?: string): void {
  const key = `${kind}:${dedupKey ?? ''}`;
  const now = Date.now();
  const gap = DEDUP_MS[kind] ?? 0;
  if (gap > 0) {
    const prev = lastSent.get(key);
    if (prev && now - prev < gap) return;
  }
  lastSent.set(key, now);
  logger.info({ kind, text }, 'sniper state alert');
  void post(`${ICON[kind]} <b>SNIPER</b> · ${text}`);
}
