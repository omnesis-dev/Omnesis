// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import type { NotificationMessage } from "@omnesis/core/push";
import type { DeviceId } from "@omnesis/types";
import type { DurableNotificationPublisher } from "../broadcast.js";

const log = createLogger("gateway:push:needs-auth");

export interface NeedsAuthNotifierOptions {
  publisher: DurableNotificationPublisher;
  reserve: (principal: string, deviceId: DeviceId) => Promise<string | null>;
  retain: (
    reservation: string,
    message: NotificationMessage,
    deviceIds: readonly DeviceId[],
  ) => Promise<readonly DeviceId[] | null>;
  release: (reservation: string) => Promise<void>;
  recover: (principal: string, deviceId: DeviceId, collapsePrefix: string) => Promise<void>;
  /**
   * The display name of the device the operator must sign in on. Consulted
   * only once a reminder is actually due, never on the ticks the backoff
   * gate absorbs.
   */
  deviceName: (deviceId: DeviceId) => string;
}

/**
 * A source's credentials as seen from one member device. Each member holds
 * its own grant, so a reminder is owed — and recovered — per (connection,
 * device), never per connection alone.
 */
export interface NeedsAuthSource {
  sourceId: string;
  providerId?: string;
  /** The member device whose grant lapsed or recovered. */
  deviceId: DeviceId;
}

function reauthPrincipal(source: NeedsAuthSource): string {
  return source.providerId ?? source.sourceId;
}

function episodeKey(principal: string, deviceId: DeviceId): string {
  return `${principal}\u0000${deviceId}`;
}

export class NeedsAuthNotifier {
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: NeedsAuthNotifierOptions) {}

  /** Best-effort: notification failure must never break sync-status ingestion. */
  async notify(source: NeedsAuthSource): Promise<void> {
    const principal = reauthPrincipal(source);
    const key = episodeKey(principal, source.deviceId);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    let reservation: string | null = null;
    try {
      reservation = await this.options.reserve(principal, source.deviceId);
      if (!reservation) {
        log.debug(
          `needs-auth for ${principal} on ${source.deviceId}: within backoff window — skipping reminder`,
        );
        return;
      }
      const deviceName = this.options.deviceName(source.deviceId);
      const message: NotificationMessage = {
        kind: "needs-auth",
        title: "Re-auth needed",
        body: `Sign in again on ${deviceName} to keep ${principal} syncing.`,
        data: {
          sourceId: source.sourceId,
          ...(source.providerId ? { providerId: source.providerId } : {}),
        },
        collapseId: needsAuthCollapseId(principal, source.deviceId),
      };
      const targets = this.options.publisher.retentionDeviceIds();
      if (targets.length === 0) {
        await this.options.release(reservation);
        return;
      }
      const retained = await this.options.retain(reservation, message, targets);
      if (!retained) {
        await this.options.release(reservation);
        return;
      }
      const dispatches = await this.options.publisher.wakeAuthorized(retained);
      log.info(
        `needs-auth reminder for ${principal} on ${source.deviceId}: retained by ${retained.length}, wake accepted by ${dispatches.filter((result) => result.ok).length}/${dispatches.length} device(s)`,
      );
    } catch (error) {
      if (reservation) await this.options.release(reservation).catch(() => undefined);
      log.warn(
        `needs-auth notification for ${source.sourceId} on ${source.deviceId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** The device re-authed the connection: drop its episode and its pending reminders. */
  async reset(source: NeedsAuthSource): Promise<void> {
    const principal = reauthPrincipal(source);
    try {
      await this.options.recover(
        principal,
        source.deviceId,
        needsAuthCollapsePrefix(principal, source.deviceId),
      );
    } catch (error) {
      log.warn(
        `failed to reset needs-auth reminder for ${principal} on ${source.deviceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/** Every reminder about one (connection, device) shares this prefix, so a recovery supersedes only its own. */
export function needsAuthCollapsePrefix(principal: string, deviceId: DeviceId): string {
  return `needs-auth:${digest(principal)}:${digest(deviceId)}:`;
}

export function needsAuthCollapseId(principal: string, deviceId: DeviceId): string {
  return `${needsAuthCollapsePrefix(principal, deviceId)}${digest("active")}`;
}
