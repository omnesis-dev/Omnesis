// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { extractTranscriptionVocabulary } from "./extract.js";
import { applyTranscriptionVocabularyBatch, getTranscriptionVocabulary } from "./storage.js";
import type { Db } from "../../data/types.js";
import type {
  ExtractedVocabularyDocument,
  VocabularyDocument,
  VocabularySettings,
} from "./types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 96,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 128,
  periodMs: 1000,
  idlePeriodMs: 60000,
};
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function database(): Db {
  const db = createDatabase(":memory:");
  databases.push(db);
  return db;
}
function document(db: Db, id: string, content: string): VocabularyDocument {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
    VALUES (?,'fictional','fictional:messages',?,'',?,'hash','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(id, id, content);
  return {
    id,
    contentHash: "hash",
    updatedAt: "2026-01-01",
    revision: 0,
    generation: 1,
    title: "",
    content,
    sourceId: "fictional:messages",
    threadId: "fictional-thread",
    recordedAt: "2026-01-01",
    people: [
      {
        personId: "fictional-person",
        name: "Fictional recipient",
        isSelf: false,
        role: "recipient",
      },
    ],
  };
}
function profile(db: Db, kind: string, key = ""): number {
  return (
    (
      db
        .prepare(
          "SELECT document_count FROM transcription_vocabulary_profiles WHERE scope_kind=? AND scope_key=?",
        )
        .get(kind, key) as { document_count: number } | undefined
    )?.document_count ?? 0
  );
}
function apply(db: Db, doc: VocabularyDocument): ExtractedVocabularyDocument {
  const extracted = extractTranscriptionVocabulary([doc], settings)[0];
  expect(applyTranscriptionVocabularyBatch(db, [extracted])).toMatchObject({
    applied: 1,
    skipped: 0,
  });
  return extracted;
}

test("common-only prose counts opportunities without inventing uncommon or authored terms", () => {
  const db = database();
  const doc = document(db, "common", "hello the and");
  doc.selfAuthoredText = [{ text: "hello the and", recordedAt: "2026-01-01" }];
  const extracted = apply(db, doc);
  expect(extracted.terms).toEqual([]);
  expect(extracted.selfTerms).toEqual([]);
  expect(profile(db, "global")).toBe(1);
  expect(profile(db, "person", "fictional-person")).toBe(1);
  expect(profile(db, "self")).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_terms").get()).toEqual({
    n: 0,
  });
  expect(applyTranscriptionVocabularyBatch(db, [extracted])).toMatchObject({
    applied: 0,
    skipped: 1,
  });
  expect(profile(db, "global")).toBe(1);
});

test("empty and identifier-only content never fabricate opportunity denominators", () => {
  const db = database();
  for (const [id, content] of [
    ["empty", ""],
    ["identifier", "https://example.org/path"],
  ]) {
    const doc = document(db, id, content);
    doc.selfAuthoredText = [];
    apply(db, doc);
  }
  expect(profile(db, "global")).toBe(0);
  expect(profile(db, "self")).toBe(0);
});

test("fresh term frequencies use the refreshed cohort rather than retained legacy counts", () => {
  const db = database();
  db.prepare(
    `INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen)
    VALUES('global','','quorvex','Quorvex',10000,2,10,'2026-01-01')`,
  ).run();
  for (const id of ["fresh-a", "fresh-b"]) apply(db, document(db, id, "Quorvex"));
  const evidence = db
    .prepare(
      "SELECT document_count,evidence_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='quorvex'",
    )
    .get();
  expect(evidence).toEqual({ document_count: 10002, evidence_count: 2 });
  expect(profile(db, "global")).toBe(2);
  const doc = document(db, "common", "hello the and");
  apply(db, doc);
  expect(profile(db, "global")).toBe(3);
  expect(
    db
      .prepare(
        "SELECT evidence_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='quorvex'",
      )
      .get(),
  ).toEqual({ evidence_count: 2 });
});

test("partial writer continuations and content replay preserve fresh frequency invariants", () => {
  const db = database();
  const doc = document(db, "many", "Quorvex");
  const extracted: ExtractedVocabularyDocument = {
    ...extractTranscriptionVocabulary([doc], settings)[0],
    scopes: [
      { kind: "global", key: "" },
      { kind: "person", key: "fictional-person" },
    ],
    terms: Array.from({ length: 128 }, (_, i) => ({
      term: `quorvex${i}`,
      text: `Quorvex${i}`,
      benefit: 2,
    })),
  };
  const first = applyTranscriptionVocabularyBatch(db, [extracted], { requested: () => true });
  expect(first.remaining[0].applyOffset).toBe(32);
  expect(profile(db, "global")).toBe(1);
  expect(profile(db, "person", "fictional-person")).toBe(1);
  expect(applyTranscriptionVocabularyBatch(db, first.remaining)).toMatchObject({
    applied: 1,
    skipped: 0,
  });
  db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id=?").run(doc.id);
  expect(applyTranscriptionVocabularyBatch(db, [extracted])).toMatchObject({
    applied: 1,
    skipped: 0,
  });
  expect(profile(db, "global")).toBe(1);
  expect(profile(db, "person", "fictional-person")).toBe(1);
  expect(
    db
      .prepare("SELECT count(*) AS n FROM transcription_vocabulary_terms WHERE evidence_count<>1")
      .get(),
  ).toEqual({ n: 0 });
});

function spellingProfiles(db: Db, selfSpellingCount: number): void {
  db.exec("INSERT INTO transcription_vocabulary_profiles VALUES ('global','',10),('self','',2)");
  const add =
    db.prepare(`INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count)
    VALUES (?,'','zilora',?, ?,2.5,5,'2026-01-01',?, ?,?,?)`);
  add.run("global", "ZiLora", 10, 0, 10, 10, 10);
  add.run("self", "Zilora", 2, 2, 2, 0, selfSpellingCount);
}

test("a context's corroborated spelling wins over a broader profile's spelling", () => {
  const db = database();
  spellingProfiles(db, 2);
  expect(
    getTranscriptionVocabulary(db, { purpose: "dictation", recordedAt: "2026-01-01" }, settings)
      .entries[0]?.text,
  ).toBe("Zilora");
});

test("one contextual spelling cannot replace a corroborated global spelling", () => {
  const db = database();
  spellingProfiles(db, 1);
  expect(
    getTranscriptionVocabulary(db, { purpose: "dictation", recordedAt: "2026-01-01" }, settings)
      .entries[0]?.text,
  ).toBe("ZiLora");
});
