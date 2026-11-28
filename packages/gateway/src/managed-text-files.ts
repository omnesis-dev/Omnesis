// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  decodeSecretTextFileValue,
  decodeSecretTextFileValueSync,
  isEncryptedSecretFile,
  secretFileEncryptionRequired,
  secretFileScope,
  writeSecretTextFile,
  writeSecretTextFileSync,
  type SecretFileOptions,
} from "@omnesis/core";

/** File-backed personal content shares the installation's fail-closed encryption policy. */
export class ManagedTextFiles {
  private readonly options: SecretFileOptions;
  constructor(
    readonly configDir: string,
    options: SecretFileOptions = {},
  ) {
    this.options = { ...options, configDir };
  }
  decode(path: string, serialized: string): Promise<string> {
    return decodeSecretTextFileValue(path, serialized, this.options);
  }
  decodeSync(path: string, serialized: string): string {
    return decodeSecretTextFileValueSync(path, serialized, this.options);
  }
  /** False means the caller should use its existing plaintext publication path. */
  async publishProtected(path: string, value: string): Promise<boolean> {
    let required = secretFileEncryptionRequired(this.configDir);
    if (!required) {
      try {
        required = isEncryptedSecretFile(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!required) return false;
    const result = await writeSecretTextFile(path, value, this.options);
    if (!result.encrypted) throw new Error("The library's encryption key is unavailable.");
    return true;
  }
  /** A staged filename never changes the authenticated logical destination. */
  publishProtectedSync(path: string, value: string, logicalPath = path): boolean {
    let required = secretFileEncryptionRequired(this.configDir);
    if (!required) {
      try {
        required = isEncryptedSecretFile(readFileSync(logicalPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!required) return false;
    const result = writeSecretTextFileSync(path, value, {
      ...this.options,
      scope: secretFileScope(logicalPath, this.configDir),
    });
    if (!result.encrypted) throw new Error("The library's encryption key is unavailable.");
    return true;
  }
}
