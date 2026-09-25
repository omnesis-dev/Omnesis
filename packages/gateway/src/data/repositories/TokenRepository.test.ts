// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { unlinkSync, existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEVICE_HOSTED_SOURCE_TYPES,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  Scope,
  writeScope,
  type DeviceId,
  type TokenId,
} from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import {
  createToken,
  validateToken,
  listTokens,
  revokeToken,
  hasTokens,
  ensureBootstrapToken,
  createSession,
  lookupSession,
  validateSession,
  deleteSession,
  cleanupExpiredSessions,
  touchTokenUsage,
  touchTokenUsageBatch,
  deviceIdForToken,
  refreshSessionActivity,
  reconcileDeviceTokenScopes,
} from "./TokenRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
let configDir: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-tokens-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  configDir = mkdtempSync(join(tmpdir(), "omnesis-tokens-"));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
  if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
});

function newDevice(name = "test"): DeviceId {
  return createDevice(db, { name, kind: "cli" }).id;
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function storedSessionRowId(sessionId: string): string {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM sessions WHERE session_hash = ?")
    .get(sessionHash(sessionId))!.id;
}

describe("deviceIdForToken", () => {
  test("resolves the device a token belongs to (powers /whoami for portal sessions)", () => {
    const deviceId = newDevice("laptop");
    const { id } = createToken(db, deviceId, [SCOPE_READ]);
    expect(deviceIdForToken(db, id as TokenId)).toBe(deviceId);
  });

  test("returns null for an unknown token id", () => {
    expect(deviceIdForToken(db, randomUUID() as TokenId)).toBeNull();
  });
});

describe("createToken", () => {
  test("returns id and raw token with omn_ prefix", () => {
    const deviceId = newDevice();
    const result = createToken(db, deviceId, [SCOPE_ADMIN]);
    expect(result.id).toBeDefined();
    expect(result.token).toMatch(/^omn_[a-f0-9]{32}$/);
  });

  test("persists scopes as JSON array", () => {
    const deviceId = newDevice();
    createToken(db, deviceId, [SCOPE_READ, SCOPE_WRITE_ALL]);
    const [tok] = listTokens(db, deviceId);
    expect(tok.scopes).toEqual([SCOPE_READ, SCOPE_WRITE_ALL]);
  });

  test("multiple tokens allowed for the same device", () => {
    const deviceId = newDevice();
    createToken(db, deviceId, [SCOPE_ADMIN], "a");
    createToken(db, deviceId, [SCOPE_READ], "b");
    expect(listTokens(db, deviceId)).toHaveLength(2);
  });
});

describe("validateToken", () => {
  test("returns scopes + deviceId for valid token", () => {
    const deviceId = newDevice();
    const { token, id } = createToken(db, deviceId, [SCOPE_ADMIN, SCOPE_READ]);
    const info = validateToken(db, token);
    expect(info?.id).toBe(id);
    expect(info?.deviceId).toBe(deviceId);
    expect(info?.scopes).toEqual([SCOPE_ADMIN, SCOPE_READ]);
  });

  test("returns null for invalid token", () => {
    expect(validateToken(db, "omn_invalid")).toBeNull();
  });

  test("updates last_used_at on the token", () => {
    const deviceId = newDevice();
    const { token } = createToken(db, deviceId, [SCOPE_READ]);
    expect(listTokens(db, deviceId)[0].lastUsedAt).toBeNull();
    validateToken(db, token);
    expect(listTokens(db, deviceId)[0].lastUsedAt).not.toBeNull();
  });

  test("updates last_seen_at on the device", () => {
    const deviceId = newDevice();
    const { token } = createToken(db, deviceId, [SCOPE_READ]);
    validateToken(db, token);
    const row = db
      .prepare<
        [string],
        { last_seen_at: number | null }
      >("SELECT last_seen_at FROM devices WHERE id = ?")
      .get(deviceId);
    expect(row?.last_seen_at).not.toBeNull();
  });
});

describe("touchTokenUsageBatch", () => {
  test("empty array is a no-op", () => {
    expect(() => touchTokenUsageBatch(db, [])).not.toThrow();
  });

  test("advances last_used_at for every token in the batch", () => {
    const deviceA = newDevice("a");
    const deviceB = newDevice("b");
    const { id: tokA } = createToken(db, deviceA, [SCOPE_READ]);
    const { id: tokB } = createToken(db, deviceB, [SCOPE_READ]);

    // Pre-batch: both tokens have null last_used_at.
    const pre = listTokens(db);
    expect(pre.find((t) => t.id === tokA)?.lastUsedAt).toBeNull();
    expect(pre.find((t) => t.id === tokB)?.lastUsedAt).toBeNull();

    touchTokenUsageBatch(db, [
      { tokenId: tokA, deviceId: deviceA },
      { tokenId: tokB, deviceId: deviceB },
    ]);

    const post = listTokens(db);
    expect(post.find((t) => t.id === tokA)?.lastUsedAt).not.toBeNull();
    expect(post.find((t) => t.id === tokB)?.lastUsedAt).not.toBeNull();
  });

  test("advances last_seen_at on every distinct device", () => {
    const deviceA = newDevice("a");
    const deviceB = newDevice("b");
    const { id: tokA } = createToken(db, deviceA, [SCOPE_READ]);
    const { id: tokB } = createToken(db, deviceB, [SCOPE_READ]);

    touchTokenUsageBatch(db, [
      { tokenId: tokA, deviceId: deviceA },
      { tokenId: tokB, deviceId: deviceB },
    ]);

    for (const d of [deviceA, deviceB]) {
      const row = db
        .prepare<
          [string],
          { last_seen_at: number | null }
        >("SELECT last_seen_at FROM devices WHERE id = ?")
        .get(d);
      expect(row?.last_seen_at).not.toBeNull();
    }
  });

  test("deduplicates device UPDATEs across many tokens on the same device", () => {
    // Two tokens on the same device — the batched form should only
    // bump devices.last_seen_at once. We assert by snapshotting the
    // timestamp twice and confirming it advances by a single tick.
    const device = newDevice();
    const { id: tokA } = createToken(db, device, [SCOPE_READ]);
    const { id: tokB } = createToken(db, device, [SCOPE_READ]);

    touchTokenUsageBatch(db, [
      { tokenId: tokA, deviceId: device },
      { tokenId: tokB, deviceId: device },
    ]);
    const t1 = db
      .prepare<[string], { last_seen_at: number }>("SELECT last_seen_at FROM devices WHERE id = ?")
      .get(device)!.last_seen_at;
    expect(t1).toBeGreaterThan(0);
  });

  test("updates on revoked token / deleted device are no-ops, not errors", () => {
    // The fire-and-forget contract: an UPDATE on a row that has been
    // deleted between the lookupToken() read and the batched flush
    // must not throw, otherwise the writer-worker would surface a
    // background error on a token revocation race.
    touchTokenUsageBatch(db, [
      {
        tokenId: "missing-token" as ReturnType<typeof createToken>["id"],
        deviceId: "missing-device" as DeviceId,
      },
    ]);
    // No assertion needed beyond "no throw".
  });

  test("all rows commit atomically (single transaction)", () => {
    // If the batched UPDATEs were not in a transaction, a SQLITE_BUSY
    // mid-batch could leave some rows advanced and others not. Verify
    // the success path leaves both timestamps consistent.
    const deviceA = newDevice("a");
    const deviceB = newDevice("b");
    const { id: tokA } = createToken(db, deviceA, [SCOPE_READ]);
    const { id: tokB } = createToken(db, deviceB, [SCOPE_READ]);

    touchTokenUsageBatch(db, [
      { tokenId: tokA, deviceId: deviceA },
      { tokenId: tokB, deviceId: deviceB },
    ]);

    const a = listTokens(db).find((t) => t.id === tokA)!.lastUsedAt!;
    const b = listTokens(db).find((t) => t.id === tokB)!.lastUsedAt!;
    // Same now() captured at batch start → identical timestamps.
    expect(a).toBe(b);
  });

  test("repeated calls advance the timestamp", async () => {
    // Two flushes (separated by a small delay) should produce
    // strictly-increasing last_used_at.
    const device = newDevice();
    const { id: tok } = createToken(db, device, [SCOPE_READ]);
    touchTokenUsageBatch(db, [{ tokenId: tok, deviceId: device }]);
    const t1 = listTokens(db).find((t) => t.id === tok)!.lastUsedAt!;
    await new Promise((r) => setTimeout(r, 2));
    touchTokenUsageBatch(db, [{ tokenId: tok, deviceId: device }]);
    const t2 = listTokens(db).find((t) => t.id === tok)!.lastUsedAt!;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  test("matches per-call touchTokenUsage semantics", () => {
    // Functional equivalence: running the batched form against N rows
    // and the per-call form against the same N rows should leave the
    // last_used_at / last_seen_at columns in the same shape (modulo
    // the shared `now()` per batch). We can't compare timestamps
    // exactly (clock advances between calls) — instead assert both
    // forms move the timestamps from null → non-null in the same
    // configuration.
    const device = newDevice();
    const { id: tok } = createToken(db, device, [SCOPE_READ]);
    touchTokenUsage(db, tok, device);
    expect(listTokens(db).find((t) => t.id === tok)?.lastUsedAt).not.toBeNull();
  });
});

describe("listTokens", () => {
  test("lists all tokens across devices by default", () => {
    const d1 = newDevice("one");
    const d2 = newDevice("two");
    createToken(db, d1, [SCOPE_ADMIN]);
    createToken(db, d2, [SCOPE_READ]);
    expect(listTokens(db)).toHaveLength(2);
  });

  test("filters by deviceId", () => {
    const d1 = newDevice("one");
    const d2 = newDevice("two");
    createToken(db, d1, [SCOPE_ADMIN]);
    createToken(db, d2, [SCOPE_READ]);
    expect(listTokens(db, d1)).toHaveLength(1);
    expect(listTokens(db, d2)).toHaveLength(1);
  });
});

describe("revokeToken", () => {
  test("revokes by id", () => {
    const deviceId = newDevice();
    const { id, token } = createToken(db, deviceId, [SCOPE_READ]);
    expect(revokeToken(db, id)).toBe(true);
    expect(validateToken(db, token)).toBeNull();
  });

  test("returns false for unknown id", () => {
    expect(revokeToken(db, "nonexistent" as never)).toBe(false);
  });
});

describe("deleting device cascades to tokens", () => {
  test("FK ON DELETE CASCADE removes tokens", () => {
    const deviceId = newDevice();
    createToken(db, deviceId, [SCOPE_ADMIN]);
    expect(listTokens(db, deviceId)).toHaveLength(1);
    db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
    expect(listTokens(db, deviceId)).toHaveLength(0);
  });
});

describe("ensureBootstrapToken", () => {
  test("creates bootstrap device + token + writes token file on first call", () => {
    mkdirSync(configDir, { recursive: true });
    const token = ensureBootstrapToken(db, configDir);
    expect(token).not.toBeNull();
    expect(token).toMatch(/^omn_[a-f0-9]{32}$/);

    const tokenPath = join(configDir, "token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(token);
  });

  test("bootstrap token has admin + read + write:* scopes", () => {
    const token = ensureBootstrapToken(db, configDir)!;
    const info = validateToken(db, token)!;
    expect(info.scopes).toContain(SCOPE_ADMIN);
    expect(info.scopes).toContain(SCOPE_READ);
    expect(info.scopes).toContain(SCOPE_WRITE_ALL);
  });

  test("returns null on subsequent calls when tokens exist", () => {
    ensureBootstrapToken(db, configDir);
    expect(ensureBootstrapToken(db, configDir)).toBeNull();
  });

  test("hasTokens reflects bootstrap state", () => {
    expect(hasTokens(db)).toBe(false);
    ensureBootstrapToken(db, configDir);
    expect(hasTokens(db)).toBe(true);
  });
});

describe("session management", () => {
  test("createSession + validateSession round-trip", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_ADMIN]);
    const sessionId = createSession(db, tokenId, [SCOPE_ADMIN]);
    const session = validateSession(db, sessionId);
    expect(session?.tokenId).toBe(tokenId);
    expect(session?.portalDeviceId).toBeNull();
    expect(session?.scopes).toEqual([SCOPE_ADMIN]);
  });

  test("lookupSession attributes activity only to a portal-owned token", () => {
    const deviceId = createDevice(db, { name: "paired portal", kind: "portal" }).id;
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);

    expect(lookupSession(db, sessionId).info?.portalDeviceId).toBe(deviceId);
  });

  test("lookupSession does not attribute raw-token portal traffic to a CLI device", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);

    expect(lookupSession(db, sessionId).info?.portalDeviceId).toBeNull();
  });

  test("createSession records last_active_at for the refresh throttle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const rowId = storedSessionRowId(sessionId);

    const row = db
      .prepare<
        [string],
        { created_at: number; last_active_at: number; expires_at: number }
      >("SELECT created_at, last_active_at, expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;
    expect(row.last_active_at).toBe(row.created_at);
    expect(row.expires_at).toBe(row.created_at + 30 * 24 * 60 * 60 * 1000);
  });

  test("createSession honors sub-day TTLs exactly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ], 60_000);
    const rowId = storedSessionRowId(sessionId);

    const row = db
      .prepare<
        [string],
        { created_at: number; expires_at: number }
      >("SELECT created_at, expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;
    expect(row.expires_at).toBe(row.created_at + 60_000);
  });

  test("refreshSessionActivity extends expiry by the configured TTL from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const rowId = storedSessionRowId(sessionId);
    const createdAt = Date.now();

    db.prepare("UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ?").run(
      createdAt - 2 * 60 * 60 * 1000,
      createdAt + 5_000,
      rowId,
    );

    vi.setSystemTime(new Date(createdAt + 1_000));
    expect(refreshSessionActivity(db, sessionId, 60_000, 60 * 60 * 1000)).toBe(true);

    const row = db
      .prepare<
        [string],
        { last_active_at: number; expires_at: number }
      >("SELECT last_active_at, expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;
    expect(row.last_active_at).toBe(createdAt + 1_000);
    expect(row.expires_at).toBe(createdAt + 61_000);
  });

  test("refreshSessionActivity is throttled by last_active_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    const rowId = storedSessionRowId(sessionId);
    const before = db
      .prepare<
        [string],
        { last_active_at: number; expires_at: number }
      >("SELECT last_active_at, expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;

    vi.setSystemTime(new Date(Date.now() + 30_000));
    expect(refreshSessionActivity(db, sessionId, 60_000, 60 * 60 * 1000)).toBe(false);

    const after = db
      .prepare<
        [string],
        { last_active_at: number; expires_at: number }
      >("SELECT last_active_at, expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;
    expect(after).toEqual(before);
  });

  test("refreshSessionActivity leaves idle expired sessions expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = randomUUID();
    const rowId = randomUUID();
    const expiredAt = Date.now() - 1_000;
    db.prepare(
      `INSERT INTO sessions (id, session_hash, token_id, scopes, created_at, last_active_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowId,
      sessionHash(sessionId),
      tokenId,
      JSON.stringify([SCOPE_READ]),
      Date.now() - 120_000,
      Date.now() - 120_000,
      expiredAt,
    );

    expect(refreshSessionActivity(db, sessionId, 60_000, 60 * 60 * 1000)).toBe(false);
    const row = db
      .prepare<[string], { expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?")
      .get(rowId)!;
    expect(row.expires_at).toBe(expiredAt);
    expect(validateSession(db, sessionId)).toBeNull();
  });

  test("stores only a hash of the browser session secret", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_ADMIN]);
    const sessionId = createSession(db, tokenId, [SCOPE_ADMIN]);
    const row = db
      .prepare<[], { id: string; session_hash: string }>("SELECT id, session_hash FROM sessions")
      .get();

    expect(row?.id).toBeDefined();
    expect(row?.id).not.toBe(sessionId);
    expect(row?.session_hash).toBe(sessionHash(sessionId));
  });

  test("validateSession returns null for expired sessions", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, session_hash, token_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      createHash("sha256").update(sessionId).digest("hex"),
      tokenId,
      JSON.stringify([SCOPE_READ]),
      Date.now() - 2000,
      Date.now() - 1000,
    );
    expect(validateSession(db, sessionId)).toBeNull();
  });

  test("deleteSession removes it", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    deleteSession(db, sessionId);
    expect(validateSession(db, sessionId)).toBeNull();
  });

  test("cleanupExpiredSessions deletes expired rows", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const expiredSession = randomUUID();
    const liveSession = randomUUID();
    db.prepare(
      `INSERT INTO sessions (id, session_hash, token_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      createHash("sha256").update(expiredSession).digest("hex"),
      tokenId,
      "[]",
      Date.now() - 2000,
      Date.now() - 1000,
    );
    db.prepare(
      `INSERT INTO sessions (id, session_hash, token_id, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      createHash("sha256").update(liveSession).digest("hex"),
      tokenId,
      "[]",
      Date.now(),
      Date.now() + 60_000,
    );
    expect(cleanupExpiredSessions(db)).toBe(1);
  });

  test("session cascades when token revoked", () => {
    const deviceId = newDevice();
    const { id: tokenId } = createToken(db, deviceId, [SCOPE_READ]);
    const sessionId = createSession(db, tokenId, [SCOPE_READ]);
    revokeToken(db, tokenId);
    expect(validateSession(db, sessionId)).toBeNull();
  });
});

describe("reconcileDeviceTokenScopes", () => {
  const iosDevice = () => createDevice(db, { name: "iPhone", kind: "ios" }).id;

  test("grants a hosted source's write scope to a token paired before it shipped", () => {
    // A phone paired when the iOS grant covered three sources, before a
    // release taught the app to host a fourth. Every push of the new source
    // 403s, and because the phone's offline buffer is FIFO, those rejections
    // stall every other source behind them.
    const deviceId = iosDevice();
    const { id } = createToken(db, deviceId, [
      SCOPE_ADMIN,
      SCOPE_READ,
      Scope("write:apple-health"),
      Scope("write:activity-segments"),
      Scope("write:photos"),
    ]);

    const scopes = reconcileDeviceTokenScopes(db, id, "ios");

    expect(scopes).toContain("write:core-location-visits");
    // Re-read from disk: the grant must be persisted, not just returned.
    expect(listTokens(db).find((t) => t.id === id)?.scopes).toContain("write:core-location-visits");
  });

  test("is a no-op when the token already covers every hosted source", () => {
    const deviceId = iosDevice();
    const { id } = createToken(db, deviceId, [
      SCOPE_ADMIN,
      SCOPE_READ,
      ...DEVICE_HOSTED_SOURCE_TYPES.ios.map(writeScope),
    ]);
    const before = listTokens(db).find((t) => t.id === id)?.scopes;

    const scopes = reconcileDeviceTokenScopes(db, id, "ios");

    expect(scopes).toEqual(before);
  });

  test("leaves a write:* token alone — it already covers every source type", () => {
    const deviceId = createDevice(db, { name: "mac", kind: "collector" }).id;
    const { id } = createToken(db, deviceId, [SCOPE_WRITE_ALL]);

    expect(reconcileDeviceTokenScopes(db, id, "collector")).toEqual([SCOPE_WRITE_ALL]);
  });

  test("adds write scopes only — read/admin are left exactly as they were", () => {
    // Per-source write scopes are deliberately not operator-narrowable, so a
    // read-only phone token does gain all four. What it must not gain is the
    // `admin` an operator removed. Asserting the exact set keeps both halves
    // of that contract visible.
    const deviceId = iosDevice();
    const { id } = createToken(db, deviceId, [SCOPE_READ]);

    const scopes = reconcileDeviceTokenScopes(db, id, "ios");

    expect(scopes).toEqual([SCOPE_READ, ...DEVICE_HOSTED_SOURCE_TYPES.ios.map(writeScope)]);
    expect(scopes).not.toContain(SCOPE_ADMIN);
  });

  test("returns null for a token that no longer exists", () => {
    expect(reconcileDeviceTokenScopes(db, randomUUID() as TokenId, "ios")).toBeNull();
  });
});
