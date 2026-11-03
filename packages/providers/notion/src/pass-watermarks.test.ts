// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySync, withVersionedState, type SourceState } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { NotionDatabasesSource } from "./databases.js";
import { NotionPagesSource } from "./pages.js";
import { notionDatabasesStateSpec, notionPagesStateSpec } from "./state.js";
import type { NotionClient } from "./client.js";
import type { NotionDatabasesCursor, NotionPagesCursor } from "./types.js";

const start = "2026-06-01T12:00:00.000Z";
const prior = "2026-06-01T10:00:00.000Z";
const edited = "2026-06-01T12:05:00.000Z";
const end = "2026-06-01T12:20:00.000Z";
const providerId = ProviderId("notion:fixture");

function page(id: string, time: string) {
  return {
    object: "page",
    id,
    properties: {},
    parent: { type: "workspace", workspace: true },
    created_time: prior,
    last_edited_time: time,
    archived: false,
    in_trash: false,
    created_by: { id: "fixture-user" },
    last_edited_by: { id: "fixture-user" },
  };
}
function database(id: string) {
  return {
    object: "data_source",
    id: `ds-${id}`,
    title: [],
    properties: {},
    parent: { database_id: id },
    created_time: prior,
    last_edited_time: prior,
    created_by: { id: "fixture-user" },
    last_edited_by: { id: "fixture-user" },
  };
}
function listing(results: unknown[], next_cursor: string | null = null) {
  return { results, next_cursor, has_more: next_cursor !== null };
}
function stored(state: SourceState, version: number, enveloped: boolean) {
  return enveloped ? { e: 1, v: version, state } : state;
}

afterEach(() => vi.useRealTimers());

describe("Notion pass watermarks", () => {
  it.each([false, true])(
    "replays database edits after a multi-sync pass (snapshot: %s)",
    async (snapshot) => {
      let now = Date.parse(start);
      let changed = false;
      const query = vi.fn(async (id: string, _cursor: string | undefined, after?: string) =>
        listing(
          id === "first" && (!after || (changed ? edited : prior) >= after)
            ? [page("row", changed ? edited : prior)]
            : [],
        ),
      );
      const client = {
        getDatabase: async (id: string) => database(id),
        queryDatabase: query,
      } as unknown as NotionClient;
      const source = new NotionDatabasesSource(
        client,
        SourceId("notion-databases:fixture"),
        providerId,
        undefined,
        undefined,
        { nowFn: () => now },
      );
      const host = withVersionedState(
        {
          sync: async () => emptySync(),
          syncStructured: (cursor) => source.syncStructured(cursor as NotionDatabasesCursor),
        },
        notionDatabasesStateSpec,
        { sourceId: "notion-databases:fixture" },
      );
      const initial: NotionDatabasesCursor = {
        phase: "done",
        databases: ["first", "last"].map((id) => ({ id, title: id, lastEditedTime: prior })),
        currentDbIndex: 2,
        discoveredAt: start,
        lastSyncTime: prior,
        lastSnapshotAt: snapshot ? undefined : start,
      };
      const first = await host.syncStructured!(stored(initial, 2, true));
      changed = true;
      now = Date.parse(end);
      const last = await host.syncStructured!(first.cursor);
      expect(last.hasMore).toBe(false);
      expect(last.presentExternalIds !== undefined).toBe(snapshot);
      const replay = await host.syncStructured!(last.cursor);
      expect(replay.documents?.map((doc) => doc.externalId)).toContain("row-row");
      expect(query.mock.calls.at(-1)?.[2]).toBe("2026-06-01T11:58:00.000Z");
      const settled = await host.syncStructured!(replay.cursor);
      expect(settled.hasMore).toBe(false);
      expect(settled.presentExternalIds).toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps the prior floor for an installed mid-database pass (envelope: %s)",
    async (enveloped) => {
      const source = new NotionDatabasesSource(
        {
          getDatabase: async () => database("last"),
          queryDatabase: async () => listing([]),
        } as unknown as NotionClient,
        SourceId("notion-databases:fixture"),
        providerId,
      );
      const host = withVersionedState(
        {
          sync: async () => emptySync(),
          syncStructured: (cursor) => source.syncStructured(cursor as NotionDatabasesCursor),
        },
        notionDatabasesStateSpec,
        { sourceId: "notion-databases:fixture" },
      );
      const result = await host.syncStructured!(
        stored(
          {
            phase: "sync-db",
            databases: [{ id: "last", title: "Last", lastEditedTime: prior }],
            currentDbIndex: 0,
            lastSyncTime: prior,
          },
          2,
          enveloped,
        ),
      );
      expect(result.cursor).toMatchObject({ state: { phase: "done", lastSyncTime: prior } });
    },
  );

  it.each([false, true])(
    "keeps the search floor until unread pages are fetched, then replays a mid-pass edit (snapshot: %s)",
    async (snapshot) => {
      vi.useFakeTimers();
      vi.setSystemTime(start);
      let call = 0;
      const searchPages = vi.fn(
        async () =>
          [
            listing([page("early", start)], "next"),
            listing([
              page("unread", "2026-06-01T11:00:00.000Z"),
              page("late-edit", "2026-06-01T12:15:00.000Z"),
            ]),
            listing([page("early", edited), page("unread", "2026-06-01T11:00:00.000Z")]),
          ][call++],
      );
      const getPageContent = vi.fn(async (id: string) => ({ markdown: id, linkedPageIds: [] }));
      const source = new NotionPagesSource(
        { searchPages, getPageContent } as unknown as NotionClient,
        SourceId("notion-pages:fixture"),
        providerId,
      );
      const host = withVersionedState(
        { sync: (cursor) => source.sync(cursor as NotionPagesCursor) },
        notionPagesStateSpec,
        { sourceId: "notion-pages:fixture" },
      );
      const first = await host.sync(
        stored({ lastEditedTime: prior, lastSnapshotAt: snapshot ? undefined : start }, 1, true),
      );
      vi.setSystemTime(end);
      const second = await host.sync(first.cursor);
      expect(second.documents.map((doc) => doc.externalId)).toEqual([
        "page-unread",
        "page-lateedit",
      ]);
      expect(second.presentExternalIds !== undefined).toBe(snapshot);
      const replay = await host.sync(second.cursor);
      expect(replay.documents.map((doc) => doc.externalId)).toEqual(["page-early"]);
      expect(replay.presentExternalIds).toBeUndefined();
    },
  );

  it("finishes an installed bootstrap without inventing a start time", async () => {
    const query = vi.fn(async () => listing([]));
    const source = new NotionDatabasesSource(
      {
        getDatabase: async () => database("last"),
        queryDatabase: query,
        searchDatabases: async () => listing([database("last")]),
      } as unknown as NotionClient,
      SourceId("notion-databases:fixture"),
      providerId,
    );
    const host = withVersionedState(
      {
        sync: async () => emptySync(),
        syncStructured: (cursor) => source.syncStructured(cursor as NotionDatabasesCursor),
      },
      notionDatabasesStateSpec,
      { sourceId: "notion-databases:fixture" },
    );
    const result = await host.syncStructured!(
      stored(
        {
          phase: "sync-db",
          databases: [{ id: "last", title: "Last", lastEditedTime: prior }],
          currentDbIndex: 0,
        },
        2,
        true,
      ),
    );
    expect(result.cursor).toMatchObject({ state: { lastSyncTime: undefined } });
    const discovery = await host.syncStructured!(result.cursor);
    await host.syncStructured!(discovery.cursor);
    expect(query.mock.calls.at(-1)).toEqual(["last", undefined, undefined, "ds-last"]);
  });

  it.each([false, true])(
    "restarts an installed pending search without its advanced cutoff (envelope: %s)",
    async (enveloped) => {
      const searchPages = vi.fn(async () => listing([page("unread", prior)]));
      const source = new NotionPagesSource(
        {
          searchPages,
          getPageContent: async () => ({ markdown: "Recovered page", linkedPageIds: [] }),
        } as unknown as NotionClient,
        SourceId("notion-pages:fixture"),
        providerId,
      );
      const host = withVersionedState(
        { sync: (cursor) => source.sync(cursor as NotionPagesCursor) },
        notionPagesStateSpec,
        { sourceId: "notion-pages:fixture" },
      );
      const result = await host.sync(
        stored(
          { startCursor: "unread-page", lastEditedTime: start, lastSnapshotAt: start },
          1,
          enveloped,
        ),
      );
      expect(searchPages).toHaveBeenCalledWith(undefined);
      expect(result.documents.map((doc) => doc.externalId)).toEqual(["page-unread"]);
      expect(result.presentExternalIds).toEqual(["page-unread"]);
    },
  );
});
