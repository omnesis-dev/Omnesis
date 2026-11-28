// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  stat,
  rename,
  symlink,
  readdir,
  chmod,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pack } from "tar-stream";
import {
  ensureInstallRootKey,
  readInstallRootKey,
  readEncryptedArtifactStream,
  isEncryptedArtifactFile,
} from "@omnesis/core";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { desktopJournalPath } from "./profile.js";
import { DesktopRestoreImports, type DesktopRestoreFileSelection } from "./restore-imports.js";

let dir: string;
let profile: DesktopProfile;
let imports: DesktopRestoreImports;
let rootKey: string;
const signal = new AbortController().signal;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "omnesis-restore-import-")));
  profile = desktopProfile(dir);
  await mkdir(profile.configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
  await writeFile(
    desktopJournalPath(profile),
    JSON.stringify({
      version: 1,
      owner: "omnesis-desktop",
      instance: profile.instance,
      secretService: profile.secretService,
      mode: "home",
      phase: "configured",
      embedder: null,
      memoryLimitMb: 512,
    }),
    { mode: 0o600 },
  );
  await ensureInstallRootKey({ backend: "file", configDir: profile.configDir });
  rootKey = (await readInstallRootKey({ backend: "file", configDir: profile.configDir }))!;
  imports = new DesktopRestoreImports(profile, {
    readRootKey: async (options) => {
      expect(options).toMatchObject({
        backend: "macos-keychain",
        service: profile.secretService,
        configDir: profile.configDir,
      });
      return rootKey;
    },
  });
});
afterEach(async () => {
  await imports.close();
  await rm(dir, { recursive: true, force: true });
});
function slotDirectory(id: string): string {
  return join(`${profile.configDir}.bootstrap`, "restore-imports", id);
}
async function input(
  body = "fixture",
): Promise<{ selection: DesktopRestoreFileSelection; sha256: string }> {
  const tar = pack(),
    chunks: Buffer[] = [];
  const consume = (async () => {
    for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  tar.entry({ name: "backup/omnesis.db" }, body);
  tar.entry(
    { name: "backup/backup-manifest.json" },
    JSON.stringify({
      version: "0.7.0",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      includeIndex: false,
      files: [{ name: "omnesis.db", bytes: body.length }],
    }),
  );
  tar.finalize();
  await consume;
  const bytes = Buffer.concat(chunks),
    path = join(dir, `selected-${randomUUID()}.tar`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  const metadata = await stat(path, { bigint: true });
  return {
    selection: {
      path,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      bytes: bytes.length,
      mtimeSeconds: String(metadata.mtimeNs / 1_000_000_000n),
      mtimeNanoseconds: String(metadata.mtimeNs % 1_000_000_000n),
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("allocates bounded opaque slots outside the restorable library and accepts only its own IDs", async () => {
  const slot = await imports.prepare(signal);
  expect(slot).toMatchObject({ kind: "desktopRestoreImport" });
  expect(slot).not.toHaveProperty("archivePath");
  expect(slot.maxBytes).toBeGreaterThan(0);
  expect(slot.maxBytes).toBeLessThanOrEqual(1024 ** 4);
  expect((await stat(slotDirectory(slot.importId))).mode & 0o777).toBe(0o700);
  await imports.prepare(signal);
  await expect(imports.prepare(signal)).rejects.toThrow("Finish or cancel");
  const selected = await input();
  await expect(imports.ingest("../../other", selected.selection, signal)).rejects.toThrow(
    "Select the backup again",
  );
});

test.skipIf(process.platform === "win32")(
  "accepts exact signed POSIX seconds with normalized nonnegative nanoseconds",
  async () => {
    const slot = await imports.prepare(signal),
      selected = await input();
    await utimes(selected.selection.path, new Date(-500), new Date(-500));
    const metadata = await stat(selected.selection.path, { bigint: true });
    expect(metadata.mtimeNs).toBeLessThan(0n);
    const seconds = (metadata.mtimeNs - 999_999_999n) / 1_000_000_000n;
    selected.selection.mtimeSeconds = String(seconds);
    selected.selection.mtimeNanoseconds = String(metadata.mtimeNs - seconds * 1_000_000_000n);
    expect(await imports.ingest(slot.importId, selected.selection, signal)).toEqual({
      sha256: selected.sha256,
      bytes: selected.selection.bytes,
    });
  },
);
test("seals original readable selections directly and every extracted entry, retaining original and live authority", async () => {
  const slot = await imports.prepare(signal),
    selected = await input();
  await chmod(selected.selection.path, 0o644);
  const receipt = await imports.ingest(slot.importId, selected.selection, signal);
  expect(receipt.sha256).toBe(selected.sha256);
  const spool = join(slotDirectory(slot.importId), "input.tar.enc");
  expect(isEncryptedArtifactFile(spool)).toBe(true);
  expect((await readFile(spool)).includes(Buffer.from("fixture"))).toBe(false);
  expect(await readdir(slotDirectory(slot.importId))).toEqual(["input.tar.enc", "owner.json"]);
  const result = await imports.unpack(slot.importId, {
    ...receipt,
    currentVersion: "0.7.8",
    signal,
  });
  const sealed = result.archive.sealedFiles.get("omnesis.db")!;
  const chunks: Buffer[] = [];
  const stream = readEncryptedArtifactStream(sealed.path, {
    rootKey,
    expectedScope: sealed.scope,
    signal,
  });
  for await (const chunk of stream) chunks.push(chunk);
  stream.authentication();
  expect(Buffer.concat(chunks).toString("utf8")).toBe("fixture");
  for (const file of result.archive.sealedFiles.values())
    expect(isEncryptedArtifactFile(file.path)).toBe(true);
  await imports.cancel(slot.importId);
  await expect(stat(slotDirectory(slot.importId))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readFile(selected.selection.path)).includes(Buffer.from("fixture"))).toBe(true);
});
test("selection identity changes and wrong receipts refuse and remove only owned staging", async () => {
  const selected = await input(),
    slot = await imports.prepare(signal);
  await expect(
    imports.ingest(slot.importId, { ...selected.selection, inode: "0" }, signal),
  ).rejects.toThrow("changed or could not be imported");
  await expect(stat(slotDirectory(slot.importId))).rejects.toMatchObject({ code: "ENOENT" });
  const next = await imports.prepare(signal),
    receipt = await imports.ingest(next.importId, selected.selection, signal);
  await expect(
    imports.unpack(next.importId, {
      ...receipt,
      sha256: "a".repeat(64),
      currentVersion: "0.7.8",
      signal,
    }),
  ).rejects.toThrow("Select the backup again");
  expect(await readFile(selected.selection.path)).toHaveLength(selected.selection.bytes);
});
test("a selected regular file swapped to FIFO refuses promptly before read", async () => {
  if (process.platform === "win32") return;
  const slot = await imports.prepare(signal),
    selected = await input();
  await rename(selected.selection.path, `${selected.selection.path}-retained`);
  execFileSync("mkfifo", [selected.selection.path]);
  await expect(imports.ingest(slot.importId, selected.selection, signal)).rejects.toThrow(
    "changed or could not be imported",
  );
  await expect(stat(slotDirectory(slot.importId))).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancel drains an in-flight selection read and validation before removing owned ciphertext", async () => {
  const slot = await imports.prepare(signal),
    selected = await input("x".repeat(8 * 1024 * 1024));
  const pending = imports.ingest(slot.importId, selected.selection, signal),
    rejected = expect(pending).rejects.toThrow();
  await imports.cancel(slot.importId);
  await rejected;
  await expect(stat(slotDirectory(slot.importId))).rejects.toMatchObject({ code: "ENOENT" });
  const next = await imports.prepare(signal),
    receipt = await imports.ingest(next.importId, selected.selection, signal);
  const validation = imports.unpack(next.importId, { ...receipt, currentVersion: "0.7.8", signal }),
    refused = expect(validation).rejects.toThrow();
  await imports.cancel(next.importId);
  await refused;
  await expect(stat(slotDirectory(next.importId))).rejects.toMatchObject({ code: "ENOENT" });
});
test("expires abandoned encrypted spools without another import", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const slot = await imports.prepare(signal),
      selected = await input();
    await imports.ingest(slot.importId, selected.selection, signal);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.waitFor(async () => {
      await expect(stat(slotDirectory(slot.importId))).rejects.toMatchObject({ code: "ENOENT" });
    });
  } finally {
    vi.useRealTimers();
  }
});
test("retains a replacement at its old staging path and refuses joined installs or linked parents", async () => {
  const slot = await imports.prepare(signal),
    path = slotDirectory(slot.importId);
  await rename(path, `${path}-retained`);
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, "unrelated"), "retained");
  await expect(imports.cancel(slot.importId)).rejects.toThrow("replacement was retained");
  expect(await readFile(join(path, "unrelated"), "utf8")).toBe("retained");
  const journal = JSON.parse(await readFile(desktopJournalPath(profile), "utf8"));
  await writeFile(desktopJournalPath(profile), JSON.stringify({ ...journal, mode: "joined" }), {
    mode: 0o600,
  });
  await expect(imports.prepare(signal)).rejects.toThrow("Mac that owns");
  await writeFile(desktopJournalPath(profile), JSON.stringify(journal), { mode: 0o600 });
  await rename(join(`${profile.configDir}.bootstrap`, "restore-imports"), join(dir, "old-imports"));
  const other = join(dir, "other");
  await mkdir(other, { mode: 0o700 });
  await symlink(other, join(`${profile.configDir}.bootstrap`, "restore-imports"));
  await expect(imports.prepare(signal)).rejects.toThrow("private and owned");
  await imports.close();
  await expect(imports.prepare(signal)).rejects.toThrow();
});
