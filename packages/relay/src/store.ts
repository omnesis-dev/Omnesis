// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, timingSafeEqual } from "node:crypto";

import DatabaseConstructor, { type Database } from "better-sqlite3";

import type { RelayPlatform, RelayTarget } from "./types.js";
import type { RelayMetricStoreSnapshot } from "./metrics.js";

export const RELAY_RATE_LIMIT_HOURLY = 30;
export const RELAY_RATE_LIMIT_DAILY = 300;
export const RELAY_RATE_WINDOW_HOUR_MS = 60 * 60_000;
export const RELAY_RATE_WINDOW_DAY_MS = 24 * 60 * 60_000;

interface ChallengeRow {
  id: string;
  platform: string;
  token: string;
  app_id: string;
  environment: string | null;
  nonce_hash: Buffer;
  expires_at: number;
  consumed_at: number | null;
}

interface CredentialRow {
  credential_hash: Buffer;
  platform: string;
  token: string;
  app_id: string;
  environment: string | null;
  created_at: number;
  revoked_at: number | null;
}

export interface StoredChallenge {
  id: string;
  target: RelayTarget;
  nonceHash: Buffer;
  expiresAt: number;
  consumedAt: number | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: "hour" | "day" | null;
  retryAfterMs: number;
}

export class RelayStore {
  readonly db: Database;

  constructor(path: string | Buffer = ":memory:") {
    this.db = new DatabaseConstructor(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createChallenge(input: {
    id: string;
    target: RelayTarget;
    nonceHash: Buffer;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO relay_challenges
           (id, platform, token, app_id, environment, nonce_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.target.platform,
        input.target.token,
        input.target.appId,
        input.target.platform === "ios" ? input.target.environment : null,
        input.nonceHash,
        input.createdAt,
        input.expiresAt,
      );
  }

  tryCreateChallenge(
    input: {
      id: string;
      target: RelayTarget;
      nonceHash: Buffer;
      createdAt: number;
      expiresAt: number;
    },
    maxPending: number,
  ): boolean {
    const create = this.db.transaction(() => {
      this.db.prepare("DELETE FROM relay_challenges WHERE expires_at <= ?").run(input.createdAt);
      const { count } = this.db.prepare("SELECT COUNT(*) AS count FROM relay_challenges").get() as {
        count: number;
      };
      if (count >= maxPending) return false;
      this.createChallenge(input);
      return true;
    });
    return create.immediate();
  }

  hasActiveCredentialForTarget(target: RelayTarget): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM relay_credentials
        WHERE platform = ? AND token = ? AND app_id = ? AND environment IS ?
          AND revoked_at IS NULL LIMIT 1`,
        )
        .get(
          target.platform,
          target.token,
          target.appId,
          target.platform === "ios" ? target.environment : null,
        ) !== undefined
    );
  }

  deleteChallenge(id: string): void {
    this.db.prepare("DELETE FROM relay_challenges WHERE id = ?").run(id);
  }

  challengePlatform(id: string): RelayPlatform | null {
    const row = this.db.prepare("SELECT platform FROM relay_challenges WHERE id = ?").get(id) as
      | { platform: RelayPlatform }
      | undefined;
    return row?.platform ?? null;
  }

  verifyChallengeAndCreateCredential(input: {
    challengeId: string;
    nonceHash: Buffer;
    credentialHash: Buffer;
    now: number;
  }): RelayTarget | null {
    const verify = this.db.transaction((): RelayTarget | null => {
      const row = this.db
        .prepare("SELECT * FROM relay_challenges WHERE id = ?")
        .get(input.challengeId) as ChallengeRow | undefined;
      if (!row || row.consumed_at !== null || row.expires_at <= input.now) return null;
      if (!equalDigest(row.nonce_hash, input.nonceHash)) return null;

      const marked = this.db
        .prepare(
          `UPDATE relay_challenges
             SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(input.now, input.challengeId, input.now);
      if (marked.changes !== 1) return null;

      this.db
        .prepare(
          `INSERT INTO relay_credentials
             (credential_hash, platform, token, app_id, environment, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.credentialHash, row.platform, row.token, row.app_id, row.environment, input.now);

      // A successful possession proof is the commit point for rotation. Keep
      // the new credential active and atomically revoke every older credential
      // for this exact carrier address + app identity. Failed/forged challenges
      // never reach this update, so the existing credential remains usable.
      this.db
        .prepare(
          `UPDATE relay_credentials
              SET revoked_at = ?, token = '', app_id = '', environment = NULL
            WHERE credential_hash <> ?
              AND revoked_at IS NULL
              AND platform = ?
              AND token = ?
              AND app_id = ?
              AND environment IS ?`,
        )
        .run(input.now, input.credentialHash, row.platform, row.token, row.app_id, row.environment);
      return targetFromRow(row);
    });
    return verify.immediate();
  }

  lookupCredential(credentialHash: Buffer): RelayTarget | null {
    const row = this.db
      .prepare(
        `SELECT credential_hash, platform, token, app_id, environment, created_at, revoked_at
           FROM relay_credentials
          WHERE credential_hash = ?`,
      )
      .get(credentialHash) as CredentialRow | undefined;
    if (!row || row.revoked_at !== null || !equalDigest(row.credential_hash, credentialHash)) {
      return null;
    }
    return targetFromRow(row);
  }

  revokeCredential(credentialHash: Buffer, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE relay_credentials
              SET revoked_at = ?, token = '', app_id = '', environment = NULL
            WHERE credential_hash = ? AND revoked_at IS NULL`,
        )
        .run(now, credentialHash).changes === 1
    );
  }

  consumeRateLimit(credentialHash: Buffer, now: number): RateLimitDecision {
    const consume = this.db.transaction((): RateLimitDecision => {
      const dayStart = now - RELAY_RATE_WINDOW_DAY_MS;
      const hourStart = now - RELAY_RATE_WINDOW_HOUR_MS;
      this.db
        .prepare("DELETE FROM relay_rate_events WHERE credential_hash = ? AND occurred_at <= ?")
        .run(credentialHash, dayStart);

      const rows = this.db
        .prepare(
          `SELECT occurred_at
             FROM relay_rate_events
            WHERE credential_hash = ? AND occurred_at > ?
            ORDER BY occurred_at ASC`,
        )
        .all(credentialHash, dayStart) as Array<{ occurred_at: number }>;
      if (rows.length >= RELAY_RATE_LIMIT_DAILY) {
        return {
          allowed: false,
          limit: "day",
          retryAfterMs: Math.max(1, rows[0]!.occurred_at + RELAY_RATE_WINDOW_DAY_MS - now),
        };
      }
      const hourly = rows.filter((row) => row.occurred_at > hourStart);
      if (hourly.length >= RELAY_RATE_LIMIT_HOURLY) {
        return {
          allowed: false,
          limit: "hour",
          retryAfterMs: Math.max(1, hourly[0]!.occurred_at + RELAY_RATE_WINDOW_HOUR_MS - now),
        };
      }
      this.db
        .prepare("INSERT INTO relay_rate_events (credential_hash, occurred_at) VALUES (?, ?)")
        .run(credentialHash, now);
      return { allowed: true, limit: null, retryAfterMs: 0 };
    });
    return consume.immediate();
  }

  prune(now: number): {
    unansweredChallenges: Record<RelayPlatform, number>;
    rateEvents: number;
  } {
    const prune = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT platform, COUNT(*) AS count FROM relay_challenges
            WHERE expires_at <= ? AND consumed_at IS NULL GROUP BY platform`,
        )
        .all(now) as Array<{ platform: RelayPlatform; count: number }>;
      this.db.prepare("DELETE FROM relay_challenges WHERE expires_at <= ?").run(now);
      const rateEvents = this.db
        .prepare("DELETE FROM relay_rate_events WHERE occurred_at <= ?")
        .run(now - RELAY_RATE_WINDOW_DAY_MS).changes;
      return {
        unansweredChallenges: {
          ios: expired.find((row) => row.platform === "ios")?.count ?? 0,
          android: expired.find((row) => row.platform === "android")?.count ?? 0,
        },
        rateEvents,
      };
    });
    return prune.immediate();
  }

  operationalSnapshot(): RelayMetricStoreSnapshot {
    const active = this.db
      .prepare(
        `SELECT platform, COUNT(*) AS count FROM relay_credentials
          WHERE revoked_at IS NULL GROUP BY platform`,
      )
      .all() as Array<{ platform: RelayPlatform; count: number }>;
    return {
      activeCredentials: {
        ios: active.find((row) => row.platform === "ios")?.count ?? 0,
        android: active.find((row) => row.platform === "android")?.count ?? 0,
      },
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_challenges (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
        token TEXT NOT NULL,
        app_id TEXT NOT NULL,
        environment TEXT CHECK (environment IN ('sandbox', 'production') OR environment IS NULL),
        nonce_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS relay_challenges_expiry
        ON relay_challenges(expires_at);

      CREATE TABLE IF NOT EXISTS relay_credentials (
        credential_hash BLOB PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
        token TEXT NOT NULL,
        app_id TEXT NOT NULL,
        environment TEXT CHECK (environment IN ('sandbox', 'production') OR environment IS NULL),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS relay_credentials_active_target
        ON relay_credentials(platform, token, app_id, environment)
        WHERE revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS relay_rate_events (
        credential_hash BLOB NOT NULL REFERENCES relay_credentials(credential_hash) ON DELETE CASCADE,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS relay_rate_events_subject_time
        ON relay_rate_events(credential_hash, occurred_at);
    `);
  }
}

export function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function targetFromRow(row: ChallengeRow | CredentialRow): RelayTarget {
  if (row.platform === "ios") {
    if (row.environment !== "sandbox" && row.environment !== "production") {
      throw new Error("stored iOS relay target has no valid environment");
    }
    return {
      platform: "ios",
      token: row.token,
      appId: row.app_id,
      environment: row.environment,
    };
  }
  if (row.platform === "android") {
    return { platform: "android", token: row.token, appId: row.app_id };
  }
  throw new Error(`stored relay target has unknown platform '${row.platform}'`);
}
