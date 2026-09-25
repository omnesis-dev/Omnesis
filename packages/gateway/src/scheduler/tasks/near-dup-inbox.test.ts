// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the near-dup inbox buffer + flush task. The
 * buffer is pure in-memory state; the flush task is driven by calling
 * `run()` / `flushNow()` directly with a mocked writeGate, so these
 * don't need a scheduled scheduler — the periodic wiring is covered by
 * `scheduler.test.ts`.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { Scheduler } from "../scheduler.js";
import { runSchemaSetup } from "../../data/schema.js";
import { runMigrations } from "../../data/migrations.js";
import { directWriteGate } from "../../write-gate.js";
import { EventBus, type DocumentProjection } from "../../events.js";
import { subscribeNearDupInbox } from "../../near-dupes/event-handler.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "../../near-dupes/config.js";
import { countNearDupInbox } from "../../near-dupes/inbox.js";
import {
  createNearDupInboxBuffer,
  nearDupInboxFlushTask,
  type NearDupInboxFlushBundle,
} from "./near-dup-inbox.js";
import type { Db } from "../../data/types.js";
import type { TaskContext } from "../types.js";

const log = createLogger("test:near-dup-inbox");

/** Minimal ctx — the flush task ignores it (no cooperative yielding). */
function ctx(): TaskContext {
  return {
    shouldYield: () => false,
    elapsedMs: () => 0,
    signal: new AbortController().signal,
    log,
  };
}

describe("createNearDupInboxBuffer", () => {
  test("add → drain returns ids grouped by reason, then clears", () => {
    const b = createNearDupInboxBuffer();
    b.add("a", "insert");
    b.add("b", "insert");
    b.add("c", "update");
    expect(b.size()).toBe(3);

    const drained = b.drain();
    const byReason = Object.fromEntries(drained.map((d) => [d.reason, d.docIds.slice().sort()]));
    expect(byReason.insert).toEqual(["a", "b"]);
    expect(byReason.update).toEqual(["c"]);

    // Cleared after drain.
    expect(b.size()).toBe(0);
    expect(b.drain()).toEqual([]);
  });

  test("dedups the same (docId, reason) pair", () => {
    const b = createNearDupInboxBuffer();
    b.add("a", "insert");
    b.add("a", "insert");
    b.add("a", "insert");
    expect(b.size()).toBe(1);
    expect(b.drain()).toEqual([{ reason: "insert", docIds: ["a"] }]);
  });

  test("keeps the same doc under distinct reasons (matches the (doc_id, reason) index)", () => {
    const b = createNearDupInboxBuffer();
    b.add("a", "insert");
    b.add("a", "update");
    expect(b.size()).toBe(2);
    const drained = b.drain();
    const byReason = Object.fromEntries(drained.map((d) => [d.reason, d.docIds]));
    expect(byReason.insert).toEqual(["a"]);
    expect(byReason.update).toEqual(["a"]);
  });

  test("drops adds beyond the cap (recovered at next algo bump)", () => {
    const warn = vi.fn();
    const b = createNearDupInboxBuffer({
      cap: 2,
      log: { ...log, warn } as unknown as typeof log,
    });
    b.add("a", "insert");
    b.add("b", "insert");
    b.add("c", "insert"); // dropped — at cap
    b.add("d", "insert"); // dropped — at cap
    expect(b.size()).toBe(2);
    const drained = b.drain();
    expect(drained).toEqual([{ reason: "insert", docIds: ["a", "b"] }]);
    expect(warn).toHaveBeenCalled();
  });

  test("a re-add of an already-buffered id under cap does not over-count", () => {
    const b = createNearDupInboxBuffer({ cap: 2 });
    b.add("a", "insert");
    b.add("a", "insert"); // dedup, still size 1 — must not consume a cap slot
    b.add("b", "insert");
    expect(b.size()).toBe(2);
  });

  test("an at-cap re-add of an already-buffered id is a dedup no-op, not a counted drop", () => {
    const warn = vi.fn();
    const b = createNearDupInboxBuffer({ cap: 1, log: { ...log, warn } as unknown as typeof log });
    b.add("a", "insert"); // fills the cap
    b.add("a", "insert"); // already buffered → no-op, must NOT warn-as-drop
    expect(b.size()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    b.add("b", "insert"); // genuinely new at cap → a real drop
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("drop warns are throttled to one per 10s window and the count accumulates then resets", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const warn = vi.fn();
      const b = createNearDupInboxBuffer({
        cap: 1,
        log: { ...log, warn } as unknown as typeof log,
      });
      b.add("keep", "insert"); // fills cap
      // Burst of drops within the same 10s window → exactly one warn.
      for (let i = 0; i < 5; i++) b.add(`drop-${i}`, "insert");
      expect(warn).toHaveBeenCalledTimes(1);

      // Advance past the window; the next drop warns again with a fresh count.
      vi.setSystemTime(11_000);
      b.add("drop-late", "insert");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("without a logger the dropped counter still resets on the window (no unbounded growth)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const b = createNearDupInboxBuffer({ cap: 1 }); // no logger
      b.add("keep", "insert");
      // Many drops across several windows must not throw or leak — just no-ops.
      for (let w = 0; w < 3; w++) {
        vi.setSystemTime(w * 11_000);
        for (let i = 0; i < 100; i++) b.add(`d-${w}-${i}`, "insert");
      }
      expect(b.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nearDupInboxFlushTask", () => {
  let scheduler: Scheduler;
  let enqueue: ReturnType<typeof vi.fn>;
  let writeGate: { enqueueNearDupInbox: typeof enqueue };

  beforeEach(() => {
    scheduler = new Scheduler({ enablePreemption: false });
    enqueue = vi.fn().mockResolvedValue({ enqueued: 1 });
    writeGate = { enqueueNearDupInbox: enqueue };
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  function build(bufferOpts?: Parameters<typeof createNearDupInboxBuffer>[0], chunkSize?: number) {
    const buffer = createNearDupInboxBuffer(bufferOpts);
    const bundle: NearDupInboxFlushBundle = nearDupInboxFlushTask(
      { buffer, writeGate, log, chunkSize },
      scheduler,
    );
    return { buffer, bundle };
  }

  test("declares background priority and the stable op name", () => {
    const { bundle } = build();
    expect(bundle.task.priority).toBe("background");
    expect(bundle.task.name).toBe("nearDup.inboxFlush");
  });

  test("run() drains the buffer into one enqueue per reason", async () => {
    const { buffer, bundle } = build();
    buffer.add("a", "insert");
    buffer.add("b", "insert");
    buffer.add("c", "update");

    const outcome = await bundle.task.run(undefined, ctx());
    expect(outcome).toEqual({ kind: "done", value: { idle: false } });

    expect(enqueue).toHaveBeenCalledTimes(2);
    const calls = enqueue.mock.calls.map(([ids, reason]) => [reason, [...ids].sort()]);
    expect(calls).toContainEqual(["insert", ["a", "b"]]);
    expect(calls).toContainEqual(["update", ["c"]]);
    // Buffer emptied.
    expect(buffer.size()).toBe(0);
  });

  test("chunks a large reason batch by chunkSize", async () => {
    const { buffer, bundle } = build(undefined, 2);
    for (const id of ["a", "b", "c", "d", "e"]) buffer.add(id, "insert");

    await bundle.task.run(undefined, ctx());

    // 5 ids / chunk 2 → 3 writer ops, each ≤ 2 ids.
    expect(enqueue).toHaveBeenCalledTimes(3);
    for (const [ids] of enqueue.mock.calls) expect(ids.length).toBeLessThanOrEqual(2);
    const all = enqueue.mock.calls.flatMap(([ids]) => ids).sort();
    expect(all).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("run() is idle (no writer op) when the buffer is empty", async () => {
    const { bundle } = build();
    const outcome = await bundle.task.run(undefined, ctx());
    expect(outcome).toEqual({ kind: "done", value: { idle: true } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("swallows a writer error and does not reject", async () => {
    const { buffer, bundle } = build();
    enqueue.mockRejectedValueOnce(new Error("writer down"));
    buffer.add("a", "insert");
    await expect(bundle.task.run(undefined, ctx())).resolves.toEqual({
      kind: "done",
      value: { idle: false },
    });
  });

  test("a failed chunk is isolated and re-buffered; siblings still flush", async () => {
    const { buffer, bundle } = build(undefined, 1); // one id per chunk
    // Fail only the 2nd writer op; the 1st and 3rd succeed.
    enqueue
      .mockResolvedValueOnce({ enqueued: 1 })
      .mockRejectedValueOnce(new Error("transient writer stall"))
      .mockResolvedValueOnce({ enqueued: 1 });
    for (const id of ["a", "b", "c"]) buffer.add(id, "insert");

    await bundle.task.run(undefined, ctx());

    // All three chunks were attempted (failure didn't abort the loop)...
    expect(enqueue).toHaveBeenCalledTimes(3);
    // ...and exactly one id (the failed chunk) was re-buffered for retry.
    expect(buffer.size()).toBe(1);

    // Next tick retries the survivor and lands it.
    enqueue.mockResolvedValue({ enqueued: 1 });
    await bundle.task.run(undefined, ctx());
    expect(buffer.size()).toBe(0);
  });

  test("flushNow() drains everything (graceful-shutdown path)", async () => {
    const { buffer, bundle } = build();
    buffer.add("a", "insert");
    buffer.add("b", "update");
    await bundle.flushNow();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(buffer.size()).toBe(0);
  });

  test("flushNow() on an empty buffer is a no-op (clean-restart path)", async () => {
    const { bundle } = build();
    await expect(bundle.flushNow()).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// Proves the three halves are actually wired together against a real DB:
// a real document.upserted event → buffer → flush task → near_dup_inbox row.
// Unit tests above mock the writeGate, so this guards the regression the
// indirection is most exposed to — "the buffer/flush silently writes nothing".
describe("integration: event → buffer → flush → near_dup_inbox (real db)", () => {
  let db: Db;
  let scheduler: Scheduler;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
    runMigrations(db);
    scheduler = new Scheduler({ enablePreemption: false });
  });

  afterEach(async () => {
    await scheduler.dispose();
    db.close();
  });

  function proj(id: string, documentType: string): DocumentProjection {
    return {
      id,
      providerId: "p",
      sourceId: "s",
      externalId: id,
      documentType,
      title: "title",
      contentHash: `h-${id}`,
      metadata: {},
      sourceCreatedAt: "2025-01-01T00:00:00Z",
      sourceUpdatedAt: "2025-01-01T00:00:00Z",
      people: [],
    };
  }

  function wire() {
    const bus = new EventBus();
    const buffer = createNearDupInboxBuffer();
    const off = subscribeNearDupInbox({
      eventBus: bus,
      buffer,
      getConfig: () => DEFAULT_NEAR_DUP_CONFIG,
    });
    const { task } = nearDupInboxFlushTask(
      { buffer, writeGate: directWriteGate(db), log },
      scheduler,
    );
    return { bus, buffer, task, off };
  }

  test("an eligible upsert lands a near_dup_inbox row only after a flush tick", async () => {
    const { bus, buffer, task, off } = wire();
    bus.emit("document.upserted", {
      before: null,
      after: proj("doc-1", "email"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    // Buffered on the hot path; nothing written to SQLite yet.
    expect(buffer.size()).toBe(1);
    expect(countNearDupInbox(db)).toBe(0);

    await task.run(undefined, ctx());

    // The flush made it durable.
    expect(countNearDupInbox(db)).toBe(1);
    expect(buffer.size()).toBe(0);
    off();
  });

  test("an ineligible doc type never reaches the inbox", async () => {
    const { bus, buffer, task, off } = wire();
    bus.emit("document.upserted", {
      before: null,
      after: proj("doc-2", "contact"),
      afterContent: "body",
      changedFields: [],
      contentChanged: true,
    });
    expect(buffer.size()).toBe(0);
    await task.run(undefined, ctx());
    expect(countNearDupInbox(db)).toBe(0);
    off();
  });
});
