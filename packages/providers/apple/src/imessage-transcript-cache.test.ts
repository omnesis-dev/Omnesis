// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ensureInstallRootKey,
  ensureStorageKey,
  rotateStorageKey,
  storageKeyPath,
} from "@omnesis/core";
import { openTranscriptDatabase } from "./imessage-transcript-storage.js";
import { IMessageTranscriptCache } from "./imessage-transcript-cache.js";

describe("IMessageTranscriptCache", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("treats legacy rows without mtime as misses when current mtime is known", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imessage-transcripts-"));
    const cacheDir = join(tmpDir, "apple-imessage");
    mkdirSync(cacheDir, { recursive: true });
    const db = new Database(join(cacheDir, "transcripts.db"));
    db.exec(`
      CREATE TABLE transcripts (
        attachment_guid TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        transcript TEXT NOT NULL,
        duration_sec REAL
      )
    `);
    db.prepare(
      "INSERT INTO transcripts (attachment_guid, size, transcript, duration_sec) VALUES (?, ?, ?, ?)",
    ).run("att-guid-1", 12, "cached transcript", 3);
    db.close();

    const cache = new IMessageTranscriptCache(tmpDir);
    try {
      expect(cache.get("att-guid-1", 12, 1234)).toBeUndefined();
      expect(cache.get("att-guid-1", 12)).toEqual({
        transcript: "cached transcript",
        durationSec: 3,
      });
    } finally {
      cache.close();
    }
  });

  async function encryptedHome(): Promise<string> {
    tmpDir ??= mkdtempSync(join(tmpdir(), "imessage-transcripts-"));
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    await ensureInstallRootKey({ backend: "file", configDir: tmpDir });
    await ensureStorageKey("imessage-transcripts", { backend: "file", configDir: tmpDir });
    return join(tmpDir, "apple-imessage", "transcripts.db");
  }

  function assertUnreadable(path: string): void {
    const plain = new Database(path, { readonly: true });
    try {
      expect(() => plain.prepare("SELECT * FROM transcripts").all()).toThrow();
    } finally {
      plain.close();
    }
    for (const entry of readdirSync(join(tmpDir!, "apple-imessage"))) {
      expect(
        readFileSync(join(tmpDir!, "apple-imessage", entry)).includes(
          Buffer.from("Invented voice note"),
        ),
      ).toBe(false);
    }
  }

  test("encrypts pages and WAL and reuses transcripts across reopen with size/mtime invalidation", async () => {
    const path = await encryptedHome();
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.set("clip", 12, 1234, { transcript: "Invented voice note", durationSec: 3 });
    cache.set("silent", 8, 12, { transcript: "" });
    assertUnreadable(path);
    cache.close();
    const reopened = new IMessageTranscriptCache(tmpDir);
    try {
      expect(reopened.get("clip", 12, 1234)).toEqual({
        transcript: "Invented voice note",
        durationSec: 3,
      });
      expect(reopened.get("clip", 13, 1234)).toBeUndefined();
      expect(reopened.get("clip", 12, 1235)).toBeUndefined();
      expect(reopened.get("silent", 8, 12)?.transcript).toBe("");
    } finally {
      reopened.close();
    }
    assertUnreadable(path);
  });

  test("migrates legacy plaintext and discards interrupted staging files and their journals", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imessage-transcripts-"));
    const old = new IMessageTranscriptCache(tmpDir);
    old.set("clip", 12, 1234, { transcript: "Invented voice note" });
    old.close();
    const path = await encryptedHome();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      writeFileSync(
        `${path}.encrypting${suffix}`,
        "Invented voice note from interrupted migration",
      );
    }
    const migrated = new IMessageTranscriptCache(tmpDir);
    expect(migrated.get("clip", 12, 1234)?.transcript).toBe("Invented voice note");
    migrated.close();
    expect(readdirSync(join(tmpDir!, "apple-imessage"))).toEqual([
      "transcripts.db",
      "transcripts.db.lock",
    ]);
    assertUnreadable(path);
  });

  test("migration retains committed rows from an abandoned WAL", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imessage-transcripts-"));
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.close();
    const path = join(tmpDir, "apple-imessage", "transcripts.db");
    const writer = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import Database from "better-sqlite3";
      const db = new Database(process.argv[1]);
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      db.prepare("INSERT INTO transcripts VALUES (?, ?, ?, ?, ?)").run("clip", 12, 1234, "Invented voice note", 3);
      process.exit(0);
    `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(writer.status, writer.stderr).toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(true);
    await encryptedHome();
    const migrated = new IMessageTranscriptCache(tmpDir);
    expect(migrated.get("clip", 12, 1234)?.transcript).toBe("Invented voice note");
    migrated.close();
    assertUnreadable(path);
  });

  test("refuses missing, wrong, unavailable and malformed keys without replacing the cache", async () => {
    const path = await encryptedHome();
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.set("clip", 12, 1234, { transcript: "Invented voice note" });
    cache.close();
    const original = readFileSync(path);
    const keyPath = storageKeyPath("imessage-transcripts", tmpDir);
    const envelope = readFileSync(keyPath);
    rmSync(keyPath);
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow(/key.*unavailable/);
    writeFileSync(keyPath, "broken envelope");
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow(/key.*unavailable/);
    writeFileSync(keyPath, envelope);
    await rotateStorageKey("imessage-transcripts", Buffer.alloc(32, 9), {
      backend: "file",
      configDir: tmpDir,
    });
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow();
    writeFileSync(keyPath, envelope);
    rmSync(join(tmpDir!, "keyring", "dev.omnesis"), { recursive: true });
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow(/root key/);
    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(join(tmpDir!, "apple-imessage"))).toEqual([
      "transcripts.db",
      "transcripts.db.lock",
    ]);
  });

  test("preserves corrupt cache bytes and refuses plaintext opening of encrypted data", async () => {
    const path = await encryptedHome();
    mkdirSync(join(tmpDir!, "apple-imessage"), { recursive: true });
    writeFileSync(path, "corrupt database");
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("corrupt database");
    rmSync(path);
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.set("clip", 12, 1234, { transcript: "Invented voice note" });
    cache.close();
    expect(() => openTranscriptDatabase(path, null)).toThrow();
    assertUnreadable(path);
  });

  test("holds lifetime exclusion across instances and cleans staging only after authenticating", async () => {
    const path = await encryptedHome();
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.set("clip", 12, 1234, { transcript: "Invented voice note" });
    expect(() => new IMessageTranscriptCache(tmpDir)).toThrow(/locked/);
    const contender = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import Database from "better-sqlite3";
      const db = new Database(process.argv[1]);
      db.pragma("busy_timeout = 0");
      try { db.exec("BEGIN EXCLUSIVE"); process.exit(1); }
      catch { process.exit(0); }
    `,
        `${path}.lock`,
      ],
      { encoding: "utf8" },
    );
    expect(contender.status, contender.stderr).toBe(0);
    expect(cache.get("clip", 12, 1234)?.transcript).toBe("Invented voice note");
    cache.close();
    writeFileSync(`${path}.encrypting`, "orphaned plaintext");
    expect(() => openTranscriptDatabase(path, Buffer.alloc(32, 7))).toThrow();
    expect(existsSync(`${path}.encrypting`)).toBe(true);
    const reopened = new IMessageTranscriptCache(tmpDir);
    reopened.close();
    expect(existsSync(`${path}.encrypting`)).toBe(false);
  });

  test("failed migration leaves the original usable and retries successfully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imessage-transcripts-"));
    const cache = new IMessageTranscriptCache(tmpDir);
    cache.set("clip", 12, 1234, { transcript: "Invented voice note" });
    cache.close();
    const path = join(tmpDir, "apple-imessage", "transcripts.db");
    expect(() => openTranscriptDatabase(path, Buffer.alloc(3))).toThrow(/32 bytes/);
    expect(existsSync(`${path}.encrypting`)).toBe(false);
    const original = new IMessageTranscriptCache(tmpDir);
    expect(original.get("clip", 12, 1234)?.transcript).toBe("Invented voice note");
    original.close();
    const encrypted = openTranscriptDatabase(path, Buffer.alloc(32, 1));
    expect(encrypted.db.prepare("SELECT transcript FROM transcripts").get()).toEqual({
      transcript: "Invented voice note",
    });
    encrypted.close();
    assertUnreadable(path);
  });
});
