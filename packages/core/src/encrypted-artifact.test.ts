// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import {
  decryptArtifactFileToBuffer,
  decryptArtifactFileToFile,
  encryptArtifactFileInPlace,
  isEncryptedArtifactFile,
} from "./encrypted-artifact.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-artifact-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("encrypted artifacts", () => {
  test("leaves files plaintext when no install root key exists", async () => {
    const path = join(dir, "documents.jsonl");
    writeFileSync(path, "plain export\n");

    const result = await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "export:test",
    });

    expect(result.encrypted).toBe(false);
    expect(result.path).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("plain export\n");
    expect(existsSync(`${path}.enc`)).toBe(false);
  });

  test("encrypts in place and decrypts with the same root key", async () => {
    const path = join(dir, "omnesis.db");
    writeFileSync(path, "database snapshot bytes");
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const result = await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "backup:one:omnesis.db",
    });

    expect(result.encrypted).toBe(true);
    expect(result.path).toBe(`${path}.enc`);
    expect(existsSync(path)).toBe(false);
    expect(isEncryptedArtifactFile(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8")).not.toContain("database snapshot bytes");

    const decrypted = await decryptArtifactFileToBuffer(result.path, {
      backend: "file",
      configDir: dir,
    });
    expect(decrypted.toString("utf8")).toBe("database snapshot bytes");
  });

  test("decrypts encrypted artifacts to private plaintext files", async () => {
    const path = join(dir, "export.jsonl");
    const output = join(dir, "export.jsonl.restored");
    writeFileSync(path, "portable export bytes");
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const encrypted = await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "export:restore",
    });

    const restored = await decryptArtifactFileToFile(encrypted.path, output, {
      backend: "file",
      configDir: dir,
    });

    expect(restored.decrypted).toBe(true);
    expect(restored.path).toBe(output);
    expect(readFileSync(output, "utf8")).toBe("portable export bytes");
    expect(existsSync(encrypted.path)).toBe(true);
  });

  test("encrypted artifacts fail closed when the root key is unavailable", async () => {
    const path = join(dir, "documents.jsonl");
    writeFileSync(path, "portable data");
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const result = await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "export:missing-key",
    });

    rmSync(join(dir, "keyring"), { recursive: true, force: true });
    await expect(
      decryptArtifactFileToBuffer(result.path, { backend: "file", configDir: dir }),
    ).rejects.toThrow(/root key unavailable/);
  });
});
