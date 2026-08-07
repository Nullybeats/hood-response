/**
 * The unknown-law: one place that decides whether a fact sheet may proceed.
 *
 * The legacy engine had no such place, and handled missing data differently in
 * every gate it happened to write: market cap failed CLOSED (unknown → rejected),
 * pair age failed OPEN (unknown → allowed through), the dust floor was skipped
 * entirely for unpriced tokens — which is to say, skipped for exactly the
 * brand-new coins it was meant to police — and the safety screen reported `ok`
 * when no check had run at all. Four gates, four different meanings for "we
 * don't know", none of them written down.
 *
 * Here there is one rule, and it is the conservative one:
 *
 *   measured  → decide on the value
 *   unknown   → RETRY, never pass. Enrichment is often merely late.
 *   failed    → BLOCK. A real negative result is final.
 *
 * Retrying is not free, so it is bounded: an alert whose facts never resolve is
 * eventually dropped with a reason, rather than pending forever. That bound is
 * the honest version of "unknown never passes" — it does not quietly become a
 * pass once we get tired of waiting.
 *
 * What this gate does NOT do is decide whether an alert is interesting. It
 * enforces house rules only — the facts that must be settled before any lane can
 * reason at all. Lane-specific requirements belong to lanes, so that a lane
 * needing pair age cannot block one that doesn't.
 */

import type { FactSheet } from './facts/sheet.js';

export type GateDecision = 'pass' | 'retry' | 'block';

export interface GateVerdict {
  decision: GateDecision;
  /** Which fact drove it, for the diary. Null when everything passed. */
  fact: string | null;
  reason: string;
}

export interface GateOptions {
  /** How many times a sheet may be retried before it is dropped. */
  maxAttempts: number;
  /** How long a sheet may stay unresolved, in ms, regardless of attempts. */
  maxPendingMs: number;
}

export const DEFAULT_GATE_OPTIONS: GateOptions = {
  /**
   * [config] Sized against how long enrichment ACTUALLY takes, measured.
   *
   * The first values (8 attempts / 45s) were guessed from how quickly a live
   * alert must fire, and they were wrong for this job: brand-new pairs need a
   * canonical pool read plus a supply backfill plus an external safety screen,
   * and trades were being dropped as "unresolved" while that work was still in
   * flight. The legacy signal queue already backs off to a full minute per
   * attempt and persists across restarts, so 45s was well short of what the
   * rest of the system considers normal.
   *
   * A shadow that emits nothing loses nothing by waiting: a fact that resolves
   * at 90s still tells us it was obtainable, which is the measurement. When v2
   * eventually drives live alerts it will need a much tighter budget — but that
   * is a decision to make against this data, not ahead of it.
   */
  maxAttempts: 30,
  maxPendingMs: 180_000,
};

/**
 * House rules. Deliberately short — each entry is a fact that no lane can
 * sensibly reason without, and adding to this list makes the whole pipeline
 * stricter, so it should be argued for rather than grown by habit.
 */
const REQUIRED_FACTS = ['canSell', 'marketCap'] as const;

/**
 * Decide what to do with a sheet.
 *
 * `attempt` counts prior evaluations of this same sheet (0 on first sight), and
 * `pendingMs` is how long it has been waiting. Both are passed in rather than
 * tracked here so the gate stays pure and a replay reproduces its decisions.
 */
export function gate(
  sheet: FactSheet,
  attempt: number,
  pendingMs: number,
  opts: GateOptions = DEFAULT_GATE_OPTIONS,
): GateVerdict {
  // A proven negative is final, and is checked before the retry budget so that a
  // known-bad token is never reported as merely "unresolved".
  for (const name of REQUIRED_FACTS) {
    const fact = sheet[name];
    if (fact.provenance === 'failed') {
      return { decision: 'block', fact: name, reason: fact.reason ?? `${name} failed` };
    }
  }

  // Sellability is the one house rule with a value-level verdict: a token that
  // was checked and cannot be sold is a trap, not a trade.
  if (sheet.canSell.provenance === 'measured' && sheet.canSell.value === false) {
    return { decision: 'block', fact: 'canSell', reason: 'checked and cannot be sold' };
  }

  const missing = REQUIRED_FACTS.filter((name) => sheet[name].provenance === 'unknown');
  if (missing.length > 0) {
    const names = missing.join(', ');
    if (attempt + 1 >= opts.maxAttempts) {
      return {
        decision: 'block',
        fact: missing[0]!,
        reason: `${names} still unresolved after ${attempt + 1} attempts — dropped, never assumed`,
      };
    }
    if (pendingMs >= opts.maxPendingMs) {
      return {
        decision: 'block',
        fact: missing[0]!,
        reason: `${names} still unresolved after ${Math.round(pendingMs / 1000)}s — dropped, never assumed`,
      };
    }
    return { decision: 'retry', fact: missing[0]!, reason: `waiting on ${names}` };
  }

  return { decision: 'pass', fact: null, reason: 'house rules satisfied' };
}
