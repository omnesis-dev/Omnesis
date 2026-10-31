// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  ref,
  sourceInterpretations,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

const TITLE = "Reserve the greenhouse workshop room";
const GUIDE = email({
  externalId: "task-transition-room-guide",
  title: "Greenhouse workshop room guide",
  content: "The greenhouse workshop needs a room reservation. Keep this room guide with the task.",
});
const UPDATE = email({
  externalId: "task-transition-room-extension",
  title: "Greenhouse workshop reservation deadline extended",
  content: "The deadline to reserve the greenhouse workshop room is now 2032-06-24.",
});

test("enabling Brain keeps an existing owner's task, references and authored deadline", async () => {
  const bench = await BrainBench.start({
    experimental: false,
    syncSources: false,
    entailment: () => "entailment",
    brain: {
      bootstrap: { enabled: false },
      mergeAdjudication: { enabled: false },
      // Exercise the transition now instead of waiting the production 1h/6h intake delays.
      knowledge: { soonDelay: "0s", routineDelay: "0s" },
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: UPDATE.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: TITLE }),
                call("open_loop_update", {
                  id: ref("open_loop_search", "loops.0.id"),
                  docs: [ctx.subject],
                  deadline: { type: "by", date: "2032-06-24" },
                  reason: "The reservation deadline was extended in the new message.",
                  evidence: {
                    fact: "The reservation deadline is now 2032-06-24.",
                    basis: "explicit",
                    quotes: [{ docId: ctx.subject, quote: UPDATE.content }],
                  },
                }),
              ],
            }),
          },
        ],
      }),
    },
  });
  try {
    await bench.push(GUIDE);
    const guideId = await bench.docId(GUIDE.externalId);
    const created = await bench.obs.createTask({
      title: TITLE,
      scheduledFor: "2032-06-10",
      deadline: { type: "by", date: "2032-06-17" },
      docs: [guideId],
    });
    const taskId = created.task!.id;
    expect(created.task).toMatchObject({ origin: "user", accepted: true });
    expect(created.task!.documents.map((doc) => doc.id)).toEqual([guideId]);
    expect(
      (await bench.harness.gatewayJson<{ experimental: boolean }>("/status")).experimental,
    ).toBe(false);

    await bench.harness.restartGateway({ gatewayMode: "experimental" });
    expect(await bench.obs.status()).toMatchObject({ experimental: true, brain: { active: true } });
    const afterRestart = (await bench.obs.task(taskId)).task;
    expect(afterRestart).toMatchObject({
      id: taskId,
      title: TITLE,
      origin: "user",
      accepted: true,
      scheduledFor: "2032-06-10",
      deadline: { type: "by", date: "2032-06-17" },
    });
    expect(afterRestart.documents.map((doc) => doc.id)).toEqual([guideId]);

    await bench.push(UPDATE);
    const updateId = await bench.docId(UPDATE.externalId);
    await waitFor(
      "the Brain interprets the reservation update",
      async () => {
        try {
          return await bench.obs.interpretationForSource(updateId);
        } catch {
          return null;
        }
      },
      90_000,
    );
    await bench.drainUntilQuiet();
    const afterBrain = (await bench.obs.task(taskId)).task;
    expect(afterBrain).toMatchObject({
      id: taskId,
      title: TITLE,
      origin: "user",
      accepted: true,
      scheduledFor: "2032-06-10",
      deadline: { type: "by", date: "2032-06-17" },
      proposedChange: { kind: "edit", fields: { deadline: { type: "by", date: "2032-06-24" } } },
    });
    expect(afterBrain.documents.map((doc) => doc.id).sort()).toEqual([guideId, updateId].sort());
    const related = await bench.harness.gatewayJson<{
      tasks: Array<{ id: string; title: string }>;
    }>("/tasks?view=future&date=2026-10-31");
    expect(related.tasks.filter((task) => task.title === TITLE).map((task) => task.id)).toEqual([
      taskId,
    ]);
    expect(
      (await bench.obs.tasks("suggested")).tasks.filter((task) => task.title === TITLE),
    ).toEqual([]);
  } finally {
    await bench.destroy();
  }
}, 600_000);
