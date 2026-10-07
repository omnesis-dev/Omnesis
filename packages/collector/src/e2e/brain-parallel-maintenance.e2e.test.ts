// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  collectToolSteps,
  compressCognitionCadences,
  decideNextTurn,
  email,
  preserveCurrentOwner,
  readRunContext,
  structuredData,
  waitFor,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { startOpenAiServer, userPromptOf } from "./brain-bench/openai-server.js";

compressCognitionCadences();
const frontierSchema = z.object({
  items: z.array(z.object({ source: z.object({ id: z.string() }).optional() })),
});
let bench: BrainBench | undefined;
let server: Awaited<ReturnType<typeof startOpenAiServer>> | undefined;
const held = new Map<string, { sourceId: string; release: () => void }>();
const entered = new Set<string>();
let releasing = false;
let peak = 0;

afterAll(async () => {
  releasing = true;
  for (const item of held.values()) item.release();
  await bench?.destroy();
  await server?.close();
}, 60_000);

it("runs four independent discoveries by default and refills a free slot while siblings wait", async () => {
  const behaviors = {
    dynamic: knowledgePuppet({
      plan(item, ctx, steps) {
        return item.source ? { calls: [] } : preserveCurrentOwner(item, ctx, steps);
      },
    }),
  };
  server = await startOpenAiServer({
    modelId: "parallel-maintenance-fixture",
    async respond(messages) {
      const ctx = readRunContext(userPromptOf(messages));
      const frontier = collectToolSteps(messages).findLast(
        (step) => step.name === "knowledge_next_frontier",
      );
      const parsed = frontierSchema.safeParse(frontier && structuredData(frontier.result));
      const sourceId = parsed.success
        ? parsed.data.items.find((item) => item.source)?.source?.id
        : undefined;
      if (ctx?.runId && sourceId && !entered.has(ctx.runId) && !releasing) {
        entered.add(ctx.runId);
        await new Promise<void>((resolve) => {
          held.set(ctx.runId, { sourceId, release: resolve });
          peak = Math.max(peak, held.size);
        });
        held.delete(ctx.runId);
      }
      const turn = decideNextTurn(messages, behaviors);
      return turn.kind === "tool"
        ? { kind: "tool", name: turn.name, args: turn.args }
        : { kind: "text", text: turn.text };
    },
  });
  bench = await BrainBench.start({
    experimental: true,
    syncSources: false,
    extraInference: {
      backends: { parallel: { type: "http", url: server.url } },
      assignments: { "background-agent": `parallel/${server.modelId}` },
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h" },
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    await bench.push(
      email({
        externalId: `parallel-independent-notice-${i}`,
        title: `Independent notice ${i}`,
        content: `Notice ${i} records an unrelated archive entry. No action is requested.`,
      }),
    );
    ids.push(await bench.docId(`parallel-independent-notice-${i}`));
  }
  await waitFor(
    "four simultaneously active source interpretations",
    () => held.size === 4 || null,
    60_000,
  );
  expect(new Set([...held.values()].map((item) => item.sourceId)).size).toBe(4);
  expect(entered.size).toBe(4);
  const firstRun = [...held.keys()][0]!;
  const sibling = [...held.values()][1]!;
  sibling.release();
  await waitFor(
    "fifth source enters while the first remains blocked",
    () => entered.size === 5 || null,
    60_000,
  );
  expect(held.has(firstRun)).toBe(true);
  expect(peak).toBe(4);
  releasing = true;
  for (const item of held.values()) item.release();
  await bench.drainUntilQuiet();
  for (const id of ids) {
    const rows = bench.sql
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM knowledge_discovery_coverage WHERE subject_id=? AND phase='interpretation'")
      .get(id);
    expect(rows?.count).toBe(1);
  }
  expect((await bench.obs.pulse()).counts.failedRuns24h).toBe(0);
}, 180_000);
