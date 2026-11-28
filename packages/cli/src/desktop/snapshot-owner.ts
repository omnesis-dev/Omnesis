// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Builtins only: reclamation checks must not launch a child under publication EX.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertDesktopProfileGeneration } from "./generation.js";
import type { DesktopProfile } from "./environment.js";
import type { RetentionFileIdentity } from "./snapshot-retention-record.js";

export interface DesktopSnapshotOwner {
  format: 1;
  owner: "omnesis-desktop-snapshot";
  instance: string;
  secretService: string;
  operationId: string;
  root: RetentionFileIdentity;
  directory: RetentionFileIdentity;
}
export function desktopSnapshotStagingPath(profile: DesktopProfile, id: string): string {
  operation(id);
  return join(profile.configDir, "backups", `.pending-${id}`);
}
function operation(id: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id))
    throw new Error("Invalid recovery snapshot operation");
}
export async function snapshotDirectoryIdentity(path: string): Promise<RetentionFileIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077n) !== 0n ||
    (process.getuid && metadata.uid !== BigInt(process.getuid())) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("A recovery snapshot folder must remain private, canonical and owned");
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}
function same(a: RetentionFileIdentity, b: RetentionFileIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): value is RetentionFileIdentity {
  return (
    record(value) &&
    Object.keys(value).sort().join() === "device,inode" &&
    typeof value.device === "string" &&
    /^\d{1,32}$/u.test(value.device) &&
    typeof value.inode === "string" &&
    /^\d{1,32}$/u.test(value.inode)
  );
}
function checkedPath(profile: DesktopProfile, id: string, path: string): void {
  operation(id);
  assertDesktopProfileGeneration(profile);
  if (
    path !== desktopSnapshotStagingPath(profile, id) &&
    path !== join(profile.configDir, "backups", `desktop-update-${id}`)
  )
    throw new Error("Only an operation's exact recovery snapshot can be selected");
}
/** Persist before any copied payload: interrupted output remains provably owned. */
export async function writeDesktopSnapshotOwner(
  profile: DesktopProfile,
  id: string,
  path: string,
): Promise<void> {
  checkedPath(profile, id, path);
  const root = await snapshotDirectoryIdentity(profile.configDir),
    directory = await snapshotDirectoryIdentity(path);
  const value: DesktopSnapshotOwner = {
    format: 1,
    owner: "omnesis-desktop-snapshot",
    instance: profile.instance,
    secretService: profile.secretService,
    operationId: id,
    root,
    directory,
  };
  const file = await open(
    join(path, "owner.json"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  const folder = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
export async function readDesktopSnapshotOwner(
  profile: DesktopProfile,
  id: string,
  path: string,
): Promise<DesktopSnapshotOwner> {
  checkedPath(profile, id, path);
  const root = await snapshotDirectoryIdentity(profile.configDir),
    directory = await snapshotDirectoryIdentity(path);
  const file = await open(
    join(path, "owner.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 4096n
    )
      throw new Error("The recovery snapshot ownership record is unsafe");
    const buffer = Buffer.alloc(4097),
      read = await file.read(buffer, 0, buffer.length, 0),
      after = await file.stat({ bigint: true });
    if (
      BigInt(read.bytesRead) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("The recovery snapshot ownership record changed");
    const value: unknown = JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8"));
    if (
      !record(value) ||
      Object.keys(value).sort().join() !==
        "directory,format,instance,operationId,owner,root,secretService" ||
      value.format !== 1 ||
      value.owner !== "omnesis-desktop-snapshot" ||
      value.instance !== profile.instance ||
      value.secretService !== profile.secretService ||
      value.operationId !== id ||
      !identity(value.root) ||
      !identity(value.directory) ||
      !same(value.root, root) ||
      !same(value.directory, directory)
    )
      throw new Error("The recovery snapshot belongs to another operation or library folder");
    return {
      format: 1,
      owner: "omnesis-desktop-snapshot",
      instance: profile.instance,
      secretService: profile.secretService,
      operationId: id,
      root,
      directory,
    };
  } finally {
    await file.close();
  }
}
