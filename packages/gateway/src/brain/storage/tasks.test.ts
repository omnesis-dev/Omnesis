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
import { listInterestSignals, listLiveInterestSignals, recordTaskInterest } from "./interest.js";
import {
  applyTaskCommand,
  autoApplyTaskChange,
  isTaskSchedule,
  proposeTaskChange,
  readTaskAuthorship,
  userAuthoredTaskFields,
  withdrawTaskProposal,
  type AutoAppliedTaskChange,
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
    expect(apply({ kind: "complete", id: loopId })).toMatchObject({
      ok: false,
      reason: "already_done",
    });
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

  function seedTaskDocument(id: string) {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'p', 's', ?, 'Garden reference', 'body', 'h', ?, ?, ?, ?)`,
    ).run(id, id, ...Array(4).fill(new Date(NOW).toISOString()));
  }

  test("editing task documents replaces and deduplicates attachments, and undo restores them", () => {
    seedTaskDocument("doc_original");
    seedTaskDocument("doc_plan");
    seedTaskDocument("doc_quote");
    const { loopId } = create("Prepare the garden plan", {
      docs: ["doc_original"],
      scheduledFor: "2026-03-12",
    });
    const edited = ok(
      apply({
        kind: "edit",
        id: loopId,
        fields: { docs: ["doc_plan", "doc_quote", "doc_plan"] },
      }),
    );
    expect(edited.loop).toMatchObject({
      docs: ["doc_plan", "doc_quote"],
      title: "Prepare the garden plan",
      scheduledFor: "2026-03-12",
    });
    expect(listOpenLoopLedger(db, loopId).at(-1)?.event).toMatchObject({
      kind: "edited",
      before: { docs: ["doc_original"] },
      fields: [],
    });
    expect(ok(apply({ kind: "undo", seq: edited.eventSeq! })).loop?.docs).toEqual(["doc_original"]);
  });

  test("task attachments can be cleared and restored by undo", () => {
    seedTaskDocument("doc_order");
    const { loopId } = create("Review the seed order", { docs: ["doc_order"] });
    const cleared = ok(apply({ kind: "edit", id: loopId, fields: { docs: [] } }));
    expect(cleared.loop?.docs).toEqual([]);
    expect(ok(apply({ kind: "undo", seq: cleared.eventSeq! })).loop?.docs).toEqual(["doc_order"]);
  });

  test("undo does not restore a document deleted after the task change", () => {
    seedTaskDocument("doc_removed");
    const { loopId } = create("Review the garden layout", { docs: ["doc_removed"] });
    const edited = ok(apply({ kind: "edit", id: loopId, fields: { docs: [] } }));
    db.prepare("DELETE FROM documents WHERE id = ?").run("doc_removed");
    expect(ok(apply({ kind: "undo", seq: edited.eventSeq! })).loop?.docs).toEqual([]);
  });

  test("undoing an older event without a document snapshot preserves attachments", () => {
    seedTaskDocument("doc_budget");
    const { loopId } = create("Review the garden budget", { docs: ["doc_budget"] });
    const edited = ok(
      apply({ kind: "edit", id: loopId, fields: { title: "Review the planting budget" } }),
    );
    const event = listOpenLoopLedger(db, loopId).at(-1)!.event!;
    delete event.before!.docs;
    db.prepare("UPDATE open_loop_ledger SET event_json = ? WHERE seq = ?").run(
      JSON.stringify(event),
      edited.eventSeq,
    );
    expect(ok(apply({ kind: "undo", seq: edited.eventSeq! })).loop).toMatchObject({
      title: "Review the garden budget",
      docs: ["doc_budget"],
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

  test("ignoring a suggestion keeps its loop open and tracked", () => {
    const loop = brainLoop();
    const result = ok(apply({ kind: "ignore", id: loop.id, reason: "not mine" }));
    expect(result.receipt).toBe(`Ignored: ${loop.title}`);
    expect(result.resolved).toBe(false);
    const after = getOpenLoop(db, loop.id)!;
    expect(after).toMatchObject({
      state: "open",
      accepted: false,
      ignored: true,
      resolvedAt: null,
    });
    // Decay checks still cover it like any other suggestion.
    expect(listDecayCandidateLoops(db).map((candidate) => candidate.id)).toContain(loop.id);
    expect(listOpenLoopLedger(db, loop.id).at(-1)?.event).toMatchObject({
      kind: "ignored",
      note: "not mine",
      before: { state: "open", ignored: false },
    });
    expect(apply({ kind: "ignore", id: loop.id })).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("only an open suggestion can be ignored", () => {
    const own = ok(create());
    expect(apply({ kind: "ignore", id: own.loopId })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    const struck = brainLoop("Return the borrowed ladder");
    ok(apply({ kind: "strike", id: struck.id }));
    expect(apply({ kind: "ignore", id: struck.id })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("undoing an ignore offers the suggestion again", () => {
    const loop = brainLoop();
    const seq = ok(apply({ kind: "ignore", id: loop.id })).eventSeq!;
    const undone = ok(apply({ kind: "undo", seq }));
    expect(undone.loop).toMatchObject({ state: "open", accepted: false, ignored: false });
  });

  test("accepting an ignored suggestion makes it the user's task again", () => {
    const loop = brainLoop();
    ok(apply({ kind: "ignore", id: loop.id }));
    const accepted = ok(apply({ kind: "accept", id: loop.id, scheduledFor: "2026-03" }));
    expect(accepted.loop).toMatchObject({
      accepted: true,
      ignored: false,
      scheduledFor: "2026-03",
    });
  });

  test("completing a suggestion marks it already done, and undo offers it again", () => {
    const loop = brainLoop();
    const result = ok(apply({ kind: "complete", id: loop.id }));
    expect(result.resolved).toBe(true);
    expect(result.loop).toMatchObject({ state: "done", accepted: true });
    const entry = listOpenLoopLedger(db, loop.id).at(-1)!;
    expect(entry.note).toBe("Already done");
    expect(entry.event?.kind).toBe("completed");
    const undone = ok(apply({ kind: "undo", seq: result.eventSeq! }));
    expect(undone.loop).toMatchObject({ state: "open", accepted: false, resolvedAt: null });
  });

  test("striking a suggestion records a strike", () => {
    const loop = brainLoop();
    ok(apply({ kind: "strike", id: loop.id }));
    expect(getOpenLoop(db, loop.id)!.state).toBe("dismissed");
    expect(listOpenLoopLedger(db, loop.id).at(-1)?.event?.kind).toBe("struck");
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

describe("Brain changes Omnesis applies on its own", () => {
  function acceptedSuggestion(description = "The plumber sent a quote.") {
    const loop = brainLoop();
    db.prepare("UPDATE open_loops SET description = ? WHERE id = ?").run(description, loop.id);
    ok(apply({ kind: "accept", id: loop.id }));
    return loop.id;
  }

  function change(id: string, extra: Partial<AutoAppliedTaskChange> = {}): AutoAppliedTaskChange {
    return {
      kind: "complete",
      reason: "The plumber confirmed the quote was accepted.",
      evidence: ["doc_reply"],
      runId: "run_2",
      basedOnSeq: readTaskAuthorship(db, id).latestEventSeq,
      ...extra,
    };
  }

  test("a completion closes the task with an auto_applied event, and undo reopens it", () => {
    const id = acceptedSuggestion();
    const applied = autoApplyTaskChange(db, id, change(id), NOW + 1000);
    expect(applied).toMatchObject({ applied: true, resolved: true });
    expect(getOpenLoop(db, id)).toMatchObject({ state: "done" });
    const entry = listOpenLoopLedger(db, id).at(-1)!;
    expect(entry.note).toBe(
      "Marked done by Omnesis: The plumber confirmed the quote was accepted.",
    );
    expect(entry.runId).toBe("run_2");
    expect(entry.event).toMatchObject({
      kind: "auto_applied",
      surface: "brain",
      note: "The plumber confirmed the quote was accepted.",
      change: { kind: "complete" },
      evidence: ["doc_reply"],
      before: { state: "open" },
    });

    const undone = ok(apply({ kind: "undo", seq: (applied as { seq: number }).seq }, NOW + 2000));
    expect(undone).toMatchObject({ reopened: true, loop: { state: "open" } });
    // Undoing it makes the state the user's: Omnesis never closes it on its own again.
    expect(readTaskAuthorship(db, id).authored.has("state")).toBe(true);
  });

  test("an edit sets only the fields it names, and undo restores them", () => {
    const id = acceptedSuggestion("The plumber sent a quote.");
    const result = autoApplyTaskChange(
      db,
      id,
      change(id, {
        kind: "edit",
        fields: {
          title: "Accept the plumber's quote",
          description: "The plumber sent a quote. It is valid until Friday.",
          deadline: { type: "by", date: "2026-03-13" },
        },
      }),
      NOW + 1000,
    );
    expect(result).toMatchObject({ applied: true, resolved: false });
    expect(getOpenLoop(db, id)).toMatchObject({
      state: "open",
      title: "Accept the plumber's quote",
      description: "The plumber sent a quote. It is valid until Friday.",
      deadline: { type: "by", date: "2026-03-13" },
    });
    const event = listOpenLoopLedger(db, id).at(-1)!.event!;
    expect(event.change).toEqual({ kind: "edit", fields: ["title", "description", "deadline"] });
    expect(listOpenLoopLedger(db, id).at(-1)!.note).toMatch(/^Updated by Omnesis: /);

    ok(apply({ kind: "undo", seq: listOpenLoopLedger(db, id).at(-1)!.seq }, NOW + 2000));
    expect(getOpenLoop(db, id)).toMatchObject({
      title: "Reply to the plumber about the quote",
      description: "The plumber sent a quote.",
      deadline: null,
    });
    expect([...readTaskAuthorship(db, id).authored].sort()).toEqual([
      "deadline",
      "description",
      "title",
    ]);
  });

  test("an applied change supersedes the proposal waiting on the task", () => {
    const id = acceptedSuggestion();
    const proposal = {
      kind: "edit" as const,
      fields: { title: "Call the plumber" },
      reason: "An older source.",
      evidence: [],
      runId: "run_1",
      proposedAt: NOW + 100,
    };
    expect(proposeTaskChange(db, id, proposal, NOW + 100)).toBe(true);
    const edit = change(id, {
      kind: "edit",
      fields: { description: "The quote is valid until Friday." },
    });
    expect(autoApplyTaskChange(db, id, edit, NOW + 1000)).toMatchObject({ applied: true });
    expect(getOpenLoop(db, id)!.proposedChange).toBeNull();
  });

  test("a waiting proposal is withdrawn only while it is still the one recorded", () => {
    const id = acceptedSuggestion();
    const proposal = {
      kind: "edit" as const,
      fields: { title: "Call the plumber" },
      reason: "An older source.",
      evidence: [],
      runId: "run_1",
      proposedAt: NOW + 100,
    };
    proposeTaskChange(db, id, proposal, NOW + 100);
    expect(withdrawTaskProposal(db, id, NOW + 99)).toBe(false);
    expect(getOpenLoop(db, id)!.proposedChange).not.toBeNull();
    expect(withdrawTaskProposal(db, id, NOW + 100)).toBe(true);
    expect(getOpenLoop(db, id)!.proposedChange).toBeNull();
  });

  test("a task that changed after the change was judged is left alone", () => {
    const id = acceptedSuggestion();
    const judged = change(id);
    ok(apply({ kind: "edit", id, fields: { title: "Reply to the plumber today" } }, NOW + 500));
    expect(autoApplyTaskChange(db, id, judged, NOW + 1000)).toEqual({
      applied: false,
      reason: "stale",
    });
    expect(getOpenLoop(db, id)?.state).toBe("open");
  });

  test("only the user's own open tasks change", () => {
    const suggestion = brainLoop();
    expect(autoApplyTaskChange(db, suggestion.id, change(suggestion.id), NOW)).toEqual({
      applied: false,
      reason: "not_owned",
    });
    expect(autoApplyTaskChange(db, "loop_missing", change("loop_missing"), NOW)).toEqual({
      applied: false,
      reason: "not_found",
    });
    const id = acceptedSuggestion();
    ok(apply({ kind: "complete", id }, NOW + 500));
    expect(autoApplyTaskChange(db, id, change(id), NOW + 1000)).toEqual({
      applied: false,
      reason: "invalid",
    });
    expect(
      autoApplyTaskChange(db, id, change(id, { kind: "edit", fields: {} }), NOW + 1000),
    ).toEqual({ applied: false, reason: "invalid" });
  });
});

describe("userAuthoredTaskFields", () => {
  test("a task the user created owns what they gave it", () => {
    const { loopId } = create("Book the bike service");
    expect([...readTaskAuthorship(db, loopId).authored]).toEqual(["title"]);
    const withDetails = create("Book the bike service", {
      description: "Brakes squeak.",
      deadline: { type: "by", date: "2026-03-20" },
    });
    expect([...readTaskAuthorship(db, withDetails.loopId).authored].sort()).toEqual([
      "deadline",
      "description",
      "title",
    ]);
  });

  test("an accepted suggestion owns only what the user edited or reopened", () => {
    const loop = brainLoop();
    ok(apply({ kind: "accept", id: loop.id }));
    expect(readTaskAuthorship(db, loop.id).authored.size).toBe(0);
    ok(apply({ kind: "edit", id: loop.id, fields: { description: "Ask about Thursday." } }));
    expect([...readTaskAuthorship(db, loop.id).authored]).toEqual(["description"]);
    ok(apply({ kind: "complete", id: loop.id }));
    ok(apply({ kind: "reopen", id: loop.id }));
    expect([...readTaskAuthorship(db, loop.id).authored].sort()).toEqual(["description", "state"]);
  });

  test("events recorded before fields were tracked count as setting every field", () => {
    expect(
      [
        ...userAuthoredTaskFields([
          { seq: 1, event: { kind: "created", surface: "tasks" } },
          { seq: 2, event: null },
        ]),
      ].sort(),
    ).toEqual(["deadline", "description", "title"]);
    expect(
      [...userAuthoredTaskFields([{ seq: 3, event: { kind: "edited", surface: "note" } }])].sort(),
    ).toEqual(["deadline", "description", "title"]);
  });

  test("undoing a user change does not hand its field back", () => {
    const loop = brainLoop();
    ok(apply({ kind: "accept", id: loop.id }));
    const edited = ok(apply({ kind: "edit", id: loop.id, fields: { title: "Call the plumber" } }));
    ok(apply({ kind: "undo", seq: edited.eventSeq! }));
    expect([...readTaskAuthorship(db, loop.id).authored]).toEqual(["title"]);
  });
});

describe("interest signals from task events", () => {
  test("a command with recordInterest false records nothing new but an undo still takes a signal back", () => {
    const created = apply({
      kind: "create",
      id: "loop_quiet",
      title: "Quiet task",
      origin: "user",
    });
    expect(created.ok).toBe(true);
    expect(listLiveInterestSignals(db)).toHaveLength(1);
    const ignoredBrain = createOpenLoop(
      db,
      { id: "loop_sugg", createdByRun: "run", title: "A suggestion", confidence: 1, importance: 1 },
      NOW,
    );
    const quiet = { recordInterest: false };
    const ignored = applyTaskCommand(
      db,
      { ...ORIGIN, kind: "ignore", id: ignoredBrain.id },
      NOW,
      quiet,
    );
    expect(ignored.ok).toBe(true);
    expect(listLiveInterestSignals(db)).toHaveLength(1);
    const undone = applyTaskCommand(
      db,
      { ...ORIGIN, kind: "undo", seq: (created as { eventSeq: number }).eventSeq },
      NOW,
      quiet,
    );
    expect(undone.ok).toBe(true);
    expect(listLiveInterestSignals(db)).toHaveLength(0);
  });

  const live = () => listLiveInterestSignals(db, { limit: 50 });
  const all = () => listInterestSignals(db, { limit: 50 });

  test("creating a user task records one +1 task_created signal bound to the created event", () => {
    const result = create("Renew the passport", { description: "Before the Lisbon trip" });
    expect(all()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      polarity: 1,
      kind: "task",
      source: "task_created",
      subjectText: "Renew the passport\nBefore the Lisbon trip",
      note: null,
      loopId: result.loopId,
      ledgerSeq: result.eventSeq,
      createdAt: NOW,
    });
  });

  test("a task without a description is matched by its title alone", () => {
    create("Renew the passport");
    expect(live()[0]?.subjectText).toBe("Renew the passport");
  });

  test("a note-created task records +1 with the note's conversation", () => {
    ok(
      applyTaskCommand(
        db,
        {
          surface: "note",
          runId: "note:n1",
          conversationId: "conv_note",
          kind: "create",
          id: "loop_note_1",
          origin: "note",
          title: "Water the plants",
        },
        NOW,
      ),
    );
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      source: "task_created",
      polarity: 1,
      loopId: "loop_note_1",
      conversationId: "conv_note",
    });
  });

  test("a Brain suggestion records nothing when created", () => {
    const loop = brainLoop();
    expect(all()).toEqual([]);
    expect(
      recordTaskInterest(
        db,
        { loop, event: { kind: "created", surface: "brain" }, seq: 99, idGen: randomUUID },
        NOW,
      ),
    ).toBeNull();
    expect(all()).toEqual([]);
  });

  test("accepting a suggestion records +1 task_accepted", () => {
    const loop = brainLoop();
    const accepted = ok(apply({ kind: "accept", id: loop.id }));
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      polarity: 1,
      source: "task_accepted",
      subjectText: loop.title,
      loopId: loop.id,
      ledgerSeq: accepted.eventSeq,
    });
  });

  test("ignoring a suggestion with a reason records −1 task_ignored carrying the reason", () => {
    const loop = brainLoop();
    const ignored = ok(apply({ kind: "ignore", id: loop.id, reason: "The plumber already came" }));
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      polarity: -1,
      source: "task_ignored",
      note: "The plumber already came",
      loopId: loop.id,
      ledgerSeq: ignored.eventSeq,
    });
    const loop2 = brainLoop("Return the library books");
    ok(apply({ kind: "ignore", id: loop2.id }));
    expect(live().find((s) => s.loopId === loop2.id)?.note).toBeNull();
  });

  test("undoing an acceptance supersedes its signal and records no new one", () => {
    const loop = brainLoop();
    const accepted = ok(apply({ kind: "accept", id: loop.id }));
    ok(apply({ kind: "undo", seq: accepted.eventSeq! }, NOW + 500));
    expect(live()).toEqual([]);
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({ source: "task_accepted", supersededAt: NOW + 500 });
  });

  test("undoing an ignore supersedes its signal", () => {
    const loop = brainLoop();
    const ignored = ok(apply({ kind: "ignore", id: loop.id, reason: "not now" }));
    ok(apply({ kind: "undo", seq: ignored.eventSeq! }));
    expect(live()).toEqual([]);
    expect(all().map((s) => s.source)).toEqual(["task_ignored"]);
  });

  test("undoing a creation removes the creation's signal with the loop; deleting a task supersedes its signals", () => {
    const { eventSeq } = create("Renew the passport");
    expect(live()).toHaveLength(1);
    ok(apply({ kind: "undo", seq: eventSeq! }));
    expect(live()).toEqual([]);
    // The loop never existed as far as the owner is concerned: no history either.
    expect(all()).toEqual([]);
    const { loop } = create("Book the dentist");
    ok(apply({ kind: "delete", id: loop!.id }));
    expect(live()).toEqual([]);
    expect(all().map((s) => [s.source, s.supersededAt !== null])).toEqual([["task_created", true]]);
  });

  test("undoing an adoption records −1 task_adopt_undone and returns the loop to the suggestions", () => {
    const loop = createOpenLoop(
      db,
      {
        id: "loop_adopted",
        createdByRun: "run_gate",
        title: "Reply to the plumber about the quote",
        description: "They asked for a decision by Friday.",
        confidence: 0.8,
        importance: 0.6,
        proposal: { tier: "adopt", note: "Adopted" },
      },
      NOW,
    );
    expect(loop.accepted).toBe(true);
    const [adoption] = listOpenLoopLedger(db, loop.id);
    expect(adoption?.event?.kind).toBe("auto_accepted");
    expect(all()).toEqual([]);

    const undone = ok(apply({ kind: "undo", seq: adoption!.seq }, NOW + 1000));
    expect(getOpenLoop(db, loop.id)).toMatchObject({
      origin: "brain",
      accepted: false,
      ignored: false,
    });
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({
      polarity: -1,
      source: "task_adopt_undone",
      subjectText: "Reply to the plumber about the quote\nThey asked for a decision by Friday.",
      loopId: loop.id,
      ledgerSeq: undone.eventSeq,
      createdAt: NOW + 1000,
    });
  });

  test("strike, complete, edit and migrate record nothing", () => {
    const { loopId } = create("Renew the passport", { scheduledFor: "2026-03-12" });
    ok(apply({ kind: "edit", id: loopId, fields: { title: "Renew both passports" } }));
    ok(apply({ kind: "migrate", id: loopId, to: "2026-03-13" }));
    ok(apply({ kind: "complete", id: loopId }));
    ok(apply({ kind: "reopen", id: loopId }));
    ok(apply({ kind: "strike", id: loopId, reason: "no longer needed" }));
    expect(all().map((s) => s.source)).toEqual(["task_created"]);

    const suggestion = brainLoop();
    ok(apply({ kind: "strike", id: suggestion.id }));
    expect(all()).toHaveLength(1);
  });

  test("accepting an ignored suggestion supersedes the ignore and leaves one live accept", () => {
    const loop = brainLoop();
    ok(apply({ kind: "ignore", id: loop.id, reason: "not now" }));
    ok(apply({ kind: "accept", id: loop.id }, NOW + 10));
    expect(live().map((s) => s.source)).toEqual(["task_accepted"]);
    expect(all().map((s) => [s.source, s.supersededAt])).toEqual([
      ["task_accepted", null],
      ["task_ignored", NOW + 10],
    ]);
    // Once accepted it is the user's task, which cannot be ignored, only struck.
    expect(apply({ kind: "ignore", id: loop.id }, NOW + 20)).toMatchObject({ ok: false });
    expect(live().map((s) => s.source)).toEqual(["task_accepted"]);
  });
});
