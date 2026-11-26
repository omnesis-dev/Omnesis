// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Private process protocol: fixed classifications, never exception text or database metadata. */
export const restoreFailureCodes = [
  "unknown",
  "input-schema",
  "worker-load-or-exit",
  "process-exit",
  "invalid-reply",
  "invalid-result",
  "missing-key",
  "page-authentication",
  "truncated-pages",
  "private-input",
  "unsupported-table",
  "generated-column",
  "unreviewed-table",
  "incomplete-schema",
  "integrity",
  "schema-version",
  "entry-scope",
  "envelope-truncated",
  "sqlite-notadb",
  "sqlite-corrupt",
  "sqlite-error",
  "sqlite-nomem",
  "sqlite-cantopen",
  "sqlite-readonly",
  "sqlite-busy",
  "sqlite-full",
] as const;
export type RestoreFailureCode = (typeof restoreFailureCodes)[number];

export function restoreFailureCode(value: unknown): RestoreFailureCode | undefined {
  return typeof value === "string" && (restoreFailureCodes as readonly string[]).includes(value)
    ? (value as RestoreFailureCode)
    : undefined;
}

const messages = new Map<string, RestoreFailureCode>([
  ["The backup database encryption key is missing", "missing-key"],
  ["Encrypted database page authentication failed", "page-authentication"],
  ["Encrypted database page stream is truncated", "truncated-pages"],
  ["The restore input must be a private owned regular file", "private-input"],
  ["The backup contains an unsupported table implementation", "unsupported-table"],
  ["The backup contains generated or hidden columns", "generated-column"],
  ["This backup contains a database table without a reviewed restore policy", "unreviewed-table"],
  ["The backup database schema is incomplete", "incomplete-schema"],
  ["The backup database is damaged", "integrity"],
  ["Unsupported backup schema", "schema-version"],
  ["Restore requires a backup compatible with this gateway database schema", "schema-version"],
  ["The backup database encryption scope is invalid", "entry-scope"],
  ["Encrypted artifact envelope is truncated", "envelope-truncated"],
]);
const sqliteCodes = new Map<string, RestoreFailureCode>([
  ["SQLITE_NOTADB", "sqlite-notadb"],
  ["SQLITE_CORRUPT", "sqlite-corrupt"],
  ["SQLITE_ERROR", "sqlite-error"],
  ["SQLITE_NOMEM", "sqlite-nomem"],
  ["SQLITE_CANTOPEN", "sqlite-cantopen"],
  ["SQLITE_READONLY", "sqlite-readonly"],
  ["SQLITE_BUSY", "sqlite-busy"],
  ["SQLITE_FULL", "sqlite-full"],
]);
export function classifyRestoreFailure(error: unknown): RestoreFailureCode {
  if (!(error instanceof Error)) return "unknown";
  const recognized = messages.get(error.message);
  if (recognized) return recognized;
  const code: unknown = "code" in error ? error.code : undefined;
  return typeof code === "string" ? (sqliteCodes.get(code) ?? "unknown") : "unknown";
}

export class RestoreWorkerFailure extends Error {
  constructor(readonly failureCode: RestoreFailureCode) {
    super("The backup database could not be prepared safely");
  }
}
