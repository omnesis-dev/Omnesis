// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "./DeviceRepository.js";
import { createToken, lookupToken, cleanupExpiredTokens } from "./TokenRepository.js";

function testDbPath(): string {
  return `/tmp/omnesis-token-ttl-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("token TTL (#568)", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("createToken with ttlMs stores a future expires_at", () => {
    const dev = createDevice(db, { name: "d", kind: "cli" });
    const { id } = createToken(db, dev.id, [SCOPE_READ], "ttl", { ttlMs: 60_000 });
    const row = db
      .prepare<
        [string],
        { expires_at: number | null }
      >("SELECT expires_at FROM tokens WHERE id = ?")
      .get(id);
    expect(row?.expires_at).toBeGreaterThan(Date.now());
  });

  test("createToken without ttl never expires (expires_at null)", () => {
    const dev = createDevice(db, { name: "d", kind: "cli" });
    const { id, token } = createToken(db, dev.id, [SCOPE_READ], "perm");
    const row = db
      .prepare<
        [string],
        { expires_at: number | null }
      >("SELECT expires_at FROM tokens WHERE id = ?")
      .get(id);
    expect(row?.expires_at).toBeNull();
    expect(lookupToken(db, token)).not.toBeNull();
  });

  test("lookupToken rejects an expired token", () => {
    const dev = createDevice(db, { name: "d", kind: "cli" });
    const { id, token } = createToken(db, dev.id, [SCOPE_READ], "ttl");
    db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);
    expect(lookupToken(db, token)).toBeNull();
  });

  test("cleanupExpiredTokens deletes only expired rows", () => {
    const dev = createDevice(db, { name: "d", kind: "cli" });
    const expired = createToken(db, dev.id, [SCOPE_READ], "expired");
    db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, expired.id);
    const future = createToken(db, dev.id, [SCOPE_READ], "future", { ttlMs: 60_000 });
    const permanent = createToken(db, dev.id, [SCOPE_READ], "perm");

    expect(cleanupExpiredTokens(db)).toBe(1);
    expect(lookupToken(db, expired.token)).toBeNull();
    expect(lookupToken(db, future.token)).not.toBeNull();
    expect(lookupToken(db, permanent.token)).not.toBeNull();
  });
});
