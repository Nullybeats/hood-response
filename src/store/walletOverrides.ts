/**
 * Manual wallet-registry overrides (persisted). The tracked set is SEEDED from code
 * (src/data/seed.ts) on every boot, so API add/remove/retier would otherwise vanish on
 * restart. This layer records the operator's manual changes to a JSON file and re-applies
 * them ON TOP of the seed at startup, so managing wallets from the UI actually sticks.
 *
 * Shape: `upserts` are added-or-modified wallets (keyed by address); `removed` are seed
 * addresses explicitly untracked. Apply order at boot: seed → delete removed → set upserts.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { TrackedWallet } from '../types.js';

interface Overrides {
  upserts: Record<string, TrackedWallet>;
  removed: string[];
}

let state: Overrides = { upserts: {}, removed: [] };
let loaded = false;

function path(): string {
  return config.WALLET_OVERRIDES_PATH;
}

/** Load overrides from disk once (sync — called at store construction). No-op if unconfigured. */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (!path()) return;
  try {
    const raw = readFileSync(path(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Overrides>;
    state = { upserts: parsed.upserts ?? {}, removed: parsed.removed ?? [] };
  } catch {
    /* missing/empty file → clean slate */
  }
}

function save(): void {
  if (!path()) return;
  try {
    mkdirSync(dirname(path()), { recursive: true });
    const tmp = `${path()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path());
  } catch (err) {
    logger.warn({ err: String(err) }, 'wallet overrides: save failed');
  }
}

/** Re-apply persisted manual changes on top of the freshly-seeded wallet map. */
export function applyWalletOverrides(wallets: Map<string, TrackedWallet>): void {
  ensureLoaded();
  for (const addr of state.removed) wallets.delete(addr.toLowerCase());
  for (const w of Object.values(state.upserts)) wallets.set(w.address.toLowerCase(), w);
  const n = state.removed.length + Object.keys(state.upserts).length;
  if (n > 0) logger.info({ upserts: Object.keys(state.upserts).length, removed: state.removed.length }, 'wallet overrides applied');
}

/** Record an add/modify so it survives restart. */
export function recordWalletUpsert(w: TrackedWallet): void {
  ensureLoaded();
  const addr = w.address.toLowerCase();
  state.upserts[addr] = { ...w, address: addr };
  state.removed = state.removed.filter((a) => a.toLowerCase() !== addr);
  save();
}

/** Record a removal so it survives restart (even if the wallet was a seed one). */
export function recordWalletRemove(address: string): void {
  ensureLoaded();
  const addr = address.toLowerCase();
  delete state.upserts[addr];
  if (!state.removed.some((a) => a.toLowerCase() === addr)) state.removed.push(addr);
  save();
}
