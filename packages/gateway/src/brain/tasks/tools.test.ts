// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { applyTaskCommand, proposeTaskChange } from "../storage/tasks.js";
import { buildTaskTools } from "./tools.js";
import { TaskService } from "./service.js";
import { placeTask } from "./views.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
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
function tools(opts: { ownedOnly?: boolean; observations?: boolean } = {}) {
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

  test("owned-only tools cannot see or change suggestions", async () => {
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
    const { call } = tools({ ownedOnly: true });
    expect(await call("task_list", { view: "suggested" })).toMatchObject({ kind: "error" });
    expect(data(await call("task_list", { query: "Sarah" })).tasks).toEqual([]);
    expect(await call("task_update", { id: "loop_s", action: "complete" })).toMatchObject({
      kind: "error",
      code: "not_owned",
    });
    expect(await call("task_update", { id: "loop_s", action: "accept" })).toMatchObject({
      kind: "error",
      code: "invalid_args",
    });
    expect(getOpenLoop(db, "loop_s")?.state).toBe("open");
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
