// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mobilePermissionCapabilitySchema } from "@omnesis/core/mobile-permission-health";
import {
  aggregateMobilePermissionState,
  isActionableMobilePermissionState,
  type MobilePermissionCapability,
  type MobilePermissionHealth,
  type MobilePermissionHealthReport,
  type MobilePermissionState,
} from "@omnesis/types/mobile-permission-health";
import { DeviceId, SourceId } from "@omnesis/types";
import type { Db } from "../types.js";

export interface MobilePermissionBackoffConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  reservationTtlMs: number;
  maxStaleNotifications?: number;
}

interface StoredRow {
  source_id: string;
  device_id: string;
  checked_at: number;
  received_at: number;
  valid_until: number;
  aggregate_state: MobilePermissionState;
  capabilities_json: string;
  episode_id: string | null;
  episode_reason: "known" | "stale" | null;
  episode_driver_ids_json: string;
  episode_started_at: number | null;
  last_notified_at: number | null;
  notify_count: number;
  reservation_token: string | null;
  reserved_until: number | null;
}

export interface MobilePermissionReportRow {
  sourceId: SourceId;
  deviceId: DeviceId;
  health: MobilePermissionHealth;
}

export interface MobilePermissionReminderReservation {
  token: string;
  episodeId: string;
  sourceId: SourceId;
  deviceId: DeviceId;
  health: MobilePermissionHealth;
  scope: "member" | "source-stale";
}

export function createMobilePermissionHealthTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_permission_health (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      checked_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      validity_anchored INTEGER NOT NULL DEFAULT 1,
      aggregate_state TEXT NOT NULL CHECK (aggregate_state IN (
        'healthy', 'permission-degraded', 'background-access-missing', 'unavailable', 'unknown'
      )),
      capabilities_json TEXT NOT NULL,
      episode_id TEXT,
      episode_reason TEXT CHECK (episode_reason IN ('known', 'stale')),
      episode_driver_ids_json TEXT NOT NULL DEFAULT '[]',
      episode_started_at INTEGER,
      last_notified_at INTEGER,
      notify_count INTEGER NOT NULL DEFAULT 0,
      reservation_token TEXT,
      reserved_until INTEGER,
      PRIMARY KEY (source_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_permission_health_due
      ON mobile_permission_health(valid_until, aggregate_state, last_notified_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_permission_health_device
      ON mobile_permission_health(device_id);
  `);
}

/** Re-key the legacy one-row-per-source table without losing its current report. */
export function rekeyMobilePermissionHealthByDevice(db: Db): void {
  const pk = db
    .prepare<[], { name: string; pk: number }>(
      "SELECT name, pk FROM pragma_table_info('mobile_permission_health') WHERE pk > 0 ORDER BY pk",
    )
    .all()
    .map((column) => column.name);
  if (pk.length === 0) {
    createMobilePermissionHealthTable(db);
    return;
  }
  if (pk.join(",") === "source_id,device_id") {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_mobile_permission_health_device ON mobile_permission_health(device_id)",
    );
    return;
  }
  if (pk.join(",") !== "source_id") {
    throw new Error(`unsupported mobile_permission_health primary key: ${pk.join(",")}`);
  }
  db.exec(`
    CREATE TABLE mobile_permission_health_v156 (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      checked_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      validity_anchored INTEGER NOT NULL DEFAULT 1,
      aggregate_state TEXT NOT NULL CHECK (aggregate_state IN (
        'healthy', 'permission-degraded', 'background-access-missing', 'unavailable', 'unknown'
      )),
      capabilities_json TEXT NOT NULL,
      episode_id TEXT,
      episode_reason TEXT CHECK (episode_reason IN ('known', 'stale')),
      episode_driver_ids_json TEXT NOT NULL DEFAULT '[]',
      episode_started_at INTEGER,
      last_notified_at INTEGER,
      notify_count INTEGER NOT NULL DEFAULT 0,
      reservation_token TEXT,
      reserved_until INTEGER,
      PRIMARY KEY (source_id, device_id)
    );
    INSERT INTO mobile_permission_health_v156 (
      source_id,
      device_id,
      checked_at,
      received_at,
      valid_until,
      validity_anchored,
      aggregate_state,
      capabilities_json,
      episode_id,
      episode_reason,
      episode_driver_ids_json,
      episode_started_at,
      last_notified_at,
      notify_count,
      reservation_token,
      reserved_until
    )
      SELECT
        h.source_id,
        h.device_id,
        h.checked_at,
        h.received_at,
        h.valid_until,
        h.validity_anchored,
        h.aggregate_state,
        h.capabilities_json,
        h.episode_id,
        h.episode_reason,
        h.episode_driver_ids_json,
        h.episode_started_at,
        h.last_notified_at,
        h.notify_count,
        h.reservation_token,
        h.reserved_until
      FROM mobile_permission_health h
      JOIN source_devices m ON m.source_id = h.source_id AND m.device_id = h.device_id
      JOIN devices d ON d.id = h.device_id AND d.revoked_at IS NULL;
    DROP TABLE mobile_permission_health;
    ALTER TABLE mobile_permission_health_v156 RENAME TO mobile_permission_health;
    CREATE INDEX idx_mobile_permission_health_due
      ON mobile_permission_health(valid_until, aggregate_state, last_notified_at);
    CREATE INDEX idx_mobile_permission_health_device
      ON mobile_permission_health(device_id);
  `);
}

export function addMobilePermissionEpisodeIdColumn(db: Db): void {
  const columns = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('mobile_permission_health')",
      )
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("episode_id"))
    db.exec("ALTER TABLE mobile_permission_health ADD COLUMN episode_id TEXT");
}

export function addMobilePermissionEpisodeCauseColumns(db: Db): void {
  const columns = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('mobile_permission_health')",
      )
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("episode_reason"))
    db.exec("ALTER TABLE mobile_permission_health ADD COLUMN episode_reason TEXT");
  if (!columns.has("episode_driver_ids_json"))
    db.exec(
      "ALTER TABLE mobile_permission_health ADD COLUMN episode_driver_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
  const rows = db
    .prepare<
      [],
      { source_id: string; aggregate_state: MobilePermissionState; capabilities_json: string }
    >("SELECT source_id, aggregate_state, capabilities_json FROM mobile_permission_health WHERE episode_id IS NOT NULL AND episode_reason IS NULL")
    .all();
  const update = db.prepare(
    "UPDATE mobile_permission_health SET episode_reason = ?, episode_driver_ids_json = ? WHERE source_id = ?",
  );
  for (const row of rows) {
    const capabilities = parseCapabilities(row.capabilities_json);
    const driverIds = capabilities
      .filter((capability) => isActionableMobilePermissionState(capability.state))
      .map((capability) => capability.id);
    update.run(driverIds.length > 0 ? "known" : "stale", JSON.stringify(driverIds), row.source_id);
  }
}

function parseCapabilities(json: string): MobilePermissionCapability[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value))
    throw new Error("stored mobile permission capabilities are not an array");
  return value.map((capability) => mobilePermissionCapabilitySchema.parse(capability));
}

function effectiveHealth(row: StoredRow, now: number): MobilePermissionHealth {
  const reportStale = now >= row.valid_until;
  return {
    state: reportStale ? "unknown" : row.aggregate_state,
    reportedState: row.aggregate_state,
    checkedAt: row.checked_at,
    receivedAt: row.received_at,
    validUntil: row.valid_until,
    reportStale,
    capabilities: parseCapabilities(row.capabilities_json),
  };
}

function rowToReport(row: StoredRow, now: number): MobilePermissionReportRow {
  return {
    sourceId: SourceId(row.source_id),
    deviceId: DeviceId(row.device_id),
    health: effectiveHealth(row, now),
  };
}

export function getMobilePermissionHealth(
  db: Db,
  sourceId: SourceId,
  now = Date.now(),
  deviceId?: DeviceId,
): MobilePermissionReportRow | null {
  const row = db
    .prepare<[string, string, string], StoredRow>(
      `SELECT * FROM mobile_permission_health
       WHERE source_id = ? AND (? = '' OR device_id = ?)
       ORDER BY device_id LIMIT 1`,
    )
    .get(sourceId, deviceId ?? "", deviceId ?? "");
  return row ? rowToReport(row, now) : null;
}

export function listMobilePermissionHealthForSource(
  db: Db,
  sourceId: SourceId,
  now = Date.now(),
): MobilePermissionReportRow[] {
  return db
    .prepare<[string], StoredRow>(
      "SELECT * FROM mobile_permission_health WHERE source_id = ? ORDER BY device_id",
    )
    .all(sourceId)
    .map((row) => rowToReport(row, now));
}

/**
 * Pick the source-level permission state without letting row order decide it.
 * A fresh member suppresses source-wide staleness; among fresh members the
 * most severe reported state represents the source. Member views still use
 * their exact row.
 */
export function aggregateMobilePermissionHealth(
  rows: readonly MobilePermissionReportRow[],
): MobilePermissionReportRow | undefined {
  if (rows.length === 0) return undefined;
  const fresh = rows.filter((row) => !row.health.reportStale);
  const candidates = fresh.length > 0 ? fresh : rows;
  const priority: Record<MobilePermissionState, number> = {
    unavailable: 4,
    "background-access-missing": 3,
    "permission-degraded": 2,
    unknown: 1,
    healthy: 0,
  };
  return candidates.reduce((selected, row) =>
    priority[row.health.state] > priority[selected.health.state] ? row : selected,
  );
}

export function listMobilePermissionHealth(db: Db, now = Date.now()): MobilePermissionReportRow[] {
  return db
    .prepare<[], StoredRow>("SELECT * FROM mobile_permission_health ORDER BY source_id")
    .all()
    .map((row) => rowToReport(row, now));
}

export function deleteMobilePermissionHealth(
  db: Db,
  sourceId: SourceId,
  deviceId?: DeviceId,
): boolean {
  const result = deviceId
    ? db
        .prepare("DELETE FROM mobile_permission_health WHERE source_id = ? AND device_id = ?")
        .run(sourceId, deviceId)
    : db.prepare("DELETE FROM mobile_permission_health WHERE source_id = ?").run(sourceId);
  return result.changes > 0;
}

export function deleteMobilePermissionHealthForDevice(db: Db, deviceId: DeviceId): SourceId[] {
  const sourceIds = db
    .prepare<[string], { source_id: string }>(
      "SELECT source_id FROM mobile_permission_health WHERE device_id = ?",
    )
    .all(deviceId)
    .map((row) => SourceId(row.source_id));
  db.prepare("DELETE FROM mobile_permission_health WHERE device_id = ?").run(deviceId);
  return sourceIds;
}

export function replaceMobilePermissionHealth(
  db: Db,
  input: {
    sourceId: SourceId;
    deviceId: DeviceId;
    report: MobilePermissionHealthReport;
    receivedAt: number;
  },
): {
  accepted: boolean;
  recovered: boolean;
  recoveredKnown: boolean;
  recoveredStale: boolean;
  health: MobilePermissionHealth;
} {
  return db
    .transaction(() => {
      const existing = db
        .prepare<
          [string, string],
          StoredRow
        >("SELECT * FROM mobile_permission_health WHERE source_id = ? AND device_id = ?")
        .get(input.sourceId, input.deviceId);
      const recoveredStale =
        db
          .prepare<
            [string],
            { found: number }
          >("SELECT 1 AS found FROM mobile_permission_health WHERE source_id = ? AND episode_reason = 'stale' LIMIT 1")
          .get(input.sourceId) !== undefined;
      if (existing && input.report.checkedAt <= existing.checked_at) {
        return {
          accepted: false,
          recovered: false,
          recoveredKnown: false,
          recoveredStale: false,
          health: effectiveHealth(existing, input.receivedAt),
        };
      }

      const aggregate = aggregateMobilePermissionState(input.report.capabilities);
      const actionableIds = input.report.capabilities
        .filter((capability) => isActionableMobilePermissionState(capability.state))
        .map((capability) => capability.id);
      const priorDrivers: string[] = existing
        ? (JSON.parse(existing.episode_driver_ids_json) as unknown[]).filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      const capabilityStates = new Map(
        input.report.capabilities.map((capability) => [capability.id, capability.state]),
      );
      const priorKnownRecovered =
        existing?.episode_reason === "known" &&
        priorDrivers.length > 0 &&
        priorDrivers.every((id) => capabilityStates.get(id) === "healthy");
      // A fresh report is enough to resolve an overdue-report episode. A
      // known permission loss is stricter: every capability that caused it
      // must be explicitly healthy. Missing/unknown drivers preserve it.
      const priorRecovered =
        existing?.episode_id != null &&
        (existing.episode_reason === "stale" || priorKnownRecovered);
      const recoveredKnown = priorKnownRecovered;
      const keepPriorEpisode = existing?.episode_id != null && !priorRecovered;
      const episodeActive = keepPriorEpisode || actionableIds.length > 0;
      const episodeId = episodeActive
        ? keepPriorEpisode
          ? existing!.episode_id
          : randomUUID()
        : null;
      const episodeReason = episodeActive ? "known" : null;
      const episodeDriverIds = episodeActive
        ? keepPriorEpisode
          ? [...new Set([...priorDrivers, ...actionableIds])]
          : actionableIds
        : [];
      const episodeStartedAt = episodeActive
        ? keepPriorEpisode
          ? (existing?.episode_started_at ?? input.receivedAt)
          : input.receivedAt
        : null;
      const validUntil = input.report.checkedAt + input.report.validForMs;
      if (!Number.isSafeInteger(validUntil))
        throw new Error("mobile permission report expiry must be a safe integer");
      db.prepare(
        `INSERT INTO mobile_permission_health (
         source_id, device_id, checked_at, received_at, valid_until, validity_anchored,
         aggregate_state,
         capabilities_json, episode_id, episode_reason, episode_driver_ids_json,
         episode_started_at, last_notified_at, notify_count,
         reservation_token, reserved_until
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL)
       ON CONFLICT(source_id, device_id) DO UPDATE SET
         checked_at = excluded.checked_at,
         received_at = excluded.received_at,
         valid_until = excluded.valid_until,
         validity_anchored = 1,
         aggregate_state = excluded.aggregate_state,
         capabilities_json = excluded.capabilities_json,
         episode_id = excluded.episode_id,
         episode_reason = excluded.episode_reason,
         episode_driver_ids_json = excluded.episode_driver_ids_json,
         episode_started_at = excluded.episode_started_at,
         last_notified_at = CASE WHEN ? THEN mobile_permission_health.last_notified_at ELSE NULL END,
         notify_count = CASE WHEN ? THEN mobile_permission_health.notify_count ELSE 0 END,
         reservation_token = CASE WHEN ? THEN mobile_permission_health.reservation_token ELSE NULL END,
         reserved_until = CASE WHEN ? THEN mobile_permission_health.reserved_until ELSE NULL END`,
      ).run(
        input.sourceId,
        input.deviceId,
        input.report.checkedAt,
        input.receivedAt,
        validUntil,
        aggregate,
        JSON.stringify(input.report.capabilities),
        episodeId,
        episodeReason,
        JSON.stringify(episodeDriverIds),
        episodeStartedAt,
        keepPriorEpisode ? 1 : 0,
        keepPriorEpisode ? 1 : 0,
        keepPriorEpisode ? 1 : 0,
        keepPriorEpisode ? 1 : 0,
      );
      const stored = db
        .prepare<
          [string, string],
          StoredRow
        >("SELECT * FROM mobile_permission_health WHERE source_id = ? AND device_id = ?")
        .get(input.sourceId, input.deviceId)!;
      if (recoveredStale) {
        db.prepare(
          `UPDATE mobile_permission_health
           SET episode_id = NULL, episode_reason = NULL, episode_driver_ids_json = '[]',
               episode_started_at = NULL, last_notified_at = NULL, notify_count = 0,
               reservation_token = NULL, reserved_until = NULL
           WHERE source_id = ? AND device_id <> ? AND episode_reason = 'stale'`,
        ).run(input.sourceId, input.deviceId);
      }
      return {
        accepted: true,
        recovered: priorRecovered || recoveredStale,
        recoveredKnown,
        recoveredStale,
        health: effectiveHealth(stored, input.receivedAt),
      };
    })
    .immediate();
}

function reminderDelayMs(count: number, cfg: MobilePermissionBackoffConfig): number {
  return Math.min(
    cfg.initialDelayMs * Math.pow(cfg.multiplier, Math.max(0, count - 1)),
    cfg.maxDelayMs,
  );
}

/** Atomically reserve one due source so concurrent scans cannot double-publish. */
export function reserveMobilePermissionReminder(
  db: Db,
  sourceId: SourceId,
  now: number,
  cfg: MobilePermissionBackoffConfig,
): MobilePermissionReminderReservation | null {
  return db
    .transaction(() => {
      const rows = db
        .prepare<[string], StoredRow>(
          `SELECT h.* FROM mobile_permission_health h
           JOIN source_devices m
             ON m.source_id = h.source_id AND m.device_id = h.device_id
           JOIN devices d ON d.id = h.device_id AND d.revoked_at IS NULL
           WHERE h.source_id = ?
           ORDER BY h.device_id`,
        )
        .all(sourceId);
      if (rows.length === 0) return null;
      const allMembersQuiet = rows.every((row) => now >= row.valid_until);
      const knownEpisodeMembers = rows.filter(
        (row) => row.episode_id != null && (row.episode_reason ?? "known") === "known",
      );
      const candidates = allMembersQuiet
        ? knownEpisodeMembers.length > 0
          ? knownEpisodeMembers
          : [...rows].sort((a, b) => a.valid_until - b.valid_until).slice(0, 1)
        : rows.filter(
            (row) =>
              now < row.valid_until && isActionableMobilePermissionState(row.aggregate_state),
          );
      const row = candidates.find((candidate) => {
        const prospectiveReason = candidate.episode_id
          ? (candidate.episode_reason ?? "known")
          : allMembersQuiet
            ? "stale"
            : "known";
        if (
          prospectiveReason === "stale" &&
          candidate.notify_count >= (cfg.maxStaleNotifications ?? 4)
        ) {
          return false;
        }
        if (
          candidate.reservation_token &&
          candidate.reserved_until != null &&
          candidate.reserved_until > now
        ) {
          return false;
        }
        return !(
          candidate.notify_count > 0 &&
          candidate.last_notified_at != null &&
          now - candidate.last_notified_at < reminderDelayMs(candidate.notify_count, cfg)
        );
      });
      if (!row) return null;
      const token = randomUUID();
      const episodeId = row.episode_id ?? randomUUID();
      const episodeReason = row.episode_id
        ? (row.episode_reason ?? "known")
        : allMembersQuiet
          ? "stale"
          : "known";
      const driverIds = row.episode_id
        ? row.episode_driver_ids_json
        : JSON.stringify(
            parseCapabilities(row.capabilities_json)
              .filter((capability) => isActionableMobilePermissionState(capability.state))
              .map((capability) => capability.id),
          );
      const updated = db
        .prepare(
          `UPDATE mobile_permission_health
            SET episode_id = ?, episode_reason = ?, episode_driver_ids_json = ?,
                episode_started_at = COALESCE(episode_started_at, ?),
                reservation_token = ?, reserved_until = ?
          WHERE source_id = ?
            AND device_id = ?
            AND (reservation_token IS NULL OR reserved_until <= ?)`,
        )
        .run(
          episodeId,
          episodeReason,
          driverIds,
          now,
          token,
          now + cfg.reservationTtlMs,
          sourceId,
          row.device_id,
          now,
        );
      if (updated.changes !== 1) return null;
      return {
        token,
        episodeId,
        sourceId: SourceId(row.source_id),
        deviceId: DeviceId(row.device_id),
        health: effectiveHealth(row, now),
        scope: episodeReason === "stale" ? ("source-stale" as const) : ("member" as const),
      };
    })
    .immediate();
}

export function commitMobilePermissionReminder(
  db: Db,
  token: string,
  episodeId: string,
  now: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE mobile_permission_health
          SET last_notified_at = ?, notify_count = notify_count + 1,
              reservation_token = NULL, reserved_until = NULL
        WHERE reservation_token = ? AND episode_id = ?`,
    )
    .run(now, token, episodeId);
  return result.changes === 1;
}

export function releaseMobilePermissionReminder(db: Db, token: string, episodeId: string): boolean {
  const result = db
    .prepare(
      `UPDATE mobile_permission_health
          SET reservation_token = NULL, reserved_until = NULL
        WHERE reservation_token = ? AND episode_id = ?`,
    )
    .run(token, episodeId);
  return result.changes === 1;
}
