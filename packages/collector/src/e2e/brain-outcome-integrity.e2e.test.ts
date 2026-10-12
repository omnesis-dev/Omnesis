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
  sourceInterpretations,
  structuredData,
} from "./brain-bench/index.js";

compressCognitionCadences();

test("an independently refused outcome transition leaves the canonical action intact", async () => {
  const description = "Arrange the equipment briefing after schedule approval.";
  const destructiveDescription = "The schedule is approved.";
  const mail = email({
    externalId: "integrity-observation-session",
    title: "Observation session planning",
    content: "The observation schedule is approved. Please arrange the equipment briefing.",
  });
  const bench = await BrainBench.start({
    experimental: true,
    brain: {
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
      mergeAdjudication: { enabled: false },
      annotations: { recordCheck: "enforce" },
    },
    decision: {
      policy: (request) => {
        const state = request.state as {
          outcome_context?: { proposed?: { description?: string } };
        };
        // Only the scripted destructive edit is refused. Ordinary retention
        // reviews must be able to revalidate the unchanged supported action.
        const destructive = state.outcome_context?.proposed?.description === destructiveDescription;
        return Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            {
              type: "score" as const,
              score: id === "transition_integrity" && destructive ? 0.2 : 2.5,
            },
          ]),
        );
      },
      inputTokens: 31,
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: mail.title,
            plan: (ctx, _item, steps) => {
              const created = steps.find(
                (step) => step.name === "open_loop_create" && structuredData(step.result)?.loop,
              );
              const id = (structuredData(created?.result)?.loop as { id?: string } | undefined)?.id;
              return {
                calls: [
                  call("open_loop_search", { query: "observation briefing" }),
                  call("open_loop_create", {
                    title: "Prepare observation briefing",
                    description,
                    confidence: 0.8,
                    importance: 0.6,
                    docs: [ctx.subject],
                    annotationDependencies: [],
                  }),
                  ...(id
                    ? [
                        call("open_loop_search", { query: "observation briefing" }),
                        call("open_loop_fetch", { id }),
                        call("open_loop_update", {
                          id,
                          description: destructiveDescription,
                          annotationDependencies: [],
                        }),
                      ]
                    : []),
                ],
              };
            },
          },
        ],
      }),
    },
  });
  try {
    await bench.drainUntilQuiet();
    const [docId] = await bench.pushAndSettle([mail]);
    const run = await bench.obs.interpretationForSource(docId!);
    const steps = await bench.obs.executedTools(run.id);
    const refused = steps.find((step) => step.tool === "open_loop_update");
    expect(refused?.result?.resultType).toBe("record.not_saved");
    expect(refused?.result?.data?.reason).toContain("transition_integrity");
    expect(refused?.result?.data?.guidance).toContain("Re-read");
    expect(
      bench.sql
        .prepare("SELECT description FROM open_loops WHERE title=?")
        .all("Prepare observation briefing"),
    ).toEqual([{ description }]);
    const decisions = (await bench.obs.run(run.id)).decisions.filter(
      (d) => d.purpose === "record-check",
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      verdict: "skip",
      score: 0.2,
      threshold: 1.5,
      enforced: true,
    });
    expect(
      bench.sql
        .prepare("SELECT response_json FROM cognition_decisions WHERE id=?")
        .get(decisions[1]!.id),
    ).toMatchObject({
      response_json: expect.stringContaining('"limiting_question":"transition_integrity"'),
    });
  } finally {
    await bench.destroy();
  }
}, 120_000);

test("a refused deadline can be cleared while preserving the useful outcome", async () => {
  const mail = email({
    externalId: "planetarium-diagram",
    title: "Planetarium diagram draft",
    content:
      "Please prepare the dome diagram. The projection rehearsal is on 12 May 2028; no diagram due date is set.",
  });
  const bench = await BrainBench.start({
    experimental: true,
    brain: {
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
      mergeAdjudication: { enabled: false },
      annotations: { recordCheck: "enforce" },
    },
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "score" as const, score: id === "deadline_support" ? 0.2 : 2.5 },
          ]),
        ),
      inputTokens: 31,
    },
    behaviors: {
      dynamic: sourceInterpretations({
        maintainNode: preserveCurrentOwner,
        sources: [
          {
            docTitle: mail.title,
            plan: (ctx) => ({
              calls: [
                call("open_loop_search", { query: "dome diagram" }),
                call("open_loop_create", {
                  title: "Prepare dome diagram",
                  description: "Prepare the requested diagram.",
                  confidence: 0.8,
                  importance: 0.6,
                  deadline: { type: "by", date: "2028-05-12" },
                  docs: [ctx.subject],
                  annotationDependencies: [],
                }),
                call("open_loop_search", { query: "dome diagram" }),
                call("open_loop_create", {
                  title: "Prepare dome diagram",
                  description: "Prepare the requested diagram.",
                  confidence: 0.8,
                  importance: 0.6,
                  deadline: null,
                  docs: [ctx.subject],
                  annotationDependencies: [],
                }),
              ],
            }),
          },
        ],
      }),
    },
  });
  try {
    await bench.drainUntilQuiet();
    const [docId] = await bench.pushAndSettle([mail]);
    const run = await bench.obs.interpretationForSource(docId!);
    const steps = await bench.obs.executedTools(run.id);
    const attempts = steps.filter((step) => step.tool === "open_loop_create");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.result?.resultType).toBe("record.not_saved");
    expect(attempts[0]?.result?.data?.reason).toContain("deadline_support");
    expect(attempts[0]?.result?.data?.guidance).toContain("clear its unsupported deadline");
    expect(
      bench.sql
        .prepare(
          "SELECT title,deadline_json AS deadline FROM open_loops WHERE title='Prepare dome diagram'",
        )
        .all(),
    ).toEqual([{ title: "Prepare dome diagram", deadline: null }]);
    const decisions = (await bench.obs.run(run.id)).decisions.filter(
      (d) => d.purpose === "record-check",
    );
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      verdict: "skip",
      score: 0.2,
      threshold: 1.5,
      enforced: true,
    });
    expect(decisions[1]).toMatchObject({ verdict: "pass" });
  } finally {
    await bench.destroy();
  }
}, 120_000);
