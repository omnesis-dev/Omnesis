// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import {
  ensureInstallRootKey,
  readInstallRootKey,
  produceEncryptedArtifact,
  createRecoveryEnvelope,
  writeSecretTextFile,
  readSecretTextFile,
  type BackupManifest,
} from "@omnesis/core";
import { DesktopRestoreEntries } from "./restore-entries.js";
import type { DesktopBackupArchive } from "./restore-archive.js";

let dir: string, sourceFolder: string, targetFolder: string, sourceRoot: string, targetRoot: string;
const signal = new AbortController().signal;
const code = "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-ZABCD";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-restore-entries-"));
  sourceFolder = join(dir, "source");
  targetFolder = join(dir, "target");
  await ensureInstallRootKey({ backend: "file", configDir: sourceFolder });
  await ensureInstallRootKey({ backend: "file", configDir: targetFolder });
  sourceRoot = (await readInstallRootKey({ backend: "file", configDir: sourceFolder }))!;
  targetRoot = (await readInstallRootKey({ backend: "file", configDir: targetFolder }))!;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function encrypted(bytes: Buffer, rootKey: string, scope: string): Promise<Buffer> {
  const path = join(dir, `encrypted-${randomUUID()}.enc`);
  await produceEncryptedArtifact(path, { rootKey, scope }, async (body) => {
    body.write(bytes);
  });
  return readFile(path);
}
async function fixture(same = false): Promise<{
  archive: DesktopBackupArchive;
  epoch: string;
  stage: (name: string, bytes: Buffer) => Promise<void>;
}> {
  const root = same ? targetRoot : sourceRoot,
    folder = same ? targetFolder : sourceFolder,
    epoch = randomUUID();
  const secretPath = join(folder, "config-secrets", "credential.json");
  await writeSecretTextFile(secretPath, "invented-provider-access-key", {
    backend: "file",
    configDir: folder,
  });
  const sourceFiles = new Map<string, Buffer>([
    [
      "omnesis.db.enc",
      await encrypted(Buffer.from("invented database bytes"), root, `backup:${epoch}:omnesis.db`),
    ],
    [
      "config-secrets/credential.json.enc",
      await encrypted(
        await readFile(secretPath),
        root,
        `backup:${epoch}:config-secrets/credential.json`,
      ),
    ],
    [
      "keyring/recovery-envelope.json",
      Buffer.from(JSON.stringify(createRecoveryEnvelope(root, code))),
    ],
  ]);
  const full: BackupManifest = {
    version: "0.7.8",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    includeIndex: false,
    encryption: { scheme: "omnesis.encrypted-artifact.v1", key: "install-root-key-v1" },
    files: [...sourceFiles].map(([name, body]) => ({
      name,
      bytes: body.length,
      encrypted: name.endsWith(".enc"),
    })),
    note: "Invented private operator note",
  };
  const name = "backup-manifest.full.json.enc";
  sourceFiles.set(
    name,
    await encrypted(
      Buffer.from(JSON.stringify(full)),
      root,
      `backup:${epoch}:backup-manifest.full.json`,
    ),
  );
  const manifest = {
    ...full,
    note: undefined,
    files: [...full.files, { name, bytes: sourceFiles.get(name)!.length, encrypted: true }],
    encryptedManifest: name,
  };
  const files = new Map<string, number>(),
    sealedFiles = new Map<string, { path: string; scope: string }>();
  const stage = async (name: string, bytes: Buffer) => {
    const path = join(dir, `stage-${randomUUID()}.enc`),
      scope = `desktop-restore:fixture:entry:${name}`;
    await produceEncryptedArtifact(path, { rootKey: targetRoot, scope }, async (body) => {
      body.write(bytes);
    });
    files.set(name, bytes.length);
    sealedFiles.set(name, { path, scope });
  };
  for (const [name, bytes] of sourceFiles) await stage(name, bytes);
  return {
    archive: { manifest, files, sealedFiles, sha256: "a".repeat(64), bytes: 4096 },
    epoch,
    stage,
  };
}
test("foreign backup recovery never publishes a root key or replaces the target root", async () => {
  const { archive } = await fixture(),
    entries = new DesktopRestoreEntries(archive, targetRoot, signal);
  await expect(entries.read("omnesis.db.enc", 1024)).rejects.toMatchObject({
    code: "RECOVERY_CODE_REQUIRED",
  });
  expect(await entries.unlock()).toEqual({ needsRecoveryCode: true });
  await expect(entries.unlock({ recoveryCode: "wrong-code" })).rejects.toThrow(
    "does not open this backup",
  );
  expect(await entries.unlock({ recoveryCode: code })).toEqual({ needsRecoveryCode: false });
  expect((await entries.read("omnesis.db.enc", 1024)).toString()).toBe("invented database bytes");
  expect(JSON.stringify(entries)).toBe("{}");
  const raw = (await entries.read("config-secrets/credential.json.enc", 16384)).toString();
  const rewrapped = entries.rewrapSecret(raw, "config:config-secrets/credential.json");
  const target = join(targetFolder, "config-secrets", "credential.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, rewrapped, { mode: 0o600 });
  expect(await readSecretTextFile(target, { backend: "file", configDir: targetFolder })).toBe(
    "invented-provider-access-key",
  );
  expect(await readInstallRootKey({ backend: "file", configDir: targetFolder })).toBe(targetRoot);
  expect(await readInstallRootKey({ backend: "file", configDir: sourceFolder })).toBe(sourceRoot);
  entries.close();
  await expect(entries.read("omnesis.db.enc", 1024)).rejects.toMatchObject({
    code: "RECOVERY_CODE_REQUIRED",
  });
});
test("a backup under the current root needs no recovery ceremony", async () => {
  const { archive } = await fixture(true),
    entries = new DesktopRestoreEntries(archive, targetRoot, signal);
  expect(await entries.unlock()).toEqual({ needsRecoveryCode: false });
  expect((await entries.read("omnesis.db.enc", 1024)).toString()).toBe("invented database bytes");
  await expect(entries.read("omnesis.db.enc", 4)).rejects.toThrow("memory bound");
});
test("mixed authenticated backup epochs refuse and cancellation never becomes a recovery prompt", async () => {
  const { archive, stage } = await fixture();
  const entries = new DesktopRestoreEntries(archive, targetRoot, signal);
  await entries.unlock({ recoveryCode: code });
  await stage(
    "omnesis.db.enc",
    await encrypted(
      Buffer.from("invented database bytes"),
      sourceRoot,
      `backup:${randomUUID()}:omnesis.db`,
    ),
  );
  await expect(entries.read("omnesis.db.enc", 1024)).rejects.toThrow("different encryption epochs");
  const controller = new AbortController();
  controller.abort();
  await expect(
    new DesktopRestoreEntries(archive, targetRoot, controller.signal).unlock(),
  ).rejects.toMatchObject({ name: "AbortError" });
});
test("unmodified legacy readable entries remain memory-only and do not import machine authority", async () => {
  const files = new Map<string, number>(),
    sealedFiles = new Map<string, { path: string; scope: string }>();
  const name = "omnesis.db",
    body = Buffer.from("invented legacy bytes"),
    path = join(dir, "legacy-stage.enc"),
    scope = "desktop-restore:fixture:entry:omnesis.db";
  await produceEncryptedArtifact(path, { rootKey: targetRoot, scope }, async (output) => {
    output.write(body);
  });
  files.set(name, body.length);
  sealedFiles.set(name, { path, scope });
  const archive: DesktopBackupArchive = {
    manifest: {
      version: "0.7.8",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      includeIndex: false,
      files: [{ name, bytes: body.length }],
    },
    files,
    sealedFiles,
    sha256: "a".repeat(64),
    bytes: 4096,
  };
  const entries = new DesktopRestoreEntries(archive, targetRoot, signal);
  expect(await entries.unlock()).toEqual({ needsRecoveryCode: false });
  expect(await entries.read(name, 1024)).toEqual(body);
  expect((await readFile(path)).includes(body)).toBe(false);
});
