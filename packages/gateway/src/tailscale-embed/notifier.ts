// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { DeviceId, DeviceRecord } from "@omnesis/types";
import type { NotificationPublisher } from "../push/broadcast.js";
import type { JoinRequestView } from "./join-requests.js";

const log = createLogger("gateway:tailscale").child("push");

/** A name a joining machine chose for itself, kept to one short line. */
function bannerName(name: string): string {
  const line = name.replace(/[\p{C}\s]+/gu, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "A device";
}

/**
 * Tells the owner's phones about collectors joining through Tailscale. Only
 * administrators' phones that said they can show these are told, and the
 * joining device never notifies itself.
 */
export class TailscaleJoinNotifier {
  constructor(
    private readonly publisher: NotificationPublisher,
    private readonly devices: () => DeviceRecord[],
    private readonly administrators: () => readonly DeviceId[],
  ) {}

  private targets(except?: DeviceId): DeviceId[] {
    const administrators = new Set(this.administrators());
    return this.devices()
      .filter(
        (device) =>
          device.id !== except &&
          device.revokedAt === null &&
          device.capabilities.tailscaleJoinNotifications === true &&
          administrators.has(device.id) &&
          (device.kind === "ios" || device.kind === "android"),
      )
      .map((device) => device.id);
  }

  async waiting(request: JoinRequestView): Promise<void> {
    try {
      const targets = this.targets();
      if (targets.length === 0) return;
      const where =
        request.machine && request.machine !== request.name
          ? ` on ${bannerName(request.machine)}`
          : "";
      await this.publisher.publish(
        {
          kind: "tailscale-join",
          title: "Device waiting to join",
          body: `${bannerName(request.name)}${where} wants to join through Tailscale. Tap to review.`,
          data: {},
          // One banner for whatever is waiting; the list behind the tap is current.
          collapseId: "tailscale-join",
        },
        targets,
        {
          expiresAt: Date.parse(request.expiresAt),
          idempotencyKey: `tailscale-join:${request.id}`,
        },
      );
    } catch {
      log.warn(
        "Join request notification could not be queued; the request is listed in the portal",
      );
    }
  }

  async joined(device: { id: DeviceId; name: string }): Promise<void> {
    try {
      const targets = this.targets(device.id);
      if (targets.length === 0) return;
      await this.publisher.publish(
        {
          kind: "device-joined",
          title: "New device joined",
          body: `${bannerName(device.name)} joined your gateway through Tailscale. Not you? Remove it in Devices.`,
          data: {},
          collapseId: `device-joined:${device.id}`,
        },
        targets,
        { expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
      );
    } catch {
      log.warn("Join notification could not be queued; the device is listed under Devices");
    }
  }
}
