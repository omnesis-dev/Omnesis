// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Bootstrap work that must settle after cancellation before process exit.
 * In particular, a storage worker must reap its validator and close its stores. */
export class StartupOperations {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  async drain(): Promise<void> {
    // An in-flight runtime initialization can register a worker while an
    // earlier async operation settles. Keep draining until all tracked work
    // has actually unwound, rather than treating abort delivery as cleanup.
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
