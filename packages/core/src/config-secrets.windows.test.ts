// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearConfigSecretRefSync,
  configSecretPath,
  makeConfigSecretRef,
  readConfigSecretRefSync,
  writeConfigSecretSync,
} from "./config-secrets.js";
import {
  clearSecretFileKeyCacheForTests,
  isEncryptedSecretFile,
  writeSecretTextFileSync,
} from "./secret-file.js";
import { ensureInstallRootKey } from "./secret-store.js";

describe.runIf(process.platform === "win32")("Windows config secret identity", () => {
  let dir: string;
  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "windows-config-secret-"));
  });
  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("case-folding legacy filenames cannot overwrite or delete another named value", () => {
    const opts = { backend: "file" as const, configDir: dir };
    expect(Buffer.from("aaE").toString("base64url").toLowerCase()).toBe(
      Buffer.from("aa_").toString("base64url").toLowerCase(),
    );
    const first = writeConfigSecretSync("aaE", "invented first value", opts);
    const second = writeConfigSecretSync("aa_", "invented second value", opts);
    expect(configSecretPath(first, dir).toLowerCase()).not.toBe(
      configSecretPath(second, dir).toLowerCase(),
    );
    expect(readConfigSecretRefSync(first, opts)).toBe("invented first value");
    expect(readConfigSecretRefSync(second, opts)).toBe("invented second value");
    clearConfigSecretRefSync(first, dir);
    clearConfigSecretRefSync(first, dir);
    expect(readConfigSecretRefSync(first, opts)).toBeNull();
    expect(readConfigSecretRefSync(second, opts)).toBe("invented second value");
  }, 60_000);

  test("legacy fallback checks its exact name and retires it only after a committed replacement", () => {
    const opts = { backend: "file" as const, configDir: dir };
    const first = makeConfigSecretRef("aaE"),
      second = makeConfigSecretRef("aa_");
    const legacy = join(
      dir,
      "config-secrets",
      `${Buffer.from("aaE").toString("base64url")}.secret`,
    );
    writeSecretTextFileSync(legacy, "invented legacy value", { ...opts, scope: first });
    expect(readConfigSecretRefSync(first, opts)).toBe("invented legacy value");
    expect(readConfigSecretRefSync(second, opts)).toBeNull();
    expect(existsSync(configSecretPath(first, dir))).toBe(false);
    writeConfigSecretSync("aa_", "invented second value", opts);
    expect(readFileSync(legacy, "utf8")).toBe("invented legacy value");
    writeConfigSecretSync("aaE", "invented updated value", opts);
    expect(existsSync(legacy)).toBe(false);
    expect(readConfigSecretRefSync(first, opts)).toBe("invented updated value");
    expect(readConfigSecretRefSync(second, opts)).toBe("invented second value");
  }, 60_000);

  test("encrypted legacy relocation keeps its logical authenticated scope", async () => {
    const opts = { backend: "file" as const, configDir: dir };
    await ensureInstallRootKey(opts);
    const ref = makeConfigSecretRef("fixture.apiKey");
    const legacy = join(
      dir,
      "config-secrets",
      `${Buffer.from("fixture.apiKey").toString("base64url")}.secret`,
    );
    writeSecretTextFileSync(legacy, "invented encrypted value", { ...opts, scope: ref });
    expect(readConfigSecretRefSync(ref, opts)).toBe("invented encrypted value");
    expect(existsSync(configSecretPath(ref, dir))).toBe(false);
    writeConfigSecretSync("fixture.apiKey", "invented replacement", opts);
    expect(isEncryptedSecretFile(readFileSync(configSecretPath(ref, dir), "utf8"))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readConfigSecretRefSync(ref, opts)).toBe("invented replacement");
  }, 60_000);

  test("encrypted legacy state without a key or marker is never replaced with plaintext", async () => {
    const opts = { backend: "file" as const, configDir: dir };
    await ensureInstallRootKey(opts);
    const ref = makeConfigSecretRef("fixture.apiKey");
    writeConfigSecretSync("fixture.apiKey", "invented encrypted value", opts);
    const raw = readFileSync(configSecretPath(ref, dir), "utf8");
    const otherDir = join(dir, "other-install");
    const other = { backend: "file" as const, configDir: otherDir };
    const legacy = join(
      otherDir,
      "config-secrets",
      `${Buffer.from("fixture.apiKey").toString("base64url")}.secret`,
    );
    clearSecretFileKeyCacheForTests();
    writeSecretTextFileSync(legacy, raw, other);
    expect(() => writeConfigSecretSync("fixture.apiKey", "replacement", other)).toThrow(
      /Refusing to write Omnesis secret file/,
    );
    expect(existsSync(configSecretPath(ref, otherDir))).toBe(false);
    expect(readFileSync(legacy, "utf8")).toBe(raw);
  }, 60_000);
});
