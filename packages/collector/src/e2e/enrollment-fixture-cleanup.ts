// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rm } from "node:fs/promises";
import { ownedProcessCleanupReceipt } from "@omnesis/core";

/** Attempt every owner before removing shared inputs; any failure retains them. */
export async function closeEnrollmentFixture(
  directory: string | undefined,
  closers: readonly (() => unknown)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const marked = failures.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
    const receipt = ownedProcessCleanupReceipt(marked);
    const error = new AggregateError(
      failures,
      "Enrollment fixture cleanup failed; inputs retained",
      {
        cause: marked ?? failures[0],
      },
    );
    throw receipt === undefined ? error : Object.assign(error, { cleanupFailure: receipt.failure });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}
