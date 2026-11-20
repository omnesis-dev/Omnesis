// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { IndexCleanupPendingError } from "../indexer/index-write-gate.js";
import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";

/** Complete each idempotent store independently so one failure cannot skip the other. */
export async function finishDocumentCascade(
  cascade: AbsenceCascade,
  ops: {
    deleteIndex?: (ids: readonly string[]) => Promise<number>;
    cascadeCognition: (ids: readonly string[]) => Promise<void>;
    acknowledge: (id: number, part: "index" | "cognition") => Promise<void>;
  },
): Promise<number> {
  let indexRows = 0;
  let failure: unknown;
  let failed = false;
  if (!cascade.indexDone) {
    try {
      if (ops.deleteIndex) indexRows = await ops.deleteIndex(cascade.documentIds);
      await ops.acknowledge(cascade.id, "index");
    } catch (error) {
      failed = true;
      failure = error;
    }
  }
  if (!cascade.cognitionDone) {
    try {
      await ops.cascadeCognition(cascade.documentIds);
      await ops.acknowledge(cascade.id, "cognition");
    } catch (error) {
      failed = true;
      // Index cleanup still pending is not a failure of its own, so a caller
      // that settles it must still see the cognition cascade's real error.
      failure =
        failure === undefined || failure instanceof IndexCleanupPendingError ? error : failure;
    }
  }
  if (failed) throw failure;
  return indexRows;
}
