// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { ProviderId, SourceId } from "@omnesis/types";
import { NotionPagesSource } from "./pages.js";
import type {
  PageObjectResponse,
  SearchResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionPagesCursor } from "./types.js";
import type { NotionClient } from "./client.js";

function makeFullPage(id: string, lastEdited = "2026-04-01T00:00:00.000Z"): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: lastEdited,
    archived: false,
    in_trash: false,
    icon: null,
    cover: null,
    url: `https://notion.so/${id}`,
    public_url: null,
    parent: { type: "workspace", workspace: true },
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [
          {
            type: "text",
            text: { content: `Page ${id}`, link: null },
            plain_text: `Page ${id}`,
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
            href: null,
          },
        ],
      },
    },
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
  } as unknown as PageObjectResponse;
}

function makeSearchResponse(
  pageIds: string[],
  has_more = false,
  next_cursor: string | null = null,
): SearchResponse {
  return {
    object: "list",
    has_more,
    next_cursor,
    results: pageIds.map((id) => makeFullPage(id)),
    type: "page_or_database",
    page_or_database: {},
  } as unknown as SearchResponse;
}

const sourceId = SourceId("notion-pages:ws1");
const providerId = ProviderId("notion:ws1");

interface ClientCalls {
  searchCursors: Array<string | undefined>;
  contentFetches: string[];
}

function buildClient(responses: SearchResponse[]): { client: NotionClient; calls: ClientCalls } {
  const calls: ClientCalls = { searchCursors: [], contentFetches: [] };
  let i = 0;
  const client = {
    async searchPages(startCursor?: string) {
      calls.searchCursors.push(startCursor);
      const r = responses[i] ?? makeSearchResponse([]);
      i++;
      return r;
    },
    async getPageContent(id: string) {
      calls.contentFetches.push(id);
      return { markdown: `# ${id}\n\nbody`, linkedPageIds: [] };
    },
  } as unknown as NotionClient;
  return { client, calls };
}

describe("NotionPagesSource — snapshot reconciliation", () => {
  test("bounds never-ending distinct-token searches", async () => {
    const { client } = buildClient([makeSearchResponse([], true, "next")]);
    await expect(
      new NotionPagesSource(client, sourceId, providerId).sync({
        startCursor: "current",
        snapshotMode: true,
        pageCursors: Array.from({ length: 10_000 }, (_, i) => `token-${i}`),
      }),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  test("an empty terminal incremental page clears continuation state for the next cycle", async () => {
    const { client, calls } = buildClient([makeSearchResponse([]), makeSearchResponse([])]);
    const source = new NotionPagesSource(client, sourceId, providerId);
    const result = await source.sync({
      startCursor: "last-page",
      pageCursors: ["last-page"],
      lastSnapshotAt: new Date().toISOString(),
      lastEditedTime: "2026-04-01T00:00:00.000Z",
    });
    expect(result.cursor.startCursor).toBeUndefined();
    expect(result.cursor.pageCursors).toBeUndefined();
    await source.sync(result.cursor);
    expect(calls.searchCursors).toEqual(["last-page", undefined]);
  });

  test.each([null, "", "   ", "x".repeat(1025)])(
    "refuses malformed continuation %j before fetching content",
    async (token) => {
      const { client, calls } = buildClient([makeSearchResponse(["a"], true, token)]);
      await expect(
        new NotionPagesSource(client, sourceId, providerId).sync(null),
      ).rejects.toMatchObject({ kind: "transient" });
      expect(calls.contentFetches).toEqual([]);
    },
  );

  test("rejects repeated pagination after a persisted multi-token cycle without mutating the bookmark", async () => {
    const { client } = buildClient([
      makeSearchResponse(["a"], true, "page-2"),
      makeSearchResponse(["b"], true, "page-3"),
      makeSearchResponse(["c"], true, "page-2"),
    ]);
    const source = new NotionPagesSource(client, sourceId, providerId);
    const first = await source.sync(null);
    const second = await source.sync(first.cursor);
    const persisted = JSON.parse(JSON.stringify(second.cursor)) as NotionPagesCursor;
    await expect(
      new NotionPagesSource(client, sourceId, providerId).sync(persisted),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(persisted).toEqual(JSON.parse(JSON.stringify(second.cursor)));
    expect(persisted.snapshotIds).toEqual(["page-a", "page-b"]);
  });

  test("legacy in-flight cursors reject a nonadvancing token and contradictory completion", async () => {
    for (const response of [
      makeSearchResponse([], true, "old"),
      makeSearchResponse([], false, "another"),
    ]) {
      const { client } = buildClient([response]);
      await expect(
        new NotionPagesSource(client, sourceId, providerId).sync({
          startCursor: "old",
          snapshotMode: true,
        }),
      ).rejects.toMatchObject({ kind: "transient" });
    }
  });

  test("first sync (no cursor): emits presentExternalIds with every page ID once search completes", async () => {
    const { client } = buildClient([makeSearchResponse(["a", "b", "c"], false, null)]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    expect(result.hasMore).toBe(false);
    // presentExternalIds must use the same `page-<hyphenless-id>` format
    // as the doc externalIds — otherwise reconcile compares apples to
    // oranges and deletes every notion-pages doc.
    expect(result.presentExternalIds?.sort()).toEqual(["page-a", "page-b", "page-c"]);
    const cursor = result.cursor as NotionPagesCursor;
    expect(cursor.lastSnapshotAt).toBeTruthy();
    expect(cursor.snapshotMode).toBe(false);
    expect(cursor.snapshotIds).toBeUndefined();
  });

  test("multi-page snapshot: first page returns hasMore=true with no presentExternalIds; final page emits presentExternalIds covering all pages", async () => {
    const { client, calls } = buildClient([
      makeSearchResponse(["a", "b"], true, "cursor1"),
      makeSearchResponse(["c", "d"], false, null),
    ]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    // First page
    const r1 = await source.sync(null);
    expect(r1.hasMore).toBe(true);
    expect(r1.presentExternalIds).toBeUndefined();
    expect((r1.cursor as NotionPagesCursor).snapshotMode).toBe(true);
    expect((r1.cursor as NotionPagesCursor).snapshotIds?.sort()).toEqual(["page-a", "page-b"]);

    // Second page resumes snapshot via cursor
    const r2 = await source.sync(r1.cursor as NotionPagesCursor);
    expect(r2.hasMore).toBe(false);
    expect(r2.presentExternalIds?.sort()).toEqual(["page-a", "page-b", "page-c", "page-d"]);
    expect((r2.cursor as NotionPagesCursor).snapshotMode).toBe(false);
    expect((r2.cursor as NotionPagesCursor).snapshotIds).toBeUndefined();

    // Both pages were fetched once each
    expect(calls.searchCursors).toEqual([undefined, "cursor1"]);
  });

  test("recently-snapshotted source: incremental sync skips snapshot mode and does NOT emit presentExternalIds", async () => {
    const { client } = buildClient([makeSearchResponse(["fresh-edit"], false, null)]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    // Cursor is "fresh" — snapshot just ran an hour ago.
    const recentSnapshot = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cursor: NotionPagesCursor = {
      lastEditedTime: "2026-04-01T00:00:00.000Z",
      lastSnapshotAt: recentSnapshot,
    };

    const result = await source.sync(cursor);

    expect(result.presentExternalIds).toBeUndefined();
    expect((result.cursor as NotionPagesCursor).snapshotMode).toBe(false);
    expect((result.cursor as NotionPagesCursor).lastSnapshotAt).toBe(recentSnapshot);
  });

  test("stale snapshot (>24h): re-enters snapshot mode and emits presentExternalIds", async () => {
    const { client } = buildClient([makeSearchResponse(["x", "y"], false, null)]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    // 25h ago — past the snapshot interval.
    const staleSnapshot = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const cursor: NotionPagesCursor = {
      lastEditedTime: "2026-04-01T00:00:00.000Z",
      lastSnapshotAt: staleSnapshot,
    };

    const result = await source.sync(cursor);

    expect(result.presentExternalIds?.sort()).toEqual(["page-x", "page-y"]);
    const newCursor = result.cursor as NotionPagesCursor;
    expect(newCursor.lastSnapshotAt).not.toBe(staleSnapshot);
    expect(newCursor.snapshotMode).toBe(false);
  });

  test("archived/in_trash pages are NOT included in the snapshot", async () => {
    const archived = makeFullPage("archived-page");
    (archived as unknown as { archived: boolean }).archived = true;
    const inTrash = makeFullPage("trash-page");
    (inTrash as unknown as { in_trash: boolean }).in_trash = true;

    const { client } = buildClient([
      {
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [makeFullPage("alive"), archived, inTrash],
        type: "page_or_database",
        page_or_database: {},
      } as unknown as SearchResponse,
    ]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    expect(result.presentExternalIds).toEqual(["page-alive"]);
  });

  test("real-shape UUIDs are stripped of hyphens AND prefixed with 'page-' to match doc externalIds (regression for catastrophic-reconcile bug)", async () => {
    // Caught live during Tier 4 of sources-qa Phase 4 validation: the
    // Notion API returns hyphenated UUIDs (`a1b0ccee-9dcd-498d-…`) but
    // `pageToDocument` stores docs under prefixed-hyphenless externalIds
    // (`page-a1b0ccee9dcd498d…`). The previous snapshot path pushed the
    // raw hyphenated UUID into `presentExternalIds`, so the gateway
    // compared two formats that share zero values, deleted every
    // matching notion-pages doc, and triggered a full re-bootstrap.
    const realShapeUuid = "a1b0ccee-9dcd-498d-b8cc-0bdfa7307fc2";
    const expectedExternalId = "page-a1b0ccee9dcd498db8cc0bdfa7307fc2";
    const { client } = buildClient([makeSearchResponse([realShapeUuid], false, null)]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    expect(result.presentExternalIds).toEqual([expectedExternalId]);
    // The doc itself must use the same format — sanity-check the alignment.
    expect(result.documents[0].externalId).toBe(expectedExternalId);
  });

  test("database rows (parent.type === 'database_id') are excluded — they belong to notion-databases source", async () => {
    const dbRow = makeFullPage("db-row");
    (dbRow as unknown as { parent: { type: string; database_id: string } }).parent = {
      type: "database_id",
      database_id: "some-db",
    };
    const standalone = makeFullPage("standalone");

    const { client } = buildClient([
      {
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [standalone, dbRow],
        type: "page_or_database",
        page_or_database: {},
      } as unknown as SearchResponse,
    ]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    expect(result.presentExternalIds).toEqual(["page-standalone"]);
  });

  test("empty search response after first snapshot still emits presentExternalIds=[]", async () => {
    // Workspace was emptied. The snapshot must be the empty array — that
    // tells the gateway to delete every Notion page doc for this source.
    const { client } = buildClient([makeSearchResponse([], false, null)]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    expect(result.presentExternalIds).toEqual([]);
    expect(result.documents).toEqual([]);
  });
});

describe("NotionPagesSource — data-retention cutoff", () => {
  function makePageWithTimes(id: string, created: string, lastEdited: string): PageObjectResponse {
    const page = makeFullPage(id, lastEdited);
    (page as unknown as { created_time: string }).created_time = created;
    return page;
  }

  // A page created before the retention cutoff but edited recently must be
  // SKIPPED without halting pagination. Search is sorted by
  // `last_edited_time` descending, so such a page can appear ahead of newer,
  // in-retention pages on later search pages. If the retention skip halted
  // pagination, those later in-retention pages would never be fetched.
  test("old-created/recently-edited page is skipped but does NOT stop pagination", async () => {
    const dataCutoff = "2024-01-01T00:00:00.000Z";

    // Search page 1: an old-created (pre-cutoff) but recently-edited page,
    // with more results to follow.
    const oldCreatedRecentEdit = makePageWithTimes(
      "old-created",
      "2020-01-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
    const page1: SearchResponse = {
      object: "list",
      has_more: true,
      next_cursor: "cursor1",
      results: [oldCreatedRecentEdit],
      type: "page_or_database",
      page_or_database: {},
    } as unknown as SearchResponse;

    // Search page 2: an in-retention page that must still be ingested.
    const inRetention = makePageWithTimes(
      "keep",
      "2025-06-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
    const page2: SearchResponse = {
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [inRetention],
      type: "page_or_database",
      page_or_database: {},
    } as unknown as SearchResponse;

    const { client, calls } = buildClient([page1, page2]);
    const source = new NotionPagesSource(client, sourceId, providerId, dataCutoff);

    // Non-snapshot incremental cycle: a recent snapshot, no incremental
    // watermark so the `last_edited_time` cutoff does not fire and we isolate
    // the retention path.
    const recentSnapshot = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cursor: NotionPagesCursor = { lastSnapshotAt: recentSnapshot };

    // Page 1: the old-created page is dropped from retention, but pagination
    // must continue because Notion has more results.
    const r1 = await source.sync(cursor);
    expect(r1.hasMore).toBe(true);
    expect((r1.cursor as NotionPagesCursor).startCursor).toBe("cursor1");
    expect(r1.documents.map((d) => d.externalId)).toEqual([]);
    expect(calls.contentFetches).not.toContain("old-created");

    // Page 2: the in-retention page is reached and ingested.
    const r2 = await source.sync(r1.cursor as NotionPagesCursor);
    expect(r2.documents.map((d) => d.externalId)).toEqual(["page-keep"]);
    expect(calls.contentFetches).toContain("keep");
  });
});

describe("NotionPagesSource — error classification", () => {
  // The collector decides a source's state from what escapes `sync()`. A
  // revoked integration must arrive as `auth` so it lands in needs-auth with a
  // re-auth prompt, rather than as an untyped error the operator can't act on.
  test("a revoked integration escapes sync() classified as auth", async () => {
    const client = {
      searchPages() {
        return Promise.reject(
          new APIResponseError({
            code: APIErrorCode.Unauthorized,
            status: 401,
            message: "API token is invalid.",
            headers: new Headers(),
            rawBodyText: "",
            additional_data: undefined,
            request_id: undefined,
          }),
        );
      },
    } as unknown as NotionClient;
    const source = new NotionPagesSource(client, sourceId, providerId);

    await expect(source.sync(null)).rejects.toMatchObject({ kind: "auth" });
  });

  test("an unreachable Notion escapes sync() as network, not auth", async () => {
    const client = {
      searchPages() {
        return Promise.reject(new TypeError("fetch failed"));
      },
    } as unknown as NotionClient;
    const source = new NotionPagesSource(client, sourceId, providerId);

    await expect(source.sync(null)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("NotionPagesSource — a rewalk that could not read everything", () => {
  /** A search result Notion acknowledged but would not describe. */
  function makePartialResult(id: string) {
    return { object: "page", id } as unknown as PageObjectResponse;
  }

  function responseWithPartial(pageIds: string[], partialIds: string[]): SearchResponse {
    return {
      object: "list",
      has_more: false,
      next_cursor: null,
      results: [...pageIds.map((id) => makeFullPage(id)), ...partialIds.map(makePartialResult)],
      type: "page_or_database",
      page_or_database: {},
    } as unknown as SearchResponse;
  }

  test("a partial search result withholds the snapshot rather than shrinking it", async () => {
    const { client } = buildClient([responseWithPartial(["a", "b"], ["c"])]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync(null);

    // The pages that did come back are still indexed.
    expect(result.documents.map((d) => d.externalId).sort()).toEqual(["page-a", "page-b"]);
    // But "c" exists and was not enumerated, so the walk cannot claim to know
    // what the workspace holds. Emitting ["page-a","page-b"] would delete it.
    expect(result.presentExternalIds).toBeUndefined();
    const cursor = result.cursor as NotionPagesCursor;
    expect(cursor.snapshotMode).toBe(false);
    expect(cursor.snapshotDirty).toBeUndefined();
  });

  test("a partial result on any page of a multi-page rewalk poisons the whole rewalk", async () => {
    const { client } = buildClient([
      {
        object: "list",
        has_more: true,
        next_cursor: "cursor1",
        results: [makeFullPage("a"), makePartialResult("b")],
        type: "page_or_database",
        page_or_database: {},
      } as unknown as SearchResponse,
      makeSearchResponse(["c"], false, null),
    ]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const first = await source.sync(null);
    expect((first.cursor as NotionPagesCursor).snapshotDirty).toBe(true);
    expect(first.issues).toBeUndefined();

    const second = await source.sync(first.cursor as NotionPagesCursor);
    expect(second.presentExternalIds).toBeUndefined();
    expect(second.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
  });

  test("a withheld rewalk does not stamp lastSnapshotAt — it is re-attempted, not deferred", async () => {
    const priorSnapshotAt = "2026-01-01T00:00:00.000Z";
    const { client } = buildClient([responseWithPartial(["a", "b"], ["c"])]);
    const source = new NotionPagesSource(client, sourceId, providerId);

    const result = await source.sync({
      lastEditedTime: "2026-01-01T00:00:00.000Z",
      lastSnapshotAt: priorSnapshotAt,
      snapshotMode: true,
    } as NotionPagesCursor);

    expect(result.presentExternalIds).toBeUndefined();
    // Stamping it would gate the next rewalk behind the full cadence interval,
    // so a single partial result would switch deletion detection off for a day
    // on the strength of a rewalk that produced nothing.
    expect((result.cursor as NotionPagesCursor).lastSnapshotAt).toBe(priorSnapshotAt);
  });

  test("the next clean rewalk reconciles — withholding defers deletion, it does not cancel it", async () => {
    const { client } = buildClient([responseWithPartial(["a", "b"], ["c"])]);
    const source = new NotionPagesSource(client, sourceId, providerId);
    const dirty = await source.sync(null);
    expect(dirty.presentExternalIds).toBeUndefined();
    expect(dirty.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);

    // A later rewalk over a workspace Notion describes fully does reconcile.
    const { client: clean } = buildClient([makeSearchResponse(["a", "b"], false, null)]);
    const cleanSource = new NotionPagesSource(clean, sourceId, providerId);
    const cursor = { ...(dirty.cursor as NotionPagesCursor), lastSnapshotAt: undefined };
    const reconciled = await cleanSource.sync(cursor);
    expect(reconciled.presentExternalIds?.sort()).toEqual(["page-a", "page-b"]);
    expect(reconciled.issues).toEqual([]);
    const incremental = await cleanSource.sync(reconciled.cursor as NotionPagesCursor);
    expect(incremental.issues).toBeUndefined();
  });
});
