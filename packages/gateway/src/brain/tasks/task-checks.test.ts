// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { insertCognitionDecision, listDecisionsForRun } from "../storage/decisions.js";
import { TaskChecks } from "./task-checks.js";
import type { DecisionPayloadCapture } from "../decision-payload.js";
import type { OwnerInterest } from "../interest/lookup.js";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("task-checks");
const capture: DecisionPayloadCapture = {
  erasureGeneration: 0,
  subjects: [{ kind: "node", id: "loop_node" }],
};

describe("TaskChecks ledger", () => {
  let path: string;
  let db: Database.Database;
  let score: number | "outage";
  let records: CognitionDecisionRecord[];
  let interest: OwnerInterest | null;
  let lookups: string[];
  let now = 1_000;

  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    decide: (request) => {
      if (score === "outage") return Promise.reject(new Error("decision offline"));
      const [id] = Object.keys(request.questions);
      return Promise.resolve({
        model: "scripted-decision",
        answers: { [id!]: { type: "score", score } },
      });
    },
    dispose() {},
  };
  const checks = (withModel = true, withInterest = false) =>
    new TaskChecks({
      getDecision: () => (withModel ? decision : null),
      ...(withInterest
        ? {
            interest: {
              lookup: (query) => {
                lookups.push(query.text);
                return Promise.resolve(interest);
              },
            },
          }
        : {}),
      recordDecision: (record) => {
        records.push(record);
        insertCognitionDecision(db, record);
        return Promise.resolve();
      },
      capturePayload: () => capture,
      recordSpend: () => Promise.resolve(),
      clock: () => (now += 1),
      idGen: () => randomUUID(),
      log,
    });
  const rename = (target: TaskChecks) =>
    target.sameTask({
      runId: "run_checks",
      loopId: "loop_fixture",
      documentId: null,
      before: { title: "Book the hall", description: "" },
      after: { title: "Book the main hall", description: "" },
    });

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    records = [];
    interest = null;
    lookups = [];
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("every verdict, outage included, is a row even when no document anchors the task", async () => {
    score = 3;
    expect(await rename(checks())).toBe("same");
    score = 0;
    expect(await rename(checks())).toBe("different");
    score = "outage";
    expect(await rename(checks())).toBe("unavailable");
    expect(listDecisionsForRun(db, "run_checks").map((d) => [d.verdict, d.documentId])).toEqual([
      ["pass", null],
      ["skip", null],
      ["unavailable", null],
    ]);
    expect(listDecisionsForRun(db, "run_checks")[0]).toMatchObject({
      purpose: "task-check",
      lane: "same_task",
      recordId: "loop_fixture",
      requestJson: null,
    });
  });

  test("the exact question and answer go to the payload store under the task's subjects", async () => {
    score = 3;
    await rename(checks());
    expect(records[0]!.payloadCapture).toBe(capture);
    const request = JSON.parse(records[0]!.payload!.requestJson) as {
      state: { after: { title: string } };
      questions: Record<string, unknown>;
    };
    expect(request.state.after.title).toBe("Book the main hall");
    expect(Object.keys(request.questions)).toEqual(["same_task"]);
    expect(JSON.parse(records[0]!.payload!.responseJson!)).toMatchObject({
      answers: { same_task: { score: 3 } },
    });
  });

  test("the owner's reactions to things like the new title or the note go in the state, when there are any", async () => {
    score = 3;
    interest = {
      positive: [
        {
          text: "Book the hall for the review",
          source: "task_accepted",
          ageDays: 2,
          similarity: 0.7,
        },
      ],
      negative: [],
      statements: [],
    };
    await rename(checks(true, true));
    expect(lookups).toEqual(["Book the main hall\n"]);
    const request = () =>
      JSON.parse(records.at(-1)!.payload!.requestJson) as { state: Record<string, unknown> };
    expect(request().state.owner_interest).toEqual(interest);
    expect(records.at(-1)!.rubricVersion).toBe("task-check-v2");

    await checks(true, true).noteIsNew({
      runId: "run_checks",
      loopId: "loop_fixture",
      documentId: null,
      task: { title: "Book the hall", description: "" },
      recentNotes: ["Quote requested"],
      note: "The hall confirmed the date.",
    });
    expect(lookups.at(-1)).toBe("The hall confirmed the date.");
    expect(request().state.owner_interest).toEqual(interest);

    // Nothing resembling it, or no lookup at all, leaves the request without the key.
    interest = null;
    await rename(checks(true, true));
    expect(request().state).not.toHaveProperty("owner_interest");
    await rename(checks());
    expect(request().state).not.toHaveProperty("owner_interest");
    expect(lookups).toHaveLength(3);
  });

  test("a failing lookup leaves the check to judge without it", async () => {
    score = 3;
    const failing = new TaskChecks({
      getDecision: () => decision,
      interest: { lookup: () => Promise.reject(new Error("ledger locked")) },
      recordDecision: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      capturePayload: () => capture,
      recordSpend: () => Promise.resolve(),
      clock: () => (now += 1),
      idGen: () => randomUUID(),
      log,
    });
    expect(await rename(failing)).toBe("same");
    const request = JSON.parse(records[0]!.payload!.requestJson) as {
      state: Record<string, unknown>;
    };
    expect(request.state).not.toHaveProperty("owner_interest");
  });

  test("no decision model means no decision and no row", async () => {
    expect(await rename(checks(false))).toBe("unchecked");
    expect(records).toEqual([]);
  });
});
