// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { DeviceEnrollmentSignIn, DeviceId, DeviceKind, DeviceRecord } from "@omnesis/types";
import type { NotificationPublisher } from "./broadcast.js";

const log = createLogger("gateway:pairing:push");

/** The name a joining device chose for itself, kept to one short line. */
function bannerName(name: string): string {
  const line = name.replace(/\p{C}+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "A device";
}

/** Only already authorized administrators may be prompted to review device enrollment. */
export class PairingNotifier {
  constructor(
    private readonly publisher: NotificationPublisher,
    private readonly devices: () => DeviceRecord[],
    private readonly administrators: () => readonly DeviceId[],
  ) {}

  /**
   * Tell the owner a device joined with nobody approving it, so a join they did
   * not make is seen while it can still be undone. Goes to every administrator's
   * phone but the new device itself. Carries nothing a lock screen should not.
   */
  async notifyJoined(joined: {
    deviceId: DeviceId;
    name: string;
    kind: DeviceKind;
    signIn: DeviceEnrollmentSignIn | null;
  }): Promise<void> {
    try {
      const administrators = new Set(this.administrators());
      const targets = this.devices()
        .filter(
          (device) =>
            device.id !== joined.deviceId &&
            device.revokedAt === null &&
            // The builds that route pairing requests route this kind too; an
            // older app would only claim a notification it cannot open.
            device.capabilities.pairingNotifications === true &&
            administrators.has(device.id) &&
            (device.kind === "ios" || device.kind === "android"),
        )
        .map((device) => device.id);
      if (targets.length === 0) return;
      await this.publisher.publish(
        {
          kind: "device-joined",
          title: "New device joined",
          body: `${bannerName(joined.name)} joined your gateway. Not you? Remove it in Devices.`,
          data: {},
          collapseId: `device-joined:${joined.deviceId}`,
        },
        targets,
        // No idempotency key: a reinstall on the same row is a new join worth
        // telling the owner about, and the collapse id replaces the older banner.
        // A day-old notice of a join is no longer news.
        { expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
      );
    } catch {
      log.warn("Join notification could not be queued; the device is listed under Devices");
    }
  }

  async notify(request: { requestId: string; expiresAt: number }): Promise<void> {
    if (request.expiresAt <= Date.now()) return;
    try {
      const administrators = new Set(this.administrators());
      const targets = this.devices()
        .filter(
          (device) =>
            device.revokedAt === null &&
            device.capabilities.pairingNotifications === true &&
            administrators.has(device.id) &&
            (device.kind === "ios" || device.kind === "android"),
        )
        .map((device) => device.id);
      if (targets.length === 0) return;
      await this.publisher.publish(
        {
          kind: "device-pairing",
          title: "Device pairing request",
          body: "Review the new device under Devices → Pairing requests. Compare the verification codes before approving.",
          data: {},
          collapseId: `device-pairing:${request.requestId}`,
        },
        targets,
        { expiresAt: request.expiresAt, idempotencyKey: `device-pairing:${request.requestId}` },
      );
    } catch {
      log.warn(
        "Pairing notification could not be queued; the request remains available on trusted devices",
      );
    }
  }
}
