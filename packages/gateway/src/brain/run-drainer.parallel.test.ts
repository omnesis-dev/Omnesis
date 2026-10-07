// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { createCognitionDrainerTasks } from "./run-drainer.js";
import { getCognitionRun } from "./storage/run-queue.js";
import type { CognitionRunDriver, CognitionRunOutcome } from "./run-driver.js";
import type { FsCognitionTranscriptStore } from "./transcripts.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { TaskContext } from "../scheduler/types.js";
import type { ClaimedCognitionRun } from "./storage/types.js";

const log = createLogger("test:parallel-drain");
const success: CognitionRunOutcome = {
  ok: true,
  modelId: null,
  usage: null,
  finalText: "",
  citations: [],
  openedDocIds: [],
};
let db: ReturnType<typeof createDatabase>;
let gate: ReturnType<typeof directWriteGate>;
beforeEach(() => {
  db = createDatabase(":memory:");
  gate = directWriteGate(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

async function enqueue(id: string, mode: "parallel" | "root" | "daily" | "digest" = "parallel") {
  const maintenance = mode === "parallel" || mode === "root";
  await gate.enqueueCognitionRun(
    {
      id,
      kind: maintenance ? "synthesis" : "daily",
      payload: maintenance
        ? {
            focus: "knowledge-maintenance",
            batchId: `batch-${id}`,
            ...(mode === "root" ? { schedulingClass: "initial-root" } : {}),
          }
        : mode === "digest"
          ? { digest: true, date: "2031-04-03" }
          : {},
    },
    100,
  );
  if (maintenance) {
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,'fp','routine','pending',100,100)",
    ).run(`batch-${id}`, id);
    db.prepare("INSERT INTO knowledge_batch_regions(batch_id,node_id) VALUES(?,?)").run(
      `batch-${id}`,
      `source:${id}`,
    );
  }
}
function setup(
  execute: (run: ClaimedCognitionRun) => Promise<CognitionRunOutcome>,
  options: {
    limit?: number;
    exhausted?: () => boolean;
    enabled?: () => boolean;
  } = {},
) {
  const controller = new AbortController();
  const ctx: TaskContext = {
    signal: controller.signal,
    shouldYield: () => false,
    elapsedMs: () => 0,
    log,
  };
  const bundle = createCognitionDrainerTasks(
    {
      db,
      writeGate: gate,
      driver: { execute } as unknown as CognitionRunDriver,
      transcripts: {} as FsCognitionTranscriptStore,
      log,
      isEnabled: options.enabled ?? (() => true),
      getBudgetVerdict: () =>
        options.exhausted?.()
          ? { exhausted: true, dimension: "runs", used: 1, limit: 1, reason: "test budget" }
          : { exhausted: false },
      getWorkerConcurrency: () => options.limit ?? 2,
      getResurrectDebounceMs: () => 0,
      clock: () => 100,
    },
    {} as Scheduler,
  );
  return { controller, ctx, run: () => bundle.tasks[0]!.run(undefined, ctx) };
}
function controlled() {
  const releases = new Map<string, () => void>();
  const starts: string[] = [];
  let live = 0;
  let peak = 0;
  const execute = async (run: ClaimedCognitionRun) => {
    starts.push(run.id);
    live++;
    peak = Math.max(peak, live);
    await new Promise<void>((resolve) => {
      releases.set(run.id, resolve);
    });
    live--;
    return success;
  };
  return { execute, releases, starts, peak: () => peak, live: () => live };
}

test("overlaps fenced work up to the cap and refills behind a slow sibling without reclaim", async () => {
  for (const id of ["a", "b", "c", "d"]) await enqueue(id);
  const work = controlled();
  const drain = setup(work.execute);
  const pending = drain.run();
  await vi.waitFor(() => expect(work.starts).toEqual(["a", "b"]));
  await drain.run();
  expect(work.starts).toEqual(["a", "b"]);
  drain.ctx.elapsedMs = () => 120_000;
  work.releases.get("b")!();
  await vi.waitFor(() => expect(work.starts).toEqual(["a", "b", "c"]));
  expect(getCognitionRun(db, "a")?.attempts).toBe(1);
  work.releases.get("c")!();
  await vi.waitFor(() => expect(work.starts).toEqual(["a", "b", "c", "d"]));
  work.releases.get("d")!();
  work.releases.get("a")!();
  await pending;
  expect(work.peak()).toBe(2);
  expect(work.live()).toBe(0);
});

test.each(["root", "daily", "digest"] as const)("%s work executes exclusively", async (mode) => {
  await enqueue("exclusive", mode);
  for (const id of ["a", "b"]) await enqueue(id);
  // Explicit ordering makes the exclusive head observable before maintenance.
  db.prepare("UPDATE cognition_runs SET next_attempt_at=0 WHERE id='exclusive'").run();
  const work = controlled();
  const drain = setup(work.execute);
  const pending = drain.run();
  await vi.waitFor(() => expect(work.starts).toEqual(["exclusive"]));
  work.releases.get("exclusive")!();
  await vi.waitFor(() => expect(work.starts).toHaveLength(3));
  work.releases.get("a")!();
  work.releases.get("b")!();
  await pending;
  expect(work.peak()).toBe(2);
});

test.each(["abort", "claim-error", "settle-error"] as const)(
  "%s waits for every admitted sibling",
  async (mode) => {
    for (const id of ["a", "b", "c"]) await enqueue(id);
    const work = controlled();
    const drain = setup(work.execute);
    let returned = false;
    const pending = drain.run().then(() => {
      returned = true;
    });
    await vi.waitFor(() => expect(work.starts).toHaveLength(2));
    if (mode === "abort") drain.controller.abort();
    else if (mode === "claim-error")
      vi.spyOn(gate, "claimDueCognitionRuns").mockRejectedValue(new Error("writer unavailable"));
    else {
      const finalize = gate.finalizeCognitionRun;
      vi.spyOn(gate, "finalizeCognitionRun").mockImplementation((input) =>
        input.runId === "b" ? Promise.reject(new Error("settle unavailable")) : finalize(input),
      );
    }
    work.releases.get("b")!();
    await vi.waitFor(() => expect(work.live()).toBe(1));
    expect(returned).toBe(false);
    work.releases.get("a")!();
    await pending;
    expect(work.starts).toEqual(["a", "b"]);
    expect(getCognitionRun(db, "c")?.attempts).toBe(0);
  },
);

test("continuations yield to the next invocation and admission count is bounded", async () => {
  for (let i = 0; i < 10; i++) await enqueue(`run-${i}`);
  const execute = vi.fn((_run: ClaimedCognitionRun) =>
    Promise.resolve({ ...success, ok: false, continuation: true, deferredUntil: 100 }),
  );
  const drain = setup(execute, { limit: 1 });
  await drain.run();
  expect(execute).toHaveBeenCalledTimes(4);
  expect(new Set(execute.mock.calls.map((args) => (args[0] as ClaimedCognitionRun).id)).size).toBe(
    4,
  );
  await drain.run();
  expect(execute).toHaveBeenCalledTimes(8);
});

test.each(["budget", "disabled", "yield"] as const)(
  "rechecks %s before refilling",
  async (stop) => {
    for (const id of ["a", "b", "c"]) await enqueue(id);
    const work = controlled();
    let exhausted = false;
    let enabled = true;
    const drain = setup(work.execute, { exhausted: () => exhausted, enabled: () => enabled });
    const pending = drain.run();
    await vi.waitFor(() => expect(work.starts).toHaveLength(2));
    if (stop === "budget") exhausted = true;
    if (stop === "disabled") enabled = false;
    if (stop === "yield") drain.ctx.shouldYield = () => true;
    work.releases.get("a")!();
    work.releases.get("b")!();
    await pending;
    expect(work.starts).toEqual(["a", "b"]);
    expect(getCognitionRun(db, "c")?.attempts).toBe(0);
  },
);

test("fills vacant capacity when the planner enqueues after the first run started", async () => {
  await enqueue("held");
  const work = controlled();
  const drain = setup(work.execute, { limit: 3 });
  const pending = drain.run();
  await vi.waitFor(() => expect(work.starts).toEqual(["held"]));
  await enqueue("later-a");
  await enqueue("later-b");
  await vi.waitFor(() => expect(work.starts).toEqual(["held", "later-a", "later-b"]));
  expect(work.live()).toBe(3);
  expect(getCognitionRun(db, "held")?.attempts).toBe(1);
  for (const release of work.releases.values()) release();
  await pending;
  expect(work.live()).toBe(0);
});

test("continues a paid tool-capped segment on its frontier and rechecks the run budget", async () => {
  await enqueue("segment");
  db.exec(
    "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch-segment','source:done','done','{}',0,'offered'),('batch-segment','source:remaining','remaining','{}',0,'offered')",
  );
  const starts: string[] = [];
  const drain = setup(
    async (run) => {
      starts.push(run.id);
      db.exec("UPDATE knowledge_frontier SET status='unchanged' WHERE node_id='source:done'");
      return {
        ...success,
        ok: false,
        modelId: "scripted",
        usage: { promptTokens: 100, completionTokens: 20 },
        failure: {
          code: "tool_iteration_cap",
          message: "Tool cap reached",
          retryable: false,
          backend: "scripted",
          model: "scripted",
        },
      };
    },
    {
      exhausted: () =>
        Number(
          (
            db.prepare("SELECT COALESCE(SUM(runs),0) AS n FROM cognition_spend").get() as {
              n: number;
            }
          ).n,
        ) >= 1,
    },
  );
  await drain.run();
  expect(starts).toEqual(["segment"]);
  expect(getCognitionRun(db, "segment")?.status).toBe("completed");
  const batch = db
    .prepare("SELECT run_id FROM knowledge_batches WHERE id='batch-segment'")
    .get() as { run_id: string };
  expect(batch.run_id).not.toBe("segment");
  expect(getCognitionRun(db, batch.run_id)).toMatchObject({
    status: "pending",
    attempts: 0,
    nextAttemptAt: 100,
  });
  expect(
    db.prepare("SELECT node_id,status FROM knowledge_frontier ORDER BY node_id").all(),
  ).toEqual([
    { node_id: "source:done", status: "unchanged" },
    { node_id: "source:remaining", status: "offered" },
  ]);
  expect(
    db.prepare("SELECT SUM(runs) AS runs,SUM(prompt_tokens) AS tokens FROM cognition_spend").get(),
  ).toEqual({ runs: 1, tokens: 100 });
});

test("a tool cap without settled frontier progress remains a terminal failure", async () => {
  await enqueue("stalled");
  const drain = setup(() =>
    Promise.resolve({
      ...success,
      ok: false,
      failure: {
        code: "tool_iteration_cap",
        message: "Tool cap reached",
        retryable: false,
        backend: "scripted",
        model: "scripted",
      },
    }),
  );
  await drain.run();
  expect(getCognitionRun(db, "stalled")?.status).toBe("failed");
  expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_runs").get()).toEqual({ n: 1 });
});
