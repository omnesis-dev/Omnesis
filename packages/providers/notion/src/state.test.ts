// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  emptySync,
  isStateEnvelope,
  resolveSourceState,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { NotionPagesSource } from "./pages.js";
import { NotionDatabasesSource } from "./databases.js";
import { notionPagesStateSpec, notionDatabasesStateSpec } from "./state.js";
import type {
  DataSourceObjectResponse,
  QueryDataSourceResponse,
  SearchResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "./client.js";

const providerId = ProviderId("notion:tester");
const pagesSourceId = SourceId("notion-pages:tester");
const databasesSourceId = SourceId("notion-databases:tester");

function makeSearchPagesResponse(
  ids: string[],
  has_more = false,
  next_cursor: string | null = null,
): SearchResponse {
  return {
    object: "list",
    has_more,
    next_cursor,
    results: ids.map((id) => ({
      object: "page",
      id,
      created_time: "2024-01-01T00:00:00.000Z",
      last_edited_time: "2026-04-01T00:00:00.000Z",
      archived: false,
      in_trash: false,
      parent: { type: "workspace", workspace: true },
      properties: {},
      created_by: { object: "user", id: "u1" },
      last_edited_by: { object: "user", id: "u1" },
    })),
    type: "page_or_database",
    page_or_database: {},
  } as unknown as SearchResponse;
}

function pagesInstance(pages: SearchResponse[]): SourceInstance {
  let i = 0;
  const client = {
    async searchPages() {
      const r = pages[i] ?? makeSearchPagesResponse([]);
      i++;
      return r;
    },
    async getPageContent(id: string) {
      return { markdown: `# ${id}`, linkedPageIds: [] };
    },
  } as unknown as NotionClient;
  const source = new NotionPagesSource(client, pagesSourceId, providerId);
  return { sync: (cursor) => source.sync(cursor as never) };
}

function makeFullDatabase(id: string): DataSourceObjectResponse {
  return {
    object: "data_source",
    id: `ds-${id}`,
    title: [],
    description: [],
    properties: {},
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-01-01T00:00:00.000Z",
    archived: false,
    in_trash: false,
    is_inline: false,
    parent: { type: "database_id", database_id: id },
    database_parent: { type: "workspace", workspace: true },
    url: `https://notion.so/${id}`,
    public_url: null,
    cover: null,
    icon: null,
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
  } as unknown as DataSourceObjectResponse;
}

function databasesInstance(): SourceInstance {
  const client = {
    async searchDatabases() {
      return {
        results: [makeFullDatabase("db1")],
        has_more: false,
        next_cursor: null,
      } as unknown as SearchResponse;
    },
    async getDatabase(id: string) {
      return makeFullDatabase(id);
    },
    async queryDatabase() {
      return {
        results: [],
        next_cursor: null,
        has_more: false,
      } as unknown as QueryDataSourceResponse;
    },
  } as unknown as NotionClient;
  const source = new NotionDatabasesSource(client, databasesSourceId, providerId);
  return {
    sync: () => Promise.resolve(emptySync()),
    syncStructured: (cursor) => source.syncStructured(cursor as never),
  };
}

describe("notionPagesStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(
      pagesInstance([makeSearchPagesResponse([], false, null)]),
      notionPagesStateSpec,
      { sourceId: "notion-pages:tester", onResolve: (outcome) => outcomes.push(outcome) },
    );

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a mid-snapshot cursor round-trips through the envelope without losing accumulated ids", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(
      pagesInstance([
        makeSearchPagesResponse(["a", "b"], true, "page-2"),
        makeSearchPagesResponse(["c"], false, null),
      ]),
      notionPagesStateSpec,
      { sourceId: "notion-pages:tester", onResolve: (outcome) => outcomes.push(outcome) },
    );

    const first = await versioned.sync(null);
    expect(first.hasMore).toBe(true);
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    if (outcomes[1]?.kind === "resume") {
      // The mid-snapshot page's accumulated ids survive the envelope
      // round-trip rather than being reset by a decoder that only recognised
      // a settled cursor.
      expect(outcomes[1].state.snapshotIds).toEqual(["page-a", "page-b"]);
    }
    expect(second.hasMore).toBe(false);
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });
});

describe("notionDatabasesStateSpec via the host decorator", () => {
  it.each([true, false])(
    "preserves incremental pagination across an upgrade (envelope: %s)",
    (enveloped) => {
      const state = {
        phase: "sync-db",
        databases: [{ id: "db-1", title: "Tasks", lastEditedTime: "2026-01-01T00:00:00.000Z" }],
        currentDbIndex: 0,
        inSnapshotMode: false,
        dbPageCursor: "incremental-page-2",
        emittedSummary: true,
        lastSyncTime: "2026-01-02T00:00:00.000Z",
      };
      const outcome = resolveSourceState(
        notionDatabasesStateSpec,
        enveloped ? { e: 1, v: 1, state } : state,
      );
      expect(outcome.kind).toBe("migrated");
      if (outcome.kind === "migrated") expect(outcome.state).toEqual(state);
    },
  );

  it("first run resolves fresh; the mid-cycle sync-db page it produces still resumes", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(databasesInstance(), notionDatabasesStateSpec, {
      sourceId: "notion-databases:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // Discovery always hands back `hasMore: true` (sync-db still has to run),
    // so this is exactly the mid-cycle shape `decode` has to accept.
    const first = await versioned.syncStructured!(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(first.hasMore).toBe(true);
    expect(isStateEnvelope(first.cursor)).toBe(true);

    const second = await versioned.syncStructured!(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a rewalk ledger this build cannot iterate rebootstraps rather than throwing forever", () => {
    // The enumeration is resumed by iterating its stored id arrays, so a
    // malformed ledger throws part-way through a page instead of being refused.
    // The decoder is the only place that can turn that into a re-bootstrap: a
    // value that decodes and then throws leaves the source retrying the same
    // cursor and failing the same way, where `onUnreadable` cannot reach it.
    const outcome = resolveSourceState(
      notionDatabasesStateSpec,
      {
        e: 1,
        v: 2,
        s: "notion-databases:tester",
        state: {
          phase: "sync-db",
          databases: [{ id: "db-1", title: "One", lastEditedTime: "2026-01-01T00:00:00.000Z" }],
          currentDbIndex: 0,
          inSnapshotMode: true,
          snapshot: { ids: { "db-1": 42 } },
        },
      },
      { sourceId: "notion-databases:tester" },
    );

    expect(outcome.kind).toBe("rebootstrap");
  });

  it("a version-1 cursor caught mid-rewalk is resumed with the rewalk ended, not continued", () => {
    // Version 1 kept a rewalk's external ids in one workspace-wide list with no
    // record of which database each came from. Nothing can split that back up,
    // and a rewalk resumed without it would reach the end believing it had read
    // only the databases walked after the upgrade — and vouch for exactly
    // those. Ending the rewalk costs one cycle and is the only honest option.
    const stored = {
      phase: "sync-db",
      databases: [
        { id: "db-1", title: "One", lastEditedTime: "2026-01-01T00:00:00.000Z" },
        { id: "db-2", title: "Two", lastEditedTime: "2026-01-01T00:00:00.000Z" },
      ],
      currentDbIndex: 1,
      dbPageCursor: "notion-page-2",
      emittedSummary: true,
      lastSyncTime: "2026-04-01T00:00:00.000Z",
      discoveredAt: "2026-04-01T00:00:00.000Z",
      skippedDbs: {
        "db-3": {
          failures: 2,
          retryAfter: "2026-04-02T00:00:00.000Z",
          lastError: "query:not_found",
        },
      },
      summaryHashes: { "db-1": "hash-1" },
      inSnapshotMode: true,
      snapshotIds: ["db-db1", "row-a", "row-b"],
      snapshotDirty: true,
      snapshotRowIdsByTable: { notion_db_1: ["a", "b"] },
      lastSnapshotRowIdsByTable: { notion_db_1: ["a"] },
    };

    const outcome = resolveSourceState(notionDatabasesStateSpec, stored, {
      sourceId: "notion-databases:tester",
    });

    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    const state = outcome.state;
    // The rewalk is over. A cursor left mid-rewalk would close on an
    // accumulator holding only what this build wrote.
    expect(state.inSnapshotMode).toBe(false);
    expect(state.snapshot).toBeUndefined();
    expect(state.snapshotRowIdsByTable).toBeUndefined();
    expect((state as unknown as { snapshotIds?: unknown }).snapshotIds).toBeUndefined();
    // Nothing the rewalk did not own is touched: position, watermark, backoff
    // ladder, summary hashes, and the analytics baseline a completed database
    // already rolled forward all survive.
    expect(state.phase).toBe("sync-db");
    expect(state.currentDbIndex).toBe(1);
    // The page cursor goes with the rewalk. Notion issues one for the query
    // that produced it, and ending the rewalk changes the query — the next call
    // would resume an unfiltered walk's cursor under an incremental filter.
    expect(state.dbPageCursor).toBeUndefined();
    expect(state.emittedSummary).toBeUndefined();
    expect(state.databases).toHaveLength(2);
    expect(state.lastSyncTime).toBe("2026-04-01T00:00:00.000Z");
    expect(state.skippedDbs?.["db-3"]?.failures).toBe(2);
    expect(state.summaryHashes?.["db-1"]).toBe("hash-1");
    expect(state.lastSnapshotRowIdsByTable).toEqual({ notion_db_1: ["a"] });
    // No lastSnapshotAt was stamped, so the next cycle starts a fresh rewalk
    // rather than waiting out the interval.
    expect(state.lastSnapshotAt).toBeUndefined();
  });
});
