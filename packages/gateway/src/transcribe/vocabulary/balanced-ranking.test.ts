// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";
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
    // Strong verified authored support survives global frequency penalties;
    // full-strength authored discrimination still favors the narrow term.
    const legacy = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      { ...settings, maxTerms: 1, authoredRarityWeight: 1, authoredContextLiftWeight: 1 },
    );
    expect(legacy.entries.map((entry) => entry.text)).toEqual([conversational]);
  },
);

test("ordinary relationship anchors survive broad corpus frequency independently of authored blends", () => {
  const db = createDatabase(":memory:");
  databases.push(db);
  const conversationKey = JSON.stringify(["messages", "fictional-thread"]);
  db.prepare(
    "INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at) VALUES ('fictional-speaker','Velquorin','fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
  ).run();
  const profile = db.prepare("INSERT INTO transcription_vocabulary_profiles VALUES(?,?,?)");
  profile.run("global", "", 200000);
  profile.run("person", "fictional-speaker", 20000);
  profile.run("conversation", conversationKey, 20000);
  const insert = db.prepare(`INSERT INTO transcription_vocabulary_terms
    (scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen,
     evidence_count,ordinary_document_count,spelling_count)
    VALUES (?,?,?,?,?,2,?,'2026-01-01',?,?,?)`);
  for (const broadCount of [1000, 10000, 100000]) {
    db.exec("DELETE FROM transcription_vocabulary_terms");
    for (const [kind, key] of [
      ["global", ""],
      ["person", "fictional-speaker"],
      ["conversation", conversationKey],
    ])
      for (const [text, count] of [
        ["Broadvelune", kind === "global" ? broadCount : broadCount / 10],
        ["Meralith", 20],
      ] as const)
        insert.run(
          kind,
          key,
          text.toLowerCase(),
          text,
          count,
          2 * Math.log1p(count),
          count,
          count,
          count,
        );
    for (const includeConversation of [false, true]) {
      const context = {
        purpose: "source-audio" as const,
        speaker: { personId: "fictional-speaker" },
        recordedAt: "2026-01-01",
        ...(includeConversation
          ? { conversation: { sourceId: SourceId("messages"), threadId: "fictional-thread" } }
          : {}),
      };
      const baseline = getTranscriptionVocabulary(db, context, settings);
      expect(baseline.entries.map((entry) => entry.text)).toEqual(["Meralith", "Broadvelune"]);
      // Ordinary rarity saturates frequency support below its spelling benefit.
      expect(baseline.entries[1].score).toBeLessThan(2 * (includeConversation ? 9 : 4));
      for (const weight of [0, 1])
        expect(
          getTranscriptionVocabulary(db, context, {
            ...settings,
            authoredRarityWeight: weight,
            authoredContextLiftWeight: weight,
          }),
        ).toEqual(baseline);
    }
  }
});

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
