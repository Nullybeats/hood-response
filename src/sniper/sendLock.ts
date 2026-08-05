/**
 * Per-wallet send serialization.
 *
 * ethers resolves a nonce with `getTransactionCount('pending')` at send time. Two sends issued
 * concurrently from the same wallet therefore read the SAME nonce, and the second one either
 * replaces the first or is rejected as underpriced — silently losing a buy or, far worse, an exit.
 *
 * Nothing protected against this before: the only guards were a per-token `buying` set (which does
 * nothing for two different tokens) and the `sampling` flag. It was survivable while the feed was
 * the only entry source and buys were rare. Adding the Pons launchpad strategy — a second,
 * independent trigger firing off its own clock — makes concurrent sends the normal case rather than
 * the exception, so it has to be fixed for both.
 *
 * The lock is held only across SEND, not across `tx.wait()`. The nonce is consumed at send, so that
 * is the whole critical section, and holding it longer would make an exit queue behind an entry.
 *
 * Scoped per executor instance, which is exactly the nonce domain: the registry gives every owner
 * its own engine, executor and wallet.
 *
 * Pure and dependency-free, per the convention in txOverrides.ts / walletShare.ts.
 */
/**
 * Backstop: release the queue if a send neither resolves nor rejects within this long.
 *
 * A stalled RPC must never be able to wedge the lock permanently, because the thing queued behind it
 * could be an EXIT. Releasing early risks the nonce collision this class exists to prevent, but a
 * blocked exit on a collapsing token is the strictly worse failure — and at 60s the send has already
 * missed its moment either way.
 */
const SEND_TIMEOUT_MS = 60_000;

export class SendLock {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` with exclusive access, in call order.
   *
   * A rejection is contained so one failed send cannot poison the queue for every later caller —
   * the tail always settles. The caller still sees the real result; only the queue is released early
   * on timeout.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = new Promise<void>((release) => {
      const timer = setTimeout(release, SEND_TIMEOUT_MS);
      // `unref` so a pending backstop can never hold the process open on shutdown.
      timer.unref?.();
      void result.then(
        () => { clearTimeout(timer); release(); },
        () => { clearTimeout(timer); release(); },
      );
    });
    return result;
  }
}
