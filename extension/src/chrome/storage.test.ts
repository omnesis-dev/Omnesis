// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_ID_KEY,
  PAIRING_KEY,
  PROFILE_LABEL_KEY,
  TOKEN_KEY,
  getOrCreateInstallId,
  CAPTURE_PERMISSION_STATE_KEY,
  clearConfig,
  CONFIG_KEY,
  loadCapturePermissionState,
  loadConfig,
  loadPairing,
  loadProfileLabel,
  migrateLegacyConfig,
  saveConfig,
  saveGatewayVersion,
  saveProfileLabel,
} from "./storage.js";

/** A `chrome.storage.local` double that honours single and multi-key reads. */
function installStorageFake(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Promise.resolve(
            Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
          );
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(store, items);
          return Promise.resolve();
        },
        remove: (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) delete store[k];
          return Promise.resolve();
        },
      },
    },
  };
  return store;
}

const paired = {
  gatewayUrl: "https://gateway.example.com",
  token: "token",
  scopes: ["write:web"],
  deviceId: "device",
  pairedAt: 1,
};

describe("browser pairing storage", () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = installStorageFake();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("persists a trimmed profile label across unpair", async () => {
    await saveProfileLabel("  Personal  ");
    expect(await loadProfileLabel()).toBe("Personal");
    expect(store[PROFILE_LABEL_KEY]).toBe("Personal");

    await clearConfig();
    expect(await loadProfileLabel()).toBe("Personal");
  });

  it("treats absent or invalid profile labels as incomplete setup", async () => {
    expect(await loadProfileLabel()).toBeNull();
    store[PROFILE_LABEL_KEY] = "";
    expect(await loadProfileLabel()).toBeNull();
    store[PROFILE_LABEL_KEY] = "x".repeat(121);
    expect(await loadProfileLabel()).toBeNull();
  });

  it("stores the token under its own key, apart from the pairing record", async () => {
    await saveConfig(paired);
    expect(store[TOKEN_KEY]).toBe("token");
    expect(JSON.parse(String(store[PAIRING_KEY]))).toEqual({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device",
      pairedAt: 1,
    });
    expect(store[CONFIG_KEY]).toBeUndefined();
    expect(await loadConfig()).toEqual(paired);
  });

  it("hands the content script a pairing with no token in it", async () => {
    await saveConfig(paired);
    const pairing = await loadPairing();
    expect(pairing).toEqual({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device",
      pairedAt: 1,
    });
    expect(pairing).not.toHaveProperty("token");
  });

  it("reads as unpaired when only one half of the pairing is present", async () => {
    store[PAIRING_KEY] = JSON.stringify({ ...paired, token: undefined });
    expect(await loadConfig()).toBeNull();
    delete store[PAIRING_KEY];
    store[TOKEN_KEY] = "token";
    expect(await loadConfig()).toBeNull();
    expect(await loadPairing()).toBeNull();
  });

  it("stores pairing without overwriting the independently ordered permission state", async () => {
    store[CAPTURE_PERMISSION_STATE_KEY] = true;
    await saveConfig(paired);
    expect(await loadConfig()).toMatchObject({ deviceId: "device" });
    expect(await loadCapturePermissionState()).toBe(true);
    expect(store[CAPTURE_PERMISSION_STATE_KEY]).toBe(true);
  });

  it("clears both halves and any legacy record on unpair", async () => {
    await saveConfig(paired);
    store[CONFIG_KEY] = JSON.stringify(paired);
    await clearConfig();
    expect(store[PAIRING_KEY]).toBeUndefined();
    expect(store[TOKEN_KEY]).toBeUndefined();
    expect(store[CONFIG_KEY]).toBeUndefined();
  });

  describe("installs paired before the token had its own key", () => {
    it("still read as paired by the worker, and as unpaired by the content script, until migrated", async () => {
      store[CONFIG_KEY] = JSON.stringify(paired);
      // The worker keeps working from the legacy record so nothing is lost…
      expect(await loadConfig()).toEqual(paired);
      // …while the content script, which never reads the legacy record (it
      // holds the token), waits for the migration's storage change.
      expect(await loadPairing()).toBeNull();
    });

    it("are split into the two keys, then the legacy record is removed", async () => {
      store[CONFIG_KEY] = JSON.stringify(paired);
      expect(await migrateLegacyConfig()).toBe(true);
      expect(store[TOKEN_KEY]).toBe("token");
      expect(JSON.parse(String(store[PAIRING_KEY]))).not.toHaveProperty("token");
      expect(store[CONFIG_KEY]).toBeUndefined();
      expect(await loadConfig()).toEqual(paired);
      // A second run has nothing to do.
      expect(await migrateLegacyConfig()).toBe(false);
    });

    it("never overwrites a newer split pairing with a stale legacy record", async () => {
      await saveConfig({ ...paired, token: "fresh-token", deviceId: "device-new" });
      store[CONFIG_KEY] = JSON.stringify(paired);
      await migrateLegacyConfig();
      expect(store[TOKEN_KEY]).toBe("fresh-token");
      expect(JSON.parse(String(store[PAIRING_KEY]))).toMatchObject({ deviceId: "device-new" });
      expect(store[CONFIG_KEY]).toBeUndefined();
    });
  });

  describe("saveGatewayVersion", () => {
    it("records a changed version beside the pairing without touching the token", async () => {
      await saveConfig(paired);
      expect(await saveGatewayVersion(paired.gatewayUrl, "0.4.6")).toBe(true);
      expect(await loadConfig()).toEqual({ ...paired, gatewayVersion: "0.4.6" });
      expect(store[TOKEN_KEY]).toBe("token");
    });

    it("is a no-op when unpaired, unchanged, or read from another gateway", async () => {
      expect(await saveGatewayVersion(paired.gatewayUrl, "0.4.6")).toBe(false);
      await saveConfig({ ...paired, gatewayVersion: "0.4.6" });
      expect(await saveGatewayVersion(paired.gatewayUrl, "0.4.6")).toBe(false);
      // A re-pair to another gateway between the health check and this write
      // must not stamp the old gateway's version onto the new pairing.
      expect(await saveGatewayVersion("https://other.example.com", "9.9.9")).toBe(false);
      expect(await loadPairing()).toMatchObject({ gatewayVersion: "0.4.6" });
    });

    it("refuses a version string that would bloat the pairing record", async () => {
      await saveConfig(paired);
      expect(await saveGatewayVersion(paired.gatewayUrl, "1.0.0-" + "x".repeat(200))).toBe(false);
      expect(await loadPairing()).not.toHaveProperty("gatewayVersion");
    });
  });

  it("treats malformed or structurally invalid pairing state as unpaired", async () => {
    store[CONFIG_KEY] = "not-json";
    expect(await loadConfig()).toBeNull();
    store[CONFIG_KEY] = JSON.stringify({ gatewayUrl: "javascript:alert(1)", token: "x" });
    expect(await loadConfig()).toBeNull();
    store[PAIRING_KEY] = "not-json";
    store[TOKEN_KEY] = "token";
    expect(await loadConfig()).toBeNull();
    expect(await loadPairing()).toBeNull();
  });

  it.each([
    "https://gateway.example.com/",
    "https://gateway.example.com/portal",
    "https://gateway.example.com?mode=test",
    "https://gateway.example.com#fragment",
    "https://user:password@gateway.example.com",
    "https://203.0.113.7:7600",
  ])("rejects a non-canonical stored gateway origin: %s", async (gatewayUrl) => {
    store[PAIRING_KEY] = JSON.stringify({ ...paired, token: undefined, gatewayUrl });
    store[TOKEN_KEY] = "token";
    expect(await loadConfig()).toBeNull();
    expect(await loadPairing()).toBeNull();
  });

  it("loads legacy scope metadata so the popup can explain that re-pairing is required", async () => {
    for (const scopes of [["write:*"], ["write:web", "read"], []]) {
      store[PAIRING_KEY] = JSON.stringify({ ...paired, token: undefined, scopes });
      store[TOKEN_KEY] = "token";
      expect(await loadConfig()).toMatchObject({ scopes });
    }
  });
});

describe("getOrCreateInstallId", () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = installStorageFake();
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("mints a UUID once and returns the same identity afterwards", async () => {
    const first = await getOrCreateInstallId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(store[INSTALL_ID_KEY]).toBe(first);
    expect(await getOrCreateInstallId()).toBe(first);
  });

  it("a fresh install mints a different identity", async () => {
    const a = await getOrCreateInstallId();
    for (const k of Object.keys(store)) delete store[k];
    expect(await getOrCreateInstallId()).not.toBe(a);
  });

  it("concurrent first calls share one mint", async () => {
    const [a, b] = await Promise.all([getOrCreateInstallId(), getOrCreateInstallId()]);
    expect(a).toBe(b);
    expect(store[INSTALL_ID_KEY]).toBe(a);
  });

  it("survives unpair — clearConfig() does not reset the identity", async () => {
    const first = await getOrCreateInstallId();
    await clearConfig();
    expect(await getOrCreateInstallId()).toBe(first);
  });
});
