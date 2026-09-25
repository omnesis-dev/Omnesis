// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Dismissal semantics (criterion 7's synchronous half): every dismissal
 * flips the brief's `dismissed_*` state and enqueues exactly one pending
 * feedback run carrying the brief id — atomically. Also pins the reason
 * model: kind-conditional reasons, snoozeUntil-only-with-snoozed,
 * terminal one-way-ness, and the fold of a re-dismissal into the still-
 * pending feedback run.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../db.js";
import {
  createBrief,
  getBrief,
  resurfaceDueSnoozedBriefs,
  setBriefState,
  type CreateBriefInput,
} from "./storage/briefs.js";
import { dismissBriefAndEnqueueFeedback, type DismissBriefInput } from "./feedback.js";
import { feedbackRunDedupeKey } from "./run-payloads.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

interface RunView {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  dedupeKey: string | null;
  nextAttemptAt: number;
}

function listCognitionRuns(db: Db): RunView[] {
  return db
    .prepare<
      [],
      {
        id: string;
        kind: string;
        status: string;
        payload_json: string;
        dedupe_key: string | null;
        next_attempt_at: number;
      }
    >("SELECT id, kind, status, payload_json, dedupe_key, next_attempt_at FROM cognition_runs")
    .all()
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      payload: JSON.parse(r.payload_json) as unknown,
      dedupeKey: r.dedupe_key,
      nextAttemptAt: r.next_attempt_at,
    }));
}

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function briefInput(over: Partial<CreateBriefInput> = {}): CreateBriefInput {
  return {
    id: over.id ?? `brf_${randomUUID()}`,
    createdByRun: over.createdByRun ?? "run_1",
    kind: over.kind ?? "loop",
    title: over.title ?? "Confirm the marathon entry went through",
    description: over.description ?? "The entry form looked submitted.",
    confidence: over.confidence ?? 0.7,
    urgency: over.urgency ?? 0.5,
    ...over,
  };
}

function dismiss(
  db: Db,
  over: Partial<DismissBriefInput> & { briefId: string },
  now = 2000,
): ReturnType<typeof dismissBriefAndEnqueueFeedback> {
  return dismissBriefAndEnqueueFeedback(
    db,
    {
      reason: "not_relevant",
      feedbackRunId: `run_${randomUUID()}`,
      ...over,
    },
    now,
  );
}

describe("dismissBriefAndEnqueueFeedback", () => {
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

  test("each reason maps to its dismissed_* state and stores the free text", () => {
    const cases = [
      { reason: "not_relevant", kind: "info", state: "dismissed_not_relevant" },
      { reason: "wrong", kind: "info", state: "dismissed_wrong" },
      { reason: "already_handled", kind: "loop", state: "dismissed_already_handled" },
      { reason: "acknowledged", kind: "info", state: "dismissed_acknowledged" },
      { reason: "snoozed", kind: "loop", state: "dismissed_snoozed" },
    ] as const;
    for (const c of cases) {
      const id = `brf_${c.reason}`;
      createBrief(db, briefInput({ id, kind: c.kind }), 1000);
      const res = dismiss(db, {
        briefId: id,
        reason: c.reason,
        feedback: "the deadline is actually the 20th",
      });
      expect(res.outcome, c.reason).toBe("dismissed");
      const brief = getBrief(db, id);
      expect(brief?.state, c.reason).toBe(c.state);
      expect(brief?.userFeedback).toBe("the deadline is actually the 20th");
    }
  });

  test("flip + enqueue are one unit: exactly one pending feedback run carrying the brief id", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    const res = dismiss(db, { briefId: "brf_1", feedbackRunId: "run_fb" });
    expect(res).toEqual({
      outcome: "dismissed",
      state: "dismissed_not_relevant",
      feedbackRunId: "run_fb",
    });
    const runs = listCognitionRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "run_fb",
      kind: "feedback",
      status: "pending",
      payload: { briefId: "brf_1" },
      dedupeKey: feedbackRunDedupeKey("brf_1"),
      nextAttemptAt: 2000, // ASAP — claimable at dismissal time
    });
  });

  test("a snooze with a user-picked time carries it in the payload; without one it doesn't", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    dismiss(db, { briefId: "brf_1", reason: "snoozed", snoozeUntil: 9_000_000 });
    expect(listCognitionRuns(db)[0]?.payload).toEqual({
      briefId: "brf_1",
      snoozeUntil: 9_000_000,
    });

    createBrief(db, briefInput({ id: "brf_2" }), 1000);
    dismiss(db, { briefId: "brf_2", reason: "snoozed" });
    const run2 = listCognitionRuns(db).find(
      (r) => (r.payload as { briefId: string }).briefId === "brf_2",
    );
    expect(run2?.payload).toEqual({ briefId: "brf_2" });
  });

  test("a user-picked snooze persists next_show durably at dismissal; agent-decides leaves it null", () => {
    createBrief(db, briefInput({ id: "brf_pick" }), 1000);
    dismiss(db, { briefId: "brf_pick", reason: "snoozed", snoozeUntil: 9_000_000 });
    const picked = getBrief(db, "brf_pick");
    expect(picked?.state).toBe("dismissed_snoozed");
    expect(picked?.nextShow).toBe(9_000_000);

    createBrief(db, briefInput({ id: "brf_agent" }), 1000);
    dismiss(db, { briefId: "brf_agent", reason: "snoozed" });
    const agentDecides = getBrief(db, "brf_agent");
    expect(agentDecides?.state).toBe("dismissed_snoozed");
    expect(agentDecides?.nextShow).toBeNull();
  });

  test("the resurface sweep returns due user-picked snoozes to unread, independent of the feedback run", () => {
    createBrief(db, briefInput({ id: "brf_due" }), 1000);
    dismiss(db, { briefId: "brf_due", reason: "snoozed", snoozeUntil: 5000 }, 2000);
    createBrief(db, briefInput({ id: "brf_future" }), 1000);
    dismiss(db, { briefId: "brf_future", reason: "snoozed", snoozeUntil: 50_000 }, 2000);
    createBrief(db, briefInput({ id: "brf_plain" }), 1000);
    dismiss(db, { briefId: "brf_plain", reason: "not_relevant" }, 2000);

    // At now=6000 only the due snooze resurfaces; the future one and the
    // plain dismissal are untouched.
    expect(resurfaceDueSnoozedBriefs(db, 6000)).toBe(1);
    expect(getBrief(db, "brf_due")?.state).toBe("unread");
    expect(getBrief(db, "brf_future")?.state).toBe("dismissed_snoozed");
    expect(getBrief(db, "brf_plain")?.state).toBe("dismissed_not_relevant");

    // Idempotent — a second sweep at the same time resurfaces nothing.
    expect(resurfaceDueSnoozedBriefs(db, 6000)).toBe(0);
  });

  test("kind-conditional reasons are enforced: already_handled needs loop, acknowledged needs info", () => {
    createBrief(db, briefInput({ id: "brf_info", kind: "info" }), 1000);
    createBrief(db, briefInput({ id: "brf_loop", kind: "loop" }), 1000);
    expect(dismiss(db, { briefId: "brf_info", reason: "already_handled" }).outcome).toBe("invalid");
    expect(dismiss(db, { briefId: "brf_loop", reason: "acknowledged" }).outcome).toBe("invalid");
    // A refused dismissal changes nothing and enqueues nothing.
    expect(getBrief(db, "brf_info")?.state).toBe("unread");
    expect(getBrief(db, "brf_loop")?.state).toBe("unread");
    expect(listCognitionRuns(db)).toHaveLength(0);
  });

  test("snoozeUntil with a non-snooze reason is refused", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    const res = dismiss(db, { briefId: "brf_1", reason: "wrong", snoozeUntil: 9_000_000 });
    expect(res.outcome).toBe("invalid");
    expect(listCognitionRuns(db)).toHaveLength(0);
  });

  test("a terminal brief refuses re-dismissal — dismissals are one-way", () => {
    createBrief(db, briefInput({ id: "brf_1", kind: "loop" }), 1000);
    dismiss(db, { briefId: "brf_1", reason: "already_handled" });
    const res = dismiss(db, { briefId: "brf_1", reason: "wrong" });
    expect(res).toEqual({ outcome: "already_terminal", state: "dismissed_already_handled" });
    expect(getBrief(db, "brf_1")?.state).toBe("dismissed_already_handled");
    expect(listCognitionRuns(db)).toHaveLength(1); // only the first dismissal's run
  });

  test("a snoozed brief IS re-dismissable, and the pending feedback run folds (newest signal wins)", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    dismiss(db, { briefId: "brf_1", reason: "snoozed", snoozeUntil: 9_000_000 });
    const res = dismiss(db, { briefId: "brf_1", reason: "not_relevant" }, 3000);
    expect(res.outcome).toBe("dismissed");
    expect(getBrief(db, "brf_1")?.state).toBe("dismissed_not_relevant");
    const runs = listCognitionRuns(db);
    expect(runs).toHaveLength(1); // folded, not stacked
    expect(runs[0]?.payload).toEqual({ briefId: "brf_1" }); // snooze hint replaced
  });

  test("read briefs dismiss like unread ones", () => {
    createBrief(db, briefInput({ id: "brf_1" }), 1000);
    setBriefState(db, "brf_1", "read", 1100);
    expect(dismiss(db, { briefId: "brf_1" }).outcome).toBe("dismissed");
  });

  test("unknown brief → not_found, nothing enqueued", () => {
    expect(dismiss(db, { briefId: "brf_missing" })).toEqual({ outcome: "not_found" });
    expect(listCognitionRuns(db)).toHaveLength(0);
  });
});
