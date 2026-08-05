import { config } from '../config/env.js';
import { HyperSyncClient } from '../chain/hypersync.js';
import { logger } from '../logger.js';
import { PONS_FACTORY, TOKEN_LAUNCHED_TOPIC, PONS_POOL_FEE, DEFAULT_RESTRICTION_BLOCKS, decodeTokenLaunched, type PonsLaunch } from './config.js';
import { gateFor, gateOpen, launchBlockL1From, type PonsGate } from './gate.js';

/**
 * Pons launch watcher: detect a launch, wait for its entry gate, hand it to the engine.
 *
 * **Runs on HyperSync, and the reason is worth recording** — the two obvious sources both fail:
 *
 *   • The free public RPC cannot do it. [verified 2026-08-05] `rpc.mainnet.chain.robinhood.com`
 *     returns `429 Rate Limit Hit` for a bare `eth_getBlockByNumber`, so a seconds-cadence poll
 *     never gets off the ground. A first cut of this watcher used it and detected **0 launches in
 *     100s** on a chain that launches one every ~20s.
 *   • Alchemy WSS would work but env.ts:441 already refuses metered RPC for continuous listening,
 *     after a 16-minute run burned 627,535 CU.
 *
 * HyperSync is free, unmetered, has no rate limit — and, decisively, exposes **`l1_block_number`**
 * per block, which IS the entry-gate clock on this Nitro chain (see gate.ts). So one source serves
 * both the launch feed and the gate, at zero marginal cost.
 *
 * Latency is a non-issue by construction: the gate is 0–12s wide, so a poll measured in seconds
 * spends slack, not edge.
 */

type LaunchHandler = (l: {
  token: string;
  symbol: string;
  deployer: string;
  initialBuyWei: bigint;
  fee: number;
  seenAt: number;
}) => void | Promise<void>;

interface Armed extends PonsLaunch {
  gate: PonsGate;
}

/** Drop anything that never fired within this many L1 blocks, so a missed tick can't leak the map. */
const STALE_L1_BLOCKS = 25;

interface HsBlock {
  number: number;
  l1_block_number?: number;
}
/** HyperSync returns each topic as its OWN field — there is no `topics` array. Assuming one
 *  silently yielded zero decodes: every log parsed to null and the watcher looked simply idle. */
interface HsLog {
  topic0?: string;
  topic1?: string;
  topic2?: string;
  topic3?: string;
  data?: string;
  block_number?: number;
  transaction_hash?: string;
}
interface HsResponse {
  data?: { blocks?: HsBlock[]; logs?: HsLog[] }[];
  next_block?: number;
}

export class PonsWatcher {
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private readonly armed = new Map<string, Armed>();
  private restrictionBlocks = DEFAULT_RESTRICTION_BLOCKS;
  private lastL1 = 0;

  constructor(private readonly onLaunch: LaunchHandler) {}

  /** One shared client (chain/hypersync.ts) rather than a second copy of the
   *  pagination contract. Keeps its OWN token: this watcher guards live entry
   *  gates and must not share quota with the feed's shadow sweeps. */
  private readonly hs = new HyperSyncClient({
    url: config.PONS_HYPERSYNC_URL,
    token: config.PONS_HYPERSYNC_TOKEN,
    op: 'pons',
  });

  private async query(body: unknown): Promise<HsResponse | null> {
    return (await this.hs.query(body)) as HsResponse | null;
  }

  private async height(): Promise<number | null> {
    return this.hs.height();
  }

  start(): void {
    if (!config.PONS_ENABLED) return;
    // HyperSync requires auth; without a token the client is inert. Say so
    // loudly — an enabled watcher that silently observes nothing is exactly the
    // absence-read-as-data failure this codebase keeps paying for.
    if (!this.hs.enabled) {
      logger.warn(
        'pons: watcher enabled but PONS_HYPERSYNC_TOKEN is unset — NO launches will be detected',
      );
      return;
    }
    logger.info(
      { dryRun: config.PONS_DRY_RUN, buyEth: config.PONS_BUY_ETH, maxOpen: config.PONS_MAX_OPEN },
      config.PONS_DRY_RUN
        ? 'pons: watcher started in DRY RUN (no funds at risk)'
        : 'pons: watcher started — LIVE, real funds',
    );
    this.timer = setInterval(() => void this.tick(), config.POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for the health endpoint / tests. */
  armedCount(): number {
    return this.armed.size;
  }
  currentL1(): number {
    return this.lastL1;
  }

  private async tick(): Promise<void> {
    const head = await this.height();
    if (!head) return;
    if (this.cursor === 0) this.cursor = head - 1; // first tick: start at the newest block

    // TWO queries on purpose. Asking for logs and `blocks: [{}]` in ONE range makes HyperSync
    // return EVERY block in it (1,447 in a measured case), which truncates the page early and
    // leaves the log cursor lagging head — launches then arrive after their gate has closed. So:
    // a light logs-only sweep that can track head, and a 1-block probe for the gate clock.
    const r = await this.query({
      from_block: this.cursor,
      to_block: head + 1,
      logs: [{ address: [PONS_FACTORY.toLowerCase()], topics: [[TOKEN_LAUNCHED_TOPIC]] }],
      field_selection: { log: ['topic0', 'topic1', 'topic2', 'topic3', 'data', 'block_number', 'transaction_hash'] },
    });
    if (!r?.data) return;

    for (const d of r.data) {
      for (const raw of d.logs ?? []) {
        const topics = [raw.topic0, raw.topic1, raw.topic2, raw.topic3].filter((t): t is string => !!t);
        const l = decodeTokenLaunched({
          topics,
          data: raw.data ?? '',
          blockNumber: raw.block_number,
          transactionHash: raw.transaction_hash,
        });
        if (!l) continue;
        const launchL1 = launchBlockL1From(l.restrictionsEndBlock, this.restrictionBlocks);
        this.armed.set(l.token, { ...l, gate: gateFor(launchL1, this.restrictionBlocks) });
      }
    }
    // Advance only on a successful page, so a failed query re-sweeps rather than skips. When
    // HyperSync stops short it returns next_block; otherwise we are caught up to head.
    this.cursor = r.next_block && r.next_block > this.cursor ? r.next_block : head + 1;

    // Gate clock: the head block's l1_block_number, one block wide.
    const hb = await this.query({
      from_block: head - 1,
      to_block: head + 1,
      blocks: [{}],
      field_selection: { block: ['number', 'l1_block_number'] },
    });
    for (const d of hb?.data ?? []) {
      for (const b of d.blocks ?? []) {
        if (typeof b.l1_block_number === 'number' && b.l1_block_number > this.lastL1) this.lastL1 = b.l1_block_number;
      }
    }

    if (!this.lastL1 || !this.armed.size) return;
    for (const [token, a] of this.armed) {
      if (gateOpen(this.lastL1, a.gate)) {
        this.armed.delete(token);
        void this.fire(a);
      } else if (this.lastL1 > a.gate.opensAtL1 + STALE_L1_BLOCKS) {
        this.armed.delete(token);
      }
    }
  }

  private async fire(a: Armed): Promise<void> {
    try {
      await this.onLaunch({
        token: a.token,
        symbol: a.token.slice(0, 8), // the event carries no symbol; a metadata read isn't worth the latency
        deployer: a.deployer,
        initialBuyWei: a.initialBuyWei,
        fee: PONS_POOL_FEE,
        seenAt: a.seenAt,
      });
    } catch (err) {
      logger.error({ token: a.token, err: String(err) }, 'pons: launch handler threw');
    }
  }
}
