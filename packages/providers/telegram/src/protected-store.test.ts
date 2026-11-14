// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { openProtectedDatabase } from "./protected-store.js";

const filesystem = vi.hoisted(() => ({
  rename: undefined as unknown as typeof import("node:fs").renameSync,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  filesystem.rename = actual.renameSync;
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function file(): string {
  const root = fs.mkdtempSync(join(tmpdir(), "telegram-store-publication-"));
  roots.push(root);
  return join(root, "archive.db");
}

test("a failed rekey publication preserves active bytes, rows and caller key, then retries", () => {
  const path = file();
  const plain = openProtectedDatabase(path, null, "message archive");
  plain.exec(
    "CREATE TABLE retained(value TEXT);INSERT INTO retained VALUES ('invented retained row')",
  );
  plain.close();
  const key = Buffer.alloc(32, 7),
    originalKey = Buffer.from(key);
  let activeBytes: Buffer | undefined;
  const rename = filesystem.rename;
  const blocked = vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (source === path + ".rekey") {
      activeBytes = fs.readFileSync(path);
      throw Object.assign(new Error("invented publication sharing failure"), { code: "EPERM" });
    }
    return rename(source, target);
  });
  expect(() => openProtectedDatabase(path, key, "message archive")).toThrow(/encryption failed/);
  expect(activeBytes).toBeDefined();
  expect(fs.readFileSync(path)).toEqual(activeBytes);
  expect(key).toEqual(originalKey);
  expect(fs.readdirSync(join(path, "..")).some((name) => name.includes(".corrupt-"))).toBe(false);
  expect(fs.existsSync(path + ".rekey")).toBe(false);
  const retained = new Database(path, { readonly: true });
  try {
    expect(retained.prepare("SELECT value FROM retained").get()).toEqual({
      value: "invented retained row",
    });
  } finally {
    retained.close();
  }
  blocked.mockRestore();
  const retried = openProtectedDatabase(path, key, "message archive");
  try {
    expect(retried.prepare("SELECT value FROM retained").get()).toEqual({
      value: "invented retained row",
    });
  } finally {
    retried.close();
  }
});

test("corrupt initialization closes its actual SQLite handle before quarantining", () => {
  const path = file();
  fs.writeFileSync(path, Buffer.alloc(8192, 3));
  const failed: Database.Database[] = [];
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
    this: Database.Database,
    source,
  ) {
    try {
      return prepare.call(this, source);
    } catch (error) {
      failed.push(this);
      throw error;
    }
  });
  const rename = filesystem.rename;
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (source === path) {
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((db) => !db.open)).toBe(true);
    }
    return rename(source, target);
  });
  const recovered = openProtectedDatabase(path, null, "message archive");
  try {
    expect(recovered.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    recovered.close();
  }
  expect(failed.length).toBe(1);
  expect(failed.every((db) => !db.open)).toBe(true);
});

test("an operational SQLite open failure closes its handle without quarantining valid data", () => {
  const path = file();
  const original = openProtectedDatabase(path, null, "message archive");
  original.exec("CREATE TABLE retained(value TEXT);INSERT INTO retained VALUES ('retained row')");
  original.close();
  const bytes = fs.readFileSync(path);
  const failure = Object.assign(new Error("invented database busy"), { code: "SQLITE_BUSY" });
  let failed: Database.Database | undefined;
  const blocked = vi.spyOn(Database.prototype, "pragma").mockImplementationOnce(function (
    this: Database.Database,
  ) {
    failed = this;
    throw failure;
  });
  expect(() => openProtectedDatabase(path, null, "message archive")).toThrow(failure);
  expect(failed?.open).toBe(false);
  expect(fs.readFileSync(path)).toEqual(bytes);
  expect(fs.readdirSync(join(path, "..")).some((name) => name.includes(".corrupt-"))).toBe(false);
  blocked.mockRestore();
  const retried = openProtectedDatabase(path, null, "message archive");
  try {
    expect(retried.prepare("SELECT value FROM retained").get()).toEqual({ value: "retained row" });
  } finally {
    retried.close();
  }
});
