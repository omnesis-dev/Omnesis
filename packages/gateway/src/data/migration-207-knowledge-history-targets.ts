// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/**
 * Body of migration 207. `knowledge_revision_dependencies` held every
 * revision's full citation list, so a page rewritten hundreds of times
 * repeated each target once per revision, and every privacy-closure walk that
 * reached the page read all of them. Readers only ever ask which targets a
 * node's history reaches, or whether any history cites a target, so each
 * target is kept once, at the earliest revision that cited it, which is the
 * row the writer records. The set per node, and the order a scan by node meets
 * its targets in, are unchanged.
 */
export function compactKnowledgeHistoryTargets(db: Database.Database): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_revision_dependencies'",
      )
      .get()
  )
    return;
  // SQLite reads a bare column beside MIN() from the row holding the minimum,
  // so the inner query names each target's earliest row. Matching rows by
  // rowid against that one list keeps this a single pass over the table.
  db.exec(`
    DELETE FROM knowledge_revision_dependencies WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid, MIN(revision) FROM knowledge_revision_dependencies
          GROUP BY node_id,target_kind,target_id));
  `);
}
