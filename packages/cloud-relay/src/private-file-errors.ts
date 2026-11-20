// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ownedProcessCleanupReceipt } from "@omnesis/core";

/** Absence and concurrent winners require confirmed completion of the private operation. */
export function isJoinedPrivateFileError(error: unknown, code: "ENOENT" | "EEXIST"): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code &&
    ownedProcessCleanupReceipt(error) === undefined
  );
}
