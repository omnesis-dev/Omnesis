// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createOpenLoop, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { applyTaskCommand, proposeTaskChange } from "../storage/tasks.js";
import { settleTaskProposals } from "./settle-proposals.js";
import { TaskChecks } from "./task-checks.js";
import type { ProposedTaskChange } from "../storage/types.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("settle-proposals");
const nowMs = Date.parse("2026-07-02T10:00:00.000Z");

describe("settleTaskProposals", () => {
  let path: string;
  let db: Database.Database;
  let sameTaskScore: number;

  const checks = new TaskChecks({
    getDecision: (): DecisionCapability => ({
      modelId: "scripted-decision",
      decide: () =>
        Promise.resolve({
          model: "scripted-decision",
          answers: { same_task: { type: "score", score: sameTaskScore } },
        }),
      dispose() {},
    }),
    recordDecision: () => Promise.resolve(),
    recordSpend: () => Promise.resolve(),
    clock: () => nowMs,
    idGen: () => randomUUID(),
    log,
  });

  const settle = (autoApply = true) =>
    settleTaskProposals({
      db,
      writeGate: directWriteGate(db),
      autoApply,
      taskChecks: checks,
      clock: () => nowMs,
      log,
    });

  function task(id: string, title: string, description = ""): void {
    createOpenLoop(
      db,
      { id, createdByRun: "r0", title, description, confidence: 0.8, importance: 0.5 },
      nowMs - 60_000,
    );
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "accept", id },
      nowMs - 50_000,
    );
  }

  function propose(id: string, change: Pick<ProposedTaskChange, "kind" | "fields">): void {
    proposeTaskChange(
      db,
      id,
      { ...change, reason: "A newer source.", evidence: [], runId: "run_old", proposedAt: nowMs },
      nowMs - 40_000,
    );
  }

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    sameTaskScore = 3;
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("an edit the policy now applies is applied as an undoable change", async () => {
    task("loop_a", "Find a 5K race");
    propose("loop_a", { kind: "edit", fields: { title: "Enter the Saturday morning 5K" } });
    expect(await settle()).toEqual({ applied: 1, withdrawn: 0 });
    expect(getOpenLoop(db, "loop_a")).toMatchObject({
      title: "Enter the Saturday morning 5K",
      proposedChange: null,
    });
    expect(listOpenLoopLedger(db, "loop_a").at(-1)!.event).toMatchObject({
      kind: "auto_applied",
      change: { kind: "edit", fields: ["title"] },
      note: "A newer source.",
    });
  });

  test("a proposal that no longer changes anything is withdrawn", async () => {
    task("loop_b", "Start the tax return");
    propose("loop_b", { kind: "edit", fields: { title: "Start the tax return" } });
    const ledgerBefore = listOpenLoopLedger(db, "loop_b").length;
    expect(await settle(false)).toEqual({ applied: 0, withdrawn: 1 });
    expect(getOpenLoop(db, "loop_b")!.proposedChange).toBeNull();
    expect(listOpenLoopLedger(db, "loop_b")).toHaveLength(ledgerBefore);
  });

  test("what still needs the user keeps waiting", async () => {
    task("loop_c", "Plan the workshop");
    propose("loop_c", { kind: "complete" });
    task("loop_d", "Book the venue");
    propose("loop_d", { kind: "edit", fields: { title: "Book a different venue" } });
    task("loop_e", "Review the Q4 budget");
    applyTaskCommand(
      db,
      {
        surface: "tasks",
        runId: "user:tasks",
        kind: "edit",
        id: "loop_e",
        fields: { description: "My own words." },
      },
      nowMs - 45_000,
    );
    propose("loop_e", { kind: "edit", fields: { description: "Different words." } });
    task("loop_f", "Call the accountant");
    propose("loop_f", { kind: "edit", fields: { title: "Email the accountant" } });
    sameTaskScore = 0;
    expect(await settle()).toEqual({ applied: 0, withdrawn: 0 });
    expect(await settle(false)).toEqual({ applied: 0, withdrawn: 0 });
    for (const id of ["loop_c", "loop_d", "loop_e", "loop_f"])
      expect(getOpenLoop(db, id)!.proposedChange).not.toBeNull();
    expect(getOpenLoop(db, "loop_e")!.description).toBe("My own words.");
  });
});
