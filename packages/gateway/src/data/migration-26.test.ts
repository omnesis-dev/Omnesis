// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import { validateSession, deleteSession } from "./repositories/TokenRepository.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("migration 26 — hash portal session secrets", () => {
  test("rekeys existing session rows while preserving active browser cookies", () => {
    const rawSessionId = `legacy-session-${randomUUID()}`;
    const deviceId = randomUUID();
    const tokenId = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES (?, ?, ?, '{}', ?)`,
    ).run(deviceId, "legacy portal", "portal", now);
    db.prepare(
      `INSERT INTO tokens (id, device_id, token_hash, scopes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tokenId, deviceId, "hash-legacy-session", '["admin"]', now);
    db.prepare(
      `INSERT INTO sessions (id, token_id, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(rawSessionId, tokenId, '["admin"]', now, now + 3_600_000);

    db.exec("PRAGMA user_version = 25");
    runMigrations(db);

    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(version).toBe(LATEST_SCHEMA_VERSION);

    const row = db
      .prepare<
        [string],
        { id: string; session_hash: string; last_active_at: number }
      >("SELECT id, session_hash, last_active_at FROM sessions WHERE token_id = ?")
      .get(tokenId);
    expect(row?.id).toBeDefined();
    expect(row?.id).not.toBe(rawSessionId);
    expect(row?.session_hash).toBe(sha256(rawSessionId));
    expect(row?.last_active_at).toBe(now);

    const session = validateSession(db, rawSessionId);
    expect(session?.tokenId).toBe(tokenId);
    expect(session?.scopes).toEqual([SCOPE_ADMIN]);

    deleteSession(db, rawSessionId);
    const count = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sessions").get()!;
    expect(count.c).toBe(0);
  });

  test("migration 27 repairs databases that already recorded the old migration 26", () => {
    const rawSessionId = `legacy-session-${randomUUID()}`;
    const deviceId = randomUUID();
    const tokenId = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES (?, ?, ?, '{}', ?)`,
    ).run(deviceId, "legacy portal", "portal", now);
    db.prepare(
      `INSERT INTO tokens (id, device_id, token_hash, scopes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tokenId, deviceId, "hash-legacy-session", '["admin"]', now);
    db.prepare(
      `INSERT INTO sessions (id, token_id, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(rawSessionId, tokenId, '["admin"]', now, now + 3_600_000);
    db.exec("ALTER TABLE sessions ADD COLUMN last_active_at INTEGER");
    db.prepare("UPDATE sessions SET last_active_at = ?").run(now);
    db.prepare(
      "INSERT INTO schema_migrations (version, description, run_at, duration_ms) VALUES (?, ?, ?, ?)",
    ).run(26, "legacy migration 26", now, 0);
    db.exec("PRAGMA user_version = 26");

    runMigrations(db);

    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(version).toBe(LATEST_SCHEMA_VERSION);

    const row = db
      .prepare<
        [string],
        { id: string; session_hash: string; last_active_at: number }
      >("SELECT id, session_hash, last_active_at FROM sessions WHERE token_id = ?")
      .get(tokenId);
    expect(row?.id).toBeDefined();
    expect(row?.id).not.toBe(rawSessionId);
    expect(row?.session_hash).toBe(sha256(rawSessionId));
    expect(row?.last_active_at).toBe(now);

    const session = validateSession(db, rawSessionId);
    expect(session?.tokenId).toBe(tokenId);
    expect(session?.scopes).toEqual([SCOPE_ADMIN]);
  });
});
