// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deleting a source document never deletes what the Brain built on it. A
 * maintenance run turns one email into a tracked loop, which the owner accepts
 * into their Tasks, and a document annotation. The collector then tombstones
 * the email through the real sync route. The email is gone for good, but the
 * task stays in the journal and the annotation stays in memory: each loses
 * its link to the email, is marked stale and is queued for review. A
 * maintenance run then reviews both and decides deliberately: it keeps the
 * task and retracts the annotation.
 *
 * Fixture data is invented — no corpus content.
 */

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  keepReviewedOwner,
  preserveCurrentOwner,
  ref,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();

const SOURCE = "synthetic:test@example.com";
const INVOICE = email({
  externalId: "plumber-invoice",
  title: "Invoice from the plumbing firm",
  content:
    "Hello,\n\nThe invoice for the boiler repair is attached. Please pay 180 by Friday.\n\nThe plumbing team",
});
const QUOTE = "Please pay 180 by Friday.";
const CLAIM = "The plumbing firm billed 180 for the boiler repair.";
const TASK = "Pay the plumbing firm invoice";

let bench: BrainBench;
let invoiceDeleted = false;
let loopId = "";
let annotationId = "";
let invoiceDocId = "";

const maintain = knowledgePuppet({
  plan(item, ctx, steps) {
    if (item.source) {
      if (invoiceDeleted || item.source.title !== INVOICE.title) return { calls: [] };
      // A later review of the same source must not record it twice.
      if (
        bench.sql.prepare("SELECT 1 FROM open_loops WHERE title = ?").get(TASK) &&
        !steps.some((step) => step.name === "open_loop_create")
      )
        return { calls: [] };
      return {
        calls: [
          call("open_loop_search", { query: "the plumbing firm invoice" }),
          call("open_loop_create", {
            title: TASK,
            description: "180 for the boiler repair, due Friday.",
            confidence: 0.9,
            importance: 0.7,
            docs: [item.source.id],
          }),
          call("open_loop_fetch", { id: ref("open_loop_create", "loop.id") }),
          call("annotation_search", { docId: item.source.id }),
          call("annotate_durable", {
            docId: item.source.id,
            claimType: "billing",
            claimText: CLAIM,
            evidenceDocId: item.source.id,
            evidenceQuote: QUOTE,
            confidence: 0.8,
            claimBasis: "inferred",
          }),
        ],
      };
    }
    const node = item.node;
    if (invoiceDeleted && node && node.validity === "stale") {
      // The reviewed decisions: the task still matters, the annotation about
      // the deleted email no longer has anything to stand on.
      if (item.id === loopId) return keepReviewedOwner(item, ctx, steps);
      if (item.id === annotationId)
        return {
          calls: [
            call("annotation_search", { docId: invoiceDocId }),
            call("annotation_retract", { id: annotationId }),
            call("knowledge_next_frontier", {}),
          ],
        };
    }
    return preserveCurrentOwner(item, ctx, steps);
  },
});

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    gatewayLogLevel: "info",
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
      workerConcurrency: 1,
      knowledge: { soonDelay: "1s", routineDelay: "1s" },
    },
    behaviors: { dynamic: maintain },
  });
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

it("keeps the task and annotation built on a tombstoned email, and a review decides their fate", async () => {
  await bench.push(INVOICE);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const invoiceId = await bench.docId(INVOICE.externalId);
  invoiceDocId = invoiceId;
  const runs = await bench.obs.runs({ kind: "synthesis", limit: 20 });
  const recorded = await Promise.all(runs.items.map((run) => bench.obs.executedTools(run.id)));
  loopId =
    bench.sql
      .prepare<[string], { id: string }>("SELECT id FROM open_loops WHERE title = ?")
      .get(TASK)?.id ?? "";
  annotationId =
    bench.sql
      .prepare<[string], { id: string }>("SELECT id FROM doc_annotations WHERE claim_text = ?")
      .get(CLAIM)?.id ?? "";
  expect({ loopId, annotationId }, JSON.stringify(recorded).slice(0, 4000)).toEqual({
    loopId: expect.stringMatching(/./),
    annotationId: expect.stringMatching(/./),
  });

  // The owner accepts the suggestion into their Tasks.
  expect((await bench.obs.taskAction(loopId, { action: "accept" })).status).toBe(200);
  expect((await bench.obs.task(loopId)).task.id).toBe(loopId);

  // The collector reports the email gone upstream: the real sync tombstone route.
  invoiceDeleted = true;
  const { wipeEpoch } = await bench.harness.gatewayJson<{ wipeEpoch: number }>(
    `/sync-state/${encodeURIComponent(SOURCE)}`,
  );
  const deleted = await bench.harness.gatewayJson<{ deleted: number }>("/documents/delete", {
    method: "POST",
    body: JSON.stringify({
      providerId: SOURCE,
      sourceId: SOURCE,
      externalIds: [INVOICE.externalId],
      writeEpoch: wipeEpoch,
    }),
  });
  expect(deleted.deleted).toBe(1);

  // The email is gone for good: unreadable and uncitable.
  expect(bench.sql.prepare("SELECT 1 FROM documents WHERE id = ?").get(invoiceId)).toBeUndefined();
  expect(
    bench.sql
      .prepare("SELECT deleted FROM knowledge_source_revisions WHERE document_id = ?")
      .get(invoiceId),
  ).toEqual({ deleted: 1 });

  // The task is still in the journal, unchanged but for its link to the email.
  expect((await bench.obs.task(loopId)).task).toMatchObject({
    id: loopId,
    title: TASK,
  });
  expect(
    bench.sql
      .prepare<[string], { state: string; accepted: number }>(
        "SELECT state, accepted FROM open_loops WHERE id = ?",
      )
      .get(loopId),
  ).toEqual({ state: "open", accepted: 1 });
  expect(bench.sql.prepare("SELECT 1 FROM open_loop_docs WHERE loop_id = ?").get(loopId)).toBe(
    undefined,
  );
  expect(
    bench.sql
      .prepare<[string], { note: string }>(
        "SELECT note FROM open_loop_ledger WHERE loop_id = ? AND run_id = 'source-deletion'",
      )
      .all(loopId),
  ).toEqual([
    { note: `Source document ${invoiceId} was deleted. The loop is kept and queued for review.` },
  ]);

  // The annotation is still in memory, marked unverified, its evidence broken.
  expect(
    bench.sql
      .prepare<[string], { invalidated_at: number | null; verification_state: string }>(
        "SELECT invalidated_at, verification_state FROM doc_annotations WHERE id = ?",
      )
      .get(annotationId),
  ).toEqual({ invalidated_at: null, verification_state: "unverified" });

  // Both owners' knowledge nodes turn stale and are queued for maintenance;
  // neither was erased.
  for (const id of [loopId, annotationId])
    await expect
      .poll(
        () =>
          bench.sql
            .prepare<[string], { validity: string }>(
              "SELECT validity FROM knowledge_nodes WHERE id = ?",
            )
            .get(id)?.validity,
        { timeout: 60_000 },
      )
      .toBe("stale");
  expect(
    bench.sql
      .prepare("SELECT 1 FROM knowledge_node_tombstones WHERE id IN (?, ?)")
      .get(loopId, annotationId),
  ).toBeUndefined();

  // A maintenance run reviews both and decides: keep the task, retract the annotation.
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 180_000 });
  const reviewRuns = await bench.obs.runs({ kind: "synthesis", limit: 20 });
  const reviewTools = await Promise.all(
    reviewRuns.items.map(async (run) =>
      (await bench.obs.executedTools(run.id)).map((step) => ({
        tool: step.tool,
        args: step.args,
        kind: step.result?.kind,
        code: step.result?.code,
      })),
    ),
  );
  expect(
    bench.sql.prepare("SELECT 1 FROM doc_annotations WHERE id = ?").get(annotationId),
    JSON.stringify({
      work: bench.sql
        .prepare(
          "SELECT subject_id, status, reason, last_error FROM knowledge_work WHERE subject_id IN (?, ?)",
        )
        .all(loopId, annotationId),
      reviewTools,
    }).slice(0, 6000),
  ).toBeUndefined();
  await expect
    .poll(
      () =>
        bench.sql
          .prepare<[string], { validity: string }>(
            "SELECT validity FROM knowledge_nodes WHERE id = ?",
          )
          .get(loopId)?.validity,
      { timeout: 120_000 },
    )
    .toBe("current");
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });

  const review = bench.sql
    .prepare<[string], { run_id: string }>(
      `SELECT b.run_id FROM knowledge_work w JOIN knowledge_batches b ON w.batch_id = b.id
        WHERE w.subject_id = ? ORDER BY b.created_at DESC LIMIT 1`,
    )
    .get(annotationId)!;
  const steps = await bench.obs.executedTools(review.run_id);
  expect(steps.filter((step) => step.tool === "annotation_retract")).toEqual([
    expect.objectContaining({ result: expect.objectContaining({ kind: "structured" }) }),
  ]);

  // The task survives the review in the journal.
  expect((await bench.obs.task(loopId)).task.id).toBe(loopId);
  expect(
    bench.sql
      .prepare<[string], { state: string }>("SELECT state FROM open_loops WHERE id = ?")
      .get(loopId),
  ).toEqual({ state: "open" });
  expect(
    bench.sql
      .prepare("SELECT 1 FROM knowledge_work WHERE subject_id IN (?, ?) AND status = 'pending'")
      .get(loopId, annotationId),
  ).toBeUndefined();
}, 300_000);
