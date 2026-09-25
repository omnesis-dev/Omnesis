// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import {
  StorageKeyRootKeyUnavailableError,
  ensureStorageKey,
  inspectStorageKey,
  markStorageEncryptionRequired,
  parseStorageKeyName,
  readStorageKey,
  readStorageKeySync,
  rotateStorageKey,
  storageEncryptionRequired,
  storageKeyHex,
  storageKeyPath,
} from "./storage-keys.js";

describe("storage keys", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-storage-keys-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a wrapped per-store key when the install root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const result = await ensureStorageKey("main-db", { backend: "file", configDir: dir });
    const key = await readStorageKey("main-db", { backend: "file", configDir: dir });

    expect(result).toMatchObject({
      keyName: "main-db",
      present: true,
      valid: true,
      encrypted: true,
      created: true,
    });
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    const raw = readFileSync(storageKeyPath("main-db", dir), "utf8");
    expect(raw).toContain("omnesis.storage-key");
    expect(raw).not.toContain(storageKeyHex(key!));
    expect(storageEncryptionRequired(dir)).toBe(true);
  });

  test("is idempotent once a wrapped key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const first = await ensureStorageKey("index-db", { backend: "file", configDir: dir });
    const firstKey = await readStorageKey("index-db", { backend: "file", configDir: dir });
    const second = await ensureStorageKey("index-db", { backend: "file", configDir: dir });
    const secondKey = await readStorageKey("index-db", { backend: "file", configDir: dir });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(secondKey?.equals(firstKey!)).toBe(true);
  });

  test("fails closed when the root key is unavailable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await ensureStorageKey("analytics-db", { backend: "file", configDir: dir });
    rmSync(join(dir, "keyring", "dev.omnesis"), { recursive: true, force: true });

    await expect(
      readStorageKey("analytics-db", { backend: "file", configDir: dir }),
    ).rejects.toThrow(StorageKeyRootKeyUnavailableError);
    expect(() => readStorageKeySync("analytics-db", { backend: "file", configDir: dir })).toThrow(
      StorageKeyRootKeyUnavailableError,
    );
  });

  test("reports absent and corrupt wrapped keys", async () => {
    await expect(inspectStorageKey("main-db", { configDir: dir })).resolves.toMatchObject({
      present: false,
      valid: false,
      encrypted: false,
    });
    await markStorageEncryptionRequired(dir);
    expect(storageEncryptionRequired(dir)).toBe(true);
    expect(existsSync(storageKeyPath("main-db", dir))).toBe(false);
  });

  test("rotates a wrapped key with caller-supplied bytes", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await ensureStorageKey("main-db", { backend: "file", configDir: dir });
    const next = Buffer.alloc(32, 7);

    await rotateStorageKey("main-db", next, { backend: "file", configDir: dir });

    const loaded = await readStorageKey("main-db", { backend: "file", configDir: dir });
    expect(loaded?.equals(next)).toBe(true);
  });

  test("parses known and provider-owned key names", () => {
    expect(parseStorageKeyName("main-db")).toBe("main-db");
    expect(parseStorageKeyName("imessage-transcripts")).toBe("imessage-transcripts");
    expect(parseStorageKeyName("provider:whatsapp-store")).toBe("provider:whatsapp-store");
    expect(() => parseStorageKeyName("")).toThrow(/Invalid/);
  });
});
