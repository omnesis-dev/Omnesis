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
  kind: "global" | "person" | "conversation" = "global",
): ExtractedVocabularyDocument {
  return {
    id,
    contentHash: "hash",
    updatedAt: "2026-01-01",
    revision: 0,
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
    expect(result.entries[0].text).toBe("Umbriolet");
    expect(result.entries.map((entry) => entry.text)).toContain("Dormanthh");
    expect(result.entries).toHaveLength(settings.maxTerms);
    // Both profiles contribute, while each profile's two streams count once.
    const expected = ((3 * Math.log1p(2)) / (1 + Math.log1p(2))) * (1 + 3 * 3);
    expect(result.entries[0].score).toBeCloseTo(expected, 10);
  });

  test("overlapping frequency and recent streams do not double a profile score", () => {
    const db = database();
    insert(db, "single-profile");
    applyTranscriptionVocabularyBatch(db, [extracted("single-profile", ["Orvelion"])]);
    const result = getTranscriptionVocabulary(
      db,
      { purpose: "dictation", recordedAt: "2026-01-01" },
      settings,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].score).toBeCloseTo((3 * Math.log1p(1)) / (1 + Math.log1p(1)), 10);
  });

  test("indexed pending fetch bounds text; resolved people are required", () => {
    const db = database();
    insert(db, "ready", "Q".repeat(1000));
    insert(db, "unresolved");
    db.prepare("UPDATE documents SET people_resolved_at=NULL WHERE id='unresolved'").run();
    const docs = fetchTranscriptionVocabularyBatch(db, { ...settings, maxDocumentChars: 32 });
    expect(docs.map((d) => d.id)).toEqual(["ready"]);
    expect(docs[0].content).toHaveLength(32);
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
    const threadId = "fictional-thread-" + "q".repeat(700);
    db.prepare("UPDATE documents SET metadata=? WHERE id='conversation'").run(
      JSON.stringify({ extra: { conversationId: threadId } }),
    );
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

describe("context dictionary", () => {
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
    const person = db.prepare(
      "INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at,merged_into) VALUES (?,?,'fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01',?)",
    );
    person.run("winner", "Maya Reeves", null);
    person.run("loser", "Maya Reeves", "winner");
    applyTranscriptionVocabularyBatch(db, [extracted("historic", ["Quorvex"], "loser", "person")]);
    expect(
      getTranscriptionVocabulary(
        db,
        { purpose: "source-audio", speaker: { personId: "winner" } },
        settings,
      ).entries.map((e) => e.text),
    ).toEqual(["Quorvex"]);
  });
  test("weak lower-case terms require independent document support", () => {
    const db = database();
    insert(db, "a");
    insert(db, "b");
    const weak = extracted("a", ["quorvex"]);
    weak.terms[0].benefit = 1;
    applyTranscriptionVocabularyBatch(db, [weak]);
    expect(getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries).toEqual([]);
    applyTranscriptionVocabularyBatch(db, [{ ...weak, id: "b" }]);
    expect(
      getTranscriptionVocabulary(db, { purpose: "dictation" }, settings).entries.map((e) => e.text),
    ).toEqual(["quorvex"]);
  });
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
    ).toEqual(["Quorvex"]);
  });
});

describe("vocabulary extraction", () => {
  test("rejects addresses and URL fragments and preserves strongest observed spelling", () => {
    const doc: VocabularyDocument = {
      id: "noise",
      contentHash: "hash",
      updatedAt: "2026-01-01",
      revision: 0,
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
      title: "",
      content: "Hello the garden maison casa Haus Quorvex Nimbrax quorvex quorvex",
      sourceId: "fictional:messages",
      threadId: "thread",
      recordedAt: "2026-01-01",
      people: [
        { personId: "fictional-person", name: "Zélor Vantix", isSelf: false, role: "sender" },
      ],
    };
    const result = extractTranscriptionVocabulary([doc], settings)[0];
    expect(result.terms.map((t) => t.text)).toContain("Zélor Vantix");
    expect(result.terms.map((t) => t.text)).toContain("Quorvex");
    for (const common of ["the", "garden", "maison", "casa", "Haus"])
      expect(result.terms.map((t) => t.term)).not.toContain(common.toLowerCase());
    expect(result.scopes).toContainEqual({ kind: "person", key: "fictional-person" });
    expect(extractTranscriptionVocabulary([doc], { ...settings, enabled: false })).toEqual([]);
  });
});
