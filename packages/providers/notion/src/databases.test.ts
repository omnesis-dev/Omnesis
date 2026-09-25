// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { APIResponseError, APIErrorCode } from "@notionhq/client";
import { ProviderId, SourceId } from "@omnesis/types";
import { rowsFor, deletionsFor, writesFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { NotionDatabasesSource } from "./databases.js";
import type {
  DataSourceObjectResponse,
  QueryDataSourceResponse,
  SearchResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionDatabasesCursor } from "./types.js";
import type { NotionClient } from "./client.js";

function makeNotFoundError(message = "Could not find database") {
  return new APIResponseError({
    code: APIErrorCode.ObjectNotFound,
    status: 404,
    message,
    headers: new Headers(),
    rawBodyText: "{}",
    additional_data: undefined,
    request_id: undefined,
  });
}

function makeRestrictedError() {
  return new APIResponseError({
    code: APIErrorCode.RestrictedResource,
    status: 403,
    message: "Insufficient permissions",
    headers: new Headers(),
    rawBodyText: "{}",
    additional_data: undefined,
    request_id: undefined,
  });
}

function makeRateLimitedError() {
  return new APIResponseError({
    code: APIErrorCode.RateLimited,
    status: 429,
    message: "Rate limited",
    headers: new Headers(),
    rawBodyText: "{}",
    additional_data: undefined,
    request_id: undefined,
  });
}

function makeInternalServerError(message = "Request to Notion API failed with status: 500") {
  return new APIResponseError({
    code: APIErrorCode.InternalServerError,
    status: 500,
    message,
    headers: new Headers(),
    rawBodyText: "{}",
    additional_data: undefined,
    request_id: undefined,
  });
}

function makeFullDatabase(id: string): DataSourceObjectResponse {
  return {
    object: "data_source",
    id: `ds-${id}`,
    title: [
      {
        type: "text",
        text: { content: "My DB", link: null },
        plain_text: "My DB",
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
    description: [],
    properties: {},
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-01-01T00:00:00.000Z",
    archived: false,
    in_trash: false,
    is_inline: false,
    parent: { type: "database_id", database_id: id },
    database_parent: { type: "workspace", workspace: true },
    url: "https://notion.so/" + id,
    public_url: null,
    cover: null,
    icon: null,
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
  } as unknown as DataSourceObjectResponse;
}

function makeEmptyQueryResponse(): QueryDataSourceResponse {
  return {
    object: "list",
    results: [],
    next_cursor: null,
    has_more: false,
    type: "page_or_data_source",
    page_or_data_source: {},
  } as unknown as QueryDataSourceResponse;
}

function makeSyncDbCursor(databaseIds: string[]): NotionDatabasesCursor {
  return {
    phase: "sync-db",
    databases: databaseIds.map((id, i) => ({
      id,
      title: `DB ${i}`,
      lastEditedTime: "2024-01-01T00:00:00.000Z",
    })),
    currentDbIndex: 0,
  };
}

function makeDoneCursor(
  databaseIds: string[],
  discoveredAt: string,
  extras: Partial<NotionDatabasesCursor> = {},
): NotionDatabasesCursor {
  return {
    phase: "done",
    databases: databaseIds.map((id, i) => ({
      id,
      title: `DB ${i}`,
      lastEditedTime: "2024-01-01T00:00:00.000Z",
    })),
    currentDbIndex: databaseIds.length,
    discoveredAt,
    ...extras,
  };
}

function makeSearchResponse(databaseIds: string[]): SearchResponse {
  return {
    object: "list",
    has_more: false,
    next_cursor: null,
    results: databaseIds.map((id) => makeFullDatabase(id)),
    type: "page_or_data_source",
    page_or_data_source: {},
  } as unknown as SearchResponse;
}

const sourceId = SourceId("notion-databases:ws1");
const providerId = ProviderId("notion:ws1");

const NOW_MS = new Date("2026-04-25T12:00:00.000Z").getTime();
const fixedNow = () => NOW_MS;

describe("NotionDatabasesSource — inaccessible databases", () => {
  test("skips DB when getDatabase throws object_not_found, advances to next", async () => {
    const calls: string[] = [];
    const client = {
      async getDatabase(id: string) {
        calls.push(`getDatabase:${id}`);
        if (id === "bad") throw makeNotFoundError();
        return makeFullDatabase(id);
      },
      async queryDatabase(id: string) {
        calls.push(`queryDatabase:${id}`);
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["bad", "good"]);

    const result = await source.syncStructured(cursor);

    expect(calls).toEqual(["getDatabase:bad"]);
    expect(result.cursor.phase).toBe("sync-db");
    expect((result.cursor as NotionDatabasesCursor).currentDbIndex).toBe(1);
    expect(result.hasMore).toBe(true);
    expect(result.analytics).toBeUndefined();
  });

  test("skips DB when getDatabase throws restricted_resource", async () => {
    const client = {
      async getDatabase(id: string) {
        if (id === "bad") throw makeRestrictedError();
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["bad", "good"]);

    const result = await source.syncStructured(cursor);
    expect((result.cursor as NotionDatabasesCursor).currentDbIndex).toBe(1);
  });

  test("skips DB when queryDatabase throws object_not_found after retrieve succeeds", async () => {
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(id: string) {
        if (id === "bad") throw makeNotFoundError();
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["bad", "good"]);

    const result = await source.syncStructured(cursor);
    expect((result.cursor as NotionDatabasesCursor).currentDbIndex).toBe(1);
    // No records were emitted from the bad DB
    expect(result.analytics).toBeUndefined();
  });

  test("skipping the last DB transitions to done phase", async () => {
    const client = {
      async getDatabase() {
        throw makeNotFoundError();
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["bad"]);

    const result = await source.syncStructured(cursor);
    expect(result.cursor.phase).toBe("done");
    expect(result.hasMore).toBe(false);
  });

  test("non-transient errors (e.g. rate_limited) propagate — must NOT be swallowed", async () => {
    const client = {
      async getDatabase() {
        throw makeRateLimitedError();
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["rate-limited-db"]);

    await expect(source.syncStructured(cursor)).rejects.toThrow("Rate limited");
  });

  test("generic (non-Notion) errors propagate", async () => {
    const client = {
      async getDatabase() {
        throw new Error("network blew up");
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["x"]);

    await expect(source.syncStructured(cursor)).rejects.toThrow("network blew up");
  });

  test("transient 500 from getDatabase is treated as a per-DB skip (regression for notion-sync-fails-hard-on-notion-500)", async () => {
    // Reproduces notion-sync-fails-hard-on-notion-500: previously a 500
    // mid-multi-DB sync threw out of the entire run, losing the work for
    // already-completed DBs. Now it gets the same skip-with-backoff
    // treatment as 404s.
    const client = {
      async getDatabase() {
        throw makeInternalServerError();
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;
    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["dies-on-500"]);
    // Doesn't throw — DB gets skipped, sync advances cleanly.
    const result = await source.syncStructured(cursor);
    const out = result.cursor as any;
    expect(out.skippedDbs?.["dies-on-500"]).toBeDefined();
    expect(out.skippedDbs?.["dies-on-500"].failures).toBe(1);
  });

  test("transient 5xx-shaped string error from queryDatabase is also caught", async () => {
    const client = {
      async getDatabase() {
        return makeFullDatabase("flaky-db");
      },
      async queryDatabase() {
        // Mimics a non-SDK Error that withRetry gave up on.
        throw new Error("Request to Notion API failed with status: 502");
      },
    } as unknown as NotionClient;
    const source = new NotionDatabasesSource(client, sourceId, providerId);
    const cursor = makeSyncDbCursor(["flaky-db"]);
    const result = await source.syncStructured(cursor);
    const out = result.cursor as any;
    expect(out.skippedDbs?.["flaky-db"]).toBeDefined();
  });
});

describe("NotionDatabasesSource — discovery TTL cache", () => {
  test("phase=done with fresh discoveredAt skips search and jumps to sync-db", async () => {
    const calls: string[] = [];
    const client = {
      async searchDatabases() {
        calls.push("searchDatabases");
        return makeSearchResponse(["a", "b"]);
      },
      async getDatabase(id: string) {
        calls.push(`getDatabase:${id}`);
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        calls.push("queryDatabase");
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // 30 minutes old — under the 1h TTL
    const discoveredAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    const cursor = makeDoneCursor(["a", "b"], discoveredAt);

    const result = await source.syncStructured(cursor);

    // No searchDatabases call — cache was reused.
    expect(calls).not.toContain("searchDatabases");
    // Went straight into sync-db with the first DB.
    expect(calls).toContain("getDatabase:a");
    expect(result.cursor.phase).toBe("sync-db");
    expect((result.cursor as NotionDatabasesCursor).currentDbIndex).toBe(1);
  });

  test("phase=done with stale discoveredAt re-runs search", async () => {
    const calls: string[] = [];
    const client = {
      async searchDatabases() {
        calls.push("searchDatabases");
        return makeSearchResponse(["a"]);
      },
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // 90 minutes old — past the 1h TTL
    const discoveredAt = new Date(NOW_MS - 90 * 60 * 1000).toISOString();
    const cursor = makeDoneCursor(["a"], discoveredAt);

    const result = await source.syncStructured(cursor);

    expect(calls[0]).toBe("searchDatabases");
    expect(result.cursor.phase).toBe("sync-db");
    // discoveredAt has been refreshed
    expect((result.cursor as NotionDatabasesCursor).discoveredAt).toBe(
      new Date(NOW_MS).toISOString(),
    );
  });

  test("phase=done preserves lastSyncTime across the cache hit", async () => {
    const previousLastSync = "2026-04-25T11:00:00.000Z";
    let queryFilterArg: string | undefined;

    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, _start?: string, lastEditedAfter?: string) {
        queryFilterArg = lastEditedAfter;
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSyncTime: previousLastSync,
      // Recent snapshot stamp so the snapshot-rewalk gate doesn't
      // fire — this test exercises the incremental cache-hit path.
      lastSnapshotAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
    });

    await source.syncStructured(cursor);

    // lastSyncTime survived the cache hit, and was passed to queryDatabase
    // (with the 2-min margin applied).
    expect(queryFilterArg).toBeDefined();
    const expected = new Date(new Date(previousLastSync).getTime() - 2 * 60 * 1000).toISOString();
    expect(queryFilterArg).toBe(expected);
  });
});

describe("NotionDatabasesSource — skip-list backoff", () => {
  test("first failure records skip entry with 1h cooldown", async () => {
    const client = {
      async getDatabase(id: string) {
        if (id === "bad") throw makeNotFoundError();
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });
    const cursor = makeSyncDbCursor(["bad"]);

    const result = await source.syncStructured(cursor);

    const skip = (result.cursor as NotionDatabasesCursor).skippedDbs?.["bad"];
    expect(skip).toBeDefined();
    expect(skip?.failures).toBe(1);
    expect(skip?.lastError).toBe("retrieve:object_not_found");
    // Cooldown is 1h from now
    const expected = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    expect(skip?.retryAfter).toBe(expected);
  });

  test("second failure escalates cooldown to 6h", async () => {
    const client = {
      async getDatabase() {
        throw makeNotFoundError();
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Cursor already has 1 prior failure recorded. Backoff already expired
    // so we *do* try again, fail, and escalate.
    const cursor: NotionDatabasesCursor = {
      ...makeSyncDbCursor(["bad"]),
      skippedDbs: {
        bad: {
          failures: 1,
          retryAfter: new Date(NOW_MS - 1000).toISOString(),
          lastError: "retrieve:object_not_found",
        },
      },
    };

    const result = await source.syncStructured(cursor);

    const skip = (result.cursor as NotionDatabasesCursor).skippedDbs?.["bad"];
    expect(skip?.failures).toBe(2);
    const expected = new Date(NOW_MS + 6 * 60 * 60 * 1000).toISOString();
    expect(skip?.retryAfter).toBe(expected);
  });

  test("DB inside its cooldown window is skipped without API call", async () => {
    const calls: string[] = [];
    const client = {
      async getDatabase(id: string) {
        calls.push(`getDatabase:${id}`);
        return makeFullDatabase(id);
      },
      async queryDatabase(id: string) {
        calls.push(`queryDatabase:${id}`);
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const cursor: NotionDatabasesCursor = {
      ...makeSyncDbCursor(["bad", "good"]),
      skippedDbs: {
        bad: {
          failures: 1,
          retryAfter: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
          lastError: "retrieve:object_not_found",
        },
      },
    };

    const result = await source.syncStructured(cursor);

    // "bad" was never hit — no API calls, cursor just advanced past it.
    expect(calls).toEqual([]);
    expect(result.cursor.phase).toBe("sync-db");
    expect((result.cursor as NotionDatabasesCursor).currentDbIndex).toBe(1);
    expect(result.hasMore).toBe(true);
  });

  test("successful sync clears the skip-list entry for that DB", async () => {
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Cooldown already expired → DB will be retried.
    const cursor: NotionDatabasesCursor = {
      ...makeSyncDbCursor(["a"]),
      skippedDbs: {
        a: {
          failures: 2,
          retryAfter: new Date(NOW_MS - 1000).toISOString(),
          lastError: "retrieve:object_not_found",
        },
      },
    };

    const result = await source.syncStructured(cursor);

    // Skip entry removed after the successful pass.
    expect((result.cursor as NotionDatabasesCursor).skippedDbs).toBeUndefined();
  });

  test("re-discovery prunes skippedDbs entries for databases no longer in the list", async () => {
    const client = {
      async searchDatabases() {
        // Only "a" is still in the workspace; "gone" was deleted.
        return makeSearchResponse(["a"]);
      },
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Stale cursor with skippedDbs entry for a database that no longer exists.
    const cursor: NotionDatabasesCursor = makeDoneCursor(
      ["a", "gone"],
      new Date(NOW_MS - 90 * 60 * 1000).toISOString(),
      {
        skippedDbs: {
          gone: {
            failures: 3,
            retryAfter: new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString(),
            lastError: "retrieve:object_not_found",
          },
        },
      },
    );

    const result = await source.syncStructured(cursor);

    expect((result.cursor as NotionDatabasesCursor).skippedDbs).toBeUndefined();
  });
});

describe("NotionDatabasesSource — summary doc dedup", () => {
  test("first sync emits the summary doc and records its hash", async () => {
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const result = await source.syncStructured(makeSyncDbCursor(["a"]));

    // 1 summary doc emitted on first sync.
    expect(result.documents?.length).toBe(1);
    expect(result.documents?.[0]?.externalId).toMatch(/^db-/);
    const hashes = (result.cursor as NotionDatabasesCursor).summaryHashes;
    expect(hashes?.["a"]).toBeDefined();
    expect(hashes?.["a"]).toBe(result.documents?.[0]?.contentHash);
  });

  test("second sync with unchanged schema does NOT re-emit the summary doc", async () => {
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // First pass to capture the hash.
    const first = await source.syncStructured(makeSyncDbCursor(["a"]));
    const firstHash = (first.cursor as NotionDatabasesCursor).summaryHashes?.["a"];
    expect(firstHash).toBeDefined();

    // Second pass with the hash already present in the cursor.
    const cursor: NotionDatabasesCursor = {
      ...makeSyncDbCursor(["a"]),
      summaryHashes: { a: firstHash! },
    };
    const second = await source.syncStructured(cursor);

    expect(second.documents ?? []).toEqual([]);
    // Hash preserved unchanged.
    expect((second.cursor as NotionDatabasesCursor).summaryHashes?.["a"]).toBe(firstHash);
  });
});

describe("NotionDatabasesSource — incremental margin", () => {
  test("queryDatabase is called with lastSyncTime - 2min", async () => {
    let queryFilterArg: string | undefined;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, _start?: string, lastEditedAfter?: string) {
        queryFilterArg = lastEditedAfter;
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const lastSync = "2026-04-25T11:30:00.000Z";
    const cursor: NotionDatabasesCursor = {
      ...makeSyncDbCursor(["a"]),
      lastSyncTime: lastSync,
    };

    await source.syncStructured(cursor);

    const expected = new Date(new Date(lastSync).getTime() - 2 * 60 * 1000).toISOString();
    expect(queryFilterArg).toBe(expected);
  });

  test("queryDatabase is called with undefined when no lastSyncTime is set", async () => {
    let queryFilterArg: string | undefined;
    let called = false;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, _start?: string, lastEditedAfter?: string) {
        called = true;
        queryFilterArg = lastEditedAfter;
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    await source.syncStructured(makeSyncDbCursor(["a"]));

    expect(called).toBe(true);
    expect(queryFilterArg).toBeUndefined();
  });
});

describe("NotionDatabasesSource — snapshot reconciliation", () => {
  function makeQueryResponseWithRows(pageIds: string[]): QueryDataSourceResponse {
    return {
      object: "list",
      next_cursor: null,
      has_more: false,
      type: "page_or_data_source",
      page_or_data_source: {},
      results: pageIds.map((id) => ({
        object: "page",
        id,
        created_time: "2026-04-01T00:00:00.000Z",
        last_edited_time: "2026-04-01T00:00:00.000Z",
        archived: false,
        in_trash: false,
        icon: null,
        cover: null,
        url: `https://notion.so/${id}`,
        public_url: null,
        parent: { type: "database_id", database_id: "ws-db" },
        properties: {
          Name: {
            id: "title",
            type: "title",
            title: [
              {
                type: "text",
                text: { content: `row ${id}`, link: null },
                plain_text: `row ${id}`,
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
      })),
    } as unknown as QueryDataSourceResponse;
  }

  test("first sync (no lastSnapshotAt) enters snapshot mode and emits presentExternalIds on rewalk completion", async () => {
    let queryFilterArg: string | undefined;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, _start?: string, lastEditedAfter?: string) {
        queryFilterArg = lastEditedAfter;
        return makeQueryResponseWithRows(["row-1", "row-2"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Use makeDoneCursor so the snapshot-mode gate is hit on the cache-
    // fresh fast-path. Set `lastSyncTime` to confirm it gets suppressed
    // when snapshot mode kicks in. No `lastSnapshotAt` → first cycle.
    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSyncTime: "2026-04-25T11:30:00.000Z",
    });

    const result = await source.syncStructured(cursor);

    // Filter suppressed during snapshot mode.
    expect(queryFilterArg).toBeUndefined();
    // Both row externalIds + the summary externalId enumerated.
    // Notion ids get dashes stripped in the externalId scheme — see
    // normalizer.ts (`db-<id>`, `row-<id>`).
    expect(result.presentExternalIds?.sort()).toEqual(["db-a", "row-row1", "row-row2"]);
    // A read that covered every database says so with the whole-source form.
    // Claiming instead would leave every document stored before this source
    // named a partition unreachable by any sweep, forever.
    expect(result.presentClaims).toBeUndefined();
    // Every document names the database it came from, which is what a claim
    // is matched against on the cycles that have to claim.
    expect(result.documents?.map((d) => d.partitionKey)).toEqual(["a", "a", "a"]);
    // lastSnapshotAt stamped, snapshot transients cleared.
    const c = result.cursor as NotionDatabasesCursor;
    expect(c.lastSnapshotAt).toBe(new Date(NOW_MS).toISOString());
    expect(c.inSnapshotMode).toBe(false);
    expect(c.snapshot).toBeUndefined();
  });

  test("recently-snapshotted source skips snapshot mode and runs incremental", async () => {
    let queryFilterArg: string | undefined;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, _start?: string, lastEditedAfter?: string) {
        queryFilterArg = lastEditedAfter;
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const previousLastSync = "2026-04-25T11:00:00.000Z";
    const recentSnapshotAt = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSyncTime: previousLastSync,
      lastSnapshotAt: recentSnapshotAt,
    });

    const result = await source.syncStructured(cursor);

    // Incremental filter applied (with 2min margin).
    expect(queryFilterArg).toBeDefined();
    // Not in snapshot mode → no presentExternalIds.
    expect(result.presentExternalIds).toBeUndefined();
    // lastSnapshotAt unchanged.
    expect((result.cursor as NotionDatabasesCursor).lastSnapshotAt).toBe(recentSnapshotAt);
  });

  test("stale lastSnapshotAt (>24h) re-enters snapshot mode", async () => {
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["x"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSnapshotAt: stale,
    });

    const result = await source.syncStructured(cursor);

    expect(result.presentExternalIds?.sort()).toEqual(["db-a", "row-x"]);
    expect((result.cursor as NotionDatabasesCursor).lastSnapshotAt).not.toBe(stale);
  });

  // ── Analytics-row deletion detection (#156) ─────────────────────────
  //
  // Two consecutive snapshot rewalks of one database; the second sees a
  // row vanish. The completion page must name the gone row by its analytics
  // key (page UUID, dashes stripped) so DuckDB drops the row whose Notion
  // source disappeared.

  /** Drive one full single-page rewalk and return its result. The cursor is
   *  `phase=done` with fresh discovery + stale `lastSnapshotAt`, so the
   *  cache-fresh fast-path re-enters snapshot mode and completes in one call. */
  async function runRewalk(
    source: NotionDatabasesSource,
    databaseIds: string[],
    lastSnapshotRowIdsByTable: Record<string, string[]> | undefined,
  ) {
    const cursor = makeDoneCursor(databaseIds, new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      // >24h stale → snapshot mode re-enters.
      lastSnapshotAt: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(),
      lastSnapshotRowIdsByTable,
    });
    return source.syncStructured(cursor);
  }

  test("a deleted analytics row is named on the next rewalk (#156)", async () => {
    // Page ids without dashes so the analytics PK == the id verbatim.
    let rows = ["alpha", "beta", "gamma"];
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(rows);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Rewalk 1: sees {alpha, beta, gamma}. No prior baseline → no deletes.
    const r1 = await runRewalk(source, ["a"], undefined);
    expect(writesFor(r1, "notion_a")[0]?.deletedKeys).toBeUndefined();
    const c1 = r1.cursor as NotionDatabasesCursor;
    // Baseline recorded for the table.
    expect(c1.lastSnapshotRowIdsByTable?.["notion_a"]?.sort()).toEqual(["alpha", "beta", "gamma"]);
    // In-progress accumulator fully drained on completion.
    expect(c1.snapshotRowIdsByTable).toBeUndefined();

    // Rewalk 2: beta deleted → sees {alpha, gamma}.
    rows = ["alpha", "gamma"];
    const r2 = await runRewalk(source, ["a"], c1.lastSnapshotRowIdsByTable);
    expect(deletionsFor(r2, "notion_a")).toEqual(["beta"]);
    expect(writesFor(r2, "notion_a")[0]?.deletedKeys).toEqual([{ id: "beta" }]);
    // The completion page's tableName routes the delete to the right table.
    expect(tablesWritten(r2)).toEqual(["notion_a"]);
    const c2 = r2.cursor as NotionDatabasesCursor;
    // Baseline rolled forward to the new present set.
    expect(c2.lastSnapshotRowIdsByTable?.["notion_a"]?.sort()).toEqual(["alpha", "gamma"]);
  });

  test("a row aged out of a ROLLING retention cutoff is NOT tombstoned as deleted (#156)", async () => {
    // The data-retention cutoff is a rolling window recomputed at every source
    // instantiation. A row created before the (now-advanced) cutoff is skipped
    // for INGEST but is STILL returned by Notion's query (the cutoff is a local
    // created_time filter, not a Notion-side one). It must not be mistaken for
    // an upstream deletion and tombstoned out of the analytics aggregates.
    const resp = makeQueryResponseWithRows(["alpha", "beta"]);
    (resp.results[0] as { created_time: string }).created_time = "2026-01-01T00:00:00.000Z"; // old
    (resp.results[1] as { created_time: string }).created_time = "2026-04-20T00:00:00.000Z"; // recent
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return resp;
      },
    } as unknown as NotionClient;

    // Cutoff sits between alpha (2026-01-01) and beta (2026-04-20): alpha is
    // aged out and skipped for ingest this cycle.
    const source = new NotionDatabasesSource(
      client,
      sourceId,
      providerId,
      "2026-04-10T00:00:00.000Z",
      undefined,
      { nowFn: fixedNow },
    );

    // Baseline (from a prior rewalk when alpha was still inside the window)
    // contains both rows.
    const r = await runRewalk(source, ["a"], { notion_a: ["alpha", "beta"] });

    // alpha aged out of retention — NOT a deletion.
    expect(writesFor(r, "notion_a")[0]?.deletedKeys).toBeUndefined();
    // Only beta is re-ingested; alpha is neither re-upserted nor tombstoned.
    expect(
      rowsFor(r, "notion_a")
        .map((x) => String(x.id))
        .sort(),
    ).toEqual(["beta"]);
    // The baseline keeps alpha (still present upstream), so it isn't lost.
    const c = r.cursor as NotionDatabasesCursor;
    expect(c.lastSnapshotRowIdsByTable?.["notion_a"]?.sort()).toEqual(["alpha", "beta"]);
  });

  test("present row PKs accumulate across paginated rewalk pages (#156)", async () => {
    // A database whose rows span two query pages. The present-PK set must
    // accumulate both pages before the completion diff runs, so a row that's
    // only on page 2 is NOT falsely reported as deleted.
    function pagedResponse(pageIds: string[], nextCursor: string | null): QueryDataSourceResponse {
      const base = makeQueryResponseWithRows(pageIds) as unknown as Record<string, unknown>;
      base.has_more = nextCursor !== null;
      base.next_cursor = nextCursor;
      return base as unknown as QueryDataSourceResponse;
    }

    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(_id: string, start?: string) {
        return start === "page2"
          ? pagedResponse(["gamma"], null)
          : pagedResponse(["alpha", "beta"], "page2");
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Baseline has all three; none should be deleted (all are still present,
    // just split across pages).
    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSnapshotAt: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(),
      lastSnapshotRowIdsByTable: { notion_a: ["alpha", "beta", "gamma"] },
    });

    // Page 1 of the DB — mid-pagination, no completion yet.
    const r1 = await source.syncStructured(cursor);
    expect(writesFor(r1, "notion_a")[0]?.deletedKeys).toBeUndefined();
    const c1 = r1.cursor as NotionDatabasesCursor;
    expect(c1.snapshotRowIdsByTable?.["notion_a"]).toEqual(["alpha", "beta"]);

    // Page 2 — completion. Full present set {alpha,beta,gamma} == baseline.
    const r2 = await source.syncStructured(c1);
    expect(writesFor(r2, "notion_a")[0]?.deletedKeys).toBeUndefined();
    expect(
      (r2.cursor as NotionDatabasesCursor).lastSnapshotRowIdsByTable?.["notion_a"]?.sort(),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  test("re-discovery retires missing tables with a compact empty baseline", async () => {
    const client = {
      async searchDatabases() {
        // Only "a" survives; "gone" was deleted.
        return makeSearchResponse(["a"]);
      },
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Stale discovery forces a re-list; baseline carries an entry for the
    // deleted DB's table. Its disappearance starts a new snapshot even when
    // the previous one is recent, without retaining all of its old row IDs.
    const cursor = makeDoneCursor(["a", "gone"], new Date(NOW_MS - 90 * 60 * 1000).toISOString(), {
      lastSnapshotAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      lastSnapshotRowIdsByTable: {
        notion_a: ["alpha"],
        notion_gone: ["x", "y"],
      },
    });

    const result = await source.syncStructured(cursor);
    const c = result.cursor as NotionDatabasesCursor;
    expect(c.lastSnapshotRowIdsByTable?.["notion_gone"]).toEqual([]);
    expect(c.missingDatabaseIds).toEqual(["gone"]);
    expect(c.lastSnapshotRowIdsByTable?.["notion_a"]).toEqual(["alpha"]);
  });

  test("an incremental (non-snapshot) cycle never names a deletion (#156)", async () => {
    // Incremental only returns CHANGED rows; an absent row means "unchanged",
    // not "deleted". Deletes must come only from a complete snapshot rewalk.
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        // Incremental cycle returns no changed rows this tick.
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Recent snapshot stamp → snapshot gate does NOT fire; runs incremental.
    const cursor = makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSyncTime: "2026-04-25T11:00:00.000Z",
      lastSnapshotAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      // A stale baseline exists, but incremental must not diff against it.
      lastSnapshotRowIdsByTable: { notion_a: ["alpha", "beta", "gamma"] },
    });

    const result = await source.syncStructured(cursor);

    expect((result.cursor as NotionDatabasesCursor).inSnapshotMode).toBeFalsy();
    expect(writesFor(result, "notion_a")[0]?.deletedKeys).toBeUndefined();
    // Baseline left untouched — incremental never rolls it.
    expect(
      (result.cursor as NotionDatabasesCursor).lastSnapshotRowIdsByTable?.["notion_a"],
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a database skipped mid-rewalk names no deletion for its table (#156)", async () => {
    // The skipped DB never reaches its completion branch, so its baseline is
    // not rolled and no row deletes are emitted — even though its rows are
    // absent from this cycle's enumeration. Mirrors the presentExternalIds
    // mass-delete guard at the analytics-row granularity.
    const client = {
      async getDatabase(id: string) {
        if (id === "bad") throw makeNotFoundError();
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["alpha"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Both tables have a prior baseline; "bad" 404s this rewalk.
    const baseline = {
      notion_bad: ["x", "y"],
      notion_good: ["alpha", "beta"],
    };
    const cursor = makeDoneCursor(
      ["bad", "good"],
      new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      {
        lastSnapshotAt: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(),
        lastSnapshotRowIdsByTable: baseline,
      },
    );

    // First call: "bad" 404s, is recorded as a gap, advances.
    const r1 = await source.syncStructured(cursor);
    expect(r1.analytics).toBeUndefined();
    let c = r1.cursor as NotionDatabasesCursor;
    expect(Object.keys(c.snapshot?.gaps ?? {})).toEqual(["bad"]);

    // Second call: "good" enumerated. "beta" is gone from good → a real delete.
    const r2 = await source.syncStructured(c);
    c = r2.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    // Only "good"'s genuine deletion is emitted; "bad" contributes nothing.
    expect(deletionsFor(r2, "notion_good")).toEqual(["beta"]);
    expect(writesFor(r2, "notion_good")[0]?.deletedKeys).toEqual([{ id: "beta" }]);
    expect(tablesWritten(r2)).toEqual(["notion_good"]);
    // "bad"'s baseline is preserved untouched (its rows x,y are NOT deleted).
    expect(c.lastSnapshotRowIdsByTable?.["notion_bad"]).toEqual(["x", "y"]);
    // "good"'s baseline rolled to its new present set.
    expect(c.lastSnapshotRowIdsByTable?.["notion_good"]).toEqual(["alpha"]);
  });

  test("a 404 mid-rewalk withholds the whole-source snapshot and claims the database it did read", async () => {
    // Two DBs, one of which 404s on retrieve. The whole-source form is an
    // instruction to delete everything it does not name, so it is withheld and
    // lastSnapshotAt does not advance. The database that WAS read to the end is
    // still vouched for by name: a 403 on one database must not suspend
    // deletion detection for every other one until the 403 clears.
    const client = {
      async getDatabase(id: string) {
        if (id === "bad") throw makeNotFoundError();
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["row-good"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // Stale snapshot triggers rewalk via the cache-fresh fast-path.
    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    const cursor = makeDoneCursor(
      ["bad", "good"],
      new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      { lastSnapshotAt: stale },
    );

    let result = await source.syncStructured(cursor);
    // First DB (bad) skipped, advanced to next.
    expect(result.hasMore).toBe(true);
    let c = result.cursor as NotionDatabasesCursor;
    expect(c.snapshot?.gaps?.bad, "the gap names the database and why").toContain(
      "retrieve failed",
    );

    // Second DB (good) walked.
    result = await source.syncStructured(c);
    c = result.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    // Refused to emit because one database was never read.
    expect(result.presentExternalIds).toBeUndefined();
    // The one that was read is claimed, and the unread one is absent from the
    // claim list — so the gateway sweeps inside "good" and leaves "bad" alone.
    expect(result.presentClaims).toEqual([{ partition: "good", ids: ["db-good", "row-rowgood"] }]);
    // lastSnapshotAt NOT updated — try again next cycle.
    expect(c.lastSnapshotAt).toBe(stale);
    // Snapshot transients cleared regardless.
    expect(c.inSnapshotMode).toBe(false);
    expect(c.snapshot).toBeUndefined();
  });
  test("a DB skipped by its backoff cooldown withholds the whole-source snapshot, not the sibling's claim", async () => {
    // The cooldown skip is the ordinary consequence of one transient failure,
    // and it fires on the cycle AFTER the failure — so it is the skip most
    // likely to coincide with a rewalk. Nothing about it is visible in the
    // rewalk's result unless it poisons the snapshot.
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["row-good"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    const cursor: NotionDatabasesCursor = {
      ...makeDoneCursor(["cooling", "good"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
        lastSnapshotAt: stale,
      }),
      skippedDbs: {
        cooling: {
          failures: 1,
          retryAfter: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
          lastError: "retrieve:internal_server_error",
        },
      },
    };

    let result = await source.syncStructured(cursor);
    let c = result.cursor as NotionDatabasesCursor;
    expect(c.snapshot?.gaps?.cooling, "a cooldown skip is a hole in the enumeration").toContain(
      "in backoff until",
    );

    result = await source.syncStructured(c);
    c = result.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims?.map((claim) => claim.partition)).toEqual(["good"]);
    expect(c.lastSnapshotAt, "the rewalk must be re-attempted, not marked done").toBe(stale);
  });

  test("the LAST database being skipped still lets the rewalk claim the ones it read", async () => {
    // The skip path walks past the end of the database list without ever
    // running the row-query path again, so a rewalk whose last database is in
    // a backoff exits through a different door than a rewalk that finished on
    // a row page. Both have to close the rewalk: one that only closed on the
    // row path would end with every database read, an accumulator full of ids,
    // and nothing asserted anywhere.
    const client = {
      async getDatabase(id: string) {
        if (id === "bad") throw makeNotFoundError();
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["row-good"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    // "bad" is last, so its skip is what ends the cycle.
    const cursor = makeDoneCursor(
      ["good", "bad"],
      new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      { lastSnapshotAt: stale },
    );

    let result = await source.syncStructured(cursor);
    expect(result.hasMore).toBe(true);
    let c = result.cursor as NotionDatabasesCursor;

    result = await source.syncStructured(c);
    c = result.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    expect(result.hasMore).toBe(false);
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims).toEqual([{ partition: "good", ids: ["db-good", "row-rowgood"] }]);
    // The rewalk is over, so the next cycle starts a fresh one rather than
    // resuming into a cursor that still believes it is mid-rewalk.
    expect(c.inSnapshotMode).toBe(false);
    expect(c.snapshot).toBeUndefined();
    expect(c.lastSnapshotAt, "a claiming rewalk is re-attempted, not marked done").toBe(stale);
  });

  test("a rewalk that read no database to completion asserts nothing at all", async () => {
    // Claims are what a partial read can honestly say. A read that completed
    // no partition has nothing to say, and must not fall through to an empty
    // claim list or an empty snapshot — either would be read as "these
    // partitions are empty" rather than "I could not look".
    const client = {
      async getDatabase() {
        throw makeNotFoundError();
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    let cursor = makeDoneCursor(["a", "b"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
      lastSnapshotAt: stale,
    });

    let result = await source.syncStructured(cursor);
    cursor = result.cursor as NotionDatabasesCursor;
    result = await source.syncStructured(cursor);
    cursor = result.cursor as NotionDatabasesCursor;

    expect(cursor.phase).toBe("done");
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims).toBeUndefined();
    expect(cursor.lastSnapshotAt).toBe(stale);
  });

  test("ids covered under a database the list no longer holds never reach the snapshot", async () => {
    // The partitions are read from the database list at the moment the rewalk
    // closes, and the covered set is a list of names checked against it. A name
    // the list no longer holds is dropped rather than covered, so its ids stay
    // out of the enumeration: a snapshot naming a document from a database this
    // cycle never walked would be vouching for something nobody read.
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeQueryResponseWithRows(["row-a"]);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    const cursor: NotionDatabasesCursor = {
      ...makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString(), {
        lastSnapshotAt: stale,
      }),
      phase: "sync-db",
      currentDbIndex: 0,
      inSnapshotMode: true,
      snapshot: { ids: { gone: ["row-ghost"] }, covered: ["gone"] },
    };

    const result = await source.syncStructured(cursor);
    const c = result.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    expect(result.presentExternalIds?.sort()).toEqual(["db-a", "row-rowa"]);
    expect(result.presentClaims).toBeUndefined();
  });

  test("a row the walk saw but did not ingest is still named as present", async () => {
    // Two rows the walk sees and skips: one Notion returned as a reference with
    // no properties, one created before the retention cutoff. Both exist
    // upstream, so a snapshot that omitted them would order the deletion of
    // documents whose rows are still there — and it is the DOCUMENT id that has
    // to be named, not only the analytics primary key three lines away.
    const partial = { object: "page", id: "reference-row" } as unknown;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        const full = makeQueryResponseWithRows(["fresh", "ancient"]);
        const results = full.results as unknown[];
        // "ancient" predates the cutoff below; the reference object has no
        // properties at all.
        (results[1] as { created_time: string }).created_time = "2020-01-01T00:00:00.000Z";
        return { ...full, results: [...results, partial] } as typeof full;
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(
      client,
      sourceId,
      providerId,
      "2026-01-01T00:00:00.000Z",
      undefined,
      { nowFn: fixedNow },
    );

    const result = await source.syncStructured(
      makeDoneCursor(["a"], new Date(NOW_MS - 10 * 60 * 1000).toISOString()),
    );

    // Only the fresh row is ingested …
    expect(result.documents?.map((d) => d.externalId)).toEqual(["db-a", "row-fresh"]);
    // … and all three are named as present, so none of them is swept.
    expect(result.presentExternalIds?.sort()).toEqual([
      "db-a",
      "row-ancient",
      "row-fresh",
      "row-referencerow",
    ]);
  });

  test("a row listing that reports more with no cursor does not cover its database", async () => {
    // The walk can neither continue nor say it finished. Covering the database
    // on the way past would turn "I am stuck here" into "I read everything",
    // and both planes would then delete what the walk never reached.
    // The first rewalk sees both rows and banks them as the baseline; the
    // second sees only one and cannot continue.
    let cycle = 0;
    const client = {
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase(id: string) {
        if (id !== "truncated") return makeQueryResponseWithRows(["whole-1"]);
        const full = makeQueryResponseWithRows(cycle === 0 ? ["row-1", "row-2"] : ["row-1"]);
        return cycle === 0 ? full : ({ ...full, has_more: true, next_cursor: null } as typeof full);
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const drain = async (start: NotionDatabasesCursor) => {
      let result = await source.syncStructured(start);
      const pages = [result];
      for (let i = 0; i < 10 && result.hasMore; i++) {
        result = await source.syncStructured(result.cursor);
        pages.push(result);
      }
      return pages;
    };

    const first = await drain(
      makeDoneCursor(["truncated", "whole"], new Date(NOW_MS - 10 * 60 * 1000).toISOString()),
    );
    expect(first.at(-1)!.presentExternalIds?.sort()).toEqual([
      "db-truncated",
      "db-whole",
      "row-row1",
      "row-row2",
      "row-whole1",
    ]);

    cycle = 1;
    const stale = { ...(first.at(-1)!.cursor as NotionDatabasesCursor), lastSnapshotAt: undefined };
    const second = await drain(stale);
    const truncatedPage = second.find((page) =>
      tablesWritten(page).some((table) => table.includes("truncated")),
    )!;
    const table = tablesWritten(truncatedPage).find((name) => name.includes("truncated"))!;

    // The database is gapped, so nothing vouches for it …
    expect((truncatedPage.cursor as NotionDatabasesCursor).snapshot?.gaps?.truncated).toContain(
      "no cursor",
    );
    // … and the analytics diff is skipped outright. Run against the baseline
    // the clean cycle banked, it would name row-2 — a row the truncated walk
    // simply never reached.
    expect(deletionsFor(truncatedPage, table)).toEqual([]);

    const last = second.at(-1)!;
    expect((last.cursor as NotionDatabasesCursor).phase).toBe("done");
    expect(last.presentExternalIds).toBeUndefined();
    expect(last.presentClaims?.map((claim) => claim.partition)).toEqual(["whole"]);
  });

  test("a discovery hole on an early page survives to the rewalk it starts", async () => {
    // Discovery is paged. A database dropped on page one is exactly as
    // invisible to the rewalk as one dropped on the last, so the hole has to
    // survive every page — and it has to be recorded before the cycle knows
    // whether it is a rewalk at all.
    let call = 0;
    const client = {
      async searchDatabases() {
        call++;
        if (call === 1) {
          const first = makeSearchResponse(["visible-1"]);
          return {
            ...first,
            has_more: true,
            next_cursor: "disco-page-2",
            results: [
              ...(first.results as unknown[]),
              { object: "database", id: "undescribed" } as unknown,
            ],
          } as typeof first;
        }
        return makeSearchResponse(["visible-2"]);
      },
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    const first = await source.syncStructured({
      phase: "discover",
      databases: [],
      currentDbIndex: 0,
      lastSnapshotAt: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(),
    });
    let c = first.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("discover");
    expect(c.discoveryIncomplete, "the hole must be carried on the discovery cursor").toBe(true);

    // Second discovery page is clean; the hole must not be forgotten.
    const second = await source.syncStructured(c);
    c = second.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("sync-db");
    expect(c.inSnapshotMode).toBe(true);
    expect(c.snapshot?.blindSpot, "a clean final page must not clear an earlier hole").toContain(
      "would not describe",
    );
    expect(c.discoveryIncomplete, "cached discovery remains incomplete until a new search").toBe(
      true,
    );
  });

  test("a database discovery returns as a partial object — the rewalk it starts is already incomplete", async () => {
    const client = {
      async searchDatabases() {
        const full = makeSearchResponse(["visible"]);
        return {
          ...full,
          results: [
            ...(full.results as unknown[]),
            { object: "database", id: "undescribed" } as unknown,
          ],
        } as typeof full;
      },
      async getDatabase(id: string) {
        return makeFullDatabase(id);
      },
      async queryDatabase() {
        return makeEmptyQueryResponse();
      },
    } as unknown as NotionClient;

    const source = new NotionDatabasesSource(client, sourceId, providerId, undefined, undefined, {
      nowFn: fixedNow,
    });

    // No discoveredAt → the source runs discovery, and a stale snapshot makes
    // the cycle that follows it a rewalk.
    const stale = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString();
    let result = await source.syncStructured({
      phase: "discover",
      databases: [],
      currentDbIndex: 0,
      lastSnapshotAt: stale,
    });

    let c = result.cursor as NotionDatabasesCursor;
    expect(c.inSnapshotMode).toBe(true);
    expect(c.snapshot?.blindSpot, "a database nobody could describe is never walked").toContain(
      "would not describe",
    );

    // Walk the rewalk out. A database that never entered the list cannot be
    // named as a missing partition — it is missing from the very list that
    // says what "everything" is — so the whole-source form stays withheld. The
    // database that WAS described is still claimed: an undescribable sibling
    // is not a reason to stop detecting deletions in the rest of the
    // workspace, which is where withholding used to leave it indefinitely.
    result = await source.syncStructured(c);
    c = result.cursor as NotionDatabasesCursor;
    expect(c.phase).toBe("done");
    expect(result.presentExternalIds).toBeUndefined();
    expect(result.presentClaims).toEqual([{ partition: "visible", ids: ["db-visible"] }]);
    expect(c.lastSnapshotAt, "a claiming rewalk is re-attempted next cycle").toBe(stale);
  });
});

describe("Notion database discovery retirement", () => {
  const old = () =>
    makeDoneCursor(["good", "blocked", "gone"], new Date(NOW_MS - 90 * 60 * 1000).toISOString(), {
      lastSnapshotAt: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(),
      lastSnapshotRowIdsByTable: {
        notion_good: ["old"],
        notion_blocked: ["held"],
        notion_gone: ["removed"],
      },
    });

  test("a disappeared database remains an empty claim across sibling failures, and reappearance cancels it", async () => {
    let discovered = ["good", "blocked"];
    const source = new NotionDatabasesSource(
      {
        searchDatabases: async () => makeSearchResponse(discovered),
        getDatabase: async (id: string) => {
          if (id === "blocked") throw makeNotFoundError();
          return makeFullDatabase(id);
        },
        queryDatabase: async () => ({
          ...makeEmptyQueryResponse(),
          results: [{ object: "page", id: "live" }],
        }),
      } as unknown as NotionClient,
      sourceId,
      providerId,
      undefined,
      undefined,
      { nowFn: fixedNow },
    );
    let cursor = old();
    for (let cycle = 0; cycle < 3; cycle++) {
      let page;
      do {
        page = await source.syncStructured(cursor);
        cursor = page.cursor;
      } while (page.hasMore);
      expect(page.presentExternalIds).toBeUndefined();
      expect(page.presentClaims).toContainEqual({ partition: "gone", ids: [] });
      expect(page.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      expect(page.presentClaims).toContainEqual({
        partition: "good",
        ids: ["db-good", "row-live"],
      });
      expect(writesFor(page, "notion_gone")).toEqual([
        { tableName: "notion_gone", records: [], presentKeys: [] },
      ]);
      expect(writesFor(page, "notion_blocked")).toEqual([]);
    }
    discovered = ["good", "gone", "blocked"];
    cursor.discoveredAt = old().discoveredAt;
    let page;
    do {
      page = await source.syncStructured(cursor);
      cursor = page.cursor;
    } while (page.hasMore);
    expect(cursor.missingDatabaseIds).toEqual([]);
    expect(page.presentClaims).toContainEqual({ partition: "gone", ids: ["db-gone", "row-live"] });
    expect(writesFor(page, "notion_gone")[0]?.presentKeys).toEqual([{ id: "live" }]);
  });

  test("an incomplete discovery never retires unseen databases, including cached retries", async () => {
    let incomplete = true;
    const source = new NotionDatabasesSource(
      {
        searchDatabases: async () => ({
          ...makeSearchResponse(["good"]),
          has_more: incomplete,
          next_cursor: null,
        }),
        getDatabase: async (id: string) => makeFullDatabase(id),
        queryDatabase: async () => makeEmptyQueryResponse(),
      } as unknown as NotionClient,
      sourceId,
      providerId,
      undefined,
      undefined,
      { nowFn: fixedNow },
    );
    let cursor = old();
    for (let cycle = 0; cycle < 3; cycle++) {
      let page;
      do {
        page = await source.syncStructured(cursor);
        cursor = page.cursor;
      } while (page.hasMore);
      expect(page.presentExternalIds).toBeUndefined();
      expect(page.presentClaims).toEqual([{ partition: "good", ids: ["db-good"] }]);
      expect(writesFor(page, "notion_gone")).toEqual([]);
      expect(cursor.discoveryIncomplete).toBe(true);
    }
    incomplete = false;
    cursor.discoveredAt = old().discoveredAt;
    let repaired;
    do {
      repaired = await source.syncStructured(cursor);
      cursor = repaired.cursor;
    } while (repaired.hasMore);
    expect(cursor.missingDatabaseIds?.sort()).toEqual(["blocked", "gone"]);
    expect(repaired.presentExternalIds).toEqual(["db-good"]);
    expect(writesFor(repaired, "notion_gone")[0]?.presentKeys).toEqual([]);
    expect(repaired.issues).toEqual([]);
  });

  test("an empty complete discovery reconciles known tables but invents none", async () => {
    const source = new NotionDatabasesSource(
      { searchDatabases: async () => makeSearchResponse([]) } as unknown as NotionClient,
      sourceId,
      providerId,
      undefined,
      undefined,
      { nowFn: fixedNow },
    );
    const cursor = old();
    cursor.databases.push({ id: "never-read", title: "Unread", lastEditedTime: "2026-01-01" });
    const page = await source.syncStructured(cursor);
    expect(page.presentExternalIds).toEqual([]);
    expect(tablesWritten(page).sort()).toEqual(["notion_blocked", "notion_gone", "notion_good"]);
    for (const table of tablesWritten(page))
      expect(writesFor(page, table)[0]?.presentKeys).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  test("a full read restamps an unchanged legacy summary with its partition", async () => {
    const source = new NotionDatabasesSource(
      {
        getDatabase: async (id: string) => makeFullDatabase(id),
        queryDatabase: async () => makeEmptyQueryResponse(),
      } as unknown as NotionClient,
      sourceId,
      providerId,
      undefined,
      undefined,
      { nowFn: fixedNow },
    );
    const first = await source.syncStructured(makeSyncDbCursor(["good"]));
    const next = await source.syncStructured({
      ...first.cursor,
      phase: "sync-db",
      currentDbIndex: 0,
      inSnapshotMode: true,
    });
    expect(next.documents?.map((doc) => doc.partitionKey)).toEqual(["good"]);
    expect(next.documents?.[0]?.contentHash).toBe(first.documents?.[0]?.contentHash);
  });
});
