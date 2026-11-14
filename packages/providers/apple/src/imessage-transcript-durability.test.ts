// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as core from "@omnesis/core";
import { afterEach, expect, test, vi } from "vitest";
import { openTranscriptDatabase } from "./imessage-transcript-storage.js";

const durability = vi.hoisted(() => ({
  file: undefined as unknown as typeof import("@omnesis/core").fsyncFileSync,
  directory: undefined as unknown as typeof import("@omnesis/core").fsyncDirSync,
}));
vi.mock("@omnesis/core", async (original) => {
  const actual = await original<typeof import("@omnesis/core")>();
  durability.file = actual.fsyncFileSync;
  durability.directory = actual.fsyncDirSync;
  return {
    ...actual,
    fsyncFileSync: vi.fn(actual.fsyncFileSync),
    fsyncDirSync: vi.fn(actual.fsyncDirSync),
  };
});
const filesystem = vi.hoisted(() => ({
  rename: undefined as unknown as typeof import("node:fs").renameSync,
  remove: undefined as unknown as typeof import("node:fs").rmSync,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  filesystem.rename = actual.renameSync;
  filesystem.remove = actual.rmSync;
  return { ...actual, renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) };
});

const roots: string[] = [];
const opened: ReturnType<typeof openTranscriptDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.renameSync).mockReset().mockImplementation(filesystem.rename);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(filesystem.remove);
  vi.mocked(core.fsyncFileSync).mockReset().mockImplementation(durability.file);
  vi.mocked(core.fsyncDirSync).mockReset().mockImplementation(durability.directory);
  for (const owned of opened.splice(0)) if (owned.db.open) owned.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "transcript-storage-durability-"));
  roots.push(root);
  const path = join(root, "transcripts.db");
  const db = new Database(path);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('invented transcript')");
  db.close();
  return { path, key: Buffer.alloc(32, 4) };
}
function open(path: string, key: Buffer | null) {
  const owned = openTranscriptDatabase(path, key);
  opened.push(owned);
  return owned;
}
function retained(path: string, key: Buffer | null) {
  const owned = open(path, key);
  try {
    expect(owned.db.prepare("SELECT value FROM retained").get()).toEqual({
      value: "invented transcript",
    });
  } finally {
    owned.close();
  }
}

test("migration flushes the verified copy before publication and strictly flushes the parent afterward", () => {
  const { path, key } = fixture();
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    expect(core.fsyncFileSync).toHaveBeenCalledWith(path + ".encrypting");
    expect(core.fsyncDirSync).not.toHaveBeenCalled();
    return filesystem.rename(source, target);
  });
  retained(path, key);
  expect(core.fsyncDirSync).toHaveBeenCalledExactlyOnceWith(dirname(path), { strict: true });
  expect(fs.readFileSync(path).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
  expect(fs.existsSync(path + ".encrypting")).toBe(false);
});

test("a failed file flush leaves the plaintext source intact and permits retry", () => {
  const { path, key } = fixture();
  const original = fs.readFileSync(path);
  const failure = Object.assign(new Error("invented flush failure"), { code: "EIO" });
  vi.mocked(core.fsyncFileSync).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => open(path, key)).toThrow(failure);
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(fs.readFileSync(path)).toEqual(original);
  expect(fs.existsSync(path + ".encrypting")).toBe(false);
  retained(path, null);
  retained(path, key);
});

test("a refused publication preserves source bytes and rows and releases the lifetime guard", () => {
  const { path, key } = fixture();
  let bytes: Buffer | undefined;
  const failure = Object.assign(new Error("invented sharing failure"), { code: "EPERM" });
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    bytes = fs.readFileSync(path);
    throw failure;
  });
  expect(() => open(path, key)).toThrow(failure);
  expect(bytes).toBeDefined();
  expect(fs.readFileSync(path)).toEqual(bytes);
  expect(core.fsyncDirSync).not.toHaveBeenCalled();
  retained(path, null);
  retained(path, key);
});

test("a directory flush failure reports the error but keeps the published encrypted cache usable", () => {
  const { path, key } = fixture();
  const failure = Object.assign(new Error("invented directory flush failure"), { code: "EIO" });
  vi.mocked(core.fsyncDirSync).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => open(path, key)).toThrow(failure);
  expect(fs.readFileSync(path).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
  retained(path, key);
});

test("migration failure preserves its original cause when staging cleanup also fails", () => {
  const { path, key } = fixture();
  const failure = new Error("invented file flush failure");
  const cleanup = new Error("invented cleanup failure");
  let failedFlush = false;
  vi.mocked(core.fsyncFileSync).mockImplementationOnce(() => {
    failedFlush = true;
    throw failure;
  });
  vi.mocked(fs.rmSync).mockImplementation((target, options) => {
    if (failedFlush && target === path + ".encrypting") throw cleanup;
    return filesystem.remove(target, options);
  });
  let caught: unknown;
  try {
    open(path, key);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught).toMatchObject({ cause: failure, errors: [failure, cleanup] });
  vi.mocked(fs.rmSync).mockRestore();
  retained(path, null);
});

test("a lifetime-guard close error cannot hide the original failed flush", () => {
  const { path, key } = fixture();
  const failure = new Error("invented flush failure");
  const cleanup = new Error("invented guard close failure");
  vi.mocked(core.fsyncFileSync).mockImplementationOnce(() => {
    throw failure;
  });
  const close = Database.prototype.close;
  vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
    const result = close.call(this);
    if (this.name === path + ".lock") throw cleanup;
    return result;
  });
  let caught: unknown;
  try {
    open(path, key);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught).toMatchObject({ cause: failure, errors: [failure, cleanup] });
  vi.restoreAllMocks();
  retained(path, null);
});
