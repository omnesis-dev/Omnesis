// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import type Database from "better-sqlite3";

export type { LabFeatureId } from "./catalog.js";
import type { LabFeatureId } from "./catalog.js";
export type LabFlags = Record<LabFeatureId, boolean>;

export function createLabTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lab_features (
    id TEXT PRIMARY KEY CHECK (id IN ('brain', 'tasks', 'watches', 'recordings')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  )`);
}

/**
 * Admit the `recordings` experiment into an existing `lab_features` table,
 * whose CHECK named only the first three, and opt in an install that has
 * already recorded a conversation. No table references `lab_features`, so the
 * rebuild runs inside the migration's transaction.
 */
export function addRecordingsLabFeature(db: Database.Database): void {
  const table = db
    .prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lab_features'",
    )
    .get();
  if (table && !table.sql.includes("'recordings'")) {
    db.exec("ALTER TABLE lab_features RENAME TO lab_features_old");
    createLabTable(db);
    db.exec("INSERT INTO lab_features (id, enabled) SELECT id, enabled FROM lab_features_old");
    db.exec("DROP TABLE lab_features_old");
  } else if (!table) {
    createLabTable(db);
  }
  const recorded =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recording_sessions'")
      .get() !== undefined &&
    db.prepare("SELECT 1 FROM recording_sessions LIMIT 1").get() !== undefined;
  if (recorded) initializeLabFlags(db, { recordings: true });
}

/** Insert once: subsequent restarts must preserve explicit opt-outs. */
export function initializeLabFlags(db: Database.Database, flags: Partial<LabFlags>): void {
  const insert = db.prepare("INSERT OR IGNORE INTO lab_features (id, enabled) VALUES (?, ?)");
  db.transaction(() => {
    for (const [id, enabled] of Object.entries(flags)) insert.run(id, Number(enabled));
  })();
}

export function setLabFlag(db: Database.Database, id: LabFeatureId, enabled: boolean): void {
  db.prepare(
    "INSERT INTO lab_features (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled",
  ).run(id, Number(enabled));
}

export function labOptIns(db: Database.Database): LabFlags {
  const flags: LabFlags = { brain: false, tasks: false, watches: false, recordings: false };
  for (const row of db
    .prepare<[], { id: LabFeatureId; enabled: number }>("SELECT id, enabled FROM lab_features")
    .all())
    flags[row.id] = row.enabled === 1;
  return flags;
}

/** Effective flags require the environment gate as well as a saved opt-in. */
export function labFeatureEnabled(db: Database.Database, id: LabFeatureId): boolean {
  if (!experimentalEnabled()) return false;
  return (
    db
      .prepare<[string], { enabled: number }>("SELECT enabled FROM lab_features WHERE id = ?")
      .get(id)?.enabled === 1
  );
}

export function labFlags(db: Database.Database): LabFlags {
  const enabled = experimentalEnabled();
  const flags = labOptIns(db);
  return {
    brain: enabled && flags.brain,
    tasks: enabled && flags.tasks,
    watches: enabled && flags.watches,
    recordings: enabled && flags.recordings,
  };
}
