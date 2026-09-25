// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweep is the only path by which an omission becomes a deletion, so what
 * it must never do matters as much as what it does: it must not run at a
 * priority that escapes admission control, must not drain a backlog in one
 * pass, must not cascade derived rows for a document it did not delete, and
 * must not decide due-ness for the writer — the read happens off the writer,
 * so the writer has to be given enough to re-decide.
 */

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { getActivePriority, runWithPriority } from "../priority.js";
import { createAbsenceSweepTask } from "./task.js";
import type { DueAbsence, AbsenceCascade } from "../data/repositories/AbsenceRepository.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { TaskContext } from "../scheduler/types.js";
import type { WriteGate } from "../write-gate.js";

const context = {} as TaskContext;
const NOW = 1_767_322_800_000;
const DAY = 24 * 60 * 60_000;

function absence(externalId: string, sourceId = "apple-notes"): DueAbsence {
  return {
    documentId: `doc-${externalId}`,
    providerId: "apple",
    sourceId,
    streamId: "",
    externalId,
  };
}

interface AnalyticsDue {
  markId: string;
  sourceId: string;
  tableName: string;
  streamId: string;
  keyColumn: string;
  keyValue: string;
  observedBy: string;
  dueBefore: number;
  minObservations: number;
}

function harness(
  opts: {
    due?: DueAbsence[];
    /** Document ids the writer finds no longer due when it re-decides. */
    revoked?: string[];
    batchSize?: number;
    analyticsDue?: AnalyticsDue[];
    /** Sources the sweep judge reports as replicated. */
    replicatedSources?: string[];
    /** Row keys the sweep judge reports as disputed. */
    disputedRows?: string[];
    pendingCascades?: AbsenceCascade[];
    withIndexGate?: boolean;
    staleCount?: number;
    deletionGraceMs?: number;
  } = {},
) {
  const due = opts.due ?? [];
  const revokedIds = new Set(opts.revoked ?? []);
  const sweepPriorities: Array<ReturnType<typeof getActivePriority>> = [];
  const sweepArgs: Array<{ documentIds: string[]; opts: Record<string, number> }> = [];
  const dueAbsences = vi.fn(() => Promise.resolve(due));
  const sweepDueAbsences = vi.fn((documentIds: string[], sweepOpts: Record<string, number>) => {
    sweepPriorities.push(getActivePriority());
    sweepArgs.push({ documentIds, opts: sweepOpts });
    const kept = documentIds.filter((id) => !revokedIds.has(id));
    return Promise.resolve({
      deletedDocumentIds: kept,
      revoked: documentIds.length - kept.length,
      ...(kept.length > 0
        ? {
            cascade: {
              id: 1,
              documentIds: kept,
              indexDone: false,
              cognitionDone: false,
            },
          }
        : {}),
    });
  });
  const staleCandidates = Array.from({ length: opts.staleCount ?? 0 }, (_, i) => ({
    documentId: `stale-${i}`,
    generation: 0,
  }));
  const staleAbsences = vi.fn(() => Promise.resolve(staleCandidates));
  const reclaimStaleAbsences = vi.fn(() => Promise.resolve(staleCandidates.length));
  const acknowledgeAbsenceCascade = vi.fn((_id: number, _part: "index" | "cognition") =>
    Promise.resolve(),
  );
  const pendingAbsenceCascades = vi.fn(() => Promise.resolve(opts.pendingCascades ?? []));
  const deleteChunksByDocuments = vi.fn(() => Promise.resolve(0));
  const purgeAnnotationsFor = vi.fn(() => Promise.resolve());
  const analyticsDueAbsences = vi.fn(() => Promise.resolve(opts.analyticsDue ?? []));
  const planAnalyticsSweep = vi.fn(
    (candidates: Array<{ sourceId: string; tableName: string; keyValue: string }>) =>
      Promise.resolve({
        replicatedSources: opts.replicatedSources ?? [],
        disputed: candidates
          .filter((c) => opts.disputedRows?.includes(c.keyValue))
          .map((c) => `${c.sourceId} ${c.tableName} ${c.keyValue}`),
      }),
  );
  const recordAnalyticsSweepVerdict = vi.fn((_verdict: Record<string, unknown>, _now: number) =>
    Promise.resolve(),
  );
  // Each due row is judged inside the store's transaction; a disputed one stays.
  const deleteAbsentRecords = vi.fn(
    async (
      due: readonly AnalyticsDue[],
      judge?: (row: AnalyticsDue) => Promise<"delete" | "disputed">,
    ) => {
      let deleted = 0;
      let disputed = 0;
      for (const row of due) {
        if (judge && (await judge(row)) === "disputed") disputed += 1;
        else deleted += 1;
      }
      return { deleted, disputed };
    },
  );
  const bundle = createAbsenceSweepTask(
    {
      writeGate: {
        reclaimStaleAbsences,
        sweepDueAbsences,
        acknowledgeAbsenceCascade,
        recordAnalyticsSweepVerdict,
      } as unknown as WriteGate,
      ioGate: { dueAbsences, pendingAbsenceCascades, staleAbsences, planAnalyticsSweep } as never,
      indexWriteGate: opts.withIndexGate === false ? undefined : { deleteChunksByDocuments },
      analyticsDb:
        opts.analyticsDue === undefined
          ? undefined
          : { dueAbsences: analyticsDueAbsences, deleteAbsentRecords },
      purgeAnnotationsFor,
      getMinObservations: () => 3,
      getMinAgeMs: () => DAY,
      log: createLogger("test:absence"),
      clock: () => NOW,
      batchSize: opts.batchSize ?? 200,
      deletionGraceMs: opts.deletionGraceMs ?? 0,
    },
    {} as Scheduler,
  );
  return {
    ...bundle,
    dueAbsences,
    staleAbsences,
    sweepDueAbsences,
    reclaimStaleAbsences,
    sweepArgs,
    sweepPriorities,
    acknowledgeAbsenceCascade,
    pendingAbsenceCascades,
    deleteChunksByDocuments,
    purgeAnnotationsFor,
    analyticsDueAbsences,
    deleteAbsentRecords,
    planAnalyticsSweep,
    recordAnalyticsSweepVerdict,
  };
}

describe("absence sweep", () => {
  test("asks only for absences whose corroboration and elapsed time are both spent", async () => {
    const h = harness();
    await h.task.run(undefined, context);
    expect(h.dueAbsences).toHaveBeenCalledWith({
      dueBefore: NOW - DAY,
      minObservations: 3,
      limit: 200,
    });
    expect(h.staleAbsences).toHaveBeenCalledWith(200);
    expect(h.staleAbsences.mock.invocationCallOrder[0]).toBeLessThan(
      h.dueAbsences.mock.invocationCallOrder[0]!,
    );
    expect(h.reclaimStaleAbsences).not.toHaveBeenCalled();
  });

  test("deletes a due absence and cascades what the writer actually removed", async () => {
    const h = harness({ due: [absence("note-2"), absence("note-3")] });
    await h.task.run(undefined, context);

    expect(h.sweepArgs[0]!.documentIds).toEqual(["doc-note-2", "doc-note-3"]);
    expect(h.deleteChunksByDocuments).toHaveBeenCalledWith(["doc-note-2", "doc-note-3"]);
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-2", "doc-note-3"]);
  });

  test("hands the writer the deadline to re-decide, rather than deciding for it", async () => {
    const h = harness({ due: [absence("note-2")] });
    await h.task.run(undefined, context);

    // The candidates were read off the writer, so a snapshot or a wipe can have
    // landed since. Passing the thresholds through is what lets the writer
    // re-decide inside the transaction that does the deleting.
    expect(h.sweepArgs[0]!.opts).toEqual({
      minObservations: 3,
      dueBefore: NOW - DAY,
      now: NOW,
    });
  });

  test("a candidate the writer found revoked takes no derived rows with it", async () => {
    const h = harness({
      due: [absence("note-2"), absence("note-3")],
      revoked: ["doc-note-2"],
    });
    await h.task.run(undefined, context);

    expect(h.deleteChunksByDocuments).toHaveBeenCalledWith(["doc-note-3"]);
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-3"]);
  });

  test("nothing is cascaded when the writer deletes nothing", async () => {
    const h = harness({ due: [absence("note-2")], revoked: ["doc-note-2"] });
    await h.task.run(undefined, context);

    expect(h.deleteChunksByDocuments).not.toHaveBeenCalled();
    expect(h.purgeAnnotationsFor).not.toHaveBeenCalled();
  });

  test("addresses candidates by document id, never by their source key", async () => {
    // A `(source, stream, external_id)` key can be re-created by a re-bootstrap
    // between the read and the write, and would then name a live row.
    const h = harness({
      due: [absence("a", "apple-notes"), absence("b", "things"), absence("c", "apple-notes")],
    });
    await h.task.run(undefined, context);
    expect(h.sweepArgs[0]!.documentIds).toEqual(["doc-a", "doc-b", "doc-c"]);
  });

  test("deletes at background priority even when kicked from a user request", async () => {
    const h = harness({ due: [absence("note-2")] });
    // A config edit kicks the periodic from inside a user-priority HTTP
    // request; the sweep must not inherit that and skip admission control.
    await runWithPriority("user", () => h.task.run(undefined, context));
    expect(h.sweepPriorities).toEqual(["background"]);
  });

  test("a full batch stays active so a backlog drains over ticks, never in one pass", async () => {
    const h = harness({ due: [absence("a"), absence("b")], batchSize: 2 });
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    // One tick asked for at most `batchSize` and stopped there.
    expect(h.dueAbsences).toHaveBeenCalledTimes(1);
    expect(h.dueAbsences).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  test("reports idle once nothing is due", async () => {
    const h = harness();
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(h.sweepDueAbsences).not.toHaveBeenCalled();
  });

  test("stays active while a full stale-generation reclaim batch may have a tail", async () => {
    const h = harness({ staleCount: 200 });
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
  });

  test("a failing tick stays active instead of backing off, and retries later", async () => {
    const h = harness();
    h.dueAbsences.mockRejectedValueOnce(new Error("io worker unavailable"));
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
  });

  test("retries a durable cascade before selecting another victim", async () => {
    const cascade: AbsenceCascade = {
      id: 42,
      documentIds: ["doc-note-2"],
      indexDone: false,
      cognitionDone: false,
    };
    const h = harness({ due: [absence("note-3")], pendingCascades: [cascade] });

    await h.task.run(undefined, context);

    expect(h.dueAbsences).not.toHaveBeenCalled();
    expect(h.deleteChunksByDocuments).toHaveBeenCalledWith(["doc-note-2"]);
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-2"]);
    expect(h.acknowledgeAbsenceCascade.mock.calls).toEqual([
      [42, "index"],
      [42, "cognition"],
    ]);
  });

  test("drains a crash-left cascade immediately while new deletions remain in startup grace", async () => {
    const cascade: AbsenceCascade = {
      id: 42,
      documentIds: ["doc-note-2"],
      indexDone: false,
      cognitionDone: false,
    };
    const h = harness({
      due: [absence("note-3")],
      pendingCascades: [cascade],
      deletionGraceMs: DAY,
    });

    expect(h.task.startDelayMs).toBe(0);
    await h.task.run(undefined, context);

    expect(h.deleteChunksByDocuments).toHaveBeenCalledWith(["doc-note-2"]);
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-2"]);
    expect(h.dueAbsences).not.toHaveBeenCalled();
  });

  test("startup grace stays on the active cadence so it does not overshoot into idle backoff", async () => {
    const h = harness({ due: [absence("note-3")], deletionGraceMs: DAY });

    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(h.dueAbsences).not.toHaveBeenCalled();
  });

  test("acknowledges the index part when this gateway has no index store", async () => {
    const cascade: AbsenceCascade = {
      id: 42,
      documentIds: ["doc-note-2"],
      indexDone: false,
      cognitionDone: false,
    };
    const h = harness({ pendingCascades: [cascade], withIndexGate: false });

    await h.task.run(undefined, context);

    expect(h.deleteChunksByDocuments).not.toHaveBeenCalled();
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-2"]);
    expect(h.acknowledgeAbsenceCascade.mock.calls).toEqual([
      [42, "index"],
      [42, "cognition"],
    ]);
  });

  test("a failed index cascade still completes cognition and remains active", async () => {
    const cascade: AbsenceCascade = {
      id: 42,
      documentIds: ["doc-note-2"],
      indexDone: false,
      cognitionDone: false,
    };
    const h = harness({ pendingCascades: [cascade] });
    h.deleteChunksByDocuments.mockRejectedValueOnce(new Error("index unavailable"));

    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(h.acknowledgeAbsenceCascade).toHaveBeenCalledWith(42, "cognition");
    expect(h.purgeAnnotationsFor).toHaveBeenCalledWith(["doc-note-2"]);
  });

  test("a failed durable cascade retries and converges on the next tick", async () => {
    const cascade: AbsenceCascade = {
      id: 42,
      documentIds: ["doc-note-2"],
      indexDone: false,
      cognitionDone: false,
    };
    const h = harness({ pendingCascades: [cascade] });
    h.deleteChunksByDocuments.mockRejectedValueOnce(new Error("index unavailable"));
    h.acknowledgeAbsenceCascade.mockImplementation(async (_id, part) => {
      if (part === "cognition") cascade.cognitionDone = true;
      if (part === "index") cascade.indexDone = true;
    });

    await h.task.run(undefined, context);
    await h.task.run(undefined, context);

    expect(h.deleteChunksByDocuments).toHaveBeenCalledTimes(2);
    expect(h.purgeAnnotationsFor).toHaveBeenCalledTimes(1);
    expect(h.acknowledgeAbsenceCascade.mock.calls).toEqual([
      [42, "cognition"],
      [42, "index"],
    ]);
  });

  test("the structured plane gets the same deadline on its own tick", async () => {
    const h = harness({
      due: [absence("note-2")],
      analyticsDue: [
        {
          markId: "mark-1",
          sourceId: "apple-health",
          tableName: "health_samples",
          streamId: "",
          keyColumn: "record_id",
          keyValue: "sample-1",
          observedBy: "",
          dueBefore: NOW - DAY,
          minObservations: 3,
        },
      ],
    });
    // Tick one sweeps documents, tick two sweeps analytics.
    await h.task.run(undefined, context);
    expect(h.analyticsDueAbsences).not.toHaveBeenCalled();
    await h.task.run(undefined, context);
    expect(h.analyticsDueAbsences).toHaveBeenCalledWith({
      dueBefore: NOW - DAY,
      minObservations: 3,
      limit: 200,
    });
    expect(h.deleteAbsentRecords).toHaveBeenCalledTimes(1);
  });

  test("a replicated source's rows are judged one by one; a dispute stays, and the members are reset once", async () => {
    const row = (sourceId: string, keyValue: string, observedBy: string): AnalyticsDue => ({
      markId: `mark-${keyValue}`,
      sourceId,
      tableName: "counters",
      streamId: "",
      keyColumn: "id",
      keyValue,
      observedBy,
      dueBefore: NOW - DAY,
      minObservations: 3,
    });
    const h = harness({
      analyticsDue: [
        row("notes:shared", "c-1", "alpha"),
        row("notes:shared", "c-2", "alpha"),
        row("steps:single", "s-1", ""),
      ],
      replicatedSources: ["notes:shared"],
      disputedRows: ["c-2"],
    });
    await h.task.run(undefined, context);
    await h.task.run(undefined, context);
    // The ledger is asked once about the whole batch, before any verdict.
    expect(h.planAnalyticsSweep).toHaveBeenCalledTimes(1);
    expect(h.planAnalyticsSweep.mock.calls[0]![0]).toEqual([
      { sourceId: "notes:shared", tableName: "counters", keyValue: "c-1" },
      { sourceId: "notes:shared", tableName: "counters", keyValue: "c-2" },
      { sourceId: "steps:single", tableName: "counters", keyValue: "s-1" },
    ]);
    // Only the replicated source's undisputed row records a verdict, with the
    // batch's one reset; the disputed row and the single-device source never
    // reach the writer.
    expect(h.recordAnalyticsSweepVerdict.mock.calls).toEqual([
      [
        {
          sourceId: "notes:shared",
          tableName: "counters",
          keyValue: "c-1",
          observedBy: "alpha",
          resetMembers: true,
        },
        NOW,
      ],
    ]);
  });

  test("one empty plane cannot back the other off while it still has a backlog", async () => {
    const h = harness({
      due: [absence("a"), absence("b")],
      batchSize: 2,
      analyticsDue: [],
    });
    // Documents: a full batch, so more may be waiting.
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    // Analytics: nothing due. The sweep as a whole is still not idle, or the
    // scheduler would rearm at the idle period and drain the document backlog
    // a batch every ten minutes instead of every five seconds.
    expect(await h.task.run(undefined, context)).toEqual({
      kind: "done",
      value: { idle: false },
    });
  });

  test("without an analytics DB every tick still sweeps documents", async () => {
    const h = harness({ due: [absence("note-2")] });
    await h.task.run(undefined, context);
    await h.task.run(undefined, context);
    // A phase that can never find work must not report idle every other tick
    // and back the whole sweep off while documents are still queued.
    expect(h.dueAbsences).toHaveBeenCalledTimes(2);
  });
});
