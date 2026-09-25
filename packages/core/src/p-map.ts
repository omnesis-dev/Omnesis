// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bounded-concurrency `Promise.all`: run `fn(item, i)` for every item with at
 * most `concurrency` calls in flight at once. Results are returned in input
 * order. Throws on the first rejection (in-flight workers settle but
 * subsequent items are not started).
 */
export async function pMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: { concurrency: number },
): Promise<R[]> {
  const concurrency = Math.max(1, opts.concurrency);
  const results = new Array<R>(items.length);
  let next = 0;
  let aborted: unknown = null;

  async function worker(): Promise<void> {
    while (aborted === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        aborted = err;
        throw err;
      }
    }
  }

  const lanes = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}
