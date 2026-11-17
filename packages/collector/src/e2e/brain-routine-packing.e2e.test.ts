// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unrelated routine source changes share one maintenance run, and the
 * discovery gate decides before that run's agent turn:
 *
 * - routine changes the gate scores low settle together with no agent turn;
 * - routine changes worth reading are interpreted by one run, not one each;
 * - while the decision model is unreachable, the batch waits for it instead
 *   of failing open into an agent turn, and runs once it answers;
 * - a source a failed batch left unfinished retries alone, while what the
 *   batch finished stays finished.
 *
 * The scripted decision model scores urgency routine for everything and
 * discovery low only for the notices; the bench checks what the engine does
 * with those verdicts, not their quality. Fixture data is invented.
 */

import "./synth-env.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  sleep,
  waitFor,
  type BenchDoc,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";

compressCognitionCadences();
const MINUTE = 60_000;
const ROUTINE_DELAY = 6 * 60 * MINUTE;
const NOTICE = "Locker reminder:";

const mail = (externalId: string, title: string, content: string) =>
  email({ externalId, title, content });
const notices = ["a", "b", "c"].map((n) =>
  mail(
    `notice-${n}`,
    `${NOTICE} locker ${n} renews`,
    `Automated reminder: gym locker ${n} renews on the first of the month as usual.`,
  ),
);
const worth = [
  mail("plan-kiln", "Kiln shelf order", "Maya ordered two new kiln shelves for the studio."),
  mail("plan-choir", "Choir rehearsal moved", "Choir rehearsal moves to Wednesdays from May."),
  mail("plan-garden", "Allotment plot assigned", "Jamie was assigned allotment plot 14."),
];
const outage = [
  mail("hold-bike", "Bike fitting booked", "A bike fitting is booked for Saturday morning."),
  mail("hold-flat", "Flat inspection notice", "The landlord inspects the flat next Tuesday."),
];
const failing = [
  mail("fail-steady", "Pottery class roster", "The evening pottery class has nine students."),
  mail("fail-stubborn", "Glaze inventory list", "The studio stocks thirty stoneware glazes."),
  mail("fail-sibling", "Studio key handover", "David hands over the studio keys on Friday."),
];
/** The model leaves this source unfinished while true. */
let stubborn = false;
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
            const title = (request.state as { source?: { title?: string } }).source?.title ?? "";
            const top = question.criteria.length - 1;
            const score =
              key === "urgency" || (key === "discovery" && title.startsWith(NOTICE)) ? 0 : top;
            return [key, { type: "score" as const, score, confidence: 1 }];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: {
        soonDelay: "30m",
        routineDelay: "6h",
        retryBackoff: "10m",
        retryBackoffCap: "15m",
        maxFailedAttempts: 3,
      },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        plan: () => ({ calls: [] }),
        leavePending: (item) => stubborn && item.source?.title === failing[1]!.title,
      }),
    },
  });
  await bench.drainUntilQuiet();
}, 300_000);

afterAll(async () => {
  await bench?.destroy();
}, 60_000);

interface WorkRow {
  status: string;
  failures: number;
  dueAt: number;
  batchId: string | null;
}
/**
 * A source's latest change work. Advancing the virtual clock past the retry
 * backoff also makes an interpreted source's review due; that is other work.
 */
const latestWork = (docId: string): WorkRow | undefined =>
  bench.sql
    .prepare<[string], WorkRow>(
      `SELECT status,failures,due_at AS dueAt,batch_id AS batchId FROM knowledge_work
      WHERE subject_kind='source' AND subject_id=? AND reason='change'
      ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    )
    .get(docId);
const batchSize = (batchId: string): number =>
  bench.sql
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM knowledge_work WHERE batch_id=?",
    )
    .get(batchId)!.count;
const runOf = (batchId: string) =>
  bench.sql
    .prepare<
      [string],
      { id: string; status: string; lastError: string | null; nextAttemptAt: number }
    >(
      `SELECT r.id,r.status,r.last_error AS lastError,r.next_attempt_at AS nextAttemptAt
      FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id WHERE b.id=?`,
    )
    .get(batchId)!;

/** Push routine changes, then move past their routine delay so they plan together. */
async function pushDue(docs: readonly BenchDoc[]): Promise<string[]> {
  await bench.pushAll(docs);
  await bench.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const ids = await Promise.all(docs.map((doc) => bench.docId(doc.externalId)));
  for (const id of ids) expect(latestWork(id)).toMatchObject({ status: "pending", failures: 0 });
  await bench.clock.advance(ROUTINE_DELAY + MINUTE);
  return ids;
}
const sharedBatch = (ids: readonly string[]) =>
  waitFor("the routine changes to share one batch", () => {
    const batches = new Set(ids.map((id) => latestWork(id)?.batchId));
    const [batch] = batches;
    return batches.size === 1 && batch ? batch : null;
  });
const allCompleted = (ids: readonly string[]) =>
  waitFor("every routine change to complete", () =>
    ids.every((id) => latestWork(id)?.status === "completed") ? true : null,
  );

it("settles routine changes the gate scores low together, with no agent turn", async () => {
  const ids = await pushDue(notices);
  const batch = await sharedBatch(ids);
  expect(batchSize(batch)).toBe(ids.length);
  await allCompleted(ids);
  for (const id of ids) {
    expect(
      bench.sql
        .prepare("SELECT DISTINCT status FROM knowledge_discovery_coverage WHERE subject_id=?")
        .all(id),
    ).toEqual([{ status: "gated" }]);
    expect(await bench.obs.runsForSource(id)).toEqual([]);
  }
}, 300_000);

it("interprets unrelated routine changes in one run", async () => {
  const ids = await pushDue(worth);
  const batch = await sharedBatch(ids);
  expect(batchSize(batch)).toBe(ids.length);
  await allCompleted(ids);
  const runs = await Promise.all(ids.map((id) => bench.obs.runsForSource(id)));
  for (const found of runs) expect(found.map((run) => run.id)).toEqual([runOf(batch).id]);
}, 300_000);

it("holds a routine batch while the decision model is unreachable, then runs it once", async () => {
  bench.decision.refuseWith(529);
  try {
    const ids = await pushDue(outage);
    const batch = await sharedBatch(ids);
    const held = await waitFor("the batch to wait for the decision model", () => {
      const run = runOf(batch);
      return run.status === "pending" && run.lastError?.includes("decision model") ? run : null;
    });
    const { now } = await bench.clock.now();
    expect(held.nextAttemptAt).toBeGreaterThan(now);
    // No agent turn interpreted either source while it waited.
    await sleep(1_500);
    for (const id of ids) {
      expect(latestWork(id)).toMatchObject({ status: "batched", batchId: batch });
      expect(await bench.obs.runsForSource(id)).toEqual([]);
    }
  } finally {
    bench.decision.refuseWith(null);
  }
  const ids = await Promise.all(outage.map((doc) => bench.docId(doc.externalId)));
  const batch = latestWork(ids[0]!)!.batchId!;
  await bench.clock.set(runOf(batch).nextAttemptAt + 10);
  await allCompleted(ids);
  for (const id of ids)
    expect((await bench.obs.runsForSource(id)).map((run) => run.id)).toEqual([runOf(batch).id]);
}, 300_000);

it("retries a source a failed pack left unfinished alone", async () => {
  stubborn = true;
  const ids = await pushDue(failing);
  const [steadyId, stubbornId, siblingId] = ids as [string, string, string];
  const batch = await sharedBatch(ids);
  expect(batchSize(batch)).toBe(3);
  // Walk the run through its attempts until the engine abandons the batch.
  await waitFor(
    "the pack to be abandoned",
    async () => {
      const row = bench.sql
        .prepare<[string], { status: string }>("SELECT status FROM knowledge_batches WHERE id=?")
        .get(batch);
      if (row?.status === "abandoned") return true;
      const run = runOf(batch);
      const { now } = await bench.clock.now();
      if (run.status === "pending" && run.lastError && run.nextAttemptAt > now)
        await bench.clock.set(run.nextAttemptAt + 10);
      return null;
    },
    180_000,
    200,
  );
  // What the pack finished stays finished; only the unfinished source retries.
  for (const id of [steadyId, siblingId])
    expect(latestWork(id)).toMatchObject({ status: "completed", failures: 0 });
  const retry = latestWork(stubbornId)!;
  expect(retry).toMatchObject({ status: "pending", failures: 1 });
  stubborn = false;
  await bench.clock.set(retry.dueAt);
  const retryBatch = await waitFor(
    "the isolated retry",
    () => latestWork(stubbornId)?.batchId ?? null,
  );
  expect(retryBatch).not.toBe(batch);
  expect(batchSize(retryBatch)).toBe(1);
  await allCompleted([stubbornId]);
}, 600_000);
