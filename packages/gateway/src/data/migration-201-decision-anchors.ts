// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 201: every decision-model judgement gets a ledger row.
 *
 * `cognition_decisions.run_id`, `document_id` and `subject_document_id`
 * become nullable. A judgement about one of the user's tasks, an observation
 * the user wrote, a date mention outside any Brain run, or a search query has
 * no document or no run to anchor it, yet it is still a decision the operator
 * audits. SQLite cannot drop a NOT NULL constraint in place, so the table is
 * rebuilt. No other table references it, so the rebuild runs inside the
 * runner's transaction; its indexes and the payload-erasure trigger that went
 * with the old table are recreated.
 */

import { createDecisionPayloadTables } from "../brain/decision-payload.js";
import { rebuildCognitionDecisionsTable } from "../brain/storage/decisions.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export function relaxDecisionAnchors(db: Db): void {
  const document = db
    .prepare<[], { notnull: number }>(
      "SELECT \"notnull\" FROM pragma_table_info('cognition_decisions') WHERE name='document_id'",
    )
    .get();
  if (!document || document.notnull === 0) return;
  rebuildCognitionDecisionsTable(db);
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_decision_inputs'",
      )
      .get()
  )
    createDecisionPayloadTables(db);
}
