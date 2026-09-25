// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scorecard instrument validation: the
 * scorecard's numbers are only trustworthy if a known-good agent scores
 * clean and a known-bad one is flagged on every planted defect. Both
 * lanes run the REAL `runScorecard` pipeline — a spawned gateway on
 * `loops-test-life`, the scripted fake OpenAI server, real tool
 * execution — differing only in the behavior table:
 *
 *  - the **perfect** script (the arc kit's correct behaviors) must score
 *    zero duplicates, full resolution recall, full loop precision, zero
 *    silent-close violations, zero infra failures — and its datum mix
 *    must match the committed `daily-mix.json` (criterion 13's
 *    documented daily datum mix);
 *  - the **saboteur** script must be flagged on exactly the defects its
 *    machine-readable manifest (`SABOTEUR_DEFECTS`) plants — expected
 *    values are DERIVED from the manifest, never hardcoded.
 *
 * The perfect lane also validates the spend-guard plumbing with a
 * recording guard: reserve-before-run and settle-with-usage must fire
 * for every expected run even on the zero-cost scripted backend, so the
 * priced deepseek lane inherits proven wiring (criterion 16's meter
 * half is unit-tested in evals/briefs/src).
 */

import "./synth-env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { computeDailyMix, runScorecard, type DailyMix } from "./briefs-scorecard.js";
import { generateArcSet, FROZEN_ARC_SEED } from "./briefs-arcs.js";
import { SABOTEUR_DEFECTS } from "./briefs-saboteur.js";

const DAILY_MIX_PATH = join(
  import.meta.dirname,
  "../../../..",
  "evals/universes/loops-test-life/daily-mix.json",
);

describe("Briefs scorecard instrument validation", () => {
  test("the committed daily-mix.json matches the arc-set derivation", () => {
    const committed = (JSON.parse(readFileSync(DAILY_MIX_PATH, "utf8")) as { mix: DailyMix }).mix;
    expect(committed).toEqual(computeDailyMix(generateArcSet(FROZEN_ARC_SEED)));
  });

  test("the perfect script scores clean, and the run guard fires for every expected run", async () => {
    const reserves: string[] = [];
    const settles = new Map<string, { promptTokens: number; completionTokens: number }>();
    const result = await runScorecard({
      gatewayMode: "experimental",
      backend: { kind: "scripted", script: "perfect" },
      seed: FROZEN_ARC_SEED,
      guard: {
        reserve(datumKey) {
          if (settles.has(datumKey)) throw new Error(`settle before reserve for ${datumKey}`);
          reserves.push(datumKey);
        },
        settle(datumKey, usage) {
          if (!reserves.includes(datumKey)) throw new Error(`unreserved settle for ${datumKey}`);
          settles.set(datumKey, usage);
        },
      },
    });

    // Clean on every gateable metric.
    expect(result.metrics.duplicateRate).toBe(0);
    expect(result.metrics.resolutionRecall).toBe(1);
    expect(result.metrics.loopPrecision).toBe(1);
    expect(result.metrics.loopRecall).toBe(1);
    expect(result.metrics.updateRecall).toBe(1);
    expect(result.metrics.silentCloseViolations).toBe(0);
    expect(result.metrics.infraFailureRate).toBe(0);
    expect(result.metrics.malformedToolCallRate).toBe(0);
    expect(result.metrics.malformedToolCallRateRaw).toBe(0);
    expect(result.counts.duplicatesMinted).toBe(0);
    expect(result.counts.runsFailed).toBe(0);
    // The update-quality gold really measured the decision thread's notes.
    expect(result.counts.updateTargets).toBeGreaterThan(0);
    expect(result.counts.updatesLanded).toBe(result.counts.updateTargets);
    expect(result.counts.loopArcsTracked).toBe(result.counts.loopArcTargets);
    // The scripted lanes never schedule follow-up runs.
    expect(result.counts.scheduledRuns).toBe(0);

    // The engine completed exactly the data runs the mix declares (engine-
    // initiated runs — sweeps, decay checks — arrive on their own clock and
    // are excluded), and the usage accounting is live (tokens_per_day is
    // real, not zero-filled).
    expect(result.counts.dataRunsCompleted).toBe(result.mix.expectedRuns);
    expect(result.counts.runsCompleted).toBeGreaterThanOrEqual(result.mix.expectedRuns);
    expect(result.counts.promptTokens).toBeGreaterThan(0);
    expect(result.counts.completionTokens).toBeGreaterThan(0);

    // Reserve-then-settle fired once per expected run — the data runs plus
    // one feedback run per simulated dismissal — in that order.
    expect(reserves).toHaveLength(result.mix.expectedRuns + result.mix.feedbackRuns);
    expect(settles.size).toBe(result.mix.expectedRuns + result.mix.feedbackRuns);
    for (const [datumKey, usage] of settles) {
      expect(usage.promptTokens, datumKey).toBeGreaterThan(0);
    }
  }, 600_000);

  test("the saboteur script is flagged on every planted defect", async () => {
    const result = await runScorecard({
      gatewayMode: "experimental",
      backend: { kind: "scripted", script: "saboteur" },
      seed: FROZEN_ARC_SEED,
    });

    // Duplicate mints: exactly the planted count, and the rate reflects it.
    expect(result.counts.duplicatesMinted).toBe(SABOTEUR_DEFECTS.duplicateMints);
    expect(result.metrics.duplicateRate).toBeCloseTo(
      SABOTEUR_DEFECTS.duplicateMints / result.counts.reconcileOpportunities,
      10,
    );
    expect(result.metrics.duplicateRate).toBeGreaterThan(0);

    // Skipped resolutions: recall drops by exactly the planted count.
    expect(result.counts.resolutionsObserved).toBe(
      result.counts.resolutionTargets - SABOTEUR_DEFECTS.skippedResolutions,
    );
    expect(result.metrics.resolutionRecall).toBeLessThan(1);

    // Silent closures of ambiguous resolutions: counted one-for-one.
    expect(result.metrics.silentCloseViolations).toBe(SABOTEUR_DEFECTS.silentClosures);

    // Unjustified loops (beyond the duplicates): precision drops.
    expect(
      result.counts.loopsTotal - result.counts.loopsJustified - result.counts.duplicatesMinted,
    ).toBe(SABOTEUR_DEFECTS.unjustifiedLoops);
    expect(result.metrics.loopPrecision).toBeLessThan(1);

    // Ignored updates: the dropped decision-thread note leaves no trace.
    expect(result.counts.updatesLanded).toBe(
      result.counts.updateTargets - SABOTEUR_DEFECTS.ignoredUpdates,
    );
    expect(result.metrics.updateRecall).toBeLessThan(1);

    // Wrong merges + feedback-vanished loops: each leaves an expecting arc
    // with no tracked loop of its own.
    expect(result.counts.loopArcsTracked).toBe(
      result.counts.loopArcTargets - SABOTEUR_DEFECTS.wrongMerges - SABOTEUR_DEFECTS.vanishedLoops,
    );
    expect(result.metrics.loopRecall).toBeLessThan(1);

    // The defects are AGENT defects, not infrastructure failures — a
    // saboteur run still completes cleanly at the queue level.
    expect(result.metrics.infraFailureRate).toBe(0);
    expect(result.metrics.malformedToolCallRate).toBe(0);
    expect(result.metrics.malformedToolCallRateRaw).toBe(0);
  }, 600_000);
});
