// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { rowsFor, tablesWritten, writesFor } from "@omnesis/source-sdk/testing";
import { GranolaMeetingsSource, maxIso, type GranolaMeetingsSourceOptions } from "./meetings.js";
import type { GranolaClient, ListNotesParams } from "./client.js";
import type { GranolaNoteDetail, GranolaNoteSummary, GranolaNotesListResponse } from "./types.js";

const providerId = ProviderId("granola:alice@example.com");
const sourceId = SourceId("granola-meetings");
const NOW = "2026-06-02T00:00:00.000Z";

function summary(
  id: string,
  updatedAt: string,
  createdAt = "2026-05-01T00:00:00.000Z",
): GranolaNoteSummary {
  return {
    id,
    object: "note",
    title: `Note ${id}`,
    owner: { name: "Alice", email: "alice@example.com" },
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function detail(id: string): GranolaNoteDetail {
  return {
    id,
    object: "note",
    title: `Note ${id}`,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T10:05:00.000Z",
    web_url: `https://granola.ai/notes/${id}`,
    summary_text: "summary",
    summary_markdown: null,
    transcript: null,
    owner: { name: "Alice", email: "alice@example.com" },
    attendees: [],
    calendar_event: null,
    folder_membership: [],
  };
}

class FakeClient {
  listCalls: ListNotesParams[] = [];
  getCalls: string[] = [];
  constructor(
    private pages: GranolaNotesListResponse[],
    private failGetNote = false,
    private notFoundIds: ReadonlySet<string> = new Set(),
  ) {}
  async listNotes(params: ListNotesParams = {}): Promise<GranolaNotesListResponse> {
    this.listCalls.push(params);
    return this.pages.shift() ?? { notes: [], hasMore: false, cursor: null };
  }
  async getNote(id: string): Promise<GranolaNoteDetail> {
    this.getCalls.push(id);
    if (this.notFoundIds.has(id)) {
      throw new SyncError("unknown", `Granola note not found (HTTP 404): ${id}`, {
        scope: "item",
      });
    }
    if (this.failGetNote) throw new SyncError("transient", "boom");
    return detail(id);
  }
}

function makeSource(
  client: FakeClient,
  dataCutoff?: string,
  options: GranolaMeetingsSourceOptions = {},
): GranolaMeetingsSource {
  return new GranolaMeetingsSource(
    client as unknown as GranolaClient,
    providerId,
    sourceId,
    dataCutoff,
    ACCOUNT_ID,
    { now: () => NOW, ...options },
  );
}

const ACCOUNT_ID = "maya.reeves@example.com";

describe("GranolaMeetingsSource.syncStructured", () => {
  test("empty incremental listings retain previously indexed notes and rows without claiming absence", async () => {
    const source = makeSource(
      new FakeClient([
        {
          notes: [summary("retained-note", "2026-06-01T08:00:00.000Z")],
          hasMore: false,
          cursor: null,
        },
      ]),
    );
    const first = await source.syncStructured(null);
    expect(first.documents).toHaveLength(1);
    let cursor = first.cursor;
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await source.syncStructured(cursor);
      expect(result.documents).toEqual([]);
      expect(result.deletedExternalIds ?? []).toEqual([]);
      expect(result.presentExternalIds).toBeUndefined();
      expect(result.presentClaims).toBeUndefined();
      expect(writesFor(result, "granola_meetings")).toEqual([]);
      cursor = result.cursor;
    }
  });
  test("backfill paginates across pages then switches to incremental", async () => {
    const client = new FakeClient([
      {
        notes: [
          summary("not_1", "2026-06-01T08:00:00.000Z"),
          summary("not_2", "2026-06-01T10:05:00.000Z"),
        ],
        hasMore: true,
        cursor: "page2",
      },
      { notes: [summary("not_3", "2026-05-30T00:00:00.000Z")], hasMore: false, cursor: null },
    ]);
    const source = makeSource(client);

    // First page.
    const r1 = await source.syncStructured(null);
    expect(tablesWritten(r1)).toEqual(["granola_meetings"]);
    expect(rowsFor(r1, "granola_meetings")).toHaveLength(2);
    expect(r1.documents).toHaveLength(2);
    expect(r1.hasMore).toBe(true);
    expect(r1.presentExternalIds).toBeUndefined();
    expect(r1.issues).toBeUndefined();
    expect(writesFor(r1, "granola_meetings")[0]?.presentIds).toBeUndefined();
    expect(r1.cursor.phase).toBe("backfill");
    expect(r1.cursor.pageCursor).toBe("page2");
    expect(client.listCalls[0].cursor).toBeUndefined();
    expect(client.listCalls[0].updatedAfter).toBeUndefined();

    // Second (final) page.
    const r2 = await source.syncStructured(r1.cursor);
    expect(client.listCalls[1].cursor).toBe("page2");
    expect(rowsFor(r2, "granola_meetings")).toHaveLength(1);
    expect(r2.hasMore).toBe(false);
    expect(r2.cursor.phase).toBe("incremental");
    expect(r2.cursor.pageCursor).toBeNull();
    // Watermark is the newest updated_at seen across the whole sweep.
    expect(r2.cursor.syncedUpTo).toBe("2026-06-01T10:05:00.000Z");
    expect(client.getCalls).toEqual(["not_1", "not_2", "not_3"]);
    expect(r2.presentExternalIds).toEqual(["not_1", "not_2", "not_3"]);
    expect(writesFor(r2, "granola_meetings")[0]?.presentIds).toEqual(r2.presentExternalIds);
    expect(r2.cursor.lastSnapshotAt).toBe(NOW);
    expect(r2.issues).toEqual([]);
  });

  test("incremental sweep filters with updated_after = watermark", async () => {
    const client = new FakeClient([{ notes: [], hasMore: false, cursor: null }]);
    const source = makeSource(client);

    const r = await source.syncStructured({
      phase: "incremental",
      syncedUpTo: "2026-06-01T10:05:00.000Z",
      lastSnapshotAt: NOW,
    });
    expect(client.listCalls[0].updatedAfter).toBe("2026-06-01T10:05:00.000Z");
    expect(r.issues).toBeUndefined();
    expect(rowsFor(r, "granola_meetings")).toHaveLength(0);
    expect(r.cursor.phase).toBe("incremental");
    // Watermark is preserved when nothing new arrives.
    expect(r.cursor.syncedUpTo).toBe("2026-06-01T10:05:00.000Z");
    expect(r.presentExternalIds).toBeUndefined();
  });

  test("skips notes created before the data cutoff without fetching detail", async () => {
    const client = new FakeClient([
      {
        notes: [
          summary("not_old", "2026-06-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"),
          summary("not_new", "2026-06-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z"),
        ],
        hasMore: false,
        cursor: null,
      },
    ]);
    const source = makeSource(client, "2026-01-01T00:00:00.000Z");

    const r = await source.syncStructured(null);
    expect(rowsFor(r, "granola_meetings")).toHaveLength(1);
    expect(client.getCalls).toEqual(["not_new"]);
  });

  test("propagates a detail-fetch error", async () => {
    const client = new FakeClient(
      [{ notes: [summary("not_1", "2026-06-01T00:00:00.000Z")], hasMore: false, cursor: null }],
      true,
    );
    const source = makeSource(client);
    await expect(source.syncStructured(null)).rejects.toMatchObject({ kind: "transient" });
  });

  test("skips a note that 404s between the list page and the detail fetch, keeping its siblings", async () => {
    const client = new FakeClient(
      [
        {
          notes: [
            summary("not_1", "2026-06-01T08:00:00.000Z"),
            summary("not_deleted", "2026-06-01T09:00:00.000Z"),
            summary("not_3", "2026-06-01T10:05:00.000Z"),
          ],
          hasMore: false,
          cursor: null,
        },
      ],
      false,
      new Set(["not_deleted"]),
    );
    const source = makeSource(client);

    const r = await source.syncStructured(null);
    expect(rowsFor(r, "granola_meetings")).toHaveLength(2);
    expect(rowsFor(r, "granola_meetings").map((row) => row.id)).toEqual(["not_1", "not_3"]);
    expect(r.documents).toHaveLength(2);
    // The watermark still advances past the skipped note's updated_at — it
    // was seen in the list page even though its detail was unreachable.
    expect(r.cursor.syncedUpTo).toBe("2026-06-01T10:05:00.000Z");
    expect(r.presentExternalIds).toContain("not_deleted");
    expect(writesFor(r, "granola_meetings")[0]?.presentIds).toContain("not_deleted");
  });

  test("an overdue full rewalk drops the update filter and names the same set in both planes", async () => {
    const client = new FakeClient([
      { notes: [summary("kept", "2026-05-01T00:00:00.000Z")], hasMore: false, cursor: null },
    ]);
    const result = await makeSource(client).syncStructured({
      phase: "incremental",
      syncedUpTo: "2026-06-01T10:05:00.000Z",
      lastSnapshotAt: "2026-05-01T00:00:00.000Z",
    });
    expect(client.listCalls[0].updatedAfter).toBeUndefined();
    expect(result.presentExternalIds).toEqual(["kept"]);
    expect(writesFor(result, "granola_meetings")[0]?.presentIds).toEqual(["kept"]);
    expect(result.cursor.syncedUpTo).toBe("2026-06-01T10:05:00.000Z");
  });

  test("an empty completed rewalk supplies empty snapshots to both planes", async () => {
    const result = await makeSource(new FakeClient([])).syncStructured({
      phase: "incremental",
      syncedUpTo: NOW,
    });
    expect(result.presentExternalIds).toEqual([]);
    expect(writesFor(result, "granola_meetings")[0]?.presentIds).toEqual([]);
  });

  test.each([null, "page-2"])(
    "refuses non-advancing pagination (%s) without modifying the incoming cursor",
    async (next) => {
      const cursor = {
        phase: "snapshot" as const,
        pageCursor: "page-2",
        pageCursors: ["page-2"],
        snapshot: { ids: { notes: ["kept"] } },
      };
      const stored = structuredClone(cursor);
      const source = makeSource(new FakeClient([{ notes: [], hasMore: true, cursor: next }]));
      await expect(source.syncStructured(cursor)).rejects.toThrow("pagination did not advance");
      expect(cursor).toEqual(stored);
    },
  );

  test("fails closed on a multi-token pagination loop", async () => {
    const source = makeSource(new FakeClient([{ notes: [], hasMore: true, cursor: "page-1" }]));
    await expect(
      source.syncStructured({
        phase: "snapshot",
        pageCursor: "page-2",
        pageCursors: ["page-1", "page-2"],
        snapshot: {},
      }),
    ).rejects.toThrow("pagination did not advance");
  });

  test("fails closed when a snapshot exceeds the item cap", async () => {
    const source = makeSource(
      new FakeClient([{ notes: [summary("new", NOW)], hasMore: false, cursor: null }]),
      undefined,
      { maxSnapshotItems: 1 },
    );
    await expect(
      source.syncStructured({
        phase: "snapshot",
        pageCursor: "page-2",
        snapshot: { ids: { notes: ["old"] } },
      }),
    ).rejects.toThrow("safe item limit");
  });

  test("fails closed when a sweep exceeds the page cap", async () => {
    const source = makeSource(new FakeClient([]), undefined, { maxSweepPages: 1 });
    await expect(
      source.syncStructured({ phase: "snapshot", pageCursor: "page-2", snapshot: {} }),
    ).rejects.toThrow("safe page limit");
  });

  test("a failing detail page cannot publish an incomplete snapshot or advance the incoming ledger", async () => {
    const source = makeSource(
      new FakeClient([{ notes: [summary("new", NOW)], hasMore: false, cursor: null }], true),
    );
    const cursor = {
      phase: "snapshot" as const,
      pageCursor: "page-2",
      snapshot: { ids: { notes: ["old"] } },
    };
    await expect(source.syncStructured(cursor)).rejects.toMatchObject({ kind: "transient" });
    expect(cursor.snapshot.ids.notes).toEqual(["old"]);
  });
});

describe("maxIso", () => {
  test("returns the later timestamp, tolerating undefined", () => {
    expect(maxIso(undefined, "b")).toBe("b");
    expect(maxIso("a", undefined)).toBe("a");
    expect(maxIso("2026-01-01", "2026-02-01")).toBe("2026-02-01");
  });
});
