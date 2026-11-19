// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { scanStorageAllocation } from "./physical-accounting.js";
import { StorageAllocationReader } from "./allocation-reader.js";
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(encrypted = false) {
  const root = mkdtempSync(join(tmpdir(), "storage-allocation-"));
  roots.push(root);
  const path = join(root, "fixture.db");
  const key = encrypted ? Buffer.alloc(32, 7) : undefined;
  const db = key
    ? (openEncryptedSqlite(path, { key }) as unknown as Database.Database)
    : new Database(path);
  db.pragma("journal_mode=WAL");
  db.exec(
    "CREATE TABLE entries(id INTEGER PRIMARY KEY,body TEXT); CREATE INDEX entries_body ON entries(body); CREATE VIRTUAL TABLE entries_fts USING fts5(body)",
  );
  const insert = db.prepare("INSERT INTO entries(body) VALUES(?)");
  db.transaction(() => {
    for (let i = 0; i < 80; i++) insert.run(`Invented ${i} ${"x".repeat(16000)}`);
  })();
  db.exec("INSERT INTO entries_fts(body) VALUES('invented lexical text')");
  return { db, store: { path, ...(key ? { keyHex: key.toString("hex") } : {}) } };
}
it.each([false, true])(
  "physical allocation matches full dbstat including overflow, indexes and FTS (encrypted=%s)",
  async (encrypted) => {
    const { db, store } = fixture(encrypted);
    try {
      const expected = db
        .prepare("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name")
        .all();
      const snapshot = await scanStorageAllocation(
        store,
        { slicePages: 3, betweenSliceMs: 0 },
        () => false,
        () => {},
      );
      expect(snapshot.state).toBe("ready");
      expect(snapshot.tables).toEqual(expected);
      expect(snapshot.completed).toEqual(expected);
      expect(snapshot.scannedBytes).toBe(
        (expected as Array<{ bytes: number }>).reduce((bytes, table) => bytes + table.bytes, 0),
      );
      expect(snapshot.scannedPages).toBeGreaterThan(80);
      expect(snapshot.tables?.some((table) => table.name.startsWith("entries_fts"))).toBe(true);
    } finally {
      db.close();
    }
  },
);
it("caps WAL growth without stopping writers or retaining its read snapshot", async () => {
  const { db, store } = fixture();
  let wrote = false;
  let probes = 0;
  try {
    const snapshot = await scanStorageAllocation(
      store,
      { slicePages: 1, maxWalGrowthBytes: 0 },
      () => false,
      () => {
        probes++;
        expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toBeDefined();
        if (!wrote) {
          wrote = true;
          db.prepare("INSERT INTO entries(body) VALUES(?)").run(
            "new invented " + "z".repeat(20000),
          );
        }
      },
    );
    expect(probes).toBeGreaterThan(0);
    expect(snapshot).toMatchObject({
      state: "partial",
      tables: null,
      error: "Allocation snapshot WAL growth limit reached",
    });
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 0 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual({ n: 81 });
  } finally {
    db.close();
  }
});
it("time cap and cancellation keep the last dated complete result", async () => {
  const { db, store } = fixture();
  try {
    const prior = await scanStorageAllocation(
      store,
      {},
      () => false,
      () => {},
    );
    for (const cancelled of [false, true]) {
      const snapshot = await scanStorageAllocation(
        store,
        { maxSnapshotMs: cancelled ? 60000 : 0 },
        () => cancelled,
        () => {},
        prior,
      );
      expect(snapshot.state).toBe("partial");
      expect(snapshot.tables).toEqual(prior.tables);
      expect(snapshot.measuredAt).toBe(prior.measuredAt);
      expect(snapshot.completed).toEqual([]);
      expect(db.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 0 }]);
    }
  } finally {
    db.close();
  }
});
it("real worker coalesces scans, shuts down a held iterator and releases WAL", async () => {
  const { db, store } = fixture(true);
  db.exec("CREATE TABLE a_overflow(body BLOB); INSERT INTO a_overflow VALUES(zeroblob(8388608))");
  const progress = Promise.withResolvers<void>();
  const reader = new StorageAllocationReader({
    gatewayStore: store,
    indexStore: store,
    slicePages: 1,
    betweenSliceMs: 10,
    onProgress: () => progress.resolve(),
  });
  try {
    const first = reader.measure("documents");
    expect(reader.measure("documents")).toBe(first);
    expect(reader.measure("documents", { force: true })).toBe(first);
    await progress.promise;
    await reader.dispose();
    expect((await first).state).toBe("partial");
    expect(db.pragma("wal_checkpoint(TRUNCATE)")).toMatchObject([{ busy: 0 }]);
    await expect(reader.measure("documents")).rejects.toThrow("closed");
  } finally {
    await reader.dispose();
    db.close();
  }
});
it("real worker backs off capped retries and permits an explicit retry", async () => {
  const { db, store } = fixture(true);
  let events = 0;
  const reader = new StorageAllocationReader({
    gatewayStore: store,
    indexStore: store,
    maxSnapshotMs: 0,
    onProgress: () => events++,
  });
  try {
    const first = await reader.measure("index");
    expect(first.state).toBe("partial");
    const count = events;
    expect(await reader.measure("index")).toEqual(first);
    expect(events).toBe(count);
    expect((await reader.measure("index", { force: true })).state).toBe("partial");
    expect(events).toBeGreaterThan(count);
  } finally {
    await reader.dispose();
    db.close();
  }
});

it.each([false, true])(
  "dbstat emits ordered pages without a materializing sort (encrypted=%s)",
  (encrypted) => {
    const { db } = fixture(encrypted);
    try {
      const plans = db
        .prepare("EXPLAIN QUERY PLAN SELECT name,pgsize FROM dbstat ORDER BY name,path")
        .all() as Array<{ detail: string }>;
      expect(plans.map((p) => p.detail).join(" ")).not.toMatch(/TEMP B-TREE|SORT/i);
      expect(plans.map((p) => p.detail).join(" ")).toMatch(/SCAN dbstat VIRTUAL TABLE INDEX/i);
      const bytecode = db
        .prepare("EXPLAIN SELECT name,pgsize FROM dbstat ORDER BY name,path")
        .all() as Array<{ opcode: string }>;
      const opcodes = bytecode.map((row) => row.opcode);
      expect(opcodes).toContain("VFilter");
      expect(opcodes).toContain("VNext");
      expect(opcodes.indexOf("ResultRow")).toBeLessThan(opcodes.indexOf("VNext"));
      expect(opcodes.join(" ")).not.toMatch(/Sorter|OpenEphemeral|(?:^| )Sort(?: |$)/);
      expect(db.prepare("SELECT octet_length('café🗃') AS bytes").get()).toEqual({
        bytes: Buffer.byteLength("café🗃"),
      });
    } finally {
      db.close();
    }
  },
);
it("restarts after an owned worker exits and ignores its stale exit notification", async () => {
  const { db, store } = fixture();
  const workers: import("node:worker_threads").Worker[] = [];
  const { Worker } = await import("node:worker_threads");
  const reader = new StorageAllocationReader({
    gatewayStore: store,
    indexStore: store,
    createWorker: (url, options) => {
      const worker = new Worker(url, options);
      workers.push(worker);
      return worker;
    },
  });
  try {
    const failed = reader.measure("documents");
    const rejected = expect(failed).rejects.toThrow("worker stopped");
    await workers[0]!.terminate();
    await rejected;
    const retried = reader.measure("documents");
    workers[0]!.emit("exit", 1);
    expect((await retried).state).toBe("ready");
    expect(workers).toHaveLength(2);
  } finally {
    await reader.dispose();
    db.close();
  }
});
it("a throwing progress observer cannot prevent transport completion", async () => {
  const { db, store } = fixture();
  const reader = new StorageAllocationReader({
    gatewayStore: store,
    indexStore: store,
    onProgress: () => {
      throw new Error("Invented observer failure");
    },
  });
  try {
    expect((await reader.measure("index")).state).toBe("ready");
  } finally {
    await reader.dispose();
    db.close();
  }
});

it.each([false, true])(
  "closing the physical reader preserves a live writer lock (encrypted=%s)",
  async (encrypted) => {
    const { db, store } = fixture(encrypted);
    try {
      db.exec("BEGIN IMMEDIATE; UPDATE entries SET body='Invented pending edit' WHERE id=1");
      const snapshot = await scanStorageAllocation(
        store,
        {},
        () => false,
        () => {},
      );
      expect(snapshot.state).toBe("ready");
      expect(contender(store.path, store.keyHex)).toBe(42);
      db.exec("ROLLBACK");
      expect(contender(store.path, store.keyHex)).toBe(0);
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  },
);
function contender(path: string, keyHex?: string): number | null {
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
      keyHex ?? "",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).status;
}
