// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterEach, expect, it } from "vitest";
import { createOpenLoop } from "@omnesis/gateway/src/brain/storage/open-loops.js";
import { reconcileKnowledgeOwner } from "@omnesis/gateway/src/brain/knowledge/owner-sync.js";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  waitFor,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async () => {
  await bench?.destroy();
}, 60_000);

it("hands a newly discovered locked owner back to the planner without repeating the model turn", async () => {
  const title = "Arrange the community exhibit";
  const description = "Prepare the exhibit inventory.";
  const loopId = "loop-exhibit-admission";
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "1s" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, ctx, steps) {
          if (!item.source) return preserveCurrentOwner(item, ctx, steps);
          return {
            calls: [
              call("fetch_many", { documents: [{ documentId: item.source.id }] }),
              call("open_loop_fetch", { id: loopId }),
              call("open_loop_update", { id: loopId, description, docs: [item.source.id] }),
            ],
          };
        },
      }),
    },
  });
  // A durable region owner is the scheduling stimulus. Discovery still enters
  // through ingestion and runs the actual model seam, tools and writer worker.
  // Reserve the writer before nested owner reconciliation reads the seed: a
  // deferred read-to-write WAL upgrade can lose to the live gateway writer.
  bench.withWriteHandle((db) =>
    db
      .transaction(() => {
        createOpenLoop(
          db,
          { id: loopId, title, createdByRun: "fixture", confidence: 0.8, importance: 0.5 },
          Date.now(),
        );
        reconcileKnowledgeOwner(db, "loop", loopId, Date.now());
        db.prepare(
          "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('existing-owner','existing-run','existing-region','routine','running',?,?)",
        ).run(Date.now(), Date.now());
        // A batch without a live queue owner is deliberately recovered as orphaned.
        // Keep this competing owner parked until the test explicitly releases it.
        db.prepare(
          "INSERT INTO cognition_runs(id,kind,payload_json,dedupe_key,status,attempts,next_attempt_at,enqueued_at) VALUES('existing-run','synthesis',?,'fixture:existing-owner','pending',0,?,?)",
        ).run(
          JSON.stringify({ focus: "knowledge-maintenance", batchId: "existing-owner" }),
          Date.now() + 86_400_000,
          Date.now(),
        );
        db.prepare("INSERT INTO knowledge_batch_regions VALUES('existing-owner',?)").run(loopId);
      })
      .immediate(),
  );
  await bench.push(
    email({
      externalId: "exhibit-admission",
      title: "Community exhibit preparation",
      content: description,
    }),
  );
  const sourceId = await bench.docId("exhibit-admission");
  const handedOff = await waitFor(
    "discovery cooperatively hands off its source",
    () =>
      bench!.sql
        .prepare<
          [string],
          { id: string; run_id: string }
        >("SELECT b.id,b.run_id FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id WHERE b.status='abandoned' AND w.subject_id=? LIMIT 1")
        .get(sourceId) ?? null,
    60_000,
  );
  await waitFor(
    "handed-off run settles without retry",
    () =>
      bench!.sql
        .prepare("SELECT 1 FROM cognition_runs WHERE id=? AND status='completed'")
        .get(handedOff.run_id) ?? null,
    30_000,
  );
  const calls = await bench.obs.executedTools(handedOff.run_id);
  expect(calls.filter((step) => step.tool === "open_loop_update")).toHaveLength(1);
  expect(calls.find((step) => step.tool === "open_loop_update")?.result).toMatchObject({
    kind: "error",
    code: "maintenance_handoff",
  });
  expect(bench.sql.prepare("SELECT description FROM open_loops WHERE id=?").get(loopId)).toEqual({
    description: "",
  });
  expect(
    bench.sql.prepare("SELECT attempts FROM cognition_runs WHERE id=?").get(handedOff.run_id),
  ).toEqual({ attempts: 1 });
  expect(
    bench.sql
      .prepare("SELECT node_id FROM knowledge_discovery_targets WHERE source_id=?")
      .all(sourceId),
  ).toEqual([{ node_id: loopId }]);
  expect(
    bench.sql
      .prepare("SELECT input_revision FROM knowledge_work WHERE subject_id=? AND status='pending'")
      .get(sourceId),
  ).toBeDefined();
  bench.withWriteHandle((db) =>
    db.transaction(() => {
      db.prepare(
        "UPDATE knowledge_batches SET status='completed',finished_at=? WHERE id='existing-owner'",
      ).run(Date.now());
      db.prepare(
        "UPDATE cognition_runs SET status='completed',completed_at=? WHERE id='existing-run'",
      ).run(Date.now());
    })(),
  );
  await bench.drainUntilQuiet();
  expect(bench.sql.prepare("SELECT description FROM open_loops WHERE id=?").get(loopId)).toEqual({
    description,
  });
  expect((await bench.obs.pulse()).counts.failedRuns24h).toBe(0);
}, 180_000);
