// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  createOpenLoop,
  getOpenLoop,
  listDecayCandidateLoops,
  listOpenLoopLedger,
} from "./open-loops.js";
import {
  applyTaskCommand,
  isTaskSchedule,
  proposeTaskChange,
  type TaskCommand,
  type TaskCommandResult,
} from "./tasks.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00Z");
const ORIGIN = { surface: "tasks", runId: "user:tasks" } as const;

let path: string;
let db: Database.Database;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

function apply(
  command: Omit<TaskCommand, "surface" | "runId"> & Record<string, unknown>,
  at = NOW,
) {
  return applyTaskCommand(db, { ...ORIGIN, ...command } as TaskCommand, at);
}

function ok(result: TaskCommandResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result;
}

function create(title = "Renew the library card", extra: Record<string, unknown> = {}) {
  return ok(apply({ kind: "create", id: `loop_${randomUUID()}`, origin: "user", title, ...extra }));
}

function brainLoop(title = "Reply to the plumber about the quote") {
  return createOpenLoop(
    db,
    { id: `loop_${randomUUID()}`, createdByRun: "run_1", title, confidence: 0.8, importance: 0.6 },
    NOW - 86_400_000,
  );
}

describe("isTaskSchedule", () => {
  test("accepts a day, a month and someday only", () => {
    expect(isTaskSchedule("2026-03-11")).toBe(true);
    expect(isTaskSchedule("2026-04")).toBe(true);
    expect(isTaskSchedule("someday")).toBe(true);
    expect(isTaskSchedule("next week")).toBe(false);
    expect(isTaskSchedule("2026-4-1")).toBe(false);
  });
});

describe("task commands", () => {
  test("create makes an owned user task with a created event", () => {
    const result = create("Book the bike service", { scheduledFor: "2026-03-12" });
    expect(result.loop).toMatchObject({
      origin: "user",
      accepted: true,
      state: "open",
      scheduledFor: "2026-03-12",
      confidence: 1,
    });
    expect(result.receipt).toBe("Added: Book the bike service");
    const [event] = listOpenLoopLedger(db, result.loopId);
    expect(event?.event).toMatchObject({ kind: "created", surface: "tasks" });
    expect(event?.seq).toBe(result.eventSeq);
  });

  test("a note-created task records its origin and conversation surface", () => {
    const result = ok(
      applyTaskCommand(
        db,
        {
          surface: "note",
          runId: "note:n1",
          kind: "create",
          id: "loop_note_1",
          origin: "note",
          title: "Water the plants",
        },
        NOW,
      ),
    );
    expect(result.loop?.origin).toBe("note");
    expect(listOpenLoopLedger(db, "loop_note_1")[0]?.runId).toBe("note:n1");
  });

  test("create refuses an invalid schedule", () => {
    const result = apply({
      kind: "create",
      id: "loop_x",
      origin: "user",
      title: "x",
      scheduledFor: "soon",
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(getOpenLoop(db, "loop_x")).toBeNull();
  });

  test("complete closes the task with its note and resolved time", () => {
    const { loopId } = create();
    const result = ok(apply({ kind: "complete", id: loopId, note: "renewed online" }, NOW + 1000));
    expect(result.resolved).toBe(true);
    expect(result.loop).toMatchObject({
      state: "done",
      completionNote: "renewed online",
      resolvedAt: NOW + 1000,
    });
    expect(apply({ kind: "complete", id: loopId })).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("migrate moves an open task and records from and to", () => {
    const { loopId } = create("Call the dentist", { scheduledFor: "2026-03-10" });
    const result = ok(apply({ kind: "migrate", id: loopId, to: "2026-04" }));
    expect(result.loop?.scheduledFor).toBe("2026-04");
    const latest = listOpenLoopLedger(db, loopId, { order: "desc", limit: 1 })[0];
    expect(latest?.event).toMatchObject({ kind: "migrated", from: "2026-03-10", to: "2026-04" });
    expect(apply({ kind: "migrate", id: loopId, to: "later" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("strike dismisses; a closed task can be reopened", () => {
    const { loopId } = create();
    ok(apply({ kind: "strike", id: loopId, reason: "no longer needed" }));
    expect(getOpenLoop(db, loopId)?.state).toBe("dismissed");
    const reopened = ok(apply({ kind: "reopen", id: loopId }));
    expect(reopened.reopened).toBe(true);
    expect(reopened.loop).toMatchObject({ state: "open", resolvedAt: null });
  });

  test("edit changes only the given fields and refuses an empty edit", () => {
    const { loopId } = create("Draft the newsletter", { description: "spring issue" });
    ok(apply({ kind: "edit", id: loopId, fields: { title: "Draft the spring newsletter" } }));
    expect(getOpenLoop(db, loopId)).toMatchObject({
      title: "Draft the spring newsletter",
      description: "spring issue",
    });
    expect(apply({ kind: "edit", id: loopId, fields: {} })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("a Brain suggestion is accepted before it can be scheduled or edited", () => {
    const loop = brainLoop();
    expect(apply({ kind: "migrate", id: loop.id, to: "2026-03-11" })).toMatchObject({
      ok: false,
      reason: "not_owned",
    });
    expect(apply({ kind: "edit", id: loop.id, fields: { title: "x" } })).toMatchObject({
      ok: false,
      reason: "not_owned",
    });
    const accepted = ok(apply({ kind: "accept", id: loop.id, scheduledFor: "2026-03-11" }));
    expect(accepted.loop).toMatchObject({
      origin: "brain",
      accepted: true,
      scheduledFor: "2026-03-11",
    });
    expect(apply({ kind: "accept", id: loop.id })).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("refusing a suggestion dismisses it as refused", () => {
    const loop = brainLoop();
    const result = ok(apply({ kind: "refuse", id: loop.id, reason: "not mine" }));
    expect(result.receipt).toBe(`Not for you: ${loop.title}`);
    expect(listOpenLoopLedger(db, loop.id).at(-1)?.event?.kind).toBe("refused");
  });

  test("unknown ids are not found", () => {
    expect(apply({ kind: "complete", id: "loop_missing" })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  test("delete removes the task", () => {
    const { loopId } = create();
    const result = ok(apply({ kind: "delete", id: loopId }));
    expect(result).toMatchObject({ loop: null, eventSeq: null, resolved: true });
    expect(getOpenLoop(db, loopId)).toBeNull();
  });
});

describe("undo", () => {
  test("undo restores every field the change replaced", () => {
    const { loopId } = create("Pay the parking fine", { scheduledFor: "2026-03-10" });
    const done = ok(apply({ kind: "complete", id: loopId, note: "paid" }));
    const undone = ok(apply({ kind: "undo", seq: done.eventSeq! }));
    expect(undone.reopened).toBe(true);
    expect(getOpenLoop(db, loopId)).toMatchObject({
      state: "open",
      completionNote: null,
      scheduledFor: "2026-03-10",
      resolvedAt: null,
    });
    expect(listOpenLoopLedger(db, loopId).at(-1)?.event).toMatchObject({
      kind: "undone",
      undoOf: done.eventSeq,
    });
  });

  test("only the latest change can be undone, and an undo cannot be undone", () => {
    const { loopId } = create();
    const moved = ok(apply({ kind: "migrate", id: loopId, to: "2026-03-20" }));
    const edited = ok(
      apply({ kind: "edit", id: loopId, fields: { title: "Renew the card online" } }),
    );
    expect(apply({ kind: "undo", seq: moved.eventSeq! })).toMatchObject({
      ok: false,
      reason: "not_latest",
    });
    const undone = ok(apply({ kind: "undo", seq: edited.eventSeq! }));
    expect(apply({ kind: "undo", seq: undone.eventSeq! })).toMatchObject({
      ok: false,
      reason: "nothing_to_undo",
    });
    // The undo is now the latest change, so the earlier move stays out of reach.
    expect(apply({ kind: "undo", seq: moved.eventSeq! })).toMatchObject({
      ok: false,
      reason: "not_latest",
    });
  });

  test("undoing a creation removes the task", () => {
    const { loopId, eventSeq } = create();
    const result = ok(apply({ kind: "undo", seq: eventSeq! }));
    expect(result.loop).toBeNull();
    expect(getOpenLoop(db, loopId)).toBeNull();
  });

  test("undoing an acceptance returns the loop to the suggestions", () => {
    const loop = brainLoop();
    const accepted = ok(apply({ kind: "accept", id: loop.id }));
    ok(apply({ kind: "undo", seq: accepted.eventSeq! }));
    expect(getOpenLoop(db, loop.id)).toMatchObject({ origin: "brain", accepted: false });
  });
});

describe("proposals", () => {
  const proposal = {
    reason: "The receipt for the fine arrived on 9 March.",
    evidence: ["doc_receipt"],
    runId: "run_brain",
    proposedAt: NOW,
  };

  test("a proposal leaves the task unchanged until confirmed", () => {
    const { loopId } = create("Pay the parking fine");
    expect(proposeTaskChange(db, loopId, { kind: "complete", ...proposal }, NOW)).toBe(true);
    expect(getOpenLoop(db, loopId)).toMatchObject({ state: "open" });
    expect(getOpenLoop(db, loopId)?.proposedChange).toMatchObject({ kind: "complete" });
    const confirmed = ok(apply({ kind: "confirm_proposal", id: loopId }));
    expect(confirmed.resolved).toBe(true);
    expect(getOpenLoop(db, loopId)).toMatchObject({ state: "done", proposedChange: null });
  });

  test("keep discards the proposal; undo brings it back", () => {
    const { loopId } = create("Draft the newsletter");
    proposeTaskChange(
      db,
      loopId,
      { kind: "edit", fields: { title: "Draft the summer newsletter" }, ...proposal },
      NOW,
    );
    const kept = ok(apply({ kind: "keep", id: loopId }));
    expect(getOpenLoop(db, loopId)).toMatchObject({
      title: "Draft the newsletter",
      proposedChange: null,
    });
    ok(apply({ kind: "undo", seq: kept.eventSeq! }));
    expect(getOpenLoop(db, loopId)?.proposedChange).toMatchObject({ kind: "edit" });
  });

  test("an edit proposal applies its fields when confirmed", () => {
    const { loopId } = create("Draft the newsletter");
    proposeTaskChange(
      db,
      loopId,
      {
        kind: "edit",
        fields: { title: "Draft the summer newsletter", scheduledFor: "2026-05" },
        ...proposal,
      },
      NOW,
    );
    ok(apply({ kind: "confirm_proposal", id: loopId }));
    expect(getOpenLoop(db, loopId)).toMatchObject({
      title: "Draft the summer newsletter",
      scheduledFor: "2026-05",
    });
  });

  test("proposals are only recorded on the user's own tasks", () => {
    const loop = brainLoop();
    expect(proposeTaskChange(db, loop.id, { kind: "strike", ...proposal }, NOW)).toBe(false);
    expect(proposeTaskChange(db, "loop_missing", { kind: "strike", ...proposal }, NOW)).toBe(false);
  });

  test("confirm and keep need a pending proposal", () => {
    const { loopId } = create();
    expect(apply({ kind: "confirm_proposal", id: loopId })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(apply({ kind: "keep", id: loopId })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("undo and later changes", () => {
  test("an undo keeps a proposal the Brain made after the change", () => {
    const { loopId } = create("Draft the newsletter");
    const edited = ok(
      apply({ kind: "edit", id: loopId, fields: { title: "Draft the spring newsletter" } }),
    );
    proposeTaskChange(
      db,
      loopId,
      {
        kind: "complete",
        reason: "Sent on Monday.",
        evidence: [],
        runId: "run_b",
        proposedAt: NOW,
      },
      NOW,
    );
    ok(apply({ kind: "undo", seq: edited.eventSeq! }));
    expect(getOpenLoop(db, loopId)).toMatchObject({
      title: "Draft the newsletter",
      proposedChange: { kind: "complete" },
    });
  });

  test("reopening a completed task clears its retirement trace", () => {
    const { loopId } = create("Return the projector");
    const done = ok(apply({ kind: "complete", id: loopId }));
    const traced = () =>
      db.prepare("SELECT COUNT(*) AS n FROM retired_loops WHERE id = ?").get(loopId) as {
        n: number;
      };
    expect(traced().n).toBe(1);
    ok(apply({ kind: "undo", seq: done.eventSeq! }));
    expect(traced().n).toBe(0);
  });
});

describe("decay", () => {
  test("the user's own tasks never decay; suggestions do", () => {
    const suggestion = brainLoop();
    const { loopId } = create();
    const accepted = brainLoop("Return the borrowed ladder");
    ok(apply({ kind: "accept", id: accepted.id }));
    const ids = listDecayCandidateLoops(db).map((loop) => loop.id);
    expect(ids).toContain(suggestion.id);
    expect(ids).not.toContain(loopId);
    expect(ids).not.toContain(accepted.id);
  });
});
