// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Keep an asynchronous search on one model/index pair across a publication. */
export class SearchGenerationGate {
  private transition = Promise.resolve();
  private readers = new Set<Promise<void>>();

  async read<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      const transition = this.transition;
      await transition;
      // A publisher may have queued while this reader was awaiting its turn.
      if (transition !== this.transition) continue;
      const done = Promise.withResolvers<void>();
      this.readers.add(done.promise);
      try {
        return await operation();
      } finally {
        this.readers.delete(done.promise);
        done.resolve();
      }
    }
  }

  async publish<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.transition;
    const done = Promise.withResolvers<void>();
    this.transition = previous.then(() => done.promise);
    try {
      await previous;
      // New searches now wait at the barrier; existing searches drain without
      // holding a writer transaction or interrupting native query inference.
      await Promise.all(this.readers);
      return await operation();
    } finally {
      done.resolve();
    }
  }
}
