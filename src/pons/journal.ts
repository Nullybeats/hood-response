/**
 * Pons decision journal — what the executor decided, and why.
 *
 * Exists because a dry run that only writes to the log is unreviewable: the whole point of running
 * dry is to accumulate evidence about fill rate, gate timing and which rails actually bite, and none
 * of that is answerable by grepping pm2 output. Every outcome is recorded, including the skips —
 * "we passed on 40 launches because the daily cap was hit" is exactly the kind of thing that
 * silently invalidates a day of data if it isn't visible.
 *
 * In-memory and bounded on purpose. This is observational data for a strategy that is still being
 * decided on, not the trade record: real positions already persist through `SniperStateStore`, and a
 * live Pons buy shows up there as an ordinary Position tagged `kind: 'PONS'`. A restart losing the
 * dry-run journal costs nothing that the on-chain record doesn't already hold.
 */

export type PonsOutcome =
  | 'dry-run' // would have bought; nothing broadcast
  | 'bought' // real fill
  | 'buy-failed'
  | 'skipped'; // a rail vetoed it — `reason` says which

export interface PonsDecision {
  at: number;
  owner: string;
  token: string;
  symbol: string;
  deployer: string;
  /** The deployer's own atomic buy, in ETH — the conviction signal that rides in the launch event. */
  selfBuyEth: number;
  sizeEth: number;
  outcome: PonsOutcome;
  reason?: string;
  txHash?: string;
  /**
   * ms from decoding the launch to acting on it.
   *
   * Reads two ways and the difference matters: a value near the 0–12s gate width means we armed
   * EARLY and waited for the gate (good — we were ready before it opened), while a near-zero value
   * means we only saw the launch after its gate had already opened and fired late.
   */
  gateLatencyMs: number;
  /**
   * Result of simulating the REAL buy at the gate (dry run only). `wouldFill` is the number that
   * matters — it is the difference between "we decided to buy" and "the buy would have worked".
   * Entry slippage falls out of quoted vs simulated.
   */
  sim?: { wouldFill: boolean; quotedTokens: number; simulatedTokens: number; gas: string | null };
}

const MAX = 300;
const entries: PonsDecision[] = [];

export function recordPonsDecision(d: PonsDecision): void {
  entries.push(d);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

/** Newest first. `owner` narrows to one operator's engine; omitted returns every engine's. */
export function ponsDecisions(limit = 100, owner?: string): PonsDecision[] {
  const src = owner ? entries.filter((e) => e.owner === owner) : entries;
  return src.slice(-limit).reverse();
}

export interface PonsJournalSummary {
  total: number;
  dryRun: number;
  bought: number;
  failed: number;
  skipped: number;
  /** Share of decisions where we were armed and waiting before the gate opened. */
  armedEarlyPct: number | null;
  medianGateLatencyMs: number | null;
  skipReasons: Record<string, number>;
  /** Of the dry-run buys we simulated, how many would actually have filled. */
  simulated: number;
  wouldFill: number;
  wouldFillPct: number | null;
  /** Median entry slippage, quoted vs simulated, in %. */
  medianSlippagePct: number | null;
}

/** Aggregate for the UI header. Deliberately counts skips by reason — see the note above. */
export function ponsJournalSummary(owner?: string): PonsJournalSummary {
  const src = owner ? entries.filter((e) => e.owner === owner) : entries;
  const acted = src.filter((e) => e.outcome !== 'skipped');
  const lat = acted.map((e) => e.gateLatencyMs).sort((a, b) => a - b);
  const skipReasons: Record<string, number> = {};
  for (const e of src) if (e.outcome === 'skipped' && e.reason) skipReasons[e.reason] = (skipReasons[e.reason] ?? 0) + 1;
  // >1s of wait means we held the launch until the gate opened rather than arriving after it.
  const armedEarly = acted.filter((e) => e.gateLatencyMs > 1000).length;
  const sims = src.filter((e) => e.sim);
  const filled = sims.filter((e) => e.sim!.wouldFill);
  const slip = filled
    .filter((e) => e.sim!.quotedTokens > 0)
    .map((e) => (1 - e.sim!.simulatedTokens / e.sim!.quotedTokens) * 100)
    .sort((a, b) => a - b);
  return {
    simulated: sims.length,
    wouldFill: filled.length,
    wouldFillPct: sims.length ? (100 * filled.length) / sims.length : null,
    medianSlippagePct: slip.length ? slip[Math.floor(slip.length / 2)]! : null,
    total: src.length,
    dryRun: src.filter((e) => e.outcome === 'dry-run').length,
    bought: src.filter((e) => e.outcome === 'bought').length,
    failed: src.filter((e) => e.outcome === 'buy-failed').length,
    skipped: src.filter((e) => e.outcome === 'skipped').length,
    armedEarlyPct: acted.length ? (100 * armedEarly) / acted.length : null,
    medianGateLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
    skipReasons,
  };
}
