// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeDrainingWal, createDatabase, openReadOnlyDatabase } from "./db.js";

let path = "";
const key = randomBytes(32);

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
});

describe("closeDrainingWal", () => {
  it("reports the backlog, drains it into the database and leaves no WAL", () => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    const db = createDatabase(path, { encryptionKey: key });
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("CREATE TABLE synth_notes (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO synth_notes (body) VALUES (randomblob(3000))");
    db.transaction(() => {
      for (let i = 0; i < 500; i++) insert.run();
    })();

    const heard: number[] = [];
    const drained = closeDrainingWal(db, (frames) => heard.push(frames));
    expect(drained.frames).toBeGreaterThan(500);
    expect(heard).toEqual([drained.frames]);
    expect(drained.ms).toBeGreaterThanOrEqual(0);
    expect(existsSync(`${path}-wal`)).toBe(false);

    const reader = openReadOnlyDatabase(path, { encryptionKey: key });
    try {
      expect(reader.prepare("SELECT count(*) AS n FROM synth_notes").get()).toEqual({ n: 500 });
    } finally {
      reader.close();
    }
  });

  it("says nothing when the WAL holds nothing to copy", () => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    const db = createDatabase(path, { encryptionKey: key });
    db.pragma("wal_checkpoint(TRUNCATE)");
    const heard: number[] = [];
    expect(closeDrainingWal(db, (frames) => heard.push(frames)).frames).toBe(0);
    expect(heard).toEqual([]);
  });
});
