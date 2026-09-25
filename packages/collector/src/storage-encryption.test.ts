// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureInstallRootKey,
  inspectStorageKey,
  markStorageEncryptionRequired,
  storageEncryptionRequired,
  storageKeyPath,
} from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  COLLECTOR_STORAGE_KEYS,
  collectorStoragePosture,
  prepareCollectorStorageEncryption,
} from "./storage-encryption.js";

let dirs: string[] = [];
let priorSecretStore: string | undefined;

beforeEach(() => {
  priorSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
});

afterEach(() => {
  if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-collector-storage-"));
  dirs.push(dir);
  return dir;
}

describe("prepareCollectorStorageEncryption", () => {
  test("the collector's key set is the provider stores, not the gateway's databases", () => {
    expect([...COLLECTOR_STORAGE_KEYS]).toEqual(["whatsapp-store", "imessage-transcripts"]);
  });

  test("a fresh collector with a root key mints its own keys before any store opens", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const readiness = await prepareCollectorStorageEncryption(dir);
    expect(readiness.enabled).toBe(true);
    expect(readiness.created).toEqual(["whatsapp-store", "imessage-transcripts"]);
    expect(storageEncryptionRequired(dir)).toBe(true);
    for (const keyName of COLLECTOR_STORAGE_KEYS) {
      await expect(inspectStorageKey(keyName, { configDir: dir })).resolves.toMatchObject({
        present: true,
        valid: true,
        encrypted: true,
      });
    }
    // The gateway's keys are not this host's to mint.
    await expect(inspectStorageKey("main-db", { configDir: dir })).resolves.toMatchObject({
      present: false,
    });
  });

  test("a restart keeps the keys it already has", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await prepareCollectorStorageEncryption(dir);
    const envelopes = COLLECTOR_STORAGE_KEYS.map((keyName) =>
      readFileSync(storageKeyPath(keyName, dir), "utf8"),
    );

    const again = await prepareCollectorStorageEncryption(dir);
    expect(again).toEqual({ enabled: true, created: [] });
    expect(
      COLLECTOR_STORAGE_KEYS.map((keyName) => readFileSync(storageKeyPath(keyName, dir), "utf8")),
    ).toEqual(envelopes);
  });

  test("an unarmed host without a root key runs plaintext and says so", async () => {
    const dir = tempConfigDir();
    const readiness = await prepareCollectorStorageEncryption(dir);
    expect(readiness).toEqual({ enabled: false, created: [] });
    expect(collectorStoragePosture(readiness)).toMatchObject({ level: "warn" });
    expect(collectorStoragePosture(readiness).message).toContain("omnesis keyring init");
  });

  test("armed encryption without a usable root key refuses the boot instead of opening plaintext", async () => {
    const dir = tempConfigDir();
    await markStorageEncryptionRequired(dir);
    await expect(prepareCollectorStorageEncryption(dir)).rejects.toThrow(
      /encryption is required, but the install root key is unavailable/u,
    );
    for (const keyName of COLLECTOR_STORAGE_KEYS) {
      await expect(inspectStorageKey(keyName, { configDir: dir })).resolves.toMatchObject({
        present: false,
      });
    }
  });

  test("the posture line names what was created on first boot", () => {
    const { level, message } = collectorStoragePosture({
      enabled: true,
      created: ["whatsapp-store"],
    });
    expect(level).toBe("info");
    expect(message).toContain("created whatsapp-store");
  });
});
