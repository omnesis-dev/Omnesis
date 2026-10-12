// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The observation retention rhythm task: closed observations older than the
 * retention window are reduced to outcome records in bounded batches, open
 * observations are never pruned, and the task idles when it is off, has no
 * retention setting, or finds nothing to prune.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import {
  createObservation,
  getObservation,
  listObservationOutcomes,
  transitionObservation,
} from "../storage/observations.js";
import { createCognitionRhythmTasks, type CognitionRhythmOpts } from "./rhythm-tasks.js";
import type Database from "better-sqlite3";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { TaskContext } from "../../scheduler/types.js";

const log = createLogger("test:observation-retention");
const taskCtx = { signal: new AbortController().signal } as TaskContext;
const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const DAY = 86_400_000;

let path: string;
let db: Database.Database;

function retentionTask(
  opts: {
    enabled?: boolean;
    days?: number | undefined;
    prune?: CognitionRhythmOpts["writeGate"]["pruneClosedObservations"];
  } = {},
) {
  const gate = directWriteGate(db);
  const writeGate = {
    ...gate,
    ...(opts.prune ? { pruneClosedObservations: opts.prune } : {}),
  } as unknown as CognitionRhythmOpts["writeGate"];
  const days = "days" in opts ? opts.days : 90;
  const bundle = createCognitionRhythmTasks(
    {
      db,
      writeGate,
      log,
      isEnabled: () => opts.enabled ?? true,
      getDailyRunHour: () => 5,
      getDecayBackoff: () => ({
        backoffBaseMs: 100,
        backoffCapMs: 800,
        datedFloorMs: 100,
        datedFraction: 0.5,
      }),
      ...(days !== undefined ? { getObservationRetentionDays: () => days } : {}),
      clock: () => NOW,
    },
    {} as unknown as Scheduler,
  );
  const task = bundle.tasks.find((t) => t.name === "cognition.observationRetention");
  if (!task) throw new Error("retention task missing");
  return task;
}

function closed(id: string, closedAt: number, state: "shipped" | "dropped" = "dropped"): void {
  createObservation(db, { id, createdByRun: "r", summary: `Closed ${id}` }, closedAt - DAY);
  transitionObservation(
    db,
    id,
    state === "shipped"
      ? { state, shipped: { conversationId: "conv", messageId: "msg" } }
      : { state, reason: "expired" },
    closedAt,
  );
}

const outcomeIds = () =>
  listObservationOutcomes(db, 1000)
    .map((o) => o.id)
    .sort();

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("observation retention task", () => {
  test("prunes closed observations at or beyond 90 days into outcome records", async () => {
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("gmail-test"),
        externalId: "e1",
        title: "Invented notice",
        content: "Body",
        contentHash: "h-e1",
        sourceCreatedAt: "2026-06-01T09:00:00.000Z",
        sourceUpdatedAt: "2026-06-01T09:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    const doc = db.prepare<[], { id: string }>("SELECT id FROM documents").get()!.id;
    createObservation(
      db,
      {
        id: "obs_cited",
        createdByRun: "r",
        summary: "One two three four five six seven eight nine ten",
        citations: [doc],
        notedScores: { alreadyKnown: 0, consequence: 4, timing: 3, modelId: "m", at: 1 },
        wouldPushAt: NOW - 120 * DAY,
      },
      NOW - 121 * DAY,
    );
    transitionObservation(
      db,
      "obs_cited",
      { state: "shipped", shipped: { conversationId: "conv", messageId: "msg" } },
      NOW - 100 * DAY,
    );
    closed("obs_boundary", NOW - 90 * DAY);
    closed("obs_recent", NOW - 89 * DAY);

    expect(await retentionTask().run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(outcomeIds()).toEqual(["obs_boundary", "obs_cited"]);
    expect(getObservation(db, "obs_cited")).toBeNull();
    expect(getObservation(db, "obs_recent")).not.toBeNull();
    const cited = listObservationOutcomes(db).find((o) => o.id === "obs_cited")!;
    expect(cited).toMatchObject({
      topic: "One two three four five six seven eight",
      sourceKinds: ["google/gmail-test"],
      state: "shipped",
      wouldPushAt: NOW - 120 * DAY,
      prunedAt: NOW,
      notedScores: { consequence: 4, timing: 3 },
    });
  });

  test("open observations are never pruned, however old", async () => {
    createObservation(db, { id: "obs_live", createdByRun: "r", summary: "Live" }, NOW - 400 * DAY);
    createObservation(db, { id: "obs_held", createdByRun: "r", summary: "Held" }, NOW - 400 * DAY);
    transitionObservation(db, "obs_held", { state: "held", reason: "below_bar" }, NOW - 300 * DAY);
    expect(await retentionTask().run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(outcomeIds()).toEqual([]);
    expect(getObservation(db, "obs_live")?.state).toBe("live");
    expect(getObservation(db, "obs_held")?.state).toBe("held");
  });

  test("prunes in bounded batches until nothing is left, then idles", async () => {
    for (let i = 0; i < 205; i++) closed(`obs_${String(i).padStart(3, "0")}`, NOW - 200 * DAY + i);
    const task = retentionTask();
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(outcomeIds()).toHaveLength(200);
    // Oldest first: the five newest remain for the next tick.
    expect(getObservation(db, "obs_204")).not.toBeNull();
    expect(getObservation(db, "obs_000")).toBeNull();
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
    expect(outcomeIds()).toHaveLength(205);
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: true } });
  });

  test("honours a shorter configured window", async () => {
    closed("obs_ten", NOW - 10 * DAY);
    expect(await retentionTask({ days: 30 }).run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(await retentionTask({ days: 7 }).run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(outcomeIds()).toEqual(["obs_ten"]);
  });

  test("idles without pruning when disabled or when no retention is configured", async () => {
    closed("obs_old", NOW - 200 * DAY);
    expect(await retentionTask({ enabled: false }).run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(await retentionTask({ days: undefined }).run(undefined, taskCtx)).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(outcomeIds()).toEqual([]);
  });

  test("a failing prune is reported as not idle and does not throw", async () => {
    const task = retentionTask({
      prune: () => Promise.reject(new Error("writer unavailable")),
    });
    expect(await task.run(undefined, taskCtx)).toEqual({ kind: "done", value: { idle: false } });
  });
});
