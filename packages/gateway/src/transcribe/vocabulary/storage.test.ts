// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createTranscriptionVocabularyTables,
  installTranscriptionVocabulary,
  fetchTranscriptionVocabularyBatch,
  applyTranscriptionVocabularyBatch,
  getTranscriptionVocabulary,
} from "./storage.js";
import { extractTranscriptionVocabulary } from "./extract.js";
import type { Db } from "../../data/types.js";
import type {
  VocabularySettings,
  ExtractedVocabularyDocument,
  VocabularyDocument,
} from "./types.js";

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
function insert(
  db: Db,
  id: string,
  content = "Discuss Quorvex and Nimbrax",
  sourceId = "fictional:messages",
): void {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
    VALUES (?,'fictional',?,?,?,?,'hash','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(id, sourceId, id, "", content);
}
function extracted(
  id: string,
  terms: string[],
  scopeKey = "",
  kind: "global" | "person" | "conversation" | "self" = "global",
): ExtractedVocabularyDocument {
  return {
    id,
    contentHash: "hash",
    updatedAt: "2026-01-01",
    revision: 0,
    generation: 1,
    scopes: [{ kind, key: scopeKey }],
    recordedAt: "2026-01-01",
    terms: terms.map((text) => ({ term: text.toLowerCase(), text, benefit: 3 })),
  };
}
function count(db: Db): number {
  return (
    db.prepare("SELECT sum(document_count) AS n FROM transcription_vocabulary_terms").get() as {
      n: number;
    }
  ).n;
}

describe("vocabulary materialization", () => {
  test("transcribed metadata cannot consume the verified written evidence budget", () => {
    const db = database();
    insert(db, "mixed-origins", "");
    db.prepare("UPDATE documents SET metadata=? WHERE id='mixed-origins'").run(
      JSON.stringify({
        selfAuthoredText: [
          { origin: "transcription", text: "Nimbrax ".repeat(4096), recordedAt: "2026-10-01" },
          { text: "Orvelion", recordedAt: "2026-10-01" },
          { origin: "written", text: "Quorvex", recordedAt: "2026-01-01" },
        ],
      }),
    );
    const batch = fetchTranscriptionVocabularyBatch(db, settings);
    expect(
      extractTranscriptionVocabulary(batch, settings)[0].selfTerms?.map((term) => term.text),
    ).toEqual(["Quorvex"]);
  });
  test("fetched input preserves enough boundary evidence to omit a cut word", () => {
    const db = database();
    insert(db, "cut-run", "Orvelion QuorvexNimbrax");
    const capped = { ...settings, maxDocumentChars: 14 };
    const batch = fetchTranscriptionVocabularyBatch(db, capped);
    expect(batch[0].content.length).toBeGreaterThan(capped.maxDocumentChars);
    expect(extractTranscriptionVocabulary(batch, capped)[0].terms.map((term) => term.text)).toEqual(
      ["Orvelion"],
    );
  });
  test("generic transcription provenance excludes attachment text and respects written projections", () => {
    const db = database();
    for (const [id, metadata] of [
      ["asr-child", { extra: { transcribed: true } }],
      ["mixed-projection", { vocabularyText: "Orvelion" }],
      ["untrusted-marker", { extra: { transcribed: "true" }, vocabularyText: 42 }],
    ] as const) {
      insert(db, id, "Nimbrax");
      db.prepare("UPDATE documents SET metadata=? WHERE id=?").run(JSON.stringify(metadata), id);
    }
    const batch = fetchTranscriptionVocabularyBatch(db, settings);
    const terms = new Map(
      extractTranscriptionVocabulary(batch, settings).map((doc) => [
        doc.id,
        doc.terms.map((term) => term.text),
      ]),
    );
    expect(terms.get("asr-child")).toEqual([]);
    expect(terms.get("mixed-projection")).toEqual(["Orvelion"]);
    expect(terms.get("untrusted-marker")).toEqual(["Nimbrax"]);
    expect(fetchTranscriptionVocabularyBatch(db, { ...settings, enabled: false })).toEqual([]);
    expect(db.prepare("SELECT content FROM documents WHERE id='asr-child'").get()).toEqual({
      content: "Nimbrax",
    });
  });
  test("the contribution ledger stores its deduplication key in a single tree", () => {
    const db = database();
    expect(
      db
        .prepare(
          "SELECT wr FROM pragma_table_list WHERE name='transcription_vocabulary_document_terms'",
        )
        .get(),
    ).toEqual({ wr: 1 });
    insert(db, "compact-ledger");
    const batch = [extracted("compact-ledger", ["Orvelion", "Rulthena"])];
    applyTranscriptionVocabularyBatch(db, batch);
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='compact-ledger'").run();
    applyTranscriptionVocabularyBatch(db, batch);
    expect(count(db)).toBe(2);
    expect(
      db.prepare("SELECT count(*) AS n FROM transcription_vocabulary_document_terms").get(),
    ).toEqual({ n: 2 });
  });

  test("schema setup preserves usable contribution ledgers with the rowid layout", () => {
    const db = database();
    db.exec(`
      DROP TABLE transcription_vocabulary_document_terms;
      CREATE TABLE transcription_vocabulary_document_terms (
        document_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        term TEXT NOT NULL,
        PRIMARY KEY (document_id, scope_kind, scope_key, term)
      );
    `);
    createTranscriptionVocabularyTables(db);
    insert(db, "existing-ledger");
    const batch = [extracted("existing-ledger", ["Orvelion"])];
    applyTranscriptionVocabularyBatch(db, batch);
    createTranscriptionVocabularyTables(db);
    createTranscriptionVocabularyTables(db);
    expect(
      db
        .prepare(
          "SELECT wr FROM pragma_table_list WHERE name='transcription_vocabulary_document_terms'",
        )
        .get(),
    ).toEqual({ wr: 0 });
    db.prepare(
      "UPDATE documents SET vocabulary_processed_at=NULL WHERE id='existing-ledger'",
    ).run();
    applyTranscriptionVocabularyBatch(db, batch);
    expect(count(db)).toBe(1);
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map(
        (entry) => entry.text,
      ),
    ).toEqual([]);
  });

  test("schema setup installs the indexed recent stream on existing vocabulary tables", () => {
    const db = database();
    db.exec("DROP INDEX idx_transcription_vocabulary_recent");
    createTranscriptionVocabularyTables(db);
    createTranscriptionVocabularyTables(db);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT term FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_recent WHERE scope_kind='person' AND scope_key='recent-speaker' ORDER BY last_seen DESC,term LIMIT 128",
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "idx_transcription_vocabulary_recent",
    );
    expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  });

  test("recent relationship terms survive frequency crowding without losing frequent terms", () => {
    const db = database();
    db.prepare(
      "INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at) VALUES ('recent-speaker','Orvella','fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
    ).run();
    const seed = db.prepare(
      "INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen) VALUES (?,?,?,?,?,3,?,?)",
    );
    for (const [kind, key] of [
      ["global", ""],
      ["person", "recent-speaker"],
    ]) {
      for (let i = 0; i < 200; i++) {
        const text = `Dormant${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`;
        const count = i === 189 ? 10000 : 100;
        seed.run(kind, key, text.toLowerCase(), text, count, 3 * Math.log1p(count), "2010-01-01");
      }
      seed.run(kind, key, "umbriolet", "Umbriolet", 2, 3 * Math.log1p(2), "2026-01-01");
    }
    const result = getTranscriptionVocabulary(
      db,
      {
        purpose: "source-audio",
        speaker: { personId: "recent-speaker" },
        recordedAt: "2026-01-01",
      },
      settings,
    );
    expect(result.entries.map((entry) => entry.text)).toContain("Umbriolet");
    expect(result.entries.map((entry) => entry.text)).toContain("Dormanthh");
    expect(result.entries).toHaveLength(settings.maxTerms);
    // Both profiles contribute, while each profile's two streams count once.
    const rarity = 0.5 + 0.5 / (1 + Math.log1p(2));
    const expected = 3 * Math.log1p(2) * rarity * (1 + 3 * 1.5);
    expect(result.entries.find((entry) => entry.text === "Umbriolet")?.score).toBeCloseTo(
      expected,
      10,
    );
  });

  test("overlapping frequency and recent streams do not double a profile score", () => {
    const db = database();
    insert(db, "single-profile");
    insert(db, "second-profile");
    applyTranscriptionVocabularyBatch(db, [
      extracted("single-profile", ["Orvelion"]),
      extracted("second-profile", ["Orvelion"]),
    ]);
    const result = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      settings,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].score).toBeCloseTo(
      3 * Math.log1p(2) * (0.5 + 0.5 / (1 + Math.log1p(2))),
      10,
    );
  });

  test("singleton noise cannot crowd corroborated terms out of bounded lookup", () => {
    const db = database();
    for (let i = 0; i < 300; i++) {
      const id = `noise-${i}`;
      insert(db, id);
      const doc = extracted(id, [`Anoise${i}`]);
      doc.terms[0].benefit = 2.5;
      applyTranscriptionVocabularyBatch(db, [doc]);
    }
    for (const id of ["support-a", "support-b"]) {
      insert(db, id);
      const doc = extracted(id, ["Zeralith"]);
      doc.terms[0].benefit = 1;
      applyTranscriptionVocabularyBatch(db, [doc]);
    }
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map((e) => e.text),
    ).toEqual(["Zeralith"]);
  });

  test("indexed pending fetch bounds text; resolved people are required", () => {
    const db = database();
    insert(db, "ready", "Q".repeat(1000));
    insert(db, "unresolved");
    db.prepare("UPDATE documents SET people_resolved_at=NULL WHERE id='unresolved'").run();
    const docs = fetchTranscriptionVocabularyBatch(db, { ...settings, maxDocumentChars: 32 });
    expect(docs.map((d) => d.id)).toEqual(["ready"]);
    // Two UTF-16 units of lookahead let extraction discard a truncated lexical run.
    expect(docs[0].content).toHaveLength(34);
    expect(
      extractTranscriptionVocabulary(docs, { ...settings, maxDocumentChars: 32 })[0].terms,
    ).toEqual([]);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM documents INDEXED BY idx_documents_vocabulary_pending WHERE vocabulary_processed_at IS NULL AND people_resolved_at IS NOT NULL ORDER BY id LIMIT 4",
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_documents_vocabulary_pending");
    expect(fetchTranscriptionVocabularyBatch(db, { ...settings, enabled: false })).toEqual([]);
  });
  test("generic conversationId matches source-audio context and long identifiers", () => {
    const db = database();
    insert(db, "conversation");
    insert(db, "conversation-second");
    const threadId = "fictional-thread-" + "q".repeat(700);
    db.prepare(
      "UPDATE documents SET metadata=? WHERE id IN ('conversation','conversation-second')",
    ).run(JSON.stringify({ extra: { conversationId: threadId } }));
    const docs = fetchTranscriptionVocabularyBatch(db, settings);
    expect(docs[0].threadId).toBe(threadId);
    applyTranscriptionVocabularyBatch(db, extractTranscriptionVocabulary(docs, settings));
    expect(
      getTranscriptionVocabulary(
        db,
        {
          purpose: "source-audio",
          conversation: { sourceId: SourceId("fictional:messages"), threadId },
        },
        settings,
      ).entries.map((entry) => entry.text),
    ).toContain("Quorvex");
  });
  test("retries, additive updates and deletes preserve counts without inflation", () => {
    const db = database();
    insert(db, "one");
    const first = extracted("one", ["Quorvex"]);
    expect(applyTranscriptionVocabularyBatch(db, [first]).applied).toBe(1);
    expect(applyTranscriptionVocabularyBatch(db, [first]).skipped).toBe(1);
    expect(count(db)).toBe(1);
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='one'").run();
    applyTranscriptionVocabularyBatch(db, [extracted("one", ["Quorvex", "Nimbrax"])]);
    expect(count(db)).toBe(2);
    db.prepare("DELETE FROM documents WHERE id='one'").run();
    expect(count(db)).toBe(2);
  });
  test("preempted chunk commits bounded progress and resumes before stamping", () => {
    const db = database();
    insert(db, "many");
    const doc = extracted(
      "many",
      Array.from({ length: 90 }, (_, i) => `Quorvex${i}`),
    );
    const first = applyTranscriptionVocabularyBatch(db, [doc], { requested: () => true });
    expect(count(db)).toBe(32);
    expect(first.remaining[0].applyOffset).toBe(32);
    expect(
      (
        db
          .prepare("SELECT vocabulary_processed_at AS stamp FROM documents WHERE id='many'")
          .get() as { stamp: string | null }
      ).stamp,
    ).toBeNull();
    const second = applyTranscriptionVocabularyBatch(db, first.remaining);
    expect(second.applied).toBe(1);
    expect(count(db)).toBe(90);
    expect(fetchTranscriptionVocabularyBatch(db, settings)).toEqual([]);
  });
  test("content changed between IO and apply cannot mark stale extraction complete", () => {
    const db = database();
    insert(db, "race");
    db.prepare("UPDATE documents SET content_hash='changed' WHERE id='race'").run();
    expect(applyTranscriptionVocabularyBatch(db, [extracted("race", ["Quorvex"])]).skipped).toBe(1);
    expect(fetchTranscriptionVocabularyBatch(db, settings)).toHaveLength(1);
  });
  test("same-timestamp metadata revision invalidates a partially applied batch", () => {
    const db = database();
    insert(db, "revision-race");
    const terms = Array.from({ length: 80 }, (_, i) => `Quorvex${i}`);
    const partial = applyTranscriptionVocabularyBatch(db, [extracted("revision-race", terms)], {
      requested: () => true,
    });
    db.prepare("UPDATE documents SET vocabulary_revision=1 WHERE id='revision-race'").run();
    expect(applyTranscriptionVocabularyBatch(db, partial.remaining).skipped).toBe(1);
    expect(fetchTranscriptionVocabularyBatch(db, settings)[0].revision).toBe(1);
  });
  test("fresh schema and old document tables install idempotently", () => {
    const db = database();
    installTranscriptionVocabulary(db);
    installTranscriptionVocabulary(db);
    expect(fetchTranscriptionVocabularyBatch(db, settings)).toEqual([]);
    const old = new Database(":memory:");
    databases.push(old);
    old.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,people_resolved_at TEXT)");
    installTranscriptionVocabulary(old);
    installTranscriptionVocabulary(old);
    expect(
      (
        old
          .prepare(
            "SELECT name FROM pragma_table_info('documents') WHERE name='vocabulary_processed_at'",
          )
          .get() as { name: string }
      ).name,
    ).toBe("vocabulary_processed_at");
  });
});

describe("source-declared automation confidence", () => {
  function observe(db: Db, id: string, text: string, automatedEvidence: boolean): void {
    insert(db, id, text);
    applyTranscriptionVocabularyBatch(db, [{ ...extracted(id, [text]), automatedEvidence }]);
  }
  function replay(db: Db, doc: ExtractedVocabularyDocument): void {
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id=?").run(doc.id);
    applyTranscriptionVocabularyBatch(db, [doc]);
  }
  function support(db: Db, term: string): unknown {
    return db
      .prepare(
        `SELECT document_count,evidence_count,ordinary_document_count
      FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term=?`,
      )
      .get(term);
  }
  function entries(db: Db, overrides: Partial<VocabularySettings> = {}) {
    return getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      { ...settings, ...overrides },
    ).entries;
  }

  test("many automated repetitions rank below independently corroborated ordinary evidence", () => {
    const db = database();
    for (let index = 0; index < 80; index++) observe(db, `automated-${index}`, "Quorvex", true);
    observe(db, "ordinary-a", "Nimbrax", false);
    observe(db, "ordinary-b", "Nimbrax", false);
    expect(entries(db).map((entry) => entry.text)).toEqual(["Nimbrax", "Quorvex"]);
    expect(entries(db, { machineEvidenceWeight: 1 })[0].text).toBe("Quorvex");
  });

  test("the bounded corroborated stream protects ordinary terms from automated candidate crowding", () => {
    const db = database();
    const noise = Array.from({ length: 140 }, (_, index) => `Quorvex${index}`);
    for (const suffix of ["a", "b", "c"]) {
      // Each extraction page is limited to 128 candidates, so use two pages.
      for (const [page, terms] of [noise.slice(0, 128), noise.slice(128)].entries()) {
        const id = `machine-${suffix}-${page}`;
        insert(db, id);
        applyTranscriptionVocabularyBatch(db, [
          { ...extracted(id, terms), automatedEvidence: true },
        ]);
      }
    }
    for (const suffix of ["a", "b"]) {
      const id = `ordinary-${suffix}`;
      insert(db, id);
      applyTranscriptionVocabularyBatch(db, [
        {
          ...extracted(id, ["Zorvella"]),
          automatedEvidence: false,
          recordedAt: "2025-12-31",
        },
      ]);
    }
    expect(entries(db, { maxTerms: 1 }).map((entry) => entry.text)).toEqual(["Zorvella"]);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT term FROM transcription_vocabulary_terms
      WHERE scope_kind='global' AND scope_key='' AND ordinary_document_count>=2
      ORDER BY ordinary_document_count DESC,term LIMIT 128`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "idx_transcription_vocabulary_ordinary",
    );
    expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  });

  test("two distinct unmarked documents restore confidence without replay manufacturing support", () => {
    const db = database();
    observe(db, "marked-a", "Quorvex", true);
    observe(db, "marked-b", "Quorvex", true);
    observe(db, "ordinary-a", "Quorvex", false);
    const doc = { ...extracted("ordinary-a", ["Quorvex"]), automatedEvidence: false };
    replay(db, doc);
    replay(db, doc);
    expect(support(db, "quorvex")).toEqual({
      document_count: 3,
      evidence_count: 3,
      ordinary_document_count: 1,
    });
    expect(entries(db, { machineEvidenceWeight: 0 })).toEqual([]);
    observe(db, "ordinary-b", "Quorvex", false);
    expect(support(db, "quorvex")).toEqual({
      document_count: 4,
      evidence_count: 4,
      ordinary_document_count: 2,
    });
    expect(entries(db, { machineEvidenceWeight: 0 }).map((entry) => entry.text)).toEqual([
      "Quorvex",
    ]);
  });

  test("classification corrections update confidence without duplicating document or spelling votes", () => {
    const db = database();
    observe(db, "marked-a", "Quorvex", true);
    observe(db, "marked-b", "Quorvex", true);
    const corrected = { ...extracted("marked-a", ["Quorvex"]), automatedEvidence: false };
    replay(db, corrected);
    replay(db, corrected);
    expect(support(db, "quorvex")).toEqual({
      document_count: 2,
      evidence_count: 2,
      ordinary_document_count: 1,
    });
    corrected.automatedEvidence = true;
    replay(db, corrected);
    replay(db, corrected);
    expect(support(db, "quorvex")).toEqual({
      document_count: 2,
      evidence_count: 2,
      ordinary_document_count: 0,
    });
    expect(
      db
        .prepare(
          `SELECT document_count FROM transcription_vocabulary_spellings
      WHERE scope_kind='global' AND term='quorvex'`,
        )
        .get(),
    ).toEqual({ document_count: 2 });
  });

  test("unknown legacy support remains usable until classified evidence arrives", () => {
    const db = database();
    observe(db, "legacy-a", "Quorvex", true);
    observe(db, "legacy-b", "Quorvex", true);
    db.prepare(
      `UPDATE transcription_vocabulary_terms SET evidence_count=0,ordinary_document_count=0,spelling_count=0`,
    ).run();
    db.prepare(
      `UPDATE transcription_vocabulary_document_terms SET observed_text=NULL,observed_automated=NULL`,
    ).run();
    db.prepare("DELETE FROM transcription_vocabulary_spellings").run();
    expect(entries(db, { machineEvidenceWeight: 0 }).map((entry) => entry.text)).toEqual([
      "Quorvex",
    ]);
    replay(db, { ...extracted("legacy-a", ["Quorvex"]), automatedEvidence: true });
    expect(support(db, "quorvex")).toEqual({
      document_count: 2,
      evidence_count: 1,
      ordinary_document_count: 0,
    });
    expect(entries(db, { machineEvidenceWeight: 0 })).toEqual([]);
  });

  test("verified own text retains confidence even when its document carries automation markers", () => {
    const db = database();
    for (const suffix of ["a", "b"]) {
      insert(db, `own-${suffix}`);
      applyTranscriptionVocabularyBatch(db, [
        {
          ...extracted(`own-${suffix}`, ["Quorvex"]),
          automatedEvidence: true,
          selfTerms: [{ term: "quorvex", text: "Quorvex", benefit: 3, recordedAt: "2026-01-01" }],
        },
      ]);
    }
    expect(entries(db, { machineEvidenceWeight: 0 }).map((entry) => entry.text)).toEqual([
      "Quorvex",
    ]);
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "source-audio", recordedAt: "2026-01-01" },
        { ...settings, machineEvidenceWeight: 0 },
      ).entries,
    ).toEqual([]);
  });

  test.each([
    [{ bulkMail: true }, true],
    [{ automatedSender: true }, true],
    [{ bulkMail: false, automatedSender: true }, true],
    [{ bulkMail: "true", automatedSender: 1 }, false],
    [{}, false],
  ])(
    "fetch recognizes only explicitly typed generic automation markers: %j",
    (metadata, automated) => {
      const db = database();
      insert(db, "marker");
      db.prepare("UPDATE documents SET metadata=? WHERE id='marker'").run(JSON.stringify(metadata));
      const docs = fetchTranscriptionVocabularyBatch(db, settings);
      expect(docs[0].automatedEvidence).toBe(automated);
      expect(extractTranscriptionVocabulary(docs, settings)[0].automatedEvidence).toBe(automated);
    },
  );
});

describe("authored vocabulary evidence", () => {
  function authored(db: Db, id: string, text: string, recordedAt: string): void {
    insert(db, id, text);
    const doc = extracted(id, []);
    doc.selfTerms = [{ term: text.toLowerCase(), text, benefit: 2, recordedAt }];
    applyTranscriptionVocabularyBatch(db, [doc]);
  }

  test("recent personally authored words outrank equally supported old words", () => {
    const db = database();
    for (const suffix of ["a", "b"]) {
      authored(db, `recent-${suffix}`, "Quorvex", "2026-01-01T00:00:00.000Z");
      authored(db, `old-${suffix}`, "Nimbrax", "2010-01-01T00:00:00.000Z");
    }
    const result = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      settings,
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["Quorvex", "Nimbrax"]);
    expect(result.entries[0].score).toBeGreaterThan(result.entries[1].score * 100);
  });

  test("one new use does not rejuvenate a lifetime of old personally authored support", () => {
    const db = database();
    for (let index = 0; index < 20; index++)
      authored(db, `history-${index}`, "Quorvex", "2010-01-01T00:00:00.000Z");
    authored(db, "history-new", "Quorvex", "2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 3; index++)
      authored(db, `current-${index}`, "Nimbrax", "2026-01-01T00:00:00.000Z");
    const mass = db
      .prepare(
        "SELECT document_count,recent_mass FROM transcription_vocabulary_terms WHERE scope_kind='self' AND term='quorvex'",
      )
      .get() as { document_count: number; recent_mass: number };
    expect(mass.document_count).toBe(21);
    expect(mass.recent_mass).toBeCloseTo(1, 6);
    const result = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      settings,
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["Nimbrax", "Quorvex"]);
    // Re-reading the new document cannot add a second recent vote.
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='history-new'").run();
    const replay = extracted("history-new", []);
    replay.selfTerms = [
      { term: "quorvex", text: "Quorvex", benefit: 2, recordedAt: "2026-01-01T00:00:00.000Z" },
    ];
    applyTranscriptionVocabularyBatch(db, [replay]);
    expect(
      db
        .prepare(
          "SELECT document_count,recent_mass FROM transcription_vocabulary_terms WHERE scope_kind='self' AND term='quorvex'",
        )
        .get(),
    ).toEqual(mass);
  });

  test("decayed support admits a current term even when lifetime and recent streams are crowded", () => {
    const db = database();
    const crowded = Array.from(
      { length: 130 },
      (_, index) => `Dormant${String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26))}`,
    );
    for (let page = 0; page < 2; page++) {
      const terms = crowded.slice(page * 65, (page + 1) * 65);
      for (let index = 0; index < 21; index++) {
        const id = `crowded-${page}-${index}`;
        insert(db, id);
        const doc = extracted(id, []);
        doc.selfTerms = terms.map((text) => ({
          term: text.toLowerCase(),
          text,
          benefit: 2,
          recordedAt: index === 20 ? "2026-01-01T00:00:00.000Z" : "2010-01-01T00:00:00.000Z",
        }));
        applyTranscriptionVocabularyBatch(db, [doc]);
      }
    }
    for (let index = 0; index < 3; index++)
      authored(db, `current-${index}`, "Nimbrax", "2025-12-31T00:00:00.000Z");
    // All 130 stale-history terms have a newer last_seen, but only one recent
    // vote apiece. The recent stream cannot admit this older, better-supported term.
    expect(
      db
        .prepare(
          "SELECT term FROM transcription_vocabulary_terms WHERE scope_kind='self' ORDER BY last_seen DESC,term LIMIT 128",
        )
        .all(),
    ).not.toContainEqual({ term: "nimbrax" });
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "dictation", recordedAt: "2026-01-01" },
        { ...settings, maxTerms: 1 },
      ).entries.map((entry) => entry.text),
    ).toEqual(["Nimbrax"]);
  });

  test("a recent received occurrence never refreshes the personally authored clock", () => {
    const db = database();
    for (const suffix of ["a", "b"])
      authored(db, `old-${suffix}`, "Quorvex", "2010-01-01T00:00:00.000Z");
    const ownBefore = db
      .prepare(
        "SELECT * FROM transcription_vocabulary_terms WHERE scope_kind='self' AND term='quorvex'",
      )
      .get();
    for (const suffix of ["a", "b"]) {
      const id = `received-${suffix}`;
      insert(db, id);
      const doc = extracted(id, ["Quorvex"]);
      doc.recordedAt = "2026-01-01T00:00:00.000Z";
      applyTranscriptionVocabularyBatch(db, [doc]);
    }
    expect(
      db
        .prepare(
          "SELECT * FROM transcription_vocabulary_terms WHERE scope_kind='self' AND term='quorvex'",
        )
        .get(),
    ).toEqual(ownBefore);
    expect(
      db
        .prepare(
          "SELECT last_seen FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='quorvex'",
        )
        .get(),
    ).toEqual({ last_seen: "2026-01-01T00:00:00.000Z" });
  });

  test("another source-audio speaker never receives the operator's authored bonus", () => {
    const db = database();
    db.prepare(
      `INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
      VALUES ('self','You','fictional',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01'),
      ('speaker','Maya Reeves','fictional',0,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run();
    authored(db, "own-a", "Quorvex", "2026-01-01");
    authored(db, "own-b", "Quorvex", "2026-01-01");
    expect(
      getTranscriptionVocabulary(
        db,
        {
          purpose: "source-audio",
          speaker: { personId: "speaker" },
          participants: [{ isSelf: true }],
          recordedAt: "2026-01-01",
        },
        settings,
      ).entries,
    ).toEqual([]);
    for (const speaker of [{ isSelf: true }, { personId: "self" }])
      expect(
        getTranscriptionVocabulary(
          db,
          { purpose: "source-audio", speaker, recordedAt: "2026-01-01" },
          settings,
        ).entries.map((entry) => entry.text),
      ).toEqual(["Quorvex"]);
  });

  test("zero authored weight excludes authored-only terms rather than emitting zero-score hints", () => {
    const db = database();
    authored(db, "own-a", "Quorvex", "2026-01-01");
    authored(db, "own-b", "Quorvex", "2026-01-01");
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "dictation", recordedAt: "2026-01-01" },
        { ...settings, authoredWeight: 0 },
      ).entries,
    ).toEqual([]);
  });

  test("stronger same-spelling evidence upgrades benefit without adding a document vote", () => {
    const db = database();
    insert(db, "grounded-a");
    insert(db, "grounded-b");
    const ordinary = extracted("grounded-a", ["Quorvex"]);
    ordinary.terms[0].benefit = 2;
    applyTranscriptionVocabularyBatch(db, [ordinary, { ...ordinary, id: "grounded-b" }]);
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='grounded-a'").run();
    const grounded = extracted("grounded-a", ["Quorvex"]);
    grounded.terms[0].benefit = 3;
    applyTranscriptionVocabularyBatch(db, [grounded]);
    expect(
      db
        .prepare(
          "SELECT text,document_count,benefit FROM transcription_vocabulary_terms WHERE scope_kind='global'",
        )
        .get(),
    ).toEqual({ text: "Quorvex", document_count: 2, benefit: 3 });
    expect(
      db
        .prepare(
          "SELECT document_count,benefit FROM transcription_vocabulary_spellings WHERE scope_kind='global'",
        )
        .get(),
    ).toEqual({ document_count: 2, benefit: 3 });
  });

  test("authored singleton support and replays retain the two-document requirement", () => {
    const db = database();
    authored(db, "own-a", "Quorvex", "2026-01-01");
    expect(getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries).toEqual([]);
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='own-a'").run();
    const replay = extracted("own-a", []);
    replay.selfTerms = [{ term: "quorvex", text: "Quorvex", benefit: 2, recordedAt: "2026-01-01" }];
    applyTranscriptionVocabularyBatch(db, [replay]);
    expect(
      db
        .prepare(
          "SELECT document_count FROM transcription_vocabulary_terms WHERE scope_kind='self'",
        )
        .get(),
    ).toEqual({ document_count: 1 });
    expect(
      db
        .prepare(
          "SELECT document_count FROM transcription_vocabulary_spellings WHERE scope_kind='self'",
        )
        .get(),
    ).toEqual({ document_count: 1 });
    authored(db, "own-b", "Quorvex", "2026-01-01");
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "agent", recordedAt: "2026-01-01" },
        settings,
      ).entries.map((entry) => entry.text),
    ).toEqual(["Quorvex"]);
  });

  test.each([
    null,
    "untrusted",
    42,
    {},
    [{ text: "Quorvex", recordedAt: "not-a-date" }],
    [{ text: 42, recordedAt: "2026-01-01" }],
    [{ text: "x".repeat(140000), recordedAt: "2026-01-01" }],
  ])("malformed or truncated authored metadata supplies no evidence: %j", (selfAuthoredText) => {
    const db = database();
    insert(db, "malformed");
    db.prepare("UPDATE documents SET metadata=? WHERE id='malformed'").run(
      JSON.stringify({ selfAuthoredText }),
    );
    const docs = fetchTranscriptionVocabularyBatch(db, settings);
    expect(docs[0].selfAuthoredText).toEqual([]);
    const extracted = extractTranscriptionVocabulary(docs, settings);
    expect(extracted[0].selfTerms ?? []).toEqual([]);
  });

  test("clean spelling wins by distinct-document support and spelling updates never inflate counts", () => {
    const db = database();
    for (const [id, text] of [
      ["clean-a", "quorvex"],
      ["clean-b", "quorvex"],
      ["clean-c", "quorvex"],
      ["mixed", "quorVex"],
    ]) {
      insert(db, id);
      const doc = extracted(id, [text]);
      doc.terms[0].benefit = text === "quorvex" ? 1 : 2.5;
      applyTranscriptionVocabularyBatch(db, [doc]);
    }
    const row = () =>
      db
        .prepare(
          "SELECT text,document_count,benefit FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='quorvex'",
        )
        .get();
    expect(row()).toEqual({ text: "quorvex", document_count: 4, benefit: 1 });
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='mixed'").run();
    applyTranscriptionVocabularyBatch(db, [extracted("mixed", ["quorVex"])]);
    expect(row()).toEqual({ text: "quorvex", document_count: 4, benefit: 1 });
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='mixed'").run();
    const corrected = extracted("mixed", ["quorvex"]);
    corrected.terms[0].benefit = 1;
    applyTranscriptionVocabularyBatch(db, [corrected]);
    expect(row()).toEqual({ text: "quorvex", document_count: 4, benefit: 1 });
    expect(
      db
        .prepare(
          "SELECT text,document_count FROM transcription_vocabulary_spellings WHERE scope_kind='global'",
        )
        .all(),
    ).toEqual([{ text: "quorvex", document_count: 4 }]);
  });
});

describe("context dictionary", () => {
  test.each([0, 2])("retained frequent words are excluded with %i fresh observations", (fresh) => {
    const db = database();
    const seed = db.prepare(
      `INSERT INTO transcription_vocabulary_terms
      (scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen,evidence_count)
      VALUES ('global','',?,?,2,2.5,3,'2026-01-01',?)`,
    );
    for (const text of ["c’est", "c'est", "l'été", "the"]) seed.run(text, text, fresh);
    const [evidence] = extractTranscriptionVocabulary(
      [
        {
          id: "fictional-name-evidence",
          contentHash: "hash",
          updatedAt: "2026-01-01",
          revision: 0,
          generation: 1,
          title: "",
          content: "Will Green explores l'umbriolet",
          sourceId: "fictional:messages",
          threadId: null,
          recordedAt: "2026-01-01",
          people: [
            { personId: "fictional-person", name: "Will Green", isSelf: false, role: "sender" },
          ],
        },
      ],
      settings,
    );
    expect(evidence!.terms.map((term) => term.text)).toContain("Will Green");
    expect(evidence!.terms.map((term) => term.text)).toContain("l'umbriolet");
    for (const text of ["Will Green", "l'umbriolet"]) seed.run(text.toLowerCase(), text, fresh);
    const entries = getTranscriptionVocabulary(
      db,
      { purpose: "source-audio", recordedAt: "2026-01-01" },
      settings,
    ).entries.map((entry) => entry.text);
    expect(entries).toEqual(expect.arrayContaining(["Will Green", "l'umbriolet"]));
    expect(entries).toHaveLength(2);
  });

  test("trusted identity hints work without corpus counts and stay behind both gates", () => {
    const db = database();
    db.prepare(
      `INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
      VALUES ('self','You','fictional',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases(id,person_id,alias,alias_type,source_id,created_at,occurrence_count)
      VALUES ('trusted','self','Maya Reeves','name','fictional:contacts','2026-01-01',1000000)`,
    ).run();
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map((e) => e.text),
    ).toEqual(["Maya Reeves"]);
    expect(
      getTranscriptionVocabulary(db, { purpose: "agent" }, settings).entries.map((e) => e.text),
    ).toEqual(["Maya Reeves"]);
    expect(getTranscriptionVocabulary(db, { purpose: "source-audio" }, settings).entries).toEqual(
      [],
    );
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "source-audio", participants: [{ isSelf: true }] },
        settings,
      ).entries.map((e) => e.text),
    ).toEqual(["Maya Reeves"]);
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, { ...settings, enabled: false })
        .entries,
    ).toEqual([]);
    db.prepare(
      `INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at)
      VALUES ('speaker','Jamie Lopez','fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01'),
      ('participant','Sarah Mendez','fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases(id,person_id,alias,alias_type,created_at,occurrence_count)
      VALUES ('speaker-name','speaker','Jamie Lopez','name','2026-01-01',1000000),
      ('participant-name','participant','Sarah Mendez','name','2026-01-01',1000000)`,
    ).run();
    expect(
      getTranscriptionVocabulary(
        db,
        {
          purpose: "source-audio",
          speaker: { personId: "speaker" },
          participants: [{ isSelf: true }, { personId: "participant" }],
        },
        settings,
      ).entries.map((e) => e.text),
    ).toEqual(["Maya Reeves", "Jamie Lopez"]);
    expect(
      getTranscriptionVocabulary(
        db,
        {
          purpose: "source-audio",
          speaker: { personId: "self" },
        },
        settings,
      ).entries.map((e) => e.text),
    ).toEqual(["Maya Reeves"]);
    db.prepare("UPDATE transcription_vocabulary_state SET phase='terms'").run();
    expect(getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries).toEqual([]);
  });

  test("conversation and linked cross-platform person vocabulary outrank global", () => {
    const db = database();
    insert(db, "global");
    insert(db, "person");
    insert(db, "thread");
    db.prepare(
      `INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at) VALUES ('canonical','Maya Reeves','fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases(id,person_id,alias_type,alias,source_id,created_at) VALUES ('alias','canonical','email','maya@example.com',NULL,'2026-01-01')`,
    ).run();
    applyTranscriptionVocabularyBatch(db, [
      extracted("global", ["Globularix"]),
      extracted("person", ["Nimbrax"], "canonical", "person"),
      extracted(
        "thread",
        ["Quorvex"],
        JSON.stringify(["fictional:messages", "thread"]),
        "conversation",
      ),
    ]);
    for (const [id, text, key, kind] of [
      ["global-second", "Globularix", "", "global"],
      ["person-second", "Nimbrax", "canonical", "person"],
      [
        "thread-second",
        "Quorvex",
        JSON.stringify(["fictional:messages", "thread"]),
        "conversation",
      ],
    ] as const) {
      insert(db, id);
      applyTranscriptionVocabularyBatch(db, [extracted(id, [text], key, kind)]);
    }
    const result = getTranscriptionVocabulary(
      db,
      {
        purpose: "source-audio",
        speaker: { identifiers: [{ kind: "email", value: "maya@example.com" }] },
        conversation: { sourceId: SourceId("fictional:messages"), threadId: "thread" },
      },
      { ...settings, maxTerms: 3 },
    );
    expect(result.entries.map((entry) => entry.text)).toEqual(["Quorvex", "Nimbrax", "Globularix"]);
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, { ...settings, enabled: false }),
    ).toEqual({ entries: [] });
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT term FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_rank WHERE scope_kind='person' AND scope_key='canonical' ORDER BY base_score DESC,term LIMIT 128",
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_transcription_vocabulary_rank");
    expect(plan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE");
  });
  test("canonical merge resolves historical person vocabulary", () => {
    const db = database();
    insert(db, "historic");
    insert(db, "historic-second");
    const person = db.prepare(
      "INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at,merged_into) VALUES (?,?,'fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01',?)",
    );
    person.run("winner", "Maya Reeves", null);
    person.run("loser", "Maya Reeves", "winner");
    applyTranscriptionVocabularyBatch(db, [
      extracted("historic", ["Quorvex"], "loser", "person"),
      extracted("historic-second", ["Quorvex"], "loser", "person"),
    ]);
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "source-audio", speaker: { personId: "winner" } },
        settings,
      ).entries.map((e) => e.text),
    ).toEqual(["Quorvex"]);
  });
  test.each([1, 2, 2.5, 4])(
    "terms require distinct document support regardless of benefit %s",
    (benefit) => {
      const db = database();
      insert(db, "a");
      insert(db, "b");
      const weak = extracted("a", ["quorvex"]);
      weak.terms[0].benefit = benefit;
      applyTranscriptionVocabularyBatch(db, [weak]);
      expect(getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries).toEqual(
        [],
      );
      applyTranscriptionVocabularyBatch(db, [{ ...weak, id: "b" }]);
      expect(
        getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map(
          (e) => e.text,
        ),
      ).toEqual(["quorvex"]);
    },
  );
  test("stronger grounded evidence upgrades a term without recounting its document", () => {
    const db = database();
    insert(db, "upgrade");
    const weak = extracted("upgrade", ["quorvex"]);
    weak.terms[0].benefit = 1;
    applyTranscriptionVocabularyBatch(db, [weak]);
    db.prepare("UPDATE documents SET vocabulary_processed_at=NULL WHERE id='upgrade'").run();
    applyTranscriptionVocabularyBatch(db, [extracted("upgrade", ["Quorvex"])]);
    expect(count(db)).toBe(1);
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map((e) => e.text),
    ).toEqual([]);
  });
});

describe("vocabulary extraction", () => {
  test("rejects addresses and URL fragments and preserves strongest observed spelling", () => {
    const doc: VocabularyDocument = {
      id: "noise",
      contentHash: "hash",
      updatedAt: "2026-01-01",
      revision: 0,
      generation: 1,
      title: "",
      content:
        "quorvex Quorvex see https://nimbrax.example.org/alpha nimbrax@example.org and nimbrax.example.org",
      sourceId: "fictional:messages",
      threadId: null,
      recordedAt: "2026-01-01",
      people: [],
    };
    const entries = extractTranscriptionVocabulary([doc], settings)[0].terms;
    expect(entries).toContainEqual({ term: "quorvex", text: "Quorvex", benefit: 2 });
    expect(entries.some((entry) => /nimbrax|example\.org|alpha/u.test(entry.term))).toBe(false);
  });
  test("keeps distinctive vocabulary and accented names while excluding everyday multilingual words", () => {
    const doc: VocabularyDocument = {
      id: "doc",
      contentHash: "hash",
      updatedAt: "2026-01-01",
      revision: 0,
      generation: 1,
      title: "",
      content: "Hello the garden maison casa Haus Quorvex Nimbrax quorvex quorvex. Zélor Vantix.",
      sourceId: "fictional:messages",
      threadId: "thread",
      recordedAt: "2026-01-01",
      people: [
        { personId: "fictional-person", name: "Zélor Vantix", isSelf: false, role: "sender" },
      ],
    };
    const result = extractTranscriptionVocabulary([doc], settings)[0];
    expect(result.terms.map((t) => t.text)).toContain("Zélor Vantix");
    const absent = extractTranscriptionVocabulary(
      [{ ...doc, content: "Hello the garden" }],
      settings,
    )[0];
    expect(absent.terms.map((t) => t.text)).not.toContain("Zélor Vantix");
    expect(result.terms.map((t) => t.text)).toContain("quorvex");
    for (const common of ["the", "garden", "maison", "casa", "Haus"])
      expect(result.terms.map((t) => t.term)).not.toContain(common.toLowerCase());
    expect(result.scopes).toContainEqual({ kind: "person", key: "fictional-person" });
    expect(extractTranscriptionVocabulary([doc], { ...settings, enabled: false })).toEqual([]);
  });
});
