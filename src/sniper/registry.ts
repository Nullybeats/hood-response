import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../logger.js';
import type { PriceOracle } from '../chain/price.js';
import type { Swarm } from '../types.js';
import { SniperEngine } from './engine.js';
import { SniperStateStore } from './state.js';
import { notifyBotState } from '../notify/state.js';
import { findWalletOwner, sharedWallets } from './walletShare.js';

/**
 * Multi-tenant sniper: one {@link SniperEngine} per admin (keyed by their cipherfi
 * email). Each engine holds its OWN hot wallet, positions, settings and on-disk
 * store, so two admins run fully independent snipers off the same alert stream.
 *
 * cipherfi authenticates the browser and vouches for the operator by injecting an
 * `x-user-id` header on every proxied /api/sniper/* call (see api.ts); hood-response
 * trusts it because the whole surface is already behind the shared admin password
 * and only reachable from the cipherfi box. Callers with no id fall back to the
 * 'default' engine (dev / direct access), preserving the old single-wallet behaviour.
 *
 * Persistence: SNIPER_STORE_PATH="/data/sniper-positions.json" becomes
 * "/data/sniper-positions.<slug>.json" per owner. An owners index next to it lets
 * every engine restore on boot with its correct email key (a slug alone is lossy).
 */
export class SniperRegistry {
  private readonly engines = new Map<string, SniperEngine>();
  readonly state = new SniperStateStore();
  private started = false;
  /** Owner emails known on disk — persisted so boot can rebuild every engine. */
  private readonly ownersIndexPath: string;

  constructor(private readonly price: PriceOracle) {
    this.ownersIndexPath = config.SNIPER_STORE_PATH
      ? join(dirname(config.SNIPER_STORE_PATH), 'sniper-owners.json')
      : '';
  }

  /** Normalise an owner id to a filesystem-safe slug (emails → a_b_com). */
  private static slug(owner: string): string {
    return owner.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
  }

  /** Per-owner store path: insert `.<slug>` before the extension of the base path. */
  private pathFor(base: string, owner: string): string {
    if (!base) return '';
    const dir = dirname(base);
    const ext = extname(base); // e.g. ".json"
    const stem = basename(base, ext); // e.g. "sniper-positions"
    return join(dir, `${stem}.${SniperRegistry.slug(owner)}${ext}`);
  }

  private async fileExists(p: string): Promise<boolean> {
    if (!p) return false;
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Build (but don't yet load) an engine for `owner` with its own paths. */
  private make(owner: string): SniperEngine {
    return new SniperEngine(this.price, undefined, undefined, {
      owner,
      storePath: this.pathFor(config.SNIPER_STORE_PATH, owner),
      journalPath: this.pathFor(config.SNIPER_JOURNAL_PATH, owner),
      state: this.state,
    });
  }

  /**
   * Get (creating on first touch) the engine for an owner. A freshly-created
   * engine is loaded from its own file, started if the registry is running, and
   * recorded in the owners index so it comes back on the next boot.
   */
  async get(ownerRaw: string | undefined | null): Promise<SniperEngine> {
    const owner = (ownerRaw && ownerRaw.trim().toLowerCase()) || 'default';
    const existing = this.engines.get(owner);
    if (existing) return existing;

    const engine = this.make(owner);
    // One-time migration: if this owner has no file yet but a legacy single-wallet
    // store exists and this owner is the designated legacy owner, seed from it so
    // the currently-running positions aren't orphaned by the multi-wallet switch.
    await this.maybeSeedFromLegacy(owner, engine).catch(() => undefined);
    await engine.load();
    if (this.started) engine.start();
    this.engines.set(owner, engine);
    await this.rememberOwner(owner);
    logger.info({ owner }, 'sniper: engine created for owner');
    return engine;
  }

  /** Synchronous lookup for hot paths that must not create — returns undefined if absent. */
  peek(ownerRaw: string | undefined | null): SniperEngine | undefined {
    const owner = (ownerRaw && ownerRaw.trim().toLowerCase()) || 'default';
    return this.engines.get(owner);
  }

  /** All live engines — the alert stream is broadcast to each. */
  all(): SniperEngine[] {
    return [...this.engines.values()];
  }

  /**
   * Which OTHER owner already has this wallet address enrolled, if any.
   *
   * The per-position sell cap stops one tenant dumping another's lot, but it cannot make a shared
   * wallet's BALANCE two balances: both engines size their buys against the same ETH, so one
   * owner's fill silently spends what the other's sizing already counted on. That is not fixable
   * downstream — the only real fix is not to share the wallet — so this exists to refuse the
   * condition at the moment it would be created, rather than warn about it a boot later.
   *
   * `null` when the address is free. Case-insensitive; an unenrolled or locked engine has no
   * address and is skipped.
   */
  ownerOfWallet(address: string, exceptOwner: string): string | null {
    return findWalletOwner(this.engines.values(), address, exceptOwner);
  }

  /** Announce a shared wallet NOW rather than at the next boot — called after a deliberate override. */
  announceSharedWallets(): void {
    this.warnOnSharedWallets();
  }

  /** Fan an alert out to every engine; each decides independently by its own
   *  settings + wallet. First-signal status is READ once globally before
   *  fan-out, so two operators both see the same answer for one alert, and is
   *  CLAIMED later by whichever engine finds the signal actionable — a signal
   *  every operator rejected must not burn the token. See state.hasSignalToken. */
  onAlert(swarm: Swarm): void {
    const firstSignal = !this.state.hasSignalToken(swarm.token);
    const annotated = { ...swarm, firstSignal };
    for (const engine of this.engines.values()) void engine.onAlert(annotated);
  }

  /**
   * Fan a Pons launch out to every operator's engine, exactly as `onAlert` does for feed alerts.
   * Each engine applies its own rails and holds its own wallet, so one operator opting out or
   * hitting a cap never affects another.
   */
  /** Any engine with a usable wallet — the paper book only needs SOMETHING that can quote. */
  any(): SniperEngine | null {
    for (const e of this.engines.values()) return e;
    return null;
  }

  onPonsLaunch(launch: { token: string; symbol: string; deployer: string; initialBuyWei: bigint; fee: number; seenAt: number }): void {
    for (const engine of this.engines.values()) void engine.onPonsLaunch(launch);
  }

  private async maybeSeedFromLegacy(owner: string, engine: SniperEngine): Promise<void> {
    const legacyOwner = (process.env.SNIPER_LEGACY_OWNER || '').trim().toLowerCase();
    if (!legacyOwner || owner !== legacyOwner) return;
    const legacyPath = config.SNIPER_STORE_PATH;
    const ownerPath = this.pathFor(config.SNIPER_STORE_PATH, owner);
    if (!legacyPath || !ownerPath || legacyPath === ownerPath) return;
    if (await this.fileExists(ownerPath)) return; // already migrated
    if (!(await this.fileExists(legacyPath))) return;
    await mkdir(dirname(ownerPath), { recursive: true }).catch(() => undefined);
    await copyFile(legacyPath, ownerPath);
    logger.info({ owner, from: legacyPath, to: ownerPath }, 'sniper: migrated legacy positions to owner store');
  }

  // ── Owners index (so boot rebuilds every engine with its email key) ───────────
  private async readOwners(): Promise<string[]> {
    if (!this.ownersIndexPath) return [];
    try {
      const raw = await readFile(this.ownersIndexPath, 'utf8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private async rememberOwner(owner: string): Promise<void> {
    if (!this.ownersIndexPath || owner === 'default') return;
    const owners = new Set(await this.readOwners());
    if (owners.has(owner)) return;
    owners.add(owner);
    try {
      await mkdir(dirname(this.ownersIndexPath), { recursive: true });
      await writeFile(this.ownersIndexPath, JSON.stringify([...owners]));
    } catch (err) {
      logger.warn({ err: String(err) }, 'sniper: could not write owners index');
    }
  }

  /** Boot: restore an engine for every known owner (positions come back even
   *  before that admin reconnects, so the other admin can view them read-only). */
  async loadAll(): Promise<void> {
    const owners = await this.readOwners();
    const legacyOwner = (process.env.SNIPER_LEGACY_OWNER || '').trim().toLowerCase();
    if (legacyOwner && !owners.includes(legacyOwner)) owners.push(legacyOwner);
    for (const owner of owners) await this.get(owner);
    logger.info({ engines: this.engines.size }, 'sniper: restored engines');
  }

  /**
   * Boot resume: for every restored engine that is ON (mode 'live'), auto-unlock
   * the enrolled wallet when the owner is in SNIPER_AUTO_UNLOCK_OWNERS — so the
   * sniper resumes trading immediately after a restart/deploy instead of sitting
   * dark until a manual unlock (the biggest measured uptime leak). An owner that
   * is ON but not auto-unlockable (or whose unlock fails) fires a 'wallet-locked'
   * health alert so the operator knows it's dark. Call AFTER loadAll().
   */
  resumeAll(): void {
    for (const engine of this.engines.values()) {
      if (engine.executionMode !== 'live') continue; // OFF by choice → nothing to resume
      const auto = config.autoUnlockOwners.has(engine.owner.trim().toLowerCase());
      if (auto && engine.keyEnrolled) {
        try {
          const addr = engine.unlockPrivateKey();
          logger.info({ owner: engine.owner, addr }, 'sniper: auto-unlocked wallet on boot');
          notifyBotState('resumed', `resumed after restart · wallet ${addr.slice(0, 8)}… unlocked · trading live`);
        } catch (err) {
          logger.error({ owner: engine.owner, err: String(err) }, 'sniper: auto-unlock failed on boot');
          notifyBotState('wallet-locked', `auto-unlock FAILED on boot — ${String(err).slice(0, 80)}`, engine.owner);
        }
      } else if (auto) {
        notifyBotState('wallet-locked', 'sniper is ON but no wallet is enrolled to auto-unlock', engine.owner);
      }
      // Non-auto owners (customers) intentionally stay locked-at-rest; no alert.
    }
    this.warnOnSharedWallets();
  }

  /**
   * Report any wallet address enrolled by more than one owner.
   *
   * Tenants are structurally separate — own engine, own store, own executor, own key — so this
   * is not a leak. It is an OPERATIONAL condition: two owners can enrol the SAME key, and then a
   * sell by one is a transfer out of the other's balance too. The executor already sizes every
   * sell to the position's own recorded lot (see `sell()` in executor.ts), which is what stops a
   * sibling being dumped; but that cap is the only thing standing between a shared wallet and a
   * cross-tenant surprise, and until now nothing said out loud that the wallet WAS shared. One
   * position closed `reconciled` at -100.59% before that cap existed.
   *
   * Log-only, deliberately. Refusing to boot on a shared wallet would take the sniper dark over a
   * condition the operator may have chosen; this makes it visible and leaves the choice.
   */
  private warnOnSharedWallets(): void {
    for (const [addr, owners] of sharedWallets(this.engines.values())) {
      logger.warn(
        { addr, owners },
        'sniper: SHARED WALLET — one address is enrolled by multiple owners; sells are capped per position, but balances are not isolated',
      );
      notifyBotState(
        'wallet-locked',
        `⚠️ shared wallet ${addr.slice(0, 8)}… is enrolled by ${owners.length} owners (${owners.join(', ')}) — balances are not isolated`,
      );
    }
  }

  start(): void {
    this.started = true;
    for (const engine of this.engines.values()) engine.start();
  }

  stop(): void {
    this.started = false;
    for (const engine of this.engines.values()) engine.stop();
  }

  async flushAll(): Promise<void> {
    await Promise.all(this.all().map((e) => e.flush().catch(() => undefined)));
  }
}
