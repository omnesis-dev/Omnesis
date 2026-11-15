// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import assert from "node:assert/strict";
const phases = new Set([
  "module-import",
  "configuration",
  "provenance",
  "platform",
  "fixture-root",
  "environment",
  "core-import",
  "core-api",
  "private-directories",
  "vault-fixtures",
  "initial-config",
  "fresh-token",
  "lifecycle",
]);
const codes = new Set([
  "failed",
  "ERR_ASSERTION",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_URL",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_REQUIRE_ASYNC_MODULE",
  "ERR_REQUIRE_ESM",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "EPRIVATE",
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "EEXIST",
  "EPERM",
  "ENOSPC",
  "EIO",
]);
const nativeStages = new Set([
  "bootstrap",
  "resolve",
  "parent",
  "create",
  "validate",
  "write",
  "commit",
  "flush",
  "rename",
  "read",
  "inspect",
  "repair",
  "unsafe-file",
  "seal-private",
  "cleanup",
  "regular-leaf",
  "storage-ancestor",
  "storage-create",
  "storage-inheritance",
  "storage-open",
  "storage-resolve",
  "storage-root",
]);
let cleanupUncertain = false;
export function markCleanupUncertain() {
  cleanupUncertain = true;
}
export function isCleanupUncertain() {
  return cleanupUncertain;
}
export function captureCleanupUncertainty(error) {
  let at = error;
  const seen = new Set();
  for (
    let depth = 0;
    depth < 16 && at !== null && (typeof at === "object" || typeof at === "function");
    depth++
  ) {
    if (seen.has(at)) break;
    seen.add(at);
    if (Object.hasOwn(at, "cleanupFailure")) {
      markCleanupUncertain();
      break;
    }
    at = at.cause;
  }
  return cleanupUncertain;
}
let phase = "module-import",
  assertionId = null;
export function setPreflightPhase(value) {
  assert.ok(phases.has(value));
  phase = value;
  assertionId = null;
}
export function taggedAssert(id, fn, ...args) {
  assert.match(id, /^(provenance|manual)-assert-[0-9]{3}$/);
  try {
    return Reflect.apply(fn, assert, args);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") assertionId = id;
    throw error;
  }
}
export function preflightDiagnostic(error) {
  const uncertain = captureCleanupUncertainty(error);
  return {
    phase,
    errorCode: codes.has(error?.code) ? error.code : "failed",
    assertionId,
    cleanupUnconfirmed: uncertain,
    ...(nativeStages.has(error?.stage) ? { nativeStage: error.stage } : {}),
    ...(Number.isInteger(error?.nativeCode) &&
    error.nativeCode >= 0 &&
    error.nativeCode <= 4294967295
      ? { nativeCode: error.nativeCode }
      : {}),
  };
}
export function validatePreflightDiagnostic(value) {
  assert.ok(value && typeof value === "object");
  assert.ok(phases.has(value.phase));
  assert.ok(codes.has(value.errorCode));
  assert.equal(typeof value.cleanupUnconfirmed, "boolean");
  assert.ok(
    value.assertionId === null || /^(provenance|manual)-assert-[0-9]{3}$/.test(value.assertionId),
  );
  const result = {
    phase: value.phase,
    errorCode: value.errorCode,
    assertionId: value.assertionId,
    cleanupUnconfirmed: value.cleanupUnconfirmed,
  };
  if (value.nativeStage !== undefined) {
    assert.ok(nativeStages.has(value.nativeStage));
    result.nativeStage = value.nativeStage;
  }
  if (value.nativeCode !== undefined) {
    assert.ok(
      Number.isInteger(value.nativeCode) && value.nativeCode >= 0 && value.nativeCode <= 4294967295,
    );
    result.nativeCode = value.nativeCode;
  }
  return result;
}
