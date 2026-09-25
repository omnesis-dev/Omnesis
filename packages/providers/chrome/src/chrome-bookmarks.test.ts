// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { type SourceInstance } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { webPageEdgeTarget } from "@omnesis/core";
import {
  readBookmarksFile,
  normalizeBookmark,
  bookmarkWebpageEdge,
  chromeTimestampToDate,
} from "./index.js";
import type {
  ChromeBookmarksFile,
  ChromeBookmarksCursor,
  ChromeBookmarkEntry,
  FlatBookmark,
} from "./types.js";

// Chrome timestamp for 2024-03-08 00:00:00 UTC
const CHROME_TS_2024_03_08 = "13348540800000000";
const CHROME_TS_2024_03_09 = "13348627200000000";

function makeBookmarksFile(overrides?: Partial<ChromeBookmarksFile>): ChromeBookmarksFile {
  return {
    checksum: "test-checksum-1",
    version: 1,
    roots: {
      bookmark_bar: {
        name: "Bookmarks bar",
        type: "folder",
        date_added: CHROME_TS_2024_03_08,
        id: "1",
        children: [],
      },
      other: {
        name: "Other bookmarks",
        type: "folder",
        date_added: CHROME_TS_2024_03_08,
        id: "2",
        children: [],
      },
      synced: {
        name: "Mobile bookmarks",
        type: "folder",
        date_added: CHROME_TS_2024_03_08,
        id: "3",
        children: [],
      },
    },
    ...overrides,
  };
}

/**
 * Recursively flatten a Chrome bookmark tree into a flat list.
 * Mirrors the logic in index.ts for test independence.
 */
function flattenBookmarks(node: ChromeBookmarkEntry, path = ""): FlatBookmark[] {
  const results: FlatBookmark[] = [];
  const currentPath = path ? `${path} / ${node.name}` : node.name;

  if (node.type === "url" && node.url) {
    const dateAdded = chromeTimestampToDate(node.date_added);
    const dateLastUsed =
      node.date_last_used && node.date_last_used !== "0"
        ? chromeTimestampToDate(node.date_last_used)
        : null;

    results.push({
      title: node.name,
      url: node.url,
      dateAdded,
      dateLastUsed,
      folderPath: path,
      guid: node.guid,
    });
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...flattenBookmarks(child, currentPath));
    }
  }

  return results;
}

/**
 * Create a test SourceInstance that reads bookmarks from a given path.
 * This mirrors the sync logic from the definition's create() method.
 */
function createTestInstance(bookmarksPath: string): SourceInstance {
  const providerId = ProviderId("chrome:test");
  const sourceId = SourceId("chrome-bookmarks:test");

  return {
    watchPaths: [bookmarksPath],

    async sync(cursor) {
      const bookmarksFile = readBookmarksFile(bookmarksPath);
      if (!bookmarksFile) {
        return { documents: [], deletedExternalIds: [], cursor: cursor ?? {}, hasMore: false };
      }

      const state = cursor as unknown as ChromeBookmarksCursor | null;

      if (state?.fileChecksum && state.fileChecksum === bookmarksFile.checksum) {
        return { documents: [], deletedExternalIds: [], cursor: state, hasMore: false };
      }

      const flatBookmarks = [
        ...flattenBookmarks(bookmarksFile.roots.bookmark_bar),
        ...flattenBookmarks(bookmarksFile.roots.other),
        ...flattenBookmarks(bookmarksFile.roots.synced),
      ];

      const documents = [];
      const edges = [];
      const currentIds = new Set<string>();

      for (const bookmark of flatBookmarks) {
        currentIds.add(bookmark.url);
        documents.push(normalizeBookmark(bookmark, providerId, sourceId));
        edges.push(bookmarkWebpageEdge(bookmark));
      }

      const previousIds = new Set(state?.knownIds ?? []);
      const deletedExternalIds: string[] = [];
      for (const id of previousIds) {
        if (!currentIds.has(id)) deletedExternalIds.push(id);
      }

      const newCursor: ChromeBookmarksCursor = {
        fileChecksum: bookmarksFile.checksum,
        knownIds: [...currentIds],
      };

      return { documents, deletedExternalIds, edges, cursor: newCursor, hasMore: false };
    },
  };
}

describe("ChromeBookmarks sync", () => {
  let tmpDir: string;
  let bookmarksPath: string;
  let instance: SourceInstance;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "chrome-bookmarks-test-"));
    const profileDir = join(tmpDir, "Default");
    mkdirSync(profileDir, { recursive: true });
    bookmarksPath = join(profileDir, "Bookmarks");

    // Write empty bookmarks file
    writeFileSync(bookmarksPath, JSON.stringify(makeBookmarksFile()));
    instance = createTestInstance(bookmarksPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty result when no bookmarks", async () => {
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("syncs a single bookmark", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Example",
        url: "https://example.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
        guid: "guid-1",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toBe("Example");
    expect(doc.externalId).toBe("https://example.com");
    expect(doc.metadata.documentType).toBe("bookmark");
    expect(doc.metadata.sourceUrl).toBe("https://example.com");
    expect(doc.content).toContain("# Example");
    expect(doc.content).toContain("URL: https://example.com");
  });

  test("declares a `bookmarks → webpage` edge for each bookmark (#895)", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Example",
        url: "https://example.com/article",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
        guid: "guid-1",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const result = await instance.sync(null);
    expect(result.edges).toBeDefined();
    expect(result.edges).toHaveLength(1);
    const edge = result.edges![0];
    expect(edge.type).toBe("bookmarks");
    // `from` is the bookmark doc this source emits (internal, keyed on URL).
    expect(edge.from).toEqual({
      kind: "internal",
      sourceDocumentId: "https://example.com/article",
    });
    // `to` is the canonical `web` entity, keyed on SHA256(normalizeUrl(url)).
    expect(edge.to).toEqual(webPageEdgeTarget("https://example.com/article"));
  });

  test("syncs bookmarks from multiple root folders", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Bar Bookmark",
        url: "https://bar.example.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
      },
    ];
    file.roots.other.children = [
      {
        name: "Other Bookmark",
        url: "https://other.example.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "11",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(2);
    const urls = result.documents.map((d) => d.externalId);
    expect(urls).toContain("https://bar.example.com");
    expect(urls).toContain("https://other.example.com");
  });

  test("preserves folder path in metadata", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Dev",
        type: "folder",
        date_added: CHROME_TS_2024_03_08,
        id: "20",
        children: [
          {
            name: "TypeScript Docs",
            url: "https://typescriptlang.org",
            type: "url",
            date_added: CHROME_TS_2024_03_08,
            id: "21",
          },
        ],
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra?.folderPath).toBe("Bookmarks bar / Dev");
    expect(result.documents[0].metadata.tags).toEqual(["Dev"]);
  });

  test("skips sync when checksum unchanged", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Example",
        url: "https://example.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Sync again with same cursor -- should skip
    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.deletedExternalIds).toHaveLength(0);
  });

  test("detects new bookmarks on checksum change", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "First",
        url: "https://first.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Add a bookmark and change checksum
    file.checksum = "test-checksum-2";
    file.roots.bookmark_bar.children!.push({
      name: "Second",
      url: "https://second.com",
      type: "url",
      date_added: CHROME_TS_2024_03_09,
      id: "11",
    });
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(2); // full re-sync on checksum change
  });

  test("detects deleted bookmarks", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Will Delete",
        url: "https://delete-me.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "10",
      },
      {
        name: "Will Keep",
        url: "https://keep-me.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "11",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(2);

    // Remove one bookmark
    file.checksum = "test-checksum-2";
    file.roots.bookmark_bar.children = [
      {
        name: "Will Keep",
        url: "https://keep-me.com",
        type: "url",
        date_added: CHROME_TS_2024_03_08,
        id: "11",
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const r2 = await instance.sync(r1.cursor);
    expect(r2.deletedExternalIds).toContain("https://delete-me.com");
    expect(r2.documents).toHaveLength(1);
  });

  test("handles nested folders", async () => {
    const file = makeBookmarksFile();
    file.roots.bookmark_bar.children = [
      {
        name: "Level 1",
        type: "folder",
        date_added: CHROME_TS_2024_03_08,
        id: "20",
        children: [
          {
            name: "Level 2",
            type: "folder",
            date_added: CHROME_TS_2024_03_08,
            id: "21",
            children: [
              {
                name: "Deep Bookmark",
                url: "https://deep.example.com",
                type: "url",
                date_added: CHROME_TS_2024_03_08,
                id: "22",
              },
            ],
          },
        ],
      },
    ];
    writeFileSync(bookmarksPath, JSON.stringify(file));

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra?.folderPath).toBe(
      "Bookmarks bar / Level 1 / Level 2",
    );
  });

  test("watchPaths includes bookmarks file", () => {
    expect(instance.watchPaths).toHaveLength(1);
    expect(instance.watchPaths![0]).toContain("Bookmarks");
  });
});
