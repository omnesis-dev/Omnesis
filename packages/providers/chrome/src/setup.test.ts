// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import definition, { discoverProfiles } from "./index.js";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(`/tmp/${prefix}-`);
  tmpDirs.push(dir);
  return dir;
}

function createChromeProfile(
  basePath: string,
  profileDir: string,
  opts?: { email?: string; withBookmarks?: boolean },
) {
  // Create Local State with profile info
  const localStatePath = join(basePath, "Local State");
  let localState: { profile: { info_cache: Record<string, { user_name: string; name: string }> } };
  if (existsSync(localStatePath)) {
    localState = JSON.parse(readFileSync(localStatePath, "utf-8"));
  } else {
    localState = { profile: { info_cache: {} } };
  }
  localState.profile.info_cache[profileDir] = {
    user_name: opts?.email ?? `user@example.com`,
    name: opts?.email ?? "User",
  };
  writeFileSync(localStatePath, JSON.stringify(localState));

  // Create profile dir with optional Bookmarks file
  const profilePath = join(basePath, profileDir);
  mkdirSync(profilePath, { recursive: true });
  if (opts?.withBookmarks !== false) {
    writeFileSync(
      join(profilePath, "Bookmarks"),
      JSON.stringify({
        checksum: "abc",
        roots: {
          bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [] },
          other: { type: "folder", name: "Other", children: [] },
          synced: { type: "folder", name: "Synced", children: [] },
        },
        version: 1,
      }),
    );
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("chrome definition", () => {
  test("has correct type and metadata", () => {
    expect(definition.type).toBe("source");
    expect(definition.id).toBe("chrome-bookmarks");
    expect(definition.name).toBe("Chrome Bookmarks");
    expect(definition.authType).toBe("local");
    expect(definition.unitName).toBe("bookmarks");
  });

  test("provider field is correct", () => {
    expect(definition.provider).toEqual({ id: "chrome", name: "Google Chrome" });
  });

  test("has discover function", () => {
    expect(typeof definition.discover).toBe("function");
  });

  test("has create function", () => {
    expect(typeof definition.create).toBe("function");
  });

  test("has icon with hosted url", () => {
    expect(definition.icon).toBeDefined();
    expect(definition.icon!.url).toMatch(/^https:\/\//);
  });

  test("treats bookmark URLs as references, not document identity", () => {
    expect(definition.urlHub).toBe(true);
    expect(definition.urlTargetRole).toBe("reference");
  });
});

describe("chrome setup - profile discovery", () => {
  test("returns no providers when no profiles found", () => {
    const dir = makeTmpDir("chrome-setup-empty");
    const profiles = discoverProfiles(dir);
    expect(profiles).toEqual([]);
  });

  test("discovers multiple profiles with bookmarks", () => {
    const dir = makeTmpDir("chrome-setup-profiles");
    createChromeProfile(dir, "Default", { email: "alice@example.com", withBookmarks: true });
    createChromeProfile(dir, "Profile 1", { email: "bob@example.com", withBookmarks: true });

    const profiles = discoverProfiles(dir);
    expect(profiles).toHaveLength(2);
  });

  test("discoverProfiles returns profiles with correct structure", () => {
    const dir = makeTmpDir("chrome-setup-structure");
    createChromeProfile(dir, "Default", { email: "test@example.com" });

    const profiles = discoverProfiles(dir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].dir).toBe("Default");
    expect(profiles[0].email).toBe("test@example.com");
    expect(profiles[0].name).toBe("test@example.com");
  });
});

describe("chrome create() — per-profile resolution", () => {
  function writeBookmarks(profilePath: string, urls: string[]) {
    writeFileSync(
      join(profilePath, "Bookmarks"),
      JSON.stringify({
        checksum: profilePath,
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            children: urls.map((u, i) => ({
              type: "url",
              name: `bm-${i}`,
              url: u,
              date_added: "13345000000000000",
              guid: `guid-${u}`,
            })),
          },
          other: { type: "folder", name: "Other", children: [] },
          synced: { type: "folder", name: "Synced", children: [] },
        },
        version: 1,
      }),
    );
  }

  test("resolves profileDir by matching accountId against the Local State email", async () => {
    // Reproduces chrome-bookmarks-all-profiles-read-default: previously every
    // source for every profile fell through to "Default", so non-Default
    // bookmarks were never indexed and Profile N saw Default's bookmarks.
    const base = makeTmpDir("chrome-create-multi");
    createChromeProfile(base, "Default", { email: "alice@example.com" });
    createChromeProfile(base, "Profile 1", { email: "bob@example.com" });
    writeBookmarks(join(base, "Default"), ["https://alice.example.com/A"]);
    writeBookmarks(join(base, "Profile 1"), ["https://bob.example.com/B"]);

    const instance = await definition.create!({
      accountId: "bob@example.com",
      sourceId: "chrome-bookmarks:bob@example.com" as any,
      providerId: "chrome:bob@example.com" as any,
      config: { basePath: base },
    });
    const result = await instance.sync(null);
    const urls = result.documents.map((d) => d.metadata.sourceUrl);
    expect(urls).toEqual(["https://bob.example.com/B"]);
  });

  test("an explicitly configured profile folder overrides email-based discovery", async () => {
    const base = makeTmpDir("chrome-create-override");
    createChromeProfile(base, "Default", { email: "alice@example.com" });
    createChromeProfile(base, "Profile 1", { email: "bob@example.com" });
    writeBookmarks(join(base, "Default"), ["https://override.example.com/X"]);
    writeBookmarks(join(base, "Profile 1"), ["https://bob.example.com/B"]);

    // accountId says bob, but explicit profileDir forces Default.
    const instance = await definition.create!({
      accountId: "bob@example.com",
      sourceId: "chrome-bookmarks:bob@example.com" as any,
      providerId: "chrome:bob@example.com" as any,
      config: { basePath: base, profileDir: "Default" },
    });
    const result = await instance.sync(null);
    expect(result.documents.map((d) => d.metadata.sourceUrl)).toEqual([
      "https://override.example.com/X",
    ]);
  });

  test("unmatched accountId falls back to Default (with logged warning)", async () => {
    const base = makeTmpDir("chrome-create-fallback");
    createChromeProfile(base, "Default", { email: "alice@example.com" });
    writeBookmarks(join(base, "Default"), ["https://alice.example.com/A"]);

    const instance = await definition.create!({
      accountId: "stranger@example.com",
      sourceId: "chrome-bookmarks:stranger@example.com" as any,
      providerId: "chrome:stranger@example.com" as any,
      config: { basePath: base },
    });
    const result = await instance.sync(null);
    expect(result.documents.map((d) => d.metadata.sourceUrl)).toEqual([
      "https://alice.example.com/A",
    ]);
  });
});
