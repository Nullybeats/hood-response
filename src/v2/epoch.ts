/**
 * When the CURRENT lane rules took effect.
 *
 * A call made under retired rules is not a call this engine would make, and keeping the two in one
 * record makes every number downstream wrong rather than merely old: the scoreboard averages them
 * together, the wallet grades learn from them, and an operator reads a track record belonging to a
 * machine that no longer exists. The 16 calls this constant retires were all one wallet allocating
 * itself ~$2,600 of a launchpad seed — the exact pattern the current rules reject on two separate
 * grounds — so leaving them in would have shown the sniper's record as 16 flat calls it would now
 * never make.
 *
 * Records that fired earlier are DROPPED, not hidden. A filtered-but-present record still gets
 * resampled every tick and still spends price RPC on a coin nobody is deciding anything about.
 *
 * ## History
 *
 * - **2026-08-08T10:10:00Z** — the Allocation lane regained the $25k market-cap FLOOR that the v2
 *   rebuild dropped (`56cba6b`), and wallet grading gained seeded priors plus retuned cutoffs
 *   (`5d4fa4e`, live on the feed at 10:11:19Z). [verified] In the 12h after, the floor alone
 *   rejected 155 allocations at a median cap of $2,628, of which exactly 1 would have been a win;
 *   the wallet behind 15 of the 16 retired calls went `U` → `F` and its mean score fell 39.5 → 24.9.
 *
 * - **2026-08-09T02:30:00Z** — the buy lanes were rewritten (`ee309c8`, feed live at 02:29:33Z).
 *   `earliest-entry` and `proven-wallets` are gone; `solo-buy` and `fresh-entry` replace them; the
 *   wallet-grade conditions, the crowd-GPA condition and every buy-lane score floor were removed.
 *   This is the clearest bump this file will ever get: the OLD rules produced 0 calls in 12.5 hours
 *   over 451 events, and replaying the two the reference engine caught in that window shows both
 *   matching under the new ones. A record of "nothing fired" is not evidence about rules that would
 *   have fired — it is evidence about rules that no longer exist.
 *
 *   COST, stated plainly: this also discards ~518 allocation records, which are the live basis for
 *   wallet grades. Affordable now precisely BECAUSE grades no longer gate anything — they are a
 *   win-rate label, so a reset costs a label and not a decision, and it rebuilds on its own. The
 *   seeded `PRIOR_OUTCOMES` are a static file and survive untouched. The Allocation lane itself did
 *   not change, so its retired records were still true; they are dropped only because the epoch is
 *   one global line and a mixed record is harder to reason about than a short one.
 *
 * BUMP THIS when a lane condition, a score dial or a grade cutoff changes such that a different set
 * of signals would have fired. Do NOT bump it for a fix that only changes COVERAGE — restoring a
 * broken price feed makes the old record incomplete, not false, and discarding history is the
 * expensive half of this trade. When in doubt, leave it: a wrong number is worse than a stale one,
 * but a thrown-away week of outcomes cannot be recovered.
 */
export const V2_RULES_EPOCH_MS = 1_786_242_600_000; // 2026-08-09T02:30:00Z
