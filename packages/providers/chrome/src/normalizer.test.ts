// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { chromeTimestampToDate, normalizeBookmark } from "./normalizer.js";
import type { FlatBookmark } from "./types.js";

describe("chromeTimestampToDate", () => {
  test("converts Chrome timestamp to correct date", () => {
    // 13008119088000000 → 2013 (known value from real bookmarks)
    const date = chromeTimestampToDate("13008119088000000");
    expect(date.getUTCFullYear()).toBe(2013);
  });

  test("converts epoch 0 to 1601-01-01", () => {
    const date = chromeTimestampToDate("0");
    expect(date.getUTCFullYear()).toBe(1601);
  });

  test("converts known 2024 timestamp", () => {
    // 2024-01-01 00:00:00 UTC
    // Unix: 1704067200 seconds = 1704067200000 ms
    // Chrome: (1704067200000 * 1000) + 11644473600000000 = 13348540800000000
    const date = chromeTimestampToDate("13348540800000000");
    expect(date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("normalizeBookmark", () => {
  const baseBookmark: FlatBookmark = {
    title: "Example Page",
    url: "https://example.com/article",
    dateAdded: new Date("2024-03-08T00:00:00.000Z"),
    dateLastUsed: null,
    folderPath: "Bookmarks bar / Development",
    guid: "test-guid-123",
  };

  test("produces correct document fields", () => {
    const doc = normalizeBookmark(baseBookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.title).toBe("Example Page");
    expect(doc.externalId).toBe("https://example.com/article");
    expect(doc.providerId).toBe(ProviderId("chrome"));
    expect(doc.sourceId).toBe(SourceId("chrome-bookmarks"));
    expect(doc.contentHash).toBeDefined();
  });

  test("content includes title, URL, folder, and date", () => {
    const doc = normalizeBookmark(baseBookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.content).toContain("# Example Page");
    expect(doc.content).toContain("URL: https://example.com/article");
    expect(doc.content).toContain("Folder: Bookmarks bar / Development");
    expect(doc.content).toContain("Added: 2024-03-08");
  });

  test("sets correct metadata", () => {
    const doc = normalizeBookmark(baseBookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.metadata.documentType).toBe("bookmark");
    expect(doc.metadata.sourceUrl).toBe("https://example.com/article");
    expect(doc.metadata.extra?.domain).toBe("example.com");
    expect(doc.metadata.extra?.folderPath).toBe("Bookmarks bar / Development");
  });

  test("uses folder name as tag", () => {
    const doc = normalizeBookmark(baseBookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.metadata.tags).toEqual(["Development"]);
  });

  test("handles bookmark with no folder path", () => {
    const bookmark = { ...baseBookmark, folderPath: "" };
    const doc = normalizeBookmark(bookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.content).not.toContain("Folder:");
    expect(doc.metadata.tags).toBeUndefined();
    expect(doc.metadata.extra?.folderPath).toBeUndefined();
  });

  test("handles bookmark with dateLastUsed", () => {
    const bookmark = {
      ...baseBookmark,
      dateLastUsed: new Date("2024-06-01T12:00:00.000Z"),
    };
    const doc = normalizeBookmark(bookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.metadata.extra?.dateLastUsed).toBe("2024-06-01T12:00:00.000Z");
  });

  test("uses Untitled for empty title", () => {
    const bookmark = { ...baseBookmark, title: "" };
    const doc = normalizeBookmark(bookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.title).toBe("Untitled");
  });

  test("sets sourceCreatedAt from dateAdded", () => {
    const doc = normalizeBookmark(baseBookmark, ProviderId("chrome"), SourceId("chrome-bookmarks"));
    expect(doc.sourceCreatedAt).toBe("2024-03-08T00:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2024-03-08T00:00:00.000Z");
  });

  test("uses fileMtime as sourceUpdatedAt floor when newer than dateAdded (rename/move regression)", () => {
    // Reproduces chrome-bookmarks-rename-doesnt-bump-updated-at: a rename
    // or folder-move bumps the Bookmarks file's mtime but Chrome doesn't
    // record a per-bookmark modification timestamp. Without the floor,
    // the doc's sourceUpdatedAt stays at dateAdded forever.
    const fileMtime = new Date("2026-04-26T15:55:00.000Z");
    const doc = normalizeBookmark(
      baseBookmark,
      ProviderId("chrome"),
      SourceId("chrome-bookmarks"),
      fileMtime,
    );
    expect(doc.sourceCreatedAt).toBe("2024-03-08T00:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-04-26T15:55:00.000Z");
  });

  test("ignores fileMtime when older than dateAdded (sanity check)", () => {
    const fileMtime = new Date("2020-01-01T00:00:00.000Z");
    const doc = normalizeBookmark(
      baseBookmark,
      ProviderId("chrome"),
      SourceId("chrome-bookmarks"),
      fileMtime,
    );
    expect(doc.sourceUpdatedAt).toBe("2024-03-08T00:00:00.000Z");
  });

  test("multi-folder filing surfaces every leaf as a tag", () => {
    const doc = normalizeBookmark(
      baseBookmark,
      ProviderId("chrome"),
      SourceId("chrome-bookmarks"),
      undefined,
      ["Other bookmarks / Reading list", "Mobile bookmarks / Inbox"],
    );
    expect(doc.metadata.tags).toEqual(["Development", "Reading list", "Inbox"]);
    expect(doc.content).toContain(
      "Folders: Bookmarks bar / Development; Other bookmarks / Reading list; Mobile bookmarks / Inbox",
    );
    expect(doc.metadata.extra?.folderPath).toBe("Bookmarks bar / Development");
    expect(doc.metadata.extra?.folderPaths).toEqual([
      "Bookmarks bar / Development",
      "Other bookmarks / Reading list",
      "Mobile bookmarks / Inbox",
    ]);
  });

  test("multi-folder dedupes identical folder paths and tag leaves", () => {
    const doc = normalizeBookmark(
      baseBookmark,
      ProviderId("chrome"),
      SourceId("chrome-bookmarks"),
      undefined,
      ["Bookmarks bar / Development", "Other bookmarks / Development"],
    );
    expect(doc.metadata.tags).toEqual(["Development"]);
    expect(doc.metadata.extra?.folderPaths).toEqual([
      "Bookmarks bar / Development",
      "Other bookmarks / Development",
    ]);
  });
});
