// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The rhythm task wrappers: the live `isEnabled` gate quiesces both
 * tasks without a restart, and an enabled tick drives the underlying
 * passes (asserted through their observable effects — the daily
 * due-gate marker and a scheduled decay check).
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  cancelPendingCognitionRunsByDedupeKeys,
  enqueueCognitionRun,
  listCognitionRuns,
} from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  setCognitionEngineState,
  COGNITION_BOOTSTRAP_STATE_KEY,
  COGNITION_DAILY_LAST_RUN_DAY_KEY,
  COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
} from "../storage/engine-state.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { createDocAnnotation } from "../storage/annotations.js";
import { directWriteGate } from "../../write-gate.js";
import { listAllMergeCandidates, upsertMergeCandidates } from "../../merge-candidates.js";
import { resolveBrainSettings } from "../config.js";
import { BOOTSTRAP_BOOT_GRACE_MS } from "./bootstrap-enqueuer.js";
import { createCognitionRhythmTasks } from "./rhythm-tasks.js";
import type Database from "better-sqlite3";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { TaskContext } from "../../scheduler/types.js";

type Db = Database.Database;

const log = createLogger("test:briefs-rhythm-tasks");
const schedulerStub = {} as unknown as Scheduler;
const taskCtx = { signal: new AbortController().signal } as TaskContext;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("steward rhythm tasks", () => {
  let path: string;
  let db: Db;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  function makeBundle(opts: { enabled?: boolean } = {}) {
    const writeGate = {
      enqueueCognitionRun: async (input: Parameters<typeof enqueueCognitionRun>[1], now: number) =>
        enqueueCognitionRun(db, input, now),
      cancelPendingCognitionRuns: async (keys: string[]) =>
        cancelPendingCognitionRunsByDedupeKeys(db, keys),
      setCognitionEngineState: async (key: string, value: string) =>
        setCognitionEngineState(db, key, value),
    };
    return createCognitionRhythmTasks(
      {
        db,
        writeGate,
        log,
        isEnabled: () => opts.enabled ?? true,
        getDailyRunHour: () => 5,
        getDecayBackoff: () => ({ backoffBaseMs: 100, backoffCapMs: 800 }),
        clock: () => Date.now(),
      },
      schedulerStub,
    );
  }

  test("disabled: both tasks idle without touching the queue or markers", async () => {
    createOpenLoop(
      db,
      { id: "loop_1", createdByRun: "r", title: "t", confidence: 1, importance: 1 },
      1000,
    );
    const bundle = makeBundle({ enabled: false });
    for (const task of bundle.tasks) {
      expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    }
    expect(getCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY)).toBeNull();
    const runs = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get();
    expect(runs?.n).toBe(0);
  });

  test("enabled: the daily task fires the due-gate and the decay task schedules a check", async () => {
    createOpenLoop(
      db,
      { id: "loop_1", createdByRun: "r", title: "t", confidence: 1, importance: 1 },
      1000,
    );
    const bundle = makeBundle();
    const [daily, , decay] = bundle.tasks;
    expect(await daily!.run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(getCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY)).not.toBeNull();
    expect(await decay!.run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    const decayRuns = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE dedupe_key LIKE 'decay:loop:%'")
      .get();
    expect(decayRuns?.n).toBe(1);
    // Second ticks are idle: the day is handled and the dirty-mark clean.
    expect(await daily!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(await decay!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
  });

  test("re-verification task: knob-gated per tick — off (or absent) idles, on drives the sweep", async () => {
    createDocAnnotation(
      db,
      {
        id: "anno_due",
        docId: "doc_subject",
        claimType: "topic",
        claimText: "a stale claim",
        evidenceDocId: "doc_evidence",
        evidenceQuote: "an invented quote",
        confidence: 0.6,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      Date.now() - 60 * 24 * 3_600_000,
    );
    let enabled = false;
    const writeGate = {
      enqueueCognitionRun: async (input: Parameters<typeof enqueueCognitionRun>[1], now: number) =>
        enqueueCognitionRun(db, input, now),
      cancelPendingCognitionRuns: async (keys: string[]) =>
        cancelPendingCognitionRunsByDedupeKeys(db, keys),
      setCognitionEngineState: async (key: string, value: string) =>
        setCognitionEngineState(db, key, value),
    };
    const bundle = createCognitionRhythmTasks(
      {
        db,
        writeGate,
        log,
        isEnabled: () => true,
        getDailyRunHour: () => 5,
        getDecayBackoff: () => ({ backoffBaseMs: 100, backoffCapMs: 800 }),
        getReverificationSettings: () => ({
          enabled,
          intervalDays: 14,
          maxPerSweep: 2,
          batchSize: 4,
        }),
        clock: () => Date.now(),
      },
      schedulerStub,
    );
    const task = bundle.tasks.find((t) => t.name === "cognition.reverificationSweep");
    expect(task).toBeDefined();
    // Knob off → the tick idles without touching the queue (quiesce without restart).
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    let runs = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'verification'")
      .get();
    expect(runs?.n).toBe(0);
    // Knob on (re-read live) → the same task's next tick fires the sweep.
    enabled = true;
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    runs = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM cognition_runs WHERE kind = 'verification'")
      .get();
    expect(runs?.n).toBe(1);
  });

  test("provenance-recheck task: a disabled tick re-anchors an existing watermark to now", async () => {
    // The watermark a previous ENABLED phase left behind.
    setCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY, "1000");
    const writeGate = {
      enqueueCognitionRun: async (input: Parameters<typeof enqueueCognitionRun>[1], now: number) =>
        enqueueCognitionRun(db, input, now),
      cancelPendingCognitionRuns: async (keys: string[]) =>
        cancelPendingCognitionRunsByDedupeKeys(db, keys),
      setCognitionEngineState: async (key: string, value: string) =>
        setCognitionEngineState(db, key, value),
    };
    const bundle = createCognitionRhythmTasks(
      {
        db,
        writeGate,
        log,
        isEnabled: () => true,
        getDailyRunHour: () => 5,
        getDecayBackoff: () => ({ backoffBaseMs: 100, backoffCapMs: 800 }),
        getProvenanceRecheckSettings: () => ({ enabled: false }),
        clock: () => 5_000,
      },
      schedulerStub,
    );
    const task = bundle.tasks.find((t) => t.name === "cognition.provenanceRecheck");
    expect(task).toBeDefined();
    // Knob off → the tick idles AND slides the watermark to its now, so
    // deaths from the off window are never back-processed on re-enable.
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(getCognitionEngineState(db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY)).toBe("5000");
  });

  test("merge-adjudication task: knob-gated per tick — off idles, on enqueues per pending candidate", async () => {
    // Two invented persons whose email aliases form one pending candidate.
    const makePerson = (name: string, email: string): void => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO people
           (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
         VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
      ).run(id, name);
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'email', '2026-01-01')`,
      ).run(randomUUID(), id, email);
    };
    makePerson("Maya Reeves", "maya@example.com");
    makePerson("Maya R", "m.reeves@example.org");
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "maya@example.com" },
        sideB: { aliasType: "email", alias: "m.reeves@example.org" },
        score: 0.8,
        matchedTokens: ["maya"],
        detectionKind: "name_token_overlap",
        personA: "p-a",
        personB: "p-b",
      },
    ]);
    const candidate = listAllMergeCandidates(db, "pending")[0];
    expect(candidate).toBeDefined();
    let enabled = false;
    const bundle = createCognitionRhythmTasks(
      {
        db,
        writeGate: directWriteGate(db),
        log,
        isEnabled: () => true,
        getDailyRunHour: () => 5,
        getDecayBackoff: () => ({ backoffBaseMs: 100, backoffCapMs: 800 }),
        getMergeAdjudicationEnabled: () => enabled,
        clock: () => Date.now(),
      },
      schedulerStub,
    );
    const task = bundle.tasks.find((t) => t.name === "cognition.mergeAdjudication");
    expect(task).toBeDefined();
    // Knob off → the tick idles without touching the queue (quiesce without restart).
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(listCognitionRuns(db, { kinds: ["merge_adjudication"] })).toHaveLength(0);
    // Knob on (re-read live) → the same task's next tick enqueues the candidate's run.
    enabled = true;
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    const runs = listCognitionRuns(db, { kinds: ["merge_adjudication"] });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dedupeKey).toBe(`merge-adjudication:candidate:${candidate!.id}`);
  });

  test("bootstrap task: the shipped-on default is inert until the Brain's own gate opens", async () => {
    // `brain.bootstrap.enabled` ships on, so the Brain gate (experimental
    // mode plus a runnable background-agent model) is the only thing between
    // an operator who never enabled the Brain and a corpus-wide retrospective
    // pass. Read the default from the resolver rather than restating it, so
    // this stays honest if the shipped value moves.
    const resolved = resolveBrainSettings(undefined);
    expect(resolved.bootstrap.enabled).toBe(true);
    // The lane also waits to be started, which is a separate operator decision
    // from the gate. Record that here so the gate is genuinely the only thing
    // this test is holding the pass back with.
    db.prepare(
      "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("bootstrap_started_at", "1");
    let gateOpen = false;
    // The lane holds every pass for a window after process start. Compose the
    // tasks, then step past that window, so the gate is the only thing left
    // that can be holding the pass back.
    let clockMs = Date.now();
    const bundle = createCognitionRhythmTasks(
      {
        db,
        writeGate: directWriteGate(db),
        log,
        isEnabled: () => gateOpen,
        getDailyRunHour: () => 5,
        getDecayBackoff: () => ({ backoffBaseMs: 100, backoffCapMs: 800 }),
        getBootstrapSettings: () => ({
          ...resolved.bootstrap,
          recencyWindowMs: resolved.recencyWindowMs,
        }),
        clock: () => clockMs,
      },
      schedulerStub,
    );
    clockMs += BOOTSTRAP_BOOT_GRACE_MS + 1;
    const task = bundle.tasks.find((t) => t.name === "cognition.bootstrap");
    expect(task).toBeDefined();

    // Gate shut: the tick idles having touched neither the queue nor the
    // lane's durable state — the pass was never entered.
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(listCognitionRuns(db, { kinds: ["bootstrap"] })).toHaveLength(0);
    expect(getCognitionEngineState(db, COGNITION_BOOTSTRAP_STATE_KEY)).toBeNull();

    // Gate open: the same task, same settings, now runs the pass — which on
    // this empty corpus records the quiet state. That marker is the proof the
    // idle above came from the gate and not from an inert task.
    gateOpen = true;
    expect(await task!.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
    expect(getCognitionEngineState(db, COGNITION_BOOTSTRAP_STATE_KEY)).toBe("drained");
  });
});
