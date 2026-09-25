// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;

import { ProviderId, SourceId } from "@omnesis/types";
import { directWriteGate } from "../../write-gate.js";
import { createDatabase } from "../../db.js";

import {
  CONVERSATION_CITATION_LINK_TYPE,
  findConversationDocId,
  upsertConversationCitations,
  type ConversationRecordCitationInput,
} from "./citation-writer.js";

function testDbPath(): string {
  return `/tmp/omnesis-citation-writer-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

async function insertConversationDoc(db: Db, externalId: string): Promise<string> {
  const gate = directWriteGate(db);
  await gate.upsertDocuments([
    {
      providerId: ProviderId("system"),
      sourceId: SourceId("omnesis-chat"),
      externalId,
      title: "Test conversation",
      content: "# Test conversation\n\n**You**: Hi",
      contentHash: "h" + externalId,
      sourceCreatedAt: "2026-05-23T10:00:00.000Z",
      sourceUpdatedAt: "2026-05-23T10:01:00.000Z",
      metadata: { documentType: "conversation" },
    },
  ]);
  const id = findConversationDocId(db, "system", "omnesis-chat", externalId);
  if (!id) throw new Error("expected docId for the just-inserted conversation");
  return id;
}

async function insertGenericDoc(db: Db, externalId: string): Promise<string> {
  const gate = directWriteGate(db);
  await gate.upsertDocuments([
    {
      providerId: ProviderId("test"),
      sourceId: SourceId("gmail:alice@example.com"),
      externalId,
      title: "Email",
      content: "Body",
      contentHash: "h-email-" + externalId,
      sourceCreatedAt: "2026-05-22T00:00:00.000Z",
      sourceUpdatedAt: "2026-05-22T00:00:00.000Z",
      metadata: { documentType: "email" },
    },
  ]);
  const id = findConversationDocId(db, "test", "gmail:alice@example.com", externalId);
  if (!id) throw new Error("expected docId for the just-inserted email");
  return id;
}

describe("upsertConversationCitations", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("inserts one document_links row per citation with metadata_json", async () => {
    const convId = await insertConversationDoc(db, "s_test_1");
    const targetA = await insertGenericDoc(db, "email-a");
    const targetB = await insertGenericDoc(db, "email-b");

    const result = upsertConversationCitations(db, convId, [
      { targetDocId: targetA, quote: "hold the quote", quoteAuthor: "Sarah", note: "confirms" },
      { targetDocId: targetB }, // no metadata — column stays NULL
    ]);
    expect(result).toEqual({ removed: 0, inserted: 2 });

    const rows = db
      .prepare<
        [string],
        {
          link_type: string;
          target_doc_id: string;
          metadata_json: string | null;
          normalized_target: string;
        }
      >(
        "SELECT link_type, target_doc_id, metadata_json, normalized_target FROM document_links WHERE source_doc_id = ? ORDER BY id",
      )
      .all(convId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      link_type: CONVERSATION_CITATION_LINK_TYPE,
      target_doc_id: targetA,
    });
    expect(rows[0].normalized_target).toBe(`omnesis://doc/${targetA}#0`);
    expect(JSON.parse(rows[0].metadata_json ?? "{}")).toEqual({
      quote: "hold the quote",
      quoteAuthor: "Sarah",
      note: "confirms",
    });
    expect(rows[1].metadata_json).toBeNull();
  });

  test("replaces the previous citation set (DELETE+INSERT semantics)", async () => {
    const convId = await insertConversationDoc(db, "s_test_2");
    const targetA = await insertGenericDoc(db, "email-2a");
    const targetB = await insertGenericDoc(db, "email-2b");

    upsertConversationCitations(db, convId, [{ targetDocId: targetA, quote: "old" }]);
    const r2 = upsertConversationCitations(db, convId, [{ targetDocId: targetB, note: "new" }]);
    expect(r2).toEqual({ removed: 1, inserted: 1 });

    const rows = db
      .prepare<
        [string],
        { target_doc_id: string; metadata_json: string | null }
      >("SELECT target_doc_id, metadata_json FROM document_links WHERE source_doc_id = ?")
      .all(convId);
    expect(rows).toEqual([
      { target_doc_id: targetB, metadata_json: JSON.stringify({ note: "new" }) },
    ]);
  });

  test("multiple annotations on the same target survive the UNIQUE constraint", async () => {
    const convId = await insertConversationDoc(db, "s_test_3");
    const targetA = await insertGenericDoc(db, "email-3a");

    const r = upsertConversationCitations(db, convId, [
      { targetDocId: targetA, quote: "first" },
      { targetDocId: targetA, quote: "second" },
    ]);
    expect(r).toEqual({ removed: 0, inserted: 2 });

    const rows = db
      .prepare<
        [string],
        { normalized_target: string; metadata_json: string }
      >("SELECT normalized_target, metadata_json FROM document_links WHERE source_doc_id = ? ORDER BY id")
      .all(convId);
    expect(rows).toHaveLength(2);
    expect(rows[0].normalized_target).not.toBe(rows[1].normalized_target);
  });

  test("empty citation list with no prior edges is a no-op", async () => {
    const convId = await insertConversationDoc(db, "s_test_4");
    const r = upsertConversationCitations(db, convId, []);
    expect(r).toEqual({ removed: 0, inserted: 0 });
  });

  test("empty list after a prior set wipes the edges", async () => {
    const convId = await insertConversationDoc(db, "s_test_5");
    const targetA = await insertGenericDoc(db, "email-5a");

    upsertConversationCitations(db, convId, [{ targetDocId: targetA }]);
    const r = upsertConversationCitations(db, convId, []);
    expect(r).toEqual({ removed: 1, inserted: 0 });

    const count = db
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) as c FROM document_links WHERE source_doc_id = ?")
      .get(convId);
    expect(count?.c ?? -1).toBe(0);
  });
});

// ─── record citations (#757, sub-issue c) ──────────────────────────────────

function recordCitation(
  overrides: Partial<ConversationRecordCitationInput> = {},
): ConversationRecordCitationInput {
  return {
    kind: "record",
    table: "demo_transactions",
    recordKey: "row:demo_transactions:txn-001",
    primaryKeyColumns: [{ name: "id", value: "txn-001", castType: "VARCHAR" }],
    title: "Stellar Sound",
    keyFields: [
      { label: "Merchant", value: "Stellar Sound" },
      { label: "Amount", value: "42.00" },
    ],
    semanticTime: "2026-05-23T10:00:00.000Z",
    snapshot: { id: "txn-001", merchant: "Stellar Sound", amount: "42.00" },
    sourceId: "demo:acct1",
    sourceType: "demo",
    tableDisplayName: "Demo Transactions",
    boundDocumentId: null,
    ...overrides,
  };
}

describe("upsertConversationCitations — record citations (#757)", () => {
  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("persists a kind:'record' citation with snapshot + semanticTime + identity", async () => {
    const convId = await insertConversationDoc(db, "s_rec_1");
    const r = upsertConversationCitations(db, convId, [recordCitation()]);
    expect(r).toEqual({ removed: 0, inserted: 1 });

    const row = db
      .prepare<
        [string],
        {
          link_type: string;
          target_doc_id: string | null;
          metadata_json: string | null;
          normalized_target: string;
        }
      >(
        "SELECT link_type, target_doc_id, metadata_json, normalized_target FROM document_links WHERE source_doc_id = ?",
      )
      .get(convId);
    expect(row?.link_type).toBe(CONVERSATION_CITATION_LINK_TYPE);
    // No bound document → target_doc_id is NULL but the row still renders.
    expect(row?.target_doc_id).toBeNull();
    // normalized_target is synthesized from recordKey under the row scheme.
    expect(row?.normalized_target).toBe("omnesis://row/demo_transactions/txn-001#0");
    const meta = JSON.parse(row?.metadata_json ?? "{}");
    expect(meta.kind).toBe("record");
    expect(meta.table).toBe("demo_transactions");
    expect(meta.recordKey).toBe("row:demo_transactions:txn-001");
    expect(meta.semanticTime).toBe("2026-05-23T10:00:00.000Z");
    expect(meta.snapshot).toEqual({ id: "txn-001", merchant: "Stellar Sound", amount: "42.00" });
    expect(meta.title).toBe("Stellar Sound");
    expect(meta.primaryKeyColumns).toEqual([{ name: "id", value: "txn-001", castType: "VARCHAR" }]);
  });

  test("re-running the upsert is idempotent — one edge, nothing destroyed", async () => {
    const convId = await insertConversationDoc(db, "s_rec_2");
    const first = upsertConversationCitations(db, convId, [recordCitation()]);
    expect(first).toEqual({ removed: 0, inserted: 1 });

    const before = db
      .prepare<
        [string],
        { normalized_target: string; metadata_json: string | null }
      >("SELECT normalized_target, metadata_json FROM document_links WHERE source_doc_id = ?")
      .all(convId);

    const second = upsertConversationCitations(db, convId, [recordCitation()]);
    // Full-sweep semantics: the prior edge is removed and re-inserted, so the
    // final edge SET is identical — no duplicate row, nothing left destroyed.
    expect(second).toEqual({ removed: 1, inserted: 1 });

    const after = db
      .prepare<
        [string],
        { normalized_target: string; metadata_json: string | null }
      >("SELECT normalized_target, metadata_json FROM document_links WHERE source_doc_id = ?")
      .all(convId);
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
  });

  test("record and document citations on one conversation do not collide", async () => {
    const convId = await insertConversationDoc(db, "s_rec_3");
    const targetDoc = await insertGenericDoc(db, "email-rec-3");

    // The record's bound document is the SAME doc as the document citation's
    // target. The row scheme must still keep the two normalized_targets distinct.
    const r = upsertConversationCitations(db, convId, [
      { kind: "document", targetDocId: targetDoc, quote: "doc evidence" },
      recordCitation({ boundDocumentId: targetDoc }),
    ]);
    expect(r).toEqual({ removed: 0, inserted: 2 });

    const rows = db
      .prepare<
        [string],
        { normalized_target: string; target_doc_id: string | null }
      >("SELECT normalized_target, target_doc_id FROM document_links WHERE source_doc_id = ? ORDER BY id")
      .all(convId);
    expect(rows).toHaveLength(2);
    expect(rows[0].normalized_target).toBe(`omnesis://doc/${targetDoc}#0`);
    expect(rows[1].normalized_target).toBe("omnesis://row/demo_transactions/txn-001#1");
    expect(rows[0].normalized_target).not.toBe(rows[1].normalized_target);
    // Both point at the same bound document.
    expect(rows[0].target_doc_id).toBe(targetDoc);
    expect(rows[1].target_doc_id).toBe(targetDoc);
  });

  test("a record bound to a document carries target_doc_id", async () => {
    const convId = await insertConversationDoc(db, "s_rec_4");
    const targetDoc = await insertGenericDoc(db, "email-rec-4");
    upsertConversationCitations(db, convId, [recordCitation({ boundDocumentId: targetDoc })]);
    const row = db
      .prepare<
        [string],
        { target_doc_id: string | null }
      >("SELECT target_doc_id FROM document_links WHERE source_doc_id = ?")
      .get(convId);
    expect(row?.target_doc_id).toBe(targetDoc);
  });
});

describe("findConversationDocId", () => {
  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("returns null when no doc matches", () => {
    expect(findConversationDocId(db, "system", "omnesis-chat", "missing")).toBeNull();
  });

  test("returns the assigned UUID after upsert", async () => {
    const id = await insertConversationDoc(db, "s_found");
    expect(id).toMatch(/^[0-9a-f-]+$/);
    expect(findConversationDocId(db, "system", "omnesis-chat", "s_found")).toBe(id);
  });
});
