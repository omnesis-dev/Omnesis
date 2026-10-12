// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterEach, expect, it } from "vitest";
import { createDocAnnotation } from "@omnesis/gateway/src/brain/storage/annotations.js";
import { convertKnowledgeOwner } from "@omnesis/gateway/src/brain/knowledge/owner-adapters.js";
import { enqueueKnowledgeWork } from "@omnesis/gateway/src/brain/knowledge/work.js";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  sourceInterpretations,
  preserveCurrentOwner,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);

it("settles a retired canonical frontier before a model turn without losing its history or requeueing it", async () => {
  bench = await BrainBench.start({
    experimental: true,
    brain: { knowledge: { soonDelay: "1s", routineDelay: "1s" } },
    behaviors: {
      dynamic: sourceInterpretations({
        sources: [],
        maintainNode: (item, ctx, steps) => {
          if (item.id === "historical-schedule")
            throw new Error("Historical owner reached the model");
          return preserveCurrentOwner(item, ctx, steps);
        },
      }),
    },
  });
  const [sourceId] = await bench.pushAndSettle([
    email({
      externalId: "studio-class-day",
      title: "Community studio timetable",
      content: "The pottery class begins on Tuesday.",
    }),
  ]);
  const now = Date.now();
  // Seed a crash-recovery boundary: canonical retirement happened after the
  // mirror was created but before already-pending maintenance was consumed.
  bench.withWriteHandle((db) =>
    db.transaction(() => {
      createDocAnnotation(
        db,
        {
          id: "historical-schedule",
          docId: sourceId!,
          claimType: "class-day",
          claimText: "The pottery class begins on Tuesday.",
          evidenceDocId: sourceId!,
          evidenceQuote: "The pottery class begins on Tuesday.",
          confidence: 0.8,
          createdByRun: "fixture",
          claimBasis: "quoted",
        },
        now,
      );
      const node = convertKnowledgeOwner(db, "doc_annotation", "historical-schedule", now);
      db.prepare(
        "UPDATE doc_annotations SET invalidated_at=?,superseded_by='new-schedule' WHERE id='historical-schedule'",
      ).run(now);
      enqueueKnowledgeWork(
        db,
        {
          id: "historical-review",
          subjectId: "historical-schedule",
          subjectKind: "node",
          reason: "review",
          inputRevision: String(node.node.revision),
          tier: "immediate",
          dueAt: now,
        },
        now,
      );
    })(),
  );
  await waitFor(
    "historical work to settle",
    () => {
      const row = bench!.sql
        .prepare("SELECT status FROM knowledge_work WHERE id='historical-review'")
        .get() as { status: string } | undefined;
      return row?.status === "completed" ? true : null;
    },
    30_000,
  );
  await bench.drainUntilQuiet();
  expect(
    bench.sql
      .prepare(
        "SELECT invalidated_at,superseded_by FROM doc_annotations WHERE id='historical-schedule'",
      )
      .get(),
  ).toEqual({ invalidated_at: now, superseded_by: "new-schedule" });
  expect(
    bench.sql
      .prepare("SELECT status FROM knowledge_frontier WHERE node_id='historical-schedule'")
      .all(),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ status: "skipped" })]));
  expect(
    bench.sql
      .prepare(
        "SELECT 1 FROM knowledge_work WHERE subject_id='historical-schedule' AND status IN ('pending','batched')",
      )
      .all(),
  ).toEqual([]);
  const runs = bench.sql
    .prepare(
      `SELECT r.usage_json FROM cognition_runs r JOIN knowledge_batches b ON b.run_id=r.id JOIN knowledge_work w ON w.batch_id=b.id WHERE w.id='historical-review'`,
    )
    .all();
  expect(runs).toEqual([{ usage_json: null }]);
}, 90_000);
