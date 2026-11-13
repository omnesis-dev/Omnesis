// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import { readPrivateSecretText, readPrivateSecretTextSync } from "./secret-store-files.js";
import { SecretPathUnreadableError } from "./security-files.js";
import {
  deleteWindowsPrivateFileExact,
  deleteWindowsPrivateFileExactSync,
} from "./windows-private-file.js";
import type { SecretEntryPaths } from "./secret-store-paths.js";

export async function readSecretEntryText(paths: SecretEntryPaths): Promise<string | null> {
  const current = await readPrivateSecretText(paths.path);
  if (current !== null || !paths.legacy) return current;
  const { path, exactBasename, exactParentBasename } = paths.legacy;
  return readPrivateSecretText(path, { exactBasename, exactParentBasename });
}
export function readSecretEntryTextSync(paths: SecretEntryPaths): string | null {
  const current = readPrivateSecretTextSync(paths.path);
  if (current !== null || !paths.legacy) return current;
  const { path, exactBasename, exactParentBasename } = paths.legacy;
  return readPrivateSecretTextSync(path, { exactBasename, exactParentBasename });
}
async function removeExact(
  path: string,
  exactBasename: string,
  exactParentBasename?: string,
): Promise<void> {
  try {
    await deleteWindowsPrivateFileExact(path, { exactBasename, exactParentBasename });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new SecretPathUnreadableError(path, error);
  }
}
/** Retire old spelling only after a new private entry is committed; reads never resurrect keys. */
export async function retireLegacySecretEntry(paths: SecretEntryPaths): Promise<void> {
  if (paths.legacy)
    await removeExact(
      paths.legacy.path,
      paths.legacy.exactBasename,
      paths.legacy.exactParentBasename,
    );
}
export async function deleteSecretEntry(paths: SecretEntryPaths): Promise<void> {
  if (process.platform !== "win32") {
    if (existsSync(paths.path)) await unlink(paths.path);
    return;
  }
  await removeExact(paths.path, basename(paths.path));
  await retireLegacySecretEntry(paths);
}

export function retireLegacySecretEntrySync(paths: SecretEntryPaths): void {
  if (!paths.legacy) return;
  const { path, exactBasename, exactParentBasename } = paths.legacy;
  try {
    deleteWindowsPrivateFileExactSync(path, { exactBasename, exactParentBasename });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new SecretPathUnreadableError(path, error);
  }
}
export function deleteSecretEntrySync(paths: SecretEntryPaths): void {
  if (process.platform !== "win32") {
    rmSync(paths.path, { force: true });
    return;
  }
  try {
    deleteWindowsPrivateFileExactSync(paths.path, { exactBasename: basename(paths.path) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new SecretPathUnreadableError(paths.path, error);
  }
  retireLegacySecretEntrySync(paths);
}
