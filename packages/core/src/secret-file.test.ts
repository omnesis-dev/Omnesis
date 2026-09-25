// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import {
  clearSecretFileKeyCacheForTests,
  isEncryptedSecretFile,
  markSecretFileEncryptionRequired,
  migrateSecretTextFile,
  primeSecretFileKeyCache,
  readSecretJsonFile,
  readSecretTextFile,
  readSecretTextFileSync,
  secretFileEncryptionRequired,
  writeSecretJsonFile,
  writeSecretTextFile,
  writeSecretTextFileSync,
} from "./secret-file.js";

describe("secret-file encryption", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "omnesis-secret-file-test-"));
    path = join(dir, "provider", "acct", "tokens.json");
  });

  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes plaintext when no install root key exists", async () => {
    const result = await writeSecretTextFile(path, "plain-token", {
      backend: "file",
      configDir: dir,
    });

    expect(result.encrypted).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("plain-token");
    expect(await readSecretTextFile(path, { backend: "file", configDir: dir })).toBe("plain-token");
  });

  test("writes and reads an encrypted envelope once a root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const result = await writeSecretJsonFile(
      path,
      { access_token: "access-1", refresh_token: "refresh-1" },
      { backend: "file", configDir: dir },
    );

    const raw = readFileSync(path, "utf8");
    expect(result.encrypted).toBe(true);
    expect(secretFileEncryptionRequired(dir)).toBe(true);
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain("access-1");
    await expect(readSecretJsonFile(path, { backend: "file", configDir: dir })).resolves.toEqual({
      access_token: "access-1",
      refresh_token: "refresh-1",
    });
  });

  test("sync read/write uses the same envelope format", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const result = writeSecretTextFileSync(path, "collector-token", {
      backend: "file",
      configDir: dir,
    });

    expect(result.encrypted).toBe(true);
    expect(readSecretTextFileSync(path, { backend: "file", configDir: dir })).toBe(
      "collector-token",
    );
  });

  test("does not rewrite an encrypted file as plaintext when the root key is unavailable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await writeSecretTextFile(path, "encrypted-token", { backend: "file", configDir: dir });
    const encryptedRaw = readFileSync(path, "utf8");
    rmSync(join(dir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    await expect(
      writeSecretTextFile(path, "plaintext-regression", { backend: "file", configDir: dir }),
    ).rejects.toThrow(/Refusing to write Omnesis secret file/);
    expect(readFileSync(path, "utf8")).toBe(encryptedRaw);
  });

  test("encrypted reads fail closed when the root key is unavailable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await writeSecretTextFile(path, "encrypted-token", { backend: "file", configDir: dir });
    rmSync(join(dir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    await expect(readSecretTextFile(path, { backend: "file", configDir: dir })).rejects.toThrow(
      /install root key/,
    );
    expect(() => readSecretTextFileSync(path, { backend: "file", configDir: dir })).toThrow(
      /install root key/,
    );
  });

  test("sync writes also refuse to downgrade encrypted files to plaintext", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    writeSecretTextFileSync(path, "encrypted-token", { backend: "file", configDir: dir });
    const encryptedRaw = readFileSync(path, "utf8");
    rmSync(join(dir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    expect(() =>
      writeSecretTextFileSync(path, "plaintext-regression", { backend: "file", configDir: dir }),
    ).toThrow(/Refusing to write Omnesis secret file/);
    expect(readFileSync(path, "utf8")).toBe(encryptedRaw);
  });

  test("marker prevents creating new plaintext secret files when the root key is unavailable", async () => {
    const newPath = join(dir, "provider", "new-account", "tokens.json");
    await markSecretFileEncryptionRequired(dir);
    clearSecretFileKeyCacheForTests();

    await expect(
      writeSecretTextFile(newPath, "plaintext-regression", { backend: "file", configDir: dir }),
    ).rejects.toThrow(/Refusing to write Omnesis secret file/);
    expect(existsSync(newPath)).toBe(false);
  });

  test("restored marker prevents new plaintext secret files when the root key was not restored", async () => {
    const restoredDir = mkdtempSync(join(tmpdir(), "omnesis-secret-file-restore-test-"));
    try {
      await ensureInstallRootKey({ backend: "file", configDir: dir });
      await writeSecretTextFile(path, "encrypted-token", { backend: "file", configDir: dir });
      mkdirSync(join(restoredDir, "keyring"), { recursive: true });
      copyFileSync(
        join(dir, "keyring", "secret-files-required"),
        join(restoredDir, "keyring", "secret-files-required"),
      );
      clearSecretFileKeyCacheForTests();

      const newPath = join(restoredDir, "provider", "new-account", "tokens.json");
      await expect(
        writeSecretTextFile(newPath, "plaintext-regression", {
          backend: "file",
          configDir: restoredDir,
        }),
      ).rejects.toThrow(/Refusing to write Omnesis secret file/);
      expect(existsSync(newPath)).toBe(false);
    } finally {
      rmSync(restoredDir, { recursive: true, force: true });
    }
  });

  test("migrates an existing plaintext file in place", async () => {
    await writeSecretTextFile(path, "legacy-token", { backend: "file", configDir: dir });
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    clearSecretFileKeyCacheForTests();

    const result = await migrateSecretTextFile(path, { backend: "file", configDir: dir });

    expect(result).toEqual({ present: true, changed: true, encrypted: true });
    expect(isEncryptedSecretFile(readFileSync(path, "utf8"))).toBe(true);
    await expect(readSecretTextFile(path, { backend: "file", configDir: dir })).resolves.toBe(
      "legacy-token",
    );
  });

  test("primeSecretFileKeyCache loads a key for later sync reads", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await writeSecretTextFile(path, "cached-token", { backend: "file", configDir: dir });
    clearSecretFileKeyCacheForTests();

    await expect(primeSecretFileKeyCache({ backend: "file", configDir: dir })).resolves.toBe(true);

    expect(readSecretTextFileSync(path, { backend: "file", configDir: dir })).toBe("cached-token");
  });

  test("migrate reports absent files without creating them", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    await expect(migrateSecretTextFile(path, { backend: "file", configDir: dir })).resolves.toEqual(
      {
        present: false,
        changed: false,
        encrypted: false,
      },
    );
    expect(existsSync(path)).toBe(false);
  });
});

describe("writing secrets while the keyring directory is unreadable", () => {
  // Root ignores the mode bits this fixture relies on.
  const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;

  test.skipIf(!asUnprivilegedUser)(
    "still writes, encrypted, when the root key is in hand",
    async () => {
      // A daemon that primed its root key at boot — or reads it from an OS
      // keyring outside the config dir — holds a key while the keyring directory
      // itself is out of reach. Its writes are encrypted either way, so refusing
      // them would buy nothing and would stall every credential write: the
      // collector persists auth state on essentially every inbound message.
      const configDir = mkdtempSync(join(tmpdir(), "omnesis-secret-unreadable-"));
      await ensureInstallRootKey({ backend: "file", configDir });
      await primeSecretFileKeyCache({ backend: "file", configDir });

      const path = join(configDir, "creds.json");
      chmodSync(join(configDir, "keyring"), 0o000);
      try {
        const result = await writeSecretTextFile(path, JSON.stringify({ token: "abc" }), {
          configDir,
        });
        expect(result.encrypted).toBe(true);
        expect(isEncryptedSecretFile(readFileSync(path, "utf8"))).toBe(true);
      } finally {
        chmodSync(join(configDir, "keyring"), 0o700);
        clearSecretFileKeyCacheForTests();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );
});
