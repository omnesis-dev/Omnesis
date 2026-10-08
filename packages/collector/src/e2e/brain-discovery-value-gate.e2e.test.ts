// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, afterEach, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterEach(async ({ task }) => {
  if (!bench || task.result?.state !== "fail") return;
  const runs = await bench.obs.runs({ limit: 20 });
  createLogger("test:discovery-gate").error(
    JSON.stringify({
      runs,
      work: bench.sql.prepare("SELECT * FROM knowledge_work").all(),
      calls: bench.puppetCalls.map((call) => ({ runId: call.runId, emitted: call.emitted })),
      tools: await Promise.all(
        runs.items.map(async (run) => ({
          id: run.id,
          tools: await bench!.obs.executedTools(run.id),
        })),
      ),
    }),
  );
});
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("gates before backend startup, preserves uncertain and oversized inputs, and revisits gated evidence", async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    clock: "virtual",
    entailment: "accept-all",
    judge: "hold-all",
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            const state = request.state as { source?: { title?: string } };
            return [
              key,
              {
                type: "score" as const,
                score:
                  key === "discovery"
                    ? state.source?.title === "Uncertain reference"
                      ? 1
                      : 0
                    : question.criteria.length - 1,
              },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      mergeAdjudication: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "0s", routineDelay: "0s", maxReviewInterval: "1h", maxSeeds: 1 },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan: (item, context, steps) =>
          item.source
            ? { calls: [call("fetch_many", { documents: [{ documentId: item.source.id }] })] }
            : preserveCurrentOwner(item, context, steps),
      }),
    },
  });
  function hasBackendRunForSource(id: string): boolean {
    const runs = bench!.sql
      .prepare<
        [string],
        { run_id: string }
      >("SELECT b.run_id FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id WHERE w.subject_id=?")
      .all(id);
    return runs.some((run) => bench!.puppetCalls.some((call) => call.runId === run.run_id));
  }
  await bench.clock.set(Date.parse("2027-01-11T12:00:00Z"));
  await bench.push(
    email({
      externalId: "routine-status",
      title: "Routine status",
      content: "The sample processing status remains unchanged.",
    }),
  );
  const lowId = await bench.docId("routine-status");
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare(
            "SELECT status,reconsider_at FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='interpretation'",
          )
          .get(lowId!),
      { timeout: 60_000 },
    )
    .toMatchObject({ status: "gated", reconsider_at: expect.any(Number) });
  const initialRuns = bench.sql
    .prepare<
      [string],
      { run_id: string }
    >("SELECT b.run_id FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id WHERE w.subject_id=?")
    .all(lowId!);
  expect(initialRuns.length).toBeGreaterThan(0);
  for (const run of initialRuns)
    expect(bench.puppetCalls.filter((call) => call.runId === run.run_id)).toEqual([]);
  const gatedAt = bench.sql
    .prepare<
      [string],
      { reconsider_at: number }
    >("SELECT reconsider_at FROM knowledge_discovery_coverage WHERE subject_id=? LIMIT 1")
    .get(lowId!)!.reconsider_at;
  expect(gatedAt).toBe(Date.parse("2027-01-11T13:00:00Z"));

  for (const doc of [
    email({
      externalId: "uncertain-reference",
      title: "Uncertain reference",
      content: "The workshop arrangement may have changed; its significance is unclear.",
    }),
    email({
      externalId: "long-reference",
      title: "Long reference",
      content: "Routine detail. ".repeat(1700) + "A new durable constraint appears at the end.",
    }),
  ]) {
    await bench.push(doc);
    const id = await bench.docId(doc.externalId);
    await expect
      .poll(
        () =>
          bench!.sql
            .prepare(
              "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='interpretation'",
            )
            .get(id!),
        { timeout: 60_000 },
      )
      .toEqual({ status: "considered" });
    expect(hasBackendRunForSource(id!)).toBe(true);
  }
  await bench.clock.set(gatedAt + 1);
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare(
            "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='interpretation'",
          )
          .get(lowId!),
      { timeout: 60_000 },
    )
    .toEqual({ status: "considered" });
  expect(hasBackendRunForSource(lowId!)).toBe(true);
}, 180_000);
