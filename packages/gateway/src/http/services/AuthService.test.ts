// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_READ, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createSession, createToken } from "../../data/repositories/TokenRepository.js";
import { AuthService } from "./AuthService.js";
import type { WriteGate } from "../../write-gate.js";
import type { StatusCache } from "./StatusCache.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  dbPath = `/tmp/omnesis-auth-service-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function makeService(writeGate: Pick<WriteGate, "purgeExpiredSession" | "refreshSessionActivity">) {
  return new AuthService({
    db,
    writeGate: writeGate as WriteGate,
    statusCache: { bump: vi.fn() } as unknown as StatusCache,
    sessionTtlMs: 60_000,
    sessionRefreshThrottleMs: 10_000,
    createOrReplaceDeviceForPair: async () => ({
      device: { id: "device:test" as DeviceId, name: "portal" },
    }),
  });
}

function newSession(scopes: readonly Scope[] = [SCOPE_READ]): string {
  const deviceId = createDevice(db, { name: `device-${randomUUID()}`, kind: "cli" }).id;
  const { id: tokenId } = createToken(db, deviceId, scopes);
  return createSession(db, tokenId as TokenId, scopes);
}

function storedSessionRowId(sessionId: string): string {
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return db
    .prepare<[string], { id: string }>("SELECT id FROM sessions WHERE session_hash = ?")
    .get(sessionHash)!.id;
}

describe("AuthService portal sessions", () => {
  test("login creates sessions with the configured millisecond TTL", async () => {
    const createSession = vi.fn().mockResolvedValue("session:test");
    const service = new AuthService({
      db,
      writeGate: {
        validateToken: vi.fn().mockResolvedValue({
          id: "token:test" as TokenId,
          deviceId: "device:test" as DeviceId,
          scopes: [SCOPE_READ],
        }),
        createSession,
      } as unknown as WriteGate,
      statusCache: { bump: vi.fn() } as unknown as StatusCache,
      sessionTtlMs: 60_000,
      sessionRefreshThrottleMs: 10_000,
      createOrReplaceDeviceForPair: async () => ({
        device: { id: "device:test" as DeviceId, name: "portal" },
      }),
    });

    await expect(service.login("omn_test")).resolves.toEqual({
      ok: true,
      scopes: [SCOPE_READ],
      sessionId: "session:test",
    });
    expect(createSession).toHaveBeenCalledWith("token:test", [SCOPE_READ], 60_000);
  });

  test("getSession enqueues a throttled sliding refresh when due", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const sessionId = newSession();
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
      Date.now() - 11_000,
      storedSessionRowId(sessionId),
    );
    const refreshSessionActivity = vi.fn().mockResolvedValue(true);
    const service = makeService({
      purgeExpiredSession: vi.fn().mockResolvedValue(undefined),
      refreshSessionActivity,
    });

    expect(service.getSession(sessionId)).toEqual({
      authenticated: true,
      scopes: [SCOPE_READ],
      refreshCookie: true,
    });
    expect(refreshSessionActivity).toHaveBeenCalledWith(sessionId, 60_000, 10_000);
  });

  test("getSession skips the writer queue while within the refresh throttle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const sessionId = newSession();
    const refreshSessionActivity = vi.fn().mockResolvedValue(true);
    const service = makeService({
      purgeExpiredSession: vi.fn().mockResolvedValue(undefined),
      refreshSessionActivity,
    });

    expect(service.getSession(sessionId)).toEqual({
      authenticated: true,
      scopes: [SCOPE_READ],
      refreshCookie: false,
    });
    expect(refreshSessionActivity).not.toHaveBeenCalled();
  });

  test("getSession purges but does not refresh expired sessions", () => {
    const sessionId = newSession();
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
      Date.now() - 1_000,
      storedSessionRowId(sessionId),
    );
    const purgeExpiredSession = vi.fn().mockResolvedValue(undefined);
    const refreshSessionActivity = vi.fn().mockResolvedValue(false);
    const service = makeService({ purgeExpiredSession, refreshSessionActivity });

    expect(service.getSession(sessionId)).toEqual({ authenticated: false });
    expect(purgeExpiredSession).toHaveBeenCalledWith(sessionId);
    expect(refreshSessionActivity).not.toHaveBeenCalled();
  });
});
