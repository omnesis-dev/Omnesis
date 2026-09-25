// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run briefs:scorecard` — run the Briefs reconcile-quality scorecard
 * end-to-end (epic #137, criteria 4, 13, 16).
 *
 * Boots an isolated spawned gateway on the `loops-test-life` universe,
 * delivers the seeded arc set through the real waker → queue → run driver
 * → tool pipeline, reduces the end state to the reconcile-quality metrics,
 * and emits `scorecard.json` plus the fixed-format convergence-ledger row.
 * Exits non-zero when a calibrated threshold is breached beyond its noise
 * band.
 *
 * Backends:
 *  - `--backend scripted` (default): the deterministic fake OpenAI server —
 *    zero tokens, zero spend. `--script saboteur` swaps in the planted-
 *    defect behavior table (instrument validation).
 *  - `--backend deepseek`: the priced Phase Two lane. Hard-refuses under
 *    CI; resolves the backend from `OMNESIS_BRIEFS_DEEPSEEK_URL/_KEY` or
 *    the operator config; wraps every run in the spend meter's
 *    reserve-then-run. Gated by the epic's operator directives (the
 *    `PHASE TWO` marker) — do not invoke it before the marker reads
 *    APPROVED.
 *
 * Manual-invocation only: never part of `npm run test`, ci.yml, or any
 * hook (the epic's lane policy).
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line no-restricted-imports -- evals tooling reaches into the collector e2e kit; evals/briefs is not a workspace package, so there is no package-name path to it
import {
  runScorecard,
  type DailyMix,
  type ScorecardBackendSpec,
  type ScorecardRunGuard,
} from "../../../packages/collector/src/e2e/briefs-scorecard.js";
// eslint-disable-next-line no-restricted-imports -- see above
import { FROZEN_ARC_SEED } from "../../../packages/collector/src/e2e/briefs-arcs.js";
import {
  assertDeepseekLaneAllowed,
  createMeteredRunGuard,
  defaultDurableLedgerPath,
  defaultOperatorConfigPath,
  describeDeepseekBackend,
  loadWorstCasePerRun,
  resolveDeepseekBackend,
} from "./deepseek-lane.js";
import { runFootprint } from "./footprint.js";
import { parseScorecardArgs } from "./scorecard-args.js";
import { assembleScorecard, loadThresholds, LEDGER_ROW_HEADER } from "./scorecard-report.js";
import {
  ledgerTotalUsd,
  loadBudget,
  loadPriceSheet,
  readSpendRecords,
  SpendMeter,
} from "./spend-meter.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVALS_DIR = join(REPO_ROOT, "evals", "briefs");
const DAILY_MIX_PATH = join(REPO_ROOT, "evals", "universes", "loops-test-life", "daily-mix.json");

/** The committed mix is documentation — fail loud the moment it drifts. */
function assertMixMatchesCommitted(actual: DailyMix): void {
  const committed = (JSON.parse(readFileSync(DAILY_MIX_PATH, "utf8")) as { mix: DailyMix }).mix;
  for (const key of Object.keys(committed) as Array<keyof DailyMix>) {
    if (committed[key] !== actual[key]) {
      throw new Error(
        `daily-mix drift: ${DAILY_MIX_PATH} says ${key}=${committed[key]} but the arc set ` +
          `derives ${actual[key]} — update the committed mix in the same change as the arc kit`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseScorecardArgs(process.argv.slice(2));
  const prices = loadPriceSheet(join(EVALS_DIR, "deepseek-prices.json"));
  const thresholds = loadThresholds(join(EVALS_DIR, "thresholds.json"));
  // Spend receipts live in their own committed journal
  // (`spend-ledger.jsonl`), paired with the durable out-of-repo ledger for
  // the max()-of-two eviction safety. The iteration-history in
  // `ledger.jsonl` is a separate concern (appended below).
  const iterationLedgerPath = join(EVALS_DIR, "ledger.jsonl");
  const ledgerPaths = [
    join(EVALS_DIR, "spend-ledger.jsonl"),
    defaultDurableLedgerPath(process.env),
  ];

  let backendSpec: ScorecardBackendSpec;
  let backendLabel: string;
  let guard: ScorecardRunGuard | undefined;
  if (args.backend === "deepseek") {
    // Refused FIRST — before any config read, any network-shaped object.
    assertDeepseekLaneAllowed(process.env);
    const config = resolveDeepseekBackend({
      env: process.env,
      configPath: defaultOperatorConfigPath(process.env),
    });
    process.stdout.write(`${describeDeepseekBackend(config)}\n`);
    const meter = new SpendMeter(prices, {
      budget: loadBudget(join(EVALS_DIR, "budget.json")),
      ledgerPaths,
    });
    guard = createMeteredRunGuard(
      meter,
      `scorecard-${new Date().toISOString()}`,
      loadWorstCasePerRun(join(EVALS_DIR, "budget.json")),
    );
    backendSpec = {
      kind: "http",
      backendName: "deepseek",
      url: config.url,
      apiKey: config.apiKey,
      modelId: args.model ?? prices.model,
    };
    backendLabel = "deepseek";
  } else {
    backendSpec = { kind: "scripted", script: args.script };
    backendLabel = args.script === "saboteur" ? "scripted-saboteur" : "scripted";
  }

  // Every scorecard run dumps its observable end-state (loops, briefs,
  // decisions, transcripts) into a git-ignored per-run dir — the raw
  // material for the Phase Two qualitative failure analysis.
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const iterSlug = args.iter.replace(/[^A-Za-z0-9_.-]/g, "_");
  const artifactsDir = join(EVALS_DIR, "runs", `${iterSlug}-${backendLabel}-${runStamp}`);

  const result = await runScorecard({
    gatewayMode: "experimental",
    backend: backendSpec,
    seed: args.seed,
    artifactsDir,
    ...(guard ? { guard } : {}),
  });
  assertMixMatchesCommitted(result.mix);
  process.stdout.write(`run artifacts dumped to ${artifactsDir}\n`);

  const footprint = runFootprint();
  const cumulativeSpendUsd = Math.max(
    ...ledgerPaths.map((path) => ledgerTotalUsd(readSpendRecords(path), path)),
  );
  const { report, ledgerRow, exitCode } = assembleScorecard({
    iter: args.iter,
    backend: backendLabel,
    seed: args.seed,
    frozenSeed: args.seed === FROZEN_ARC_SEED,
    mix: result.mix,
    metrics: result.metrics,
    counts: result.counts,
    prices,
    cumulativeSpendUsd,
    footprint: { sharedTotalLines: footprint.sharedTotalLines, base: footprint.base },
    thresholds,
  });

  const outPath = resolve(REPO_ROOT, args.out);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`scorecard written to ${outPath}\n\n`);

  // Append the run to the authoritative in-repo iteration-history — one JSON
  // record per scorecard run, committed to git (the durable numbers, never
  // hand-written). The markdown ledger row below is only for pasting into the
  // issue's convergence ledger.
  const iterationRecord = {
    kind: "scorecard-iteration",
    at: report.generatedAt,
    iter: report.iter,
    backend: report.backend,
    seed: report.seed,
    frozenSeed: report.frozenSeed,
    metrics: report.metrics,
    cumulativeSpendUsd: report.cumulativeSpendUsd,
    verdict: report.verdict,
  };
  appendFileSync(iterationLedgerPath, `${JSON.stringify(iterationRecord)}\n`, "utf8");

  process.stdout.write(`${LEDGER_ROW_HEADER}\n${ledgerRow}\n`);
  if (report.failures.length > 0) {
    process.stdout.write(`\nFAIL:\n${report.failures.map((f) => `  - ${f}`).join("\n")}\n`);
  }
  process.exitCode = exitCode;
}

// No top-level await: evals/ sits under the typeless root package.json, so
// tsx transforms this entry as CJS.
main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
