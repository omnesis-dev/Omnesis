// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runDesktopDataOperation } from "./data-operation-channel.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopRemovalResult } from "./removal.js";

/** The controller owns the session lease; all actual deletion occurs in the native EX host. */
export async function runDesktopEraseOperation(
  profile: DesktopProfile,
  operationId: string,
  signal: AbortSignal,
): Promise<DesktopRemovalResult> {
  const result = await runDesktopDataOperation(
    { version: 1, purpose: "erase", operationId, profile, payload: {} },
    signal,
  );
  if (
    !result ||
    typeof result !== "object" ||
    !("status" in result) ||
    !("data" in result) ||
    !("keyring" in result)
  )
    throw new Error("Data removal could not be verified");
  if (result.data === "erased" && result.status === "retired" && result.keyring === "cleared")
    return { status: "retired", data: "erased", keyring: "cleared" };
  if (
    result.data === "erased" &&
    result.status === "key-cleanup-pending" &&
    result.keyring === "pending"
  )
    return { status: "key-cleanup-pending", data: "erased", keyring: "pending" };
  throw new Error("Data removal could not be verified");
}
