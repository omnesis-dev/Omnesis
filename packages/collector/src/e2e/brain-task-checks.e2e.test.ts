// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Brain bench: decision-model checks on the user's own tasks.
 *
 * With a decision model assigned, a new title applies to an accepted task on
 * its own only when the model scores it as naming the same task; otherwise it
 * waits as a proposal. A note a run appends to an accepted task is recorded
 * only when the model scores it as adding something to the task's history.
 * Every verdict is a `task-check` row on the run that asked. The scripted
 * decision server answers every other question at its top level, so the worth
 * gate and record check let each run through.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  sourceInterpretations,
  type TaskDto,
} from "./brain-bench/index.js";
import type { DecisionAnswer } from "@omnesis/core";
import type { DecisionServerRequest } from "./brain-bench/decision-server.js";

compressCognitionCadences();

const SUGGESTION = email({
  externalId: "task-checks-bake-sale",
  title: "Bake sale planning",
  content: "Hello,\n\nCould you book the community centre for the bake sale?\n\nStudio Northstar",
});
const TASK_TITLE = "Book the community centre for the bake sale";

const DRIFT = email({
  externalId: "task-checks-market",
  title: "Farmers market stalls",
  content: "Hello,\n\nStalls at the farmers market are open for booking.\n\nStudio Northstar",
});
const DRIFT_TITLE = "Book a stall at the farmers market";

const REFINE = email({
  externalId: "task-checks-main-hall",
  title: "Community centre rooms",
  content:
    "Hello,\n\nFor the bake sale, the community centre suggests its main hall.\n\nStudio Northstar",
});
const REFINED_TITLE = "Book the community centre's main hall for the bake sale";

const UPDATE = email({
  externalId: "task-checks-follow-up",
  title: "Bake sale follow-up",
  content:
    "Hello,\n\nStill waiting on the community centre. The hall costs £40 for the afternoon.\n\nStudio Northstar",
});
const REPEATED_NOTE = "Still waiting on the community centre.";
const NEW_NOTE = "The main hall costs £40 for the afternoon.";

/** Top level for every score question, except the two this suite scripts low. */
function policy(request: DecisionServerRequest): Record<string, DecisionAnswer> {
  const state = request.state as { after?: { title?: string }; note?: string };
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== "score") continue;
    const top = question.criteria.length - 1;
    const low =
      (id === "same_task" && state.after?.title === DRIFT_TITLE) ||
      (id === "adds_new" && state.note === REPEATED_NOTE);
    const score = low ? 0 : top;
    answers[id] = { type: "score", score, confidence: 0.9, probabilities: { [score]: 1 } };
  }
  return answers;
}

describe("brain bench: task checks", () => {
  let bench: BrainBench;
  let taskId = "";

  const view = async (name: string): Promise<TaskDto[]> => (await bench.obs.tasks(name)).tasks;
  const taskChecksOf = async (docId: string) => {
    const run = await bench.obs.interpretationForSource(docId);
    return (await bench.obs.run(run.id)).decisions.filter((d) => d.purpose === "task-check");
  };
  const retitle = (title: string, reason: string) => ({
    calls: [
      call("open_loop_search", { query: "community centre" }),
      call("open_loop_update", { id: ref("open_loop_search", "loops.0.id"), title, reason }),
    ],
  });

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: true,
      syncSources: false,
      decision: { policy, inputTokens: 40 },
      entailment: () => "entailment",
      brain: {
        knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
        derivationBarrier: "0s",
        bootstrap: { enabled: false },
        mergeAdjudication: { enabled: false },
      },
      behaviors: {
        dynamic: sourceInterpretations({
          maintainNode: preserveCurrentOwner,
          sources: [
            {
              docTitle: SUGGESTION.title,
              plan: (ctx) => ({
                calls: [
                  call("open_loop_search", { query: "community centre" }),
                  call("open_loop_create", {
                    title: TASK_TITLE,
                    confidence: 0.9,
                    importance: 0.6,
                    docs: [ctx.subject],
                  }),
                ],
              }),
            },
            {
              docTitle: DRIFT.title,
              plan: () => retitle(DRIFT_TITLE, "Market stalls are open for booking."),
            },
            {
              docTitle: REFINE.title,
              plan: () => retitle(REFINED_TITLE, "The centre suggests its main hall."),
            },
            {
              docTitle: UPDATE.title,
              plan: () => ({
                calls: [
                  call("open_loop_search", { query: "community centre" }),
                  ...[REPEATED_NOTE, NEW_NOTE].map((note) =>
                    call("open_loop_ledger_append", {
                      id: ref("open_loop_search", "loops.0.id"),
                      note,
                    }),
                  ),
                ],
              }),
            },
          ],
        }),
      },
    });
    await bench.pushAndSettle([SUGGESTION]);
    const suggestion = (await view("suggested")).find((t) => t.title === TASK_TITLE)!;
    taskId = suggestion.id;
    expect((await bench.obs.taskAction(taskId, { action: "accept" })).status).toBe(200);
  }, 600_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  test("a title that names another task waits as a proposal", async () => {
    const [docId] = await bench.pushAndSettle([DRIFT]);
    const task = (await bench.obs.task(taskId)).task;
    expect(task.title).toBe(TASK_TITLE);
    expect(task.proposedChange).toMatchObject({ kind: "edit", fields: { title: DRIFT_TITLE } });
    expect(await taskChecksOf(docId!)).toEqual([
      expect.objectContaining({ verdict: "skip", enforced: true }),
    ]);
  }, 240_000);

  test("a title that refines the same task applies on its own", async () => {
    const [docId] = await bench.pushAndSettle([REFINE]);
    const detail = await bench.obs.task(taskId);
    expect(detail.task).toMatchObject({ title: REFINED_TITLE, proposedChange: null });
    expect(detail.history[0]).toMatchObject({ kind: "auto_applied", change: "edit" });
    expect(await taskChecksOf(docId!)).toEqual([expect.objectContaining({ verdict: "pass" })]);
  }, 240_000);

  test("a note that repeats the task's history is left out of it", async () => {
    const [docId] = await bench.pushAndSettle([UPDATE]);
    const notes = (await bench.obs.task(taskId)).history.map((e) => e.note);
    expect(notes).toContain(NEW_NOTE);
    expect(notes).not.toContain(REPEATED_NOTE);
    expect((await taskChecksOf(docId!)).map((d) => d.verdict).sort()).toEqual(["pass", "skip"]);
  }, 240_000);
});
