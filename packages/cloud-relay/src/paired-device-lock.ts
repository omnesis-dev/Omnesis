// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireGatewayLock, ensurePrivateDirs } from "@omnesis/core";

/** Pairing replacement and hint refresh share one process-identity lease across processes. */
export async function withPairedDeviceFileLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const directory = `${resolve(path)}.pairing-lock`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())))
  )
    throw new Error("The paired-device lock folder must be private and owned by this user");
  if (process.platform === "win32") await ensurePrivateDirs([directory]);
  const lock = await acquireGatewayLock(directory);
  try {
    return await work();
  } finally {
    lock.release();
  }
}
