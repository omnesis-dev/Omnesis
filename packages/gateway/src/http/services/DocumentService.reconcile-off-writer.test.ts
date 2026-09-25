// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Snapshot reconcile at the service seam.
 *
 * Two properties are load-bearing here and neither is visible from the
 * repository alone. First, a snapshot's omissions are recorded, never applied:
 * a page whose snapshot names none of what the source holds leaves the corpus
 * exactly as it found it. Second, the diff runs OFF the
 * writer — the scan is the expensive half, and the writer is the one contended
 * thread in the gateway — while the marks it produces still commit inside the
 * cursor transaction, so a page's documents and the absences its snapshot
 * implies land together or not at all.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_WRITE_ALL, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, bumpWipeEpoch, countPendingAbsences } from "../../db.js";
import { getActivePriority, runWithPriority } from "../../priority.js";
import {
  computeSnapshotAbsencePlan,
  type SnapshotAbsencePlan,
} from "../../data/repositories/AbsenceRepository.js";
import { beginSyncAttempt } from "../../data/repositories/SyncStateRepository.js";
import { markSourceRemoved } from "../../data/repositories/SourceRepository.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { DocumentService } from "./DocumentService.js";
import { EventService } from "./EventService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function doc(externalId: string): DocumentInput {
  return {
    providerId: "google",
    sourceId: "gmail",
    externalId,
    title: `Doc ${externalId}`,
    content: `body ${externalId}`,
    contentHash: `ch-${externalId}`,
    metadata: { documentType: "email" },
    sourceCreatedAt: "2026-01-15T10:00:00Z",
    sourceUpdatedAt: "2026-01-15T10:00:00Z",
  } as unknown as DocumentInput;
}

interface SpiedCalls {
  upsertWithCursorArgs: Array<{
    presentExternalIds?: string[];
    absencePlan?: SnapshotAbsencePlan;
  }>;
  deleteDocumentsCalls: Array<string[]>;
  /** Writer-op names in invocation order, to pin ordering guarantees. */
  sequence: string[];
  /** Ambient priority observed by each IO compute round. */
  computePriorities: Array<string | null>;
  /** Ambient priority observed by each writer-side page commit. */
  writePriorities: Array<string | null>;
}

function makeService(opts: {
  ioGate: boolean;
  afterCompute?: (plan: SnapshotAbsencePlan) => void | Promise<void>;
}): {
  service: DocumentService;
  calls: SpiedCalls;
} {
  const gate = directWriteGate(db);
  const calls: SpiedCalls = {
    upsertWithCursorArgs: [],
    deleteDocumentsCalls: [],
    sequence: [],
    computePriorities: [],
    writePriorities: [],
  };
  const spied: WriteGate = {
    ...gate,
    upsertWithCursor: (args, canonicalizers) => {
      calls.upsertWithCursorArgs.push({
        presentExternalIds: args.presentExternalIds,
        absencePlan: args.absencePlan,
      });
      calls.sequence.push("upsertWithCursor");
      calls.writePriorities.push(getActivePriority());
      return gate.upsertWithCursor(args, canonicalizers);
    },
    applySnapshotAbsencePlan: (...args) => {
      calls.sequence.push("applySnapshotAbsencePlan");
      return gate.applySnapshotAbsencePlan(...args);
    },
    deleteDocuments: (...args) => {
      calls.deleteDocumentsCalls.push([...args[2]]);
      calls.sequence.push("deleteDocuments");
      return gate.deleteDocuments(...args);
    },
  };
  const service = new DocumentService({
    db,
    writeGate: spied,
    events: new EventService(db, undefined, false),
    ioGate: opts.ioGate
      ? {
          snapshotAbsencePlan: async (
            providerId,
            sourceId,
            presentExternalIds,
            policy,
            streamId,
          ) => {
            calls.computePriorities.push(getActivePriority());
            const plan = computeSnapshotAbsencePlan(
              db,
              providerId,
              sourceId,
              presentExternalIds,
              policy,
              streamId ?? "",
            );
            await opts.afterCompute?.(plan);
            return plan;
          },
        }
      : undefined,
  });
  return { service, calls };
}

function seed(service: DocumentService, externalIds: string[]) {
  return service.upsertWithCursor({
    callerScopes: [SCOPE_WRITE_ALL],
    body: {
      providerId: "google",
      sourceId: "gmail",
      documents: externalIds.map(doc),
      hasMore: false,
      cursor: { syncedAt: "2026-01-15T10:00:00Z" },
    },
  });
}

function survivingExternalIds(): string[] {
  return db
    .prepare<[], { external_id: string }>(
      "SELECT external_id FROM documents WHERE provider_id = 'google' AND source_id = 'gmail' ORDER BY external_id",
    )
    .all()
    .map((r) => r.external_id);
}

function markedExternalIds(): string[] {
  return db
    .prepare<[], { external_id: string }>(
      "SELECT external_id FROM document_absences ORDER BY external_id",
    )
    .all()
    .map((r) => r.external_id);
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("upsertWithCursor snapshot reconcile off the writer", () => {
  test("a removed page stops before authority refresh or writes while preserving scope checks", async () => {
    const { service, calls } = makeService({ ioGate: true });
    markSourceRemoved(db, SourceId("gmail"));
    const pageWriteAuthority = vi.fn((): never => {
      throw new Error("Removed sources must stop before refreshing authority");
    });
    const body = { providerId: "google", sourceId: "gmail", cursor: {}, hasMore: false };
    await expect(
      service.upsertWithCursor({ callerScopes: [SCOPE_WRITE_ALL], body, pageWriteAuthority }),
    ).resolves.toMatchObject({ ingested: 0, reconciledDeleted: 0, rejectedAsRemoved: true });
    await expect(
      service.upsertWithCursor({ callerScopes: [], body, pageWriteAuthority }),
    ).rejects.toMatchObject({ status: 403 });
    expect(pageWriteAuthority).not.toHaveBeenCalled();
    expect(calls.sequence).toEqual([]);
  });

  test("live page authority refresh precedes snapshot decisions", async () => {
    const { service } = makeService({ ioGate: true });
    await seed(service, ["retained"]);
    const pageWriteAuthority = vi.fn(() => ({
      deletionAuthority: false,
      reconcileAuthority: false,
      resetReplicaCursors: undefined,
    }));
    await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      reconcileAuthority: true,
      pageWriteAuthority,
      body: {
        providerId: "google",
        sourceId: "gmail",
        cursor: {},
        hasMore: false,
        presentExternalIds: [],
      },
    });
    expect(pageWriteAuthority).toHaveBeenCalledOnce();
    expect(markedExternalIds()).toEqual([]);
    expect(survivingExternalIds()).toEqual(["retained"]);
  });

  test("a snapshot that omits a stored document marks it and deletes nothing", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        documents: [doc("a")],
        presentExternalIds: ["a", "b"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.absence).toMatchObject({ marked: 1, absent: 1, stored: 3, snapshot: 2 });
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
    expect(markedExternalIds()).toEqual(["c"]);
    // Nothing was deleted, so no delete op reached the writer at all.
    expect(calls.deleteDocumentsCalls).toEqual([]);
    // The writer received a finished plan, not a snapshot to diff.
    expect(calls.upsertWithCursorArgs.at(-1)!.absencePlan).toBeDefined();
  });

  test("a snapshot that omits the entire source still deletes nothing", async () => {
    // The reproduction, at the seam that applies a snapshot: Things 165 -> 0.
    const { service } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: [],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.absence).toMatchObject({ absent: 3, stored: 3, snapshot: 0 });
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });

  test("a lost with-cursor response replay cannot count the completed attempt twice", async () => {
    const { service } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);
    const body = {
      providerId: "google",
      sourceId: "gmail",
      presentExternalIds: ["a"],
      observationId: "epoch-7:attempt-a",
      hasMore: false,
      cursor: { syncedAt: "2026-01-16T10:00:00Z" },
    };

    await service.upsertWithCursor({ callerScopes: [SCOPE_WRITE_ALL], body });
    db.prepare("UPDATE document_absences SET last_absent_at = 0").run();
    await service.upsertWithCursor({ callerScopes: [SCOPE_WRITE_ALL], body });

    expect(
      db.prepare<[], { observations: number }>("SELECT observations FROM document_absences").get()!
        .observations,
    ).toBe(1);
  });

  test("a later snapshot naming the document again revokes its absence", async () => {
    const { service } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);
    await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });
    expect(countPendingAbsences(db)).toBe(2);

    const recovered = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a", "b", "c"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-17T10:00:00Z" },
      },
    });

    expect(recovered.absence).toMatchObject({ cleared: 2, absent: 0 });
    expect(countPendingAbsences(db)).toBe(0);
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });

  test("the snapshot's ids the corpus does not hold are counted and surfaced", async () => {
    const { service } = makeService({ ioGate: true });

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a", "b", "c"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    // Three live ids, nothing stored — a reading a healthy no-op cannot make.
    expect(result.absence).toMatchObject({ missing: 3, stored: 0, absent: 0 });
  });

  test("a tombstone on the same page still deletes at once", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);

    await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        // The source asserts b is gone AND omits c from its snapshot. Only the
        // assertion applies now; the omission starts a clock.
        deletedExternalIds: ["b"],
        presentExternalIds: ["a"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(survivingExternalIds()).toEqual(["a", "c"]);
    expect(markedExternalIds()).toEqual(["c"]);
    // The tombstone deletes inside the page's own writer transaction, so no
    // separate delete op is needed — and none of the absences produced one.
    expect(calls.deleteDocumentsCalls).toEqual([]);
  });

  test("the compute round runs at realtime priority on the collector's critical path", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);

    await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(calls.computePriorities).toEqual(["realtime"]);
  });

  test("the page commit keeps the collector's realtime priority on the writer", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);
    calls.writePriorities.length = 0;

    // The HTTP middleware tags a collector request `realtime`; the service
    // must not demote the page commit below it. A `background` commit is
    // ordered behind every backfill drip on the one writer thread and is
    // skipped outright while `POST /admin/background/pause` is in effect —
    // the very pause whose contract is that collector ingestion keeps flowing.
    await runWithPriority("realtime", () =>
      service.upsertWithCursor({
        callerScopes: [SCOPE_WRITE_ALL],
        body: {
          providerId: "google",
          sourceId: "gmail",
          documents: [doc("d")],
          hasMore: true,
          cursor: { syncedAt: "2026-01-16T10:00:00Z" },
        },
      }),
    );

    expect(calls.writePriorities).toEqual(["realtime"]);
  });

  test("a zero-absence snapshot costs the writer nothing beyond the cursor write", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);
    calls.sequence.length = 0;

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a", "b"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.absence).toMatchObject({ marked: 0, cleared: 0, absent: 0 });
    expect(calls.sequence).toEqual(["upsertWithCursor"]);
  });

  test("a mid-page snapshot (hasMore) is never consumed", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a"],
        hasMore: true,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.absence).toBeUndefined();
    expect(countPendingAbsences(db)).toBe(0);
    expect(calls.computePriorities).toEqual([]);
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });

  test("a stale echoed wipeEpoch (#551) skips the compute and the writer rejects", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);
    bumpWipeEpoch(db, "gmail");

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: [],
        wipeEpoch: 0,
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.rejected).toBe(true);
    expect(calls.computePriorities).toEqual([]);
    expect(countPendingAbsences(db)).toBe(0);
    expect(survivingExternalIds()).toEqual(["a", "b"]);
  });

  test("does not mark a document reinserted after a mid-reconcile wipe", async () => {
    let wiped = false;
    const { service } = makeService({
      ioGate: true,
      afterCompute: async () => {
        if (wiped) return;
        wiped = true;
        // A wipe and re-bootstrap race the read: the plan names document ids
        // that no longer exist, so the fresh rows must not inherit its verdict.
        bumpWipeEpoch(db, "gmail");
        await seed(service, ["a", "b"]);
      },
    });
    await seed(service, ["a", "b"]);

    await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: [],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(survivingExternalIds()).toEqual(["a", "b"]);
  });

  test("without an IO gate the writer withholds the snapshot instead of scanning the source", async () => {
    const { service, calls } = makeService({ ioGate: false });
    await seed(service, ["a", "b", "c"]);

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: ["a"],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    // A missing read worker is not permission to do an O(source) diff on the
    // sole writer. Withholding costs one cycle and preserves the corpus.
    expect(calls.upsertWithCursorArgs.at(-1)!.absencePlan).toBeUndefined();
    expect(result.absence).toBeUndefined();
    expect(countPendingAbsences(db)).toBe(0);
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });

  test("a member with no reconcile authority leaves the snapshot alone", async () => {
    const { service, calls } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);

    const result = await service.upsertWithCursor({
      callerScopes: [SCOPE_WRITE_ALL],
      reconcileAuthority: false,
      body: {
        providerId: "google",
        sourceId: "gmail",
        presentExternalIds: [],
        hasMore: false,
        cursor: { syncedAt: "2026-01-16T10:00:00Z" },
      },
    });

    expect(result.reconcileDeferred).toBe(true);
    expect(result.absence).toBeUndefined();
    expect(calls.computePriorities).toEqual([]);
    expect(countPendingAbsences(db)).toBe(0);
  });
});

describe("the /documents/reconcile endpoint", () => {
  test("marks the snapshot's omissions and reports them without deleting", async () => {
    const { service } = makeService({ ioGate: true });
    await seed(service, ["a", "b", "c"]);

    const result = await service.reconcile("google", "gmail", ["a"]);

    expect(result.deleted).toBe(0);
    expect(result.deletedIds).toEqual([]);
    expect(result.absence).toMatchObject({ marked: 2, absent: 2, stored: 3, snapshot: 1 });
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
    expect(markedExternalIds()).toEqual(["b", "c"]);
  });

  test("a stale claimed epoch marks nothing", async () => {
    const { service } = makeService({ ioGate: true });
    await seed(service, ["a", "b"]);
    // A newer sync attempt claims the source; the caller's echoed epoch of 0
    // is stale, so its snapshot has no authority over what is stored now.
    beginSyncAttempt(db, "gmail");

    const result = await service.reconcile("google", "gmail", [], 0, true);

    expect(result.deleted).toBe(0);
    expect(countPendingAbsences(db)).toBe(0);
    expect(survivingExternalIds()).toEqual(["a", "b"]);
  });

  test("a wipe between the diff and the write discards the plan", async () => {
    let wiped = false;
    const { service } = makeService({
      ioGate: true,
      afterCompute: async () => {
        if (wiped) return;
        wiped = true;
        // The source is wiped and re-bootstrapped after the diff was taken. A
        // re-bootstrap re-derives the same document ids, so the plan's foreign
        // keys all still resolve — only the write epoch can tell that the rows
        // the plan describes are not the rows it was computed against.
        bumpWipeEpoch(db, "gmail");
        await seed(service, ["a", "b", "c"]);
      },
    });
    await seed(service, ["a", "b", "c"]);

    const result = await service.reconcile("google", "gmail", ["a"]);

    expect(result.absence).toMatchObject({ marked: 0, cleared: 0 });
    expect(countPendingAbsences(db)).toBe(0);
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });

  test("without an IO gate the diff runs on the main read handle and still only marks", async () => {
    const { service } = makeService({ ioGate: false });
    await seed(service, ["a", "b", "c"]);

    const result = await service.reconcile("google", "gmail", ["a"]);

    expect(result.absence).toMatchObject({ marked: 2 });
    expect(survivingExternalIds()).toEqual(["a", "b", "c"]);
  });
});
