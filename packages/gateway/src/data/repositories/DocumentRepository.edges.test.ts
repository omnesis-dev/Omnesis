// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * upsertWithCursor(+Yieldable) carrying source-declared `edges` (#430). Verifies
 * declared edges commit atomically with the page's documents, including across
 * the chunked yieldable path where only the final transaction applies edges.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import {
  upsertWithCursor,
  upsertWithCursorYieldable,
  type UpsertWithCursorArgs,
} from "./DocumentRepository.js";
import type { EdgeDeclaration } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => db.close());

const SOURCE = "gmail:me";
const T = "2026-01-01T10:00:00Z";

function doc(externalId: string): DocumentInput {
  return {
    providerId: "google" as DocumentInput["providerId"],
    sourceId: SOURCE as DocumentInput["sourceId"],
    externalId,
    title: `Doc ${externalId}`,
    content: `body ${externalId}`,
    contentHash: `ch-${externalId}`,
    metadata: { documentType: "email" },
    sourceCreatedAt: T,
    sourceUpdatedAt: T,
  };
}

function replyEdge(): EdgeDeclaration {
  return {
    from: { kind: "internal", sourceDocumentId: "reply-1" },
    to: { kind: "internal", sourceDocumentId: "msg-1" },
    type: "replies-to",
  };
}

function linkTypes(sourceDocId: string): string[] {
  return db
    .prepare<[string], { link_type: string }>(
      "SELECT link_type FROM document_links WHERE source_doc_id = ?",
    )
    .all(sourceDocId)
    .map((r) => r.link_type);
}

function docId(externalId: string): string {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

describe("upsertWithCursor with edges", () => {
  test("applies a declared edge in the same atomic write as the documents", () => {
    const args: UpsertWithCursorArgs = {
      providerId: "google",
      sourceId: SOURCE,
      documents: [doc("msg-1"), doc("reply-1")],
      edges: [replyEdge()],
      hasMore: false,
      cursor: { page: 0 },
    };
    upsertWithCursor(db, args);
    expect(linkTypes(docId("reply-1"))).toContain("replies-to");
  });

  test("parks a forward-reference declared edge in pending_edges", () => {
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: SOURCE,
      documents: [doc("reply-1")], // msg-1 not in this page
      edges: [replyEdge()],
      hasMore: false,
      cursor: { page: 0 },
    });
    expect(linkTypes(docId("reply-1"))).not.toContain("replies-to");
    const pending = db.prepare("SELECT COUNT(*) AS c FROM pending_edges").get() as { c: number };
    expect(pending.c).toBe(1);
  });
});

describe("upsertWithCursorYieldable carries edges to the final chunk", () => {
  test("edges apply only after the final chunk completes (chunked + yielding)", () => {
    // 3 docs at chunkSize 1 → two intermediate upsert-only chunks then a final
    // atomic chunk. A token that always requests yield forces the chunked path.
    const args: UpsertWithCursorArgs = {
      providerId: "google",
      sourceId: SOURCE,
      documents: [doc("msg-1"), doc("filler"), doc("reply-1")],
      edges: [replyEdge()],
      hasMore: false,
      cursor: { page: 0 },
    };
    const token = { requested: () => true };

    let outcome = upsertWithCursorYieldable(db, args, { token, chunkSize: 1 });
    let guard = 0;
    while (outcome.kind === "yield") {
      // Mid-stream: the intermediate chunks upsert documents only — no edges yet.
      expect(db.prepare("SELECT COUNT(*) AS c FROM document_links").get()).toMatchObject({ c: 0 });
      outcome = upsertWithCursorYieldable(db, outcome.resume, { token, chunkSize: 1 });
      if (++guard > 10) throw new Error("yield loop did not converge");
    }

    // Final chunk done → the declared edge is now present.
    expect(outcome.kind).toBe("done");
    expect(linkTypes(docId("reply-1"))).toContain("replies-to");
  });
});
