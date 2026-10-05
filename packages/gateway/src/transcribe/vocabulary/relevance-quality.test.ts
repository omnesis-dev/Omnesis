// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { adaptTranscriptionVocabulary } from "../vocabulary-adapter.js";
import { extractTranscriptionVocabulary } from "./extract.js";
import { advanceTranscriptionVocabularyRebuild } from "./rebuild.js";
import {
  applyTranscriptionVocabularyBatch,
  fetchTranscriptionVocabularyBatch,
  getTranscriptionVocabulary,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { TranscriptionContext } from "@omnesis/types";
import type { VocabularySettings } from "./types.js";

const NOW = "2026-10-01T12:00:00.000Z";
const RECENT = "2026-09-29T12:00:00.000Z";
const OLD = "2020-01-01T12:00:00.000Z";
const settings: VocabularySettings = {
  enabled: true,
  authoredWeight: 4,
  machineEvidenceWeight: 0.15,
  contextPriorDocuments: 10,
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

interface History {
  text: string;
  date?: string;
  own?: string;
  ownDate?: string;
  peer?: "north" | "south";
  thread?: string;
  automated?: boolean;
  bulk?: boolean;
}

// All words and scenarios are invented. Judgments below describe independently
// chosen future utterances; those utterances are never inserted into the history.
// Twenty eligible distractors force real competition for the recognizer budget.
const crowd = Array.from({ length: 20 }, (_, i) => `distrax${String.fromCharCode(97 + i)}vex`).join(
  "; ",
);
const crowdedHistory = (): History[] => [{ text: crowd }, { text: crowd }];

function materialize(history: History[]): Db {
  const db = createDatabase(":memory:");
  databases.push(db);
  expect(advanceTranscriptionVocabularyRebuild(db, settings).ready).toBe(true);
  const person = db.prepare(
    `INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
     VALUES (?,?,'fictional',?,?,?,?,?)`,
  );
  for (const id of ["self", "north", "south"])
    person.run(id, id === "self" ? "Operator" : id, id === "self" ? 1 : 0, NOW, NOW, NOW, NOW);
  const insert = db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,
      source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
     VALUES (?,'fictional','fictional:quality',?,'',?,?,?,?,?,?,?,?)`,
  );
  const link = db.prepare(
    "INSERT INTO document_people(document_id,person_id,role,source_id) VALUES (?,?,?,'fictional:quality')",
  );
  history.forEach((item, index) => {
    const id = `history-${String(index).padStart(3, "0")}`;
    const date = item.date ?? RECENT;
    const metadata = {
      ...(item.thread ? { extra: { conversationId: item.thread } } : {}),
      ...(item.automated ? { automatedSender: true } : {}),
      ...(item.bulk ? { bulkMail: true } : {}),
      ...(item.own !== undefined
        ? { selfAuthoredText: [{ text: item.own, recordedAt: item.ownDate ?? date }] }
        : {}),
    };
    insert.run(
      id,
      id,
      item.text,
      `hash-${index}`,
      JSON.stringify(metadata),
      date,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    link.run(id, "self", item.own !== undefined ? "sender" : "recipient");
    if (item.peer) link.run(id, item.peer, "sender");
  });
  while (true) {
    const docs = fetchTranscriptionVocabularyBatch(db, settings);
    if (!docs.length) break;
    const result = applyTranscriptionVocabularyBatch(
      db,
      extractTranscriptionVocabulary(docs, settings),
    );
    expect(result.skipped).toBe(0);
    expect(result.remaining).toEqual([]);
  }
  return db;
}

function measure(db: Db, targets: string[], context: Partial<TranscriptionContext> = {}) {
  const dictionary = getTranscriptionVocabulary(
    db,
    { purpose: "dictation", recordedAt: NOW, ...context },
    settings,
  );
  const packed = (budget: number) =>
    adaptTranscriptionVocabulary(dictionary, { runtime: "smart-whisper", maxPromptTokens: budget })
      ?.initial_prompt ?? "";
  const contains = (text: string, target: string) =>
    text
      .normalize("NFC")
      .toLocaleLowerCase("und")
      .split(", ")
      .some((phrase) => phrase === target.toLocaleLowerCase("und"));
  const coverage = (prompt: string) => targets.filter((target) => contains(prompt, target)).length;
  const prompt = packed(96);
  const small = packed(32);
  expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(96);
  expect(Buffer.byteLength(small, "utf8")).toBeLessThanOrEqual(32);
  expect(coverage(prompt)).toBeGreaterThanOrEqual(coverage(small));
  return { dictionary, prompt, small, coverage: coverage(prompt), smallCoverage: coverage(small) };
}

const own = (text: string, count = 2, date = RECENT): History[] =>
  Array.from({ length: count }, () => ({ text, own: text, date }));

// These checks measure selection and prompt coverage, not acoustic recognition.
// They exercise the public pipeline with no language-model inference or score
// formula assertions. Small and standard budgets reveal packing losses.
describe("history-only vocabulary relevance in crowded independent scenarios", () => {
  test.each([
    { language: "en", target: "novaLyth", utterance: "Please review novaLyth tomorrow." },
    { language: "fr", target: "éloraVex", utterance: "On reparle de éloraVex demain." },
  ])(
    "$language: recent own vocabulary survives old received distractions",
    ({ target, utterance }) => {
      expect(utterance).toContain(target);
      const db = materialize([
        ...crowdedHistory(),
        ...Array.from({ length: 10 }, () => ({ text: "chronoMira", date: OLD })),
        ...own(target),
      ]);
      const result = measure(db, [target]);
      expect(result.coverage).toBe(1);
      expect(result.prompt.indexOf(target)).toBeLessThan(
        result.prompt.indexOf("chronoMira") < 0 ? Infinity : result.prompt.indexOf("chronoMira"),
      );
    },
  );

  test("genuine repeated entities survive automated and bulk prose", () => {
    // More than one candidate-stream page of eligible machine terms must not
    // exclude a genuine entity before the final score or recognizer budget.
    const machineHistory: History[] = [];
    for (let group = 0; group < 3; group++) {
      const text = Array.from(
        { length: 64 },
        (_, index) =>
          `distrax${String.fromCharCode(97 + group)}${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}vex`,
      ).join("; ");
      for (let copy = 0; copy < 20; copy++)
        machineHistory.push({
          text: text + "; ARCHIVE; UNSUBSCRIBE; TEMPLATE",
          automated: copy % 2 === 0,
          bulk: copy % 2 === 1,
        });
    }
    const db = materialize([
      ...machineHistory,
      { text: "soraNuvex", date: "2026-09-20T12:00:00.000Z" },
      { text: "soraNuvex", date: "2026-09-21T12:00:00.000Z" },
    ]);
    const result = measure(db, ["soraNuvex"]);
    expect(result.coverage).toBe(1);
    expect(result.dictionary.entries[0]?.text).toBe("soraNuvex");
    // Discounting changes relevance rather than banning every machine term.
    // A zero policy is the explicit exclusion control; spare prompt space at
    // the default weight may still contain low-ranked machine-only evidence.
    const excluded = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: NOW },
      { ...settings, machineEvidenceWeight: 0 },
    );
    expect(excluded.entries.map((entry) => entry.text)).toEqual(["soraNuvex"]);
  });

  test("one renewed mention does not make a long-obsolete topic dominate current own wording", () => {
    const db = materialize([
      ...crowdedHistory(),
      ...own("paleoVurn", 8, OLD),
      ...own("paleoVurn", 1),
      ...own("liraQuent", 3),
    ]);
    const result = measure(db, ["liraQuent"]);
    expect(result.coverage).toBe(1);
    const words = result.dictionary.entries.map((entry) => entry.text);
    expect(words.indexOf("liraQuent")).toBeLessThan(words.indexOf("paleoVurn"));
  });

  test("spelling preserves a genuine brand while isolated corrupted casing loses its vote", () => {
    const db = materialize([
      ...crowdedHistory(),
      ...own("Zilquorin; velaNuv", 3),
      ...own("zIlQuOrIn; Velanuv", 1),
    ]);
    const result = measure(db, ["Zilquorin", "velaNuv"]);
    expect(result.coverage).toBe(2);
    expect(result.prompt).toContain("Zilquorin");
    expect(result.prompt).toContain("velaNuv");
    expect(result.prompt).not.toContain("zIlQuOrIn");
  });

  test("switching speakers changes useful vocabulary across sparse and dense cohorts", () => {
    const db = materialize([
      ...crowdedHistory(),
      ...Array.from({ length: 3 }, () => ({
        text: "noraVelt",
        peer: "north" as const,
        thread: "north-thread",
      })),
      ...Array.from({ length: 12 }, () => ({
        text: crowd + "; solQuent",
        peer: "south" as const,
        thread: "south-thread",
      })),
    ]);
    for (const [peer, target] of [
      ["north", "noraVelt"],
      ["south", "solQuent"],
    ] as const) {
      const result = measure(db, [target], {
        purpose: "source-audio",
        speaker: { personId: peer },
        conversation: { sourceId: SourceId("fictional:quality"), threadId: `${peer}-thread` },
      });
      expect(result.coverage).toBe(1);
      expect(result.smallCoverage).toBe(1);
    }
  });

  test("unknown authorship retains corroborated fallback without introducing presentation artifacts", () => {
    const db = materialize([
      ...crowdedHistory(),
      ...Array.from({ length: 3 }, () => ({
        text: "# Quality record\n\n**Origin:** Headerquorin\n**Destination:** Recipientquorin\n\n---\n\nVoraquint\n\n> Quotedquorin\n\n```\nFencedquorin\n```",
      })),
    ]);
    const result = measure(db, ["Voraquint"]);
    expect(result.coverage).toBe(1);
    expect(result.prompt).not.toMatch(/Headerquorin|Recipientquorin|Quotedquorin|Fencedquorin/);
    // An unrelated ordinary future utterance has no expected vocabulary terms;
    // the dictionary may still exist, but it must contain no leaked artifacts.
    expect(measure(db, []).coverage).toBe(0);
  });
});
