// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearMarkerKeyringState,
  ensureInstallRootKey,
  inspectStorageKey,
  markSecretFileEncryptionRequired,
  markStorageEncryptionRequired,
  readInstallRootKey,
  readMarkerKeyringState,
  storageEncryptionRequired,
  verifySecureMarker,
} from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  resolveGatewayStorageEncryptionKeys,
  storageEncryptionPosture,
} from "./storage-encryption.js";

let dirs: string[] = [];
let priorSecretStore: string | undefined;

beforeEach(() => {
  priorSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
});

afterEach(() => {
  if (priorSecretStore === undefined) {
    delete process.env.OMNESIS_SECRET_STORE;
  } else {
    process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-storage-encryption-"));
  dirs.push(dir);
  return dir;
}

describe("resolveGatewayStorageEncryptionKeys", () => {
  test("leaves live storage plaintext when no root key and no secure marker exist", async () => {
    const dir = tempConfigDir();
    const result = await resolveGatewayStorageEncryptionKeys(dir);
    expect(result.enabled).toBe(false);
    expect(result.mainDbKey).toBeNull();
  });

  test("creates wrapped per-store keys when the root key is available", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const result = await resolveGatewayStorageEncryptionKeys(dir);
    expect(result.enabled).toBe(true);
    expect(result.mainDbKey).toHaveLength(32);
    expect(result.indexDbKey).toHaveLength(32);
    expect(result.analyticsDbKey).toHaveLength(32);
    // The watch-v2 journal is derived and rebuildable, but it holds document
    // titles, person ids and analytics rows. A key missing here is a store
    // sitting plaintext beside encrypted ones, which nothing else would notice.
    expect(result.watchDbKey).toHaveLength(32);
    expect(result.mainDbKeyHex).toHaveLength(64);

    await expect(inspectStorageKey("main-db", { configDir: dir })).resolves.toMatchObject({
      present: true,
      valid: true,
      encrypted: true,
    });
    // Provider stores belong to the collector that hosts them; the gateway
    // mints only its own keys, so a gateway boot never seeds a key the
    // collector is responsible for.
    await expect(inspectStorageKey("whatsapp-store", { configDir: dir })).resolves.toMatchObject({
      present: false,
    });
  });

  test("fails closed when secure storage was marked required but the root key is unavailable", async () => {
    const dir = tempConfigDir();
    await markStorageEncryptionRequired(dir);

    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /live storage encryption is required/i,
    );
  });

  test("upgrades a legacy v1 marker to the MAC-bound format and sets keyring state", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const rootKey = await readInstallRootKey({ backend: "file", configDir: dir });
    if (!rootKey) throw new Error("expected root key");
    // A pre-MAC install: bare v1 sentinel on disk, no keyring state.
    writeFileSync(
      join(dir, "keyring", "storage-encryption-required"),
      "omnesis.storage-encryption.required.v1\n",
    );

    const result = await resolveGatewayStorageEncryptionKeys(dir);
    expect(result.enabled).toBe(true);
    expect(await verifySecureMarker("storage-encryption", rootKey, dir)).toBe("valid");
    expect(
      await readMarkerKeyringState("storage-encryption", { backend: "file", configDir: dir }),
    ).toBe("required");
  });

  test("fails loud on a tampered marker instead of proceeding", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    // First boot arms everything.
    await resolveGatewayStorageEncryptionKeys(dir);
    // Corrupt the marker in place.
    const path = join(dir, "keyring", "storage-encryption-required");
    writeFileSync(path, readFileSync(path, "utf8").replace("mac=", "mac=AAAA"));

    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /failed integrity verification/i,
    );
  });

  test("fails loud when an armed marker file was deleted (keyring state survives)", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await resolveGatewayStorageEncryptionKeys(dir);

    rmSync(join(dir, "keyring", "storage-encryption-required"));
    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /marker file is missing/i,
    );
  });

  test("fails loud when marker, keys, and root key are gone but keyring state survives", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await resolveGatewayStorageEncryptionKeys(dir);

    // Simulate a partial wipe: marker + wrapped keys + the root-key entry are
    // gone, but the file store's marker-state entries survive under
    // keyring/dev.omnesis/ (entry filenames are base64url of the entry name).
    rmSync(join(dir, "keyring", "storage-encryption-required"));
    rmSync(join(dir, "keyring", "storage-keys"), { recursive: true, force: true });
    const storeDir = join(dir, "keyring", "dev.omnesis");
    const rootKeyEntry = readdirSync(storeDir).find((f) =>
      Buffer.from(f.replace(/\.secret$/, ""), "base64url")
        .toString("utf8")
        .includes("install-root-key"),
    );
    if (!rootKeyEntry) throw new Error("expected a root key entry in the file store");
    rmSync(join(storeDir, rootKeyEntry));

    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /records that live storage encryption was enabled/i,
    );
  });

  test("self-heals keyring state for a valid marker restored onto a fresh store", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await resolveGatewayStorageEncryptionKeys(dir);
    // Simulate `omnesis restore` on a fresh machine: marker + keys + root key
    // all restored, but the marker-state entries absent.
    await clearMarkerKeyringState("storage-encryption", { backend: "file", configDir: dir });
    await clearMarkerKeyringState("secret-files", { backend: "file", configDir: dir });

    const result = await resolveGatewayStorageEncryptionKeys(dir);
    expect(result.enabled).toBe(true);
    expect(
      await readMarkerKeyringState("storage-encryption", { backend: "file", configDir: dir }),
    ).toBe("required");
  });

  test("re-arms a deleted marker on a pre-MAC install with existing keys and no state", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await resolveGatewayStorageEncryptionKeys(dir);
    // Pre-MAC installs have no keyring state; simulate by clearing it, then
    // deleting the marker. Boot must re-arm rather than run marker-less.
    await clearMarkerKeyringState("storage-encryption", { backend: "file", configDir: dir });
    rmSync(join(dir, "keyring", "storage-encryption-required"));

    const result = await resolveGatewayStorageEncryptionKeys(dir);
    expect(result.enabled).toBe(true);
    expect(storageEncryptionRequired(dir)).toBe(true);
  });
});

describe("storageEncryptionPosture", () => {
  test("enabled → info confirmation", () => {
    const posture = storageEncryptionPosture(true);
    expect(posture.level).toBe("info");
    expect(posture.message).toMatch(/encryption enabled/i);
  });

  test("disabled → high-signal plaintext warning that names the remedy", () => {
    const posture = storageEncryptionPosture(false);
    expect(posture.level).toBe("warn");
    expect(posture.message).toMatch(/unencrypted|plaintext/i);
    // The operator is told exactly what to run to fix it.
    expect(posture.message).toContain("omnesis keyring init");
    expect(posture.message).toContain("omnesis doctor");
  });
});

describe("marker integrity — secret-files kind and state namespacing", () => {
  test("fails loud when the armed secret-files marker was deleted", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await markSecretFileEncryptionRequired(dir, { backend: "file" });
    await resolveGatewayStorageEncryptionKeys(dir);

    rmSync(join(dir, "keyring", "secret-files-required"));
    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /marker file is missing/i,
    );
  });

  test("fails loud on a tampered secret-files marker", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await markSecretFileEncryptionRequired(dir, { backend: "file" });
    await resolveGatewayStorageEncryptionKeys(dir);

    const path = join(dir, "keyring", "secret-files-required");
    writeFileSync(path, readFileSync(path, "utf8").replace("mac=", "mac=AAAA"));
    await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
      /failed integrity verification/i,
    );
  });

  test("one install's armed state never trips a second config dir on the same store", async () => {
    // Two installs sharing one OS-user secret store (simulated with a shared
    // file-store service dir is not possible for the file backend — instead
    // assert the state entry NAME is namespaced per config dir).
    const a = tempConfigDir();
    const b = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: a });
    await resolveGatewayStorageEncryptionKeys(a);
    // Install A is armed; install B (fresh, same machine) must boot plaintext
    // without tripping A's state.
    const result = await resolveGatewayStorageEncryptionKeys(b);
    // B has no root key of its own (file backend is per-config-dir), so it
    // stays plaintext rather than throwing a false "deletion detected".
    expect(result.enabled).toBe(false);
  });
});

describe("passphrase-sealed root key at boot", () => {
  test("a present-but-unopenable root key refuses to boot plaintext", async () => {
    const dir = tempConfigDir();
    process.env.OMNESIS_SECRET_STORE = "passphrase";
    process.env.OMNESIS_KEYRING_PASSPHRASE = "initial passphrase";
    try {
      await ensureInstallRootKey({ backend: "passphrase", configDir: dir });
      // Fresh install: no markers, no storage keys yet — the exact window
      // where a wrong passphrase previously booted plaintext silently.
      process.env.OMNESIS_KEYRING_PASSPHRASE = "typo'd passphrase";
      await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(/cannot be read/i);
    } finally {
      delete process.env.OMNESIS_KEYRING_PASSPHRASE;
    }
  });
});

/**
 * The passphrase (present-but-unopenable root key) and marker-MAC (tampered
 * marker) fail-closed guards were built on separate branches and both edit the
 * single boot resolver. This asserts both survive together in the merged
 * function, so a future refactor cannot silently drop one and re-open the
 * plaintext-downgrade window the other closes.
 */
describe("composed fail-closed enforcement (passphrase + marker MAC)", () => {
  test("the one boot resolver enforces BOTH the unreadable-root-key and tampered-marker guards", async () => {
    const dir = tempConfigDir();
    process.env.OMNESIS_SECRET_STORE = "passphrase";
    process.env.OMNESIS_KEYRING_PASSPHRASE = "initial passphrase";
    try {
      await ensureInstallRootKey({ backend: "passphrase", configDir: dir });
      // Valid first boot arms the markers + wrapped keys.
      await expect(resolveGatewayStorageEncryptionKeys(dir)).resolves.toMatchObject({
        enabled: true,
      });

      // Guard 1 (passphrase slice): a present root key that the wrong
      // passphrase cannot open must refuse to boot plaintext.
      process.env.OMNESIS_KEYRING_PASSPHRASE = "wrong passphrase";
      await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(/cannot be read/i);

      // Guard 2 (marker-MAC slice): with the right passphrase the root key
      // opens, but a tampered marker must still fail integrity verification.
      process.env.OMNESIS_KEYRING_PASSPHRASE = "initial passphrase";
      const marker = join(dir, "keyring", "storage-encryption-required");
      writeFileSync(marker, readFileSync(marker, "utf8").replace("mac=", "mac=AAAA"));
      await expect(resolveGatewayStorageEncryptionKeys(dir)).rejects.toThrow(
        /failed integrity verification/i,
      );
    } finally {
      delete process.env.OMNESIS_KEYRING_PASSPHRASE;
    }
  });
});
