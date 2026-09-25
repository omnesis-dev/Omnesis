// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import { resolveStorageEncryptionReadiness } from "./storage-readiness.js";
import {
  inspectStorageKey,
  markStorageEncryptionRequired,
  storageEncryptionRequired,
  storageKeyNamesForHost,
} from "./storage-keys.js";

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
  const dir = mkdtempSync(join(tmpdir(), "omnesis-storage-readiness-"));
  dirs.push(dir);
  return dir;
}

describe("storageKeyNamesForHost", () => {
  test("splits the registry between the gateway and the collector with nothing left over", () => {
    const gateway = storageKeyNamesForHost("gateway");
    const collector = storageKeyNamesForHost("collector");
    expect([...gateway]).toEqual(["main-db", "index-db", "analytics-db", "watch2-db"]);
    expect([...collector]).toEqual(["whatsapp-store", "imessage-transcripts"]);
  });
});

describe("resolveStorageEncryptionReadiness", () => {
  test("mints only the requested key set and reports what it created", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    const first = await resolveStorageEncryptionReadiness(dir, ["whatsapp-store"]);
    expect(first).toEqual({ enabled: true, created: ["whatsapp-store"] });
    expect(storageEncryptionRequired(dir)).toBe(true);
    await expect(inspectStorageKey("main-db", { configDir: dir })).resolves.toMatchObject({
      present: false,
    });

    // A second process on the same host, with a wider set, creates only the
    // keys that set adds; the existing key is left untouched.
    const second = await resolveStorageEncryptionReadiness(dir, ["whatsapp-store", "main-db"]);
    expect(second).toEqual({ enabled: true, created: ["main-db"] });
  });

  test("an unarmed install without a root key runs plaintext", async () => {
    const dir = tempConfigDir();
    await expect(resolveStorageEncryptionReadiness(dir, ["whatsapp-store"])).resolves.toEqual({
      enabled: false,
      created: [],
    });
  });

  test("an armed marker without a root key refuses", async () => {
    const dir = tempConfigDir();
    await markStorageEncryptionRequired(dir);
    await expect(resolveStorageEncryptionReadiness(dir, ["whatsapp-store"])).rejects.toThrow(
      /encryption is required, but the install root key is unavailable/u,
    );
  });

  test("a wrapped key on disk counts as armed even when the marker is gone", async () => {
    const dir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    await resolveStorageEncryptionReadiness(dir, ["whatsapp-store"]);
    // The marker and the root key are gone; the wrapped key survives. The
    // file store keeps its entries under keyring/dev.omnesis/, named by the
    // base64url of the entry name.
    rmSync(join(dir, "keyring", "storage-encryption-required"), { force: true });
    const storeDir = join(dir, "keyring", "dev.omnesis");
    const rootKeyEntry = readdirSync(storeDir).find((f) =>
      Buffer.from(f.replace(/\.secret$/u, ""), "base64url")
        .toString("utf8")
        .includes("install-root-key"),
    );
    if (!rootKeyEntry) throw new Error("expected a root key entry in the file store");
    rmSync(join(storeDir, rootKeyEntry));
    await expect(resolveStorageEncryptionReadiness(dir, ["whatsapp-store"])).rejects.toThrow(
      /root key is unavailable/u,
    );
  });
});
