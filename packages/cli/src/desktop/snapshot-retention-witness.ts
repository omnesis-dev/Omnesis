// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Builtins only. Phase two checks bounded inventories; payload verification runs before publication EX.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { desktopSnapshotStagingPath, snapshotDirectoryIdentity } from "./snapshot-owner.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopSnapshotWitness } from "./snapshot-retention-record.js";

export function snapshotWitnessPath(
  profile: DesktopProfile,
  witness: Pick<DesktopSnapshotWitness, "operationId" | "staging">,
): string {
  const pending = desktopSnapshotStagingPath(profile, witness.operationId);
  return witness.staging
    ? pending
    : join(profile.configDir, "backups", `desktop-update-${witness.operationId}`);
}
export async function captureDesktopSnapshotWitness(
  profile: DesktopProfile,
  operationId: string,
  staging: boolean,
  kind: "owner" | "manifest",
  signal: AbortSignal,
): Promise<DesktopSnapshotWitness> {
  const path = snapshotWitnessPath(profile, { operationId, staging });
  const directory = await snapshotDirectoryIdentity(path);
  const inventoryPath = join(path, kind === "owner" ? "owner.json" : "snapshot.json");
  const file = await open(
    inventoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true }),
      limit = kind === "owner" ? 4096 : 32 * 1024 ** 2;
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error("The recovery snapshot inventory is unsafe");
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      signal.throwIfAborted();
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > limit) throw new Error("The recovery snapshot inventory grew");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await file.stat({ bigint: true }),
      published = await lstat(inventoryPath, { bigint: true }),
      final = await snapshotDirectoryIdentity(path);
    if (
      before.size !== BigInt(bytes) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== published.dev ||
      before.ino !== published.ino ||
      directory.device !== final.device ||
      directory.inode !== final.inode
    )
      throw new Error("The recovery snapshot inventory changed");
    return {
      operationId,
      staging,
      directory,
      inventory: {
        kind,
        identity: { device: String(before.dev), inode: String(before.ino) },
        bytes,
        mtimeNs: String(before.mtimeNs),
        ctimeNs: String(before.ctimeNs),
        sha256: hash.digest("hex"),
      },
    };
  } finally {
    await file.close();
  }
}
export async function assertDesktopSnapshotWitness(
  profile: DesktopProfile,
  expected: DesktopSnapshotWitness,
  signal: AbortSignal,
): Promise<void> {
  const observed = await captureDesktopSnapshotWitness(
    profile,
    expected.operationId,
    expected.staging,
    expected.inventory.kind,
    signal,
  );
  const a = observed.inventory,
    b = expected.inventory;
  if (
    observed.operationId !== expected.operationId ||
    observed.staging !== expected.staging ||
    observed.directory.device !== expected.directory.device ||
    observed.directory.inode !== expected.directory.inode ||
    a.kind !== b.kind ||
    a.identity.device !== b.identity.device ||
    a.identity.inode !== b.identity.inode ||
    a.bytes !== b.bytes ||
    a.mtimeNs !== b.mtimeNs ||
    a.ctimeNs !== b.ctimeNs ||
    a.sha256 !== b.sha256
  )
    throw new Error("The reviewed recovery snapshot changed before cleanup");
}
