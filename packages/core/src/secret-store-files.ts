// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileSecretDirectory, fileSecretEntryPaths } from "./secret-store-paths.js";
import { SecretPathUnreadableError, secretPathExists } from "./security-files.js";
import {
  inspectWindowsPrivatePaths,
  readWindowsPrivateFileContents,
  readWindowsPrivateFileContentsSync,
  type WindowsPrivatePath,
} from "./windows-private-file.js";

/** Missing and unsafe existing key material remain distinct on every entry point. */
export async function readPrivateSecretText(
  path: string,
  opts?: { exactBasename?: string; exactParentBasename?: string },
): Promise<string | null> {
  if (process.platform !== "win32") {
    if (!secretPathExists(path)) return null;
    return readFile(path, "utf8");
  }
  try {
    return (await readWindowsPrivateFileContents(path, opts)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SecretPathUnreadableError(path, error);
  }
}

export function readPrivateSecretTextSync(
  path: string,
  opts?: { exactBasename?: string; exactParentBasename?: string },
): string | null {
  if (process.platform !== "win32") {
    if (!secretPathExists(path)) return null;
    return readFileSync(path, "utf8");
  }
  try {
    return readWindowsPrivateFileContentsSync(path, opts).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SecretPathUnreadableError(path, error);
  }
}

/** Status cannot advertise a usable private fallback while existing entries are unsafe. */
export async function verifyWindowsSecretFiles(configDir: string, service: string): Promise<void> {
  if (process.platform !== "win32") return;
  const directory = fileSecretDirectory(configDir, service);
  const keyring = join(configDir, "keyring");
  const candidates = new Set([keyring, directory]);
  const legacy = fileSecretEntryPaths(configDir, service, "").legacy;
  if (legacy) {
    try {
      if ((await readdir(keyring)).includes(service)) candidates.add(dirname(legacy.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SecretPathUnreadableError(keyring, error);
    }
  }
  const directories: WindowsPrivatePath[] = [];
  for (const path of candidates) {
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Secret-store directory must be a regular private directory");
      directories.push({ path, kind: "directory" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new SecretPathUnreadableError(path, error);
    }
  }
  const verify = async (paths: readonly WindowsPrivatePath[]): Promise<void> => {
    try {
      const statuses = await inspectWindowsPrivatePaths(paths);
      const unsafe = statuses.findIndex((entry) => !entry.private);
      if (unsafe >= 0)
        throw new SecretPathUnreadableError(
          paths[unsafe]!.path,
          new Error("Windows access controls are not private"),
        );
    } catch (error) {
      if (error instanceof SecretPathUnreadableError) throw error;
      throw new SecretPathUnreadableError(directory, error);
    }
  };
  await verify(directories);
  for (const entry of directories) {
    if (entry.path === keyring) continue;
    let names: string[];
    try {
      names = await readdir(entry.path);
    } catch (error) {
      throw new SecretPathUnreadableError(entry.path, error);
    }
    const paths = names.map((name): WindowsPrivatePath => ({
      path: join(entry.path, name),
      kind: "file",
    }));
    for (let offset = 0; offset < paths.length; offset += 5000)
      await verify(paths.slice(offset, offset + 5000));
  }
}
