// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Knowledge maintenance that one run cannot finish.
 *
 * A joint organization batch holds three sources. The model works two of them
 * and leaves the third pending on every attempt, as it does with an input it
 * judges too large for the run. The batch's run exhausts its attempts and the
 * batch is abandoned. What the batch finished must stay finished, unrelated
 * evidence must keep flowing, and the unfinished source must retry alone on a
 * growing delay, then park until its document changes.
 */

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  sleep,
  waitFor,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
const MINUTE = 60_000;
const steady = email({
  externalId: "retry-steady",
  title: "Kiln firing schedule",
  content: "The kiln fires on Thursday evenings after the studio closes.",
});
const heavy = email({
  externalId: "retry-heavy",
  title: "Glaze supplier catalogue",
  content: "The glaze supplier catalogue lists forty stoneware glazes and their firing ranges.",
});
const sibling = email({
  externalId: "retry-sibling",
  title: "Studio membership renewal",
  content: "Studio memberships renew at the start of each quarter.",
});
const unrelated = email({
  externalId: "retry-unrelated",
  title: "Bicycle repair appointment",
  content: "The bicycle repair shop confirmed an appointment for Saturday morning.",
});
/** The model leaves this source's first revision unfinished once the cohort forms. */
let heavyIsStubborn = false;
let bench: BrainBench;

beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    clock: "virtual",
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
      knowledge: {
        soonDelay: "0s",
        routineDelay: "6h",
        retryBackoff: "10m",
        retryBackoffCap: "15m",
        maxFailedAttempts: 3,
      },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan: () => ({ calls: [] }),
        leavePending: (item) =>
          heavyIsStubborn &&
          item.source?.title === heavy.title &&
          !item.source.content.startsWith("Revised"),
      }),
    },
  });
  await bench.drainUntilQuiet();
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

interface WorkRow {
  id: string;
  reason: string;
  status: string;
  failures: number;
  dueAt: number;
  lastError: string | null;
  batchId: string | null;
  inputRevision: string;
}
const workFor = (docId: string): WorkRow[] =>
  bench.sql
    .prepare<[string], WorkRow>(
      `SELECT id,reason,status,failures,due_at AS dueAt,last_error AS lastError,batch_id AS batchId,
      input_revision AS inputRevision FROM knowledge_work WHERE subject_kind='source' AND subject_id=?
      ORDER BY created_at,rowid`,
    )
    .all(docId);
const latestWork = (docId: string): WorkRow => workFor(docId).at(-1)!;
const batchSize = (batchId: string): number =>
  bench.sql
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM knowledge_work WHERE batch_id=?",
    )
    .get(batchId)!.count;

/** Walk the batch's run through its retry delays until the engine abandons it. */
async function failOut(batchId: string): Promise<number> {
  return waitFor(
    () =>
      `batch ${batchId} to be abandoned: ${JSON.stringify(
        bench.sql
          .prepare(
            "SELECT b.status,r.status AS run,r.attempts,r.next_attempt_at FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id WHERE b.id=?",
          )
          .get(batchId),
      )}`,
    async () => {
      const row = bench.sql
        .prepare<
          [string],
          {
            status: string;
            finishedAt: number | null;
            run: string;
            attempts: number;
            lastError: string | null;
            nextAttemptAt: number;
          }
        >(
          `SELECT b.status,b.finished_at AS finishedAt,r.status AS run,r.attempts,r.last_error AS lastError,
          r.next_attempt_at AS nextAttemptAt FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id WHERE b.id=?`,
        )
        .get(batchId);
      if (row?.status === "abandoned") return row.finishedAt!;
      const { now } = await bench.clock.now();
      if (row?.run === "pending" && row.attempts > 0 && row.lastError && row.nextAttemptAt > now)
        await bench.clock.set(row.nextAttemptAt + 10);
      return null;
    },
    180_000,
    200,
  );
}

it("keeps a failed batch's progress, isolates and backs off its unfinished source, parks it, and resumes on a new revision", async () => {
  // Phase 1: each source is interpreted on its own. The frozen clock holds
  // joint organization until all three are considered.
  await bench.pushAll([steady, heavy, sibling]);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const [steadyId, heavyId, siblingId] = await Promise.all(
    [steady, heavy, sibling].map((doc) => bench.docId(doc.externalId)),
  );
  for (const id of [steadyId, heavyId, siblingId])
    expect(workFor(id).map((row) => row.status)).toEqual(["completed"]);

  // Phase 2: the three sources form one joint batch the model cannot finish.
  heavyIsStubborn = true;
  await bench.clock.advance(MINUTE + 1_000);
  const cohortBatch = await waitFor(
    "the joint organization batch",
    () => {
      const row = latestWork(heavyId);
      return row.reason === "review" && row.batchId ? row.batchId : null;
    },
    60_000,
  );
  expect(batchSize(cohortBatch)).toBe(3);
  const failedAt = await failOut(cohortBatch);

  // What the batch finished stays finished: no second read of the settled sources.
  for (const id of [steadyId, siblingId]) {
    expect(workFor(id).map((row) => row.status)).toEqual(["completed", "completed"]);
  }
  expect(latestWork(heavyId)).toMatchObject({
    status: "pending",
    reason: "review",
    failures: 1,
    dueAt: failedAt + 10 * MINUTE,
  });

  // Unrelated evidence completes while the unfinished source backs off.
  await bench.push(unrelated);
  const unrelatedId = await bench.docId(unrelated.externalId);
  await waitFor("unrelated evidence to complete", () =>
    workFor(unrelatedId).some((row) => row.status === "completed") ? true : null,
  );
  await sleep(1_500);
  expect(latestWork(heavyId)).toMatchObject({ status: "pending", failures: 1 });

  // The retry runs alone once due, fails again and backs off further (capped).
  await bench.clock.set(failedAt + 10 * MINUTE);
  const retryBatch = await waitFor("the isolated retry batch", () => latestWork(heavyId).batchId);
  expect(batchSize(retryBatch)).toBe(1);
  const secondFailure = await failOut(retryBatch);
  expect(latestWork(heavyId)).toMatchObject({
    status: "pending",
    failures: 2,
    dueAt: secondFailure + 15 * MINUTE,
  });

  // The third failure reaches the cap: the work parks instead of retrying.
  await bench.clock.set(secondFailure + 15 * MINUTE);
  const lastBatch = await waitFor("the final retry batch", () => {
    const row = latestWork(heavyId);
    return row.batchId && row.batchId !== retryBatch ? row.batchId : null;
  });
  expect(batchSize(lastBatch)).toBe(1);
  await failOut(lastBatch);
  const parked = latestWork(heavyId);
  expect(parked).toMatchObject({ status: "deferred", failures: 3, lastError: "parked" });

  // Parked work is visible on the operator surfaces, not silently dropped.
  const status = await bench.harness.gatewayJson<{
    parked: Array<{ subjectKind: string; reason: string; tier: string; count: number }>;
  }>("/admin/brain/knowledge/status");
  const group = status.parked.find((row) => row.subjectKind === "source");
  expect(group).toMatchObject({ reason: "review", count: 1 });
  const listed = await bench.harness.gatewayJson<{ items: Array<{ nodeId: string }> }>(
    `/admin/brain/knowledge/pending-work?reason=review&tier=${group!.tier}&readiness=parked`,
  );
  expect(listed.items.map((item) => item.nodeId)).toEqual([`source:${heavyId}`]);

  // Nothing re-admits the parked revision, however much time passes.
  await bench.clock.advance(2 * 60 * MINUTE);
  await sleep(2_000);
  expect(latestWork(heavyId).id).toBe(parked.id);

  // A new revision of the document is ordinary fresh work, and completes.
  await bench.update(heavy, `Revised: ${heavy.content} Two new glazes were added.`);
  await waitFor("the new revision to complete", () => {
    const row = latestWork(heavyId);
    return row.inputRevision !== parked.inputRevision && row.status === "completed" ? row : null;
  });
  expect(latestWork(heavyId)).toMatchObject({ failures: 0, lastError: null });
  const after = await bench.harness.gatewayJson<{ parked: unknown[] }>(
    "/admin/brain/knowledge/status",
  );
  expect(after.parked).toEqual([]);
}, 600_000);
