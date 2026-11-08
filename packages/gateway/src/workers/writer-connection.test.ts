// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { DEFAULT_WAL_CHECKPOINT_POLICY, WAL_SIZE_LIMIT_BYTES } from "./wal-checkpoint.js";
import { openWriteConn } from "./writer-connection.js";

const opened: Database.Database[] = [];
let path = "";

function seed(): void {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  db.exec("INSERT INTO counters VALUES ('hits', 0)");
  db.close();
}

/** A second writable connection — an operator's shell or a test seeding rows. */
function outOfBandWriter(): Database.Database {
  const db = new Database(path);
  // Fail at once instead of waiting: everything below runs on one thread.
  db.exec("PRAGMA busy_timeout = 0");
  opened.push(db);
  return db;
}

function track(db: Database.Database): Database.Database {
  opened.push(db);
  return db;
}

const value = (db: Database.Database): number =>
  (db.prepare("SELECT value FROM counters WHERE key = 'hits'").get() as { value: number }).value;

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
});

describe("openWriteConn", () => {
  it("a deferred read-then-write transaction fails when another connection commits in between", () => {
    // The hazard the writer's transactions are configured against: SQLite
    // reports a stale snapshot immediately, whatever the busy timeout.
    seed();
    const deferred = track(new Database(path));
    deferred.exec("PRAGMA busy_timeout = 5000");
    const other = outOfBandWriter();
    const readThenWrite = deferred.transaction(() => {
      const seen = value(deferred);
      other.prepare("UPDATE counters SET value = value + 1 WHERE key = 'hits'").run();
      deferred.prepare("UPDATE counters SET value = ? WHERE key = 'hits'").run(seen + 10);
    });
    expect(readThenWrite).toThrow(expect.objectContaining({ code: "SQLITE_BUSY_SNAPSHOT" }));
  });

  it("holds the write lock from BEGIN, so another writer cannot invalidate a read-then-write transaction", () => {
    seed();
    const writer = track(openWriteConn(path, "WAL"));
    const other = outOfBandWriter();
    writer.transaction(() => {
      const seen = value(writer);
      expect(() =>
        other.prepare("UPDATE counters SET value = value + 1 WHERE key = 'hits'").run(),
      ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
      writer.prepare("UPDATE counters SET value = ? WHERE key = 'hits'").run(seen + 10);
    })();
    expect(value(writer)).toBe(10);
    // Once the writer commits, the other connection writes normally.
    other.prepare("UPDATE counters SET value = value + 1 WHERE key = 'hits'").run();
    expect(value(writer)).toBe(11);
  });

  it.each([
    ["plaintext", undefined],
    ["encrypted", randomBytes(32)],
  ])("configures a %s WAL handle for checkpoints made between ops", (_label, key) => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    if (key) {
      const seedDb = openEncryptedSqlite(path, { key });
      seedDb.exec("PRAGMA journal_mode = WAL");
      seedDb.exec("CREATE TABLE counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
      seedDb.close();
    } else {
      seed();
    }
    const writer = track(openWriteConn(path, "WAL", key?.toString("hex")));
    const pragma = (name: string) => writer.pragma(name, { simple: true });
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("wal_autocheckpoint")).toBe(0);
    expect(pragma("journal_size_limit")).toBe(WAL_SIZE_LIMIT_BYTES);
    expect(pragma("checkpoint_fullfsync")).toBe(1);
    expect(pragma("synchronous")).toBe(2);
    expect(pragma("mmap_size")).toBe(0);
    expect(pragma("busy_timeout")).toBe(DEFAULT_WAL_CHECKPOINT_POLICY.busyTimeoutMs);
  });

  it("keeps nested transactions as savepoints and the explicit variants available", () => {
    seed();
    const writer = track(openWriteConn(path, "WAL"));
    const bump = writer.transaction((by: number) => {
      writer.prepare("UPDATE counters SET value = value + ? WHERE key = 'hits'").run(by);
    });
    const failing = writer.transaction(() => {
      bump(1);
      throw new Error("abandon the inner step");
    });
    writer.transaction(() => {
      bump(2);
      expect(failing).toThrow("abandon the inner step");
    })();
    expect(value(writer)).toBe(2);
    bump.deferred(3);
    bump.exclusive(4);
    expect(value(writer)).toBe(9);
  });
});
