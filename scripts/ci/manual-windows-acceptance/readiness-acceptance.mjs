// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
export function recordReadiness(receipt, component, elapsedMs, sourceTestBudgetMs) {
  assert.ok(["gateway", "collector"].includes(component));
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
  assert.ok(Number.isFinite(sourceTestBudgetMs) && sourceTestBudgetMs > 0);
  const observation = {
    component,
    elapsedMs,
    sourceTestBudgetMs,
    withinSourceTestBudget: elapsedMs <= sourceTestBudgetMs,
  };
  receipt.readinessObservations.push(observation);
  if (!observation.withinSourceTestBudget) {
    receipt.readinessAcceptanceFailed = true;
    receipt.functionalDiagnosticOnly = true;
    receipt.steps.push({
      name: component + "-readiness-budget",
      passed: false,
      elapsedMs,
      sourceTestBudgetMs,
    });
  }
  return observation;
}
export function manualAcceptance(receipt) {
  return (
    receipt.functionalStepsCompleted === true &&
    !receipt.readinessAcceptanceFailed &&
    !receipt.gracefulAcceptanceFailed &&
    !receipt.cleanupUnconfirmed &&
    !receipt.ungracefulFallback &&
    receipt.steps.every((step) => step.passed !== false)
  );
}
