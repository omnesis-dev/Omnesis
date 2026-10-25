// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger, type DecisionCapability, type DecisionRequest } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { insertCognitionDecision, listDecisionsForRun } from "../storage/decisions.js";
import { TaskProposeGate } from "./task-propose.js";
import type { TaskProposeGateMode } from "../config.js";
import type { DecisionPayloadCapture } from "../decision-payload.js";
import type { InterestExample, OwnerInterest } from "../interest/lookup.js";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type Database from "better-sqlite3";

const log = createLogger("test").child("task-propose");
const capture: DecisionPayloadCapture = {
  erasureGeneration: 0,
  subjects: [{ kind: "source", id: "doc_fixture" }],
};

const example = (source: string, text: string): InterestExample => ({
  text,
  source,
  basis: "words",
  ageDays: 3,
  similarity: 0.8,
});
const accepted = (text: string) => example("task_accepted", text);
const ignored = (text: string) => example("task_ignored", text);
const interestOf = (over: Partial<OwnerInterest>): OwnerInterest => ({
  positive: [],
  negative: [],
  statements: [],
  ...over,
});

describe("TaskProposeGate", () => {
  let path: string;
  let db: Database.Database;
  let score: number | "outage";
  let mode: TaskProposeGateMode;
  let interest: OwnerInterest | null;
  let lookups: string[];
  let asked: DecisionRequest[];
  let records: CognitionDecisionRecord[];
  let now = 1_000;

  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    decide: (request) => {
      asked.push(request);
      if (score === "outage") return Promise.reject(new Error("decision offline"));
      const [id] = Object.keys(request.questions);
      return Promise.resolve({
        model: "scripted-decision",
        answers: { [id!]: { type: "score", score } },
      });
    },
    dispose() {},
  };
  const gate = (withModel = true) =>
    new TaskProposeGate({
      getDecision: () => (withModel ? decision : null),
      getMode: () => mode,
      interest: {
        lookup: (query) => {
          lookups.push(query.text);
          return Promise.resolve(interest);
        },
      },
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
  const judge = (target = gate()) =>
    target.judge({
      runId: "run_propose",
      loopId: "loop_new",
      documentId: null,
      title: "Renew the studio lease",
      description: "The landlord asked for an answer by Friday.",
    });

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    records = [];
    asked = [];
    lookups = [];
    mode = "enforce";
    score = 1;
    interest = interestOf({ positive: [accepted("Renew the gym membership")] });
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("off asks nothing: no lookup, no model call, no row", async () => {
    mode = "off";
    expect(await judge()).toEqual({ tier: "suggest", enforced: false, reason: expect.any(String) });
    expect(lookups).toEqual([]);
    expect(asked).toEqual([]);
    expect(records).toEqual([]);
  });

  test("a suggestion nothing resembles is offered without a model call or a row", async () => {
    interest = null;
    expect((await judge()).tier).toBe("suggest");
    expect(lookups).toEqual([
      "Renew the studio lease\nThe landlord asked for an answer by Friday.",
    ]);
    expect(asked).toEqual([]);
    expect(records).toEqual([]);
  });

  test("no decision model means no judgement and no row", async () => {
    expect((await judge(gate(false))).tier).toBe("suggest");
    expect(asked).toEqual([]);
    expect(records).toEqual([]);
  });

  test("the model reads the task beside the owner's reactions, kept under the subjects", async () => {
    score = 2;
    await judge();
    expect(asked[0]!.state).toEqual({
      task: {
        title: "Renew the studio lease",
        description: "The landlord asked for an answer by Friday.",
      },
      owner_interest: interest,
    });
    expect(Object.keys(asked[0]!.questions)).toEqual(["tier"]);
    expect(records[0]!.payloadCapture).toBe(capture);
    const request = JSON.parse(records[0]!.payload!.requestJson) as {
      state: { owner_interest: OwnerInterest };
    };
    expect(request.state.owner_interest.positive[0]!.text).toBe("Renew the gym membership");
    expect(records[0]!.requestJson).toBeNull();
  });

  test("adopt needs something the owner wanted and nothing they did not", async () => {
    score = 2;
    interest = interestOf({
      positive: [accepted("Renew the gym membership"), accepted("Renew the van insurance")],
    });
    expect(await judge()).toEqual({
      tier: "adopt",
      enforced: true,
      reason: "Adopted: like 2 tasks you accepted or created",
    });
    interest = interestOf({
      positive: [accepted("Renew the gym membership")],
      negative: [ignored("Renew the magazine subscription")],
    });
    expect((await judge()).tier).toBe("suggest");
    interest = interestOf({ negative: [ignored("Renew the magazine subscription")] });
    expect((await judge()).tier).toBe("suggest");
    interest = interestOf({
      statements: [
        { text: "lease renewals", direction: "more", ageDays: 1, similarity: 0.7, basis: "words" },
      ],
    });
    expect(await judge()).toEqual({
      tier: "adopt",
      enforced: true,
      reason: "Adopted: like what you asked for more of",
    });
    // Every answer is a row; a tier the examples could not support was not acted on.
    expect(
      listDecisionsForRun(db, "run_propose").map((d) => [d.verdict, d.score, d.enforced]),
    ).toEqual([
      ["pass", 2, true],
      ["pass", 2, false],
      ["pass", 2, false],
      ["pass", 2, true],
    ]);
    expect(listDecisionsForRun(db, "run_propose")[0]).toMatchObject({
      purpose: "task-propose",
      lane: "tier",
      recordId: "loop_new",
      documentId: null,
      threshold: 1,
      rubricVersion: "task-propose-v1",
    });
  });

  test("withhold needs something the owner did not want", async () => {
    score = 0;
    expect((await judge()).tier).toBe("suggest");
    interest = interestOf({ negative: [ignored("Renew the magazine subscription")] });
    expect(await judge()).toEqual({
      tier: "withhold",
      enforced: true,
      reason: "Withheld: like 1 suggestion you ignored",
    });
    interest = interestOf({
      negative: [example("brief_not_interested", "Lease renewal reminders")],
    });
    expect((await judge()).reason).toBe("Withheld: like 1 item you did not want");
    expect(
      listDecisionsForRun(db, "run_propose").map((d) => [d.verdict, d.score, d.enforced]),
    ).toEqual([
      ["skip", 0, false],
      ["skip", 0, true],
      ["skip", 0, true],
    ]);
  });

  test("a middle score suggests, and is a pass", async () => {
    score = 1;
    expect(await judge()).toEqual({
      tier: "suggest",
      enforced: true,
      reason: "Suggested: no clear precedent",
    });
    expect(records.map((r) => [r.verdict, r.enforced])).toEqual([["pass", true]]);
  });

  test("shadow records the verdict without acting on it", async () => {
    mode = "shadow";
    score = 0;
    interest = interestOf({ negative: [ignored("Renew the magazine subscription")] });
    expect(await judge()).toEqual({
      tier: "withhold",
      enforced: false,
      reason: "Withheld: like 1 suggestion you ignored",
    });
    expect(records.map((r) => [r.verdict, r.enforced])).toEqual([["skip", false]]);
  });

  test("an outage is an unavailable row and the suggestion is offered", async () => {
    score = "outage";
    expect((await judge()).tier).toBe("suggest");
    expect(records.map((r) => [r.verdict, r.score, r.error])).toEqual([
      ["unavailable", null, "decision offline"],
    ]);
  });

  test("a failing lookup offers the suggestion", async () => {
    const failing = new TaskProposeGate({
      getDecision: () => decision,
      getMode: () => mode,
      interest: { lookup: () => Promise.reject(new Error("ledger locked")) },
      recordDecision: () => Promise.resolve(),
      recordSpend: () => Promise.resolve(),
      clock: () => now,
      idGen: () => randomUUID(),
      log,
    });
    expect((await judge(failing)).tier).toBe("suggest");
    expect(asked).toEqual([]);
  });
});
