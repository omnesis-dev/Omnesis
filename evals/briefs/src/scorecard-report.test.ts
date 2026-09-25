// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assembleScorecard,
  evaluateVerdict,
  formatLedgerRow,
  loadThresholds,
  LEDGER_ROW_HEADER,
} from "./scorecard-report.js";
import type { ScorecardMetrics } from "../../../packages/collector/src/e2e/briefs-scorecard.js";
import type { PriceSheet } from "./spend-meter.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeThresholds(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "briefs-thresholds-"));
  tempDirs.push(dir);
  const path = join(dir, "thresholds.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const METRICS: ScorecardMetrics = {
  duplicateRate: 0.1,
  resolutionRecall: 0.9,
  loopPrecision: 0.8,
  loopRecall: 0.875,
  updateRecall: 1,
  silentCloseViolations: 0,
  briefsPerDay: 5,
  tokensPerDay: 100_000,
  infraFailureRate: 0,
  malformedToolCallRate: 0.04,
  malformedToolCallRateRaw: 0.08,
  scheduledRuns: 3,
};

const SNAKE: Record<string, number> = {
  duplicate_rate: 0.1,
  resolution_recall: 0.9,
  loop_precision: 0.8,
  loop_recall: 0.875,
  update_recall: 1,
  silent_close_violations: 0,
  briefs_per_day: 5,
  tokens_per_day: 100_000,
  infra_failure_rate: 0,
  malformed_tool_call_rate: 0.04,
  malformed_tool_call_rate_raw: 0.08,
  scheduled_runs: 3,
};

const PRICES: PriceSheet = {
  model: "test-model",
  currency: "USD",
  per1MTokensUsd: { inputCacheHit: 0.001, inputCacheMiss: 0.1, output: 0.2 },
  sourceUrl: "https://example.com/pricing",
  retrievedAt: "2026-07-01",
};

describe("loadThresholds", () => {
  test("accepts an empty metrics map and well-formed entries", () => {
    expect(loadThresholds(writeThresholds({ metrics: {} }))).toEqual({ metrics: {} });
    expect(
      loadThresholds(
        writeThresholds({
          metrics: {
            duplicate_rate: { value: 0.1, noiseBand: 0.02 },
            loop_recall: { value: 1, noiseBand: 0 },
            update_recall: { value: 1, noiseBand: 0 },
            malformed_tool_call_rate: { value: 0.05, noiseBand: 0.01 },
          },
        }),
      ),
    ).toEqual({
      metrics: {
        duplicate_rate: { value: 0.1, noiseBand: 0.02 },
        loop_recall: { value: 1, noiseBand: 0 },
        update_recall: { value: 1, noiseBand: 0 },
        malformed_tool_call_rate: { value: 0.05, noiseBand: 0.01 },
      },
    });
  });

  test("rejects unknown metrics, non-numeric values, and negative noise bands", () => {
    expect(() =>
      loadThresholds(writeThresholds({ metrics: { briefs_per_day: { value: 1, noiseBand: 0 } } })),
    ).toThrow(/not a gateable metric/);
    expect(() =>
      loadThresholds(
        writeThresholds({ metrics: { duplicate_rate: { value: "x", noiseBand: 0 } } }),
      ),
    ).toThrow(/value must be a finite number/);
    expect(() =>
      loadThresholds(
        writeThresholds({ metrics: { duplicate_rate: { value: 0.1, noiseBand: -1 } } }),
      ),
    ).toThrow(/noiseBand/);
    expect(() => loadThresholds(writeThresholds({ metrics: [] }))).toThrow(/must be an object/);
  });
});

describe("evaluateVerdict", () => {
  test("no thresholds = uncalibrated, never a failure", () => {
    expect(evaluateVerdict(SNAKE, { metrics: {} })).toEqual({
      verdict: "uncalibrated",
      failures: [],
    });
  });

  test("max metrics fail above value+band, min metrics below value-band", () => {
    const pass = evaluateVerdict(SNAKE, {
      metrics: {
        duplicate_rate: { value: 0.09, noiseBand: 0.02 }, // 0.1 <= 0.11
        resolution_recall: { value: 0.95, noiseBand: 0.06 }, // 0.9 >= 0.89
      },
    });
    expect(pass).toEqual({ verdict: "pass", failures: [] });

    const fail = evaluateVerdict(SNAKE, {
      metrics: {
        duplicate_rate: { value: 0.05, noiseBand: 0.01 }, // 0.1 > 0.06
        resolution_recall: { value: 0.99, noiseBand: 0.01 }, // 0.9 < 0.98
      },
    });
    expect(fail.verdict).toBe("fail");
    expect(fail.failures).toHaveLength(2);
    expect(fail.failures[0]).toMatch(/duplicate_rate/);
  });

  test("a gated-but-unmeasured metric is a hard error", () => {
    expect(() =>
      evaluateVerdict({}, { metrics: { duplicate_rate: { value: 0.1, noiseBand: 0 } } }),
    ).toThrow(/was not measured/);
  });
});

describe("formatLedgerRow / assembleScorecard", () => {
  test("emits the fixed-format row matching the frozen header", () => {
    const row = formatLedgerRow({
      iter: "13",
      backend: "scripted",
      metrics: METRICS,
      estimatedUsdPerDay: 0.0141,
      cumulativeSpendUsd: 0,
      sharedDiffLines: 1861,
      verdict: "uncalibrated",
    });
    expect(row).toBe(
      "| 13 | scripted | 0.100 | 0.900 | 0.800 | 0 | 5.0 | 100000 ($0.0141) | 0.000 | $0.00 | 1861 | uncalibrated |",
    );
    expect(row.split(" | ")).toHaveLength(LEDGER_ROW_HEADER.split(" | ").length);
  });

  test("assembles the report with priced per-day estimate and fail exit code on breach", () => {
    const input = {
      iter: "13",
      backend: "scripted",
      seed: 137,
      frozenSeed: true,
      mix: {
        representsDays: 1,
        datumsDelivered: 13,
        eligibleWakes: 9,
        wakerSkips: 2,
        expectedRuns: 10,
      },
      metrics: METRICS,
      counts: {
        arcs: 14,
        loopsTotal: 9,
        loopsJustified: 9,
        duplicatesMinted: 0,
        reconcileOpportunities: 8,
        resolutionTargets: 2,
        resolutionsObserved: 2,
        loopArcTargets: 8,
        loopArcsTracked: 7,
        updateTargets: 3,
        updatesLanded: 3,
        briefsCreated: 5,
        runsCompleted: 22,
        runsFailed: 0,
        dataRunsCompleted: 22,
        mutatingToolCalls: 25,
        mutatingToolCallsFailed: 2,
        mutatingToolCallsUncorrected: 1,
        scheduledRuns: 3,
        promptTokens: 99_000,
        completionTokens: 1_000,
      },
      prices: PRICES,
      cumulativeSpendUsd: 1.23,
      footprint: { sharedTotalLines: 1861, base: "abc123" },
    };

    const clean = assembleScorecard({ ...input, thresholds: { metrics: {} } });
    expect(clean.exitCode).toBe(0);
    expect(clean.report.verdict).toBe("uncalibrated");
    // 99k prompt at cache-miss $0.1/M + 1k output at $0.2/M.
    expect(clean.report.estimatedUsdPerDay).toBeCloseTo(0.0101, 10);
    expect(clean.report.ledgerRow).toBe(clean.ledgerRow);
    expect(clean.report.metrics.duplicate_rate).toBe(0.1);

    const breached = assembleScorecard({
      ...input,
      thresholds: { metrics: { duplicate_rate: { value: 0.01, noiseBand: 0 } } },
    });
    expect(breached.exitCode).toBe(1);
    expect(breached.report.verdict).toBe("fail");
    expect(breached.report.failures).toHaveLength(1);
  });
});
