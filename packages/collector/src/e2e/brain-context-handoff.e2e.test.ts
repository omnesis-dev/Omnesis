// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A maintenance run's conversation grows with every tool result. These
 * scenarios script the input size the model reports for each request and
 * assert that a run hands its durable frontier to a fresh-context successor —
 * at its context budget, or when the provider refuses an overflowing request —
 * and that the batch finishes with every input settled exactly once.
 */

import "./synth-env.js";
import { promptText, promptTokenFloor } from "@omnesis/agent";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainBench,
  call,
  compressCognitionCadences,
  decideNextTurn,
  email,
  preserveCurrentOwner,
  structuredData,
  type RunDto,
} from "./brain-bench/index.js";
import { knowledgePuppet } from "./brain-bench/knowledge-puppet.js";
import { startOpenAiServer, type WireMessage } from "./brain-bench/openai-server.js";

compressCognitionCadences();
const loopCount = 3;
// Every tool result adds this many reported input tokens to the next request.
const tokensPerToolResult = 1000;
const createdLoop = z.object({ loop: z.object({ id: z.string() }) });
let bench: BrainBench | undefined;
let server: Awaited<ReturnType<typeof startOpenAiServer>> | undefined;

afterEach(async () => {
  await bench?.destroy();
  await server?.close();
  bench = undefined;
  server = undefined;
}, 60_000);

const toolResults = (messages: readonly WireMessage[]): number =>
  messages.filter((message) => message.role === "tool").length;

const behaviors = {
  dynamic: knowledgePuppet({
    plan(item, ctx, steps) {
      if (item.source)
        return {
          calls: Array.from({ length: loopCount }, (_, index) => {
            const title = `Restock pantry shelf ${index + 1}`;
            return [
              call("open_loop_search", { query: title }),
              call("open_loop_create", {
                title,
                description: `${title} before the community dinner.`,
                docs: [item.source!.id],
                confidence: 0.9,
                importance: 0.5,
              }),
            ];
          }).flat(),
        };
      const preserved = preserveCurrentOwner(item, ctx, steps);
      if (item.node?.kind !== "loop") return preserved;
      return {
        calls: [
          call("knowledge_fetch", { id: item.id, editing: true }),
          ...Object.keys(item.inputVersions)
            .filter((ref) => ref.startsWith("source:"))
            .map((ref) => call("knowledge_reference", { ref })),
          ...preserved.calls,
        ],
      };
    },
    targets(_item, steps) {
      return steps.flatMap((step) => {
        if (step.name !== "open_loop_create") return [];
        const parsed = createdLoop.safeParse(structuredData(step.result));
        return parsed.success ? [parsed.data.loop.id] : [];
      });
    },
  }),
};

async function startScenario(opts: {
  respond: (messages: readonly WireMessage[]) => "overflow" | "answer";
  knowledge?: Record<string, unknown>;
}): Promise<BrainBench> {
  server = await startOpenAiServer({
    modelId: "context-handoff-fixture",
    respond(messages) {
      if (opts.respond(messages) === "overflow")
        return {
          kind: "httpError",
          status: 400,
          message:
            "This model's maximum context length is 16384 tokens. However, you requested 17000 tokens.",
        };
      const turn = decideNextTurn(messages, behaviors);
      return turn.kind === "tool"
        ? { kind: "tool", name: turn.name, args: turn.args }
        : { kind: "text", text: turn.text };
    },
    // The scripted count never drops under what the messages could tokenize
    // to: the agent backend reads a count below that floor as a server that
    // cut the prompt to its window and fails the turn, as it would a real one.
    promptTokens: (messages) =>
      Math.max(
        promptTokenFloor(promptText(messages)),
        tokensPerToolResult * (1 + toolResults(messages)),
      ),
  });
  return BrainBench.start({
    experimental: true,
    syncSources: false,
    entailment: "accept-all",
    extraInference: {
      backends: { handoff: { type: "http", url: server.url } },
      assignments: { "background-agent": `handoff/${server.modelId}` },
    },
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.entries(request.questions).map(([key, question]) => {
            if (question.type !== "score") throw new Error(`Unexpected decision ${key}`);
            return [
              key,
              { type: "score" as const, score: question.criteria.length - 1, confidence: 1 },
            ];
          }),
        ),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { soonDelay: "1s", routineDelay: "6h", ...opts.knowledge },
    },
  });
}

/** Push the scenario's email and drain until its first maintenance batch settles. */
async function runBatch(b: BrainBench): Promise<{ batchId: string; runs: RunDto[] }> {
  await b.push(
    email({
      externalId: "context-handoff-pantry",
      title: "Pantry restock for the community dinner",
      content: Array.from(
        { length: loopCount },
        (_, index) => `Restock pantry shelf ${index + 1} before the community dinner.`,
      ).join("\n"),
    }),
  );
  const sourceId = await b.docId("context-handoff-pantry");
  await expect
    .poll(
      () =>
        b.sql
          .prepare("SELECT 1 FROM knowledge_work WHERE subject_id=? AND batch_id IS NOT NULL")
          .get(sourceId),
      { timeout: 60_000 },
    )
    .toBeDefined();
  await b.drainUntilQuiet({ includeUpcoming: false, timeoutMs: 120_000 });
  const batch = b.sql
    .prepare<[string], { batch_id: string; status: string }>(
      `SELECT w.batch_id,b.status FROM knowledge_work w
       JOIN knowledge_batches b ON b.id=w.batch_id
       WHERE w.subject_kind='source' AND w.subject_id=? ORDER BY w.created_at LIMIT 1`,
    )
    .get(sourceId)!;
  expect(batch.status).toBe("completed");
  const runs = (await b.obs.runs({ kind: "synthesis" })).items.filter((run) => {
    const trigger = z.object({ batchId: z.string() }).safeParse(run.trigger);
    return trigger.success && trigger.data.batchId === batch.batch_id;
  });
  return { batchId: batch.batch_id, runs };
}

/** Every input of the batch was settled once, across however many segments ran. */
async function expectSettledOnce(b: BrainBench, runs: RunDto[]): Promise<void> {
  const tools = (await Promise.all(runs.map((run) => b.obs.executedTools(run.id)))).flat();
  const discoveries = tools.filter((step) => step.tool === "knowledge_discovery_complete");
  expect(discoveries).toHaveLength(1);
  expect(discoveries[0]!.args.targets).toHaveLength(loopCount);
  const saves = tools.filter((step) => step.tool === "knowledge_save");
  expect(saves).toHaveLength(loopCount);
  expect(new Set(saves.map((step) => step.args.inputFingerprint)).size).toBe(loopCount);
  expect((await b.obs.loops()).items).toHaveLength(loopCount);
}

it("hands a run that reached its context budget to a fresh-context successor", async () => {
  const handoffTokens = 12_000;
  bench = await startScenario({
    respond: () => "answer",
    knowledge: { contextHandoffTokens: handoffTokens },
  });
  const { runs } = await runBatch(bench);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  for (const run of runs) expect(run.status).toBe("completed");
  const handedOff = runs.filter((run) => run.context?.handoffReason === "context_budget");
  expect(handedOff.length).toBe(runs.length - 1);
  for (const run of handedOff) {
    // The request that crossed the budget was the last one the run sent.
    expect(run.context?.peakInputTokens).toBe(handoffTokens);
    expect(run.lastError).toContain("Context budget reached");
    const tools = await bench.obs.executedTools(run.id);
    expect(tools.length).toBe(handoffTokens / tokensPerToolResult);
  }
  // The final segment finished within the budget.
  const last = runs.find((run) => run.context?.handoffReason === null);
  expect(last?.context?.peakInputTokens).toBeLessThan(handoffTokens);
  await expectSettledOnce(bench, runs);
}, 240_000);

it("continues the frontier in a successor when the provider refuses an overflowing request", async () => {
  const overflowAt = 9;
  bench = await startScenario({
    respond: (messages) => (toolResults(messages) >= overflowAt ? "overflow" : "answer"),
  });
  const { runs } = await runBatch(bench);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  // The overflow costs no settled work: every segment completes, and each one
  // that overflowed names the refusal as its handoff reason.
  for (const run of runs) expect(run.status).toBe("completed");
  const overflowed = runs.filter((run) => run.context?.handoffReason === "context_window_exceeded");
  expect(overflowed.length).toBe(runs.length - 1);
  for (const run of overflowed) expect(run.lastError).toContain("context window exceeded");
  const transcripts = await bench.obs.run(overflowed[0]!.id);
  const attempt = (await bench.obs.transcript(transcripts.transcripts[0]!.fileName)).transcript;
  expect(attempt.failureCode).toBe("context_window_exceeded");
  await expectSettledOnce(bench, runs);
}, 240_000);
