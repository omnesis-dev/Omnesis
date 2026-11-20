// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import type { ProcessResult } from "./run-child.js";

function outcomeMessage(result: ProcessResult): string {
  switch (result.failure) {
    case "timeout":
      return "External process timed out";
    case "aborted":
      return "External process was aborted";
    case "spawn":
      return "External process could not start";
    case undefined:
      return result.signal
        ? `External process ended with ${result.signal}`
        : `External process exited ${result.exitCode ?? "without a code"}`;
    default:
      return assertNever(result.failure);
  }
}

export class ProcessCleanupUnconfirmedError extends Error {
  readonly cleanupFailure: unknown;
  readonly exitCode: ProcessResult["exitCode"];
  readonly signal: ProcessResult["signal"];
  readonly failure: ProcessResult["failure"];
  readonly failureMessage: ProcessResult["failureMessage"];

  constructor(result: ProcessResult) {
    super(`${outcomeMessage(result)}; cleanup was not confirmed.`, {
      cause: result.cleanupFailure,
    });
    this.name = "ProcessCleanupUnconfirmedError";
    this.cleanupFailure = result.cleanupFailure;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.failure = result.failure;
    this.failureMessage = result.failureMessage;
  }
}

export function hasUnconfirmedProcessCleanup(error: unknown): boolean {
  return error !== null && typeof error === "object" && Object.hasOwn(error, "cleanupFailure");
}

export function assertProcessCleanupConfirmed(result: ProcessResult): void {
  if (hasUnconfirmedProcessCleanup(result)) throw new ProcessCleanupUnconfirmedError(result);
}
