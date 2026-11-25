// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteFile, assertNever } from "@omnesis/core";
import { assertDesktopRuntimeLeases, type DesktopRuntimeLeases } from "./runtime-leases.js";
import type { DesktopProfile } from "./environment.js";

const MAX_ENTRIES = 200_000;
const MAX_MANIFEST_BYTES = 32 * 1024 ** 2;
const excludedRoots = new Set([
  "backups",
  "models",
  "logs",
  "runtime-owner",
  "gateway-owner",
  "collector-owner",
]);
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part && part !== "." && part !== "..") &&
      !excluded(path),
  );
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: pathSchema }).strict(),
  z
    .object({
      kind: z.literal("file"),
      path: pathSchema,
      bytes: z.number().int().nonnegative().safe(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      executable: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("symlink"),
      path: pathSchema,
      target: z
        .string()
        .max(4096)
        .refine((value) => !value.includes("\0")),
    })
    .strict(),
]);
const manifestSchema = z
  .object({
    format: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string(),
    secretService: z.string(),
    operationId: z.string().uuid(),
    entries: z.array(entrySchema).max(MAX_ENTRIES),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
export interface DesktopUpdateSnapshot {
  manifestSha256: string;
  bytes: number;
}
export async function verifyDesktopUpdateSnapshot(
  profile: DesktopProfile,
  options: { operationId: string; manifestSha256: string; signal: AbortSignal },
): Promise<void> {
  await verifiedEntries(
    profile,
    desktopUpdateSnapshotPath(profile, options.operationId),
    options.operationId,
    options.manifestSha256,
    options.signal,
  );
}
function excluded(path: string): boolean {
  const parts = path.split("/");
  return (
    excludedRoots.has(parts[0]!) ||
    parts.some((part) => part.endsWith(".pairing-lock")) ||
    (parts.length === 1 && parts[0]!.startsWith("gateway.lock"))
  );
}
export function desktopUpdateSnapshotPath(profile: DesktopProfile, operationId: string): string {
  return join(
    profile.configDir,
    "backups",
    `desktop-update-${z.string().uuid().parse(operationId)}`,
  );
}

/** Caller holds the external installation lease; opaque runtime leases prove every store remains stopped. */
export async function createDesktopUpdateSnapshot(
  profile: DesktopProfile,
  options: { operationId: string; leases: DesktopRuntimeLeases; signal: AbortSignal },
): Promise<DesktopUpdateSnapshot> {
  await assertDesktopRuntimeLeases(profile, options.leases);
  const target = desktopUpdateSnapshotPath(profile, options.operationId);
  const parent = dirname(target);
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await privateDirectory(parent);
  const pending = join(parent, `.pending-${options.operationId}`);
  await mkdir(pending, { mode: 0o700 });
  const entries: Entry[] = [];
  let bytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      options.signal.throwIfAborted();
      const path = prefix ? `${prefix}/${name}` : name;
      if (excluded(path)) continue;
      pathSchema.parse(path);
      if (entries.length >= MAX_ENTRIES)
        throw new Error("The desktop recovery snapshot contains too many files");
      const source = join(directory, name),
        destination = join(pending, "files", path);
      const metadata = await lstat(source);
      if (process.getuid && metadata.uid !== process.getuid())
        throw new Error("The managed library contains files owned by another account");
      if (metadata.isSymbolicLink()) {
        const target = await readlink(source);
        const entry = entrySchema.parse({ kind: "symlink", path, target });
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await symlink(target, destination);
        entries.push(entry);
      } else if (metadata.isDirectory()) {
        entries.push({ kind: "directory", path });
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await visit(source, path);
      } else if (metadata.isFile()) {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const result = await copyFileChecked(source, destination, options.signal);
        bytes += result.bytes;
        if (!Number.isSafeInteger(bytes))
          throw new Error("The desktop recovery snapshot is too large");
        const executable = Boolean(metadata.mode & 0o100);
        await chmod(destination, executable ? 0o700 : 0o600);
        entries.push({ kind: "file", path, ...result, executable });
      } else throw new Error("The managed library contains an unsupported special file");
    }
  };
  try {
    await mkdir(join(pending, "files"), { mode: 0o700 });
    await visit(profile.configDir, "");
    await assertDesktopRuntimeLeases(profile, options.leases);
    options.signal.throwIfAborted();
    const manifest = JSON.stringify(
      manifestSchema.parse({
        format: 1,
        owner: "omnesis-desktop",
        instance: profile.instance,
        secretService: profile.secretService,
        operationId: options.operationId,
        entries,
      }),
    );
    if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES)
      throw new Error("The desktop recovery inventory is too large");
    await atomicWriteFile(join(pending, "snapshot.json"), manifest, { mode: 0o600 });
    await rename(pending, target);
    return { manifestSha256: hash(Buffer.from(manifest)), bytes };
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

/** All snapshot bytes are checked before current state is touched; a failed restore stays fenced and is retryable. */
export async function restoreDesktopUpdateSnapshot(
  profile: DesktopProfile,
  options: {
    operationId: string;
    snapshot: DesktopUpdateSnapshot;
    leases: DesktopRuntimeLeases;
    signal: AbortSignal;
  },
): Promise<void> {
  await assertDesktopRuntimeLeases(profile, options.leases);
  const root = desktopUpdateSnapshotPath(profile, options.operationId);
  const entries = await verifiedEntries(
    profile,
    root,
    options.operationId,
    options.snapshot.manifestSha256,
    options.signal,
  );
  await assertDesktopRuntimeLeases(profile, options.leases);
  options.signal.throwIfAborted();
  for (const name of await readdir(profile.configDir)) {
    options.signal.throwIfAborted();
    if (!excluded(name)) await rm(join(profile.configDir, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    options.signal.throwIfAborted();
    const destination = join(profile.configDir, entry.path);
    switch (entry.kind) {
      case "directory":
        await mkdir(destination, { recursive: true, mode: 0o700 });
        break;
      case "symlink":
        await symlink(entry.target, destination);
        break;
      case "file": {
        const copy = await copyFileChecked(
          join(root, "files", entry.path),
          destination,
          options.signal,
        );
        if (copy.bytes !== entry.bytes || copy.sha256 !== entry.sha256)
          throw new Error("The recovery snapshot changed during restoration; retry recovery");
        await chmod(destination, entry.executable ? 0o700 : 0o600);
        break;
      }
      default:
        assertNever(entry);
    }
  }
  await assertDesktopRuntimeLeases(profile, options.leases);
}

async function verifiedEntries(
  profile: DesktopProfile,
  root: string,
  operationId: string,
  expectedHash: string,
  signal: AbortSignal,
): Promise<Entry[]> {
  await privateDirectory(dirname(root));
  await privateDirectory(root);
  await privateDirectory(join(root, "files"));
  const file = await open(join(root, "snapshot.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let body: Buffer;
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_MANIFEST_BYTES ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())
    )
      throw new Error("The desktop recovery inventory is unsafe");
    body = Buffer.alloc(metadata.size + 1);
    const read = await file.read(body, 0, body.length, 0);
    body = body.subarray(0, read.bytesRead);
  } finally {
    await file.close();
  }
  if (hash(body) !== expectedHash)
    throw new Error("The desktop recovery inventory failed its integrity check");
  const manifest = manifestSchema.parse(JSON.parse(body.toString("utf8")));
  if (
    manifest.instance !== profile.instance ||
    manifest.secretService !== profile.secretService ||
    manifest.operationId !== operationId
  )
    throw new Error("The desktop recovery snapshot belongs to another installation");
  const seen = new Map<string, Entry>();
  for (const entry of manifest.entries) {
    signal.throwIfAborted();
    if (seen.has(entry.path)) throw new Error("Duplicate recovery inventory path");
    const parent = dirname(entry.path);
    if (parent !== "." && seen.get(parent)?.kind !== "directory")
      throw new Error("The recovery inventory has an unsafe parent path");
    seen.set(entry.path, entry);
    const path = join(root, "files", entry.path),
      metadata = await lstat(path);
    if (entry.kind === "directory") {
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Invalid recovery directory");
    } else if (entry.kind === "symlink") {
      if (!metadata.isSymbolicLink() || (await readlink(path)) !== entry.target)
        throw new Error("Invalid recovery symlink");
    } else {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.bytes)
        throw new Error("Invalid recovery file");
      const checked = await digestFile(path, signal);
      if (checked.sha256 !== entry.sha256 || checked.bytes !== entry.bytes)
        throw new Error("The desktop recovery file failed its integrity check");
    }
  }
  return manifest.entries;
}
async function privateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The desktop recovery snapshot folder must be private and owned by you");
}
async function copyFileChecked(source: string, destination: string, signal: AbortSignal) {
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const result = await digestFile(source, signal, (bytes) => output.writeFile(bytes));
    await output.sync();
    return result;
  } finally {
    await output.close();
  }
}
async function digestFile(
  path: string,
  signal: AbortSignal,
  write?: (bytes: Buffer) => Promise<void>,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("A recovery file changed type");
    const digest = createHash("sha256");
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(1024 * 1024);
      const read = await file.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const part = buffer.subarray(0, read.bytesRead);
      bytes += read.bytesRead;
      digest.update(part);
      await write?.(part);
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size)
      throw new Error("A managed file changed while making its recovery snapshot");
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await file.close();
  }
}
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
