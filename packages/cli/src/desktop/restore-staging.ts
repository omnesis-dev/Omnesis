// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DesktopRestoreFailure } from "./restore-errors.js";
import { readDesktopRestoreFile } from "./restore-files.js";
import { sameDesktopRoot, type DesktopRootIdentity } from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

const identity = z
  .object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) })
  .strict();
const ownerSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop-restore"),
    instance: z.string(),
    secretService: z.string(),
    importId: z.string().uuid(),
    root: identity,
    directory: identity,
  })
  .strict();
interface Entry {
  path: string;
  device: bigint;
  inode: bigint;
  directory: boolean;
  size: bigint;
  mtime: bigint;
  ctime: bigint;
}
/** Caller owns restore-session, install and all runtime/store leases before erasure. */
export async function removeDesktopRestoreStaging(
  profile: DesktopProfile,
  root: DesktopRootIdentity,
  signal: AbortSignal,
): Promise<void> {
  const parent = join(`${profile.configDir}.bootstrap`, "restore-imports");
  let parentEntry: Entry;
  try {
    parentEntry = await privateEntry(parent);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!parentEntry.directory)
    throw new Error("The restore staging parent is not an owned directory");
  const slots: Entry[] = [];
  let more = false;
  const children = await opendir(parent);
  for await (const child of children) {
    signal.throwIfAborted();
    if (slots.length >= 32) {
      more = true;
      break;
    }
    const path = join(parent, child.name),
      entry = await privateEntry(path);
    if (
      !child.isDirectory() ||
      !z.string().uuid().safeParse(child.name).success ||
      !entry.directory
    )
      throw new Error("Unrecognized restore staging was retained");
    const names = [];
    for await (const inner of await opendir(path)) {
      names.push(inner.name);
      if (names.length > 65536) throw new Error("The restore staging slot is too large");
    }
    if (names.length) {
      const raw = await readDesktopRestoreFile(join(path, "owner.json"), 16384);
      let owner: z.infer<typeof ownerSchema>;
      try {
        owner = ownerSchema.parse(JSON.parse(raw.toString("utf8")));
      } finally {
        raw.fill(0);
      }
      if (
        owner.importId !== child.name ||
        owner.instance !== profile.instance ||
        owner.secretService !== profile.secretService ||
        !sameDesktopRoot(owner.root, root) ||
        owner.directory.device !== String(entry.device) ||
        owner.directory.inode !== String(entry.inode)
      )
        throw new Error("The restore staging slot belongs to another installation or was replaced");
    }
    slots.push(entry);
  }
  for (const slot of slots) {
    const entries: Entry[] = [];
    const visit = async (entry: Entry, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 24 || entries.length >= 65536)
        throw new Error("The restore staging exceeds safe cleanup bounds");
      entries.push(entry);
      if (entry.directory)
        for await (const child of await opendir(entry.path))
          await visit(await privateEntry(join(entry.path, child.name)), depth + 1);
    };
    await visit(slot, 0);
    // Validate the complete set before deleting any file; unexpected links or replacements keep the key.
    for (const entry of entries) await unchanged(entry);
    for (const entry of entries.reverse()) {
      signal.throwIfAborted();
      // Directory timestamps legitimately change as their validated children are removed.
      const current = await privateEntry(entry.path);
      if (
        current.device !== entry.device ||
        current.inode !== entry.inode ||
        current.directory !== entry.directory
      )
        throw new Error("The restore staging changed during removal");
      if (entry.directory) await rmdir(entry.path);
      else {
        await unchanged(entry);
        await unlink(entry.path);
      }
    }
  }
  if (more) throw new DesktopRestoreFailure("RESTORE_CLEANUP_PENDING");
  const current = await privateEntry(parent);
  if (current.device !== parentEntry.device || current.inode !== parentEntry.inode)
    throw new Error("The restore staging parent changed during removal");
  await rmdir(parent);
}
async function privateEntry(path: string): Promise<Entry> {
  const item = await lstat(path, { bigint: true }),
    directory = item.isDirectory();
  if (
    item.isSymbolicLink() ||
    (!directory && !item.isFile()) ||
    (item.mode & 0o077n) !== 0n ||
    (!directory && item.nlink !== 1n) ||
    (process.getuid && item.uid !== BigInt(process.getuid())) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("Unowned or linked restore staging was retained; its key was kept");
  return {
    path,
    device: item.dev,
    inode: item.ino,
    directory,
    size: item.size,
    mtime: item.mtimeNs,
    ctime: item.ctimeNs,
  };
}
async function unchanged(entry: Entry): Promise<void> {
  const current = await privateEntry(entry.path);
  if (
    current.device !== entry.device ||
    current.inode !== entry.inode ||
    current.directory !== entry.directory ||
    current.size !== entry.size ||
    current.mtime !== entry.mtime ||
    current.ctime !== entry.ctime
  )
    throw new Error("The restore staging changed; its key was kept");
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
