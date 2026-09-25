// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { createLogger } from "@omnesis/core";

import { DEFAULT_PUSH_RELAY_URL, type OmnesisConfig } from "@omnesis/config";
import { getDevice, listDevices } from "../../data/repositories/DeviceRepository.js";
import { selectPushTransport } from "../../push/select-transport.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { PushTransport } from "../../watch/push-transport.js";
import type { DeviceId, DeviceRecord, NotificationDeliveryHealth } from "@omnesis/types";
import type { PushPlan } from "@omnesis/core/push";
import type { WriteGate } from "../../write-gate.js";

type GatewaySettings = NonNullable<OmnesisConfig["gateway"]>;

const log = createLogger("gateway:http").child("push-admin");

export interface PushCredentialImport {
  platform: "ios" | "android";
  sourcePath: string;
}

export interface PushAdminServiceDeps {
  db: import("better-sqlite3").Database;
  pushTransport: PushTransport;
  getSettings: () => Pick<GatewaySettings, "apns" | "fcm"> | undefined;
  getRelaySettings?: () => { enabled: boolean; url: string; visible?: boolean };
  /** The app-bound plan a phone would get today; null for a phone that never announced its app. */
  planForDevice?: (device: DeviceRecord) => PushPlan | null;
  writeGate: Pick<WriteGate, "setDeviceNotificationDeliveryHealth">;
  onDeviceChanged?: () => void;
  configDir?: string;
}

interface DeliveryLedgerRow {
  device_id: string;
  pending: number;
  leased: number;
  delivered: number;
  superseded: number;
  expired: number;
  last_claimed_at: number | null;
  last_delivered_at: number | null;
  wake_pending: number;
  wake_leased: number;
  wake_sent: number;
  wake_terminal: number;
  wake_exhausted: number;
  wake_attempts: number;
  wake_last_attempt_at: number | null;
  wake_last_success_at: number | null;
  wake_last_state: string | null;
  wake_last_error: string | null;
  wake_last_transport: string | null;
}

/** Host-side push administration. Routes only validate and map its results. */
export class PushAdminService {
  constructor(private readonly deps: PushAdminServiceDeps) {}

  status() {
    const settings = this.deps.getSettings();
    const relay = this.deps.getRelaySettings?.() ?? {
      enabled: false,
      url: DEFAULT_PUSH_RELAY_URL,
      visible: false,
    };
    const devices = listDevices(this.deps.db).filter(
      (device) => (device.kind === "ios" || device.kind === "android") && !device.revokedAt,
    );
    const relayConsented = devices.filter(
      (device) => device.relayConsent !== null && device.relayConsent !== undefined,
    ).length;
    const availability = new Map(
      devices.map((device) => [device.id, this.deps.pushTransport.isDeviceAvailable(device)]),
    );
    // Why a phone has no transport, kept apart so the operator is not sent to
    // the wrong fix: the app-bound plan says whether the app can be served at
    // all (consent missing, identity unsupported, no relay endpoint); when it
    // can, an unavailable phone is a registration the app has to redo.
    const explain = (
      device: DeviceRecord,
    ): { plan: PushPlan | null; unavailableReason?: string } => {
      const plan = this.deps.planForDevice?.(device) ?? null;
      if (availability.get(device.id) || plan?.transport === "unavailable") return { plan };
      const selected = selectPushTransport(device, { socketConnected: false, relayUrl: relay.url });
      return selected.transport === "unavailable"
        ? { plan, unavailableReason: selected.reason }
        : { plan };
    };
    const queueByDevice = new Map(
      this.deps.db
        .prepare<[], DeliveryLedgerRow>(
          `SELECT device_id,
                    SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN state = 'leased' THEN 1 ELSE 0 END) AS leased,
                    SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                    SUM(CASE WHEN state = 'superseded' THEN 1 ELSE 0 END) AS superseded,
                    SUM(CASE WHEN state = 'expired' THEN 1 ELSE 0 END) AS expired,
                    MAX(claimed_at) AS last_claimed_at,
                    MAX(delivered_at) AS last_delivered_at,
                    SUM(CASE WHEN wake_state = 'pending' THEN 1 ELSE 0 END) AS wake_pending,
                    SUM(CASE WHEN wake_state = 'leased' THEN 1 ELSE 0 END) AS wake_leased,
                    SUM(CASE WHEN wake_state = 'sent' THEN 1 ELSE 0 END) AS wake_sent,
                    SUM(CASE WHEN wake_state = 'terminal' THEN 1 ELSE 0 END) AS wake_terminal,
                    SUM(CASE WHEN wake_state = 'exhausted' THEN 1 ELSE 0 END) AS wake_exhausted,
                    SUM(wake_attempt_count) AS wake_attempts,
                    MAX(wake_last_attempt_at) AS wake_last_attempt_at,
                    MAX(wake_last_success_at) AS wake_last_success_at,
                    (SELECT d2.wake_state
                       FROM notification_deliveries d2
                      WHERE d2.device_id = notification_deliveries.device_id
                      ORDER BY COALESCE(d2.wake_last_attempt_at, -1) DESC, d2.rowid DESC
                      LIMIT 1) AS wake_last_state,
                    (SELECT d2.wake_last_error
                       FROM notification_deliveries d2
                      WHERE d2.device_id = notification_deliveries.device_id
                      ORDER BY COALESCE(d2.wake_last_attempt_at, -1) DESC, d2.rowid DESC
                      LIMIT 1) AS wake_last_error,
                    (SELECT d2.wake_last_transport
                       FROM notification_deliveries d2
                      WHERE d2.device_id = notification_deliveries.device_id
                      ORDER BY COALESCE(d2.wake_last_attempt_at, -1) DESC, d2.rowid DESC
                      LIMIT 1) AS wake_last_transport
               FROM notification_deliveries
              GROUP BY device_id`,
        )
        .all()
        .map((row) => [row.device_id, row] as const),
    );
    return {
      configured: {
        apns: !!settings?.apns,
        fcm: !!settings?.fcm,
        // Deprecated global-shaped field: report whether any active phone has
        // granted the authorization that now controls relay use.
        ...(relay.visible ? { relay: relayConsented > 0 } : {}),
      },
      settings: {
        apns: settings?.apns
          ? {
              keyPath: settings.apns.keyPath,
              keyId: settings.apns.keyId,
              teamId: settings.apns.teamId,
              bundleId: settings.apns.bundleId,
              environment: settings.apns.environment,
            }
          : null,
        fcm: settings?.fcm
          ? {
              serviceAccountPath: settings.fcm.serviceAccountPath,
              appId: settings.fcm.appId ?? null,
              projectId: settings.fcm.projectId ?? null,
            }
          : null,
        ...(relay.visible ? { relay: { enabled: relayConsented > 0, url: relay.url } } : {}),
      },
      devices: {
        total: devices.length,
        directApns: devices.filter(
          (device) => device.pushTransport === "direct-apns" && availability.get(device.id),
        ).length,
        directFcm: devices.filter(
          (device) => device.pushTransport === "direct-fcm" && availability.get(device.id),
        ).length,
        // Deprecated response fields retained until the next HTTP major.
        // Rich carrier delivery no longer exists, so both are always zero.
        legacyApns: 0,
        legacyFcm: 0,
        relay: devices.filter(
          (device) => device.pushTransport === "relay" && availability.get(device.id),
        ).length,
        relayConsented,
        unavailable: devices.filter((device) => !availability.get(device.id)).length,
        deliveryHealth: devices.map((device) => {
          const queue = queueByDevice.get(device.id);
          return {
            id: device.id,
            name: device.name,
            platform: device.kind,
            transport: device.pushTransport,
            available: availability.get(device.id) ?? false,
            ...explain(device),
            status: device.notificationDeliveryHealth ?? null,
            updatedAt: device.notificationDeliveryHealthUpdatedAt ?? null,
            queue: {
              pending: queue?.pending ?? 0,
              leased: queue?.leased ?? 0,
              delivered: queue?.delivered ?? 0,
              superseded: queue?.superseded ?? 0,
              expired: queue?.expired ?? 0,
              lastClaimedAt: queue?.last_claimed_at ?? null,
              lastDeliveredAt: queue?.last_delivered_at ?? null,
              wake: {
                pending: queue?.wake_pending ?? 0,
                leased: queue?.wake_leased ?? 0,
                sent: queue?.wake_sent ?? 0,
                terminal: queue?.wake_terminal ?? 0,
                exhausted: queue?.wake_exhausted ?? 0,
                attempts: queue?.wake_attempts ?? 0,
                lastAttemptAt: queue?.wake_last_attempt_at ?? null,
                lastSuccessAt: queue?.wake_last_success_at ?? null,
                lastOutcome: queue?.wake_last_state ?? null,
                lastError: queue?.wake_last_error ?? null,
                lastTransport: queue?.wake_last_transport ?? null,
              },
            },
          };
        }),
      },
    };
  }

  async reportDeliveryHealth(
    id: DeviceId,
    status: NotificationDeliveryHealth,
  ): Promise<{ ok: true; updatedAt: number }> {
    const device = getDevice(this.deps.db, id);
    if (!device) throw new NotFoundError("device not found");
    if (device.kind !== "ios" && device.kind !== "android") {
      throw new BadRequestError("notification delivery health is phone-only");
    }
    const updatedAt = Date.now();
    await this.deps.writeGate.setDeviceNotificationDeliveryHealth(id, status, updatedAt);
    this.deps.onDeviceChanged?.();
    return { ok: true, updatedAt };
  }

  async sendTest(targetDeviceId?: DeviceId) {
    if (targetDeviceId) {
      const device = getDevice(this.deps.db, targetDeviceId);
      if (!device) throw new NotFoundError("device not found");
      if (device.kind !== "ios" && device.kind !== "android") {
        throw new BadRequestError("push tests are phone-only");
      }
    }
    const result = await this.deps.pushTransport.sendTest(
      targetDeviceId ? [targetDeviceId] : undefined,
    );
    log.info(`test wake: status=${result.status} ${result.stdoutTail || result.error || ""}`);
    return result;
  }

  importCredential(input: PushCredentialImport): string {
    if (!this.deps.configDir) throw new BadRequestError("config dir is not available");
    if (!existsSync(input.sourcePath)) throw new BadRequestError(`no file at ${input.sourcePath}`);
    const expectedExtension = input.platform === "ios" ? ".p8" : ".json";
    if (!input.sourcePath.endsWith(expectedExtension)) {
      throw new BadRequestError(`expected a ${expectedExtension} file`);
    }
    const destinationDir = join(this.deps.configDir, input.platform === "ios" ? "apns" : "fcm");
    mkdirSync(destinationDir, { recursive: true });
    const destination = join(destinationDir, basename(input.sourcePath));
    if (resolve(input.sourcePath) !== resolve(destination))
      copyFileSync(input.sourcePath, destination);
    chmodSync(destination, 0o600);
    log.info(`${input.platform} push credential imported into config dir: ${destination}`);
    return destination;
  }
}
