// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whose turn it is to write the journal.
 *
 * Two scheduler tasks write that file: the materializer's drain and the
 * engine's evaluation tick. They hold separate connections on purpose — a
 * shared one would let each open a transaction inside the other's — and SQLite
 * in WAL mode serialises the two writers for us, so on paper a busy timeout is
 * all that is needed.
 *
 * What that reasoning misses is *how* the loser waits. `better-sqlite3` is
 * synchronous, so a connection that finds the write lock taken does not yield:
 * it blocks the thread inside the busy handler until the lock frees or the
 * timeout expires. Both tasks run on the gateway's main runner, which allows
 * them to overlap, so the whole event loop — every in-flight HTTP request
 * included — stops for as long as the other side holds its transaction.
 *
 * This lease is what turns that block into an await. A task takes it before
 * opening a transaction and releases it after committing, so the two never
 * reach SQLite's busy handler at all and the one that arrives second yields
 * instead of stalling the process. It is not a substitute for the busy timeout,
 * which still guards against anything outside this pair; it is what keeps our
 * own two writers from paying for it.
 *
 * FIFO, because a queue that reordered would let a busy drain starve the
 * evaluation it feeds.
 */

/** Runs one section at a time, in the order the sections arrived. */
export class WriteLease {
  /** Resolves when everything queued ahead has finished. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `work` with the lease held.
   *
   * The chain is advanced whether `work` resolves or rejects — a section that
   * threw has still finished, and a lease that a failure could wedge would take
   * the subsystem down on the first bad drain.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const ahead = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Awaited rather than chained onto, so an earlier rejection cannot
    // propagate into this caller — `tail` is only ever resolved by `release`.
    await ahead;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
