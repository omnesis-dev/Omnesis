// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/**
 * Body of migration 205. Every install journals source writes into
 * `knowledge_changes`, but only the experimental intake drains it: the journal
 * grew by one row per write, and each document delete scanned all of it for
 * that document's entries. Intake reads a source as it stands, so only a
 * source's newest entry carries anything; the triggers keep it that way from
 * here on.
 */
export function compactKnowledgeJournal(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS knowledge_changes_entity ON knowledge_changes(entity_id);
    DELETE FROM knowledge_changes WHERE seq NOT IN
      (SELECT MAX(seq) FROM knowledge_changes GROUP BY entity_id);
  `);
}
