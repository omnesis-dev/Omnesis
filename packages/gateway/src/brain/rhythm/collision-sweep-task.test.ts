// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `cognition.collisionSweep` rhythm task end to end on a temp database:
 * its gates, the read port it selects candidates through, the order the arms
 * read and enqueue in, and the retry a failed read leaves behind. The port is
 * a stub here, so each test says exactly what the selection returned; the
 * main handle holds a collision of its own that the sweep must never find.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { listCognitionRuns } from "../storage/run-queue.js";
import {
  COGNITION_COLLISION_LAST_RUN_KEY,
  getCognitionEngineState,
} from "../storage/engine-state.js";
import { createCognitionRhythmTasks } from "./rhythm-tasks.js";
import type { CollisionSweepReads } from "./collision-sweep-reads.js";
import type Database from "better-sqlite3";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask, TaskContext } from "../../scheduler/types.js";

type Db = Database.Database;

const log = createLogger("test:collision-sweep-task");
const taskCtx = { signal: new AbortController().signal } as TaskContext;
const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const HOUR = 3_600_000;

/** The ledgers the sweep's arms select from; the main handle must never read them. */
const SELECTION_TABLES =
  /\b(open_loops|open_loop_people|open_loop_docs|observation_related_loops|temporal_annotations|doc_annotations|person_annotations)\b/;

let path: string;
let db: Db;
let prepared: string[];
let calls: string[];

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  // A collision on the main handle: a sweep that read it would enqueue L1+L2.
  for (const id of ["L1", "L2"])
    createOpenLoop(
      db,
      { id, createdByRun: "r", title: id, confidence: 0.9, importance: 0.9, docs: ["doc-shared"] },
      NOW - HOUR,
    );
  prepared = [];
  calls = [];
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

/** The main handle as the task sees it, recording every statement it prepares. */
function recordingHandle(): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare")
        return (sql: string) => {
          prepared.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

interface StubResults {
  loops?: Awaited<ReturnType<CollisionSweepReads["collisionLoopCandidates"]>>;
  temporal?: () => Promise<Awaited<ReturnType<CollisionSweepReads["collisionTemporalCandidates"]>>>;
  contradictions?: Awaited<ReturnType<CollisionSweepReads["collisionAnnotationContradictions"]>>;
}

function stubReads(results: StubResults = {}) {
  return {
    collisionLoopCandidates: vi.fn((options: { limit: number }) => {
      calls.push(`read loops limit=${options.limit}`);
      return Promise.resolve(results.loops ?? []);
    }),
    collisionTemporalCandidates: vi.fn((options: { limit: number; horizonDays: number }) => {
      calls.push(`read temporal limit=${options.limit} horizon=${options.horizonDays}`);
      return results.temporal ? results.temporal() : Promise.resolve([]);
    }),
    collisionAnnotationContradictions: vi.fn((options: { max: number }) => {
      calls.push(`read contradictions max=${options.max}`);
      return Promise.resolve(results.contradictions ?? []);
    }),
  } satisfies CollisionSweepReads;
}

function collisionTask(opts: {
  reads: CollisionSweepReads;
  enabled?: () => boolean;
  loops?: () => boolean;
  contradictions?: () => boolean;
  maxPerSweep?: number;
  clock?: () => number;
}): PeriodicTask<unknown, { idle: boolean }> {
  const gate = directWriteGate(db);
  const writeGate = {
    ...gate,
    enqueueCognitionRun: (...args: Parameters<typeof gate.enqueueCognitionRun>) => {
      calls.push(`enqueue ${args[0].dedupeKey}`);
      return gate.enqueueCognitionRun(...args);
    },
  };
  const bundle = createCognitionRhythmTasks(
    {
      db: recordingHandle(),
      writeGate,
      log,
      isEnabled: opts.enabled ?? (() => true),
      getDailyRunHour: () => 5,
      getDecayBackoff: () => ({
        backoffBaseMs: 100,
        backoffCapMs: 800,
        datedFloorMs: 10,
        datedFraction: 0.5,
      }),
      getCollisionEnabled: opts.loops ?? (() => true),
      getCollisionMaxPerSweep: () => opts.maxPerSweep ?? 3,
      getCollisionTimeHorizonDays: () => 45,
      getAnnotationContradictionsEnabled: opts.contradictions ?? (() => true),
      getAnnotationContradictionsMaxPerSweep: () => 2,
      collisionReads: opts.reads,
      clock: opts.clock ?? (() => NOW),
    },
    {} as unknown as Scheduler,
  );
  return bundle.tasks.find((t) => t.name === "cognition.collisionSweep")! as PeriodicTask<
    unknown,
    { idle: boolean }
  >;
}

const loopCandidate = { loopIds: ["X1", "X2"], matchedBy: ["doc:doc-port"], score: 0.5 };
const temporalCandidate = {
  temporalAnnotationIds: ["ta-a", "ta-b"],
  matchedBy: ["time-overlap:2026-07-10..2026-07-10"],
};
const contradictionCandidate = {
  store: "doc" as const,
  annotationIds: ["da-1", "da-2"],
  subjectId: "doc-port",
  claimType: "status",
};

function synthesisRuns() {
  return listCognitionRuns(db, { kinds: ["synthesis"] });
}

describe("the collision sweep task", () => {
  test("idles without selecting when the Brain is off or both arm families are off", async () => {
    const reads = stubReads({ loops: [loopCandidate] });
    for (const task of [
      collisionTask({ reads, enabled: () => false }),
      collisionTask({ reads, loops: () => false, contradictions: () => false }),
    ])
      expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(calls).toEqual([]);
    expect(synthesisRuns()).toEqual([]);
    expect(getCognitionEngineState(db, COGNITION_COLLISION_LAST_RUN_KEY)).toBeNull();
  });

  test("selects through the wired read port and never reads a ledger on the main handle", async () => {
    const task = collisionTask({
      reads: stubReads({
        loops: [loopCandidate],
        temporal: () => Promise.resolve([temporalCandidate]),
        contradictions: [contradictionCandidate],
      }),
    });
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(synthesisRuns().map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        { focus: "collision", loopIds: ["X1", "X2"], matchedBy: ["doc:doc-port"] },
        {
          focus: "collision",
          temporalAnnotationIds: ["ta-a", "ta-b"],
          matchedBy: ["time-overlap:2026-07-10..2026-07-10"],
        },
        {
          focus: "annotation-contradiction",
          annotationIds: ["da-1", "da-2"],
          store: "doc",
        },
      ]),
    );
    // The handle's own L1+L2 collision was never found: the port decided.
    expect(synthesisRuns()).toHaveLength(3);
    expect(prepared.length).toBeGreaterThan(0);
    expect(prepared.filter((sql) => SELECTION_TABLES.test(sql))).toEqual([]);
    expect(getCognitionEngineState(db, COGNITION_COLLISION_LAST_RUN_KEY)).toBe(String(NOW));
  });

  test("each arm reads after the previous arm's enqueues, and the temporal arm gets what the loops left", async () => {
    const task = collisionTask({
      reads: stubReads({
        loops: [loopCandidate],
        temporal: () => Promise.resolve([temporalCandidate]),
        contradictions: [contradictionCandidate],
      }),
    });
    await task.run(undefined, taskCtx);
    expect(calls).toEqual([
      "read loops limit=3",
      "enqueue synthesis:collision:X1,X2",
      "read temporal limit=2 horizon=45",
      "enqueue synthesis:collision:ta-a,ta-b",
      "read contradictions max=2",
      "enqueue synthesis:anno-contradiction:da-1,da-2",
    ]);
  });

  test("loop joins at the cap leave no read for the temporal arm", async () => {
    const task = collisionTask({ maxPerSweep: 1, reads: stubReads({ loops: [loopCandidate] }) });
    await task.run(undefined, taskCtx);
    expect(calls).toEqual([
      "read loops limit=1",
      "enqueue synthesis:collision:X1,X2",
      "read contradictions max=2",
    ]);
  });

  test("an arm switched off is never read", async () => {
    const reads = stubReads({ loops: [loopCandidate], contradictions: [contradictionCandidate] });
    await collisionTask({ reads, loops: () => false }).run(undefined, taskCtx);
    expect(calls).toEqual([
      "read contradictions max=2",
      "enqueue synthesis:anno-contradiction:da-1,da-2",
    ]);
    expect(reads.collisionLoopCandidates).not.toHaveBeenCalled();
    expect(reads.collisionTemporalCandidates).not.toHaveBeenCalled();
  });

  test("no candidates still stamps the marker, and the cadence holds the next tick", async () => {
    let now = NOW;
    const reads = stubReads();
    const task = collisionTask({ reads, clock: () => now });
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(synthesisRuns()).toEqual([]);
    expect(getCognitionEngineState(db, COGNITION_COLLISION_LAST_RUN_KEY)).toBe(String(NOW));
    now = NOW + 23 * HOUR;
    calls = [];
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(calls).toEqual([]);
  });

  test("a failed read leaves the marker unstamped, and the next tick redoes the pass", async () => {
    let failures = 1;
    const reads = stubReads({
      loops: [loopCandidate],
      temporal: () =>
        failures-- > 0
          ? Promise.reject(new Error("io worker unavailable"))
          : Promise.resolve([temporalCandidate]),
    });
    const task = collisionTask({ reads });
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(getCognitionEngineState(db, COGNITION_COLLISION_LAST_RUN_KEY)).toBeNull();
    expect(synthesisRuns().map((r) => r.dedupeKey)).toEqual(["synthesis:collision:X1,X2"]);

    // The retry folds the loop run it already enqueued and finishes the pass.
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(
      synthesisRuns()
        .map((r) => r.dedupeKey)
        .sort(),
    ).toEqual(["synthesis:collision:X1,X2", "synthesis:collision:ta-a,ta-b"]);
    expect(getCognitionEngineState(db, COGNITION_COLLISION_LAST_RUN_KEY)).toBe(String(NOW));
  });
});
