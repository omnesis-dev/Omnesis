// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { expect, test } from "vitest";
import { getBrowserInfo } from "./paths.js";
import { ChromiumHistoryReader, msToChromiumTimestamp } from "./readers/chromium.js";

test("the discovered Arc on Windows package layout feeds the real Chromium history reader", () => {
  const root = mkdtempSync(join(tmpdir(), "arc-windows-history-"));
  const localAppData = "D:\\invented app data";
  const suffix = "Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data";
  const expected = win32.join(localAppData, suffix);
  const baseDir = join(root, ...suffix.split("\\"));
  const profile = "Profile 3";
  let reader: ChromiumHistoryReader | undefined;
  try {
    mkdirSync(join(baseDir, profile), { recursive: true });
    writeFileSync(
      join(baseDir, "Local State"),
      JSON.stringify({
        profile: { info_cache: { [profile]: { name: "fictional profile" } } },
      }),
    );
    const db = new SqliteDatabase(join(baseDir, profile, "History"));
    const at = Date.UTC(2026, 0, 2, 12);
    try {
      db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER);
        CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER,
          visit_duration INTEGER, transition INTEGER, is_known_to_sync INTEGER, originator_cache_guid TEXT);
        CREATE TABLE visit_source(id INTEGER, source INTEGER);`);
      db.prepare("INSERT INTO urls VALUES (1, ?, ?, 0)").run(
        "https://example.org/invented",
        "Invented visit",
      );
      db.prepare("INSERT INTO visits VALUES (1, 1, ?, 0, 1, 0, NULL)").run(
        msToChromiumTimestamp(at),
      );
    } finally {
      db.close();
    }
    const fixturePath = (path: string): string => {
      const relative = win32.relative(expected, path);
      if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative))
        return join(root, "absent");
      return join(baseDir, ...relative.split("\\"));
    };
    const discovered = getBrowserInfo("arc", {
      platform: "win32",
      home: "C:\\Users\\Example",
      localAppData,
      exists: (path) => existsSync(fixturePath(path)),
      readText: (path) => readFileSync(fixturePath(path), "utf8"),
    });
    expect(discovered).toEqual({ id: "arc", name: "Arc", engine: "chromium", baseDir: expected });
    // Use the host-native spelling of the same owned fixture on POSIX runners.
    reader = new ChromiumHistoryReader({ ...discovered!, baseDir });
    const result = reader.readVisits({}, 0, 10);
    expect(result.profileFailures).toBe(0);
    expect(result.visits).toEqual([
      expect.objectContaining({
        browser: "arc",
        profile: "fictional profile",
        url: "https://example.org/invented",
        title: "Invented visit",
        timestamp: at,
      }),
    ]);
    expect(result.hasMore).toBe(false);
  } finally {
    reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
