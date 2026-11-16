// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import { preflightDiagnostic } from "./preflight-state.mjs";
import { validateCliFailureKinds } from "./cli-failure-kinds.mjs";
const stages = new Set([
  "none",
  "lexical-index-ready",
  "status-command",
  "status-json",
  "search-command",
  "search-json",
  "search-result",
  "show-command",
  "show-json",
  "show-result",
  "sqlite-command",
  "sqlite-json",
  "sqlite-row-count",
  "sqlite-document-count",
  "duckdb-command",
  "duckdb-json",
  "duckdb-value",
  "analytics-key-read",
  "analytics-key-size",
  "restart-offline-status-command",
  "restart-offline-status-json",
  "restart-collector",
  "restart-persistence-read",
  "restart-persistence-match",
  "restart-status-command",
  "shutdown-request",
  "shutdown-join",
  "shutdown-receipt",
  "shutdown-ipc",
  "shutdown-application-exit",
  "shutdown-wrapper-exit",
  "shutdown-budget",
]);
export function validateOperationDiagnostic(value) {
  assert.ok(value && typeof value === "object");
  assert.ok(stages.has(value.subphase));
  const diagnostic = preflightDiagnostic({
    code: value.errorCode,
    stage: value.nativeStage,
    nativeCode: value.nativeCode,
  });
  assert.equal(value.errorCode, diagnostic.errorCode);
  assert.ok(value.assertionId === null || /^operation-assert-[0-9]{3}$/.test(value.assertionId));
  if (value.applicationExitCode !== undefined)
    assert.ok(
      Number.isInteger(value.applicationExitCode) &&
        value.applicationExitCode >= -2147483648 &&
        value.applicationExitCode <= 4294967295,
    );
  return {
    subphase: value.subphase,
    errorCode: diagnostic.errorCode,
    assertionId: value.assertionId,
    ...(value.cliFailureKinds === undefined
      ? {}
      : { cliFailureKinds: validateCliFailureKinds(value.cliFailureKinds) }),
    ...(value.applicationExitCode === undefined
      ? {}
      : { applicationExitCode: value.applicationExitCode }),
    ...(diagnostic.nativeStage === undefined ? {} : { nativeStage: diagnostic.nativeStage }),
    ...(diagnostic.nativeCode === undefined ? {} : { nativeCode: diagnostic.nativeCode }),
  };
}
export function operationDiagnostic(subphase, error, assertionId = null) {
  const diagnostic = preflightDiagnostic(error);
  return validateOperationDiagnostic({
    ...diagnostic,
    subphase,
    assertionId,
    ...(error?.manualCliFailureKinds === undefined
      ? {}
      : { cliFailureKinds: error.manualCliFailureKinds }),
    ...(Number.isInteger(error?.manualApplicationExitCode)
      ? { applicationExitCode: error.manualApplicationExitCode }
      : {}),
  });
}
export function validateCleanupDiagnostics(rows) {
  assert.ok(Array.isArray(rows) && rows.length <= 32);
  return rows.map((row) => {
    assert.ok(["gateway", "collector", "other"].includes(row.component));
    return { ...validateOperationDiagnostic(row), component: row.component };
  });
}
