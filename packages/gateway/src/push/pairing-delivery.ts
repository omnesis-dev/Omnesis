// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DeviceId } from "@omnesis/types";
import type { Db } from "../data/types.js";

/** Run inside the claim transaction so a capability withdrawal cannot strand an older client behind an unknown kind. */
export function suppressUnsupportedPairingReminders(
  db: Db,
  deviceId: DeviceId,
  now: number,
  supportsPairingNotifications: boolean,
): void {
  const waiting = db
    .prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.device_id=? AND n.kind='device-pairing' AND d.state IN ('pending','leased') LIMIT 1",
    )
    .get(deviceId);
  if (!waiting) return;
  const capability = supportsPairingNotifications
    ? db
        .prepare<[string], { supported: number | null }>(
          "SELECT CASE WHEN json_valid(capabilities) THEN json_type(capabilities, '$.pairingNotifications') = 'true' ELSE 0 END AS supported FROM devices WHERE id=?",
        )
        .get(deviceId)
    : undefined;
  if (capability?.supported === 1) return;
  db.prepare(
    `UPDATE notification_deliveries SET state='superseded', leased_until=NULL,
      wake_state='terminal', wake_lease_token=NULL, wake_leased_until=NULL, wake_next_attempt_at=NULL
      WHERE device_id=? AND notification_id IN (SELECT id FROM notifications WHERE kind='device-pairing')
      AND (state='pending' OR (state='leased' AND leased_until<=?))`,
  ).run(deviceId, now);
}
