// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  sourceInterpretations,
} from "./brain-bench/index.js";

compressCognitionCadences();
const sentence = "The fictional planetarium demonstration is scheduled for 14 June 2034.";
const source = email({
  externalId: "temporal-scope-demonstration",
  title: "Planetarium demonstration plan",
  content: sentence,
});
let bench: BrainBench;
beforeAll(async () => {
  bench = await BrainBench.start({
    experimental: true,
    brain: { knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 } },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: source.title,
            expectedRefusals: [{ tool: "temporal_annotation_add", code: "revision_conflict" }],
            plan: (ctx) => {
              const add = {
                when: "2034-06-14",
                sentence,
                force: true,
                evidence: { docId: ctx.subject, quote: sentence },
              };
              return {
                calls: [
                  call("temporal_query", {
                    from: "2033-06-01",
                    to: "2033-07-01",
                    timeZone: "UTC",
                    origins: ["annotation"],
                    documentIds: [ctx.subject],
                  }),
                  call("temporal_annotation_add", add),
                  call("temporal_query", {
                    from: "2034-06-01",
                    to: "2034-07-01",
                    timeZone: "UTC",
                    origins: ["annotation"],
                    documentIds: [ctx.subject],
                  }),
                  call("temporal_annotation_add", add),
                ],
              };
            },
          },
        ],
      }),
    },
  });
}, 300_000);
afterAll(async () => {
  await bench?.destroy();
}, 60_000);

test("a real maintenance run must reconcile the intended scope before forced creation", async () => {
  const [docId] = await bench.pushAndSettle([source]);
  const run = await bench.obs.interpretationForSource(docId!);
  const writes = (await bench.obs.executedTools(run.id)).filter(
    (step) => step.tool === "temporal_annotation_add",
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]!.result).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(writes[1]!.result).toMatchObject({
    kind: "structured",
    resultType: "temporal_annotation.added",
  });
  expect(
    bench.sql
      .prepare("SELECT sentence,canonical FROM temporal_annotations WHERE sentence=?")
      .all(sentence),
  ).toEqual([{ sentence, canonical: "2034-06-14" }]);
}, 180_000);
