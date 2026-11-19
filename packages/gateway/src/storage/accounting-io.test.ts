// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createIndexDatabase } from "../indexer/db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../scheduler/io-ops.js";
import { directReadPort } from "../scheduler/read-port.js";
import { measureStorageAccounting } from "./accounting.js";
import { measureIndexStorageAccounting } from "./index-accounting.js";
import { STORAGE_READS, STORAGE_INDEX_READS } from "./reads.js";
it.each([false, true])(
  "separate main/index IO handles return identical bounded inventories without an indexer (encrypted=%s)",
  async (encrypted) => {
    const dir = mkdtempSync(join(tmpdir(), "storage-accounting-io-"));
    const gatewayDbPath = join(dir, "gateway.db");
    const indexPath = join(dir, "index.db");
    const key = encrypted ? Buffer.alloc(32, 19) : undefined;
    const main = createDatabase(gatewayDbPath, { encryptionKey: key });
    const index = createIndexDatabase(indexPath, { encryptionKey: key });
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(
      new IoTaskRunner({
        gatewayDbPath,
        gatewayDbKeyHex: key?.toString("hex"),
        indexStore: { path: indexPath, keyHex: key?.toString("hex") },
        concurrency: 1,
        workerUrl: new URL("../workers/io-worker.ts", import.meta.url),
        workerExecArgv: ["--import", new URL("../workers/register-tsx.mjs", import.meta.url).href],
      }),
    );
    try {
      upsertDocuments(main, [
        {
          providerId: ProviderId("invented-provider"),
          sourceId: SourceId("invented-source"),
          externalId: "entry",
          title: "café",
          content: "Invented 🗃",
          contentHash: "fixture",
          metadata: {},
          sourceCreatedAt: "2031-01-01T00:00:00Z",
          sourceUpdatedAt: "2031-01-01T00:00:00Z",
        },
      ]);
      index
        .prepare(
          "INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,source_created_at,embedding) VALUES('c','d',0,'café','invented-source','Invented','2031-01-01',zeroblob(16))",
        )
        .run();
      const now = () => new Date("2032-01-01T00:00:00Z");
      const directMain = await measureStorageAccounting(directReadPort(STORAGE_READS, main), now);
      const directIndex = await measureIndexStorageAccounting(
        directReadPort(STORAGE_INDEX_READS, index),
        now,
      );
      await scheduler.start();
      const io = ioGateFromScheduler(scheduler);
      expect(await measureStorageAccounting(io, now)).toStrictEqual(directMain);
      expect(await measureIndexStorageAccounting(io, now)).toStrictEqual(directIndex);
      expect(await io.echo("interactive reader still runs")).toBe("interactive reader still runs");
      expect(directIndex.tables).toBeNull();
      expect(directMain.database.tables).toBeNull();
      main.exec("BEGIN IMMEDIATE; UPDATE documents SET title='Invented pending title'");
      index.exec("BEGIN IMMEDIATE; UPDATE chunks SET title='Invented pending title'");
      await measureStorageAccounting(io, now);
      await measureIndexStorageAccounting(io, now);
      await scheduler.dispose();
      for (const path of [gatewayDbPath, indexPath]) expect(contender(path, key)).toBe(42);
      main.exec("ROLLBACK");
      index.exec("ROLLBACK");
      for (const path of [gatewayDbPath, indexPath]) expect(contender(path, key)).toBe(0);
    } finally {
      await scheduler.dispose();
      if (main.inTransaction) main.exec("ROLLBACK");
      if (index.inTransaction) index.exec("ROLLBACK");
      main.close();
      index.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);

function contender(path: string, key?: Buffer): number | null {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import Database from 'better-sqlite3';
    import Cipher from 'better-sqlite3-multiple-ciphers';
    const [path,key]=process.argv.slice(1);
    const db=key?new Cipher(path):new Database(path);
    if(key){db.pragma("cipher='sqlcipher'");db.pragma('legacy=4');db.pragma("key='"+key+"'");}
    db.pragma('busy_timeout=0');
    try {db.exec('BEGIN IMMEDIATE; ROLLBACK');}
    catch(error){if(error.code==='SQLITE_BUSY')process.exitCode=42;else throw error;}
    finally{db.close();}
  `,
      path,
      key?.toString("hex") ?? "",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).status;
}
