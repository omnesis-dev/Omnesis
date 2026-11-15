// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Only an explicit own marker establishes uncertainty; its payload can be undefined. */
export function ownedProcessCleanupReceipt(
  error: unknown,
): { failure: unknown; pending: boolean } | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 16 && error !== null && typeof error === "object"; depth++) {
    if (seen.has(error)) return undefined;
    seen.add(error);
    if (Object.hasOwn(error, "cleanupFailure")) {
      return {
        failure: Reflect.get(error, "cleanupFailure"),
        pending:
          Object.hasOwn(error, "cleanupPending") && Reflect.get(error, "cleanupPending") === true,
      };
    }
    error = "cause" in error ? error.cause : undefined;
  }
  return undefined;
}
