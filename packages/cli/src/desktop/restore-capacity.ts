// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { omnesisConfigSchema } from "@omnesis/config";
import { readDesktopRestoreFile } from "./restore-files.js";
import { DesktopRestoreFailure } from "./restore-errors.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopBackupArchive } from "./restore-archive.js";

/** Shared conservative allocation/envelope allowance, independent of the configured write reserve. */
export const DESKTOP_RESTORE_ENTRY_HEADROOM_BYTES = 16_384;

/** Include a full bounded envelope per entry, including tiny files and manifests. */
export function desktopRestoreExpandedBytes(
  archive: Pick<DesktopBackupArchive, "files" | "bytes">,
): number {
  let bytes = 0;
  if (archive.files.size > 16384) throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
  for (const size of archive.files.values()) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
    bytes += size + DESKTOP_RESTORE_ENTRY_HEADROOM_BYTES;
    if (!Number.isSafeInteger(bytes)) throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
  }
  return Math.max(archive.bytes, bytes);
}

/** Reuses the configured gateway write reserve; never invent a lower restore-only threshold. */
export async function desktopRestoreReserveBytes(profile: DesktopProfile): Promise<bigint> {
  const raw = await readDesktopRestoreFile(join(profile.configDir, "omnesis.json"), 1024 * 1024);
  try {
    const config = omnesisConfigSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
    // Keep the existing storage-pressure default when the owner has not set it.
    return BigInt(config.gateway?.minFreeDiskMb ?? 500) * 1024n * 1024n;
  } finally {
    raw.fill(0);
  }
}
export async function assertDesktopRestoreCapacity(
  profile: DesktopProfile,
  options: { expandedBytes: number; snapshotBytes: number; signal: AbortSignal },
  dependencies: { capacity?: () => Promise<{ bavail: bigint; bsize: bigint }> } = {},
): Promise<void> {
  options.signal.throwIfAborted();
  if (
    ![options.expandedBytes, options.snapshotBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
  const reserve = await desktopRestoreReserveBytes(profile);
  const capacity = await (dependencies.capacity?.() ?? statfs(profile.configDir, { bigint: true }));
  const required = 3n * BigInt(options.expandedBytes) + BigInt(options.snapshotBytes) + reserve;
  if (capacity.bavail < 0n || capacity.bsize <= 0n || capacity.bavail * capacity.bsize < required)
    throw new DesktopRestoreFailure("RESTORE_CAPACITY_REQUIRED");
  options.signal.throwIfAborted();
}
