// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { spawnOwnedChildProcess } from "@omnesis/core";
import { managedDesktopDataOperationInvocation } from "@omnesis/core";
import { runOwnedDesktopFrame } from "./owned-frame.js";
import { desktopEnvironment, type DesktopProfile } from "./environment.js";
import { desktopRestoreFailureFromCode } from "./restore-errors.js";

export type DesktopDataPurpose =
  "erase" | "restore" | "rollback" | "update-snapshot" | "update-rollback";
export interface DesktopDataRequest {
  version: 1;
  purpose: DesktopDataPurpose;
  operationId: string;
  profile: DesktopProfile;
  payload: unknown;
}
import { DESKTOP_DATA_INPUT_LIMIT } from "./data-operation-frame.js";
const OUTPUT_LIMIT = 64 * 1024;
const refused = () =>
  new Error(
    "The protected data operation did not finish. Review its recovery status before retrying.",
  );

/** The native executable fixes the host entry; no caller-selected module is executed. */
export async function runDesktopDataOperation(
  request: DesktopDataRequest,
  signal: AbortSignal,
  dependencies: {
    invocation?: typeof managedDesktopDataOperationInvocation;
    spawn?: typeof spawnOwnedChildProcess;
  } = {},
): Promise<unknown> {
  return runOwnedDesktopFrame(
    {
      request,
      inputLimit: DESKTOP_DATA_INPUT_LIMIT,
      outputLimit: OUTPUT_LIMIT,
      env: desktopEnvironment(request.profile),
      invocation: () =>
        (dependencies.invocation ?? managedDesktopDataOperationInvocation)(
          request.profile,
          request.purpose,
          request.operationId,
        ),
      refused,
      failure: (code) => desktopRestoreFailureFromCode(code) ?? null,
      spawn: dependencies.spawn,
    },
    signal,
  );
}
