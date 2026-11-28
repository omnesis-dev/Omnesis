// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpath, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import {
  ensureInstallRootKey,
  readInstallRootKey,
  ensureStorageKey,
  readStorageKey,
  storageKeyPath,
  produceEncryptedArtifact,
  createRecoveryEnvelope,
  type StorageKeyOptions,
  type StorageKeyName,
} from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { DesktopRestoreEntries } from "./restore-entries.js";
import { DesktopRestoreStoreKeys } from "./restore-store-keys.js";
import type { DesktopBackupArchive } from "./restore-archive.js";

let dir: string,
  source: string,
  profile: DesktopProfile,
  sourceRoot: string,
  targetRoot: string,
  sourceKey: Buffer,
  targetKey: Buffer;
const signal = new AbortController().signal,
  code = "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-ZABCD";
let calls: string[][];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-store-keys-")));
  source = join(dir, "source");
  profile = desktopProfile(dir);
  calls = [];
  await ensureInstallRootKey({ backend: "file", configDir: source });
  await ensureInstallRootKey({
    backend: "file",
    configDir: profile.configDir,
    service: profile.secretService,
  });
  sourceRoot = (await readInstallRootKey({ backend: "file", configDir: source }))!;
  targetRoot = (await readInstallRootKey({
    backend: "file",
    configDir: profile.configDir,
    service: profile.secretService,
  }))!;
  await ensureStorageKey("main-db", { backend: "file", configDir: source });
  await ensureStorageKey("main-db", {
    backend: "file",
    configDir: profile.configDir,
    service: profile.secretService,
  });
  sourceKey = (await readStorageKey("main-db", { backend: "file", configDir: source }))!;
  targetKey = (await readStorageKey("main-db", {
    backend: "file",
    configDir: profile.configDir,
    service: profile.secretService,
  }))!;
});
afterEach(async () => {
  sourceKey.fill(0);
  targetKey.fill(0);
  await rm(dir, { recursive: true, force: true });
});
async function readKey(name: StorageKeyName, options?: StorageKeyOptions) {
  if (!options) throw new Error("The restore key reader must receive an explicit scope");
  expect(options).toMatchObject({ backend: "macos-keychain", service: profile.secretService });
  return readStorageKey(name, {
    ...options,
    runCommand: async (cmd, args) => {
      expect(cmd).toBe("security");
      calls.push(args);
      if (args[0] === "-h") return { code: 0, stdout: "", stderr: "" };
      expect(args[0]).toBe("find-generic-password");
      expect(args[args.indexOf("-s") + 1]).toBe(profile.secretService);
      expect(args[args.indexOf("-a") + 1]).toBe("install-root-key-v1");
      return { code: 0, stdout: targetRoot, stderr: "" };
    },
  });
}
async function fixture() {
  const files = new Map<string, number>(),
    sealedFiles = new Map<string, { path: string; scope: string }>();
  const stage = async (name: string, bytes: Buffer) => {
    const path = join(dir, `sealed-${sealedFiles.size}-${Date.now()}.enc`),
      scope = `desktop-restore:fixture:entry:${name}`;
    await produceEncryptedArtifact(path, { rootKey: targetRoot, scope }, async (body) => {
      body.write(bytes);
    });
    files.set(name, bytes.length);
    sealedFiles.set(name, { path, scope });
  };
  await stage(
    "keyring/storage-keys/main-db.json",
    await readFile(storageKeyPath("main-db", source)),
  );
  await stage(
    "keyring/recovery-envelope.json",
    Buffer.from(JSON.stringify(createRecoveryEnvelope(sourceRoot, code))),
  );
  const archive: DesktopBackupArchive = {
    manifest: {
      version: "0.7.8",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      includeIndex: false,
      files: [...files].map(([name, bytes]) => ({ name, bytes })),
    },
    files,
    sealedFiles,
    sha256: "a".repeat(64),
    bytes: 4096,
  };
  const entries = new DesktopRestoreEntries(archive, targetRoot, signal);
  expect(await entries.unlock({ recoveryCode: code })).toEqual({ needsRecoveryCode: false });
  return { entries, stage };
}
test("maps source DEKs by exact store name and rewraps only their envelopes under the existing target root", async () => {
  const { entries } = await fixture();
  const before = await readFile(storageKeyPath("main-db", profile.configDir));
  const keys = await DesktopRestoreStoreKeys.prepare(
    { profile, entries, directory: join(dir, "key-stage"), signal },
    { readKey },
  );
  expect(keys.source("main-db")).toEqual(sourceKey);
  expect(keys.target("main-db")).toEqual(targetKey);
  expect(keys.source("index-db")).toBeNull();
  expect(keys.wrapped("index-db")).toBeNull();
  expect(keys.wrapped("main-db")?.logical).toBe("keyring/storage-keys/main-db.json");
  expect(JSON.stringify(keys)).toBe("{}");
  expect(await readFile(storageKeyPath("main-db", profile.configDir))).toEqual(before);
  expect(
    await readInstallRootKey({
      backend: "file",
      configDir: profile.configDir,
      service: profile.secretService,
    }),
  ).toBe(targetRoot);
  const held = keys.source("main-db")!;
  keys.close();
  expect(held.every((byte) => byte === 0)).toBe(true);
  expect(calls.every((args) => args[0] === "-h" || args[0] === "find-generic-password")).toBe(true);
});
test("an authenticated key cannot be relabelled for another store or replace target authority", async () => {
  const { entries, stage } = await fixture();
  await ensureStorageKey("analytics-db", { backend: "file", configDir: source });
  await stage(
    "keyring/storage-keys/main-db.json",
    await readFile(storageKeyPath("analytics-db", source)),
  );
  const before = await readFile(storageKeyPath("main-db", profile.configDir));
  await expect(
    DesktopRestoreStoreKeys.prepare(
      { profile, entries, directory: join(dir, "wrong-stage"), signal },
      { readKey },
    ),
  ).rejects.toThrow("could not be reconciled");
  expect(await readFile(storageKeyPath("main-db", profile.configDir))).toEqual(before);
});
test("cancellation does not read, create or rotate any Keychain item", async () => {
  const { entries } = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(
    DesktopRestoreStoreKeys.prepare(
      { profile, entries, directory: join(dir, "cancelled-stage"), signal: controller.signal },
      { readKey },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([]);
});
