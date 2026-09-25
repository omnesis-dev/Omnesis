// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  PersistentQueue,
  QUEUE_CORRUPTION_KEY,
  QUEUE_OVERFLOW_KEY,
  QUEUE_STORAGE_KEY,
} from "./queue.js";
import { MemoryStore } from "./test-fakes.js";
import type { QueueItem } from "./index.js";

function visitItem(id: string): QueueItem {
  return {
    kind: "visit",
    id,
    visit: {
      url: `https://example.com/${id}`,
      domain: "example.com",
      title: null,
      visited_at: "2026-01-01T00:00:00.000Z",
      dwell_ms: 6000,
    },
    attempts: 0,
    notBefore: 0,
    enqueuedAt: 0,
  };
}

describe("PersistentQueue", () => {
  it("persists across a simulated restart (new instance, same store)", async () => {
    const store = new MemoryStore();
    const q1 = new PersistentQueue(store);
    await q1.enqueue(visitItem("a"));
    await q1.enqueue(visitItem("b"));
    expect(await q1.size()).toBe(2);

    // Simulate SW eviction / browser restart: a brand-new queue object backed
    // by the same durable store must see the same items.
    const q2 = new PersistentQueue(store);
    await q2.load();
    expect(await q2.size()).toBe(2);
    expect((await q2.list()).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("de-duplicates on item id", async () => {
    const store = new MemoryStore();
    const q = new PersistentQueue(store);
    await q.enqueue(visitItem("dup"));
    await q.enqueue(visitItem("dup"));
    expect(await q.size()).toBe(1);
  });

  it("replaceAll commits the post-drain state in one write", async () => {
    const store = new MemoryStore();
    const q = new PersistentQueue(store);
    await q.enqueue(visitItem("a"));
    await q.enqueue(visitItem("b"));
    await q.replaceAll([visitItem("b")]);
    expect((await q.list()).map((i) => i.id)).toEqual(["b"]);
    // Verify it actually hit the store under the versioned key.
    expect(store.snapshot().has(QUEUE_STORAGE_KEY)).toBe(true);
  });

  it("an empty store yields an empty queue", async () => {
    const q = new PersistentQueue(new MemoryStore());
    expect(await q.size()).toBe(0);
    expect(await q.list()).toEqual([]);
  });

  it("sanitizes a damaged snapshot and records the data-loss diagnostic", async () => {
    const store = new MemoryStore();
    await store.set(QUEUE_STORAGE_KEY, JSON.stringify([visitItem("valid"), { bad: true }]));
    const q = new PersistentQueue(store);
    expect((await q.list()).map((item) => item.id)).toEqual(["valid"]);
    expect(JSON.parse((await store.get(QUEUE_CORRUPTION_KEY)) ?? "null")).toMatchObject({
      discarded: 1,
    });
    expect(JSON.parse((await store.get(QUEUE_STORAGE_KEY)) ?? "null")).toHaveLength(1);
  });

  it("recovers from unreadable JSON instead of wedging all future capture", async () => {
    const store = new MemoryStore();
    await store.set(QUEUE_STORAGE_KEY, "not-json");
    const q = new PersistentQueue(store);
    expect(await q.list()).toEqual([]);
    expect(JSON.parse((await store.get(QUEUE_CORRUPTION_KEY)) ?? "null")).toMatchObject({
      discarded: null,
    });
  });

  it("does not rewrite or repair the queue during a read-only size inspection", async () => {
    const store = new MemoryStore();
    await store.set(QUEUE_STORAGE_KEY, "not-json");
    const q = new PersistentQueue(store);
    expect(await q.size()).toBe(0);
    expect(await store.get(QUEUE_STORAGE_KEY)).toBe("not-json");
    expect(await store.get(QUEUE_CORRUPTION_KEY)).toBeUndefined();
  });

  it("replaces an obsolete queued snapshot without disturbing distinct visits", async () => {
    const q = new PersistentQueue(new MemoryStore());
    await q.enqueue(visitItem("visit"));
    await q.enqueueReplacing(visitItem("new"), (item) => item.id === "old");
    await q.enqueueReplacing(visitItem("newer"), (item) => item.id === "new");
    expect((await q.list()).map((item) => item.id)).toEqual(["visit", "newer"]);
  });

  it("bounds an outage backlog, evicts visits first, and records visible loss", async () => {
    const store = new MemoryStore();
    const q = new PersistentQueue(store, QUEUE_STORAGE_KEY, {
      maxItems: 2,
      maxBytes: 100_000,
    });
    const document = {
      ...visitItem("document"),
      kind: "document" as const,
      doc: { source: "web", externalId: "doc", title: "Example", content: "body" },
    };
    delete (document as unknown as { visit?: unknown }).visit;
    await q.enqueue(document as unknown as QueueItem);
    await q.enqueue(visitItem("visit-a"));
    await q.enqueue(visitItem("visit-b"));
    expect((await q.list()).map((item) => item.id)).toEqual(["document", "visit-b"]);
    expect(JSON.parse((await store.get(QUEUE_OVERFLOW_KEY)) ?? "null")).toMatchObject({
      discardedDocuments: 0,
      discardedVisits: 1,
    });
  });

  it("ignores a malformed previous overflow counter instead of corrupting totals", async () => {
    const store = new MemoryStore();
    await store.set(QUEUE_OVERFLOW_KEY, JSON.stringify({ discardedVisits: "many" }));
    const q = new PersistentQueue(store, QUEUE_STORAGE_KEY, { maxItems: 1, maxBytes: 100_000 });
    await q.enqueue(visitItem("first"));
    await q.enqueue(visitItem("second"));
    expect(JSON.parse((await store.get(QUEUE_OVERFLOW_KEY)) ?? "null")).toMatchObject({
      discardedVisits: 1,
    });
  });
});
