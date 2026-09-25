// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Success-criterion 5 (queue durability) at the drain level: exactly-
 * once claim → run → settle, crash re-claim with an attempt-numbered
 * prompt, non-`daily` serialization regardless of the N knob, spend
 * recorded for failed attempts, retention pruning, and the live
 * kill-switch. Everything runs on a scripted zero-token backend and a
 * compressed injectable clock.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type AgentEvent } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { upsertDocuments } from "../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../enrichment/dates/storage.js";
import { CognitionRunActivity } from "./run-activity.js";
import { createCognitionDrainerTasks, cognitionRunBackoffMs } from "./run-drainer.js";
import {
  PROVIDER_BREAKER_ERROR_KEY,
  PROVIDER_BREAKER_FAILURES_KEY,
  PROVIDER_BREAKER_OPEN_UNTIL_KEY,
  PROVIDER_BREAKER_THRESHOLD,
} from "./provider-breaker.js";
import { getCognitionEngineState, setCognitionEngineState } from "./storage/engine-state.js";
import { listSweepTallies } from "./storage/sweep-tally.js";
import { CognitionRunDriver } from "./run-driver.js";
import { FsCognitionTranscriptStore } from "./transcripts.js";
import { getCognitionRun } from "./storage/run-queue.js";
import { dataRunDedupeKey } from "./run-payloads.js";
import {
  getCognitionSpendDayTotal,
  listCognitionSpend,
  cognitionSpendDay,
} from "./storage/spend.js";
import { createBrief } from "./storage/briefs.js";
import { createOpenLoop } from "./storage/open-loops.js";
import { countPendingBootstrap, fetchBootstrapBatch } from "./storage/bootstrap.js";
import { listCognitionCoverage } from "./storage/coverage.js";
import type { DocumentInput } from "@omnesis/types";
import type { CognitionBudgetVerdict } from "./cognition/budget.js";
import type Database from "better-sqlite3";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { TaskContext } from "../scheduler/types.js";

type Db = Database.Database;

const log = createLogger("test").child("run-drainer");

// periodicJob reads the scheduler only inside observe(), which these
// tests never call — a bare stub keeps the bundle constructible without
// spawning worker threads.
const schedulerStub = {} as unknown as Scheduler;

const taskCtx: TaskContext = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function happyScript(input: TurnInput): AgentEvent[] {
  return [
    {
      type: "agent.message.start",
      payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "done" },
    },
    {
      type: "agent.message.end",
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 10 },
      },
    },
  ];
}

describe("steward run drainer", () => {
  let dbPath: string;
  let db: Db;
  let dir: string;
  let transcripts: FsCognitionTranscriptStore;
  let now: number;
  const clock = (): number => now;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    dir = mkdtempSync(join(tmpdir(), "omnesis-run-drainer-"));
    transcripts = new FsCognitionTranscriptStore(join(dir, "t"));
    now = 100_000;
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A historical document carrying a still-future extracted date — i.e. one
   * the bootstrap work-list would select — and its gateway id.
   */
  function seedDatedDoc(externalId: string, sourceId: string): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: sourceId as DocumentInput["sourceId"],
      externalId,
      title: "Storage lease renewal",
      content: "The lease runs until 2099.",
      contentHash: `hash-${externalId}`,
      metadata: { documentType: "email" },
      sourceCreatedAt: "2024-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    const id = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
    applyExtractedDates(db, [
      {
        id,
        dates: [
          {
            kind: "date",
            resolvedStart: "2099-06-01",
            resolvedEnd: null,
            relative: false,
            text: "2099-06-01",
            timex: "2099-06-01",
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
    return id;
  }

  interface BundleOpts {
    backend?: (input: TurnInput) => AgentEvent[] | Promise<AgentEvent[]>;
    resolveBackend?: () => ChatBackend | null;
    isEnabled?: () => boolean;
    getBudgetVerdict?: () => CognitionBudgetVerdict;
    workerConcurrency?: number;
    maxAttempts?: number;
    resurrectDebounceMs?: number;
    prompts?: string[];
    activity?: CognitionRunActivity;
    digestPush?: {
      getEnabled: () => boolean;
      send: (brief: import("./storage/types.js").BriefRow, day: string) => Promise<void>;
    };
  }

  function makeBundle(opts: BundleOpts = {}) {
    const writeGate = directWriteGate(db);
    const script = opts.backend ?? happyScript;
    const prompts = opts.prompts ?? [];
    const resolveBackend =
      opts.resolveBackend ??
      ((): ChatBackend => ({
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          prompts.push(input.userMessage);
          for (const event of await script(input)) yield event;
        },
      }));
    const driver = new CognitionRunDriver({ resolveBackend, transcripts, log, clock });
    const bundle = createCognitionDrainerTasks(
      {
        db,
        writeGate,
        driver,
        transcripts,
        log,
        isEnabled: opts.isEnabled ?? (() => true),
        getBudgetVerdict: opts.getBudgetVerdict ?? (() => ({ exhausted: false as const })),
        ...(opts.activity ? { activity: opts.activity } : {}),
        getWorkerConcurrency: () => opts.workerConcurrency ?? 1,
        getResurrectDebounceMs: () => opts.resurrectDebounceMs ?? 0,
        clock,
        ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        ...(opts.digestPush ? { digestPush: opts.digestPush } : {}),
      },
      schedulerStub,
    );
    const [drain] = bundle.tasks;
    return { writeGate, drain: drain!, prompts };
  }

  test("a completed digest run pushes its minted brief; disabled knob stays silent", async () => {
    const pushed: Array<{ briefId: string; day: string }> = [];
    let pushEnabled = true;
    const { writeGate, drain } = makeBundle({
      digestPush: {
        getEnabled: () => pushEnabled,
        // eslint-disable-next-line @typescript-eslint/require-await
        send: async (brief, day) => {
          pushed.push({ briefId: brief.id, day });
        },
      },
    });
    // The digest run's card, stamped with the run id the hook looks up.
    createBrief(
      db,
      {
        id: "brf_digest",
        createdByRun: "run_digest",
        kind: "info",
        title: "Morning brief — quiet day",
        description: "Nothing needs you before noon.",
        confidence: 0.9,
        urgency: 0.2,
      },
      now - 1000,
    );
    await writeGate.enqueueCognitionRun(
      { id: "run_digest", kind: "daily", payload: { digest: true, date: "2026-07-02" } },
      now,
    );
    await drain.run(undefined, taskCtx);
    expect(pushed).toEqual([{ briefId: "brf_digest", day: "2026-07-02" }]);

    // Knob off → a second day's digest completes without pushing.
    pushEnabled = false;
    createBrief(
      db,
      {
        id: "brf_digest_2",
        createdByRun: "run_digest_2",
        kind: "info",
        title: "Morning brief — still quiet",
        description: "d",
        confidence: 0.9,
        urgency: 0.2,
      },
      now - 500,
    );
    await writeGate.enqueueCognitionRun(
      { id: "run_digest_2", kind: "daily", payload: { digest: true, date: "2026-07-03" } },
      now,
    );
    await drain.run(undefined, taskCtx);
    expect(pushed).toHaveLength(1);
  });

  test("a settled sweep run folds into its sweep's tally; other kinds do not", async () => {
    // The drainer is the only writer of every number the Sweeps tab shows, and
    // the artifact counts come from `created_by_run` rather than from anything
    // accumulated as the run worked.
    const { writeGate, drain } = makeBundle();
    createOpenLoop(
      db,
      {
        id: "loop_from_sweep",
        createdByRun: "run_sweep",
        title: "Chase the deposit refund",
        confidence: 0.7,
        importance: 0.6,
      },
      now - 100,
    );
    createBrief(
      db,
      {
        id: "brf_from_sweep",
        createdByRun: "run_sweep",
        kind: "info",
        title: "Two subscriptions renew next week",
        confidence: 0.8,
        urgency: 0.4,
      },
      now - 100,
    );
    await writeGate.enqueueCognitionRun(
      {
        id: "run_sweep",
        kind: "sweep",
        payload: { sweepId: "weekly-finances", date: "2026-07-02", steeringPrompt: "money" },
      },
      now,
    );
    // A non-sweep run settling alongside must leave no tally at all.
    await writeGate.enqueueCognitionRun(
      { id: "run_daily", kind: "daily", payload: { digest: true, date: "2026-07-02" } },
      now,
    );
    await drain.run(undefined, taskCtx);
    await drain.run(undefined, taskCtx);

    const tallies = listSweepTallies(db);
    expect([...tallies.keys()]).toEqual(["weekly-finances"]);
    expect(tallies.get("weekly-finances")).toMatchObject({
      runs: 1,
      failedRuns: 0,
      briefsCreated: 1,
      loopsCreated: 1,
      promptTokens: 50,
      completionTokens: 10,
    });
    expect(tallies.get("weekly-finances")!.lastRunAt).toBe(now);
  });

  test("a sweep run tallies once it gives up, and not while it is still retrying", async () => {
    const { writeGate, drain } = makeBundle({
      maxAttempts: 2,
      backend: () => {
        throw new Error("backend down");
      },
    });
    await writeGate.enqueueCognitionRun(
      {
        id: "run_sweep_fail",
        kind: "sweep",
        payload: { sweepId: "health-trends", date: "2026-07-02", steeringPrompt: "health" },
      },
      now,
    );
    // First attempt fails but is still due another, so nothing is recorded —
    // a sweep that eventually succeeds must not also show as having failed.
    await drain.run(undefined, taskCtx);
    expect(listSweepTallies(db).size).toBe(0);

    now += 60 * 60 * 1000;
    await drain.run(undefined, taskCtx);
    expect(listSweepTallies(db).get("health-trends")).toMatchObject({ runs: 0, failedRuns: 1 });
  });

  test("one queue kind's distinct procedures land in distinct spend buckets", async () => {
    // The point of workflow-level attribution: `daily` multiplexes three
    // procedures, and blending them into one bucket is what makes a
    // per-workload model decision unanswerable.
    const { writeGate, drain } = makeBundle();
    await writeGate.enqueueCognitionRun(
      {
        id: "run_src",
        kind: "daily",
        payload: { sourceId: "src_1", dateFrom: "2026-07-02", dateTo: "2026-07-02" },
      },
      now,
    );
    await writeGate.enqueueCognitionRun(
      { id: "run_digest", kind: "daily", payload: { digest: true, date: "2026-07-03" } },
      now,
    );
    await writeGate.enqueueCognitionRun(
      { id: "run_mayday", kind: "daily", payload: { mayDay: true, date: "2026-07-03" } },
      now,
    );
    // One tick claims a bounded batch; drain until the queue is empty.
    for (let i = 0; i < 3; i++) await drain.run(undefined, taskCtx);

    expect(
      listCognitionSpend(db)
        .map((r) => r.mechanism)
        .sort(),
    ).toEqual(["daily-lookahead", "daily-source-review", "morning-digest"]);
  });

  test("an exhausted day budget parks the queue instead of failing its runs", async () => {
    // Parking at the CLAIM boundary matters: an already-claimed run has burned
    // an attempt, so failing it there would walk the row toward the terminal
    // state. A parked run is simply still pending tomorrow.
    const { writeGate, drain } = makeBundle({
      getBudgetVerdict: () => ({
        exhausted: true,
        dimension: "tokens",
        used: 1_100,
        limit: 1_000,
        reason: "Today's cognition token budget is spent.",
      }),
    });
    await writeGate.enqueueCognitionRun(
      { id: "run_budget", kind: "data", payload: { docId: "d", event: "created", datumAt: now } },
      now,
    );

    const outcome = await drain.run(undefined, taskCtx);
    expect(outcome).toEqual({ kind: "done", value: { idle: true } });

    const row = getCognitionRun(db, "run_budget");
    expect(row?.status, "still claimable tomorrow").toBe("pending");
    expect(row?.attempts, "no attempt burned").toBe(0);
    expect(listCognitionSpend(db), "and nothing spent").toEqual([]);
  });

  test("enqueue → claim → run → complete, with usage recorded on the row and the day", async () => {
    const { writeGate, drain } = makeBundle();
    await writeGate.enqueueCognitionRun(
      {
        id: "run_1",
        kind: "data",
        payload: { docId: "d", event: "created", datumAt: now },
      },
      now,
    );
    const outcome = await drain.run(undefined, taskCtx);
    expect(outcome).toEqual({ kind: "done", value: { idle: false } });

    const row = getCognitionRun(db, "run_1");
    expect(row?.status).toBe("completed");
    expect(row?.usage).toEqual({
      promptTokens: 50,
      completionTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // Spend is attributed to the run's cognitive WORKFLOW (not its queue
    // kind) and the resolved backend's model.
    expect(listCognitionSpend(db)).toEqual([
      {
        day: cognitionSpendDay(now),
        mechanism: "datum-intake",
        modelId: "scripted-model",
        runs: 1,
        promptTokens: 50,
        completionTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
    // Exactly-once: a second tick finds nothing.
    expect(await drain.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
  });

  test("marks the executing run in the activity registry, and clears it on settle", async () => {
    const activity = new CognitionRunActivity();
    let seenWhileExecuting: number | null = null;
    const { writeGate, drain } = makeBundle({
      activity,
      backend: (input) => {
        // Observed mid-execution: the registry must say run_1 is live.
        seenWhileExecuting = activity.startedAtMs("run_1");
        return happyScript(input);
      },
    });
    await writeGate.enqueueCognitionRun(
      {
        id: "run_1",
        kind: "data",
        payload: { docId: "d", event: "created", datumAt: now },
      },
      now,
    );
    expect(activity.startedAtMs("run_1")).toBeNull();
    await drain.run(undefined, taskCtx);
    expect(seenWhileExecuting).toBe(now);
    // Settled → cleared, whatever the outcome.
    expect(activity.startedAtMs("run_1")).toBeNull();
    expect(activity.count).toBe(0);
  });

  test("crash re-claim: a claimed-but-never-settled run is re-run with attempt 2 in the prompt", async () => {
    const { writeGate, drain, prompts } = makeBundle();
    await writeGate.enqueueCognitionRun({ id: "run_1", kind: "data", payload: {} }, now);
    // Simulate a worker killed after claiming: attempts bumped, row still pending.
    const crashed = await writeGate.claimDueCognitionRuns({ now });
    expect(crashed).toHaveLength(1);
    expect(getCognitionRun(db, "run_1")?.status).toBe("pending");

    // The next drain tick naturally re-claims it and the prompt is honest
    // about the run id + attempt number.
    await drain.run(undefined, taskCtx);
    expect(getCognitionRun(db, "run_1")?.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Run id: run_1");
    expect(prompts[0]).toContain("Attempt: 2");
  });

  test("non-daily runs serialize even at N=2; daily runs use the parallelism", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gatedScript = async (input: TurnInput): Promise<AgentEvent[]> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield twice so overlapping runs would actually interleave.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return happyScript(input);
    };

    const { writeGate, drain } = makeBundle({ backend: gatedScript, workerConcurrency: 2 });
    await writeGate.enqueueCognitionRun({ id: "run_a", kind: "data", payload: {} }, now);
    await writeGate.enqueueCognitionRun({ id: "run_b", kind: "feedback", payload: {} }, now);
    await drain.run(undefined, taskCtx);
    expect(getCognitionRun(db, "run_a")?.status).toBe("completed");
    expect(getCognitionRun(db, "run_b")?.status).toBe("completed");
    expect(maxInFlight).toBe(1);

    // Same shape, `daily` kind: the two runs overlap.
    maxInFlight = 0;
    await writeGate.enqueueCognitionRun({ id: "run_c", kind: "daily", payload: {} }, now);
    await writeGate.enqueueCognitionRun({ id: "run_d", kind: "daily", payload: {} }, now);
    await drain.run(undefined, taskCtx);
    expect(getCognitionRun(db, "run_c")?.status).toBe("completed");
    expect(getCognitionRun(db, "run_d")?.status).toBe("completed");
    expect(maxInFlight).toBe(2);
  });

  test("a failing run retries with backoff, then fails terminally at the attempts cap", async () => {
    const { writeGate, drain } = makeBundle({
      backend: () => {
        throw new Error("model exploded");
      },
      maxAttempts: 2,
    });
    await writeGate.enqueueCognitionRun(
      { id: "run_1", kind: "data", payload: { diff: "transient" } },
      now,
    );

    await drain.run(undefined, taskCtx);
    const afterFirst = getCognitionRun(db, "run_1");
    expect(afterFirst?.status).toBe("pending");
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toContain("model exploded");
    expect(afterFirst?.nextAttemptAt).toBe(
      now + cognitionRunBackoffMs(1, { baseBackoffMs: 60_000, maxBackoffMs: 3_600_000 }),
    );

    // Not due yet — the drain leaves it alone.
    expect(await drain.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });

    // Once due, the final attempt fails terminally and the payload dies.
    now = afterFirst!.nextAttemptAt;
    await drain.run(undefined, taskCtx);
    const terminal = getCognitionRun(db, "run_1");
    expect(terminal?.status).toBe("failed");
    expect(terminal?.payload).toEqual({});
  });

  test("a deterministic context failure settles after one attempt without retrying", async () => {
    let calls = 0;
    const { writeGate, drain } = makeBundle({
      backend: (input) => {
        calls += 1;
        return [
          {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "error",
              failure: {
                code: "context_window_exceeded",
                message: "prompt is too long",
                retryable: false,
                backend: "scripted",
                model: "scripted-model",
              },
              usage: { inputTokens: 8_500, outputTokens: 0 },
            },
          },
        ];
      },
      maxAttempts: 5,
    });
    await writeGate.enqueueCognitionRun(
      { id: "run_context", kind: "data", payload: { docId: "fictional-doc" } },
      now,
    );

    await drain.run(undefined, taskCtx);

    expect(getCognitionRun(db, "run_context")).toMatchObject({
      status: "failed",
      attempts: 1,
      failureCode: "context_window_exceeded",
    });
    expect(getCognitionSpendDayTotal(db, cognitionSpendDay(now))).toMatchObject({
      runs: 0,
      promptTokens: 8_500,
      completionTokens: 0,
    });
    now += 24 * 60 * 60_000;
    await drain.run(undefined, taskCtx);
    expect(calls).toBe(1);
  });

  test("output truncation is terminal for a machine workflow", async () => {
    const { writeGate, drain } = makeBundle({
      backend: (input) => [
        {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "max_tokens",
          },
        },
      ],
      maxAttempts: 5,
    });
    await writeGate.enqueueCognitionRun(
      { id: "run_truncated", kind: "daily", payload: { date: "2099-01-01" } },
      now,
    );

    await drain.run(undefined, taskCtx);

    expect(getCognitionRun(db, "run_truncated")).toMatchObject({
      status: "failed",
      attempts: 1,
      failureCode: "output_truncated",
    });
  });

  test("a boot reconciles a breaker mirror left open by the previous process", async () => {
    // The breaker itself lives in memory and starts CLOSED on every boot —
    // deliberately, because a restart is the operator's most likely response
    // to an outage and should buy an immediate retry. The mirror is written
    // only on the open/closed edge, so a process killed while it was open
    // leaves a row nothing holds any more. Without a reconcile, the operator
    // who just fixed the backend watches runs complete while the Brain panel
    // still reports "model backend failing" for the rest of the cooldown.
    setCognitionEngineState(db, PROVIDER_BREAKER_OPEN_UNTIL_KEY, String(now + 600_000));
    setCognitionEngineState(db, PROVIDER_BREAKER_FAILURES_KEY, "3");
    setCognitionEngineState(db, PROVIDER_BREAKER_ERROR_KEY, "HTTP 402 no credit");

    const { writeGate, drain } = makeBundle();
    await writeGate.enqueueCognitionRun(
      { id: "run_after_restart", kind: "daily", payload: { date: "2099-01-01" } },
      now,
    );
    await drain.run(undefined, taskCtx);

    expect(getCognitionRun(db, "run_after_restart")?.status).toBe("completed");
    expect(Number(getCognitionEngineState(db, PROVIDER_BREAKER_OPEN_UNTIL_KEY))).toBe(0);
    expect(getCognitionEngineState(db, PROVIDER_BREAKER_FAILURES_KEY)).toBe("0");
    expect(getCognitionEngineState(db, PROVIDER_BREAKER_ERROR_KEY)).toBe("");
  });

  test("repeated model-limit failures leave the provider breaker closed", async () => {
    // `output_truncated` and `tool_iteration_cap` are verdicts the backend
    // itself delivered — it answered, at length. Folding them into the
    // provider breaker would let a run of over-long documents stop every
    // cognition lane against a perfectly healthy backend.
    const { writeGate, drain } = makeBundle({
      backend: (input) => [
        {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "max_tokens",
          },
        },
      ],
      maxAttempts: 5,
    });
    for (let i = 0; i < PROVIDER_BREAKER_THRESHOLD + 1; i++) {
      await writeGate.enqueueCognitionRun(
        { id: `run_trunc_${i}`, kind: "daily", payload: { date: `2099-01-0${i + 1}` } },
        now,
      );
    }
    for (let i = 0; i < PROVIDER_BREAKER_THRESHOLD + 1; i++) {
      await drain.run(undefined, taskCtx);
    }

    // The run after the threshold was still claimed and settled: the drainer
    // never stopped claiming.
    expect(getCognitionRun(db, `run_trunc_${PROVIDER_BREAKER_THRESHOLD}`)).toMatchObject({
      status: "failed",
      failureCode: "output_truncated",
    });
    // ...and nothing mirrored an outage for the operator to chase.
    expect(getCognitionEngineState(db, PROVIDER_BREAKER_OPEN_UNTIL_KEY)).toBeNull();
  });

  /**
   * Drive one `data` run to completion while a second wake for the same
   * document folds into the in-flight row — the race the resurrect path
   * exists for. Returns the resurrected row.
   */
  async function resurrectAfterInFlightFold(
    docId: string,
    payloadExtra: Record<string, unknown>,
    resurrectDebounceMs: number,
  ) {
    // The fold has to reach the queue while the attempt is in flight, so it
    // goes through its own handle rather than the bundle's (which does not
    // exist yet when this backend is constructed).
    const foldGate = directWriteGate(db);
    const { writeGate, drain } = makeBundle({
      resurrectDebounceMs,
      backend: async (input) => {
        // A second capture lands mid-attempt: same dedupe key, fresh bytes.
        await foldGate.enqueueCognitionRun(
          {
            id: `fold_${docId}`,
            kind: "data",
            payload: { docId, event: "updated", datumAt: now + 1, ...payloadExtra },
            dedupeKey: dataRunDedupeKey(docId),
          },
          now,
        );
        return happyScript(input);
      },
    });
    await writeGate.enqueueCognitionRun(
      {
        id: `run_${docId}`,
        kind: "data",
        payload: { docId, event: "created", datumAt: now, ...payloadExtra },
        dedupeKey: dataRunDedupeKey(docId),
      },
      now,
    );
    await drain.run(undefined, taskCtx);
    return getCognitionRun(db, `run_${docId}`);
  }

  test("an in-flight fold on addressed content resurrects due now", async () => {
    // `immediate` marks content the user deliberately handed to the assistant
    // (a quick capture, a note addressed to the agent). Its contract is that
    // nothing downstream delays it. A second capture landing while the first
    // run is still executing folds into the in-flight row; the resurrect must
    // therefore re-fire at once rather than serve out the conversation quiet
    // window that ordinary documents get.
    const row = await resurrectAfterInFlightFold("doc_addressed", { immediate: true }, 3_600_000);
    expect(row).toMatchObject({ status: "pending", nextAttemptAt: now });
  });

  test("an in-flight fold on an ordinary document re-enters the quiet window", async () => {
    // The control for the case above: an ordinary document's resurrect is the
    // primary spend-safety window and must keep waiting it out.
    const row = await resurrectAfterInFlightFold("doc_ordinary", {}, 3_600_000);
    expect(row).toMatchObject({ status: "pending", nextAttemptAt: now + 3_600_000 });
  });

  test("an unavailable backend is a soft failure — the run stays claimable", async () => {
    const { writeGate, drain } = makeBundle({ resolveBackend: () => null });
    await writeGate.enqueueCognitionRun({ id: "run_1", kind: "data", payload: {} }, now);
    await drain.run(undefined, taskCtx);
    const row = getCognitionRun(db, "run_1");
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("backend unavailable");
  });

  test("a failed attempt's tokens land in spend without counting a run", async () => {
    // A backend that reports usage, then dies before finishing the stream.
    const { writeGate, drain } = makeBundle({
      resolveBackend: () => ({
        name: "half-broken",
        model: "half-broken-model",
        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          for (const event of happyScript(input)) {
            yield event.type === "agent.message.end"
              ? { ...event, payload: { ...event.payload, stopReason: "tool_use" } }
              : event;
          }
          await Promise.resolve();
          throw new Error("stream died after usage was reported");
        },
      }),
      maxAttempts: 1,
    });
    await writeGate.enqueueCognitionRun(
      { id: "run_1", kind: "data", payload: { docId: "d", event: "created", datumAt: now } },
      now,
    );
    await drain.run(undefined, taskCtx);
    expect(getCognitionRun(db, "run_1")?.status).toBe("failed");
    // The tokens the doomed attempt consumed are still accounted, but the
    // per-day run counter only counts completions.
    expect(getCognitionSpendDayTotal(db, cognitionSpendDay(now))).toMatchObject({
      runs: 0,
      promptTokens: 50,
      completionTokens: 10,
    });
    // Attribution still lands on the workflow and the model that spent them.
    expect(listCognitionSpend(db)).toMatchObject([
      { mechanism: "datum-intake", modelId: "half-broken-model" },
    ]);
  });

  test("kill-switch off: the drain claims nothing and reports idle", async () => {
    const { writeGate, drain } = makeBundle({ isEnabled: () => false });
    await writeGate.enqueueCognitionRun({ id: "run_1", kind: "data", payload: {} }, now);
    expect(await drain.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(getCognitionRun(db, "run_1")?.attempts).toBe(0);
  });

  test("a datum the live lane handled never becomes a bootstrap candidate", async () => {
    // The two lanes divide the corpus on the datum's own timestamp, so a
    // document the waker handles today crosses into the retrospective lane's
    // half as soon as it ages past the recency window. Without the marker the
    // agent buys a second full run over a document it already reasoned about.
    const docId = seedDatedDoc("renewal-1", "mail:maya@example.com");
    const { writeGate, drain } = makeBundle();
    await writeGate.enqueueCognitionRun(
      {
        id: "run_live",
        kind: "data",
        payload: { docId, event: "created", datumAt: now },
      },
      now,
    );
    await drain.run(undefined, taskCtx);

    // A floor above the datum's own timestamp: without the settle stamp this
    // document is squarely in the bootstrap work-list.
    const floor = "2100-01-01T00:00:00.000Z";
    expect(countPendingBootstrap(db, floor)).toBe(0);
    expect(fetchBootstrapBatch(db, { recencyFloor: floor, batchSize: 10 })).toEqual([]);
  });

  test("a settled run tallies coverage against its document's source", async () => {
    const docId = seedDatedDoc("renewal-2", "mail:maya@example.com");
    const { writeGate, drain } = makeBundle();
    await writeGate.enqueueCognitionRun(
      { id: "run_cov", kind: "data", payload: { docId, event: "created", datumAt: now } },
      now,
    );
    await drain.run(undefined, taskCtx);

    expect(listCognitionCoverage(db)).toMatchObject([
      {
        sourceId: "mail:maya@example.com",
        workflowId: "datum-intake",
        processed: 1,
        skipped: 0,
        promptTokens: 50,
        completionTokens: 10,
        status: "live",
      },
    ]);
  });
});
