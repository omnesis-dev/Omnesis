// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { type SourceState, withVersionedState } from "@omnesis/source-sdk";
import { outlookEmailStateSpec } from "./state.js";
import {
  createMockGraph,
  createOutlookEmailSource,
  makeOutlookMessage,
  makeMailFolder,
} from "./testing/mock-outlook.js";
import type { OutlookEmailCursor } from "./outlook-types.js";

const cutoff = "2026-01-01T00:00:00.000Z";
const recent = "2026-05-01T00:00:00.000Z";

describe("Outlook mail delta handoff", () => {
  it.each([
    "fresh",
    "paused-bare",
    "paused-envelope",
    "missing-token-bare",
    "missing-token-envelope",
  ])("drains cutoff pages and replays mid-walk changes (%s)", async (shape) => {
    const graph = createMockGraph();
    let changed = false;
    let caughtUp = false;
    const old = makeOutlookMessage("old", { receivedDateTime: "2020-01-01T00:00:00Z" });
    delete old.body;
    graph.get = vi.fn(async (url: string) => {
      if (url.includes("/me/mailFolders?")) return { value: [makeMailFolder("inbox")] };
      if (url === "page-two")
        return {
          value: [makeOutlookMessage("later", { receivedDateTime: recent })],
          "@odata.deltaLink": "walk-delta",
        };
      if (url === "walk-delta") {
        expect(changed).toBe(true);
        caughtUp = true;
        return {
          value: [
            makeOutlookMessage("early", {
              receivedDateTime: recent,
              subject: "Changed during walk",
            }),
            { id: "deleted", "@removed": { reason: "deleted" } },
          ],
          "@odata.deltaLink": "caught-up",
        };
      }
      if (url === "caught-up") return { value: [], "@odata.deltaLink": "caught-up" };
      if (url === "saved-page" || url.includes("/messages/delta"))
        return {
          value: [makeOutlookMessage("early", { receivedDateTime: recent }), old],
          "@odata.nextLink": "page-two",
        };
      return { value: [] };
    });
    const source = createOutlookEmailSource(graph, {
      dataCutoff: cutoff,
      accountId: "fixture@example.com",
    });
    const host = withVersionedState(
      { sync: (cursor) => source.sync(cursor as OutlookEmailCursor) },
      outlookEmailStateSpec,
      { sourceId: "outlook-email:fixture@example.com" },
    );
    const state: OutlookEmailCursor = shape.startsWith("missing")
      ? { phase: "incremental", folderDeltas: {} }
      : {
          phase: "bootstrap",
          folderDeltas: {},
          folderIds: ["inbox"],
          currentFolderIndex: 0,
          currentPageLink: shape.startsWith("paused") ? "saved-page" : undefined,
        };
    let cursor: SourceState | null =
      shape === "fresh" ? null : shape.endsWith("envelope") ? { e: 1, v: 1, state } : state;
    let first;
    for (let i = 0; i < 3; i++) {
      first = await host.sync(cursor);
      cursor = first.cursor;
      if (first.documents.some((doc) => doc.externalId === "early")) break;
    }
    expect(first?.documents.map((doc) => doc.externalId)).toEqual(["early"]);
    expect(first?.hasMore).toBe(true);
    expect(cursor).toMatchObject({ state: { currentPageLink: "page-two", backfillIds: [] } });
    changed = true;
    const finish = await host.sync(cursor);
    expect(finish.documents.map((doc) => doc.externalId)).toEqual(["later"]);
    expect(finish.hasMore).toBe(false);
    const replay = await host.sync(finish.cursor);
    expect(caughtUp).toBe(true);
    expect(replay.documents.map((doc) => doc.externalId)).toEqual(["early"]);
    expect(replay.documents[0].title).toBe("Changed during walk");
    expect(replay.deletedExternalIds).toEqual(["deleted"]);
    expect(replay.presentExternalIds).toBeUndefined();
    const idle = await host.sync(replay.cursor);
    expect(idle.documents).toEqual([]);
    expect(idle.hasMore).toBe(false);
  });
});
