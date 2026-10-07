// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  structuredData,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
const loopCount = 12;
const createdLoop = z.object({ loop: z.object({ id: z.string() }) });
let bench: BrainBench | undefined;

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("continues a paid maintenance batch beyond the tool cap without replaying settled frontiers", async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    judge: "hold-all",
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            return [
              key,
              { type: "score" as const, score: question.criteria.length - 1, confidence: 1 },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan(item, ctx, steps) {
          if (item.source)
            return {
              calls: Array.from({ length: loopCount }, (_, index) => {
                const title = `Prepare workshop station ${index + 1}`;
                return [
                  call("open_loop_search", { query: title }),
                  call("open_loop_create", {
                    title,
                    description: `${title} before the workshop opens.`,
                    docs: [item.source!.id],
                    confidence: 0.9,
                    importance: 0.5,
                  }),
                ];
              }).flat(),
            };
          const preserved = preserveCurrentOwner(item, ctx, steps);
          if (item.node?.kind !== "loop") return preserved;
          // Each owner is read alongside its evidence before its terminal save.
          // Together with discovery this is over 50 useful calls in one batch.
          return {
            calls: [
              call("knowledge_fetch", { id: item.id, editing: true }),
              ...Object.keys(item.inputVersions)
                .filter((ref) => ref.startsWith("source:"))
                .map((ref) => call("knowledge_reference", { ref })),
              ...preserved.calls,
            ],
          };
        },
        targets(_item, steps) {
          return steps.flatMap((step) => {
            if (step.name !== "open_loop_create") return [];
            const parsed = createdLoop.safeParse(structuredData(step.result));
            return parsed.success ? [parsed.data.loop.id] : [];
          });
        },
      }),
    },
  });
  await bench.push(
    email({
      externalId: "continuation-workshop-stations",
      title: "Workshop station preparation",
      content: Array.from(
        { length: loopCount },
        (_, index) => `Prepare workshop station ${index + 1} before the workshop opens.`,
      ).join("\n"),
    }),
  );
  const sourceId = await bench.docId("continuation-workshop-stations");
  // Intake can precede the first batch. Observe admission before asking whether
  // the due queue is quiet so this test cannot pass over future parked work.
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare("SELECT 1 FROM knowledge_work WHERE subject_id=? AND batch_id IS NOT NULL")
          .get(sourceId),
      { timeout: 60_000 },
    )
    .toBeDefined();
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const sourceBatch = bench.sql
    .prepare<[string], { batch_id: string; status: string }>(
      `SELECT w.batch_id,b.status FROM knowledge_work w
       JOIN knowledge_batches b ON b.id=w.batch_id
       WHERE w.subject_kind='source' AND w.subject_id=? ORDER BY w.created_at LIMIT 1`,
    )
    .get(sourceId)!;
  expect(sourceBatch.status).toBe("completed");
  const runs = (await bench.obs.runs({ kind: "synthesis" })).items.filter((run) => {
    const trigger = z.object({ batchId: z.string() }).safeParse(run.trigger);
    return trigger.success && trigger.data.batchId === sourceBatch.batch_id;
  });
  expect(runs.length).toBeGreaterThanOrEqual(2);
  for (const run of runs) {
    expect(run.status).toBe("completed");
    expect(run.usage?.promptTokens).toBeGreaterThan(0);
    expect(run.usage?.completionTokens).toBeGreaterThan(0);
    expect((await bench.obs.run(run.id)).transcripts.length).toBeGreaterThan(0);
  }
  const segments = await Promise.all(runs.map((run) => bench!.obs.executedTools(run.id)));
  const tools = segments.flat();
  expect(tools.length).toBeGreaterThan(50);
  expect(segments.every((segment) => segment.length <= 50)).toBe(true);
  const discoveries = tools.filter((step) => step.tool === "knowledge_discovery_complete");
  expect(discoveries).toHaveLength(1);
  expect(discoveries[0]!.args.targets).toHaveLength(loopCount);
  const saves = tools.filter((step) => step.tool === "knowledge_save");
  expect(saves).toHaveLength(loopCount);
  expect(new Set(saves.map((step) => step.args.inputFingerprint)).size).toBe(loopCount);
  expect((await bench.obs.loops()).items).toHaveLength(loopCount);
}, 180_000);
