// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Isolated deterministic gateway demo; no live account or model backend is used. */
import "../packages/collector/src/e2e/synth-env.js";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { createLogger, LogLevel, setLogLevel } from "@omnesis/core";
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
// Interactive guidance stays visible while routine collector chatter stays quiet.
if (!flags.has("--auto") && !process.env.OMNESIS_LOG_LEVEL) setLogLevel(LogLevel.WARN);
const announce = (message: string) => process.stdout.write(`${message}\n`);
function inspectorUrl(localUrl: string): string {
  const url = new URL("/portal/debug/cognition/knowledge", localUrl);
  try {
    const status = JSON.parse(
      execFileSync("tailscale", ["status", "--json"], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    ) as { Self?: { DNSName?: unknown } };
    const name = status.Self?.DNSName;
    if (typeof name === "string" && /^[a-z0-9.-]+\.ts\.net\.?$/i.test(name))
      url.hostname = name.replace(/\.$/, "");
  } catch {
    // Tailscale is optional; a local URL works on every development machine.
  }
  return url.toString();
}
const stepGuides: Record<string, string> = {
  "recent-bootstrap": "Create the first wikis and tracked commitments",
  "unchanged-replay": "Replay the same message — nothing should change",
  "discovered-urgent-correction": "Move gathering setup from 10:00 to 08:00",
  "same-document-edit": "Edit the crate reservation; its repair waits for the hourly tier",
  "late-historic-evidence": "Add an older proposal without replacing the accepted plan",
  "one-hour-boundary": "Advance the clock and process the hourly updates",
  "parallel-regions": "Record separate camera and gathering updates",
  "shared-batch-frontier": "Process one message that connects both projects",
  "privacy-delete": "Delete private access evidence and remove its derived page",
  "suppressed-resurrection": "Verify deleted evidence cannot return",
  "no-page-for-every-source": "Add an unrelated note without creating an unnecessary wiki",
  "conflicting-evidence": "Introduce a conflicting, unconfirmed setup time",
  "resolve-conflict": "Resolve the conflict with organiser confirmation",
  "routine-boundary": "Advance the clock to finish routine maintenance",
};
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
  announce("\nPreparing your isolated Brain demo…");
  announce(
    flags.has("--focused")
      ? "Loading the guided story. Your normal Omnesis data is not used."
      : "Loading the fictional universe (about 28,000 documents). This takes several minutes. Your normal Omnesis data is not used.",
  );
  announce("The first wikis will be created automatically. Wait for DEMO READY below.\n");
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
  const url = inspectorUrl(bench.harness.gatewayUrl);
  for (const [index, step] of scenario.steps.entries()) {
    if (index > 0 && !flags.has("--auto")) {
      announce(`\nNext · ${stepGuides[step.id] ?? step.id}`);
      await input.question(
        "Press Enter to run this event, or explore the browser first. Ctrl+C stops the demo: ",
      );
    }
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
    if (index === 0) {
      announce(`\nDEMO READY — open ${url}`);
      if (!flags.has("--exit-after")) announce(`Demo-only login token: ${bench.harness.apiKey}`);
      announce(
        "This disposable server uses a self-signed certificate; your browser may ask you to continue.",
      );
      announce(
        "Start with Winter lantern gathering. Read its overview, then open Evidence to see what supports it.",
      );
      announce(
        "The browser shows the brain. This terminal introduces the next event. Refresh the browser after an event finishes.",
      );
      announce("All model responses are scripted to demonstrate engine behavior.\n");
    } else if (!flags.has("--auto")) {
      announce(
        `Done · ${stepGuides[step.id] ?? step.id}. Refresh the browser to inspect the result.`,
      );
    }
  }
  if (!flags.has("--exit-after") && !closing) {
    announce(
      "\nAll events complete. Keep exploring in the browser. Press Enter or Ctrl+C here only when you want to stop the demo.",
    );
    await input.question("");
  }
} catch (error) {
  if (bench && !stopping) {
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
  if (!stopping) throw error;
} finally {
  await close();
}
