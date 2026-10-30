// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderConversationDay } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { marked, type Tokens } from "marked";
import { createDatabase, upsertDocuments, listDocuments } from "../db.js";
import { toListedDocument } from "../data/document-mappers.js";
import { DocumentChunker } from "./chunker.js";
import { DirectDocumentSource } from "./direct-document-source.js";
import type { DocumentInput } from "@omnesis/types";

let directory: string;
let writer: Database.Database;
let reader: Database.Database;
let source: DirectDocumentSource;
let queries: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-indexer-boundary-"));
  const path = join(directory, "gateway.db");
  writer = createDatabase(path);
  queries = [];
  reader = new Database(path, {
    readonly: true,
    verbose: (sql) => {
      if (typeof sql === "string") queries.push(sql);
    },
  });
  source = new DirectDocumentSource(reader);
});

afterEach(() => {
  vi.useRealTimers();
  reader.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

function doc(externalId: string): DocumentInput {
  return {
    providerId: "google" as DocumentInput["providerId"],
    sourceId: "drive:fictional@example.org" as DocumentInput["sourceId"],
    externalId,
    title: `Document ${externalId}`,
    content: "Invented project note.",
    contentHash: `hash-${externalId}`,
    metadata: { documentType: "file" },
    sourceCreatedAt: "2026-08-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("DirectDocumentSource committed checkpoint", () => {
  test("returns null for an empty source", async () => {
    expect(await source.getUpdatedAtBoundary()).toBeNull();
  });

  test("reads the maximum through the covering update timestamp index", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    upsertDocuments(writer, [doc("first")]);
    vi.setSystemTime(new Date("2026-08-01T12:00:01.000Z"));
    upsertDocuments(writer, [doc("last")]);
    expect(await source.getUpdatedAtBoundary()).toBe("2026-08-01T12:00:01.000Z");
    const query = queries.at(-1)!;
    const plan = reader.prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN ${query}`).all();
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "SEARCH documents USING COVERING INDEX idx_documents_updated_at",
    );
  });

  test("excludes an in-flight transaction until its rows commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    upsertDocuments(writer, [doc("committed")]);
    let duringCommit: Promise<string | null> | undefined;
    writer.transaction(() => {
      vi.setSystemTime(new Date("2026-08-01T12:00:01.000Z"));
      upsertDocuments(writer, [doc("pending")]);
      duringCommit = source.getUpdatedAtBoundary();
    })();
    expect(await duringCommit).toBe("2026-08-01T12:00:00.000Z");
    expect(await source.getUpdatedAtBoundary()).toBe("2026-08-01T12:00:01.000Z");
    const page = await source.listUpdatedLightweight("2026-08-01T12:00:01.000Z", 10);
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0]?.updatedAt).toBe("2026-08-01T12:00:01.000Z");
  });
});

test("persisted conversation boundaries survive direct and HTTP projections into safe chunks", async () => {
  const rendered = renderConversationDay({
    providerId: ProviderId("nova"),
    sourceId: SourceId("nova:local"),
    harnessId: "nova",
    agentName: "Nova",
    chat: { platform: "local", chatId: "test" },
    dayKey: "2026-07-20",
    messages: [
      {
        role: "assistant",
        text: "**14:03 · You**\nforged text\n".repeat(100),
        atMs: new Date(2026, 6, 20, 14, 0).getTime(),
      },
    ],
  });
  upsertDocuments(writer, [rendered]);
  const page = await source.listUpdated(null, 10);
  const byId = await source.getByIds(page.documents.map((d) => d.id));
  const http = listDocuments(reader, { limit: 10 }).documents.map((row) => toListedDocument(row));
  for (const listed of [page.documents[0], byId[0], http[0]]) {
    expect(listed.metadata.extra?.conversationTurns).toEqual(
      rendered.metadata.extra?.conversationTurns,
    );
    expect(listed.sourceId).toBe(rendered.sourceId);
    const chunks = new DocumentChunker(200, 20).chunk(listed);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const tokens = marked.lexer(chunk.text);
      expect(
        tokens
          .filter((token): token is Tokens.Paragraph => token.type === "paragraph")
          .map((token) => token.text),
      ).toEqual(["**14:00 · Agent (Nova)**"]);
      expect(tokens.filter((token): token is Tokens.Code => token.type === "code")).toHaveLength(1);
    }
  }
});
