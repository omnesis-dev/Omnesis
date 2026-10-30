// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The connection cache against the real mtcute client, offline: importing and
 * exporting a session touches only storage, so no request leaves the process.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseTelegramClient } from "@mtcute/node";
import { defaultProductionDc, writeStringSession } from "@mtcute/core/utils.js";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  ensureStorageKey,
} from "@omnesis/core";
import { readTelegramStoreKey } from "../../protected-store.js";
import { tempConfigDir } from "../../testing/fixtures.js";
import { MTCUTE_CACHE_FILE, createMtcuteStorage } from "./storage.js";

const HEADER = "SQLite format 3\0";

describe("mtcute connection cache", () => {
  let configDir: string;
  let dir: string;
  const authKey = randomBytes(256);
  const session = writeStringSession({
    version: 3,
    primaryDcs: defaultProductionDc,
    self: { userId: 5550100101, isBot: false, isPremium: false, usernames: [] },
    authKey,
  });

  beforeEach(() => {
    configDir = tempConfigDir("mtcute");
    dir = join(configDir, "telegram", "5550100101");
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function roundTrip(key: Buffer | null): Promise<string> {
    const client = new BaseTelegramClient({
      apiId: 1234567,
      apiHash: "0123456789abcdef0123456789abcdef",
      storage: createMtcuteStorage({ dir, key }),
      updates: false,
    });
    try {
      await client.importSession(session, true);
      return await client.exportSession();
    } finally {
      await client.destroy();
    }
  }

  it("imports and re-exports the session through the encrypted cache", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    await ensureStorageKey("telegram-store", { backend: "file", configDir });
    const key = readTelegramStoreKey(configDir)!;
    await expect(roundTrip(key)).resolves.toBe(session);
    const path = join(dir, MTCUTE_CACHE_FILE);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, HEADER.length).toString()).not.toBe(HEADER);
  });

  it("never writes the auth key into the cache, even unencrypted", async () => {
    await expect(roundTrip(null)).resolves.toBe(session);
    const files = readdirSync(dir).filter((f) => f.startsWith(MTCUTE_CACHE_FILE));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(dir, file)).includes(authKey), file).toBe(false);
    }
  });

  it("quarantines a corrupt cache and rebuilds it from the session string", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MTCUTE_CACHE_FILE), Buffer.alloc(8192, 3));
    await expect(roundTrip(null)).resolves.toBe(session);
    expect(readdirSync(dir).some((f) => f.startsWith(`${MTCUTE_CACHE_FILE}.corrupt-`))).toBe(true);
    // And the rebuilt one is reused on the next start.
    await expect(roundTrip(null)).resolves.toBe(session);
  });
});
