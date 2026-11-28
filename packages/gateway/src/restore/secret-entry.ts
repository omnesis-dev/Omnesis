// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat } from "node:fs/promises";
import {
  atomicWriteFile,
  backupScopeEntryFor,
  isEncryptedSecretFile,
  openSecretFileValueAsync,
  sealSecretFileValueAsync,
  secretFileScope,
} from "@omnesis/core";
import { streamRestoredEntry, type SealedRestoreEntry } from "./entry-stream.js";

/** Only provider credentials and user-authored prose; machine/account authority is excluded. */
export async function restoreSecretEntry(
  options: { entry: SealedRestoreEntry; targetPath: string },
  signal: AbortSignal,
): Promise<{ protected: true }> {
  const logical = options.entry.logicalName.replace(/\.enc$/, "");
  const scope = backupScopeEntryFor(logical);
  const reserved = new Set([
    "keyring",
    "tls",
    "cloud-relay",
    "config-secrets",
    "models",
    "logs",
    "backups",
    "exports",
    "conversations",
  ]);
  if (
    logical !== "OMNESIS.md" &&
    !/^sweeps\/[^/:\\]+\.md$/u.test(logical) &&
    !(
      scope?.kind === "config" &&
      scope.name === logical &&
      !reserved.has(logical.split("/")[0]!) &&
      /^(?:[^/:\\]+-credentials\.json|[^/:\\]+\/[^/:\\]+\/credentials\.json)$/u.test(logical)
    )
  )
    throw new Error("This backup entry is not restorable prose or provider credentials");
  const blocks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const block of streamRestoredEntry(options.entry, signal)) {
      bytes += block.length;
      if (bytes > 16 * 1024 * 1024)
        throw new Error("The restored prose or credential file exceeds its safe bound");
      blocks.push(block);
    }
    const raw = Buffer.concat(blocks);
    try {
      const serialized = new TextDecoder("utf-8", { fatal: true }).decode(raw),
        secretScope = secretFileScope(logical, ".");
      const text = isEncryptedSecretFile(serialized)
        ? await openSecretFileValueAsync(serialized, {
            rootKey: options.entry.sourceRootKey,
            scope: secretScope,
          })
        : serialized;
      signal.throwIfAborted();
      const sealed = await sealSecretFileValueAsync(text, {
        rootKey: options.entry.targetRootKey,
        scope: secretScope,
      });
      try {
        await lstat(options.targetPath);
        throw new Error("The restore destination already exists");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      signal.throwIfAborted();
      await atomicWriteFile(options.targetPath, sealed, { mode: 0o600, ensureDir: true });
      return { protected: true };
    } finally {
      raw.fill(0);
    }
  } finally {
    for (const block of blocks) block.fill(0);
  }
}
