// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 198: open loops become the user's tasks.
 *
 * Adds where a loop came from (a Tell Omnesis note, the user, or the Brain),
 * whether the user accepted a Brain suggestion, when the user plans to do it
 * (separate from its deadline), a pending Brain proposal, a completion note
 * and when it was resolved; and gives the loop ledger a structured event so
 * migrations, strikes and undo have a history to read. Existing loops are
 * Brain loops awaiting acceptance.
 */

import { createTaskIndexes } from "../brain/storage/schema.js";
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

export function addTaskFieldsToLoops(db: Db): void {
  const loop = columns(db, "open_loops");
  if (loop.size > 0) {
    if (!loop.has("origin"))
      db.exec("ALTER TABLE open_loops ADD COLUMN origin TEXT NOT NULL DEFAULT 'brain'");
    if (!loop.has("accepted"))
      db.exec("ALTER TABLE open_loops ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0");
    if (!loop.has("scheduled_for")) db.exec("ALTER TABLE open_loops ADD COLUMN scheduled_for TEXT");
    if (!loop.has("proposed_change_json"))
      db.exec("ALTER TABLE open_loops ADD COLUMN proposed_change_json TEXT");
    if (!loop.has("completion_note"))
      db.exec("ALTER TABLE open_loops ADD COLUMN completion_note TEXT");
    if (!loop.has("resolved_at")) {
      db.exec("ALTER TABLE open_loops ADD COLUMN resolved_at INTEGER");
      // A loop resolved before this migration last changed when it resolved.
      db.exec(
        "UPDATE open_loops SET resolved_at = last_update WHERE state IN ('done', 'dismissed')",
      );
    }
  }
  const ledger = columns(db, "open_loop_ledger");
  if (ledger.size > 0 && !ledger.has("event_json"))
    db.exec("ALTER TABLE open_loop_ledger ADD COLUMN event_json TEXT");
  createTaskIndexes(db);
}
