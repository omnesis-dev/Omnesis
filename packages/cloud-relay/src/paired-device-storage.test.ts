// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import {
  createSecretStore,
  ensureInstallRootKey,
  isEncryptedSecretFile,
  writeSecretTextFile,
} from "@omnesis/core";
import { saveDirectCandidates } from "./device-file-hints.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import {
  readPairedDeviceFile,
  pairedDeviceSecretOptions,
  savePairedDeviceFile,
  type pairedDeviceSchema,
} from "./paired-device-storage.js";
import { defaultCloudDeviceFile } from "./client-bootstrap.js";
import type { z } from "zod";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-sealed-pairing-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const pair: z.infer<typeof pairedDeviceSchema> = {
  homeName: "Fictional home",
  gatewayUrl: "https://library.example.test",
  gatewayFingerprint: "a".repeat(64),
  gatewayCertificate: "invented-certificate-for-storage-test",
  token: "invented-scoped-device-token",
  deviceId: "00000000-0000-4000-8000-000000000001",
  kind: "collector",
  scopes: ["read", "write:*"],
};
function options() {
  return { configDir: directory, service: "dev.omnesis.desktop.fixture", backend: "file" as const };
}

describe("scoped paired-device storage", () => {
  test("encrypts credentials and keeps LAN hint rewrites encrypted in the same namespace", async () => {
    const scope = options();
    await ensureInstallRootKey(scope);
    const path = join(directory, "cloud-relay/collector-device.json");
    await savePairedDeviceFile(path, pair, scope);
    let raw = await readFile(path, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain(pair.token);
    expect(raw).not.toContain(pair.gatewayUrl);
    expect(await readPairedDeviceFile(path, scope)).toEqual(pair);
    const candidates = [{ address: "10.0.0.20", port: 17601 }];
    await saveDirectCandidates(path, pair, candidates, scope);
    raw = await readFile(path, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain(pair.token);
    expect((await readPairedDeviceFile(path, scope)).directCandidates).toEqual(candidates);
  });

  test("another namespace cannot read or rewrite an encrypted pairing", async () => {
    const scope = options();
    await ensureInstallRootKey(scope);
    const path = join(directory, "collector-device.json");
    await savePairedDeviceFile(path, pair, scope);
    const before = await readFile(path, "utf8");
    const other = { ...scope, service: "dev.omnesis.other.fixture" };
    await expect(readPairedDeviceFile(path, other)).rejects.toThrow();
    await expect(saveDirectCandidates(path, pair, [], other)).rejects.toThrow();
    await expect(savePairedDeviceFile(path, pair, other)).rejects.toThrow(/installation key/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("an unavailable key refuses initial publication and never writes a plaintext fallback", async () => {
    const path = join(directory, "collector-device.json");
    await expect(savePairedDeviceFile(path, pair, options())).rejects.toThrow(/installation key/);
    await expect(access(path)).rejects.toThrow();
    const scope = options();
    await ensureInstallRootKey(scope);
    await savePairedDeviceFile(path, pair, scope);
    const before = await readFile(path, "utf8");
    await createSecretStore(scope).delete("install-root-key-v1");
    await expect(savePairedDeviceFile(path, pair, scope)).rejects.toThrow(/installation key/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("validates the pairing before persisting any credential", async () => {
    await ensureInstallRootKey(options());
    const path = join(directory, "invalid.json");
    await expect(
      savePairedDeviceFile(path, { ...pair, deviceId: "invalid" }, options()),
    ).rejects.toThrow();
    await expect(access(path)).rejects.toThrow();
  });

  test("bootstrap discovers an encrypted bundle and token using its supplied environment scope", async () => {
    const scope = options();
    await ensureInstallRootKey(scope);
    const path = join(directory, "cloud-relay/collector-device.json");
    await savePairedDeviceFile(path, pair, scope);
    await writeSecretTextFile(join(directory, "collector-token"), pair.token, scope);
    expect(
      await defaultCloudDeviceFile(
        {
          OMNESIS_CONFIG_DIR: directory,
          OMNESIS_SECRET_SERVICE: scope.service,
          OMNESIS_SECRET_STORE: "file",
        },
        "collector",
      ),
    ).toBe(path);
    expect(
      await defaultCloudDeviceFile(
        {
          OMNESIS_CONFIG_DIR: directory,
          OMNESIS_SECRET_SERVICE: "dev.omnesis.other.fixture",
          OMNESIS_SECRET_STORE: "file",
        },
        "collector",
      ),
    ).toBeUndefined();
  });

  test("bounds decoded credentials and the envelope without echoing their contents", async () => {
    const scope = options();
    await ensureInstallRootKey(scope);
    const path = join(directory, "large.json");
    await expect(savePrivateJson(path, { value: "x".repeat(65_537) }, scope)).rejects.toThrow(
      /too large/,
    );
    await writeSecretTextFile(path, JSON.stringify({ value: "x".repeat(65_537) }), scope);
    await expect(readPrivateJson(path, scope)).rejects.toThrow(/too large/);
    await writeFile(path, "x".repeat(131_073));
    await expect(readPrivateJson(path, scope)).rejects.toThrow(/too large/);
  });

  test("legacy no-options records retain their original plaintext representation", async () => {
    const path = join(directory, "legacy.json");
    await savePrivateJson(path, { token: "invented-legacy-token" });
    expect(await readFile(path, "utf8")).toBe('{"token":"invented-legacy-token"}\n');
    expect(await readPrivateJson(path)).toEqual({ token: "invented-legacy-token" });
  });
});

test("a queued stale hint refresh cannot resurrect credentials a newer pairing publishes", async () => {
  const { withPairedDeviceFileLock } = await import("./paired-device-lock.js");
  const scope = options();
  await ensureInstallRootKey(scope);
  const path = join(directory, "collector-device.json");
  await savePairedDeviceFile(path, pair, scope);
  const replacement = { ...pair, token: "invented-newer-device-token" };
  let refresh: Promise<void> | undefined;
  await withPairedDeviceFileLock(path, async () => {
    refresh = saveDirectCandidates(path, pair, [{ address: "10.0.0.20", port: 17601 }], scope);
    await savePrivateJson(path, replacement, scope);
  });
  await refresh;
  expect(await readPairedDeviceFile(path, scope)).toEqual(replacement);
  expect(await readFile(path, "utf8")).not.toContain(replacement.token);
});

test("a managed device's private signing key stays encrypted and retains its identity", async () => {
  const { readOrCreateDeviceKey } = await import("./device-key-file.js");
  const scope = options();
  await ensureInstallRootKey(scope);
  const path = join(directory, "collector-device.json.key");
  const created = await readOrCreateDeviceKey(path, scope);
  expect((await readOrCreateDeviceKey(path, scope)).publicKey).toBe(created.publicKey);
  const serialized = await readFile(path, "utf8");
  expect(isEncryptedSecretFile(serialized)).toBe(true);
  expect(serialized).not.toContain("PRIVATE KEY");
  await expect(
    readOrCreateDeviceKey(path, { ...scope, service: "dev.omnesis.other.fixture" }),
  ).rejects.toThrow(/installation key/);
  expect(await readFile(path, "utf8")).toBe(serialized);
});

test("concurrent encrypted signing-key creation selects one persistent identity", async () => {
  const { readOrCreateDeviceKey } = await import("./device-key-file.js");
  const scope = options();
  await ensureInstallRootKey(scope);
  const path = join(directory, "collector-device.json.key");
  const keys = await Promise.all(
    Array.from({ length: 3 }, () => readOrCreateDeviceKey(path, scope)),
  );
  expect(new Set(keys.map((key) => key.publicKey)).size).toBe(1);
  expect(isEncryptedSecretFile(await readFile(path, "utf8"))).toBe(true);
});

test("an unjoined credential read is not treated as an absent automatic pairing", async () => {
  const scope = options();
  await ensureInstallRootKey(scope);
  const path = join(directory, "cloud-relay/collector-device.json");
  await savePairedDeviceFile(path, pair, scope);
  const receipt = Object.assign(new Error("Invented private-read cleanup uncertainty"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  const read = vi.spyOn(core, "readSecretTextFile").mockRejectedValueOnce(receipt);
  try {
    await expect(
      defaultCloudDeviceFile(
        {
          OMNESIS_CONFIG_DIR: directory,
          OMNESIS_SECRET_SERVICE: scope.service,
          OMNESIS_SECRET_STORE: "file",
        },
        "collector",
      ),
    ).rejects.toBe(receipt);
  } finally {
    read.mockRestore();
  }
});

test("pairing secret selectors come only from the supplied environment", () => {
  expect(pairedDeviceSecretOptions({})).toBeUndefined();
  expect(() =>
    pairedDeviceSecretOptions({ OMNESIS_SECRET_SERVICE: "invented-scoped-pairing" }),
  ).toThrow("configuration directory");
  expect(pairedDeviceSecretOptions({ OMNESIS_CONFIG_DIR: directory })).toEqual({
    configDir: directory,
    service: core.OMNESIS_SECRET_SERVICE,
    backend: "auto",
  });
  expect(
    pairedDeviceSecretOptions({
      OMNESIS_CONFIG_DIR: directory,
      OMNESIS_SECRET_SERVICE: "invented-explicit-pairing",
      OMNESIS_SECRET_STORE: "file",
    }),
  ).toEqual({ configDir: directory, service: "invented-explicit-pairing", backend: "file" });
  expect(() =>
    pairedDeviceSecretOptions({
      OMNESIS_CONFIG_DIR: directory,
      OMNESIS_SECRET_STORE: "invented-unsupported",
    }),
  ).toThrow("Invalid OMNESIS_SECRET_STORE");
  expect(() =>
    pairedDeviceSecretOptions({
      OMNESIS_CONFIG_DIR: directory,
      OMNESIS_SECRET_SERVICE: "../foreign",
    }),
  ).toThrow("Invalid OMNESIS_SECRET_SERVICE");
});

test("legacy pairing reads validate the full schema without requiring a scoped key", async () => {
  const path = join(directory, "legacy-pairing.json");
  await savePrivateJson(path, pair);
  expect(await readPairedDeviceFile(path)).toEqual(pair);
  await savePrivateJson(path, { ...pair, homeName: "Invented\u0000hidden" });
  await expect(readPairedDeviceFile(path)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8")).homeName).toBe("Invented\u0000hidden");
});
