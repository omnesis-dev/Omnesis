// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  handoffQueuedMessages,
  newQueueHandoffIds,
  visibleQueueControls,
  // @ts-expect-error — portal modules are plain JS without sibling declarations.
} from "./queue-handoff.js";

const queued = (id: string) => ({ id, text: "Same follow-up", status: "queued" });

describe("queued message handoff", () => {
  it("masks exact receipts across stale snapshots, preserves new identical text and failed receipts", () => {
    const original = { queuedMessages: [queued("first"), queued("second")] };
    const hidden = new Set(["first", "second"]);
    expect(visibleQueueControls(original, hidden).queuedMessages).toEqual([]);
    expect(original.queuedMessages).toHaveLength(2);
    const stale = { queuedMessages: [...original.queuedMessages, queued("new")] };
    expect(visibleQueueControls(stale, hidden).queuedMessages).toEqual([queued("new")]);
    const failed = { ...queued("first"), status: "failed", error: "Try again" };
    expect(visibleQueueControls({ queuedMessages: [failed] }, hidden).queuedMessages).toEqual([failed]);
    expect(visibleQueueControls(original, new Set())).toBe(original);
  });

  it("hides synchronously before the request and never restores on a successful queued response", async () => {
    const order: string[] = [];
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const restore = vi.fn();
    const task = handoffQueuedMessages({
      hide: () => order.push("hide"),
      send: () => { order.push("send"); return pending; },
      restore,
      isCurrent: () => true,
      refresh: () => order.push("refresh"),
      onError: vi.fn(),
    });
    expect(order).toEqual(["hide", "send"]);
    finish();
    await task;
    expect(order).toEqual(["hide", "send", "refresh"]);
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects a duplicate handoff and gives an overlapping failure ownership of only new receipts", async () => {
    const hidden = new Set<string>();
    const first = newQueueHandoffIds(hidden, ["first"]);
    first.forEach((id: string) => hidden.add(id));
    expect(newQueueHandoffIds(hidden, ["first"])).toEqual([]);
    const second = newQueueHandoffIds(hidden, ["first", "second"]);
    await handoffQueuedMessages({
      hide: () => second.forEach((id: string) => hidden.add(id)),
      send: () => Promise.reject(new Error("second attempt failed")),
      restore: () => second.forEach((id: string) => hidden.delete(id)),
      isCurrent: () => true, refresh: vi.fn(), onError: vi.fn(),
    });
    expect([...hidden]).toEqual(["first"]);
  });

  it("restores only this failed attempt while preserving another handoff", async () => {
    const hidden = new Set(["earlier"]);
    const error = new Error("network unavailable");
    const refresh = vi.fn();
    const onError = vi.fn();
    await handoffQueuedMessages({
      hide: () => hidden.add("this-attempt"),
      send: () => Promise.reject(error),
      restore: () => hidden.delete("this-attempt"),
      isCurrent: () => true,
      refresh,
      onError,
    });
    expect([...hidden]).toEqual(["earlier"]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("restores the originating session after navigation without refreshing or showing errors in another", async () => {
    const restore = vi.fn();
    const refresh = vi.fn();
    const onError = vi.fn();
    await handoffQueuedMessages({
      hide: vi.fn(), send: () => Promise.reject(new Error("offline")), restore,
      isCurrent: () => false, refresh, onError,
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
