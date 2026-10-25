// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { enqueueKnowledgeWork } from "@omnesis/gateway/src/brain/knowledge/work.js";
import { readKnowledgeSourceRevision } from "@omnesis/gateway/src/brain/knowledge/source-revision.js";
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
      completionRequirements: z.object({ requiredPhases: z.array(z.string()) }).optional(),
      sourceRead: z.object({ status: z.string(), nextOffset: z.number().optional() }).optional(),
      source: z.object({ id: z.string(), contentTruncated: z.boolean().optional() }).optional(),
    }),
  ),
});

it("accepts complete paginated reads and requires both phases before durably completing truncated input", async () => {
  let coveredReview = false;
  const maintain = knowledgePuppet({ plan: preserveCurrentOwner });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
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
        if (item?.source && coveredReview) {
          expect(item.completionRequirements?.requiredPhases).toEqual([]);
          if (
            steps.findLastIndex((step) => step.name === "fetch_many") >
            steps.findLastIndex((step) => step.name === "knowledge_next_frontier")
          )
            return { kind: "tool", name: "knowledge_next_frontier", args: {} };
          const completion = steps.findLastIndex(
            (step) => step.name === "knowledge_discovery_complete",
          );
          if (completion > steps.findLastIndex((step) => step.name === "knowledge_next_frontier"))
            return { kind: "tool", name: "knowledge_next_frontier", args: {} };
          if (item.sourceRead?.status !== "complete")
            return {
              kind: "tool",
              name: "fetch_many",
              args: { documents: [{ documentId: item.source.id, maxContentChars: 65536 }] },
            };
          return {
            kind: "tool",
            name: "knowledge_discovery_complete",
            args: { id: item.id, inputFingerprint: item.inputFingerprint, phases: [] },
          };
        }
        if (item?.source) {
          expect(item.completionRequirements?.requiredPhases).toEqual([
            "interpretation",
            "organization",
          ]);
          const attempts = steps.filter(
            (step) => step.name === "knowledge_discovery_complete" && step.args?.id === item.id,
          );
          if (!attempts.length)
            return {
              kind: "tool",
              name: "knowledge_discovery_complete",
              args: { id: item.id, inputFingerprint: item.inputFingerprint },
            };
          const fetched = steps.filter(
            (step) =>
              step.name === "fetch_many" && JSON.stringify(step.args).includes(item.source!.id),
          );
          const lastFetch = steps.findLastIndex((step) => step.name === "fetch_many");
          const lastFrontier = steps.findLastIndex(
            (step) => step.name === "knowledge_next_frontier",
          );
          if (lastFetch > lastFrontier)
            return { kind: "tool", name: "knowledge_next_frontier", args: {} };
          expect(item.sourceRead).toEqual(
            fetched.length === 0
              ? { status: "required", nextOffset: 0 }
              : fetched.length === 1
                ? { status: "partial", nextOffset: 8192 }
                : { status: "complete" },
          );
          if (fetched.length < 2)
            return {
              kind: "tool",
              name: "fetch_many",
              args: {
                documents: [
                  {
                    documentId: item.source.id,
                    contentOffset: fetched.length ? 8192 : 0,
                    maxContentChars: fetched.length ? 65536 : 8192,
                  },
                ],
              },
            };
          if (attempts.length === 1 || attempts.length === 2)
            return {
              kind: "tool",
              name: "knowledge_discovery_complete",
              args: {
                id: item.id,
                inputFingerprint: item.inputFingerprint,
                phases: attempts.length === 1 ? [] : ["interpretation"],
              },
            };
        }
        // These expected negative-path calls must not be treated as successful
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
  expect(completions).toHaveLength(4);
  const offers = executed
    .filter((step) => step.tool === "knowledge_next_frontier")
    .flatMap((step) => {
      const parsed = frontierSchema.safeParse(structuredData(step.result));
      return parsed.success ? parsed.data.items : [];
    })
    .filter((item) => item.id === `source:${sourceId}`);
  expect(offers.length).toBeGreaterThan(0);
  expect(offers[0]!.completionRequirements?.requiredPhases).toEqual([
    "interpretation",
    "organization",
  ]);
  expect(completions[0]!.result).toMatchObject({ kind: "error", code: "source_read_required" });
  expect(completions[1]!.result).toMatchObject({
    kind: "error",
    code: "claim_invalid",
    message: expect.stringContaining("interpretation, organization still requires review"),
  });
  expect(completions[2]!.result).toMatchObject({
    kind: "error",
    code: "claim_invalid",
    message: expect.stringContaining("organization still requires review"),
  });
  expect(completions[3]!.result).toMatchObject({ kind: "structured" });
  const pageReads = executed.filter((step) => step.tool === "fetch_many");
  expect(pageReads).toHaveLength(2);
  expect(pageReads.map((step) => step.args)).toEqual([
    { documents: [{ documentId: sourceId, contentOffset: 0, maxContentChars: 8192 }] },
    { documents: [{ documentId: sourceId, contentOffset: 8192, maxContentChars: 65536 }] },
  ]);
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
  const priorCoverage = bench.sql
    .prepare("SELECT * FROM knowledge_discovery_coverage WHERE subject_id=? ORDER BY phase")
    .all(sourceId);
  coveredReview = true;
  bench.withWriteHandle((db) => {
    const now = Date.now();
    enqueueKnowledgeWork(
      db,
      {
        id: "covered-source-review",
        subjectId: sourceId,
        subjectKind: "source",
        reason: "review",
        inputRevision: readKnowledgeSourceRevision(db, sourceId)!,
        tier: "immediate",
        dueAt: now,
      },
      now,
    );
  });
  await expect
    .poll(
      () =>
        bench!.sql
          .prepare("SELECT status FROM knowledge_work WHERE id='covered-source-review'")
          .get(),
      { timeout: 90_000 },
    )
    .toEqual({ status: "completed" });
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 90_000 });
  const review = bench.sql
    .prepare<
      [],
      { run_id: string }
    >("SELECT b.run_id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE w.id='covered-source-review'")
    .get()!;
  const reviewTools = await bench.obs.executedTools(review.run_id);
  expect(reviewTools).toContainEqual(
    expect.objectContaining({
      tool: "knowledge_discovery_complete",
      args: expect.objectContaining({ id: `source:${sourceId}`, phases: [] }),
      result: expect.objectContaining({ kind: "structured" }),
    }),
  );
  expect(
    bench.sql
      .prepare("SELECT * FROM knowledge_discovery_coverage WHERE subject_id=? ORDER BY phase")
      .all(sourceId),
  ).toEqual(priorCoverage);
}, 180_000);
