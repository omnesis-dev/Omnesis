// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { applyTaskCommand, proposeTaskChange } from "../storage/tasks.js";
import { recordKnowledgeSourceDeletion } from "../knowledge/storage-invalidation.js";
import { buildTaskTools } from "./tools.js";
import { TaskService } from "./service.js";
import { placeTask } from "./views.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type { InterestEngine, RecordInterestInput } from "../interest/engine.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-03-10T09:00:00");
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

let n = 0;
function tools(
  opts: {
    creationReference?: () => Promise<string | null>;
    observations?: boolean;
    interest?: Pick<InterestEngine, "record">;
  } = {},
) {
  const gate = directWriteGate(db);
  const handles = buildTaskTools({
    db,
    tasks: new TaskService(db, gate, () => NOW),
    writeGate: gate,
    origin: { surface: "conversation", runId: "user:conversation:c1", conversationId: "c1" },
    clock: () => NOW,
    idGen: () => `t${++n}`,
    ...opts,
  });
  const call = async (name: string, args: unknown): Promise<ToolResult> => {
    const handle = handles.find((tool) => tool.name === name);
    if (!handle) throw new Error(`missing ${name}`);
    return handle.invoke(args, { sessionId: "s", messageId: "m" } as never);
  };
  return { handles, call };
}

const data = (result: ToolResult) => {
  if (result.kind !== "structured") throw new Error(JSON.stringify(result));
  return result.data as Record<string, any>;
};

describe("task tools", () => {
  test("a conversation gets the four task tools, all but the list marked mutating", () => {
    const { handles } = tools();
    expect(handles.map((tool: ToolHandle) => [tool.name, tool.mutates === true])).toEqual([
      ["task_list", false],
      ["task_create", true],
      ["task_update", true],
      ["task_undo", true],
    ]);
    expect(tools({ observations: true }).handles.at(-1)?.name).toBe("observation_suppress");
  });

  test("query is a literal substring across supported journal views and ignores view", async () => {
    const { handles, call } = tools();
    expect(
      applyTaskCommand(
        db,
        {
          kind: "create",
          surface: "tasks",
          runId: "user:fixture",
          id: "loop_literal_query",
          origin: "user",
          title: "Archive the astronomy club poster",
          scheduledFor: "2026-05-18",
        },
        NOW,
      ).ok,
    ).toBe(true);
    const exact = data(await call("task_list", { query: "I archived the astronomy club poster" }));
    expect(exact.tasks).toEqual([]);
    const global = data(await call("task_list", { query: "ASTRONOMY" }));
    expect(global.tasks).toHaveLength(1);
    expect(data(await call("task_list", { query: "ASTRONOMY", view: "done" }))).toEqual(global);
    expect(data(await call("task_list", { view: "done" })).tasks).toEqual([]);
    expect(handles.find((handle) => handle.name === "task_list")?.description).toContain(
      "view is ignored when query is present",
    );
  });

  test("interest_record is offered only where the engine is, and it mutates", () => {
    expect(tools().handles.map((t) => t.name)).not.toContain("interest_record");
    const record = vi.fn<InterestEngine["record"]>();
    const { handles } = tools({ observations: true, interest: { record } });
    expect(handles.map((t) => [t.name, t.mutates === true])).toEqual([
      ["task_list", false],
      ["task_create", true],
      ["task_update", true],
      ["task_undo", true],
      ["observation_suppress", true],
      ["interest_record", true],
    ]);
  });

  test("interest_record writes a statement signal with the user's words", async () => {
    const recorded: RecordInterestInput[] = [];
    const record = vi.fn<InterestEngine["record"]>(async (input) => {
      recorded.push(input);
      return { id: `int_${recorded.length}` } as never;
    });
    const { call, handles } = tools({ interest: { record } });
    const less = await call("interest_record", {
      direction: "less",
      about: "loyalty points and reward balances",
      quote: "I don't care about points expiring.",
      observationId: "obs_points",
    });
    expect(less).toEqual({
      kind: "structured",
      resultType: "interest.recorded",
      data: { id: "int_1", direction: "less", about: "loyalty points and reward balances" },
    });
    expect(recorded[0]).toEqual({
      polarity: -1,
      kind: "statement",
      source: "statement",
      subjectText: "loyalty points and reward balances",
      note: "I don't care about points expiring.",
      conversationId: "c1",
      observationId: "obs_points",
    });

    const more = await call("interest_record", { direction: "more", about: "  school events  " });
    expect(more).toMatchObject({
      data: { id: "int_2", direction: "more", about: "school events" },
    });
    expect(recorded[1]).toEqual({
      polarity: 1,
      kind: "statement",
      source: "statement",
      subjectText: "school events",
      note: null,
      conversationId: "c1",
    });
    expect(
      handles.find((t) => t.name === "interest_record")?.summarize?.({ about: "school events" }),
    ).toBe("school events");
  });

  test("interest_record says so when the ledger is off, and rejects bad arguments", async () => {
    const record = vi.fn<InterestEngine["record"]>(async () => null);
    const { call } = tools({ interest: { record } });
    expect(await call("interest_record", { direction: "more", about: "school events" })).toEqual({
      kind: "structured",
      resultType: "interest.recorded",
      data: {
        recorded: false,
        direction: "more",
        about: "school events",
        message: expect.stringContaining("off"),
      },
    });
    for (const args of [
      {},
      { direction: "never", about: "x" },
      { direction: "less", about: "" },
      { direction: "less", about: "x".repeat(301) },
      { direction: "less", about: "x", quote: "" },
      { direction: "less", about: "x", extra: 1 },
    ]) {
      expect(await call("interest_record", args), JSON.stringify(args)).toMatchObject({
        kind: "error",
        code: "invalid_args",
      });
    }
    expect(record).toHaveBeenCalledTimes(1);
  });

  test("create, list, update and undo, stamped with the conversation", async () => {
    const { call } = tools();
    const created = data(
      await call("task_create", { title: "Book the vet", scheduledFor: "2026-03-10" }),
    );
    expect(created).toMatchObject({ receipt: "Added: Book the vet", task: { id: "loop_t1" } });

    const listed = data(await call("task_list", {}));
    expect(listed).toMatchObject({
      today: "2026-03-10",
      tasks: [{ id: "loop_t1", title: "Book the vet", yours: true }],
    });
    expect(data(await call("task_list", { query: "VET" })).tasks).toHaveLength(1);
    expect(data(await call("task_list", { query: "dentist" })).tasks).toHaveLength(0);

    const moved = data(
      await call("task_update", { id: "loop_t1", action: "migrate", to: "2026-03-13" }),
    );
    expect(moved.receipt).toBe("Moved to Fri 13 Mar: Book the vet");
    expect(listOpenLoopLedger(db, "loop_t1").at(-1)?.event).toMatchObject({
      kind: "migrated",
      surface: "conversation",
      conversationId: "c1",
    });
    expect(listOpenLoopLedger(db, "loop_t1").at(-1)?.runId).toBe("user:conversation:c1");

    await call("task_undo", { undoSeq: moved.undoSeq });
    expect(getOpenLoop(db, "loop_t1")?.scheduledFor).toBe("2026-03-10");
  });

  test.each([
    { action: "migrate", to: "2026-03-13", deadline: { type: "by", date: "2026-03-20" } },
    { action: "complete", docs: ["not-a-document"] },
    { action: "accept", title: "A different task" },
    { action: "edit", reason: "ignored reason" },
    { action: "delete", note: "ignored note" },
  ])("rejects fields an action would ignore before any write: %j", async (args) => {
    const { call } = tools();
    const created = data(await call("task_create", { title: "Inspect the greenhouse labels" }));
    const before = getOpenLoop(db, created.task.id);
    const history = listOpenLoopLedger(db, created.task.id);
    expect(await call("task_update", { id: created.task.id, ...args })).toMatchObject({
      kind: "error",
      code: "invalid_args",
      message: expect.stringContaining("Nothing was changed"),
    });
    expect(getOpenLoop(db, created.task.id)).toEqual(before);
    expect(listOpenLoopLedger(db, created.task.id)).toEqual(history);
  });

  test("migration and deadline edits return and list the actual saved deadline", async () => {
    const { call } = tools();
    const created = data(await call("task_create", { title: "Inspect the greenhouse labels" }));
    await call("task_update", { id: created.task.id, action: "migrate", to: "2026-03-13" });
    const edited = data(
      await call("task_update", {
        id: created.task.id,
        action: "edit",
        deadline: { type: "by", date: "2026-03-20" },
      }),
    );
    expect(edited.task).toMatchObject({
      scheduledFor: "2026-03-13",
      deadline: { type: "by", date: "2026-03-20" },
    });
    expect(data(await call("task_list", { query: "greenhouse labels" })).tasks).toEqual([
      expect.objectContaining({ deadline: { type: "by", date: "2026-03-20" } }),
    ]);
  });

  test("a conversation can only undo its own changes", async () => {
    const { call } = tools();
    const mine = data(await call("task_create", { title: "Book the vet" }));
    const user = applyTaskCommand(
      db,
      {
        surface: "tasks",
        runId: "user:tasks",
        kind: "create",
        id: "loop_user",
        origin: "user",
        title: "Water the plants",
      },
      NOW,
    );
    expect(user.ok).toBe(true);
    const userSeq = user.ok ? user.eventSeq! : 0;
    expect(await call("task_undo", { undoSeq: userSeq })).toMatchObject({
      kind: "error",
      code: "not_yours",
    });
    expect(getOpenLoop(db, "loop_user")).not.toBeNull();
    await call("task_undo", { undoSeq: mine.undoSeq });
    expect(getOpenLoop(db, "loop_t1")).toBeNull();
  });

  test("argument errors are reported to the model", async () => {
    const { call } = tools();
    expect(await call("task_update", { id: "loop_x", action: "migrate" })).toMatchObject({
      kind: "error",
      code: "invalid_args",
    });
    expect(await call("task_update", { id: "loop_x", action: "complete" })).toMatchObject({
      kind: "error",
      code: "not_found",
    });
    expect(await call("task_create", { title: "x", scheduledFor: "next week" })).toMatchObject({
      kind: "error",
      code: "invalid_args",
    });
  });

  test("a conversation can accept a suggestion and confirm a proposal", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_s",
        createdByRun: "run_1",
        title: "Reply to Sarah Mendez",
        confidence: 0.7,
        importance: 0.5,
      },
      NOW,
    );
    const { call } = tools();
    expect(data(await call("task_list", { view: "suggested" })).tasks).toHaveLength(1);
    await call("task_update", { id: "loop_s", action: "accept", scheduledFor: "2026-03-11" });
    expect(getOpenLoop(db, "loop_s")).toMatchObject({ accepted: true, scheduledFor: "2026-03-11" });
    proposeTaskChange(
      db,
      "loop_s",
      {
        kind: "complete",
        reason: "Sarah confirmed by email.",
        evidence: [],
        runId: "run_2",
        proposedAt: NOW,
      },
      NOW,
    );
    expect(data(await call("task_list", { view: "month" })).tasks).toEqual([
      expect.objectContaining({
        id: "loop_s",
        proposedChange: { kind: "complete", reason: "Sarah confirmed by email." },
      }),
    ]);
    await call("task_update", { id: "loop_s", action: "confirm" });
    expect(getOpenLoop(db, "loop_s")?.state).toBe("done");
  });

  test("creation attaches the published origin without dropping explicit documents or duplicating it", async () => {
    for (const id of ["doc_chat", "doc_blueprint"]) {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
        VALUES (?, 'p', 's', ?, 'Observatory reference', 'body', 'h', ?, ?, ?, ?)`,
      ).run(id, id, ...Array(4).fill(new Date(NOW).toISOString()));
    }
    const resolve = vi.fn(() => Promise.resolve("doc_chat"));
    const { call } = tools({ creationReference: resolve });
    const first = data(
      await call("task_create", { title: "Check the telescope", docs: ["doc_blueprint"] }),
    );
    expect(getOpenLoop(db, first.task.id as string)?.docs).toEqual(["doc_blueprint", "doc_chat"]);
    const second = data(
      await call("task_create", { title: "Store the lenses", docs: ["doc_chat", "doc_chat"] }),
    );
    expect(getOpenLoop(db, second.task.id as string)?.docs).toEqual(["doc_chat"]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("the 100-document boundary counts a repeated origin only once", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `doc_ref_${i}`);
    const insert =
      db.prepare(`INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
      source_created_at, source_updated_at, ingested_at, updated_at)
      VALUES (?, 'p', 's', ?, 'Observatory reference', 'body', 'h', ?, ?, ?, ?)`);
    for (const id of ids) insert.run(id, id, ...Array(4).fill(new Date(NOW).toISOString()));
    const { call } = tools({ creationReference: () => Promise.resolve(ids[99]!) });
    const first = data(
      await call("task_create", { title: "Catalog the star maps", docs: ids.slice(0, 99) }),
    );
    expect(getOpenLoop(db, first.task.id as string)?.docs).toEqual([...ids].sort());
    const second = data(await call("task_create", { title: "Review the catalog", docs: ids }));
    expect(getOpenLoop(db, second.task.id as string)?.docs).toEqual([...ids].sort());
    const third = data(await call("task_create", { title: "Check the observatory" }));
    expect(getOpenLoop(db, third.task.id as string)?.docs).toEqual([ids[99]]);
  });

  test("creation refuses an unavailable origin and an overflowing merged reference list without writing", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM open_loops").get();
    expect(
      await tools({ creationReference: () => Promise.resolve(null) }).call("task_create", {
        title: "Missing origin",
      }),
    ).toMatchObject({ kind: "error", message: expect.stringContaining("No task was created") });
    expect(
      await tools({ creationReference: () => Promise.resolve("doc_chat") }).call("task_create", {
        title: "Too many references",
        docs: Array.from({ length: 100 }, (_, i) => `doc_${i}`),
      }),
    ).toMatchObject({
      kind: "error",
      message: expect.stringContaining("including its originating conversation"),
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM open_loops").get()).toEqual(before);
  });

  test("cancellation while publishing the origin cannot create a task", async () => {
    const abort = new AbortController();
    const { handles } = tools({
      creationReference: () => {
        abort.abort();
        return Promise.resolve("doc_chat");
      },
    });
    const result = await handles
      .find((tool) => tool.name === "task_create")!
      .invoke({ title: "Canceled publication" }, {
        sessionId: "s",
        messageId: "m",
        abortSignal: abort.signal,
      } as never);
    expect(result).toMatchObject({ kind: "error", code: "canceled" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM open_loops").get()).toEqual({ n: 0 });
  });

  test("tasks link found documents, expose them to later edits, and undo attachment changes", async () => {
    const seed = (id: string) => {
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES (?, 'p', 's', ?, 'Garden planning reference', 'body', 'h', ?, ?, ?, ?)`,
      ).run(id, id, ...Array(4).fill(new Date(NOW).toISOString()));
    };
    seed("doc_plan");
    seed("doc_quote");
    const { call } = tools();
    const created = data(
      await call("task_create", {
        title: "Prepare the garden plan",
        docs: ["doc_plan", "doc_plan"],
      }),
    );
    const id = created.task.id;
    expect(getOpenLoop(db, id)?.docs).toEqual(["doc_plan"]);
    expect(data(await call("task_list", { query: "garden" })).tasks[0].documents).toEqual([
      { id: "doc_plan", title: "Garden planning reference", sourceId: "s" },
    ]);
    const edited = data(
      await call("task_update", {
        id,
        action: "edit",
        docs: ["doc_plan", "doc_quote"],
      }),
    );
    expect(getOpenLoop(db, id)?.docs).toEqual(["doc_plan", "doc_quote"]);
    await call("task_undo", { undoSeq: edited.undoSeq });
    expect(getOpenLoop(db, id)?.docs).toEqual(["doc_plan"]);
    expect(
      await call("task_create", { title: "Missing document", docs: ["absent"] }),
    ).toMatchObject({ kind: "error", code: "invalid" });
    expect(await call("task_update", { id, action: "edit", docs: ["absent"] })).toMatchObject({
      kind: "error",
      code: "invalid",
    });
    expect(getOpenLoop(db, id)?.docs).toEqual(["doc_plan"]);
    const cleared = data(await call("task_update", { id, action: "edit", docs: [] }));
    expect(getOpenLoop(db, id)?.docs).toEqual([]);
    await call("task_undo", { undoSeq: cleared.undoSeq });
    expect(getOpenLoop(db, id)?.docs).toEqual(["doc_plan"]);
  });

  test("hidden document links cannot be exposed, newly attached or restored by undo", async () => {
    for (const id of ["doc_visible", "doc_hidden"])
      db.prepare(
        `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
         VALUES (?, 'p', 's', ?, 'Greenhouse reference', 'body', 'h', ?, ?, ?, ?)`,
      ).run(id, id, ...Array(4).fill(new Date(NOW).toISOString()));
    const { call } = tools();
    const created = data(
      await call("task_create", {
        title: "Plan the greenhouse",
        docs: ["doc_visible", "doc_hidden"],
      }),
    );
    const id = created.task.id;
    const edited = data(
      await call("task_update", { id, action: "edit", title: "Plan the greenhouse planting" }),
    );
    recordKnowledgeSourceDeletion(db, "doc_hidden", NOW + 1);
    // The source is fenced before its physical document row is removed.
    expect(db.prepare("SELECT id FROM documents WHERE id = 'doc_hidden'").get()).toBeDefined();
    expect(data(await call("task_list", { query: "greenhouse" })).tasks[0].documents).toEqual([
      { id: "doc_visible", title: "Greenhouse reference", sourceId: "s" },
    ]);
    expect(
      await call("task_create", { title: "Read the greenhouse reference", docs: ["doc_hidden"] }),
    ).toMatchObject({ kind: "error", code: "invalid" });
    expect(
      await call("task_update", {
        id,
        action: "edit",
        title: "An unavailable reference must not change this task",
        docs: ["doc_hidden"],
      }),
    ).toMatchObject({ kind: "error", code: "invalid" });
    expect(getOpenLoop(db, id)?.title).toBe("Plan the greenhouse planting");

    const undone = await call("task_undo", { undoSeq: edited.undoSeq });
    expect(undone).toMatchObject({ kind: "structured", resultType: "task.changed" });
    expect(getOpenLoop(db, id)).toMatchObject({
      title: "Plan the greenhouse",
      docs: ["doc_visible"],
    });
  });

  test("observation_suppress drops an open observation and records the user's action", async () => {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_1', 'p', 's', 'doc_1', 'Club newsletter', 'body', 'h', ?, ?, ?, ?)`,
    ).run(...Array(4).fill(new Date(NOW).toISOString()));
    createObservation(
      db,
      {
        id: "obs_1",
        createdByRun: "run_1",
        summary: "The book club moved to Thursdays.",
        citations: ["doc_1"],
      },
      NOW,
    );
    const { call } = tools({ observations: true });
    const result = data(
      await call("observation_suppress", { id: "obs_1", reason: "I left that club" }),
    );
    expect(result.receipt).toBe("Won't mention again: The book club moved to Thursdays.");
    expect(getObservation(db, "obs_1")).toMatchObject({
      state: "dropped",
      closeReason: "suppressed",
      userAction: "suppressed",
    });
    expect(await call("observation_suppress", { id: "obs_missing", reason: "x" })).toMatchObject({
      kind: "error",
      code: "not_found",
    });
  });
});

describe("placeTask", () => {
  const day = "2026-03-10";
  test.each([
    [
      { scheduledFor: "2026-03-10", deadline: null },
      { view: "today", carried: false },
    ],
    [
      { scheduledFor: "2026-03-07", deadline: null },
      { view: "today", carried: true },
    ],
    [
      { scheduledFor: "2026-02", deadline: null },
      { view: "today", carried: true },
    ],
    [
      { scheduledFor: "2026-03-20", deadline: null },
      { view: "month", carried: false },
    ],
    [
      { scheduledFor: "2026-03", deadline: null },
      { view: "month", carried: false },
    ],
    [
      { scheduledFor: "2026-04-02", deadline: null },
      { view: "future", carried: false },
    ],
    [
      { scheduledFor: "2026-05", deadline: null },
      { view: "future", carried: false },
    ],
    [
      { scheduledFor: "someday", deadline: null },
      { view: "future", carried: false },
    ],
    [
      { scheduledFor: null, deadline: null },
      { view: "anytime", carried: false },
    ],
    [
      { scheduledFor: null, deadline: { type: "by", date: "2026-03-09" } },
      { view: "today", carried: false },
    ],
    [
      { scheduledFor: null, deadline: { type: "by", date: "2026-03-28" } },
      { view: "month", carried: false },
    ],
    [
      { scheduledFor: null, deadline: { type: "by", date: "2026-07-01" } },
      { view: "future", carried: false },
    ],
    [
      { scheduledFor: null, deadline: { type: "any_time" } },
      { view: "anytime", carried: false },
    ],
    // A deadline that has arrived wins over a later plan.
    [
      { scheduledFor: "2026-03-25", deadline: { type: "by", date: "2026-03-10" } },
      { view: "today", carried: false },
    ],
    [
      { scheduledFor: "someday", deadline: { type: "by", date: "2026-03-09" } },
      { view: "today", carried: false },
    ],
    // A plan for later in the month stays put while the deadline is ahead.
    [
      { scheduledFor: "2026-03-25", deadline: { type: "by", date: "2026-03-28" } },
      { view: "month", carried: false },
    ],
  ])("%j → %j", (loop, expected) => {
    expect(placeTask(loop, day)).toEqual(expected);
  });
});
