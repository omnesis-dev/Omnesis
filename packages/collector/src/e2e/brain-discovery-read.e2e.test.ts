// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  structuredData,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
let bench: BrainBench | undefined;
afterAll(async () => {
  await bench?.destroy();
}, 60_000);
const frontierSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      inputFingerprint: z.string(),
      source: z.object({ id: z.string(), contentTruncated: z.boolean().optional() }).optional(),
    }),
  ),
});

it("requires full source reads and both discovery phases before durably completing truncated input", async () => {
  const maintain = knowledgePuppet({ plan: preserveCurrentOwner });
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
      dynamic(ctx, steps) {
        if (ctx.flavour !== "synthesis.knowledge") return null;
        const latest = [...steps].reverse().find((step) => step.name === "knowledge_next_frontier");
        const frontier = frontierSchema.safeParse(latest ? structuredData(latest.result) : null);
        const item = frontier.success
          ? frontier.data.items.find((entry) => entry.source)
          : undefined;
        if (item?.source) {
          const attempts = steps.filter(
            (step) => step.name === "knowledge_discovery_complete" && step.args?.id === item.id,
          );
          if (!attempts.length)
            return {
              kind: "tool",
              name: "knowledge_discovery_complete",
              args: { id: item.id, inputFingerprint: item.inputFingerprint },
            };
          const fetched = steps.some(
            (step) =>
              step.name === "fetch_many" && JSON.stringify(step.args).includes(item.source!.id),
          );
          if (!fetched)
            return {
              kind: "tool",
              name: "fetch_many",
              args: { documents: [{ documentId: item.source.id }] },
            };
          if (attempts.length === 1)
            return {
              kind: "tool",
              name: "knowledge_discovery_complete",
              args: {
                id: item.id,
                inputFingerprint: item.inputFingerprint,
                phases: ["interpretation"],
              },
            };
        }
        // These two expected negative-path calls must not be treated as successful
        // settlement by the generic puppet. The next default completion uses both phases.
        const accepted = steps.filter(
          (step) =>
            !(
              step.name === "knowledge_discovery_complete" &&
              step.result &&
              typeof step.result === "object" &&
              "kind" in step.result &&
              step.result.kind === "error"
            ),
        );
        return maintain(ctx, accepted);
      },
    },
  });
  await bench.push(
    email({
      externalId: "long-reference-manual",
      title: "Community workshop reference manual",
      content: Array.from(
        { length: 240 },
        (_, i) =>
          `Reference section ${i + 1}: store the numbered materials in the matching labeled cabinet.`,
      ).join("\n"),
    }),
  );
  const sourceId = await bench.docId("long-reference-manual");
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
  const runIds = bench.sql
    .prepare<
      [string],
      { run_id: string }
    >("SELECT DISTINCT b.run_id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE w.subject_id=?")
    .all(sourceId);
  const executed = (
    await Promise.all(runIds.map((run) => bench!.obs.executedTools(run.run_id)))
  ).flat();
  const completions = executed.filter(
    (step) => step.tool === "knowledge_discovery_complete" && step.args.id === `source:${sourceId}`,
  );
  expect(completions).toHaveLength(3);
  expect(completions[0]!.result).toMatchObject({ kind: "error", code: "source_read_required" });
  expect(completions[1]!.result).toMatchObject({
    kind: "error",
    code: "claim_invalid",
    message: expect.stringContaining("organization still requires review"),
  });
  expect(completions[2]!.result).toMatchObject({ kind: "structured" });
  const fetchIndex = executed.findIndex((step) => step.tool === "fetch_many");
  expect(fetchIndex).toBeGreaterThan(executed.indexOf(completions[0]!));
  expect(fetchIndex).toBeLessThan(executed.indexOf(completions[1]!));
  expect(
    bench.sql
      .prepare(
        "SELECT phase,status FROM knowledge_discovery_coverage WHERE subject_id=? ORDER BY phase",
      )
      .all(sourceId),
  ).toEqual([
    { phase: "interpretation", status: "considered" },
    { phase: "organization", status: "considered" },
  ]);
  expect(
    bench.sql
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id=? AND status IN ('pending','batched')",
      )
      .get(sourceId),
  ).toEqual({ n: 0 });
}, 180_000);
