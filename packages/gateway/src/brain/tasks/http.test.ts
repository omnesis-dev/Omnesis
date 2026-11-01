// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP coverage for `/tasks*`: the journal views, task commands with their
 * receipts and undo, Brain suggestions and proposals, the documents a task
 * refers to, scopes, and that the routes are available without the Brain.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, ProviderId, SourceId, type Scope } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { proposeTaskChange } from "../storage/tasks.js";
import { createMutableClock } from "../virtual-clock.js";
import type { StatusCache } from "../../http/services/StatusCache.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T12:00:00");
const TODAY = "2026-03-10";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let admin: string;
let reader: string;
let statusCache: StatusCache;
const clock = createMutableClock(NOW);

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

async function call(method: string, path: string, body?: unknown, token = admin) {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const view = async (name: string, date = TODAY) =>
  (await call("GET", `/tasks?view=${name}&date=${date}`)).json;

async function addTask(title: string, extra: Record<string, unknown> = {}) {
  clock.set(clock() + 1_000);
  const res = await call("POST", "/tasks", { title, ...extra });
  expect(res.status).toBe(201);
  return res.json as { task: { id: string }; receipt: { text: string; undoSeq: number } };
}

const action = (id: string, body: Record<string, unknown>) =>
  call("POST", `/tasks/${id}/actions`, body);

beforeEach(() => {
  clock.set(NOW);
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  admin = mintToken([SCOPE_ADMIN]);
  reader = mintToken([SCOPE_READ]);
  // No Brain status: tasks must not depend on it.
  app = createServer(db, dbPath, {
    briefsClock: clock,
    onStatusCache: (cache) => {
      statusCache = cache;
    },
  });
});

afterEach(() => {
  statusCache.stop();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

describe("/tasks", () => {
  test("requires the admin scope", async () => {
    expect((await call("GET", "/tasks", undefined, reader)).status).toBe(403);
    expect((await call("POST", "/tasks", { title: "x" }, reader)).status).toBe(403);
  });

  test("validates the view, the date and the body", async () => {
    expect((await call("GET", "/tasks?view=week")).status).toBe(400);
    expect((await call("GET", "/tasks?date=10-03-2026")).status).toBe(400);
    expect((await call("POST", "/tasks", { title: "" })).status).toBe(400);
    expect((await call("POST", "/tasks", { title: "x", scheduledFor: "soon" })).status).toBe(400);
    const { task } = await addTask("Water the plants");
    expect((await action(task.id, { action: "migrate", to: "later" })).status).toBe(400);
    expect((await action(task.id, { action: "fly" })).status).toBe(400);
  });

  test("fields a newer app adds are ignored, not refused", async () => {
    const { task } = await addTask("Call the plumber", {
      priority: "high",
      deadline: { type: "by", date: TODAY, reminder: true },
    });
    expect((await action(task.id, { action: "complete", note: "Done", photo: null })).status).toBe(
      200,
    );
  });

  test("today shows open tasks newest first, then what was resolved today", async () => {
    const carried = await addTask("Return the library books", { scheduledFor: "2026-03-08" });
    const planned = await addTask("Call the garage", { scheduledFor: TODAY });
    const due = await addTask("Submit the grant form", {
      deadline: { type: "by", date: TODAY },
    });
    const later = await addTask("Plan the reunion", { scheduledFor: "2026-03-25" });
    const done = await addTask("Buy stamps", { scheduledFor: TODAY });
    await action(done.task.id, { action: "complete", note: "at the post office" });

    const today = await view("today");
    expect(today.tasks.map((t: { id: string }) => t.id)).toEqual([
      due.task.id,
      planned.task.id,
      carried.task.id,
      done.task.id,
    ]);
    expect(today.tasks[2]).toMatchObject({ carried: true, scheduledFor: "2026-03-08" });
    expect(today.tasks[3]).toMatchObject({ state: "done", completionNote: "at the post office" });
    expect(today.counts).toMatchObject({ carried: 1, suggested: 0, proposals: 0 });
    expect((await view("month")).tasks.map((t: { id: string }) => t.id)).toEqual([later.task.id]);
  });

  test("today orders by creation, including carried tasks, without promoting recently edited tasks", async () => {
    const overdue = await addTask("Check the display frame", {
      deadline: { type: "by", date: "2026-03-09" },
    });
    const planned = await addTask("Label the seed trays", { scheduledFor: TODAY });
    const carried = await addTask("Check the garden timer", { scheduledFor: "2026-03-09" });
    const newestCarried = await addTask("Print the star chart", { scheduledFor: "2026-02" });
    const newest = await addTask("Sort the blue tokens", { scheduledFor: TODAY });
    clock.set(clock() + 60_000);
    expect(
      (await action(planned.task.id, { action: "edit", title: "Label the seed trays carefully" }))
        .status,
    ).toBe(200);
    // Moving an old task onto today also leaves its creation order intact.
    expect((await action(overdue.task.id, { action: "migrate", to: TODAY })).status).toBe(200);

    const today = await view("today");
    expect(today.tasks.map((task: { id: string }) => task.id)).toEqual([
      newest.task.id,
      newestCarried.task.id,
      carried.task.id,
      planned.task.id,
      overdue.task.id,
    ]);
    expect(today.tasks.map((task: { carried: boolean }) => task.carried)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(Date.parse(today.tasks[3].lastUpdate)).toBeGreaterThan(
      Date.parse(today.tasks[0].createdAt),
    );
  });

  test("today uses a stable task ID order when creation instants match", async () => {
    for (const [id, scheduledFor] of [
      ["loop_z", "2026-03-09"],
      ["loop_a", TODAY],
    ] as const) {
      createOpenLoop(
        db,
        {
          id,
          scheduledFor,
          createdByRun: "user:fixture",
          title: "Sort the display tokens",
          origin: "user",
          confidence: 1,
          importance: 0,
        },
        NOW,
      );
    }
    const ids = async () => (await view("today")).tasks.map((task: { id: string }) => task.id);
    expect(await ids()).toEqual(["loop_a", "loop_z"]);
    expect(await ids()).toEqual(["loop_a", "loop_z"]);
  });

  test("month, future, anytime and done place tasks by schedule and deadline", async () => {
    const month = await addTask("Renew the passport", { scheduledFor: "2026-03" });
    const nextMonth = await addTask("Book the summer trip", { scheduledFor: "2026-04" });
    const someday = await addTask("Learn the cello", { scheduledFor: "someday" });
    const anytime = await addTask("Tidy the shed");
    const dueLater = await addTask("Pay the annual dues", {
      deadline: { type: "by", date: "2026-06-30" },
    });
    const ids = (tasks: Array<{ id: string }>) => tasks.map((t) => t.id).sort();
    expect(ids((await view("month")).tasks)).toEqual([month.task.id]);
    expect(ids((await view("future")).tasks)).toEqual(
      [nextMonth.task.id, someday.task.id, dueLater.task.id].sort(),
    );
    expect(ids((await view("anytime")).tasks)).toEqual([anytime.task.id]);
    // Every view counts its open tasks, read with any view or on their own.
    const counts = { today: 0, month: 1, future: 3, anytime: 1, waiting: 0 };
    expect((await view("done")).counts).toMatchObject(counts);
    const alone = await call("GET", `/tasks/counts?date=${TODAY}`);
    expect(alone.status).toBe(200);
    expect(alone.json).toMatchObject({ day: TODAY, counts });

    await action(anytime.task.id, { action: "strike" });
    expect(ids((await view("done")).tasks)).toEqual([anytime.task.id]);
    expect((await call("GET", `/tasks/counts?date=${TODAY}`)).json.counts.anytime).toBe(0);
    expect((await call("GET", "/tasks/counts?date=tomorrow")).status).toBe(400);
  });

  test("no read is cacheable, so a client never shows a task as it was", async () => {
    for (const path of [`/tasks?view=today&date=${TODAY}`, `/tasks/counts?date=${TODAY}`]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${admin}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("a command returns a receipt whose undo reverts it", async () => {
    const { task } = await addTask("Order the birthday cake", { scheduledFor: TODAY });
    const moved = await action(task.id, { action: "migrate", to: "2026-03-11" });
    expect(moved.status).toBe(200);
    expect(moved.json.receipt.text).toBe("Moved to Wed 11 Mar: Order the birthday cake");
    expect((await view("today")).tasks).toHaveLength(0);
    const undone = await call("POST", "/tasks/undo", { seq: moved.json.receipt.undoSeq });
    expect(undone.status).toBe(200);
    expect(undone.json.task.scheduledFor).toBe(TODAY);
    expect((await call("POST", "/tasks/undo", { seq: moved.json.receipt.undoSeq })).status).toBe(
      409,
    );
  });

  test("completing a task that is already done is refused with its own code", async () => {
    const { task } = await addTask("Return the library books", { scheduledFor: TODAY });
    expect((await action(task.id, { action: "complete" })).status).toBe(200);
    const again = await action(task.id, { action: "complete" });
    expect(again.status).toBe(400);
    expect(again.json).toMatchObject({
      code: "TASK_ALREADY_DONE",
      error: "the task is already done",
    });
    // Other refusals keep the generic code.
    const moved = await action(task.id, { action: "migrate", to: "2026-03-11" });
    expect(moved.json).toMatchObject({ code: "BAD_REQUEST" });
  });

  test("a task's history lists every change with its surface", async () => {
    const { task } = await addTask("Fix the gate latch");
    await action(task.id, { action: "edit", title: "Fix the garden gate latch" });
    await action(task.id, { action: "complete" });
    const detail = await call("GET", `/tasks/${task.id}`);
    expect(detail.json.task.title).toBe("Fix the garden gate latch");
    expect(detail.json.history.map((e: { kind: string }) => e.kind)).toEqual([
      "completed",
      "edited",
      "created",
    ]);
    expect(detail.json.history[0].surface).toBe("tasks");
    expect(detail.json.undoSeq).toBe(detail.json.history[0].seq);
    expect((await call("GET", "/tasks/loop_missing")).status).toBe(404);
  });

  test("Brain suggestions appear only under Suggested until accepted", async () => {
    const suggestion = createOpenLoop(
      db,
      {
        id: "loop_suggested",
        createdByRun: "run_1",
        title: "Reply to Maya Reeves about the venue",
        confidence: 0.8,
        importance: 0.7,
        deadline: { type: "by", date: TODAY },
      },
      NOW - 3_600_000,
    );
    expect((await view("today")).tasks).toHaveLength(0);
    const suggested = await view("suggested");
    expect(suggested.tasks.map((t: { id: string }) => t.id)).toEqual([suggestion.id]);
    expect(suggested.counts.suggested).toBe(1);
    expect((await action(suggestion.id, { action: "migrate", to: TODAY })).status).toBe(409);

    const accepted = await action(suggestion.id, { action: "accept", scheduledFor: TODAY });
    expect(accepted.json.receipt.text).toBe(
      "Added to your tasks: Reply to Maya Reeves about the venue",
    );
    expect((await view("suggested")).tasks).toHaveLength(0);
    expect((await view("today")).tasks.map((t: { id: string }) => t.id)).toEqual([suggestion.id]);
  });

  function brainSuggestion(id: string, title: string) {
    createOpenLoop(db, { id, createdByRun: "run_1", title, confidence: 0.5, importance: 0.2 }, NOW);
  }

  test("ignoring a suggestion takes it out of Tasks while its loop stays open", async () => {
    brainSuggestion("loop_ignore", "Sign up for the newsletter");
    expect((await call("GET", `/tasks/counts?date=${TODAY}`)).json.counts.suggested).toBe(1);
    const ignored = await action("loop_ignore", { action: "ignore", reason: "not interested" });
    expect(ignored.status).toBe(200);
    expect(ignored.json.task).toMatchObject({ state: "open", accepted: false, ignored: true });
    expect(ignored.json.receipt.text).toBe("Ignored: Sign up for the newsletter");
    expect((await view("suggested")).tasks).toHaveLength(0);
    expect((await view("done")).tasks).toHaveLength(0);
    expect((await call("GET", `/tasks/counts?date=${TODAY}`)).json.counts.suggested).toBe(0);
    const detail = await call("GET", "/tasks/loop_ignore");
    expect(detail.json.history[0]).toMatchObject({
      kind: "ignored",
      note: "Ignored: not interested",
    });

    const undone = await call("POST", "/tasks/undo", { seq: ignored.json.receipt.undoSeq });
    expect(undone.json.task).toMatchObject({ state: "open", ignored: false });
    expect((await view("suggested")).tasks.map((t: { id: string }) => t.id)).toEqual([
      "loop_ignore",
    ]);
  });

  test("an older app's refuse ignores the suggestion", async () => {
    brainSuggestion("loop_legacy", "Join the book club mailing list");
    const res = await action("loop_legacy", { action: "refuse" });
    expect(res.json.task).toMatchObject({ state: "open", ignored: true });
    expect((await view("suggested")).tasks).toHaveLength(0);
  });

  test("a suggestion accepted with a note is planned and leaves a note about it", async () => {
    brainSuggestion("loop_note", "Book the bike service");
    const noteId = randomUUID();
    const res = await action("loop_note", {
      action: "accept",
      scheduledFor: "2026-03-14",
      note: "the rear brake squeaks too",
      noteId,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      noteId,
      task: { accepted: true, scheduledFor: "2026-03-14" },
      receipt: { text: "Added to your tasks: Book the bike service" },
    });
    const notes = (await call("GET", "/notes?day=2026-03-10", undefined, reader)).json
      .entries as Array<{
      id: string;
      text: string;
      taskId?: string;
    }>;
    expect(notes.find((note) => note.id === noteId)).toMatchObject({
      text: "This is a note about the task “Book the bike service”: the rear brake squeaks too",
      taskId: "loop_note",
    });
    // The same request again is a replay, not a conflict.
    const again = await action("loop_note", {
      action: "accept",
      note: "the rear brake squeaks too",
      noteId,
    });
    expect(again.status).toBe(200);
    expect(
      ((await call("GET", "/notes?day=2026-03-10", undefined, reader)).json.entries as unknown[])
        .length,
    ).toBe(notes.length);
    expect((await action("loop_note", { action: "accept", note: "  " })).status).toBe(400);
  });

  test("a suggestion that is already done is completed straight away", async () => {
    brainSuggestion("loop_done", "Pay the gym membership");
    const res = await action("loop_done", { action: "complete" });
    expect(res.json.task).toMatchObject({ state: "done", accepted: true });
    expect((await view("suggested")).tasks).toHaveLength(0);
    expect((await view("done")).tasks.map((t: { id: string }) => t.id)).toEqual(["loop_done"]);
    const undone = await call("POST", "/tasks/undo", { seq: res.json.receipt.undoSeq });
    expect(undone.json.task).toMatchObject({ state: "open", accepted: false });
    expect((await view("suggested")).tasks.map((t: { id: string }) => t.id)).toEqual(["loop_done"]);
  });

  test("a proposal is shown on the task and confirmed or kept by the user", async () => {
    const { task } = await addTask("Pay the water bill", { scheduledFor: TODAY });
    proposeTaskChange(
      db,
      task.id,
      {
        kind: "complete",
        reason: "A payment confirmation arrived this morning.",
        evidence: ["doc_payment"],
        runId: "run_brain",
        proposedAt: NOW,
      },
      NOW,
    );
    const today = await view("today");
    expect(today.counts.proposals).toBe(1);
    expect(today.tasks[0]).toMatchObject({
      state: "open",
      proposedChange: { kind: "complete", reason: "A payment confirmation arrived this morning." },
    });
    const confirmed = await action(task.id, { action: "confirm" });
    expect(confirmed.json.task).toMatchObject({ state: "done", proposedChange: null });
    expect((await action(task.id, { action: "keep" })).status).toBe(400);
  });

  test("Done pages back through history with a cursor", async () => {
    for (const title of ["One", "Two", "Three"]) {
      const { task } = await addTask(title);
      clock.set(clock() + 1_000);
      await action(task.id, { action: "complete" });
    }
    const first = await call("GET", `/tasks?view=done&date=${TODAY}&limit=2`);
    expect(first.json.tasks.map((t: { title: string }) => t.title)).toEqual(["Three", "Two"]);
    expect(first.json.nextBefore).toMatch(/^\d+:loop_/);
    const second = await call(
      "GET",
      `/tasks?view=done&date=${TODAY}&limit=2&before=${encodeURIComponent(first.json.nextBefore)}`,
    );
    expect(second.json.tasks.map((t: { title: string }) => t.title)).toEqual(["One"]);
    expect(second.json.nextBefore).toBeUndefined();
    expect((await call("GET", `/tasks?view=done&before=yesterday`)).status).toBe(400);
  });

  test("a task lists the documents it refers to that are still there to open", async () => {
    const seed = (sourceId: string, externalId: string, title: string) => {
      upsertDocuments(db, [
        {
          providerId: ProviderId("fictional"),
          sourceId: SourceId(sourceId),
          externalId,
          title,
          content: `${title} body`,
          contentHash: `h-${externalId}`,
          sourceCreatedAt: "2026-03-09T09:00:00.000Z",
          sourceUpdatedAt: "2026-03-09T09:00:00.000Z",
          metadata: {},
        },
      ]);
      return db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(externalId)!.id;
    };
    const invoice = seed("mail:inbox", "e1", "Window repair invoice");
    const quote = seed("files:drive", "f1", "Venue quote");
    const removed = seed("mail:old", "e2", "Archived thread");
    db.prepare("INSERT INTO removed_sources (id, removed_at) VALUES ('mail:old', ?)").run(NOW);
    createOpenLoop(
      db,
      {
        id: "loop_docs",
        createdByRun: "run_1",
        title: "Pay the window repair invoice",
        confidence: 0.8,
        importance: 0.6,
        docs: [invoice, quote, removed, "doc_gone"],
      },
      NOW,
    );
    await action("loop_docs", { action: "accept", scheduledFor: TODAY });

    const expected = [
      { id: invoice, title: "Window repair invoice", sourceId: "mail:inbox" },
      { id: quote, title: "Venue quote", sourceId: "files:drive" },
    ].sort((a, b) => a.id.localeCompare(b.id));
    const today = await view("today");
    expect(today.tasks[0].documents).toEqual(expected);
    expect(today.tasks[0]).not.toHaveProperty("docs");
    expect((await call("GET", "/tasks/loop_docs")).json.task.documents).toEqual(expected);

    db.prepare("DELETE FROM documents WHERE id = ?").run(quote);
    const edited = await action("loop_docs", { action: "edit", title: "Pay the invoice" });
    expect(edited.json.task.documents).toEqual([
      { id: invoice, title: "Window repair invoice", sourceId: "mail:inbox" },
    ]);
  });

  test("a task whose knowledge is being purged leaves every list and the count", async () => {
    const seed = (id: string, title: string) =>
      createOpenLoop(
        db,
        { id, createdByRun: "run_1", title, confidence: 0.8, importance: 0.5 },
        NOW,
      );
    seed("loop_kept", "Book the piano tuner");
    seed("loop_hidden", "Renew the parking permit");
    seed("loop_owned_hidden", "Return the borrowed ladder");
    await action("loop_owned_hidden", { action: "accept", scheduledFor: TODAY });
    const hide = db.prepare("INSERT INTO knowledge_node_tombstones (id, deleted_at) VALUES (?, ?)");
    hide.run("loop_hidden", NOW);
    hide.run("loop_owned_hidden", NOW);

    const suggested = await view("suggested");
    expect(suggested.tasks.map((t: { id: string }) => t.id)).toEqual(["loop_kept"]);
    expect((await view("today")).tasks).toEqual([]);
    expect(suggested.counts.suggested).toBe(1);
  });

  test("delete removes a task", async () => {
    const { task } = await addTask("Duplicate entry");
    const res = await action(task.id, { action: "delete" });
    expect(res.json).toMatchObject({
      task: null,
      receipt: { text: "Deleted: Duplicate entry", undoSeq: null },
    });
    expect((await call("GET", `/tasks/${task.id}`)).status).toBe(404);
  });

  test("status advertises tasks", async () => {
    const res = await call("GET", "/status", undefined, reader);
    expect(res.json.tasks).toEqual({ available: true, noteAgent: false });
    expect(res.json.noteAgent).toEqual({
      enabled: false,
      modelAssigned: false,
      active: false,
    });
  });

  test("status advertises the note agent's setting beside whether notes are read", async () => {
    statusCache.stop();
    const noteAgent = { enabled: false, modelAssigned: true, active: false };
    app = createServer(db, dbPath, {
      briefsClock: clock,
      getNoteAgentStatus: () => noteAgent,
      onStatusCache: (cache) => {
        statusCache = cache;
      },
    });
    let res = await call("GET", "/status", undefined, reader);
    expect(res.json.tasks).toEqual({ available: true, noteAgent: false });
    expect(res.json.noteAgent).toEqual(noteAgent);

    Object.assign(noteAgent, { enabled: true, active: true });
    res = await call("GET", "/status", undefined, reader);
    expect(res.json.tasks).toEqual({ available: true, noteAgent: true });
    expect(res.json.noteAgent).toEqual(noteAgent);
  });
});
