// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { DeviceId } from "@omnesis/types";
import type { DurableNotificationPublisher } from "../push/broadcast.js";

const log = createLogger("gateway:access:push");

/**
 * Selects eligible phone targets and emits a content-free wake after the
 * writer has atomically committed the notification outbox row.
 *
 * This class never accepts a request id, user code, or client name, so none can
 * accidentally cross into carrier payloads or logs.
 */
export class AccessAuthorizationNotifier {
  constructor(private readonly publisher: DurableNotificationPublisher) {}

  targetDeviceIds(): DeviceId[] {
    return this.publisher.retentionDeviceIds();
  }

  async wakeQueued(deviceIds: readonly DeviceId[]): Promise<void> {
    try {
      const results = await this.publisher.wakeAuthorized(deviceIds);
      const woken = results.filter((result) => result.ok).length;
      log.info(
        `access authorization wake queued for ${deviceIds.length} device(s); ${woken} woken immediately`,
      );
    } catch {
      // The notification is already durable. The retry scheduler owns every
      // pending wake, so an immediate carrier fault must not re-enqueue it.
      log.warn("immediate access authorization wake failed after durable enqueue");
    }
  }
}
