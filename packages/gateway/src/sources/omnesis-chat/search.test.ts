// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./ids.js";
import { createConversationSearch } from "./search.js";
import type { SearchQuery, SearchResultItem, SearchResponse } from "../../search/types.js";

function result(
  documentId: string,
  sourceId: string,
  chunkText: string,
  lanes: { bm25Rank?: number; vectorRank?: number } = { bm25Rank: 1 },
): SearchResultItem {
  return {
    scoreBreakdown: lanes,
    documentId,
    sourceId,
    documentType: "conversation",
    title: "t",
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    chunkText,
    score: 1,
  };
}

describe("createConversationSearch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE documents (id TEXT PRIMARY KEY, provider_id TEXT, source_id TEXT, external_id TEXT)",
    );
    const insert = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)");
    insert.run("doc-1", OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID, "conv-1");
    insert.run("doc-2", OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID, "conv-2");
    insert.run("doc-mail", "google", "gmail-1", "msg-1");
  });

  afterEach(() => db.close());

  test("searches this source only and maps each document to its conversation, best passage first", async () => {
    const search = vi.fn(
      async (_query: SearchQuery): Promise<SearchResponse> =>
        ({
          results: [
            result("doc-2", OMNESIS_CHAT_SOURCE_ID, "best passage of two"),
            result("doc-mail", "gmail-1", "an email"),
            result("doc-1", OMNESIS_CHAT_SOURCE_ID, "passage of one"),
            result("doc-2", OMNESIS_CHAT_SOURCE_ID, "weaker passage of two"),
            result("doc-gone", OMNESIS_CHAT_SOURCE_ID, "deleted since"),
            result("doc-1", OMNESIS_CHAT_SOURCE_ID, "nearest by meaning only", { vectorRank: 1 }),
          ],
        }) as unknown as SearchResponse,
    );
    const hits = await createConversationSearch({ pipeline: { search }, db })("budget");

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ text: "budget", filters: { sourceIds: [OMNESIS_CHAT_SOURCE_ID] } }),
    );
    expect(hits).toEqual([
      { conversationId: "conv-2", text: "best passage of two" },
      { conversationId: "conv-1", text: "passage of one" },
    ]);
  });

  test("a hit only the vector lane found does not count", async () => {
    const search = async (): Promise<SearchResponse> =>
      ({
        results: [result("doc-1", OMNESIS_CHAT_SOURCE_ID, "unrelated", { vectorRank: 1 })],
      }) as unknown as SearchResponse;
    await expect(createConversationSearch({ pipeline: { search }, db })("zzqx")).resolves.toEqual(
      [],
    );
  });

  test("strips the transcript's speaker labels from the passage", async () => {
    const search = async (): Promise<SearchResponse> =>
      ({
        results: [result("doc-1", OMNESIS_CHAT_SOURCE_ID, "**You** (2026-01-01):\nWhen is it?")],
      }) as unknown as SearchResponse;
    const [hit] = await createConversationSearch({ pipeline: { search }, db })("when");
    expect(hit!.text.trim()).toBe("When is it?");
  });

  test("no results asks nothing of the database", async () => {
    const search = async (): Promise<SearchResponse> =>
      ({ results: [] }) as unknown as SearchResponse;
    db.close();
    await expect(createConversationSearch({ pipeline: { search }, db })("x")).resolves.toEqual([]);
    db = new Database(":memory:");
  });
});
