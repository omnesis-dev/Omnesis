// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
  symlink,
  chmod,
  link,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureInstallRootKey,
  readInstallRootKey,
  readEncryptedArtifactStream,
  produceEncryptedArtifact,
} from "@omnesis/core";
import { pack, type Header } from "tar-stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractDesktopBackupArchive } from "./restore-archive.js";

let root: string;
let rootKey: string;
const manifest = (files = [{ name: "omnesis.db", bytes: 7 }], extra = {}) => ({
  version: "0.7.0",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  includeIndex: false,
  files,
  ...extra,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omnesis-restore-archive-"));
  await ensureInstallRootKey({ backend: "file", configDir: root });
  rootKey = (await readInstallRootKey({ backend: "file", configDir: root }))!;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function archive(
  entries: Array<{ name: string; body?: string; type?: Header["type"]; linkname?: string }>,
): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      tar.entry(
        { name: entry.name, type: entry.type ?? "file", linkname: entry.linkname },
        entry.body ?? "",
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  tar.finalize();
  await reading;
  return Buffer.concat(chunks);
}
async function fixture(
  extra: Array<{ name: string; body?: string; type?: Header["type"]; linkname?: string }> = [],
  value = manifest(),
): Promise<Buffer> {
  return archive([
    { name: "backup/", type: "directory" },
    { name: "backup/backup-manifest.json", body: JSON.stringify(value) },
    { name: "backup/omnesis.db", body: "fixture" },
    ...extra,
  ]);
}
async function options(bytes: Buffer) {
  const archivePath = join(root, "input.tar");
  await writeFile(archivePath, bytes, { mode: 0o600 });
  return {
    archivePath,
    destination: join(root, "unpacked"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    currentVersion: "0.7.8",
    seal: { rootKey, scope: "restore:invented" },
    signal: new AbortController().signal,
  };
}
async function refused(bytes: Buffer) {
  const opts = await options(bytes);
  await expect(extractDesktopBackupArchive(opts)).rejects.toThrow(
    "complete supported Omnesis backup",
  );
  await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
}
describe("private desktop backup archive boundary", () => {
  test("extracts declared stores and nested credential files privately with exact bytes", async () => {
    const bytes = await fixture(
      [
        { name: "backup/config-secrets/", type: "directory" },
        { name: "backup/config-secrets/example.enc", body: "sealed" },
      ],
      manifest([
        { name: "omnesis.db", bytes: 7 },
        { name: "config-secrets", bytes: 6 },
      ]),
    );
    const opts = await options(bytes);
    const result = await extractDesktopBackupArchive(opts);
    expect(result.manifest.version).toBe("0.7.0");
    expect(result.files.get("config-secrets/example.enc")).toBe(6);
    expect(await plain(result.sealedFiles.get("omnesis.db")!)).toBe("fixture");
    await expect(stat(join(opts.destination, "omnesis.db"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(opts.destination)).mode & 0o777).toBe(0o700);
    expect((await stat(result.sealedFiles.get("omnesis.db")!.path)).mode & 0o777).toBe(0o600);
  });
  test("accepts current encrypted-artifact names without decrypting or importing keys", async () => {
    const bytes = await archive([
      { name: "backup/omnesis.db.enc", body: "sealed" },
      { name: "backup/backup-manifest.full.json.enc", body: "sealed-full" },
      {
        name: "backup/backup-manifest.json",
        body: JSON.stringify(
          manifest(
            [
              { name: "omnesis.db.enc", bytes: 6 },
              { name: "backup-manifest.full.json.enc", bytes: 11 },
            ],
            {
              encryption: { scheme: "omnesis.encrypted-artifact.v1", key: "install-root-key-v1" },
              encryptedManifest: "backup-manifest.full.json.enc",
            },
          ),
        ),
      },
    ]);
    const opts = await options(bytes);
    const result = await extractDesktopBackupArchive(opts);
    expect(await plain(result.sealedFiles.get("omnesis.db.enc")!)).toBe("sealed");
  });
  test("extracts an encrypted spool only after terminal authentication and seals every staged entry", async () => {
    const bytes = await fixture();
    const opts = await options(bytes);
    const encryptedPath = join(root, "input.tar.enc");
    await produceEncryptedArtifact(
      encryptedPath,
      { rootKey, scope: "restore:archive" },
      async (body) => {
        body.write(bytes);
      },
    );
    const protectedOptions = {
      ...opts,
      archivePath: encryptedPath,
      inputProtection: { rootKey, scope: "restore:archive" },
    };
    const result = await extractDesktopBackupArchive(protectedOptions);
    for (const file of result.sealedFiles.values()) {
      const stored = await readFile(file.path);
      expect(stored.toString("utf8")).toMatch(/^omnesis.encrypted-artifact.v1/);
      expect(stored.includes(Buffer.from("fixture"))).toBe(false);
    }
    await rm(opts.destination, { recursive: true, force: true });
    const corrupt = await readFile(encryptedPath);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(encryptedPath, corrupt);
    await expect(extractDesktopBackupArchive(protectedOptions)).rejects.toThrow(
      "complete supported",
    );
    await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects traversal, alternate roots, absolute names and special entries", async () => {
    for (const name of [
      "backup/../escaped",
      "/backup/token",
      "other/token",
      "backup/config-secrets/../../escaped",
      "backup/token:alternate",
      "backup/config-secrets\\escaped",
    ])
      await refused(await fixture([{ name, body: "secret" }]));
    for (const type of ["symlink", "link", "fifo", "character-device"] as const)
      await refused(
        await fixture([{ name: "backup/config-secrets/value", type, linkname: "../../escape" }]),
      );
    await expect(stat(join(root, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("rejects duplicate and colliding entries without overwriting output", async () => {
    await refused(await fixture([{ name: "backup/omnesis.db", body: "changed" }]));
    await refused(
      await fixture([
        { name: "backup/config-secrets", body: "file" },
        { name: "backup/config-secrets/token", body: "token" },
      ]),
    );
  });
  test("rejects undeclared files, missing entries, wrong counts and forward versions", async () => {
    await refused(await fixture([{ name: "backup/token", body: "not-declared" }]));
    await refused(await fixture([], manifest([{ name: "omnesis.db", bytes: 9 }])));
    await refused(await fixture([], manifest([{ name: "absent.db", bytes: 7 }])));
    await refused(await fixture([], manifest(undefined, { version: "99.0.0" })));
    await refused(await fixture([], manifest(undefined, { finishedAt: "not-a-date" })));
    await refused(await fixture([], manifest(undefined, { encryptedManifest: "missing.enc" })));
  });
  test("requires exact input hash, bounded metadata and complete TAR termination", async () => {
    const bytes = await fixture();
    const opts = await options(bytes);
    await expect(
      extractDesktopBackupArchive({ ...opts, sha256: "a".repeat(64) }),
    ).rejects.toThrow();
    for (const limits of [
      { maxEntries: 1 },
      { maxFileBytes: 3 },
      { maxManifestBytes: 16 },
      { maxBytes: 100 },
    ]) {
      await expect(extractDesktopBackupArchive({ ...opts, limits })).rejects.toThrow();
      await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await refused(bytes.subarray(0, bytes.length - 512));
  });
  test("aborts in-flight extraction and rejects an input unlinked during reading", async () => {
    const body = "x".repeat(8 * 1024 * 1024);
    const bytes = await archive([
      {
        name: "backup/backup-manifest.json",
        body: JSON.stringify(manifest([{ name: "omnesis.db", bytes: body.length }])),
      },
      { name: "backup/omnesis.db", body },
    ]);
    const opts = await options(bytes);
    const controller = new AbortController();
    const pending = extractDesktopBackupArchive({ ...opts, signal: controller.signal });
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow();
    await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
    const stale = extractDesktopBackupArchive(opts);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await unlink(opts.archivePath);
    await expect(stale).rejects.toThrow("complete supported Omnesis backup");
    await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("never follows selected-file links or adopts an existing extraction directory", async () => {
    const opts = await options(await fixture());
    const linked = join(root, "linked.tar");
    await symlink(opts.archivePath, linked);
    const hardlinked = join(root, "hardlinked.tar");
    await link(opts.archivePath, hardlinked);
    await expect(extractDesktopBackupArchive(opts)).rejects.toThrow();
    await unlink(hardlinked);
    await expect(extractDesktopBackupArchive({ ...opts, archivePath: linked })).rejects.toThrow();
    await mkdir(opts.destination);
    await writeFile(join(opts.destination, "unrelated"), "retained");
    await expect(extractDesktopBackupArchive(opts)).rejects.toThrow();
    expect(await readFile(join(opts.destination, "unrelated"), "utf8")).toBe("retained");
  });
  test("refuses readable imported archives and cancels without publishing or retaining a partial stage", async () => {
    const opts = await options(await fixture());
    await chmod(opts.archivePath, 0o644);
    await expect(extractDesktopBackupArchive(opts)).rejects.toThrow();
    await chmod(opts.archivePath, 0o600);
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractDesktopBackupArchive({ ...opts, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(stat(opts.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function plain(file: { path: string; scope: string }): Promise<string> {
  const chunks: Buffer[] = [];
  const reading = readEncryptedArtifactStream(file.path, {
    rootKey,
    expectedScope: file.scope,
    signal: new AbortController().signal,
  });
  for await (const chunk of reading) chunks.push(chunk);
  reading.authentication();
  return Buffer.concat(chunks).toString("utf8");
}
