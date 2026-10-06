// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Isolated deterministic gateway demo; no live account or model backend is used. */
import "../packages/collector/src/e2e/synth-env.js";
import { createInterface } from "node:readline/promises";
import { createLogger } from "@omnesis/core";
import {
  BrainBench,
  compressCognitionCadences,
} from "../packages/collector/src/e2e/brain-bench/bench.js";
import { knowledgePuppet } from "../packages/collector/src/e2e/brain-bench/knowledge-puppet.js";
import {
  nextGenDecisionPolicy,
  nextGenPolicy,
} from "../packages/collector/src/e2e/brain-bench/next-gen-policy.js";
import {
  loadNextGenScenario,
  NextGenScenarioDriver,
} from "../packages/collector/src/e2e/brain-bench/next-gen-scenario.js";

const flags = new Set(process.argv.slice(2));
const allowed = new Set(["--focused", "--auto", "--exit-after"]);
for (const flag of flags) if (!allowed.has(flag)) throw new Error(`Unknown option ${flag}`);
const log = createLogger("collector:brain-demo");
const scenario = loadNextGenScenario();
const scenarioTitles = new Set(Object.values(scenario.documents).map((doc) => doc.title));
compressCognitionCadences();
const input = createInterface({ input: process.stdin, output: process.stdout });
let bench: BrainBench | undefined;
let closing: Promise<void> | undefined;
let stopping = false;
const close = () =>
  (closing ??= (async () => {
    input.close();
    await bench?.destroy();
  })());
const stop = () => {
  stopping = true;
  input.close();
  if (bench) void close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  bench = await BrainBench.start({
    universe: "sacha-bellamy",
    experimental: true,
    clock: "virtual",
    syncSources: !flags.has("--focused"),
    ...(!flags.has("--focused") ? { initialInventory: "pre-existing" as const } : {}),
    embedder: true,
    entailment: "accept-all",
    judge: "hold-all",
    decision: {
      policy: (request) => {
        // Ambient sources stay searchable. Only the progression has scripted
        // synthesis judgements; a demo must not invent decisions for other stories.
        const state = request.state as { title?: unknown; source?: { title?: unknown } };
        const title = state?.title ?? state?.source?.title;
        if (request.questions.discovery && typeof title === "string" && !scenarioTitles.has(title))
          return { discovery: { type: "score", score: 0, confidence: 1 } };
        return typeof nextGenDecisionPolicy === "function"
          ? nextGenDecisionPolicy(request)
          : { httpError: 500, message: "Demo requires its scripted policy" };
      },
    },
    behaviors: {
      dynamic: knowledgePuppet({
        ...nextGenPolicy,
        plan: (item, ctx, steps) =>
          item.source && !scenarioTitles.has(item.source.title)
            ? { calls: [] }
            : nextGenPolicy.plan(item, ctx, steps),
        targets: (item, steps) =>
          item.source && !scenarioTitles.has(item.source.title)
            ? []
            : (nextGenPolicy.targets?.(item, steps) ?? []),
      }),
    },
    brain: {
      bootstrap: { enabled: false },
      derivationBarrier: "0s",
      knowledge: { rootMaxChars: 2000, soonDelay: "1h", routineDelay: "6h" },
    },
  });
  if (stopping) throw new Error("Demo stopped during startup");
  if (bench.initialInventory) {
    log.info(
      `Pre-existing inventory: ${bench.initialInventory.documentCount} documents; ${bench.initialInventory.sourceChangeCount} initial arrivals checkpointed before cognition started. Historical synthesis coverage remains absent.`,
    );
  }
  await bench.clock.set(Date.parse(scenario.epoch));
  const sourceId = bench.harness.getSourceIds().find((id) => id.startsWith("gmail:"));
  if (!sourceId) throw new Error("The fictional universe has no mail source");
  const driver = new NextGenScenarioDriver(bench, scenario, { providerId: "google", sourceId });
  log.info(`Isolated inspector: ${bench.harness.gatewayUrl}/portal/debug/cognition/knowledge`);
  log.info(
    `Its local configuration and authentication token are in ${bench.harness.getConfigDir()}`,
  );
  log.info(
    "Every model judgement is scripted. This demonstrates engine behavior, not synthesis quality.",
  );
  for (const step of scenario.steps) {
    if (!flags.has("--auto"))
      await input.question(`Enter to advance to ${step.id} (+${step.minute} minutes): `);
    if (closing) break;
    await driver.advance();
    await bench.drainUntilQuiet({
      includeUpcoming: false,
      // The first checkpoint can also finish bounded evidence cascades from
      // loading the pre-existing inventory. Later checkpoints are small.
      timeoutMs: step === scenario.steps[0] && !flags.has("--focused") ? 600_000 : 300_000,
    });
    const failed = (await bench.obs.runs({ status: "failed" })).items;
    if (failed.length)
      throw new Error(`Replay failed: inspect run ${failed[0]!.id} in the isolated gateway log`);
    const state = await bench.harness.gatewayJson<{ items: Array<{ kind: string }> }>(
      "/admin/brain/knowledge?limit=100",
    );
    log.info(
      `${step.id}: ${state.items.length} visible synthesis nodes; future tiers remain queued until the virtual clock reaches them`,
    );
  }
  if (!flags.has("--exit-after") && !closing) {
    log.info("Replay complete; the isolated gateway remains available until Enter or Ctrl+C.");
    await input.question("");
  }
} catch (error) {
  if (bench) {
    try {
      log.error(
        `Replay stopped: ${JSON.stringify({
          pulse: await bench.obs.pulse(),
          maintenance: await bench.harness.gatewayJson("/admin/brain/knowledge/status"),
          runs: await bench.obs.runs({ limit: 10 }),
        })}`,
      );
    } catch {
      // Preserve the original failure if the isolated gateway is already gone.
    }
  }
  throw error;
} finally {
  await close();
}
