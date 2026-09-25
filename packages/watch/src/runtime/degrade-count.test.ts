// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Counting the day's degraded deliveries, and leaving some of them out.
 *
 * A degrade is a firing that reached the operator as less than its channel can
 * send. Which of those are worth counting is a question about how the *host*
 * is wired — on an install with no agent integration at all, "no agent opened
 * a conversation" describes the install rather than a fault — so the runtime
 * takes the exclusion list rather than inventing a policy it cannot check.
 *
 * The rows are never filtered, only the count: the per-firing answer to "why
 * was this one plain" has to stay true whatever the report chooses to total.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { WatchStateStore } from "./state.js";

const START = "2026-05-13T23:00:00.000Z";
const END = "2026-05-14T23:00:00.000Z";

function withDeliveries(
  deliveries: readonly { at: string; degraded: string | null }[],
): WatchStateStore {
  const store = new WatchStateStore();
  deliveries.forEach(({ at, degraded }, index) => {
    store.recordDeliveryOutcome({
      watchId: "w-1",
      seq: index + 1,
      nodeId: "sink",
      keyHash: "singleton",
      kind: "omnesis-notify",
      attempted: 1,
      delivered: 1,
      error: null,
      degraded,
      at,
    });
  });
  return store;
}

describe("degradedBetween", () => {
  it("counts a local day's UTC instant range with half-open boundaries", () => {
    const store = withDeliveries([
      { at: "2026-05-13T22:59:59.999Z", degraded: "before" },
      { at: START, degraded: "at-start" },
      { at: "2026-05-14T09:00:00.000Z", degraded: null },
      { at: "2026-05-14T22:59:59.999Z", degraded: "before-end" },
      { at: END, degraded: "at-end" },
    ]);

    expect(store.degradedBetween(START, END)).toBe(2);
  });

  it("leaves out the classes the host says are not degrades here", () => {
    const store = withDeliveries([
      { at: START, degraded: "no-opener" },
      { at: "2026-05-14T09:01:00.000Z", degraded: "no-agent" },
      { at: "2026-05-14T09:02:00.000Z", degraded: "open-failed" },
    ]);

    expect(store.degradedBetween(START, END, ["no-opener", "no-agent"])).toBe(1);
  });

  it("keeps every row it left out of the count", () => {
    // The exclusion is a reporting decision, not a retraction. An operator
    // looking at one firing still learns why that banner was the plain one.
    const store = withDeliveries([
      { at: START, degraded: "no-opener" },
      { at: "2026-05-14T09:01:00.000Z", degraded: "open-failed" },
    ]);

    expect(store.degradedBetween(START, END, ["no-opener"])).toBe(1);
    expect(store.deliveries("w-1").map((d) => d.degraded)).toEqual(["no-opener", "open-failed"]);
  });
});

describe("delivery retry outcomes", () => {
  it("preserves an early retry result for only the matching full firing identity", () => {
    const store = new WatchStateStore();
    store.recordDeliveryRetryOutcome({
      watchId: "w-retry",
      seq: 7,
      nodeId: "notify-b",
      keyHash: "key-b",
      attempted: 3,
      delivered: 1,
      error: null,
      at: START,
    });
    for (const [nodeId, keyHash] of [
      ["notify-a", "key-a"],
      ["notify-b", "key-b"],
    ] as const) {
      store.recordDeliveryOutcome({
        watchId: "w-retry",
        seq: 7,
        nodeId,
        keyHash,
        kind: "omnesis-notify",
        attempted: 1,
        delivered: 0,
        error: "initial wake failed",
        degraded: null,
        at: START,
      });
    }
    expect(store.deliveries("w-retry")).toMatchObject([
      { nodeId: "notify-b", attempted: 3, delivered: 1, error: null },
      { nodeId: "notify-a", attempted: 1, delivered: 0, error: "initial wake failed" },
    ]);
  });
});
