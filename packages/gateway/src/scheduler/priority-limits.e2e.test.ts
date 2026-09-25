// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source wipe does to a page that is already halfway into the writer.
 *
 * A collector page larger than `UPSERT_WITH_CURSOR_CHUNK_SIZE` is not one
 * transaction. `upsertWithCursorYieldable` commits the pre-final documents in
 * 50-doc sub-transactions and polls the preempt token between them, so a
 * user-priority write can cut in. When it does, the rest of the page leaves the
 * writer worker entirely: the continuation is structured-cloned back to the main
 * thread as the task's resume args, re-queued at the back of the realtime lane,
 * and re-enters the worker only once every user-priority op ahead of it has run.
 * "Remove this source" is one of those ops, and it is the one that has to win —
 * `deleteAllBySource` advances the source's write epoch, and the resumed page is
 * fenced on the epoch its sync attempt claimed, so nothing it still holds may
 * land.
 *
 * `db.test.ts` pins the fence itself with a stubbed token and two hand-sequenced
 * calls. What only an end-to-end can show is that the three moving parts line up
 * in production shape: the yield is produced by the real SharedArrayBuffer flag
 * the Scheduler flips, the wipe is ordered ahead of the continuation by the real
 * priority queue rather than by the test, and the resume args survive
 * `postMessage` — a page that lost its documents or its cursor in the clone
 * would be refused for the wrong reason and look identical from outside.
 *
 * The two page tests are one choreography with a single input changed: which
 * source the wipe names. Wiping the page's own source rejects it whole; wiping
 * an unrelated source leaves it alone, and it commits all 1,200 documents, its
 * tombstone and its cursor. Each states its preconditions — the Scheduler really
 * did signal a yield, the page really did come back through the worker boundary,
 * the wipe really did find committed chunks to take — so neither can pass on a
 * page that never chunked.
 *
 * The last test reads the same invariant from the other side: the wipe is
 * deliberately absent from `writerYieldableHandlers`, so it is the interruption
 * that cannot itself be interrupted. It needs no scheduler and no worker.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, getWipeEpoch } from "../db.js";
import { UPSERT_WITH_CURSOR_CHUNK_SIZE } from "../data/repositories/DocumentRepository.js";
import { runWithPriority } from "../priority.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import { writerYieldableHandlers } from "./writer-handlers.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const PROVIDER = ProviderId("priority-limits");
const PAGE_SOURCE = SourceId("priority-limits-page");
const OTHER_SOURCE = SourceId("priority-limits-other");

/** 24 chunks at the writer's default; 23 of them pre-final and yieldable. */
const PAGE_SIZE = 24 * UPSERT_WITH_CURSOR_CHUNK_SIZE;
/**
 * The wipe is held until the page has committed this many rows. Two chunks in
 * leaves 21 pre-final chunks — each its own `synchronous = FULL` transaction —
 * between the gate and the end of the page, so however fast the disk is, the
 * writer cannot reach the end of the page in the handful of microtasks between
 * the polling read that opens the gate and the enqueue that follows it.
 */
const MID_PAGE_ROWS = 2 * UPSERT_WITH_CURSOR_CHUNK_SIZE;
/** Documents seeded on the unrelated source, so its wipe has something to take. */
const OTHER_SIZE = 40;

function makeDocs(sourceId: SourceId, count: number, prefix: string): DocumentInput[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    providerId: PROVIDER,
    sourceId,
    externalId: `${prefix}-${i}`,
    title: `Ingest fixture ${prefix} ${i}`,
    content: `Sample ingest body ${i}. `.repeat(20),
    contentHash: `${prefix}-hash-${i}`,
    sourceCreatedAt: now,
    sourceUpdatedAt: now,
    metadata: { documentType: "note" as const },
  }));
}

function cursorNow(): SyncCursor {
  return { type: "incremental", lastSyncTime: new Date().toISOString() } as SyncCursor;
}

describe("A source wipe against a chunking page", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let read: Database.Database | null = null;

  /**
   * A second, read-only handle on the same file. The writer worker owns the
   * writable one; WAL lets this one observe each sub-transaction as it commits,
   * which is what makes "the page is mid-flight" an observable condition rather
   * than a sleep. Only ever opened after a first write has been committed, so
   * the WAL sidecar files exist for a connection that may not create them.
   */
  function openRead(): Database.Database {
    const handle = new Database(dbPath, { readonly: true });
    handle.pragma("busy_timeout = 5000");
    read = handle;
    return handle;
  }

  function countDocs(handle: Database.Database, sourceId: SourceId): number {
    return (
      handle
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
        .get(sourceId)?.n ?? 0
    );
  }

  function pageYieldCount(): number {
    const stats = scheduler.snapshot(60).perTask.find((t) => t.name === "db.upsertWithCursor");
    expect(stats).toBeDefined();
    return stats!.yieldCount;
  }

  beforeEach(async () => {
    dbPath = `/tmp/omnesis-priority-limits-${randomUUID()}.db`;
    const seed = createDatabase(dbPath);
    seed.close();
    scheduler = new Scheduler({ enablePreemption: true });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();
  });

  afterEach(async () => {
    read?.close();
    read = null;
    await scheduler.dispose();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  test("wiping the page's own source rejects the resumed continuation whole", async () => {
    const gate = writeGateFromScheduler(scheduler);

    // The collector claims the source's write epoch when a sync attempt starts
    // and echoes it back on every page. `beginSyncAttempt` is the only thing so
    // far to touch `source_wipe_epoch`, so this attempt holds epoch 1.
    const epoch = await runWithPriority("realtime", () => gate.beginSyncAttempt(PAGE_SOURCE));
    expect(epoch).toBe(1);
    const handle = openRead();

    const pagePromise = runWithPriority("realtime", () =>
      gate.upsertWithCursor({
        providerId: PROVIDER,
        sourceId: PAGE_SOURCE,
        documents: makeDocs(PAGE_SOURCE, PAGE_SIZE, "page"),
        hasMore: false,
        cursor: cursorNow(),
        wipeEpoch: epoch,
      }),
    );

    await vi.waitFor(
      () => {
        expect(countDocs(handle, PAGE_SOURCE)).toBeGreaterThanOrEqual(MID_PAGE_ROWS);
      },
      { timeout: 20_000, interval: 10 },
    );

    // `db.deleteAllBySource` is declared `user` in the write-op registry, so it
    // enters the user lane on its own — no ambient priority needed, exactly as
    // the remove-source route reaches it.
    const preemptsBefore = scheduler.preemptRequestCount;
    const deleted = await gate.deleteAllBySource(PAGE_SOURCE);
    const pageResult = await pagePromise;

    // Preconditions. A yield is only signalled when the op in flight
    // ranks below the arrival, so a request here is proof the page was still
    // running when the wipe was enqueued; the yield count is proof it acted on
    // the flag and came back through the worker boundary; and the wipe carried
    // off the chunks the page had already committed.
    expect(scheduler.preemptRequestCount - preemptsBefore).toBe(1);
    expect(pageYieldCount()).toBeGreaterThanOrEqual(1);
    expect(deleted).toBeGreaterThanOrEqual(MID_PAGE_ROWS);

    // The wipe wins whole: the resumed page is refused at the fence, so not one
    // of the documents it still held is resurrected onto the emptied source.
    expect(pageResult.rejected).toBe(true);
    expect(countDocs(handle, PAGE_SOURCE)).toBe(0);
    expect(getWipeEpoch(handle, PAGE_SOURCE)).toBe(epoch + 1);
    // Belt and braces: no cursor survives either. Weaker than the three above —
    // this source has no `sync_state` row before the test does anything, since
    // only the page's final chunk would have written one.
    expect(
      handle
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM sync_state WHERE source_id = ?")
        .get(PAGE_SOURCE)?.n,
    ).toBe(0);
  }, 60_000);

  test("wiping an unrelated source leaves the page to finish", async () => {
    const gate = writeGateFromScheduler(scheduler);

    await runWithPriority("realtime", () =>
      gate.upsertDocuments(makeDocs(OTHER_SOURCE, OTHER_SIZE, "other")),
    );
    // One older document on the page's own source, which the page names in its
    // per-page tombstone channel. The tombstone applies only in the final chunk,
    // so it lands only if the whole reconciliation context survived the clone.
    await runWithPriority("realtime", () =>
      gate.upsertDocuments(makeDocs(PAGE_SOURCE, 1, "stale")),
    );
    const epoch = await runWithPriority("realtime", () => gate.beginSyncAttempt(PAGE_SOURCE));
    const handle = openRead();

    const pagePromise = runWithPriority("realtime", () =>
      gate.upsertWithCursor({
        providerId: PROVIDER,
        sourceId: PAGE_SOURCE,
        documents: makeDocs(PAGE_SOURCE, PAGE_SIZE, "page"),
        deletedExternalIds: ["stale-0"],
        hasMore: false,
        cursor: cursorNow(),
        wipeEpoch: epoch,
      }),
    );

    await vi.waitFor(
      () => {
        expect(countDocs(handle, PAGE_SOURCE)).toBeGreaterThanOrEqual(MID_PAGE_ROWS);
      },
      { timeout: 20_000, interval: 10 },
    );

    const preemptsBefore = scheduler.preemptRequestCount;
    const deletedOther = await gate.deleteAllBySource(OTHER_SOURCE);
    const pageResult = await pagePromise;

    // Same preconditions as the fenced case: the page was in flight, it yielded,
    // and the wipe was a real cascade rather than a no-op.
    expect(scheduler.preemptRequestCount - preemptsBefore).toBe(1);
    expect(pageYieldCount()).toBeGreaterThanOrEqual(1);
    expect(deletedOther).toBe(OTHER_SIZE);

    // The fence is per source. This page's epoch never moved, so its
    // continuation is admitted and commits everything it was holding.
    expect(pageResult.rejected).toBeFalsy();
    expect(getWipeEpoch(handle, PAGE_SOURCE)).toBe(epoch);
    expect(countDocs(handle, PAGE_SOURCE)).toBe(PAGE_SIZE);
    expect(countDocs(handle, OTHER_SOURCE)).toBe(0);
    // The final chunk ran with the args it was given before the yield: the
    // tombstone took the older document, and the cursor advanced with it.
    expect(pageResult.tombstoneDeletedDocumentIds).toHaveLength(1);
    const state = handle
      .prepare<[string], { cursor: string }>("SELECT cursor FROM sync_state WHERE source_id = ?")
      .get(PAGE_SOURCE);
    expect(state?.cursor).toBeTruthy();
  }, 60_000);
});

describe("The wipe itself", () => {
  test("the bulk wipes are absent from the yieldable writer handlers", () => {
    // A cascade delete is the one O(corpus) writer op that runs at `user`
    // priority, and it is deliberately not chunked: chunking would let a
    // concurrent sync re-insert documents between the chunks, and would leave a
    // half-wiped source behind a crash (write-ops.ts). So it holds the single
    // writer for its whole duration and nothing can signal it to step aside —
    // which is exactly what the page above has to survive. If a yieldable
    // variant is ever added, those two races need an answer first, and this
    // guard falls with them.
    const yieldable = Object.keys(writerYieldableHandlers);
    for (const op of ["db.deleteAllBySource", "db.deleteAllByStream", "db.deleteAllByProvider"]) {
      expect(yieldable).not.toContain(op);
    }
  });
});
