// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import {
  clearConfigSecretRefSync,
  configSecretPath,
  makeConfigSecretRef,
  readConfigSecretRefSync,
  writeConfigSecretSync,
} from "./config-secrets.js";
import { clearSecretFileKeyCacheForTests, isEncryptedSecretFile } from "./secret-file.js";

describe("config secrets", () => {
  let dir: string;

  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "omnesis-config-secrets-"));
  });

  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes owner-only plaintext before keyring opt-in", () => {
    const ref = writeConfigSecretSync("inference.backend.openai.apiKey", "sk-example", {
      backend: "file",
      configDir: dir,
    });

    expect(ref).toBe("config-secret:inference.backend.openai.apiKey");
    expect(readConfigSecretRefSync(ref, { backend: "file", configDir: dir })).toBe("sk-example");
    expect(readFileSync(configSecretPath(ref, dir), "utf8")).toBe("sk-example");
  });

  test("writes encrypted config secret files once a root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    clearSecretFileKeyCacheForTests();

    const ref = writeConfigSecretSync("inference.backend.openai.apiKey", "sk-example", {
      backend: "file",
      configDir: dir,
    });

    const raw = readFileSync(configSecretPath(ref, dir), "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain("sk-example");
    expect(readConfigSecretRefSync(ref, { backend: "file", configDir: dir })).toBe("sk-example");
  });

  test("removes a referenced config secret", () => {
    const ref = writeConfigSecretSync("inference.backend.openai.apiKey", "sk-example", {
      backend: "file",
      configDir: dir,
    });
    expect(existsSync(configSecretPath(ref, dir))).toBe(true);

    clearConfigSecretRefSync(ref, dir);

    expect(existsSync(configSecretPath(ref, dir))).toBe(false);
  });

  test("rejects path-shaped secret names", () => {
    expect(() => makeConfigSecretRef("../bad")).toThrow(/Invalid Omnesis config secret name/);
  });
});
