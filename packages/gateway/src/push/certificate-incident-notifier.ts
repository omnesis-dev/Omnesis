// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { DeviceId, DeviceRecord } from "@omnesis/types";
import type { NotificationPublisher } from "./broadcast.js";

const log = createLogger("gateway:certificate-incident:push");

/**
 * Tells the owner's phones that the gateway is on a certificate incident hold.
 *
 * The push relay may run beside the relay whose certificate is in question, so
 * the text is generic: no hostname, fingerprint or issuer. It uses the
 * `diagnostic` kind, which every app version opens, rather than a new kind an
 * older app would set aside unopened.
 */
export class CertificateIncidentNotifier {
  constructor(
    private readonly publisher: NotificationPublisher,
    private readonly devices: () => DeviceRecord[],
    private readonly administrators: () => readonly DeviceId[],
  ) {}

  async notify(): Promise<void> {
    try {
      const administrators = new Set(this.administrators());
      const targets = this.devices()
        .filter(
          (device) =>
            device.revokedAt === null &&
            administrators.has(device.id) &&
            (device.kind === "ios" || device.kind === "android"),
        )
        .map((device) => device.id);
      if (targets.length === 0) return;
      await this.publisher.publish(
        {
          kind: "diagnostic",
          title: "Security check needed",
          body: "Omnesis found a certificate for your gateway that it did not request. New devices now wait for your approval. On the gateway, run omnesis cloud status for details.",
          data: {},
          collapseId: "certificate-incident",
        },
        targets,
        // A week: the hold lasts until the owner acts, but a stale banner adds nothing.
        { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 },
      );
    } catch {
      log.warn("Certificate incident notification could not be queued; the portal still shows it");
    }
  }
}
