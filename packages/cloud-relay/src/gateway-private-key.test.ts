// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { readGatewayTlsPrivateKey } from "./gateway-private-key.js";

let dir: string;
beforeEach(async () => {
  core.clearSecretFileKeyCacheForTests();
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  dir = await mkdtemp(join(tmpdir(), "gateway-key-envelope-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  core.clearSecretFileKeyCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

test("decrypts only the explicitly identified configuration scope", async () => {
  await core.ensureInstallRootKey({ backend: "file", configDir: dir });
  await core.primeSecretFileKeyCache({ backend: "file", configDir: dir });
  const key = join(dir, "tls", "private.pem");
  await core.writeSecretTextFile(key, "invented key PEM", { configDir: dir });
  expect(await readGatewayTlsPrivateKey(key, dir)).toBe("invented key PEM");
  await expect(readGatewayTlsPrivateKey(key)).rejects.toThrow(
    "requires its configuration directory",
  );
  await expect(readGatewayTlsPrivateKey(key, join(dir, "another-config"))).rejects.toThrow();
});

test("preserves plaintext legacy keys without requiring configuration inference", async () => {
  const key = join(dir, "private.pem");
  await core.atomicWriteFile(key, "invented legacy PEM", { mode: 0o600 });
  expect(await readGatewayTlsPrivateKey(key)).toBe("invented legacy PEM");
});

test("rejects oversized serialized key data before decoding", async () => {
  const key = join(dir, "oversized.pem");
  await core.atomicWriteFile(key, "x".repeat(65_537), { mode: 0o600 });
  const decode = vi.spyOn(core, "decodeSecretTextFileValue");
  await expect(readGatewayTlsPrivateKey(key, dir)).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});

test("Windows refuses unsafe held key contents before decoding", async () => {
  const failure = Object.assign(new Error("Invented unsafe key contents"), { code: "EPRIVATE" });
  const read = vi.spyOn(core, "readWindowsPrivateFile").mockRejectedValue(failure);
  const decode = vi.spyOn(core, "decodeSecretTextFileValue");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await expect(readGatewayTlsPrivateKey(join(dir, "private.pem"), dir)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledWith(join(dir, "private.pem"), 65_536);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
