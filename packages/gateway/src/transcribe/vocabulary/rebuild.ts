// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../../data/types.js";
import type { VocabularySettings } from "./types.js";

/** Bump when previously accumulated hints must be replaced, not merely reranked. */
export const VOCABULARY_ALGORITHM_VERSION = 2;
const RESET_PAGE_SIZE = 128;
type Phase = "ready" | "terms" | "ledger" | "documents";
interface State {
  algorithm_version: number;
  target_version: number;
  generation: number;
  phase: Phase;
  cursor: string;
}

/** Schema-only setup. Existing corpora require a background reset; fresh stores do not. */
export function createTranscriptionVocabularyState(db: Db): void {
  const existing = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
    .get();
  db.exec(`CREATE TABLE IF NOT EXISTS transcription_vocabulary_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    algorithm_version INTEGER NOT NULL,
    target_version INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('ready','terms','ledger','documents')),
    cursor TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT OR IGNORE INTO transcription_vocabulary_state VALUES (1,?,?,1,'ready','')`,
  ).run(existing ? 1 : VOCABULARY_ALGORITHM_VERSION, VOCABULARY_ALGORITHM_VERSION);
}

function state(db: Db): State | undefined {
  return db
    .prepare(
      "SELECT algorithm_version,target_version,generation,phase,cursor FROM transcription_vocabulary_state WHERE id=1",
    )
    .get() as State | undefined;
}

/** Null holds both inference and extraction closed throughout an obsolete/reset generation. */
export function transcriptionVocabularyGeneration(db: Db): number | null {
  const current = state(db);
  return current?.phase === "ready" && current.algorithm_version === VOCABULARY_ALGORITHM_VERSION
    ? current.generation
    : null;
}

/** One bounded transaction per reset page; persisted phases survive interruption. */
function advancePage(db: Db, settings: VocabularySettings): { ready: boolean; worked: boolean } {
  if (!settings.enabled) return { ready: false, worked: false };
  return db.transaction(() => {
    const current = state(db);
    if (!current) throw new Error("Transcription vocabulary state is missing");
    if (current.phase === "ready" && current.algorithm_version === VOCABULARY_ALGORITHM_VERSION)
      return { ready: true, worked: false };
    if (current.phase === "ready" || current.target_version !== VOCABULARY_ALGORITHM_VERSION) {
      db.prepare(
        `UPDATE transcription_vocabulary_state SET target_version=?,generation=generation+1,phase='terms',cursor='' WHERE id=1`,
      ).run(VOCABULARY_ALGORITHM_VERSION);
      return { ready: false, worked: true };
    }
    if (current.phase === "terms") {
      const rows = db
        .prepare("SELECT rowid FROM transcription_vocabulary_terms LIMIT ?")
        .all(RESET_PAGE_SIZE) as Array<{ rowid: number }>;
      const remove = db.prepare("DELETE FROM transcription_vocabulary_terms WHERE rowid=?");
      for (const row of rows) remove.run(row.rowid);
      if (rows.length < RESET_PAGE_SIZE)
        db.exec("UPDATE transcription_vocabulary_state SET phase='ledger' WHERE id=1");
    } else if (current.phase === "ledger") {
      const rows = db
        .prepare(
          "SELECT document_id,scope_kind,scope_key,term FROM transcription_vocabulary_document_terms LIMIT ?",
        )
        .all(RESET_PAGE_SIZE) as Array<{
        document_id: string;
        scope_kind: string;
        scope_key: string;
        term: string;
      }>;
      const remove = db.prepare(
        "DELETE FROM transcription_vocabulary_document_terms WHERE document_id=? AND scope_kind=? AND scope_key=? AND term=?",
      );
      for (const row of rows) remove.run(row.document_id, row.scope_kind, row.scope_key, row.term);
      if (rows.length < RESET_PAGE_SIZE)
        db.exec("UPDATE transcription_vocabulary_state SET phase='documents',cursor='' WHERE id=1");
    } else {
      const rows = db
        .prepare("SELECT id FROM documents WHERE id>? ORDER BY id LIMIT ?")
        .all(current.cursor, RESET_PAGE_SIZE) as Array<{ id: string }>;
      const reset = db.prepare(
        "UPDATE documents SET vocabulary_processed_at=NULL,vocabulary_revision=vocabulary_revision+1 WHERE id=?",
      );
      for (const row of rows) reset.run(row.id);
      if (rows.length < RESET_PAGE_SIZE) {
        db.prepare(
          "UPDATE transcription_vocabulary_state SET algorithm_version=?,phase='ready',cursor='' WHERE id=1",
        ).run(VOCABULARY_ALGORITHM_VERSION);
        return { ready: true, worked: true };
      }
      db.prepare("UPDATE transcription_vocabulary_state SET cursor=? WHERE id=1").run(
        rows.at(-1)!.id,
      );
    }
    return { ready: false, worked: true };
  })();
}

/** At most 2048 reset rows; foreground work can preempt between 128-row transactions. */
export function advanceTranscriptionVocabularyRebuild(
  db: Db,
  settings: VocabularySettings,
  token?: { requested(): boolean },
): { ready: boolean; worked: boolean } {
  if (!settings.enabled) return { ready: false, worked: false };
  let worked = false;
  for (let page = 0; page < 16; page++) {
    const result = advancePage(db, settings);
    worked ||= result.worked;
    if (result.ready || token?.requested()) return { ready: result.ready, worked };
  }
  return { ready: false, worked };
}
