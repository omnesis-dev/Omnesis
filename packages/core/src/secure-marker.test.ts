// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey, readInstallRootKey } from "./secret-store.js";
import {
  classifySecureMarker,
  clearMarkerKeyringState,
  readMarkerKeyringState,
  renderSecureMarker,
  secureMarkerPath,
  verifySecureMarker,
  writeSecureMarker,
  writeSecureMarkerSync,
} from "./secure-marker.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-secure-marker-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeRootKey(): string {
  return `omn_root_v1_${randomBytes(32).toString("base64url")}`;
}

describe("renderSecureMarker / classifySecureMarker", () => {
  test("a rendered v2 marker verifies under the same root key", () => {
    const rootKey = fakeRootKey();
    const raw = renderSecureMarker("storage-encryption", rootKey);
    expect(raw.startsWith("omnesis.storage-encryption.required.v2\n")).toBe(true);
    expect(classifySecureMarker("storage-encryption", raw, rootKey)).toBe("valid");
  });

  test("a marker from a different install's root key is invalid", () => {
    const raw = renderSecureMarker("storage-encryption", fakeRootKey());
    expect(classifySecureMarker("storage-encryption", raw, fakeRootKey())).toBe("invalid");
  });

  test("the two marker kinds are domain-separated", () => {
    const rootKey = fakeRootKey();
    const raw = renderSecureMarker("storage-encryption", rootKey);
    // Same root key, but the secret-files header/MAC domain must not accept it.
    expect(classifySecureMarker("secret-files", raw, rootKey)).toBe("invalid");
  });

  test("tampering with any line invalidates the marker", () => {
    const rootKey = fakeRootKey();
    const raw = renderSecureMarker("secret-files", rootKey);
    const lines = raw.split("\n");
    const flippedMac = `mac=${Buffer.from(randomBytes(32)).toString("base64url")}`;
    expect(
      classifySecureMarker(
        "secret-files",
        [lines[0], lines[1], flippedMac, ""].join("\n"),
        rootKey,
      ),
    ).toBe("invalid");
    const flippedSalt = `salt=${Buffer.from(randomBytes(16)).toString("base64url")}`;
    expect(
      classifySecureMarker(
        "secret-files",
        [lines[0], flippedSalt, lines[2], ""].join("\n"),
        rootKey,
      ),
    ).toBe("invalid");
  });

  test("legacy v1 sentinels are recognized as legacy, arbitrary junk as invalid", () => {
    const rootKey = fakeRootKey();
    expect(
      classifySecureMarker(
        "storage-encryption",
        "omnesis.storage-encryption.required.v1\n",
        rootKey,
      ),
    ).toBe("legacy");
    expect(classifySecureMarker("storage-encryption", "required", rootKey)).toBe("invalid");
    expect(classifySecureMarker("storage-encryption", "", rootKey)).toBe("invalid");
  });
});

describe("writeSecureMarker / verifySecureMarker (file backend)", () => {
  test("writes a v2 marker + keyring state when a root key exists, and verifies", async () => {
    const configDir = tmp();
    await ensureInstallRootKey({ backend: "file", configDir });
    const rootKey = await readInstallRootKey({ backend: "file", configDir });
    if (!rootKey) throw new Error("expected root key");

    await writeSecureMarker("storage-encryption", { backend: "file", configDir });

    expect(await verifySecureMarker("storage-encryption", rootKey, configDir)).toBe("valid");
    expect(await readMarkerKeyringState("storage-encryption", { backend: "file", configDir })).toBe(
      "required",
    );
  });

  test("falls back to the legacy sentinel when no root key is available", async () => {
    const configDir = tmp();
    await writeSecureMarker("secret-files", { backend: "file", configDir });
    const raw = readFileSync(secureMarkerPath("secret-files", configDir), "utf8");
    expect(raw).toBe("omnesis.secret-files.required.v1\n");
    // No root key was ever written, so no state entry either.
    expect(await readMarkerKeyringState("secret-files", { backend: "file", configDir })).toBeNull();
  });

  test("verifySecureMarker reports missing when no file exists", async () => {
    const configDir = tmp();
    expect(await verifySecureMarker("storage-encryption", fakeRootKey(), configDir)).toBe(
      "missing",
    );
  });

  test("sync variant writes the same verifiable format", async () => {
    const configDir = tmp();
    await ensureInstallRootKey({ backend: "file", configDir });
    const rootKey = await readInstallRootKey({ backend: "file", configDir });
    if (!rootKey) throw new Error("expected root key");

    writeSecureMarkerSync("storage-encryption", { backend: "file", configDir });
    expect(await verifySecureMarker("storage-encryption", rootKey, configDir)).toBe("valid");
  });

  test("clearMarkerKeyringState removes the armed state", async () => {
    const configDir = tmp();
    await ensureInstallRootKey({ backend: "file", configDir });
    await writeSecureMarker("storage-encryption", { backend: "file", configDir });
    await clearMarkerKeyringState("storage-encryption", { backend: "file", configDir });
    expect(
      await readMarkerKeyringState("storage-encryption", { backend: "file", configDir }),
    ).toBeNull();
  });

  test("readMarkerKeyringState fails open on an unavailable store", async () => {
    const configDir = tmp();
    // The "unavailable" platform resolution: no secret-service on an unsupported OS.
    expect(
      await readMarkerKeyringState("storage-encryption", {
        configDir,
        platform: "freebsd",
      }),
    ).toBeNull();
  });

  test("a corrupted on-disk marker verifies as invalid", async () => {
    const configDir = tmp();
    await ensureInstallRootKey({ backend: "file", configDir });
    const rootKey = await readInstallRootKey({ backend: "file", configDir });
    if (!rootKey) throw new Error("expected root key");
    await writeSecureMarker("storage-encryption", { backend: "file", configDir });

    const path = secureMarkerPath("storage-encryption", configDir);
    writeFileSync(path, readFileSync(path, "utf8").replace("mac=", "mac=AAAA"));
    expect(await verifySecureMarker("storage-encryption", rootKey, configDir)).toBe("invalid");
    expect(existsSync(path)).toBe(true);
  });

  test("re-arms a corrupted marker back to valid when the root key is readable", async () => {
    const configDir = tmp();
    await ensureInstallRootKey({ backend: "file", configDir });
    const rootKey = await readInstallRootKey({ backend: "file", configDir });
    if (!rootKey) throw new Error("expected root key");
    await writeSecureMarker("storage-encryption", { backend: "file", configDir });

    const path = secureMarkerPath("storage-encryption", configDir);
    writeFileSync(path, readFileSync(path, "utf8").replace("mac=", "mac=AAAA"));
    expect(await verifySecureMarker("storage-encryption", rootKey, configDir)).toBe("invalid");

    // A fresh write with the same root key heals the marker — this is the
    // convergence `omnesis keyring storage-init` relies on for marker repair.
    await writeSecureMarker("storage-encryption", { backend: "file", configDir });
    expect(await verifySecureMarker("storage-encryption", rootKey, configDir)).toBe("valid");
  });
});

describe("readMarkerKeyringState — unreadable versus offline", () => {
  // Root ignores the mode bits this fixture relies on.
  const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;

  test.skipIf(!asUnprivilegedUser)(
    "propagates an unreadable store instead of reading it as unarmed",
    async () => {
      // The state entry mirrors "encryption is armed" so a deleted marker cannot
      // silently downgrade an install. An offline store answers nothing and must
      // stay soft; a store whose entries are merely out of reach is withholding
      // an answer, and reporting that as "not armed" is the downgrade itself.
      const configDir = tmp("omnesis-marker-unreadable-");
      await ensureInstallRootKey({ backend: "file", configDir });
      await writeSecureMarker("storage-encryption", { backend: "file", configDir });
      expect(
        await readMarkerKeyringState("storage-encryption", { backend: "file", configDir }),
      ).toBe("required");

      chmodSync(join(configDir, "keyring"), 0o000);
      try {
        await expect(
          readMarkerKeyringState("storage-encryption", { backend: "file", configDir }),
        ).rejects.toThrow(/Cannot determine whether/);
      } finally {
        chmodSync(join(configDir, "keyring"), 0o700);
      }
    },
  );
});
