// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, test } from "vitest";
import {
  BrainBench,
  call,
  collectToolSteps,
  compressCognitionCadences,
  decideNextTurn,
  email,
  preserveCurrentOwner,
  readRunContext,
  sourceInterpretations,
  waitFor,
} from "./brain-bench/index.js";
import { startOpenAiServer, userPromptOf } from "./brain-bench/openai-server.js";
import type { SourceInterpretation } from "./brain-bench/source-interpretations.js";

compressCognitionCadences();
const sentence = "The fictional observatory demonstration is scheduled for 17 August 2035.";
const sources = [0, 1].map((i) =>
  email({
    externalId: `epoch-independent-${i}`,
    title: `Independent observatory ${i}`,
    content: sentence,
  }),
);
let bench: BrainBench | undefined;
let server: Awaited<ReturnType<typeof startOpenAiServer>> | undefined;
const held = new Map<string, () => void>();
const entered = new Set<string>();
afterAll(async () => {
  for (const release of held.values()) release();
  await bench?.destroy();
  await server?.close();
}, 60_000);

test("two complete disjoint document reads survive serialized real-writer commits", async () => {
  const behaviors = {
    dynamic: sourceInterpretations({
      maintainNode: preserveCurrentOwner,
      sources: sources.map<SourceInterpretation>((source) => ({
        docTitle: source.title,
        plan: (ctx) => ({
          calls: [
            call("temporal_query", {
              from: "2035-08-01",
              to: "2035-09-01",
              timeZone: "UTC",
              origins: ["annotation"],
              documentIds: [ctx.subject],
            }),
            call("temporal_annotation_add", {
              when: "2035-08-17",
              sentence,
              force: true,
              documentIds: [ctx.subject],
              evidence: { docId: ctx.subject, quote: sentence },
            }),
          ],
        }),
      })),
    }),
  };
  server = await startOpenAiServer({
    modelId: "temporal-document-epoch-fixture",
    async respond(messages) {
      const ctx = readRunContext(userPromptOf(messages));
      const turn = decideNextTurn(messages, behaviors);
      if (
        ctx?.runId &&
        turn.kind === "tool" &&
        turn.name === "temporal_annotation_add" &&
        !entered.has(ctx.runId)
      ) {
        expect(collectToolSteps(messages).some((step) => step.name === "temporal_query")).toBe(
          true,
        );
        entered.add(ctx.runId);
        await new Promise<void>((resolve) => held.set(ctx.runId, resolve));
      }
      return turn.kind === "tool"
        ? { kind: "tool", name: turn.name, args: turn.args }
        : { kind: "text", text: turn.text };
    },
  });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    extraInference: {
      backends: { epochs: { type: "http", url: server.url } },
      assignments: { "background-agent": `epochs/${server.modelId}` },
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { maxSeeds: 1, maxFrontierNodes: 1, soonDelay: "1s", routineDelay: "6h" },
    },
  });
  for (const source of sources) await bench.push(source);
  await waitFor(
    "both complete temporal queries reach the write barrier",
    () => held.size === 2 || null,
    60_000,
  );
  const releases = [...held.values()];
  releases[0]!();
  await waitFor(
    "first canonical temporal write commits",
    () =>
      bench!.sql.prepare<[], { n: number }>("SELECT COUNT(*) n FROM temporal_annotations").get()
        ?.n === 1 || null,
    30_000,
  );
  releases[1]!();
  await bench.drainUntilQuiet();
  expect(bench.sql.prepare("SELECT COUNT(*) n FROM temporal_annotations").get()).toEqual({ n: 2 });
  for (const runId of held.keys()) {
    const writes = (await bench.obs.executedTools(runId)).filter(
      (step) => step.tool === "temporal_annotation_add",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.result).toMatchObject({
      kind: "structured",
      resultType: "temporal_annotation.added",
    });
  }
}, 180_000);
