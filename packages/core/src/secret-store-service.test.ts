// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSecretStore,
  generateInstallRootKey,
  KEYRING_ENV_KEYS,
  OMNESIS_INSTALL_ROOT_KEY,
  OMNESIS_SECRET_SERVICE,
  readInstallRootKey,
  readInstallRootKeySync,
  resolveSecretStoreService,
  writeInstallRootKey,
} from "./secret-store.js";
import { readSecretTextFile, readSecretTextFileSync, writeSecretTextFile } from "./secret-file.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret store service namespaces", () => {
  test("sealed file reads and their root-key cache follow environment namespace changes", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-service-sealed-"));
    dirs.push(configDir);
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    const options = { configDir, backend: "file" as const };
    vi.stubEnv("OMNESIS_SECRET_SERVICE", undefined);
    await writeInstallRootKey(generateInstallRootKey(), options);
    const first = join(configDir, "first-secret");
    await writeSecretTextFile(first, "first-fictional-value", options);
    vi.stubEnv("OMNESIS_SECRET_SERVICE", "dev.omnesis.desktop.example");
    await writeInstallRootKey(generateInstallRootKey(), options);
    const second = join(configDir, "second-secret");
    await writeSecretTextFile(second, "second-fictional-value", options);
    expect(await readSecretTextFile(second, options)).toBe("second-fictional-value");
    expect(readSecretTextFileSync(second, options)).toBe("second-fictional-value");
    await expect(readSecretTextFile(first, options)).rejects.toThrow();
    vi.stubEnv("OMNESIS_SECRET_SERVICE", undefined);
    expect(await readSecretTextFile(first, options)).toBe("first-fictional-value");
    expect(readSecretTextFileSync(first, options)).toBe("first-fictional-value");
    await expect(readSecretTextFile(second, options)).rejects.toThrow();
  });
  test("keeps the headless namespace when no service is selected", () => {
    vi.stubEnv("OMNESIS_SECRET_SERVICE", undefined);
    expect(resolveSecretStoreService()).toBe(OMNESIS_SECRET_SERVICE);
  });

  test("forwards the namespace through the shared child environment contract", () => {
    expect(KEYRING_ENV_KEYS).toContain("OMNESIS_SECRET_SERVICE");
  });

  test("async and sync root-key reads select the same isolated namespace", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-service-scope-"));
    dirs.push(configDir);
    vi.stubEnv("OMNESIS_SECRET_SERVICE", undefined);
    const headless = generateInstallRootKey();
    await writeInstallRootKey(headless, { configDir, backend: "file" });
    vi.stubEnv("OMNESIS_SECRET_SERVICE", "dev.omnesis.desktop.example");
    expect(await readInstallRootKey({ configDir, backend: "file" })).toBeNull();
    expect(readInstallRootKeySync({ configDir, backend: "file" })).toBeNull();
    const desktop = generateInstallRootKey();
    await writeInstallRootKey(desktop, { configDir, backend: "file" });
    expect(await readInstallRootKey({ configDir, backend: "file" })).toBe(desktop);
    expect(readInstallRootKeySync({ configDir, backend: "file" })).toBe(desktop);
    vi.stubEnv("OMNESIS_SECRET_SERVICE", undefined);
    expect(readInstallRootKeySync({ configDir, backend: "file" })).toBe(headless);
  });

  test("passes the selected service to macOS Keychain without changing the account identity", async () => {
    vi.stubEnv("OMNESIS_SECRET_SERVICE", "dev.omnesis.desktop.example");
    const calls: string[][] = [];
    const store = createSecretStore({
      backend: "macos-keychain",
      platform: "darwin",
      runCommand: async (_command, args) => {
        calls.push(args);
        return { code: 44, stdout: "", stderr: "" };
      },
    });
    await store.read(OMNESIS_INSTALL_ROOT_KEY);
    expect(calls).toEqual([
      [
        "find-generic-password",
        "-a",
        OMNESIS_INSTALL_ROOT_KEY,
        "-s",
        "dev.omnesis.desktop.example",
        "-w",
      ],
    ]);
  });

  test("an explicit service overrides the environment", async () => {
    vi.stubEnv("OMNESIS_SECRET_SERVICE", "dev.omnesis.desktop.example");
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-service-explicit-"));
    dirs.push(configDir);
    const value = generateInstallRootKey();
    const options = { configDir, backend: "file" as const, service: OMNESIS_SECRET_SERVICE };
    await writeInstallRootKey(value, options);
    expect(await readInstallRootKey(options)).toBe(value);
    expect(readInstallRootKeySync(options)).toBe(value);
    expect(await readInstallRootKey({ configDir, backend: "file" })).toBeNull();
  });

  test.each([
    "",
    "..",
    "../other",
    "/tmp/other",
    "service/other",
    "a\\b",
    "name\nvalue",
    "name\n",
    "x".repeat(256),
  ])("refuses unsafe environment namespace %j before accessing a store", (service) => {
    vi.stubEnv("OMNESIS_SECRET_SERVICE", service);
    expect(() => createSecretStore({ backend: "file" })).toThrow(/OMNESIS_SECRET_SERVICE/);
    expect(() => readInstallRootKeySync({ backend: "file" })).toThrow(/OMNESIS_SECRET_SERVICE/);
  });
});
