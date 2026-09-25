// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { watchV2FiringKey } from "../subscriptions/watch-v2-plan.js";
import type { WatchNotificationWakeOutcome } from "../push/queue.js";

export interface WatchDeliveryLedgerEntry {
  seq: number;
  nodeId: string;
  keyHash: string;
  kind: string;
  attempted: number | null;
  delivered: number;
  error: string | null;
  degraded: string | null;
  at: string;
}

/** Overlay the durable queue's current outcome without duplicating its state. */
export function overlayWatchPushRetries(
  watchId: string,
  deliveries: readonly WatchDeliveryLedgerEntry[],
  outcomes: ReadonlyMap<string, WatchNotificationWakeOutcome>,
): WatchDeliveryLedgerEntry[] {
  return deliveries.map((delivery) => {
    const firingId = watchV2FiringKey({
      watchId,
      seq: delivery.seq,
      nodeId: delivery.nodeId,
      keyHash: delivery.keyHash,
    });
    const outcome = outcomes.get(firingId);
    if (!outcome) return delivery;
    return {
      ...delivery,
      attempted: outcome.attempted,
      delivered: outcome.delivered,
      error:
        outcome.outstanding > 0
          ? `notification wake retry pending for ${outcome.outstanding} device(s)`
          : outcome.failed > 0
            ? `notification wake failed for ${outcome.failed} device(s)`
            : null,
    };
  });
}
