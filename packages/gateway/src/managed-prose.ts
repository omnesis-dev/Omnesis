// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  migrateSecretTextFile,
  OPERATOR_INSTRUCTIONS_FILENAME,
  secretFileEncryptionRequired,
  type SecretFileOptions,
} from "@omnesis/core";

/** Encrypt existing operator prose before an encrypted installation opens its library. */
export async function protectManagedProse(
  configDir: string,
  options: SecretFileOptions = {},
): Promise<void> {
  if (!secretFileEncryptionRequired(configDir)) return;
  const candidates = [join(configDir, OPERATOR_INSTRUCTIONS_FILENAME)];
  const directory = join(configDir, "sweeps");
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "The sweep directory must be a regular directory before opening the encrypted library.",
      );
    const entries = (await readdir(directory)).filter((name) => name.endsWith(".md"));
    if (entries.length > 64)
      throw new Error(
        "Review the sweep directory before opening the encrypted library: it contains more than 64 sweep files.",
      );
    for (const name of entries) candidates.push(join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Validate the complete set first; never follow an operator-authored link.
  const present: string[] = [];
  for (const file of candidates) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) {
        throw new Error(
          "An operator instructions or sweep file must be a regular file below 256 KiB before opening the encrypted library.",
        );
      }
      present.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const file of present) {
    const result = await migrateSecretTextFile(file, { ...options, configDir });
    if (result.present && !result.encrypted)
      throw new Error(
        "Unlock the library's encryption key before opening its instructions and sweeps.",
      );
  }
}
