// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/**
 * Body of migration 205. Every install journals source writes into
 * `knowledge_changes`, but only the experimental intake drains it: the journal
 * grew by one row per write, and each document delete scanned all of it for
 * that document's entries. Intake reads a source as it stands, so only a
 * source's newest change entry carries anything; the insert and update
 * triggers keep it that way from here on. Node entries are left alone: each
 * one is its own obligation (a page's change queues its dependents, its
 * invalidation does not), so a later one never stands in for an earlier one.
 */
export function compactKnowledgeJournal(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS knowledge_changes_entity ON knowledge_changes(entity_id);
    DELETE FROM knowledge_changes
      WHERE kind IN ('source_changed','source_evidence_changed') AND seq NOT IN
        (SELECT MAX(seq) FROM knowledge_changes
          WHERE kind IN ('source_changed','source_evidence_changed') GROUP BY entity_id);
  `);
}
