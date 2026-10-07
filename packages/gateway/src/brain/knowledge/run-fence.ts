// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  assertKnowledgeReconciliation,
  type KnowledgeReconciliationReceipt,
} from "./reconciliation.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Trusted runtime ownership, never accepted in model argument schemas. */
export interface KnowledgeRunFence {
  batchId: string;
  runId: string;
  /** Generation observed through this run's reads, never model-supplied. */
  reconciliation?: KnowledgeReconciliationReceipt;
}
export function assertKnowledgeRunFence(db: Database.Database, fence?: KnowledgeRunFence): void {
  if (!fence) return;
  if (fence.reconciliation) assertKnowledgeReconciliation(db, fence.reconciliation);
  if (
    !db
      .prepare(
        "SELECT 1 FROM knowledge_batches WHERE id=? AND run_id=? AND status NOT IN ('completed','abandoned')",
      )
      .get(fence.batchId, fence.runId)
  )
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Maintenance batch is no longer active or owned by this run",
    );
}
