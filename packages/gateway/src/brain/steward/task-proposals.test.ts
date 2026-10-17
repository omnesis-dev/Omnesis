// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Brain's authority over the user's own tasks: `open_loop_update` turns a
 * change to a user-owned loop's state, title, description or deadline into a
 * proposal (reason required) unless its stated evidence passes the auto-apply
 * policy and the entailment verifier, and `open_loop_delete` refuses to erase
 * a user task. Brain suggestions keep the direct path, including the resolve
 * cascade that drops their open observations.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createObservation, getObservation } from "../storage/observations.js";
import { createOpenLoop, getOpenLoop, listOpenLoopLedger } from "../storage/open-loops.js";
import { applyTaskCommand } from "../storage/tasks.js";
import { taskProposalFor } from "../tasks/auto-apply.js";
import { TaskChecks } from "../tasks/task-checks.js";
import { createOpenLoopMirror } from "./mirror.js";
import { buildCognitionOwnTools } from "./tools.js";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type { OpenLoopRow, TaskOrigin } from "../storage/types.js";
import type { SearchPort, ToolHandle } from "@omnesis/agent";
import type {
  DecisionCapability,
  EntailCapability,
  EntailVerdict,
  ToolResult,
} from "@omnesis/core";
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

  test("a suggestion the user ignored is still the Brain's to maintain, and says so", async () => {
    seedLoop("loop_i", "brain");
    db.prepare("UPDATE open_loops SET ignored = 1 WHERE id = ?").run("loop_i");
    const fetched = structured(await tool("open_loop_fetch").invoke({ id: "loop_i" }, CTX));
    expect(JSON.stringify(fetched.data)).toContain('"ignoredByUser":true');
    const result = await update({ id: "loop_i", importance: 0.9, description: "Draft sent" });
    expect(result.kind).toBe("structured");
    expect(getOpenLoop(db, "loop_i")).toMatchObject({
      state: "open",
      ignored: true,
      importance: 0.9,
      description: "Draft sent",
    });
  });

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

describe("open_loop_update applies a verified change to the user's own task", () => {
  const RECEIPT = "Thanks for paying the budget review invoice in full today.";
  const FACT = "The budget review invoice was paid in full today.";
  let path: string;
  let db: Db;
  let docId: string;
  let verdict: EntailVerdict["label"] | "outage";
  let claims: string[];
  let tools: ToolHandle[];
  const nowMs = Date.parse("2026-07-02T10:00:00.000Z");

  const verifier: EntailCapability = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async verify(input) {
      claims.push(input.claim);
      if (verdict === "outage") throw new Error("verifier offline");
      return { label: verdict };
    },
    dispose() {},
  };

  // The decision model behind the task checks: a score per question, or an outage.
  let scores: Record<string, number | "outage">;
  let asked: string[];
  let ledger: CognitionDecisionRecord[];
  const decision: DecisionCapability = {
    modelId: "scripted-decision",
    // eslint-disable-next-line @typescript-eslint/require-await
    async decide(request) {
      const [id] = Object.keys(request.questions);
      asked.push(id!);
      const score = scores[id!];
      if (score === undefined || score === "outage") throw new Error("decision offline");
      return { model: "scripted-decision", answers: { [id!]: { type: "score", score } } };
    },
    dispose() {},
  };
  const taskChecks = (withModel = true) =>
    new TaskChecks({
      getDecision: () => (withModel ? decision : null),
      recordDecision: async (record) => {
        ledger.push(record);
      },
      recordSpend: async () => {},
      clock: () => nowMs,
      idGen: () => randomUUID(),
      log,
    });

  function build(
    options: {
      autoApply?: boolean;
      verifier?: boolean;
      checks?: TaskChecks;
      seedDocIds?: string[];
    } = {},
  ): void {
    const writeGate = directWriteGate(db);
    tools = buildCognitionOwnTools({
      db,
      writeGate,
      searchPort: emptySearch,
      mirror: createOpenLoopMirror({ db, writeGate, log }),
      getNotesMaxBytes: () => 8192,
      clock: () => nowMs,
      runId: "run_auto_1",
      idGen: () => randomUUID(),
      taskAutoApply: options.autoApply ?? true,
      ...(options.checks ? { taskChecks: options.checks } : {}),
      ...(options.seedDocIds ? { seedDocIds: options.seedDocIds } : {}),
      ...(options.verifier === false
        ? {}
        : { getEntailmentVerifier: () => Promise.resolve(verifier) }),
      log,
    });
  }

  const update = (args: Record<string, unknown>) =>
    tools
      .find((t) => t.name === "open_loop_update")!
      .invoke({ annotationDependencies: [], ...args }, CTX);
  const evidence = (basis = "explicit", quote = RECEIPT) => ({
    fact: FACT,
    basis,
    quotes: [{ docId, quote }],
  });
  const complete = (extra: Record<string, unknown> = {}) =>
    update({
      id: "loop_t",
      state: "done",
      reason: "The receipt says the invoice was paid.",
      evidence: evidence(),
      ...extra,
    });

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("gmail-test"),
        externalId: "receipt-1",
        title: "Invoice receipt",
        content: `Hello,\n\n${RECEIPT}\n\nThe accounts team`,
        contentHash: "h-receipt-1",
        sourceCreatedAt: "2026-07-02T08:00:00.000Z",
        sourceUpdatedAt: "2026-07-02T08:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get("receipt-1")!.id;
    createOpenLoop(
      db,
      {
        id: "loop_t",
        createdByRun: "r0",
        title: "Pay the budget review invoice",
        description: "Invoice from the sound engineer.",
        confidence: 0.8,
        importance: 0.5,
        docs: [docId],
      },
      nowMs - 60_000,
    );
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "accept", id: "loop_t" },
      nowMs - 50_000,
    );
    verdict = "entailment";
    claims = [];
    scores = {};
    asked = [];
    ledger = [];
    build();
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("an entailed completion is applied, recorded, and resolves the task", async () => {
    createObservation(
      db,
      { id: "obs_t", createdByRun: "r0", summary: "Invoice due", relatedLoopIds: ["loop_t"] },
      nowMs - 30_000,
    );
    const result = structured(await complete());
    expect(result.resultType).toBe("open_loop.change_applied");
    expect(claims).toEqual([`${FACT} So this is done: Pay the budget review invoice.`]);
    expect(getOpenLoop(db, "loop_t")).toMatchObject({ state: "done", proposedChange: null });
    expect(listOpenLoopLedger(db, "loop_t").at(-1)!.event).toMatchObject({
      kind: "auto_applied",
      change: { kind: "complete" },
      evidence: [docId],
      note: "The receipt says the invoice was paid.",
    });
    expect(getObservation(db, "obs_t")!.state).toBe("dropped");
  });

  test.each([["neutral" as const], ["contradiction" as const], ["outage" as const]])(
    "a %s verdict leaves the change a proposal",
    async (label) => {
      verdict = label;
      const result = structured(await complete());
      expect(result.resultType).toBe("open_loop.change_proposed");
      expect(result.data.notAppliedBecause).toEqual(expect.any(String));
      expect(getOpenLoop(db, "loop_t")).toMatchObject({
        state: "open",
        proposedChange: { kind: "complete", evidence: [docId] },
      });
    },
  );

  test("without a verifier, an inference, a misquote or the knob off, nothing is verified", async () => {
    build({ verifier: false });
    expect(structured(await complete()).resultType).toBe("open_loop.change_proposed");
    build();
    expect(
      structured(await complete({ evidence: evidence("inferred") })).data.notAppliedBecause,
    ).toBe("the change rests on an inference");
    expect(
      structured(await complete({ evidence: evidence("explicit", "This sentence is not in it.") }))
        .data.notAppliedBecause,
    ).toEqual(expect.stringContaining("could not be checked"));
    build({ autoApply: false });
    expect(structured(await complete()).data.notAppliedBecause).toBe(
      "automatic task changes are turned off",
    );
    expect(claims).toEqual([]);
    expect(getOpenLoop(db, "loop_t")!.state).toBe("open");
  });

  test("striking is proposed without asking the verifier", async () => {
    const result = structured(await complete({ state: "dismissed" }));
    expect(result.resultType).toBe("open_loop.change_proposed");
    expect(claims).toEqual([]);
    expect(getOpenLoop(db, "loop_t")!.proposedChange?.kind).toBe("strike");
  });

  test("a new title or description applies without asking the verifier", async () => {
    const result = structured(
      await update({
        id: "loop_t",
        title: "Settle the sound engineer's invoice",
        description: "The sound engineer invoiced for the budget review.",
        reason: "The invoice names who it is from and what it covers.",
      }),
    );
    expect(result.resultType).toBe("open_loop.change_applied");
    expect(claims).toEqual([]);
    expect(getOpenLoop(db, "loop_t")).toMatchObject({
      title: "Settle the sound engineer's invoice",
      description: "The sound engineer invoiced for the budget review.",
      proposedChange: null,
    });
    expect(listOpenLoopLedger(db, "loop_t").at(-1)!.event).toMatchObject({
      kind: "auto_applied",
      change: { kind: "edit", fields: ["title", "description"] },
    });
  });

  test("the user's description gains additions on its own, but a rewrite is proposed", async () => {
    applyTaskCommand(
      db,
      {
        surface: "tasks",
        runId: "user:tasks",
        kind: "edit",
        id: "loop_t",
        fields: { description: "My own words." },
      },
      nowMs - 10_000,
    );
    const rewrite = structured(
      await update({
        id: "loop_t",
        description: "Paid in full.",
        reason: "The receipt confirms payment.",
      }),
    );
    expect(rewrite.data.notAppliedBecause).toBe("the user wrote this description");
    expect(getOpenLoop(db, "loop_t")!.description).toBe("My own words.");

    const addition = structured(
      await update({
        id: "loop_t",
        description: "My own words. Paid in full.",
        reason: "The receipt confirms payment.",
      }),
    );
    expect(addition.resultType).toBe("open_loop.change_applied");
    expect(getOpenLoop(db, "loop_t")!.description).toBe("My own words. Paid in full.");
  });
  const rename = () =>
    update({
      id: "loop_t",
      title: "Settle the sound engineer's invoice",
      reason: "The invoice names who it is from.",
    });

  test("a new title applies when the decision model confirms it names the same task", async () => {
    scores = { same_task: 3 };
    build({ checks: taskChecks() });
    expect(structured(await rename()).resultType).toBe("open_loop.change_applied");
    expect(getOpenLoop(db, "loop_t")!.title).toBe("Settle the sound engineer's invoice");
    expect(ledger).toEqual([
      expect.objectContaining({
        purpose: "task-check",
        lane: "same_task",
        documentId: docId,
        recordId: "loop_t",
        verdict: "pass",
        requestJson: null,
      }),
    ]);
  });

  test.each([
    [0, "the new title may describe a different task"],
    ["outage" as const, "whether the new title still names the same task could not be checked"],
  ])("a title scored %s stays a proposal", async (score, why) => {
    scores = { same_task: score };
    build({ checks: taskChecks() });
    const result = structured(await rename());
    expect(result.resultType).toBe("open_loop.change_proposed");
    expect(result.data.notAppliedBecause).toBe(why);
    expect(getOpenLoop(db, "loop_t")).toMatchObject({
      title: "Pay the budget review invoice",
      proposedChange: { kind: "edit", fields: { title: "Settle the sound engineer's invoice" } },
    });
  });

  test("without a decision model a title applies unchecked, and a description never asks", async () => {
    build({ checks: taskChecks(false) });
    expect(structured(await rename()).resultType).toBe("open_loop.change_applied");
    build({ checks: taskChecks() });
    const described = structured(
      await update({
        id: "loop_t",
        description: "The sound engineer invoiced for the budget review.",
        reason: "The invoice says what it covers.",
      }),
    );
    expect(described.resultType).toBe("open_loop.change_applied");
    expect(asked).toEqual([]);
  });

  test("a note that repeats the task's history is left out of it", async () => {
    const append = (note: string) =>
      tools.find((t) => t.name === "open_loop_ledger_append")!.invoke({ id: "loop_t", note }, CTX);
    build({ checks: taskChecks() });
    const before = listOpenLoopLedger(db, "loop_t").length;
    scores = { adds_new: 0 };
    const repeated = structured(await append("Searched again; still no reply."));
    expect(repeated).toMatchObject({
      resultType: "open_loop.ledger_unchanged",
      data: { recorded: false },
    });
    expect(listOpenLoopLedger(db, "loop_t")).toHaveLength(before);
    scores = { adds_new: 1 };
    expect(structured(await append("The engineer replied with a revised amount.")).resultType).toBe(
      "open_loop.ledger_appended",
    );
    scores = { adds_new: "outage" };
    expect(structured(await append("A second invoice arrived.")).resultType).toBe(
      "open_loop.ledger_appended",
    );
    expect(listOpenLoopLedger(db, "loop_t")).toHaveLength(before + 2);
    expect(ledger.map((entry) => entry.verdict)).toEqual(["skip", "pass", "unavailable"]);
  });

  test("a task without documents anchors its checks to the source the run is reading", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_n",
        createdByRun: "r0",
        title: "Sort out the invoice",
        description: "",
        confidence: 0.8,
        importance: 0.5,
      },
      nowMs - 60_000,
    );
    applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "accept", id: "loop_n" },
      nowMs - 50_000,
    );
    build({ checks: taskChecks(), seedDocIds: [docId] });
    scores = { same_task: 3, adds_new: 1 };
    expect(
      structured(
        await update({
          id: "loop_n",
          title: "Pay the budget review invoice",
          reason: "The receipt names the invoice.",
        }),
      ).resultType,
    ).toBe("open_loop.change_applied");
    await tools
      .find((t) => t.name === "open_loop_ledger_append")!
      .invoke({ id: "loop_n", note: "The receipt arrived." }, CTX);
    expect(ledger.map((entry) => [entry.lane, entry.documentId, entry.recordId])).toEqual([
      ["same_task", docId, "loop_n"],
      ["adds_new", docId, "loop_n"],
    ]);
  });

  test("notes on a loop the user has not accepted are not checked", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_s",
        createdByRun: "r0",
        title: "Review the Q4 budget",
        description: "",
        confidence: 0.8,
        importance: 0.5,
      },
      nowMs - 60_000,
    );
    build({ checks: taskChecks() });
    const result = structured(
      await tools
        .find((t) => t.name === "open_loop_ledger_append")!
        .invoke({ id: "loop_s", note: "Nothing new." }, CTX),
    );
    expect(result.resultType).toBe("open_loop.ledger_appended");
    expect(asked).toEqual([]);
  });
});
