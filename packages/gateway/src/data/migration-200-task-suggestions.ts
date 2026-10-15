// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 200: a Brain suggestion can be ignored, or accepted with a note.
 *
 * Adds `open_loops.ignored`: an ignored suggestion is left out of the Tasks
 * views while its loop stays open for the Brain to maintain. Existing loops
 * are not ignored. Adds `note_entries.task_id`: a Tell Omnesis note written
 * while accepting a suggestion names the task it is about.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

function columns(db: Db, table: string): Set<string> {
  return new Set(
    db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((c) => c.name),
  );
}

export function addSuggestionIgnoreAndTaskNotes(db: Db): void {
  const loop = columns(db, "open_loops");
  if (loop.size > 0 && !loop.has("ignored"))
    db.exec("ALTER TABLE open_loops ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0");
  const note = columns(db, "note_entries");
  if (note.size > 0 && !note.has("task_id"))
    db.exec("ALTER TABLE note_entries ADD COLUMN task_id TEXT");
}
