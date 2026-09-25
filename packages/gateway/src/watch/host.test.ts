// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the gateway pays for hosting this, and what it pays when it isn't.
 *
 * Both properties here are about cost rather than correctness. The bus runs its
 * handlers synchronously on the main thread after every writer commit, so a
 * handler that did real work would put the materializer's whole cost on the
 * ingest path — and during a bootstrap that path runs thousands of times a
 * minute. And a subsystem nobody enabled should cost nothing at all, not run
 * quietly with its output discarded.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { EventBus } from "../events.js";
import { runSchemaSetup } from "../data/schema.js";
import { startWatchV2, type WatchV2HostOptions } from "./host.js";
import { capture, MaterializerQueue } from "./queue.js";
import type { Db } from "../data/types.js";
import type { DocumentProjection, DocumentUpsertedEvent } from "../events.js";

let dir: string;
let db: Db;
let bus: EventBus;

const SIGNALS = {
  importing: () => false,
  reportedPhase: () => "incremental",
};

function projection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    providerId: "google",
    sourceId: "gmail",
    externalId: "msg-1",
    documentType: "email",
    title: "Quote",
    contentHash: "h",
    metadata: {},
    sourceCreatedAt: "2026-03-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-03-01T09:00:00.000Z",
    people: [],
    ...overrides,
  };
}

function upserted(overrides: Partial<DocumentUpsertedEvent> = {}): DocumentUpsertedEvent {
  return {
    before: null,
    after: projection(),
    afterContent: "",
    changedFields: [],
    contentChanged: true,
    ...overrides,
  };
}

function options(overrides: Partial<WatchV2HostOptions> = {}): WatchV2HostOptions {
  return {
    configDir: dir,
    db,
    indexDb: null,
    analyticsDb: null,
    bus,
    signals: SIGNALS,
    storageKey: null,
    enabled: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watch2-host-"));
  db = new Database(":memory:");
  runSchemaSetup(db);
  bus = new EventBus();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("with the gate off", () => {
  it("creates nothing — no file, no subscription, no task", () => {
    const host = startWatchV2(options({ enabled: () => false }));

    expect(host).toBeNull();
    expect(existsSync(join(dir, "watch.db")), "a disabled subsystem created its store").toBe(false);

    // And the bus still runs with nothing attached.
    bus.emit("document.upserted", upserted());
  });
});

describe("with the gate on", () => {
  it("captures bus events without touching the database on the ingest path", () => {
    const host = startWatchV2(options());
    expect(host).not.toBeNull();

    try {
      // A read here would be a query per event on the ingest path. The handler
      // is allowed to do exactly one thing: reduce and append.
      const before = host!.store.count();
      bus.emit("document.upserted", upserted());
      bus.emit("analytics_row.inserted", {
        table: "example_rows",
        sourceId: "plaid:acct",
        row: { id: "r-1" },
      });

      expect(host!.queue.depth, "the document handler did not capture the event").toBe(1);
      expect(host!.store.count(), "the handler wrote to the journal synchronously").toBe(before);
    } finally {
      host!.stop();
    }
  });

  it("stops listening once it is stopped", () => {
    const host = startWatchV2(options())!;
    host.stop();

    bus.emit("document.upserted", upserted());
    expect(host.queue.depth, "a stopped host was still queueing events").toBe(0);
  });

  it("takes its cost controls from configuration", () => {
    const host = startWatchV2(
      options({
        tunables: {
          drainIntervalMs: 500,
          idleIntervalMs: 9_000,
          batchSize: 7,
          queueCapacity: 3,
        },
      }),
    )!;
    try {
      expect(host.task.periodMs).toBe(500);
      expect(host.task.idlePeriodMs).toBe(9_000);
      // The queue capacity is not readable, so it is checked by behaviour:
      // a fourth event past a capacity of three is dropped.
      for (let i = 0; i < 4; i += 1) bus.emit("document.upserted", upserted());
      expect(host.queue.depth, "queueCapacity did not reach the queue").toBe(3);
      expect(host.queue.dropped.documents).toBe(1);
    } finally {
      host.stop();
    }
  });

  it("backs off instead of spinning when a drain keeps failing", async () => {
    // The drain runs on the main thread every couple of seconds. A persistent
    // fault — a closed handle at shutdown, a full disk — must not turn into a
    // tight loop against it.
    const host = startWatchV2(options())!;
    // A closed store handle is a synthetic provocation rather than a race the
    // gateway can reach — shutdown disposes the scheduler before it stops the
    // host. What it exercises is the runner's catch: the realistic transient
    // (a rejected catalog read) is covered where the drain itself is tested.
    host.store.close();
    bus.emit("analytics_row.inserted", {
      table: "example_rows",
      sourceId: "plaid:acct",
      row: { id: "r-1" },
    });

    const outcome = await host.task.run({} as never, undefined);
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("expected a completed tick");
    expect(outcome.value.idle, "a failing drain stayed on the active cadence").toBe(true);
    expect(host.task.isIdle?.(outcome.value)).toBe(true);
  });
});

describe("the queue between the handler and the drain", () => {
  it("keeps only the fields the drain reads, not the document body", () => {
    // A `DocumentUpsertedEvent` carries the whole body and the drain never
    // reads it. Holding the event whole pins every queued document's text in
    // memory for a drain interval — hundreds of megabytes at a bootstrap's
    // queue depth, for strings nothing will look at.
    const body = "x".repeat(1024);
    const captured = capture(upserted({ afterContent: body, beforeContent: body }), 0);

    expect(captured, "the event's body came along for the ride").not.toHaveProperty("afterContent");
    expect(captured).not.toHaveProperty("beforeContent");
    expect(
      JSON.stringify(captured).includes(body),
      "the body survived somewhere inside the captured record",
    ).toBe(false);
    // And what the drain does read is still there.
    expect(captured.document.title).toBe("Quote");
    expect(captured.document.metadata).toBeDefined();
  });

  it("reads an insert as a creation and an update as an update", () => {
    expect(capture(upserted(), 0).op).toBe("created");
    expect(capture(upserted({ before: projection() }), 0).op).toBe("updated");
  });

  it("throws away the overflow rather than the process", () => {
    // Unbounded, a source pushing faster than the drain empties grows the array
    // until the gateway dies — a far worse failure than a missed shadow event.
    // What is dropped is counted, because a silent loss reads as a quiet corpus.
    const queue = new MaterializerQueue(2);
    for (let i = 0; i < 5; i += 1) {
      queue.pushRow({ at: 0, table: "t", sourceId: "s", row: { id: i }, backfill: false });
    }
    expect(queue.depth).toBe(2);
    expect(queue.dropped.rows).toBe(3);

    for (let i = 0; i < 4; i += 1) queue.pushDocument(capture(upserted(), i));
    expect(queue.dropped.documents, "dropped documents went uncounted").toBe(2);
  });

  it("hands the drain a snapshot and keeps arrivals for the next one", () => {
    const queue = new MaterializerQueue();
    queue.pushRow({ at: 0, table: "t", sourceId: "s", row: { id: 1 }, backfill: false });
    const taken = queue.take();
    queue.pushRow({ at: 0, table: "t", sourceId: "s", row: { id: 2 }, backfill: false });

    expect(taken.rows, "the snapshot grew under the drain").toHaveLength(1);
    expect(queue.depth).toBe(1);
  });

  it("puts returned work at the front, where the oldest deadline is", () => {
    const queue = new MaterializerQueue();
    queue.pushDocument(capture(upserted(), 2));
    queue.returnDocuments([capture(upserted(), 1)]);
    queue.pushRow({ at: 2, table: "t", sourceId: "s", row: { id: 2 }, backfill: false });
    queue.returnRows([{ at: 1, table: "t", sourceId: "s", row: { id: 1 }, backfill: false }]);

    const taken = queue.take();
    expect(taken.documents.map((d) => d.at)).toEqual([1, 2]);
    expect(taken.rows.map((r) => r.at)).toEqual([1, 2]);
  });

  it("accepts returned work even at capacity, because it was already accepted", () => {
    // Dropping here would lose exactly the work a transient failure was about
    // to retry.
    const queue = new MaterializerQueue(1);
    queue.pushDocument(capture(upserted(), 2));
    queue.returnDocuments([capture(upserted(), 1)]);
    expect(queue.depth).toBe(2);
    expect(queue.dropped.documents).toBe(0);
  });
});
