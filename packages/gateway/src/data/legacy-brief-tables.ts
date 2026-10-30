// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Frozen DDL for the brief tables that migration 197 retires.
 *
 * The current schema does not declare these tables. The historical migrations that created or altered
 * them still replay on every upgrade path, including a fresh database that
 * runs the full sequence, so they keep this exact shape until migration 197
 * drops it. Nothing outside the migration list uses this module.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

const ID_CHUNK = 500;

/** The brief tables as migration 33 created them (later columns added by 37 and 89). */
export function createLegacyBriefTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id TEXT PRIMARY KEY,
      created_by_run TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      body TEXT,
      confidence REAL NOT NULL,
      urgency REAL NOT NULL,
      relevant_until INTEGER,
      next_show INTEGER,
      event_at INTEGER,
      user_feedback TEXT,
      state TEXT NOT NULL DEFAULT 'unread',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_briefs_state_next_show ON briefs(state, next_show)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_citations (
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      doc_id TEXT NOT NULL,
      PRIMARY KEY (brief_id, position)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_citations_doc ON brief_citations(doc_id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_related_loops (
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      loop_id TEXT NOT NULL,
      PRIMARY KEY (brief_id, loop_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_brief_related_loops_loop ON brief_related_loops(loop_id)",
  );
}

/** The brief-claims sidecar as migration 58 created it. */
export function createLegacyBriefClaimsTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_claims (
      id TEXT PRIMARY KEY,
      brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      claim_text TEXT NOT NULL,
      evidence_doc_id TEXT NOT NULL,
      evidence_quote TEXT NOT NULL,
      claim_basis TEXT NOT NULL,
      confidence REAL NOT NULL,
      verification_state TEXT,
      created_at INTEGER NOT NULL,
      invalidated_at INTEGER
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_claims_brief ON brief_claims(brief_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_brief_claims_evidence ON brief_claims(evidence_doc_id)");
}

/**
 * The privacy cascade migration 69 applied to brief claims: hard-delete every
 * claim whose evidence document is being removed.
 */
export function legacyCascadeBriefClaimPrivacyDelete(
  db: Db,
  deletedDocIds: readonly string[],
): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='brief_claims'").get())
    return;
  for (let i = 0; i < deletedDocIds.length; i += ID_CHUNK) {
    const batch = deletedDocIds.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    db.prepare<string[]>(`DELETE FROM brief_claims WHERE evidence_doc_id IN (${placeholders})`).run(
      ...batch,
    );
  }
}

/** Briefs citing one of `deletedDocIds`, removed by the same migration-69 cascade. */
export function legacyDeleteBriefsCitingDocs(db: Db, deletedDocIds: readonly string[]): string[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='briefs'").get())
    return [];
  const ids = new Set<string>();
  for (let i = 0; i < deletedDocIds.length; i += ID_CHUNK) {
    const batch = deletedDocIds.slice(i, i + ID_CHUNK);
    const placeholders = batch.map(() => "?").join(", ");
    for (const row of db
      .prepare<string[], { brief_id: string }>(
        `SELECT DISTINCT brief_id FROM brief_citations WHERE doc_id IN (${placeholders})`,
      )
      .all(...batch))
      ids.add(row.brief_id);
  }
  const del = db.prepare<[string]>("DELETE FROM briefs WHERE id = ?");
  for (const id of ids) del.run(id);
  return [...ids];
}
