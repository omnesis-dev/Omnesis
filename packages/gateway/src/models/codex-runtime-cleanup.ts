// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Unconfirmed child cleanup cannot authorize another runtime generation. */
export class CodexGenerationCleanupError extends Error {
  readonly cleanupFailure = true;
  constructor(cause: unknown) {
    super("Codex process cleanup was not confirmed. Review the process state before retrying.", {
      cause,
    });
    this.name = "CodexGenerationCleanupError";
  }
}

/** execWindowsJob preserves this explicit marker even when the command also failed. */
export function codexCleanupFailure(error: unknown): CodexGenerationCleanupError | null {
  if (error instanceof CodexGenerationCleanupError) return error;
  if (error !== null && typeof error === "object" && Object.hasOwn(error, "cleanupFailure"))
    return new CodexGenerationCleanupError(error);
  return null;
}
