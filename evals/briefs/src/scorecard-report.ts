// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scorecard reporting: the threshold gate, the verdict, and the two
 * artifacts every scorecard run emits — machine-readable `scorecard.json`
 * and the fixed-format convergence-ledger row the epic loop appends to
 * the issue ledger (numbers always machine-emitted, never hand-written).
 *
 * Pure: the harness-driving half lives in the collector e2e kit
 * (`packages/collector/src/e2e/briefs-scorecard.ts`); this module reduces
 * its result plus the committed context (thresholds, price sheet, spend
 * ledgers, shared-diff footprint) to the report.
 */

import { readFileSync } from "node:fs";
import { priceWorstCaseUsd, type PriceSheet } from "./spend-meter.js";
// eslint-disable-next-line no-restricted-imports -- evals tooling reaches into the collector e2e kit; evals/briefs is not a workspace package, so there is no package-name path to it
import type {
  DailyMix,
  ScorecardCounts,
  ScorecardMetrics,
} from "../../../packages/collector/src/e2e/briefs-scorecard.js";

// ── thresholds ──────────────────────────────────────────────────────────────

/**
 * Which direction each gateable metric fails in. `max` = the metric must
 * stay at or below the threshold; `min` = at or above. `briefs_per_day`,
 * `tokens_per_day`, `scheduled_runs`, and `malformed_tool_call_rate_raw`
 * (all failed mutating calls, self-corrected ones included — the gated
 * `malformed_tool_call_rate` counts only uncorrected failures) are
 * informational and never gate (deliberately not in this registry).
 */
const GATEABLE_METRICS: Record<string, "max" | "min"> = {
  duplicate_rate: "max",
  resolution_recall: "min",
  loop_precision: "min",
  loop_recall: "min",
  update_recall: "min",
  silent_close_violations: "max",
  infra_failure_rate: "max",
  malformed_tool_call_rate: "max",
};

export interface MetricThreshold {
  value: number;
  /** Max−min over K≥3 frozen-seed runs at one commit (the epic's protocol). */
  noiseBand: number;
}

export interface Thresholds {
  metrics: Record<string, MetricThreshold>;
}

/** Load + validate `thresholds.json`. Throws on any structural problem. */
export function loadThresholds(path: string): Thresholds {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const metricsRaw = raw.metrics;
  if (metricsRaw === null || typeof metricsRaw !== "object" || Array.isArray(metricsRaw)) {
    throw new Error(`${path}: "metrics" must be an object`);
  }
  const metrics: Record<string, MetricThreshold> = {};
  for (const [name, entry] of Object.entries(metricsRaw as Record<string, unknown>)) {
    if (!(name in GATEABLE_METRICS)) {
      throw new Error(
        `${path}: "${name}" is not a gateable metric (expected one of: ${Object.keys(GATEABLE_METRICS).join(", ")})`,
      );
    }
    const obj = entry as { value?: unknown; noiseBand?: unknown } | null;
    const value = obj?.value;
    const noiseBand = obj?.noiseBand;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${path}: metrics.${name}.value must be a finite number`);
    }
    if (typeof noiseBand !== "number" || !Number.isFinite(noiseBand) || noiseBand < 0) {
      throw new Error(`${path}: metrics.${name}.noiseBand must be a finite non-negative number`);
    }
    metrics[name] = { value, noiseBand };
  }
  return { metrics };
}

export type Verdict = "uncalibrated" | "pass" | "fail";

/**
 * Gate the (snake_case-keyed) metric values against the committed
 * thresholds. An empty thresholds map means Phase Two has not calibrated
 * yet — `uncalibrated`, never a failure. A threshold naming a metric the
 * run did not produce is a hard error (a silently ungated metric could
 * mask a regression).
 */
export function evaluateVerdict(
  metrics: Record<string, number>,
  thresholds: Thresholds,
): { verdict: Verdict; failures: string[] } {
  const entries = Object.entries(thresholds.metrics);
  if (entries.length === 0) return { verdict: "uncalibrated", failures: [] };
  const failures: string[] = [];
  for (const [name, threshold] of entries) {
    const direction = GATEABLE_METRICS[name];
    if (direction === undefined) throw new Error(`"${name}" is not a gateable metric`);
    const value = metrics[name];
    if (value === undefined) throw new Error(`metric "${name}" is gated but was not measured`);
    const breach =
      direction === "max"
        ? value > threshold.value + threshold.noiseBand
        : value < threshold.value - threshold.noiseBand;
    if (breach) {
      failures.push(
        `${name} = ${value.toFixed(4)} breaches ${direction} ${threshold.value} ` +
          `(noise band ±${threshold.noiseBand})`,
      );
    }
  }
  return { verdict: failures.length > 0 ? "fail" : "pass", failures };
}

// ── the ledger row ──────────────────────────────────────────────────────────

/** The fixed convergence-ledger template (frozen in the epic spec). */
export const LEDGER_ROW_HEADER =
  "| iter | backend | dup_rate | recall | precision | silent_close | briefs/day | tokens/day | infra_fail | cum_spend | shared_diff | verdict |";

export function formatLedgerRow(input: {
  iter: string;
  backend: string;
  metrics: ScorecardMetrics;
  estimatedUsdPerDay: number;
  cumulativeSpendUsd: number;
  sharedDiffLines: number;
  verdict: Verdict;
}): string {
  const m = input.metrics;
  return [
    "",
    input.iter,
    input.backend,
    m.duplicateRate.toFixed(3),
    m.resolutionRecall.toFixed(3),
    m.loopPrecision.toFixed(3),
    String(m.silentCloseViolations),
    m.briefsPerDay.toFixed(1),
    `${Math.round(m.tokensPerDay)} ($${input.estimatedUsdPerDay.toFixed(4)})`,
    m.infraFailureRate.toFixed(3),
    `$${input.cumulativeSpendUsd.toFixed(2)}`,
    String(input.sharedDiffLines),
    input.verdict,
    "",
  ]
    .join(" | ")
    .trim();
}

// ── assembly ────────────────────────────────────────────────────────────────

export interface ScorecardReport {
  generatedAt: string;
  iter: string;
  backend: string;
  seed: number;
  frozenSeed: boolean;
  mix: DailyMix;
  metrics: Record<string, number>;
  estimatedUsdPerDay: number;
  priceModel: string;
  counts: ScorecardCounts;
  cumulativeSpendUsd: number;
  footprint: { sharedTotalLines: number; base: string };
  verdict: Verdict;
  failures: string[];
  ledgerRow: string;
}

export function assembleScorecard(input: {
  iter: string;
  backend: string;
  seed: number;
  frozenSeed: boolean;
  mix: DailyMix;
  metrics: ScorecardMetrics;
  counts: ScorecardCounts;
  prices: PriceSheet;
  cumulativeSpendUsd: number;
  footprint: { sharedTotalLines: number; base: string };
  thresholds: Thresholds;
}): { report: ScorecardReport; ledgerRow: string; exitCode: number } {
  const m = input.metrics;
  const snakeMetrics: Record<string, number> = {
    duplicate_rate: m.duplicateRate,
    resolution_recall: m.resolutionRecall,
    loop_precision: m.loopPrecision,
    loop_recall: m.loopRecall,
    update_recall: m.updateRecall,
    silent_close_violations: m.silentCloseViolations,
    briefs_per_day: m.briefsPerDay,
    tokens_per_day: m.tokensPerDay,
    infra_failure_rate: m.infraFailureRate,
    malformed_tool_call_rate: m.malformedToolCallRate,
    malformed_tool_call_rate_raw: m.malformedToolCallRateRaw,
    scheduled_runs: m.scheduledRuns,
  };
  // Priced at the sheet's worst-case rates (all prompt tokens as cache
  // misses) — informational, deliberately conservative.
  const estimatedUsdPerDay =
    priceWorstCaseUsd(
      { promptTokens: input.counts.promptTokens, completionTokens: input.counts.completionTokens },
      input.prices,
    ) / input.mix.representsDays;
  const { verdict, failures } = evaluateVerdict(snakeMetrics, input.thresholds);
  const ledgerRow = formatLedgerRow({
    iter: input.iter,
    backend: input.backend,
    metrics: m,
    estimatedUsdPerDay,
    cumulativeSpendUsd: input.cumulativeSpendUsd,
    sharedDiffLines: input.footprint.sharedTotalLines,
    verdict,
  });
  const report: ScorecardReport = {
    generatedAt: new Date().toISOString(),
    iter: input.iter,
    backend: input.backend,
    seed: input.seed,
    frozenSeed: input.frozenSeed,
    mix: input.mix,
    metrics: snakeMetrics,
    estimatedUsdPerDay,
    priceModel: input.prices.model,
    counts: input.counts,
    cumulativeSpendUsd: input.cumulativeSpendUsd,
    footprint: input.footprint,
    verdict,
    failures,
    ledgerRow,
  };
  return { report, ledgerRow, exitCode: verdict === "fail" ? 1 : 0 };
}
