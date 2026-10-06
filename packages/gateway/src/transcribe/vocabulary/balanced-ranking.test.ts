// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { getTranscriptionVocabulary } from "./storage.js";
import type { Db } from "../../data/types.js";
import type { VocabularySettings } from "./types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 96,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 64,
  periodMs: 1000,
  idlePeriodMs: 60000,
};
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(technical: string, conversational: string): Db {
  const db = createDatabase(":memory:");
  databases.push(db);
  db.exec(`INSERT INTO transcription_vocabulary_profiles VALUES
    ('global','',10000),('self','',2000)`);
  term(db, technical, 500, 110, 90, 2.5);
  term(db, conversational, 12, 12, 12, 2);
  return db;
}

// Model coherent materialized cohorts directly to isolate ranking from lexical extraction.
function term(
  db: Db,
  text: string,
  globalCount: number,
  authoredCount: number,
  mass: number,
  benefit: number,
) {
  const insert = db.prepare(`INSERT INTO transcription_vocabulary_terms
    (scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen,recent_mass,
      evidence_count,ordinary_document_count,spelling_count)
    VALUES (?,'',?,?,?,?,?,'2026-01-01',?,?,?,?)`);
  insert.run(
    "global",
    text.toLocaleLowerCase("und"),
    text,
    globalCount,
    benefit,
    benefit * Math.log1p(globalCount),
    0,
    globalCount,
    globalCount,
    globalCount,
  );
  insert.run(
    "self",
    text.toLocaleLowerCase("und"),
    text,
    authoredCount,
    benefit,
    benefit * Math.log1p(mass),
    mass,
    authoredCount,
    authoredCount,
    authoredCount,
  );
}

test.each([
  ["en", "prismaVeld", "zoffli"],
  ["fr", "résoNève", "plouki"],
])(
  "%s: widely distributed technical vocabulary survives narrow recent slang",
  (_language, technical, conversational) => {
    const db = fixture(technical, conversational);
    const dictionary = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      { ...settings, maxTerms: 1 },
    );
    expect(dictionary.entries.map((entry) => entry.text)).toEqual([technical]);
    // Full-strength discrimination reproduces the frequency/lift cancellation;
    // the balanced default fixes it without term-specific admission rules.
    const legacy = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      { ...settings, maxTerms: 1, rarityWeight: 1, contextLiftWeight: 1 },
    );
    expect(legacy.entries.map((entry) => entry.text)).toEqual([conversational]);
  },
);

test("strong recent contextual evidence can still outrank broad vocabulary", () => {
  const db = fixture("prismaVeld", "zoffli");
  term(db, "Orvessa Talerin", 40, 40, 40, 4);
  expect(
    getTranscriptionVocabulary(
      db,
      { purpose: "agent", recordedAt: "2026-01-01" },
      { ...settings, maxTerms: 1 },
    ).entries[0].text,
  ).toBe("Orvessa Talerin");
});

test("authored confidence does not keep stale vocabulary ahead of current use", () => {
  const db = fixture("résoNève", "plouki");
  db.prepare("UPDATE transcription_vocabulary_terms SET last_seen='2024-01-01' WHERE term=?").run(
    "résonève",
  );
  expect(
    getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      { ...settings, maxTerms: 1 },
    ).entries[0].text,
  ).toBe("plouki");
  expect(
    getTranscriptionVocabulary(db, { purpose: "dictation" }, { ...settings, enabled: false }),
  ).toEqual({ entries: [] });
});
