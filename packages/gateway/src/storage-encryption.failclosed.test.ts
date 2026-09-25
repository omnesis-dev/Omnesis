// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An armed install must never open plaintext because it could not see its keys.
 *
 * The boot path decides whether encryption is on by asking whether pieces of
 * key material exist, and a keyring directory the daemon cannot read answers
 * every one of those questions the same way an empty one does. Reading that as
 * "never armed" is what would put an unencrypted corpus beside sealed keys.
 *
 * These drive the real boot resolver against a real armed config dir and change
 * nothing but the directory's mode.
 */

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  STORAGE_KEY_NAMES,
  ensureInstallRootKey,
  ensureStorageKey,
  markSecretFileEncryptionRequired,
  markStorageEncryptionRequired,
} from "@omnesis/core";
import { WATCH_JOURNAL_FILENAME } from "./watch/journal-path.js";
import { resolveGatewayStorageEncryptionKeys } from "./storage-encryption.js";

const dirs: string[] = [];
let savedBackend: string | undefined;

beforeEach(() => {
  savedBackend = process.env.OMNESIS_SECRET_STORE;
  // What the generated unit bakes in. Without it the resolver would ask the
  // OS keyring instead of the config dir, and never reach the paths under test.
  process.env.OMNESIS_SECRET_STORE = "file";
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Restore traversal before removal; an unarmed fixture has no keyring dir.
    try {
      chmodSync(join(dir, "keyring"), 0o700);
    } catch {
      /* nothing to restore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedBackend === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = savedBackend;
});

/** A config dir armed exactly as `omnesis keyring init` leaves one. */
async function armedConfigDir(): Promise<string> {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-failclosed-"));
  dirs.push(configDir);
  await ensureInstallRootKey({ backend: "file", configDir });
  await markSecretFileEncryptionRequired(configDir, { backend: "file" });
  await markStorageEncryptionRequired(configDir, { backend: "file" });
  for (const keyName of ["main-db", "index-db", "analytics-db", "watch2-db"] as const) {
    await ensureStorageKey(keyName, { configDir, backend: "file" });
  }
  return configDir;
}

// Root ignores the mode bits that make the fixture unreadable.
const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;

describe("resolveGatewayStorageEncryptionKeys — unreadable key material", () => {
  test("an armed, readable install enables encryption", async () => {
    const configDir = await armedConfigDir();
    const resolved = await resolveGatewayStorageEncryptionKeys(configDir);
    expect(resolved.enabled).toBe(true);
    expect(resolved.mainDbKey).not.toBeNull();
  });

  test.skipIf(!asUnprivilegedUser)(
    "the same install refuses to boot once its keyring is unreadable",
    async () => {
      const configDir = await armedConfigDir();
      expect((await resolveGatewayStorageEncryptionKeys(configDir)).enabled).toBe(true);

      chmodSync(join(configDir, "keyring"), 0o000);
      await expect(resolveGatewayStorageEncryptionKeys(configDir)).rejects.toThrow(
        /Cannot determine whether .* exists/,
      );
    },
  );

  test.skipIf(!asUnprivilegedUser)(
    "the refusal names the unreadable path, so the fix is obvious from the error",
    async () => {
      const configDir = await armedConfigDir();
      chmodSync(join(configDir, "keyring"), 0o000);
      await expect(resolveGatewayStorageEncryptionKeys(configDir)).rejects.toThrow(
        new RegExp(join(configDir, "keyring").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    },
  );

  test("a genuinely unarmed install still opens plaintext", async () => {
    // The whole point of distinguishing the two: absence is a legitimate state
    // and must stay cheap. A first run has no keyring directory at all.
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-unarmed-"));
    dirs.push(configDir);
    const resolved = await resolveGatewayStorageEncryptionKeys(configDir);
    expect(resolved.enabled).toBe(false);
    expect(resolved.mainDbKey).toBeNull();
  });
});

describe("the watch journal's key name is frozen", () => {
  test("is still `watch2-db`, whatever the file is called", () => {
    // Deliberately not renamed alongside the file, and this test exists so
    // that finishing the rename reddens something that says why.
    //
    // A key name is sealed into its envelope four ways — the filename, the
    // HKDF info, the AES-GCM additional data, and an equality check on
    // decrypt. Changing it needs a re-wrap ordered before anything calls
    // `ensureStorageKey`, and that ordering is not enforceable: `omnesis
    // keyring storage-init` and `omnesis secure` both loop STORAGE_KEY_NAMES
    // calling it from outside the gateway, and `ensureStorageKey` mints fresh
    // random bytes for a name with no envelope. The result is a read that
    // succeeds and a journal that will not decrypt.
    expect(STORAGE_KEY_NAMES).toContain("watch2-db");
    expect(STORAGE_KEY_NAMES, "a second name for the same store").not.toContain("watch-db");
    // The file, by contrast, is on its current name.
    expect(WATCH_JOURNAL_FILENAME).toBe("watch.db");
  });
});
