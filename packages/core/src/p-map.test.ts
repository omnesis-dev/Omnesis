// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { pMap } from "./p-map.js";

/**
 * A manually-controllable deferred — lets a test resolve/reject worker
 * promises in an arbitrary order without touching the wall clock, so the
 * concurrency/ordering/abort invariants are asserted deterministically.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield to the microtask queue so already-resolved promises propagate. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("pMap", () => {
  it("returns results in INPUT order even when workers finish out of order", async () => {
    const items = [0, 1, 2, 3] as const;
    const deferreds = items.map(() => deferred<string>());

    const promise = pMap(items, (item) => deferreds[item].promise, { concurrency: 4 });

    // Resolve in reverse completion order: 3, then 1, then 0, then 2.
    deferreds[3].resolve("d-3");
    deferreds[1].resolve("d-1");
    deferreds[0].resolve("d-0");
    deferreds[2].resolve("d-2");

    const results = await promise;
    // Despite the scrambled completion order, results follow input index order.
    expect(results).toEqual(["d-0", "d-1", "d-2", "d-3"]);
  });

  it("never runs more than `concurrency` workers in flight at once", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const deferreds = items.map(() => deferred<number>());

    let inFlight = 0;
    let maxInFlight = 0;

    const promise = pMap(
      items,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const value = await deferreds[item].promise;
        inFlight -= 1;
        return value;
      },
      { concurrency: 3 },
    );

    // With 10 items and concurrency 3, exactly 3 should be in flight before
    // any settle. Settle them one at a time and confirm the cap never breaks.
    await flush();
    expect(inFlight).toBe(3);

    for (const item of items) {
      deferreds[item].resolve(item * 10);
      await flush();
      expect(inFlight).toBeLessThanOrEqual(3);
    }

    const results = await promise;
    expect(results).toEqual(items.map((i) => i * 10));
    expect(maxInFlight).toBe(3);
  });

  it("aborts on the first rejection and stops starting new items", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 6 }, (_, i) => i);

    // concurrency 1 forces strictly-sequential starts, so we can prove that
    // items after the failing one are never even started.
    await expect(
      pMap(
        items,
        async (item) => {
          started.push(item);
          if (item === 2) throw new Error("boom at 2");
          return item;
        },
        { concurrency: 1 },
      ),
    ).rejects.toThrow("boom at 2");

    // Items 0, 1, 2 ran; 2 threw; the abort gate prevents 3, 4, 5 from starting.
    expect(started).toEqual([0, 1, 2]);
  });

  it("rethrows the first rejection's error", async () => {
    const sentinel = new Error("sentinel-failure");
    await expect(
      pMap(
        [1, 2, 3],
        async () => {
          throw sentinel;
        },
        { concurrency: 2 },
      ),
    ).rejects.toBe(sentinel);
  });

  it("clamps concurrency <= 0 to a single lane (still completes)", async () => {
    const items = [10, 20, 30];
    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds = items.map(() => deferred<number>());

    const promise = pMap(
      items,
      async (item, i) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const v = await deferreds[i].promise;
        inFlight -= 1;
        return v;
      },
      { concurrency: 0 },
    );

    await flush();
    // concurrency 0 is clamped to 1: only one worker in flight.
    expect(inFlight).toBe(1);

    for (let i = 0; i < items.length; i++) {
      deferreds[i].resolve(items[i]);
      await flush();
    }

    expect(await promise).toEqual(items);
    expect(maxInFlight).toBe(1);
  });

  it("returns an empty array for empty input without invoking fn", async () => {
    let calls = 0;
    const result = await pMap(
      [] as number[],
      async (x) => {
        calls += 1;
        return x;
      },
      { concurrency: 4 },
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("passes the input index to fn", async () => {
    const seen: Array<[string, number]> = [];
    await pMap(
      ["a", "b", "c"],
      async (item, index) => {
        seen.push([item, index]);
        return index;
      },
      { concurrency: 1 },
    );
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});
