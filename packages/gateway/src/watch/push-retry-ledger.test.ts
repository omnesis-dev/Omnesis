// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { watchV2FiringKey } from "../subscriptions/watch-v2-plan.js";
import { overlayWatchPushRetries, type WatchDeliveryLedgerEntry } from "./push-retry-ledger.js";

function delivery(nodeId: string, keyHash: string): WatchDeliveryLedgerEntry {
  return {
    seq: 7,
    nodeId,
    keyHash,
    kind: "omnesis-notify",
    attempted: 1,
    delivered: 0,
    error: "initial wake failed",
    degraded: null,
    at: "2026-01-02T03:04:05.000Z",
  };
}

describe("overlayWatchPushRetries", () => {
  test("updates only the full firing identity when two firings share a sequence", () => {
    const watchId = "watch-fictional";
    const first = delivery("notify-a", "key-a");
    const second = delivery("notify-b", "key-b");
    const firingId = watchV2FiringKey({
      watchId,
      seq: second.seq,
      nodeId: second.nodeId,
      keyHash: second.keyHash,
    });

    const result = overlayWatchPushRetries(
      watchId,
      [first, second],
      new Map([
        [
          firingId,
          {
            watchId,
            firingKey: `${watchId}:7`,
            firingId,
            attempted: 3,
            delivered: 1,
            outstanding: 0,
            failed: 0,
          },
        ],
      ]),
    );

    expect(result[0]).toEqual(first);
    expect(result[1]).toMatchObject({ attempted: 3, delivered: 1, error: null });
  });

  test("renders durable crash exhaustion even without an explicit settlement callback", () => {
    const watchId = "watch-fictional";
    const row = delivery("notify", "key");
    const firingId = watchV2FiringKey({
      watchId,
      seq: row.seq,
      nodeId: row.nodeId,
      keyHash: row.keyHash,
    });
    expect(
      overlayWatchPushRetries(
        watchId,
        [row],
        new Map([
          [
            firingId,
            {
              watchId,
              firingKey: `${watchId}:7`,
              firingId,
              attempted: 6,
              delivered: 0,
              outstanding: 0,
              failed: 1,
            },
          ],
        ]),
      )[0],
    ).toMatchObject({
      attempted: 6,
      delivered: 0,
      error: "notification wake failed for 1 device(s)",
    });
  });
});
