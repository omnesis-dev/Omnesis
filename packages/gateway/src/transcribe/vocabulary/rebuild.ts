// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../../data/types.js";
import type { VocabularySettings } from "./types.js";

/** Bump when previously accumulated hints must be replaced, not merely reranked. */
export const VOCABULARY_ALGORITHM_VERSION = 4;
const RESET_PAGE_SIZE = 128;
/** Bump when existing documents need new evidence without discarding learned terms. */
export const VOCABULARY_EVIDENCE_VERSION = 1;
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
  db.exec(`CREATE TABLE IF NOT EXISTS transcription_vocabulary_refresh_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL,
    cursor TEXT NOT NULL,
    done INTEGER NOT NULL CHECK(done IN (0,1))
  )`);
  db.prepare("INSERT OR IGNORE INTO transcription_vocabulary_refresh_state VALUES (1,?,'',?)").run(
    VOCABULARY_EVIDENCE_VERSION,
    existing ? 0 : 1,
  );
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

/** Called inside the page transaction, keeping old hints available during enrollment. */
function advanceEvidenceRefresh(db: Db): { ready: boolean; worked: boolean } {
  const refresh = db
    .prepare("SELECT version,cursor,done FROM transcription_vocabulary_refresh_state WHERE id=1")
    .get() as { version: number; cursor: string; done: number } | undefined;
  if (!refresh) throw new Error("Transcription vocabulary refresh state is missing");
  // An older binary must not overwrite a newer binary's refresh checkpoint.
  if (
    refresh.version > VOCABULARY_EVIDENCE_VERSION ||
    (refresh.version === VOCABULARY_EVIDENCE_VERSION && refresh.done)
  )
    return { ready: true, worked: false };
  const cursor = refresh.version === VOCABULARY_EVIDENCE_VERSION ? refresh.cursor : "";
  const rows = db
    .prepare("SELECT id FROM documents WHERE id>? ORDER BY id LIMIT ?")
    .all(cursor, RESET_PAGE_SIZE) as Array<{ id: string }>;
  const enroll = db.prepare(`UPDATE documents SET vocabulary_processed_at=NULL,
    vocabulary_revision=vocabulary_revision+1 WHERE id=? AND vocabulary_processed_at IS NOT NULL`);
  for (const row of rows) enroll.run(row.id);
  db.prepare(
    "UPDATE transcription_vocabulary_refresh_state SET version=?,cursor=?,done=? WHERE id=1",
  ).run(
    VOCABULARY_EVIDENCE_VERSION,
    rows.at(-1)?.id ?? cursor,
    rows.length < RESET_PAGE_SIZE ? 1 : 0,
  );
  return { ready: true, worked: true };
}

/** One bounded transaction per reset page; persisted phases survive interruption. */
function advancePage(db: Db, settings: VocabularySettings): { ready: boolean; worked: boolean } {
  if (!settings.enabled) return { ready: false, worked: false };
  return db.transaction(() => {
    const current = state(db);
    if (!current) throw new Error("Transcription vocabulary state is missing");
    if (current.phase === "ready" && current.algorithm_version === VOCABULARY_ALGORITHM_VERSION)
      return advanceEvidenceRefresh(db);
    if (current.phase === "ready" || current.target_version !== VOCABULARY_ALGORITHM_VERSION) {
      db.prepare(
        `UPDATE transcription_vocabulary_state SET target_version=?,generation=generation+1,phase='terms',cursor='' WHERE id=1`,
      ).run(VOCABULARY_ALGORITHM_VERSION);
      return { ready: false, worked: true };
    }
    if (current.phase === "terms") {
      const profileDocuments = db
        .prepare(
          `SELECT document_id,scope_kind,scope_key
        FROM transcription_vocabulary_document_profiles LIMIT ?`,
        )
        .all(RESET_PAGE_SIZE) as Array<{
        document_id: string;
        scope_kind: string;
        scope_key: string;
      }>;
      if (profileDocuments.length) {
        const remove = db.prepare(`DELETE FROM transcription_vocabulary_document_profiles
          WHERE document_id=? AND scope_kind=? AND scope_key=?`);
        for (const row of profileDocuments)
          remove.run(row.document_id, row.scope_kind, row.scope_key);
        return { ready: false, worked: true };
      }
      const profiles = db
        .prepare(`SELECT scope_kind,scope_key FROM transcription_vocabulary_profiles LIMIT ?`)
        .all(RESET_PAGE_SIZE) as Array<{ scope_kind: string; scope_key: string }>;
      if (profiles.length) {
        const remove = db.prepare(
          "DELETE FROM transcription_vocabulary_profiles WHERE scope_kind=? AND scope_key=?",
        );
        for (const row of profiles) remove.run(row.scope_kind, row.scope_key);
        return { ready: false, worked: true };
      }
      const spellings = db
        .prepare(
          `SELECT scope_kind,scope_key,term,text
        FROM transcription_vocabulary_spellings LIMIT ?`,
        )
        .all(RESET_PAGE_SIZE) as Array<{
        scope_kind: string;
        scope_key: string;
        term: string;
        text: string;
      }>;
      if (spellings.length) {
        const removeSpelling = db.prepare(`DELETE FROM transcription_vocabulary_spellings
          WHERE scope_kind=? AND scope_key=? AND term=? AND text=?`);
        for (const spelling of spellings)
          removeSpelling.run(spelling.scope_kind, spelling.scope_key, spelling.term, spelling.text);
        return { ready: false, worked: true };
      }
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
        // The destructive reset already enrolled every existing document.
        db.prepare(
          "UPDATE transcription_vocabulary_refresh_state SET version=?,cursor='',done=1 WHERE id=1 AND version<=?",
        ).run(VOCABULARY_EVIDENCE_VERSION, VOCABULARY_EVIDENCE_VERSION);
        return { ready: true, worked: true };
      }
      db.prepare("UPDATE transcription_vocabulary_state SET cursor=? WHERE id=1").run(
        rows.at(-1)!.id,
      );
    }
    return { ready: false, worked: true };
  })();
}

/** Reset at most 2048 rows, or enroll one 128-document evidence page while serving hints. */
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
