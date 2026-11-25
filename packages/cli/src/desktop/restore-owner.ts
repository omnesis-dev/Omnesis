// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireGatewayLock, GatewayLockHeldError } from "@omnesis/core";
import { DesktopRestoreFailure } from "./restore-errors.js";
import type { DesktopProfile } from "./environment.js";

/** Acquire before the install lease, retaining ownership through native-worker exit. */
export async function withDesktopRestoreOperationLease<T>(
  profile: DesktopProfile,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const lease = await acquireDesktopRestoreSessionLease(profile, signal);
  try {
    signal.throwIfAborted();
    return await work();
  } finally {
    lease.release();
  }
}
export async function acquireDesktopRestoreSessionLease(
  profile: DesktopProfile,
  signal: AbortSignal,
  options: { createParent?: boolean } = {},
): Promise<{ release(): void }> {
  const parent = `${profile.configDir}.bootstrap`;
  if (options.createParent)
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  await privateDirectory(parent);
  const directory = join(parent, "restore-owner");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await privateDirectory(directory);
  try {
    return await acquireGatewayLock(directory, { signal, waitMs: 0 });
  } catch (error) {
    if (error instanceof GatewayLockHeldError) throw new DesktopRestoreFailure("RESTORE_BUSY");
    throw error;
  }
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
    throw new Error("The restore owner folder must remain private and owned");
}
