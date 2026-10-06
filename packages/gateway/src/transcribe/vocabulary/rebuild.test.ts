// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import {
  advanceTranscriptionVocabularyRebuild,
  createTranscriptionVocabularyState,
  transcriptionVocabularyGeneration,
  VOCABULARY_EVIDENCE_VERSION,
} from "./rebuild.js";
import {
  applyTranscriptionVocabularyBatch,
  fetchTranscriptionVocabularyBatch,
  getTranscriptionVocabulary,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { VocabularySettings, ExtractedVocabularyDocument } from "./types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 224,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 64,
  periodMs: 1000,
  idlePeriodMs: 60000,
};
const databases: Db[] = [];
function database(): Db {
  const db = createDatabase(":memory:");
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function insert(db: Db, id: string, processed = true): void {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at,vocabulary_processed_at)
    VALUES (?,'fictional','fictional:messages',?,'','Tazureli','hash','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01','2026-01-01',?)`,
  ).run(id, id, processed ? "2026-01-01" : null);
}
function obsolete(db: Db): void {
  db.exec("UPDATE transcription_vocabulary_state SET algorithm_version=1");
}
function drain(db: Db): void {
  for (let i = 0; i < 100; i++)
    if (advanceTranscriptionVocabularyRebuild(db, settings).ready) return;
  throw new Error("reset did not finish");
}
function batch(id: string, generation: number): ExtractedVocabularyDocument {
  return {
    id,
    generation,
    contentHash: "hash",
    updatedAt: "2026-01-01",
    revision: 0,
    scopes: [{ kind: "global", key: "" }],
    recordedAt: "2026-01-01",
    terms: [{ term: "tazureli", text: "Tazureli", benefit: 3 }],
  };
}

describe("versioned vocabulary rebuild", () => {
  test("fresh stores are ready and disabled reset touches no database", () => {
    const db = database();
    expect(transcriptionVocabularyGeneration(db)).toBe(1);
    const spy = vi.spyOn(db, "prepare");
    expect(advanceTranscriptionVocabularyRebuild(db, { ...settings, enabled: false })).toEqual({
      ready: false,
      worked: false,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  test("obsolete hints and extraction remain hidden until bounded reset completes", () => {
    const db = database();
    insert(db, "a", false);
    applyTranscriptionVocabularyBatch(db, [batch("a", 1)]);
    obsolete(db);
    expect(getTranscriptionVocabulary(db, { purpose: "dictation" }, settings)).toEqual({
      entries: [],
    });
    expect(fetchTranscriptionVocabularyBatch(db, settings)).toEqual([]);
    drain(db);
    expect(transcriptionVocabularyGeneration(db)).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_terms").get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_document_terms").get(),
    ).toEqual({ n: 0 });
    expect(fetchTranscriptionVocabularyBatch(db, settings)[0]).toMatchObject({
      id: "a",
      generation: 2,
      revision: 1,
    });
    expect(applyTranscriptionVocabularyBatch(db, [batch("a", 1)])).toMatchObject({
      applied: 0,
      skipped: 1,
    });
    const current = { ...batch("a", 2), revision: 1 };
    expect(applyTranscriptionVocabularyBatch(db, [current])).toMatchObject({
      applied: 1,
      skipped: 0,
    });
    expect(applyTranscriptionVocabularyBatch(db, [current])).toMatchObject({
      applied: 0,
      skipped: 1,
    });
  });
  test("preemption checkpoints one page and recreated state resumes without losing new ingestion", () => {
    const db = database();
    for (let i = 0; i < 300; i++) insert(db, `d${String(i).padStart(3, "0")}`);
    obsolete(db);
    const token = { requested: () => true };
    for (let i = 0; i < 4; i++) advanceTranscriptionVocabularyRebuild(db, settings, token);
    expect(db.prepare("SELECT phase,cursor FROM transcription_vocabulary_state").get()).toEqual({
      phase: "documents",
      cursor: "d127",
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM documents WHERE vocabulary_processed_at IS NULL").get(),
    ).toEqual({ n: 128 });
    // Restart resumes solely from persisted state; new IDs behind the cursor already stay pending.
    insert(db, "a-new", false);
    advanceTranscriptionVocabularyRebuild(db, settings, token);
    expect(db.prepare("SELECT cursor FROM transcription_vocabulary_state").get()).toEqual({
      cursor: "d255",
    });
    drain(db);
    expect(
      db.prepare("SELECT count(*) AS n FROM documents WHERE vocabulary_processed_at IS NULL").get(),
    ).toEqual({ n: 301 });
    expect(
      db.prepare("SELECT vocabulary_revision AS revision FROM documents WHERE id='a-new'").get(),
    ).toEqual({ revision: 0 });
  });
  test("a process restart resumes the committed reset phase and cursor", () => {
    const dir = mkdtempSync(join(tmpdir(), "vocabulary-rebuild-"));
    let db = createDatabase(join(dir, "fixture.db"));
    try {
      for (let i = 0; i < 300; i++) insert(db, `d${String(i).padStart(3, "0")}`);
      obsolete(db);
      for (let i = 0; i < 4; i++)
        advanceTranscriptionVocabularyRebuild(db, settings, { requested: () => true });
      db.close();
      db = createDatabase(join(dir, "fixture.db"));
      expect(
        db.prepare("SELECT phase,cursor,generation FROM transcription_vocabulary_state").get(),
      ).toEqual({ phase: "documents", cursor: "d127", generation: 2 });
      expect(fetchTranscriptionVocabularyBatch(db, settings)).toEqual([]);
      drain(db);
      expect(transcriptionVocabularyGeneration(db)).toBe(2);
      expect(
        db.prepare("SELECT count(*) AS n FROM documents WHERE vocabulary_revision=1").get(),
      ).toEqual({ n: 300 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("aggregate and contribution deletion are bounded even when foreground work waits", () => {
    const db = database();
    const add = db.prepare(
      "INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen) VALUES ('global','',?, ?,2,3,3,'2026-01-01')",
    );
    const ledger = db.prepare(
      "INSERT INTO transcription_vocabulary_document_terms(document_id,scope_kind,scope_key,term) VALUES (?,'global','',?)",
    );
    for (let i = 0; i < 300; i++) {
      add.run(`term${i}`, `Term${i}`);
      ledger.run(`doc${i}`, `term${i}`);
    }
    obsolete(db);
    const token = { requested: () => true };
    advanceTranscriptionVocabularyRebuild(db, settings, token);
    advanceTranscriptionVocabularyRebuild(db, settings, token);
    expect(db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_terms").get()).toEqual({
      n: 172,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_document_terms").get(),
    ).toEqual({ n: 300 });
    drain(db);
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_document_terms").get(),
    ).toEqual({ n: 0 });
  });
});

function refresh(db: Db): void {
  db.exec("UPDATE transcription_vocabulary_refresh_state SET version=0,cursor='',done=0");
}

function refreshState(db: Db): unknown {
  return db
    .prepare("SELECT version,cursor,done FROM transcription_vocabulary_refresh_state WHERE id=1")
    .get();
}

describe("non-destructive vocabulary evidence refresh", () => {
  test("enrolls one page while old hints and contribution counts remain available", () => {
    const db = database();
    for (const id of ["a", "b"]) {
      insert(db, id, false);
      applyTranscriptionVocabularyBatch(db, [batch(id, 1)]);
    }
    const context = { purpose: "dictation" as const, recordedAt: "2026-01-15T12:00:00.000Z" };
    const entries = getTranscriptionVocabulary(db, context, settings).entries;
    expect(entries).toHaveLength(1);
    refresh(db);
    expect(advanceTranscriptionVocabularyRebuild(db, settings)).toEqual({
      ready: true,
      worked: true,
    });
    expect(transcriptionVocabularyGeneration(db)).toBe(1);
    expect(getTranscriptionVocabulary(db, context, settings).entries).toEqual(entries);
    expect(db.prepare("SELECT document_count FROM transcription_vocabulary_terms").get()).toEqual({
      document_count: 2,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_document_terms").get(),
    ).toEqual({ n: 2 });
    expect(fetchTranscriptionVocabularyBatch(db, settings).map((doc) => doc.revision)).toEqual([
      1, 1,
    ]);
    expect(refreshState(db)).toEqual({
      version: VOCABULARY_EVIDENCE_VERSION,
      cursor: "b",
      done: 1,
    });
    expect(advanceTranscriptionVocabularyRebuild(db, settings)).toEqual({
      ready: true,
      worked: false,
    });
  });

  test("does not enroll or query while disabled, and fences stale extraction", () => {
    const db = database();
    insert(db, "a", false);
    const stale = fetchTranscriptionVocabularyBatch(db, settings)[0];
    applyTranscriptionVocabularyBatch(db, [batch("a", 1)]);
    refresh(db);
    const spy = vi.spyOn(db, "prepare");
    expect(advanceTranscriptionVocabularyRebuild(db, { ...settings, enabled: false })).toEqual({
      ready: false,
      worked: false,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    advanceTranscriptionVocabularyRebuild(db, settings);
    expect(
      applyTranscriptionVocabularyBatch(db, [{ ...batch("a", 1), revision: stale.revision }]),
    ).toMatchObject({ applied: 0, skipped: 1 });
    expect(fetchTranscriptionVocabularyBatch(db, settings)[0].revision).toBe(1);
  });

  test("checkpoints bounded pages and leaves already pending documents' revisions intact", () => {
    const db = database();
    for (let i = 0; i < 300; i++) insert(db, `d${String(i).padStart(3, "0")}`);
    insert(db, "a-pending", false);
    refresh(db);
    advanceTranscriptionVocabularyRebuild(db, settings, { requested: () => true });
    expect(refreshState(db)).toEqual({
      version: VOCABULARY_EVIDENCE_VERSION,
      cursor: "d126",
      done: 0,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM documents WHERE vocabulary_processed_at IS NULL").get(),
    ).toEqual({ n: 128 });
    expect(
      db
        .prepare("SELECT vocabulary_revision AS revision FROM documents WHERE id='a-pending'")
        .get(),
    ).toEqual({ revision: 0 });
    insert(db, "a-new", false);
    advanceTranscriptionVocabularyRebuild(db, settings);
    expect(refreshState(db)).toEqual({
      version: VOCABULARY_EVIDENCE_VERSION,
      cursor: "d254",
      done: 0,
    });
    advanceTranscriptionVocabularyRebuild(db, settings);
    expect(refreshState(db)).toEqual({
      version: VOCABULARY_EVIDENCE_VERSION,
      cursor: "d299",
      done: 1,
    });
    expect(
      db.prepare("SELECT count(*) AS n FROM documents WHERE vocabulary_processed_at IS NULL").get(),
    ).toEqual({ n: 302 });
  });

  test("persisted refresh survives restart without enrolling the completed page twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "vocabulary-refresh-"));
    let db = createDatabase(join(dir, "fixture.db"));
    try {
      for (let i = 0; i < 300; i++) insert(db, `d${String(i).padStart(3, "0")}`);
      refresh(db);
      advanceTranscriptionVocabularyRebuild(db, settings);
      db.close();
      db = createDatabase(join(dir, "fixture.db"));
      expect(refreshState(db)).toEqual({
        version: VOCABULARY_EVIDENCE_VERSION,
        cursor: "d127",
        done: 0,
      });
      advanceTranscriptionVocabularyRebuild(db, settings);
      expect(refreshState(db)).toEqual({
        version: VOCABULARY_EVIDENCE_VERSION,
        cursor: "d255",
        done: 0,
      });
      expect(
        db.prepare("SELECT vocabulary_revision AS revision FROM documents WHERE id='d000'").get(),
      ).toEqual({ revision: 1 });
      expect(transcriptionVocabularyGeneration(db)).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upgrade installs only refresh state and preserves a newer checkpoint", () => {
    const db = database();
    insert(db, "a");
    db.exec("DROP TABLE transcription_vocabulary_refresh_state");
    createTranscriptionVocabularyState(db);
    expect(refreshState(db)).toEqual({ version: VOCABULARY_EVIDENCE_VERSION, cursor: "", done: 0 });
    expect(db.prepare("SELECT vocabulary_processed_at FROM documents WHERE id='a'").get()).toEqual({
      vocabulary_processed_at: "2026-01-01",
    });
    db.prepare(
      "UPDATE transcription_vocabulary_refresh_state SET version=?,cursor='future',done=0",
    ).run(VOCABULARY_EVIDENCE_VERSION + 1);
    expect(advanceTranscriptionVocabularyRebuild(db, settings)).toEqual({
      ready: true,
      worked: false,
    });
    expect(refreshState(db)).toEqual({
      version: VOCABULARY_EVIDENCE_VERSION + 1,
      cursor: "future",
      done: 0,
    });
  });

  test("destructive reset deletes spelling evidence in bounded pages and needs no second refresh", () => {
    const db = database();
    const add = db.prepare(
      "INSERT INTO transcription_vocabulary_spellings VALUES ('global','',?,?,2,2)",
    );
    for (let i = 0; i < 300; i++) add.run(`term${i}`, `Term${i}`);
    insert(db, "a");
    obsolete(db);
    advanceTranscriptionVocabularyRebuild(db, settings, { requested: () => true });
    advanceTranscriptionVocabularyRebuild(db, settings, { requested: () => true });
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_spellings").get(),
    ).toEqual({ n: 172 });
    expect(transcriptionVocabularyGeneration(db)).toBeNull();
    drain(db);
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_spellings").get(),
    ).toEqual({ n: 0 });
    expect(refreshState(db)).toEqual({ version: VOCABULARY_EVIDENCE_VERSION, cursor: "", done: 1 });
    expect(advanceTranscriptionVocabularyRebuild(db, settings)).toEqual({
      ready: true,
      worked: false,
    });
    expect(
      db.prepare("SELECT vocabulary_revision AS revision FROM documents WHERE id='a'").get(),
    ).toEqual({ revision: 1 });
  });
});
