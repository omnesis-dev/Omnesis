// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openReadonlySqliteSnapshot } from "@omnesis/core";
import { KnowledgeDbReader } from "./db-reader.js";

it("recovers hot usage database journals on the copy, not the original", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-recovery-"));
  const path = join(root, "knowledgeC.db");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const Database=require(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))});
    const db=new Database(process.argv[1]);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=5; PRAGMA cache_spill=ON; CREATE TABLE ZOBJECT(Z_PK INTEGER PRIMARY KEY,ZSTREAMNAME TEXT,ZVALUESTRING TEXT,ZSTARTDATE REAL,ZENDDATE REAL,ZCREATIONDATE REAL,ZSECONDSFROMGMT INTEGER); CREATE TABLE padding(id INTEGER PRIMARY KEY,value BLOB)");
    db.exec("INSERT INTO ZOBJECT VALUES(1,'/app/usage','com.example.fixture',100,160,170,0)");
    const insert=db.prepare("INSERT INTO padding VALUES(?,zeroblob(8192))");
    db.transaction(()=>{for(let i=0;i<50;i++)insert.run(i)})();
    db.exec("BEGIN IMMEDIATE; DELETE FROM ZOBJECT; UPDATE padding SET value=randomblob(8192)");
    process.kill(process.pid,'SIGKILL');
  `,
      path,
    ],
    { timeout: 10000 },
  );
  let reader: KnowledgeDbReader | undefined;
  try {
    expect(child.signal).toBe("SIGKILL");
    const before = [readFileSync(path), readFileSync(path + "-journal")];
    expect(before[1].subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
    reader = new KnowledgeDbReader(path);
    expect(reader.schemaOk).toBe(true);
    expect(reader.fetchSessions(0, 0, 10).sessions).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before[0]);
    expect(readFileSync(path + "-journal")).toEqual(before[1]);
    reader.close();
    reader.close();
  } finally {
    reader?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it("preserves committed WAL rows and returns a genuinely readonly handle", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-wal-recovery-"));
  const path = join(root, "fixture.db");
  const source = new Database(path);
  source.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES(42)",
  );
  const before = [readFileSync(path), readFileSync(path + "-wal")];
  const snapshot = openReadonlySqliteSnapshot(path, (copy, options) => new Database(copy, options));
  try {
    expect(snapshot.db.readonly).toBe(true);
    expect(snapshot.db.prepare("SELECT id FROM fixture").get()).toEqual({ id: 42 });
    expect(() => snapshot.db.prepare("INSERT INTO fixture VALUES(43)").run()).toThrow();
    expect(readFileSync(path)).toEqual(before[0]);
    expect(readFileSync(path + "-wal")).toEqual(before[1]);
  } finally {
    snapshot.cleanup();
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
