// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain's authority over the user's own tasks: `open_loop_update` turns a
 * change to a user-owned loop's state, title, description or deadline into a
 * proposal (reason required) instead of applying it, and `open_loop_delete`
 * refuses to erase a user task. Brain suggestions keep the direct path,
 * including the resolve cascade that drops their open observations.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { createOpenLoop, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { createOpenLoopMirror } from "./mirror.js";
import { buildCognitionOwnTools, taskProposalFor } from "./tools.js";
import type { OpenLoopRow, TaskOrigin } from "../storage/types.js";
import type { SearchPort, ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("task-proposals");
const CTX = { sessionId: "S", messageId: "M" };

function loopRow(overrides: Partial<OpenLoopRow> = {}): OpenLoopRow {
  return {
    id: "loop_1",
    createdByRun: "r0",
    state: "open",
    confidence: 0.9,
    importance: 0.5,
    title: "Book the venue tour",
    description: "Call Riverside Estate",
    deadline: { date: "2026-07-10" },
    ...overrides,
  } as OpenLoopRow;
}

describe("taskProposalFor", () => {
  test("resolving proposes completion or striking", () => {
    expect(taskProposalFor(loopRow(), { state: "done" })).toEqual({ kind: "complete" });
    expect(taskProposalFor(loopRow(), { state: "dismissed" })).toEqual({ kind: "strike" });
  });

  test("a state the task already has proposes nothing", () => {
    expect(taskProposalFor(loopRow({ state: "done" }), { state: "done" })).toBeNull();
    expect(taskProposalFor(loopRow({ state: "dismissed" }), { state: "dismissed" })).toBeNull();
  });

  test("snoozing or reopening is not proposed", () => {
    expect(taskProposalFor(loopRow(), { state: "snoozed" })).toBeNull();
    expect(taskProposalFor(loopRow(), { state: "open" })).toBeNull();
  });

  test("an edit carries only the fields that actually change", () => {
    expect(
      taskProposalFor(loopRow(), {
        title: "Book the venue tour for Saturday",
        description: "Call Riverside Estate",
        deadline: { date: "2026-07-10" },
      }),
    ).toEqual({ kind: "edit", fields: { title: "Book the venue tour for Saturday" } });
    expect(taskProposalFor(loopRow(), { description: "Email Riverside Estate instead" })).toEqual({
      kind: "edit",
      fields: { description: "Email Riverside Estate instead" },
    });
  });

  test("deadlines compare by value, and clearing one is an edit", () => {
    expect(taskProposalFor(loopRow(), { deadline: { date: "2026-07-10" } })).toBeNull();
    expect(taskProposalFor(loopRow(), { deadline: { date: "2026-07-12" } })).toEqual({
      kind: "edit",
      fields: { deadline: { date: "2026-07-12" } },
    });
    expect(taskProposalFor(loopRow(), { deadline: null })).toEqual({
      kind: "edit",
      fields: { deadline: null },
    });
  });

  test("no change proposes nothing", () => {
    expect(taskProposalFor(loopRow(), {})).toBeNull();
    expect(taskProposalFor(loopRow(), { title: "Book the venue tour" })).toBeNull();
  });

  test("resolution wins over field edits in the same change", () => {
    expect(taskProposalFor(loopRow(), { state: "done", title: "Something else" })).toEqual({
      kind: "complete",
    });
  });
});

const emptySearch: SearchPort = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async search(input) {
    return { query: input.query, durationMs: 0, results: [] };
  },
};

function structured(result: ToolResult): { resultType: string; data: Record<string, unknown> } {
  if (result.kind !== "structured")
    throw new Error(`expected a structured result, got ${JSON.stringify(result)}`);
  return { resultType: result.resultType, data: result.data as Record<string, unknown> };
}

describe("open_loop_update / open_loop_delete on the user's own tasks", () => {
  let path: string;
  let db: Db;
  let nowMs: number;
  let tools: ToolHandle[];

  function tool(name: string): ToolHandle {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
  const update = (args: Record<string, unknown>) =>
    tool("open_loop_update").invoke({ annotationDependencies: [], ...args }, CTX);
  const del = (id: string) => tool("open_loop_delete").invoke({ id }, CTX);

  function seedLoop(id: string, origin: TaskOrigin, accepted = false): void {
    createOpenLoop(
      db,
      {
        id,
        createdByRun: "r0",
        title: "Send the Q4 budget review",
        description: "Draft for Sarah Mendez",
        confidence: 0.8,
        importance: 0.4,
        origin,
      },
      nowMs - 60_000,
    );
    if (accepted) db.prepare("UPDATE open_loops SET accepted = 1 WHERE id = ?").run(id);
  }

  function seedObservation(id: string, loopId: string): void {
    createObservation(
      db,
      { id, createdByRun: "r0", summary: "Budget review due soon", relatedLoopIds: [loopId] },
      nowMs - 30_000,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    nowMs = Date.parse("2026-07-02T10:00:00.000Z");
    const writeGate = directWriteGate(db);
    tools = buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearch,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => nowMs,
      runId: "run_prop_1",
      idGen: () => randomUUID(),
      log,
    });
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test.each([
    ["a note-origin task", "note" as const, false],
    ["a user-origin task", "user" as const, false],
    ["an accepted Brain suggestion", "brain" as const, true],
  ])(
    "a resolving change to %s without a reason is refused and changes nothing",
    async (_l, origin, accepted) => {
      seedLoop("loop_u", origin, accepted);
      const before = getOpenLoop(db, "loop_u")!;
      const result = await update({ id: "loop_u", state: "done", importance: 0.9 });
      expect(result).toMatchObject({ kind: "error", code: "reason_required" });
      const after = getOpenLoop(db, "loop_u")!;
      expect(after).toMatchObject({
        state: "open",
        importance: before.importance,
        proposedChange: null,
      });
    },
  );

  test("a title edit without a reason is refused too", async () => {
    seedLoop("loop_u", "user");
    expect(await update({ id: "loop_u", title: "Send the Q4 budget" })).toMatchObject({
      kind: "error",
      code: "reason_required",
    });
    expect(getOpenLoop(db, "loop_u")!.title).toBe("Send the Q4 budget review");
  });

  test("with a reason the change is proposed, the task keeps its values, and other fields apply", async () => {
    seedLoop("loop_u", "user");
    seedObservation("obs_u", "loop_u");
    const result = structured(
      await update({
        id: "loop_u",
        state: "done",
        importance: 0.9,
        reason: "The budget review was sent on Tuesday.",
      }),
    );
    expect(result.resultType).toBe("open_loop.change_proposed");
    expect(result.data.proposed).toEqual(expect.stringContaining("keeps its current values"));
    const loop = getOpenLoop(db, "loop_u")!;
    expect(loop.state).toBe("open");
    expect(loop.importance).toBe(0.9);
    expect(loop.proposedChange).toMatchObject({
      kind: "complete",
      reason: "The budget review was sent on Tuesday.",
      runId: "run_prop_1",
      proposedAt: nowMs,
      evidence: [],
    });
    expect(listOpenLoopLedger(db, "loop_u").map((e) => e.note)).toContain(
      "Proposed complete: The budget review was sent on Tuesday.",
    );
    // A proposal is not a resolution: the task's observations stay open.
    expect(getObservation(db, "obs_u")!.state).toBe("live");
  });

  test("an edit proposal records only the changed fields", async () => {
    seedLoop("loop_u", "note");
    structured(
      await update({
        id: "loop_u",
        title: "Send the revised Q4 budget review",
        description: "Draft for Sarah Mendez",
        reason: "Sarah asked for the revised figures.",
      }),
    );
    const loop = getOpenLoop(db, "loop_u")!;
    expect(loop.title).toBe("Send the Q4 budget review");
    expect(loop.proposedChange).toMatchObject({
      kind: "edit",
      fields: { title: "Send the revised Q4 budget review" },
    });
  });

  test("a user task change that touches only direct fields is applied without a reason", async () => {
    seedLoop("loop_u", "user");
    const result = structured(await update({ id: "loop_u", importance: 0.2, state: "snoozed" }));
    expect(result.resultType).toBe("open_loop.updated");
    const loop = getOpenLoop(db, "loop_u")!;
    expect(loop.importance).toBe(0.2);
    // Snoozing a user task is the user's call: not applied, not proposed.
    expect(loop.state).toBe("open");
    expect(loop.proposedChange).toBeNull();
  });

  test("an unaccepted Brain suggestion is changed directly and its resolution drops its observations", async () => {
    seedLoop("loop_b", "brain");
    seedObservation("obs_b", "loop_b");
    const result = structured(
      await update({ id: "loop_b", state: "done", title: "Sent the Q4 budget review" }),
    );
    expect(result.resultType).toBe("open_loop.updated");
    expect(getOpenLoop(db, "loop_b")).toMatchObject({
      state: "done",
      title: "Sent the Q4 budget review",
      proposedChange: null,
    });
    expect(getObservation(db, "obs_b")).toMatchObject({
      state: "dropped",
      closeReason: "superseded",
    });
  });

  test("open_loop_delete refuses a user task and leaves it and its observations intact", async () => {
    seedLoop("loop_u", "user");
    seedObservation("obs_u", "loop_u");
    expect(await del("loop_u")).toMatchObject({ kind: "error", code: "user_task" });
    expect(getOpenLoop(db, "loop_u")).not.toBeNull();
    expect(getObservation(db, "obs_u")!.state).toBe("live");
  });

  test("open_loop_delete erases a Brain suggestion with its open observations", async () => {
    seedLoop("loop_b", "brain");
    seedObservation("obs_b", "loop_b");
    const result = structured(await del("loop_b"));
    expect(result).toEqual({
      resultType: "open_loop.deleted",
      data: { loopId: "loop_b", deletedObservationIds: ["obs_b"] },
    });
    expect(getOpenLoop(db, "loop_b")).toBeNull();
    expect(getObservation(db, "obs_b")).toBeNull();
  });

  test("open_loop_delete of an unknown loop is not_found", async () => {
    expect(await del("loop_missing")).toMatchObject({ kind: "error", code: "not_found" });
  });
});
