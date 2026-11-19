// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Internal structured-clone contract for the one-shot doctor security worker. */

import type { SecurityData } from "./types.js";
import { ownedProcessCleanupReceipt } from "../owned-process-cleanup.js";

export interface DoctorSecurityWorkerInput {
  configDir: string;
  component: "gateway" | "collector";
}

export type DoctorSecurityWorkerMessage =
  | { type: "done"; security: SecurityData }
  | { type: "error"; error: string; cleanupFailure?: unknown };

/** Error custom properties are not retained by structured-cloning an Error. */
export function doctorSecurityWorkerError(error: unknown): DoctorSecurityWorkerMessage {
  const receipt = ownedProcessCleanupReceipt(error);
  return {
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    ...(receipt ? { cleanupFailure: receipt.failure } : {}),
  };
}
