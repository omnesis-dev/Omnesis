// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { writeFileSync } from "node:fs";
import { preflightDiagnostic, validatePreflightDiagnostic } from "./preflight-state.mjs";
const [, summaryPath, mode, sourceCommit] = process.argv.slice(2);
const safeMode = ["source", "compiled"].includes(mode) ? mode : "invalid";
const safeCommit = /^[a-f0-9]{40}$/.test(sourceCommit) ? sourceCommit : null;
try {
  if (!["source", "compiled"].includes(mode) || !/^[a-f0-9]{40}$/.test(sourceCommit))
    throw Error("Invalid manual entry configuration");
  await import("./manual-smoke.mjs");
} catch (error) {
  const diagnostic = validatePreflightDiagnostic(preflightDiagnostic(error));
  const record = {
    sourceCommit: safeCommit,
    mode: safeMode,
    passed: false,
    realCollectorCli: false,
    modelInference: false,
    documents: 0,
    encryptedAnalyticsKeyPresent: false,
    sqliteWithoutKeyRefused: false,
    sqlitePlainControlRead: false,
    duckdbWithoutKeyRefused: false,
    functionalStepsCompleted: false,
    readinessAcceptanceFailed: false,
    gracefulAcceptanceFailed: false,
    cleanupUnconfirmed: diagnostic.cleanupUnconfirmed,
    ungracefulFallback: false,
    failedPhase: null,
    readinessObservations: [],
    phaseResults: [],
    resolutionHashes: [],
    preflightFailure: diagnostic,
  };
  // This file contains no raw error, private argument, path, token or stack.
  let summaryWritten = true;
  try {
    writeFileSync(summaryPath, JSON.stringify(record, null, 2));
  } catch {
    summaryWritten = false;
  }
  console.log(
    JSON.stringify({
      phase: summaryWritten ? "manual-preflight-failed" : "manual-preflight-summary-unavailable",
      mode: safeMode,
      sourceCommit: safeCommit,
      diagnostic,
    }),
  );
  process.exitCode = 1;
}
