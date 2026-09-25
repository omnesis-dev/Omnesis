// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import chromeBookmarks, { discoverProfiles, readBookmarksFile } from "./index.js";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(`/tmp/${prefix}-`);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

test("bookmarks remain exclusive until synced profile identity is authoritative", () => {
  expect(chromeBookmarks.multiDevice).toBeUndefined();
});

describe("discoverProfiles", () => {
  test("returns empty when no Local State file exists", () => {
    const dir = makeTmpDir("chrome-no-state");
    const profiles = discoverProfiles(dir);
    expect(profiles).toEqual([]);
  });

  test("parses valid JSON with profiles", () => {
    const dir = makeTmpDir("chrome-profiles");
    const localState = {
      profile: {
        info_cache: {
          Default: { user_name: "alice@example.com", name: "Alice" },
          "Profile 1": { user_name: "bob@example.com", name: "Bob" },
        },
      },
    };
    writeFileSync(join(dir, "Local State"), JSON.stringify(localState));

    const profiles = discoverProfiles(dir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({
      dir: "Default",
      name: "alice@example.com",
      email: "alice@example.com",
    });
    expect(profiles[1]).toEqual({
      dir: "Profile 1",
      name: "bob@example.com",
      email: "bob@example.com",
    });
  });

  test("handles invalid JSON gracefully (returns empty)", () => {
    const dir = makeTmpDir("chrome-bad-json");
    writeFileSync(join(dir, "Local State"), "not valid json {{{");

    const profiles = discoverProfiles(dir);
    expect(profiles).toEqual([]);
  });

  test("handles missing info_cache key", () => {
    const dir = makeTmpDir("chrome-no-cache");
    writeFileSync(join(dir, "Local State"), JSON.stringify({ profile: {} }));

    const profiles = discoverProfiles(dir);
    expect(profiles).toEqual([]);
  });
});

describe("readBookmarksFile", () => {
  test("returns null when file doesn't exist", () => {
    const result = readBookmarksFile("/tmp/nonexistent-bookmarks-file.json");
    expect(result).toBeNull();
  });

  test("parses valid bookmarks file", () => {
    const dir = makeTmpDir("chrome-bookmarks");
    const bookmarks = {
      checksum: "abc123",
      roots: {
        bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [] },
        other: { type: "folder", name: "Other bookmarks", children: [] },
        synced: { type: "folder", name: "Mobile bookmarks", children: [] },
      },
      version: 1,
    };
    const filePath = join(dir, "Bookmarks");
    writeFileSync(filePath, JSON.stringify(bookmarks));

    const result = readBookmarksFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.checksum).toBe("abc123");
    expect(result!.version).toBe(1);
  });

  test("returns null on bad JSON", () => {
    const dir = makeTmpDir("chrome-bad-bookmarks");
    const filePath = join(dir, "Bookmarks");
    writeFileSync(filePath, "not json");

    const result = readBookmarksFile(filePath);
    expect(result).toBeNull();
  });
});
