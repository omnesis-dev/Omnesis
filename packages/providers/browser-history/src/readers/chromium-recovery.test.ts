// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChromiumHistoryReader } from "./chromium.js";

it("reads committed history through a hot rollback journal without modifying its source", () => {
  const root = mkdtempSync(join(tmpdir(), "omnesis-history-recovery-"));
  const path = join(root, "Default", "History");
  mkdirSync(join(root, "Default"));
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }),
  );
  // Spill uncommitted pages, then crash only this owned fixture process. A clean
  // close would roll back and hide the recovery condition under test.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))});
    const db = new Database(process.argv[1]);
    db.exec("PRAGMA page_size=1024; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=5; PRAGMA cache_spill=ON;");
    db.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT,hidden INTEGER); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER,visit_duration INTEGER,transition INTEGER,originator_cache_guid TEXT DEFAULT ''); CREATE TABLE visit_source(id INTEGER PRIMARY KEY,source INTEGER); CREATE TABLE padding(id INTEGER PRIMARY KEY, value BLOB);");
    db.prepare("INSERT INTO urls VALUES(1,?,?,0)").run("https://example.com/recovery", "Fixture page");
    db.exec("INSERT INTO visits(id,url,visit_time,visit_duration,transition) VALUES(1,1,13380163200000000,1000000,0)");
    const insert=db.prepare("INSERT INTO padding VALUES(?,zeroblob(2048))");
    db.transaction(()=>{for(let i=0;i<100;i++)insert.run(i)})();
    db.exec("BEGIN IMMEDIATE; UPDATE urls SET title='Uncommitted'; UPDATE padding SET value=randomblob(2048)");
    process.kill(process.pid, "SIGKILL");
  `,
      path,
    ],
    { timeout: 10000 },
  );
  const reader = new ChromiumHistoryReader({
    id: "chrome",
    name: "Fixture",
    baseDir: root,
    engine: "chromium",
  });
  try {
    expect(child.signal).toBe("SIGKILL");
    expect(existsSync(path + "-journal")).toBe(true);
    const before = [readFileSync(path), readFileSync(path + "-journal")];
    expect(before[1].subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
    const result = reader.readVisits({}, 0, 100);
    expect(result.visits).toHaveLength(1);
    expect(result.visits[0].title).toBe("Fixture page");
    expect(readFileSync(path)).toEqual(before[0]);
    expect(readFileSync(path + "-journal")).toEqual(before[1]);
  } finally {
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
});
