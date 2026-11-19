// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { readTlsPrivateKey, writeTlsMaterial } from "./persistence.js";

let dir: string;
beforeEach(async () => {
  core.clearSecretFileKeyCacheForTests();
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  dir = await mkdtemp(join(tmpdir(), "tls-private-persistence-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  core.clearSecretFileKeyCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

test("encrypted staged keys keep the final path scope across replacement and readback", async () => {
  await core.ensureInstallRootKey({ backend: "file", configDir: dir });
  await core.primeSecretFileKeyCache({ backend: "file", configDir: dir });
  const cert = join(dir, "certificate.pem"),
    key = join(dir, "private-key.pem");
  await writeTlsMaterial(
    cert,
    key,
    { cert: "invented public certificate", key: "invented private key" },
    dir,
  );
  expect(core.secretFileEncryptionRequired(dir)).toBe(true);
  const serialized = await readFile(key, "utf8");
  expect(core.isEncryptedSecretFile(serialized)).toBe(true);
  expect(serialized).not.toContain("invented private key");
  expect(await readTlsPrivateKey(key, dir)).toBe("invented private key");
  await writeTlsMaterial(
    cert,
    key,
    { cert: "replacement public certificate", key: "replacement private key" },
    dir,
  );
  expect(await readTlsPrivateKey(key, dir)).toBe("replacement private key");
  expect(await readFile(cert, "utf8")).toBe("replacement public certificate");
  expect(
    (await readdir(dir)).some((name) => name.includes(".renew-") || name.endsWith(".tmp")),
  ).toBe(false);
});

test("required encryption with an unavailable root refuses replacement and retains both files", async () => {
  const cert = join(dir, "certificate.pem"),
    key = join(dir, "private-key.pem");
  await writeTlsMaterial(
    cert,
    key,
    { cert: "old public certificate", key: "old private key" },
    dir,
  );
  await core.markSecretFileEncryptionRequired(dir, { backend: "file" });
  await expect(
    writeTlsMaterial(cert, key, { cert: "replacement certificate", key: "replacement key" }, dir),
  ).rejects.toThrow("without the install root key");
  expect(await readFile(cert, "utf8")).toBe("old public certificate");
  expect(await readTlsPrivateKey(key, dir)).toBe("old private key");
  expect(
    (await readdir(dir)).some((name) => name.includes(".renew-") || name.endsWith(".tmp")),
  ).toBe(false);
});

test("a legacy plaintext key remains readable", async () => {
  const key = join(dir, "legacy-key.pem");
  if (process.platform === "win32")
    await core.atomicWriteFile(key, "invented legacy key", { mode: 0o600 });
  else await writeFile(key, "invented legacy key", { mode: 0o600 });
  expect(await readTlsPrivateKey(key, dir)).toBe("invented legacy key");
});

test("Windows private key publication failure leaves the old certificate and key untouched", async () => {
  const cert = join(dir, "certificate.pem"),
    key = join(dir, "private-key.pem");
  await writeTlsMaterial(
    cert,
    key,
    { cert: "old public certificate", key: "old private key" },
    dir,
  );
  const failure = new Error("Invented protected key publication failure");
  const writer = vi.spyOn(core, "writeSecretTextFile").mockRejectedValue(failure);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await expect(
      writeTlsMaterial(cert, key, { cert: "replacement certificate", key: "replacement key" }, dir),
    ).rejects.toBe(failure);
    expect(writer).toHaveBeenCalledWith(key, "replacement key", { configDir: dir });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  expect(await readFile(cert, "utf8")).toBe("old public certificate");
  expect(await readFile(key, "utf8")).toBe("old private key");
});

test("an existing encrypted key cannot be downgraded even when the root and requirement marker are lost", async () => {
  await core.ensureInstallRootKey({ backend: "file", configDir: dir });
  await core.primeSecretFileKeyCache({ backend: "file", configDir: dir });
  const cert = join(dir, "certificate.pem"),
    key = join(dir, "private-key.pem");
  await writeTlsMaterial(
    cert,
    key,
    { cert: "old public certificate", key: "old private key" },
    dir,
  );
  const serialized = await readFile(key, "utf8");
  await rm(join(dir, "keyring"), { recursive: true, force: true });
  core.clearSecretFileKeyCacheForTests();
  expect(core.secretFileEncryptionRequired(dir)).toBe(false);
  await expect(
    writeTlsMaterial(cert, key, { cert: "replacement certificate", key: "replacement key" }, dir),
  ).rejects.toThrow("without the install root key");
  expect(await readFile(key, "utf8")).toBe(serialized);
  expect(await readFile(cert, "utf8")).toBe("old public certificate");
});
