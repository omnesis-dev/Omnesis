// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { statfsSync } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { InsufficientStorageError } from "../http/errors.js";
import type { StoragePolicy, StorageVolume } from "./pressure.js";

/**
 * Resolve each configured store's existing ancestor and measure every volume.
 * Missing files on a fresh install inherit their parent's volume. Permission or
 * probe failures propagate so admission cannot mistake an unreadable disk for free space.
 */
export async function measureStorageVolumes(paths: readonly string[]): Promise<StorageVolume[]> {
  const volumes = new Map<string, StorageVolume>();
  for (const configuredPath of paths) {
    let path = resolve(configuredPath);
    let identity;
    while (true) {
      try {
        identity = await stat(path);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = dirname(path);
        if (parent === path) throw error;
        path = parent;
      }
    }
    // A store under a regular file can never be created. POSIX reports that as ENOTDIR;
    // Windows reports ENOENT, so the walk above reaches the file and is refused here.
    if (path !== resolve(configuredPath) && !identity.isDirectory())
      throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${configuredPath}'`), {
        code: "ENOTDIR",
        path: configuredPath,
      });
    const id = String(identity.dev);
    if (volumes.has(id)) continue;
    const fs = await statfs(path);
    volumes.set(id, {
      id,
      totalBytes: Number(fs.blocks) * Number(fs.bsize),
      availableBytes: Number(fs.bavail) * Number(fs.bsize),
    });
  }
  return [...volumes.values()];
}

/** Fresh per-chunk download preflight; a failed syscall never means infinite capacity. */
export function assertStorageVolumeGrowth(
  configuredPath: string,
  policy: Pick<StoragePolicy, "minFreeBytes" | "maxDiskUsedPercent">,
  additionalBytes = 0,
  probe: (path: string) => {
    blocks: number | bigint;
    bavail: number | bigint;
    bsize: number | bigint;
  } = statfsSync,
): void {
  if (!Number.isFinite(additionalBytes) || additionalBytes < 0)
    throw new RangeError("Invalid growth size");
  let path = resolve(configuredPath);
  let capacity;
  while (true) {
    try {
      capacity = probe(path);
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT" &&
        dirname(path) !== path
      ) {
        path = dirname(path);
        continue;
      }
      throw new InsufficientStorageError(
        "The model storage volume cannot be verified. Download paused. Open Settings → Storage.",
      );
    }
  }
  const totalBytes = Number(capacity.blocks) * Number(capacity.bsize);
  const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(availableBytes) ||
    availableBytes < 0 ||
    availableBytes > totalBytes
  ) {
    throw new InsufficientStorageError(
      "The model storage volume cannot be verified. Download paused. Open Settings → Storage.",
    );
  }
  const remaining = availableBytes - additionalBytes;
  if (
    remaining < policy.minFreeBytes ||
    (1 - remaining / totalBytes) * 100 >= policy.maxDiskUsedPercent
  ) {
    throw new InsufficientStorageError(
      "Not enough disk space to download this model safely. Open Settings → Storage to reclaim space.",
    );
  }
}
