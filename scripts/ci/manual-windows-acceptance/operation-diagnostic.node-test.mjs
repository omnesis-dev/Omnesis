// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
import test from "node:test";
import {
  operationDiagnostic,
  validateOperationDiagnostic,
  validateCleanupDiagnostics,
} from "./operation-diagnostic.mjs";
test("only fixed operation stage and bounded native facts leave private diagnostics", () => {
  const value = operationDiagnostic(
    "sqlite-command",
    Object.assign(Error("invented-sensitive-payload"), {
      code: "EPRIVATE",
      stage: "parent",
      nativeCode: 5,
      path: "invented-sensitive-path",
    }),
  );
  assert.deepEqual(value, {
    subphase: "sqlite-command",
    errorCode: "EPRIVATE",
    assertionId: null,
    nativeStage: "parent",
    nativeCode: 5,
  });
  assert.equal(JSON.stringify(value).includes("sensitive"), false);
});
test("unknown diagnostic values are scrubbed and unknown output stages refused", () => {
  assert.deepEqual(
    operationDiagnostic("search-json", {
      code: "invented-sensitive-code",
      stage: "invented-sensitive-stage",
      nativeCode: -1,
    }),
    { subphase: "search-json", errorCode: "failed", assertionId: null },
  );
  assert.throws(() =>
    validateOperationDiagnostic({
      subphase: "invented-sensitive-stage",
      errorCode: "failed",
      assertionId: null,
    }),
  );
  assert.throws(() =>
    operationDiagnostic("show-result", Error("invented"), "invented-sensitive-id"),
  );
});
test("fixed assertion IDs and cleanup components survive without raw diagnostics", () => {
  const value = operationDiagnostic(
    "sqlite-document-count",
    {
      code: "ERR_ASSERTION",
      actual: "invented-sensitive",
      expected: "invented-sensitive",
    },
    "operation-assert-004",
  );
  assert.deepEqual(validateCleanupDiagnostics([{ ...value, component: "collector" }]), [
    {
      subphase: "sqlite-document-count",
      errorCode: "ERR_ASSERTION",
      assertionId: "operation-assert-004",
      component: "collector",
    },
  ]);
  assert.throws(() => validateCleanupDiagnostics([{ ...value, component: "invented-sensitive" }]));
});
test("only a bounded explicit manual command exit is projected", () => {
  assert.equal(
    operationDiagnostic(
      "status-command",
      { code: "ERR_ASSERTION", manualApplicationExitCode: 2 },
      "operation-assert-007",
    ).applicationExitCode,
    2,
  );
  assert.throws(() =>
    operationDiagnostic("status-command", {
      manualApplicationExitCode: 4294967296,
    }),
  );
  assert.equal(
    Object.hasOwn(
      operationDiagnostic("status-command", {
        actual: "invented-sensitive",
        manualApplicationExitCode: "invented-sensitive",
      }),
      "applicationExitCode",
    ),
    false,
  );
});
