// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
vi.mock("node:fs", async (actual) => ({ ...(await actual<typeof import("node:fs")>()) }));
vi.mock("node:crypto", async (actual) => ({ ...(await actual<typeof import("node:crypto")>()) }));
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
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("encrypted artifacts", () => {
  async function encryptedFixture() {
    const path = join(dir, "input.dat");
    writeFileSync(path, Buffer.alloc(128 * 1024, 0x5a));
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    return encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: dir,
      scope: "export:publication-test",
    });
  }

  test("does not overwrite a destination created after decryption's initial check", async () => {
    const encrypted = await encryptedFixture();
    const output = join(dir, "restored.dat");
    let resume: (() => void) | undefined;
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const actual = fs.createReadStream;
    vi.spyOn(fs, "createReadStream").mockImplementationOnce((...args) => {
      const stream = actual(...args);
      const read = stream._read.bind(stream);
      vi.spyOn(stream, "_read").mockImplementationOnce((size) => {
        resume = () => {
          resume = undefined;
          read(size);
        };
        ready();
      });
      return stream;
    });
    const decrypting = decryptArtifactFileToFile(encrypted.path, output, {
      backend: "file",
      configDir: dir,
    });
    try {
      await Promise.race([
        reading,
        decrypting.then(() => {
          throw new Error("Decryption bypassed the read barrier");
        }),
      ]);
      writeFileSync(output, "a concurrent writer's invented payload", { flag: "wx", mode: 0o600 });
      resume!();
      await expect(decrypting).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(output, "utf8")).toBe("a concurrent writer's invented payload");
      expect(readdirSync(dir).filter((name) => name.startsWith("restored.dat."))).toEqual([]);
    } finally {
      resume?.();
      await decrypting.catch(() => {});
    }
  });

  test("force replaces an existing destination after successful authentication", async () => {
    const encrypted = await encryptedFixture();
    const output = join(dir, "restored.dat");
    writeFileSync(output, "existing invented payload");
    await decryptArtifactFileToFile(encrypted.path, output, {
      backend: "file",
      configDir: dir,
      force: true,
    });
    expect(readFileSync(output)).toEqual(Buffer.alloc(128 * 1024, 0x5a));
    expect(readdirSync(dir).filter((name) => name.startsWith("restored.dat."))).toEqual([]);
  });

  test.each([false, true])(
    "failed final authentication never publishes plaintext (existing target=%s)",
    async (existing) => {
      const encrypted = await encryptedFixture();
      const data = readFileSync(encrypted.path);
      data[data.length - 1] ^= 1;
      writeFileSync(encrypted.path, data);
      const output = join(dir, "restored.dat");
      if (existing) writeFileSync(output, "existing invented payload");
      await expect(
        decryptArtifactFileToFile(encrypted.path, output, {
          backend: "file",
          configDir: dir,
          force: existing,
        }),
      ).rejects.toThrow();
      if (existing) expect(readFileSync(output, "utf8")).toBe("existing invented payload");
      else expect(existsSync(output)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith("restored.dat."))).toEqual([]);
      expect(existsSync(encrypted.path)).toBe(true);
    },
  );

  test.runIf(process.platform !== "win32")(
    "a filesystem without hard links cannot fall back to overwriting output",
    async () => {
      const encrypted = await encryptedFixture();
      const output = join(dir, "restored.dat");
      const error = Object.assign(new Error("Hard links unavailable"), { code: "EOPNOTSUPP" });
      vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
        throw error;
      });
      await expect(
        decryptArtifactFileToFile(encrypted.path, output, { backend: "file", configDir: dir }),
      ).rejects.toBe(error);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith("restored.dat."))).toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "a scratch collision preserves the other file's bytes",
    async () => {
      const encrypted = await encryptedFixture();
      const output = join(dir, "restored.dat");
      const random = Buffer.alloc(6, 0x4a);
      const collision = `${output}.tmp-${process.pid}-${random.toString("hex")}`;
      writeFileSync(collision, "another writer's invented scratch");
      vi.spyOn(crypto, "randomBytes").mockImplementationOnce(
        ((_size: number) => random) as typeof crypto.randomBytes,
      );
      await expect(
        decryptArtifactFileToFile(encrypted.path, output, { backend: "file", configDir: dir }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(readFileSync(collision, "utf8")).toBe("another writer's invented scratch");
      expect(existsSync(output)).toBe(false);
    },
  );
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
