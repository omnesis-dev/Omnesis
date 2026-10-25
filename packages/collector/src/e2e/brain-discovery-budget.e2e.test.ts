// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { expect, test } from "vitest";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  email,
  sourceInterpretations,
  preserveCurrentOwner,
} from "./brain-bench/index.js";

compressCognitionCadences();

test("complete long-source admission skips only an actual negative decision and audits oversized fallback", async () => {
  const body = "Fictional observatory instrument measurements. ".repeat(1300);
  const low = email({
    externalId: "budget-low",
    title: "Archive instrument glossary",
    content: body,
  });
  const high = email({
    externalId: "budget-high",
    title: "Lens inspection schedule",
    content: body + "The final observation requests a lens inspection.",
  });
  const huge = email({
    externalId: "budget-huge",
    title: "Extended workshop archive",
    content: "界".repeat(50_000),
  });
  const bench = await BrainBench.start({
    experimental: true,
    brain: { knowledge: { soonDelay: "1s", routineDelay: "1s" } },
    behaviors: {
      dynamic: sourceInterpretations({
        sources: [
          {
            plan: (ctx) => ({
              calls: [
                call("fetch_many", {
                  documents: [{ documentId: ctx.subject, maxContentChars: 65536 }],
                }),
              ],
            }),
          },
        ],
        maintainNode: preserveCurrentOwner,
      }),
    },
    decision: {
      policy(request) {
        const purpose = Object.keys(request.questions)[0]!;
        const source = (request.state as { source?: { title: string; content: string } }).source;
        if (purpose === "discovery" && source?.title === low.title) {
          expect(source.content).toContain(body);
          return { [purpose]: { type: "score", score: 0 } };
        }
        return { [purpose]: { type: "score", score: 2 } };
      },
    },
  });
  try {
    await bench.drainUntilQuiet();
    await bench.pushAll([low, high, huge]);
    await bench.drainUntilQuiet();
    const lowId = await bench.docId(low.externalId),
      highId = await bench.docId(high.externalId),
      hugeId = await bench.docId(huge.externalId);
    expect(
      bench.sql
        .prepare(
          "SELECT status FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='interpretation'",
        )
        .get(lowId),
    ).toEqual({ status: "gated" });
    expect(await bench.obs.runsForSource(lowId)).toEqual([]);
    expect((await bench.obs.interpretationForSource(highId)).kind).toBe("synthesis");
    expect((await bench.obs.interpretationForSource(hugeId)).kind).toBe("synthesis");
    const row = bench.sql
      .prepare(
        "SELECT score,input_tokens,bypass_json FROM knowledge_decisions WHERE node_id=? AND purpose='discovery'",
      )
      .get(`source:${hugeId}`) as { score: null; input_tokens: number; bypass_json: string };
    expect(row).toMatchObject({ score: null, input_tokens: 0 });
    expect(JSON.parse(row.bypass_json)).toMatchObject({
      reason: "request_budget_exceeded",
      budgetBytes: 131072,
    });
    expect(
      bench.decision.calls.some(
        ({ request }) =>
          request.questions.discovery &&
          (request.state as { source?: { title: string } }).source?.title === huge.title,
      ),
    ).toBe(false);
  } finally {
    await bench.destroy();
  }
}, 120_000);
