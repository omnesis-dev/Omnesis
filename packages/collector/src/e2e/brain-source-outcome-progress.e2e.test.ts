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
} from "./brain-bench/index.js";

compressCognitionCadences();

test("source progress survives a later-ingested older request without reopening the finished part", async () => {
  const title = "Prepare the Juniper spectrometer kit";
  const remaining = "Calibration is complete; protective packing remains before the kit is ready.";
  const initial = email({
    externalId: "juniper-kit-start",
    title: "Juniper kit preparation",
    content:
      "Prepare the Juniper spectrometer kit by calibrating it and completing protective packing.",
    ageDays: 3,
  });
  const progress = email({
    externalId: "juniper-kit-progress",
    title: "Juniper calibration completed",
    content: "Calibration of the Juniper spectrometer kit is complete. Protective packing remains.",
    ageDays: 1,
  });
  const olderRequest = email({
    externalId: "juniper-kit-calibration-request",
    title: "Juniper calibration request",
    content: "Please calibrate the Juniper spectrometer before packing the kit.",
    ageDays: 2,
  });
  let initialId = "";
  let progressId = "";
  const bench = await BrainBench.start({
    experimental: true,
    brain: {
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
      mergeAdjudication: { enabled: false },
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: initial.title,
            plan: (ctx) => {
              if (!ctx.subject) throw new Error("Expected offered source identity");
              initialId = ctx.subject;
              return {
                calls: [
                  call("open_loop_search", { query: "Juniper spectrometer" }),
                  call("open_loop_create", {
                    title,
                    description: initial.content,
                    confidence: 0.9,
                    importance: 0.6,
                    docs: [ctx.subject],
                  }),
                ],
              };
            },
          },
          {
            docTitle: progress.title,
            plan: (ctx) => {
              if (!ctx.subject) throw new Error("Expected offered source identity");
              progressId = ctx.subject;
              return {
                calls: [
                  call("open_loop_search", { query: "Juniper spectrometer" }),
                  call("open_loop_fetch", { id: ref("open_loop_search", "loops.0.id") }),
                  call("open_loop_update", {
                    id: ref("open_loop_search", "loops.0.id"),
                    description: remaining,
                    docs: [initialId, ctx.subject],
                  }),
                  call("open_loop_ledger_append", {
                    id: ref("open_loop_search", "loops.0.id"),
                    note: "Calibration completed; packing remains. The kit outcome is still open.",
                  }),
                ],
              };
            },
          },
          {
            docTitle: olderRequest.title,
            plan: () => ({
              calls: [
                call("open_loop_search", { query: "Juniper spectrometer" }),
                call("open_loop_fetch", { id: ref("open_loop_search", "loops.0.id") }),
                call("fetch_many", { documents: [{ documentId: progressId }] }),
                call("observation_list", {}),
              ],
              finalText:
                "The later completion evidence already covers calibration; packing remains on the existing outcome.",
            }),
          },
        ],
      }),
    },
  });
  try {
    await bench.drainUntilQuiet();
    await bench.pushAndSettle([initial]);
    await bench.pushAndSettle([progress]);
    const [olderId] = await bench.pushAndSettle([olderRequest]);
    expect(
      bench.sql
        .prepare("SELECT title, description, state FROM open_loops WHERE title=?")
        .all(title),
    ).toEqual([{ title, description: remaining, state: "open" }]);
    const loops = (await bench.obs.loops()).items;
    expect(loops).toHaveLength(1);
    expect(loops[0]?.docs).toEqual(expect.arrayContaining([initialId, progressId]));
    expect((await bench.obs.ledger(loops[0]!.id)).items.map((entry) => entry.note)).toContain(
      "Calibration completed; packing remains. The kit outcome is still open.",
    );
    expect((await bench.obs.observations()).items).toHaveLength(0);
    const run = await bench.obs.interpretationForSource(olderId!);
    const steps = await bench.obs.executedTools(run.id);
    expect(
      steps.some((step) => step.tool === "open_loop_fetch" && step.result?.kind === "structured"),
    ).toBe(true);
    expect(
      steps.some(
        (step) => step.tool === "fetch_many" && JSON.stringify(step.args).includes(progressId),
      ),
    ).toBe(true);
    expect(
      steps.some((step) =>
        ["open_loop_create", "open_loop_update", "observation_note"].includes(step.tool),
      ),
    ).toBe(false);
  } finally {
    await bench.destroy();
  }
}, 120_000);
