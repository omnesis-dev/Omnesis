// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  migratePlaintextSqliteFile,
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
} from "./sqlite-encryption.js";

// Wrap only fs.renameSync so a test can simulate a failed atomic swap; every
// other fs call passes through to the real implementation.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-sqlite-encryption-"));
  dirs.push(dir);
  return join(dir, "store.db");
}

function key(): Buffer {
  return randomBytes(32);
}

function encryptTempCount(path: string): number {
  const prefix = `${basename(path)}.encrypting-`;
  return readdirSync(dirname(path)).filter((entry) => entry.startsWith(prefix)).length;
}

describe("openEncryptedSqlite", () => {
  test("creates a keyed SQLite database whose raw file is not plaintext", () => {
    const path = tmpDbPath();
    const k = key();

    const db = openEncryptedSqlite(path, { key: k });
    db.exec("CREATE TABLE items (value TEXT NOT NULL)");
    db.prepare("INSERT INTO items (value) VALUES (?)").run("alpha");
    db.close();

    expect(readFileSync(path).subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("alpha");

    const reopened = openEncryptedSqlite(path, { key: k, readonly: true, fileMustExist: true });
    expect(reopened.prepare("SELECT value FROM items").pluck().get()).toBe("alpha");
    reopened.close();
  });

  test("migrates a plaintext database in place and preserves WAL-backed rows", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("PRAGMA journal_mode = WAL");
    plain.exec("PRAGMA wal_autocheckpoint = 0");
    plain.exec("CREATE TABLE items (value TEXT NOT NULL)");
    plain.prepare("INSERT INTO items (value) VALUES (?)").run("persisted-from-wal");
    plain.close();

    expect(sqliteFileLooksPlaintext(path)).toBe(true);
    const k = key();
    expect(migratePlaintextSqliteFile(path, k)).toBe(true);

    expect(sqliteFileLooksPlaintext(path)).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("persisted-from-wal");

    const encrypted = openEncryptedSqlite(path, { key: k, readonly: true, fileMustExist: true });
    expect(encrypted.prepare("SELECT value FROM items").pluck().get()).toBe("persisted-from-wal");
    encrypted.close();
  });

  test("refuses readonly keyed open on a plaintext store", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("CREATE TABLE items (value TEXT NOT NULL)");
    plain.close();

    expect(() => openEncryptedSqlite(path, { key: key(), readonly: true })).toThrow(
      /plaintext.*without migration/i,
    );
  });

  test("keeps plaintext behavior when no key is supplied", () => {
    const path = tmpDbPath();
    const db = openEncryptedSqlite(path);
    db.exec("CREATE TABLE items (value TEXT NOT NULL)");
    db.close();

    expect(readFileSync(path).subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)).toBe(true);
  });
});

describe("migratePlaintextSqliteFile crash-safety", () => {
  test("a failed atomic rename leaves the original plaintext intact and is retryable", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("CREATE TABLE items (value TEXT NOT NULL)");
    plain.prepare("INSERT INTO items (value) VALUES (?)").run("survives-crash");
    plain.close();

    const k = key();
    // Simulate a crash/kill at the most dangerous moment: the encrypted temp is
    // fully written, but the atomic swap over the original fails.
    vi.mocked(fs.renameSync).mockClear();
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    expect(() => migratePlaintextSqliteFile(path, k)).toThrow(/simulated rename failure/);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);

    // The live file is untouched: still a readable plaintext DB with its data.
    expect(sqliteFileLooksPlaintext(path)).toBe(true);
    const reopened = new Database(path, { readonly: true });
    expect(reopened.prepare("SELECT value FROM items").pluck().get()).toBe("survives-crash");
    reopened.close();
    // No half-written temp artifacts survive the failure.
    expect(encryptTempCount(path)).toBe(0);

    // Retrying (rename restored) completes cleanly and yields a whole encrypted database.
    expect(migratePlaintextSqliteFile(path, k)).toBe(true);
    expect(sqliteFileLooksPlaintext(path)).toBe(false);
    const encrypted = openEncryptedSqlite(path, { key: k, readonly: true, fileMustExist: true });
    expect(encrypted.prepare("SELECT value FROM items").pluck().get()).toBe("survives-crash");
    encrypted.close();
    expect(encryptTempCount(path)).toBe(0);
  });

  test("preserves multi-table, multi-page, and BLOB data through migration", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    plain.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
    const insertDoc = plain.prepare("INSERT INTO docs (id, body) VALUES (?, ?)");
    plain.transaction(() => {
      for (let i = 0; i < 500; i++) insertDoc.run(i, `row-${i}-${"x".repeat(64)}`);
    })();
    const blob = randomBytes(64 * 1024); // spans many pages
    plain.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(1, blob);
    plain.close();

    const k = key();
    expect(migratePlaintextSqliteFile(path, k)).toBe(true);
    expect(sqliteFileLooksPlaintext(path)).toBe(false);

    const enc = openEncryptedSqlite(path, { key: k, readonly: true, fileMustExist: true });
    expect(enc.prepare("SELECT COUNT(*) FROM docs").pluck().get()).toBe(500);
    expect(enc.prepare("SELECT body FROM docs WHERE id = 499").pluck().get()).toBe(
      `row-499-${"x".repeat(64)}`,
    );
    const roundtrip = enc.prepare("SELECT data FROM blobs WHERE id = 1").pluck().get() as Buffer;
    expect(Buffer.compare(roundtrip, blob)).toBe(0);
    enc.close();
  });

  test("a successful migration leaves no temp files behind", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("CREATE TABLE items (value TEXT NOT NULL)");
    plain.prepare("INSERT INTO items (value) VALUES (?)").run("clean");
    plain.close();

    expect(migratePlaintextSqliteFile(path, key())).toBe(true);
    expect(encryptTempCount(path)).toBe(0);
  });

  test("reclaims a temp file orphaned by a prior interrupted attempt", () => {
    const path = tmpDbPath();
    const plain = new Database(path);
    plain.exec("CREATE TABLE items (value TEXT NOT NULL)");
    plain.prepare("INSERT INTO items (value) VALUES (?)").run("orphan-cleanup");
    plain.close();

    // A leftover temp from a crashed prior attempt must not accumulate.
    writeFileSync(`${path}.encrypting-999-1`, "garbage");

    const k = key();
    expect(migratePlaintextSqliteFile(path, k)).toBe(true);
    expect(encryptTempCount(path)).toBe(0);
    const encrypted = openEncryptedSqlite(path, { key: k, readonly: true, fileMustExist: true });
    expect(encrypted.prepare("SELECT value FROM items").pluck().get()).toBe("orphan-cleanup");
    encrypted.close();
  });
});

describe("sqliteFileLooksPlaintext on a large file", () => {
  test("reads only the header — no ERR_FS_FILE_TOO_LARGE past Node's 2 GiB readFileSync limit", () => {
    const path = tmpDbPath();
    // A sparse file: the real SQLite magic header at offset 0, then a hole out
    // past 2 GiB. Sparse, so it costs no real disk. Reading the whole file with
    // readFileSync would throw ERR_FS_FILE_TOO_LARGE — a real corpus hits this.
    const fd = fs.openSync(path, "w");
    try {
      fs.writeSync(fd, SQLITE_HEADER, 0, SQLITE_HEADER.length, 0);
      fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024 + 4096);
    } finally {
      fs.closeSync(fd);
    }
    expect(() => sqliteFileLooksPlaintext(path)).not.toThrow();
    expect(sqliteFileLooksPlaintext(path)).toBe(true);
  });
});
