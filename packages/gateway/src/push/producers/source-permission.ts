// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger, parseDuration } from "@omnesis/core";
import { aggregateDrivingMobilePermissionCapability } from "@omnesis/types/mobile-permission-health";
import { getSource } from "../../data/repositories/SourceRepository.js";
import { listMobilePermissionHealth } from "../../data/repositories/MobilePermissionHealthRepository.js";
import { DEFAULT_NOTIFICATION_TTL_MS, type DurableNotificationPublisher } from "../broadcast.js";
import type { NotificationMessage } from "@omnesis/core/push";
import type { MobilePermissionRemindersSettings } from "@omnesis/config";
import type { DeviceId, DeviceRecord, SourceId, SourceType } from "@omnesis/types";
import type { MobilePermissionBackoffConfig } from "../../data/repositories/MobilePermissionHealthRepository.js";
import type { WriteGate } from "../../write-gate.js";
import type { Db } from "../../data/types.js";

const log = createLogger("gateway:push:source-permission");
const DEFAULT_SCAN_INTERVAL = "15m";
const DEFAULT_INITIAL_DELAY = "1d";
const DEFAULT_MAX_DELAY = "7d";
const DEFAULT_RESERVATION_TTL = "5m";
const DEFAULT_MAX_STALE_NOTIFICATIONS = 4;

export interface SourcePermissionReminderConfig extends MobilePermissionBackoffConfig {
  scanIntervalMs: number;
}

export function resolveSourcePermissionReminderConfig(
  settings: MobilePermissionRemindersSettings | undefined,
): SourcePermissionReminderConfig {
  const resolved = {
    initialDelayMs: parseDuration(settings?.initialDelay ?? DEFAULT_INITIAL_DELAY),
    multiplier: settings?.multiplier ?? 2,
    maxDelayMs: parseDuration(settings?.maxDelay ?? DEFAULT_MAX_DELAY),
    reservationTtlMs: parseDuration(settings?.reservationTtl ?? DEFAULT_RESERVATION_TTL),
    maxStaleNotifications: settings?.maxStaleNotifications ?? DEFAULT_MAX_STALE_NOTIFICATIONS,
    scanIntervalMs: parseDuration(settings?.scanInterval ?? DEFAULT_SCAN_INTERVAL),
  };
  if (
    resolved.initialDelayMs <= 0 ||
    resolved.maxDelayMs <= 0 ||
    resolved.reservationTtlMs <= 0 ||
    resolved.scanIntervalMs <= 0 ||
    !Number.isSafeInteger(resolved.maxStaleNotifications) ||
    resolved.maxStaleNotifications <= 0
  )
    throw new Error(
      "mobile permission reminder durations must be greater than zero and counts must be positive integers",
    );
  return resolved;
}

export interface SourcePermissionNotifierOptions {
  db: Db;
  writeGate: Pick<
    WriteGate,
    | "reserveMobilePermissionReminder"
    | "releaseMobilePermissionReminder"
    | "commitMobilePermissionReminderNotification"
  >;
  publisher: DurableNotificationPublisher;
  listDevices: () => readonly DeviceRecord[];
  deviceName: (deviceId: DeviceId) => string;
  sourceName: (sourceId: SourceId, sourceType: SourceType) => string;
  config: SourcePermissionReminderConfig;
  now?: () => number;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function displayName(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clip(normalized || fallback, 256);
}

export class SourcePermissionNotifier {
  private readonly now: () => number;

  constructor(private readonly options: SourcePermissionNotifierOptions) {
    this.now = options.now ?? Date.now;
  }

  async notify(sourceId: SourceId): Promise<boolean> {
    const now = this.now();
    const reservation = await this.options.writeGate.reserveMobilePermissionReminder(
      sourceId,
      now,
      this.options.config,
    );
    if (!reservation) return false;
    try {
      const source = getSource(this.options.db, sourceId);
      const affectedDevice = this.options
        .listDevices()
        .find((device) => device.id === reservation.deviceId);
      const stillMember = this.options.db
        .prepare<
          [string, string],
          { found: number }
        >("SELECT 1 AS found FROM source_devices WHERE source_id = ? AND device_id = ?")
        .get(sourceId, reservation.deviceId);
      if (!source || !source.enabled || !stillMember || affectedDevice?.revokedAt != null) {
        await this.options.writeGate.releaseMobilePermissionReminder(
          reservation.token,
          reservation.episodeId,
        );
        return false;
      }
      const viable = this.options
        .listDevices()
        .filter((device) => device.kind === "ios" || device.kind === "android")
        .filter((device) => device.pushTransport !== null)
        .filter(
          (device) =>
            device.notificationDeliveryHealth === "healthy" ||
            device.notificationDeliveryHealth === "scheduled-summary",
        )
        .map((device) => device.id);
      if (viable.length === 0) {
        await this.options.writeGate.releaseMobilePermissionReminder(
          reservation.token,
          reservation.episodeId,
        );
        return false;
      }
      const capability = aggregateDrivingMobilePermissionCapability(
        reservation.health.capabilities,
      );
      const stale = reservation.scope === "source-stale";
      const sourceName = displayName(
        this.options.sourceName(sourceId, source.type),
        "Mobile source",
      );
      const deviceName = displayName(
        this.options.deviceName(reservation.deviceId),
        "the affected device",
      );
      const title = stale ? "Source check overdue" : "Source permission needs attention";
      const body = stale
        ? clip(
            `No recent ${sourceName} permission check has arrived from any contributing device. Open Omnesis on ${deviceName} or another contributing device to verify background access. If a device no longer contributes this source, remove it from Paired devices.`,
            4096,
          )
        : clip(
            `${sourceName} on ${deviceName} — ${capability?.label ?? "Permission access"}: ${capability?.impact ?? "Data collection is degraded."} ${capability?.remediation ?? "Open Omnesis to repair access."}`,
            4096,
          );
      const message: NotificationMessage = {
        kind: "source-permission",
        title,
        body,
        data: {
          sourceId,
          affectedDeviceId: reservation.deviceId,
          sourceName,
          affectedDeviceName: deviceName,
        },
        collapseId: collapseId(
          sourceId,
          reservation.episodeId,
          reservation.scope === "member" ? reservation.deviceId : undefined,
        ),
      };
      const targets = this.options.publisher.retentionDeviceIds(viable);
      if (targets.length === 0) {
        await this.options.writeGate.releaseMobilePermissionReminder(
          reservation.token,
          reservation.episodeId,
        );
        return false;
      }
      const retained = await this.options.writeGate.commitMobilePermissionReminderNotification(
        reservation.token,
        reservation.episodeId,
        this.now(),
        {
          message,
          deviceIds: targets,
          createdAt: now,
          expiresAt: now + DEFAULT_NOTIFICATION_TTL_MS,
        },
      );
      if (!retained) {
        await this.options.writeGate.releaseMobilePermissionReminder(
          reservation.token,
          reservation.episodeId,
        );
        return false;
      }
      await this.options.publisher.wakeAuthorized(retained.deviceIds);
      return true;
    } catch (error) {
      await this.options.writeGate
        .releaseMobilePermissionReminder(reservation.token, reservation.episodeId)
        .catch(() => undefined);
      log.warn(
        `source permission reminder for ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async scan(): Promise<{ checked: number; notified: number }> {
    const rows = listMobilePermissionHealth(this.options.db, this.now());
    let notified = 0;
    const sourceIds = [...new Set(rows.map((row) => row.sourceId))];
    for (const sourceId of sourceIds) if (await this.notify(sourceId)) notified += 1;
    return { checked: sourceIds.length, notified };
  }
}

function digest(value: string, length = 20): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function collapsePrefix(sourceId: SourceId): string {
  return `source-permission:${digest(sourceId)}:`;
}

export function memberCollapsePrefix(sourceId: SourceId, deviceId: DeviceId): string {
  return `${collapsePrefix(sourceId)}m:${digest(deviceId, 8)}:`;
}

export function staleCollapsePrefix(sourceId: SourceId): string {
  return `${collapsePrefix(sourceId)}stale:`;
}

export function collapseId(sourceId: SourceId, episodeId: string, deviceId?: DeviceId): string {
  const prefix = deviceId
    ? memberCollapsePrefix(sourceId, deviceId)
    : staleCollapsePrefix(sourceId);
  return `${prefix}${digest(episodeId, 12)}`;
}
