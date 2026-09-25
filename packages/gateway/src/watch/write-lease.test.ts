// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Taking turns to write one file.
 *
 * The lease exists because of how the loser of a write race waits rather than
 * because of the race itself. SQLite serialises two writers regardless, but a
 * synchronous driver blocks its thread inside the busy handler — and both
 * writers of the journal run on the gateway's main one, so the wait would stop
 * every in-flight request with it.
 */

import { describe, expect, it } from "vitest";

import { WriteLease } from "./write-lease.js";

/** A promise with its resolver, so a test can hold a section open. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("the lease", () => {
  it("runs one section at a time", async () => {
    const lease = new WriteLease();
    const first = held();
    const order: string[] = [];

    const a = lease.run(async () => {
      order.push("a in");
      await first.promise;
      order.push("a out");
    });
    const b = lease.run(() => {
      order.push("b in");
      return Promise.resolve();
    });

    // `b` must not have started: `a` is still holding.
    await Promise.resolve();
    expect(order, "a second writer started while the first was open").toEqual(["a in"]);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a in", "a out", "b in"]);
  });

  it("keeps its order, so a busy writer cannot starve the other", async () => {
    const lease = new WriteLease();
    const gate = held();
    const order: number[] = [];

    const running = [
      lease.run(async () => {
        await gate.promise;
        order.push(0);
      }),
      lease.run(() => {
        order.push(1);
        return Promise.resolve();
      }),
      lease.run(() => {
        order.push(2);
        return Promise.resolve();
      }),
    ];

    gate.release();
    await Promise.all(running);
    expect(order).toEqual([0, 1, 2]);
  });

  it("hands the turn on when a section throws", async () => {
    // A drain that failed has still finished. A lease a failure could wedge
    // would take the whole subsystem down on the first bad tick.
    const lease = new WriteLease();
    await expect(lease.run(() => Promise.reject(new Error("drain failed")))).rejects.toThrow(
      "drain failed",
    );

    await expect(lease.run(() => Promise.resolve("after"))).resolves.toBe("after");
  });

  it("does not report an earlier failure to a later caller", async () => {
    // The queue is a chain of promises, and chaining onto a rejected one would
    // deliver the first writer's error to the second — which would then log an
    // outage it had nothing to do with.
    const lease = new WriteLease();
    const failing = lease.run(() => Promise.reject(new Error("drain failed")));
    const following = lease.run(() => Promise.resolve("fine"));

    await expect(failing).rejects.toThrow("drain failed");
    await expect(following).resolves.toBe("fine");
  });
});
