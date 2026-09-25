// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { SourceWriteEpochFence, epochScope } from "./source-write-epoch-fence.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return !settled;
}

describe("SourceWriteEpochFence.runAll", () => {
  const scopes = {
    shared: epochScope("source:local"),
    a: epochScope("source:local", "device-a"),
    b: epochScope("source:local", "device-b"),
  };

  test("waits for the in-flight operation on any of its scopes, and holds every scope until it is done", async () => {
    const fence = new SourceWriteEpochFence();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const inFlight = fence.run(scopes.b, () => held);

    const purge = fence.runAll([scopes.shared, scopes.a, scopes.b], async () => {
      order.push("purge");
      return "purged";
    });
    const after = fence.run(scopes.shared, async () => {
      order.push("shared-after");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);

    release();
    await inFlight;
    await expect(purge).resolves.toBe("purged");
    await after;
    expect(order).toEqual(["purge", "shared-after"]);
  });

  test("two callers over the same scopes in different orders both finish", async () => {
    const fence = new SourceWriteEpochFence();
    const first = fence.runAll([scopes.a, scopes.b], async () => "first");
    const second = fence.runAll([scopes.b, scopes.a], async () => "second");
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    // The scopes are released: a later operation on any of them runs at once.
    await expect(fence.run(scopes.b, async () => "later")).resolves.toBe("later");
  });
});

describe("SourceWriteEpochFence attempt cancellation", () => {
  test("a cancel arriving before begin prevents the late claim", async () => {
    const fence = new SourceWriteEpochFence();
    const claim = vi.fn(async () => 1);
    const revoke = vi.fn(async () => true);

    await expect(fence.cancelAttempt("source:local", "attempt-a", undefined, revoke)).resolves.toBe(
      false,
    );
    await expect(fence.beginAttempt("source:local", "attempt-a", claim)).resolves.toBeUndefined();

    expect(claim).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  test("a cancel after begin revokes the epoch claimed by that attempt", async () => {
    const fence = new SourceWriteEpochFence();
    const revoke = vi.fn(async (epoch: number) => epoch === 7);

    await expect(fence.beginAttempt("source:local", "attempt-b", async () => 7)).resolves.toBe(7);
    await expect(fence.cancelAttempt("source:local", "attempt-b", undefined, revoke)).resolves.toBe(
      true,
    );

    expect(revoke).toHaveBeenCalledWith(7);
  });

  test("a cancel after a gateway restart still revokes the epoch the caller holds", async () => {
    // Attempt bookkeeping is in-memory. A gateway restart between the claim
    // and the collector's sync timeout leaves the collector holding the only
    // record of the epoch; dropping it would leave the abandoned attempt
    // still authorized to commit its in-flight page.
    const fence = new SourceWriteEpochFence();
    const revoke = vi.fn(async (epoch: number) => epoch === 11);

    await expect(fence.cancelAttempt("source:local", "attempt-restart", 11, revoke)).resolves.toBe(
      true,
    );
    expect(revoke).toHaveBeenCalledWith(11);
  });

  test("a cancel after the attempt record ages out still revokes the epoch the caller holds", async () => {
    // The attempt TTL and the collector's sync timeout are the same hour, so
    // the revocation for a timed-out sync can arrive just after its record
    // has been pruned.
    const fence = new SourceWriteEpochFence();
    const revoke = vi.fn(async (epoch: number) => epoch === 4);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      await expect(fence.beginAttempt("source:local", "attempt-ttl", async () => 4)).resolves.toBe(
        4,
      );
      clock.mockReturnValue(start + 2 * 60 * 60 * 1000);
      await expect(fence.cancelAttempt("source:local", "attempt-ttl", 4, revoke)).resolves.toBe(
        true,
      );
    } finally {
      clock.mockRestore();
    }
    expect(revoke).toHaveBeenCalledWith(4);
  });

  test("a cancel with an epoch but no record still pre-cancels the late claim", async () => {
    const fence = new SourceWriteEpochFence();
    const revoke = vi.fn(async () => true);
    const claim = vi.fn(async () => 2);

    await expect(fence.cancelAttempt("source:local", "attempt-d", 5, revoke)).resolves.toBe(true);
    await expect(fence.beginAttempt("source:local", "attempt-d", claim)).resolves.toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  });

  test("attempts on different cursor rows of one source are independent", async () => {
    const fence = new SourceWriteEpochFence();
    const shared = epochScope("source:local");
    const member = epochScope("source:local", "device-a");
    const revoke = vi.fn(async () => true);

    // A cancel on the shared row does not pre-cancel the same attempt id on a member's row.
    await expect(fence.cancelAttempt(shared, "attempt-c", undefined, revoke)).resolves.toBe(false);
    await expect(fence.beginAttempt(member, "attempt-c", async () => 3)).resolves.toBe(3);
    await expect(fence.beginAttempt(shared, "attempt-c", async () => 9)).resolves.toBeUndefined();

    // Cancelling the member's attempt revokes the member's epoch only.
    await expect(fence.cancelAttempt(member, "attempt-c", undefined, revoke)).resolves.toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(3);
  });
});

describe("SourceWriteEpochFence wipe barriers", () => {
  test("a source-exclusive wipe drains admitted work and blocks a new cursor row", async () => {
    const fence = new SourceWriteEpochFence();
    const releaseInFlight = deferred();
    const wipeEntered = deferred();
    const releaseWipe = deferred();
    const inFlight = fence.run(epochScope("source:a", "device-a"), () => releaseInFlight.promise);
    const wipe = fence.runSourceExclusive("source:a", async () => {
      wipeEntered.resolve();
      await releaseWipe.promise;
    });

    expect(await isPending(wipeEntered.promise)).toBe(true);
    releaseInFlight.resolve();
    await inFlight;
    await wipeEntered.promise;

    const unseenCursor = fence.run(epochScope("source:a", "device-new"), async () => "after");
    expect(await isPending(unseenCursor)).toBe(true);
    releaseWipe.resolve();
    await wipe;
    await expect(unseenCursor).resolves.toBe("after");
  });

  test("a source-exclusive wipe does not block another source", async () => {
    const fence = new SourceWriteEpochFence();
    const wipeEntered = deferred();
    const releaseWipe = deferred();
    const wipe = fence.runSourceExclusive("source:a", async () => {
      wipeEntered.resolve();
      await releaseWipe.promise;
    });
    await wipeEntered.promise;

    await expect(fence.run(epochScope("source:b"), async () => "independent")).resolves.toBe(
      "independent",
    );
    releaseWipe.resolve();
    await wipe;
  });

  test("a global wipe blocks work for a source first seen after the wipe starts", async () => {
    const fence = new SourceWriteEpochFence();
    const wipeEntered = deferred();
    const releaseWipe = deferred();
    const wipe = fence.runGlobalExclusive(async () => {
      wipeEntered.resolve();
      await releaseWipe.promise;
    });
    await wipeEntered.promise;

    const newcomer = fence.run(epochScope("source:new"), async () => "after");
    expect(await isPending(newcomer)).toBe(true);
    releaseWipe.resolve();
    await wipe;
    await expect(newcomer).resolves.toBe("after");
  });

  test("a queued exclusive wipe cannot be starved by later shared work", async () => {
    const fence = new SourceWriteEpochFence();
    const releaseFirst = deferred();
    const order: string[] = [];
    const first = fence.run(epochScope("source:a", "device-a"), () => releaseFirst.promise);
    const wipe = fence.runSourceExclusive("source:a", async () => {
      order.push("wipe");
    });
    const later = fence.run(epochScope("source:a", "device-b"), async () => {
      order.push("later");
    });

    releaseFirst.resolve();
    await Promise.all([first, wipe, later]);
    expect(order).toEqual(["wipe", "later"]);
  });

  test("an exclusive operation that throws releases the barrier", async () => {
    const fence = new SourceWriteEpochFence();
    await expect(
      fence.runSourceExclusive("source:a", async () => {
        throw new Error("cleanup failed");
      }),
    ).rejects.toThrow("cleanup failed");
    await expect(fence.run(epochScope("source:a"), async () => "released")).resolves.toBe(
      "released",
    );
  });
});
