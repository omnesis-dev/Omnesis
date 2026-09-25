// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";

/** Complete each idempotent store independently so one failure cannot skip the other. */
export async function finishDocumentCascade(
  cascade: AbsenceCascade,
  ops: {
    deleteIndex?: (ids: readonly string[]) => Promise<number>;
    purgeCognition: (ids: readonly string[]) => Promise<void>;
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
      await ops.purgeCognition(cascade.documentIds);
      await ops.acknowledge(cascade.id, "cognition");
    } catch (error) {
      failed = true;
      failure ??= error;
    }
  }
  if (failed) throw failure;
  return indexRows;
}
