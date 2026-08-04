import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { PerformanceTracker, TrackedCall } from '../engine/performance.js';

const API = 'https://api.telegram.org/bot';
const LONG_POLL_SECONDS = 25;

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
}

// ── formatting: compact one-liner per ticker ──────────────────────────────────
// "#1 $GME 200k - 1.1 mill 5x -10mins ago 7/10"

function trimNum(n: number, maxDecimals: number): string {
  return n.toFixed(maxDecimals).replace(/\.?0+$/, '');
}

export function shortMC(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000, 2)} mill`;
  if (n >= 1_000) return `${trimNum(n / 1_000, 1)}k`;
  return `${Math.round(n)}`;
}

export function multiplierStr(entry: number, now: number): string {
  if (!(entry > 0) || !Number.isFinite(now)) return '?x';
  return `${trimNum(now / entry, 1)}x`;
}

export function ageStr(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}min${min === 1 ? '' : 's'}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Conviction (0-100) collapsed to the X/10 shown in the one-liner. */
export function convictionTenth(c: number): number {
  return Math.max(0, Math.min(10, Math.round(c / 10)));
}

/** One summary line, e.g. "#1 $GME 200k - 1.1 mill 5x -10mins ago 7/10".
 *  `peak` shows the call's best-ever mark (for /t5, /t10); otherwise shows
 *  where it stands right now (for /l5). */
export function formatLine(rank: number, call: TrackedCall, peak: boolean, now = Date.now()): string {
  const endPrice = peak ? call.maxPrice : call.lastPrice;
  const endMc = peak
    ? call.entryMarketCap != null && call.entryPrice > 0
      ? call.entryMarketCap * (call.maxPrice / call.entryPrice)
      : call.entryMarketCap
    : call.lastMarketCap;
  const mult = multiplierStr(call.entryPrice, endPrice);
  const age = ageStr(now - call.entryAt);
  return `#${rank} $${call.tokenSymbol} ${shortMC(call.entryMarketCap)} - ${shortMC(endMc)} ${mult} -${age} ago ${convictionTenth(call.conviction)}/10`;
}

/** /t5 and /t10: best peak performers among calls entered in the last 24h. */
export function topPlaysText(performance: PerformanceTracker, n: number): string {
  const cutoff = Date.now() - 24 * 3_600_000;
  const calls = performance
    .list()
    .filter((c) => c.entryAt >= cutoff)
    .sort((a, b) => b.maxGainPct - a.maxGainPct)
    .slice(0, n);
  if (calls.length === 0) return 'No tracked calls in the last 24h yet.';
  const header = `🏆 Top ${calls.length} plays (24h)`;
  return [header, ...calls.map((c, i) => formatLine(i + 1, c, true))].join('\n');
}

/** /l5: the most recent calls, showing where they stand right now. */
export function lastAlertsText(performance: PerformanceTracker, n: number): string {
  const calls = [...performance.list()].sort((a, b) => b.entryAt - a.entryAt).slice(0, n);
  if (calls.length === 0) return 'No tracked calls yet.';
  const header = `📋 Last ${calls.length} call${calls.length === 1 ? '' : 's'}`;
  return [header, ...calls.map((c, i) => formatLine(i + 1, c, false))].join('\n');
}

/** First whitespace-delimited token, "/cmd@botname" stripped to "/cmd", lowercased. */
export function parseCommand(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? '').split('@')[0]!.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inbound Telegram slash commands (/t5, /t10, /l5) answered from live
 * performance-tracker data. Long-polls Telegram's getUpdates rather than
 * requiring a public webhook URL, since the bot is otherwise outbound-only.
 * Replies only in the configured alert chat, so wallet-labeled data never
 * reaches a stranger who happens to DM the bot.
 */
export class TelegramCommands {
  private offset = 0;
  private stopped = true;

  constructor(private readonly performance: PerformanceTracker) {}

  start(): void {
    if (!config.notifications.telegram) return;
    this.stopped = false;
    logger.info('telegram commands: listening for /t5 /t10 /l5');
    void this.run();
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    const tg = config.notifications.telegram;
    if (!tg) return;
    // Discard any backlog accumulated while the bot was offline, so a redeploy
    // never replays stale commands.
    try {
      const backlog = await this.getUpdates(tg.token, 0);
      const lastId = backlog[backlog.length - 1]?.update_id;
      if (lastId != null) this.offset = lastId + 1;
    } catch (err) {
      logger.warn({ err: String(err) }, 'telegram commands: catch-up failed');
    }

    while (!this.stopped) {
      let updates: TgUpdate[];
      try {
        updates = await this.getUpdates(tg.token, LONG_POLL_SECONDS);
      } catch (err) {
        logger.warn({ err: String(err) }, 'telegram commands: poll error');
        await sleep(3000);
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        await this.handleUpdate(tg, u).catch((err: unknown) =>
          logger.warn({ err: String(err) }, 'telegram commands: handler error'),
        );
      }
    }
  }

  private async getUpdates(token: string, timeoutSec: number): Promise<TgUpdate[]> {
    const url =
      `${API}${token}/getUpdates?offset=${this.offset}&timeout=${timeoutSec}` +
      `&allowed_updates=%5B%22message%22%5D`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (timeoutSec + 10) * 1000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      return body.result ?? [];
    } finally {
      clearTimeout(t);
    }
  }

  private async handleUpdate(tg: { token: string; chatId: string }, u: TgUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text) return;
    if (String(msg.chat.id) !== String(tg.chatId)) return;
    const cmd = parseCommand(msg.text);
    let reply: string | null = null;
    if (cmd === '/t5') reply = topPlaysText(this.performance, 5);
    else if (cmd === '/t10') reply = topPlaysText(this.performance, 10);
    else if (cmd === '/l5') reply = lastAlertsText(this.performance, 5);
    if (reply == null) return;
    await this.sendMessage(tg.token, tg.chatId, reply);
  }

  private async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    try {
      const res = await fetch(`${API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'telegram commands: reply failed');
    } catch (err) {
      logger.warn({ err: String(err) }, 'telegram commands: reply failed');
    }
  }
}
