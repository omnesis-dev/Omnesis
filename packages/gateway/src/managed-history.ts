// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  migrateSecretTextFile,
  secretFileEncryptionRequired,
  type SecretFileOptions,
} from "@omnesis/core";

/** Run before publishing the HTTP listener; legacy personal content must not remain plaintext. */
export async function protectManagedHistory(
  configDir: string,
  options: SecretFileOptions = {},
): Promise<void> {
  if (!secretFileEncryptionRequired(configDir)) return;
  const root = await realpath(configDir);
  for (const relative of ["conversations", "briefs/transcripts"]) {
    const directory = join(configDir, relative);
    let inspected = false;
    try {
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(directory)) !== join(root, relative)
      )
        throw new Error(
          "A managed history directory must be a regular directory before opening the encrypted library.",
        );
      inspected = true;
      for await (const entry of await opendir(directory)) {
        if (!entry.name.endsWith(".json") && !/^\.summary-index\.v\d+$/u.test(entry.name)) continue;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error(
            "Managed history must contain regular files before opening the encrypted library.",
          );
        const result = await migrateSecretTextFile(path, { ...options, configDir });
        if (result.present && !result.encrypted)
          throw new Error("Unlock the library's encryption key before opening its history.");
      }
    } catch (error) {
      if (inspected || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
