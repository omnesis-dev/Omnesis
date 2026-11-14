// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DeviceId } from "@omnesis/types";
import type { Db } from "../data/types.js";

/**
 * A notification kind that only some clients can route, and the device
 * capability that says a client can.
 */
interface RoutedKind {
  kind: "device-pairing" | "tailscale-join";
  capability: "pairingNotifications" | "tailscaleJoinNotifications";
}

const PAIRING: RoutedKind = { kind: "device-pairing", capability: "pairingNotifications" };
const TAILSCALE_JOIN: RoutedKind = {
  kind: "tailscale-join",
  capability: "tailscaleJoinNotifications",
};

/**
 * Supersede waiting deliveries of `routed.kind` unless this claim says the
 * client routes them and its device row agrees. Run inside the claim
 * transaction so a capability withdrawal cannot strand an older client behind
 * a kind it does not know.
 */
function suppressUnsupported(
  db: Db,
  deviceId: DeviceId,
  now: number,
  routed: RoutedKind,
  claimSupports: boolean,
): void {
  const waiting = db
    .prepare<[string, string], { present: number }>(
      "SELECT 1 AS present FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.device_id=? AND n.kind=? AND d.state IN ('pending','leased') LIMIT 1",
    )
    .get(deviceId, routed.kind);
  if (!waiting) return;
  const capability = claimSupports
    ? db
        .prepare<[string, string], { supported: number | null }>(
          "SELECT CASE WHEN json_valid(capabilities) THEN json_type(capabilities, ?) = 'true' ELSE 0 END AS supported FROM devices WHERE id=?",
        )
        .get(`$.${routed.capability}`, deviceId)
    : undefined;
  if (capability?.supported === 1) return;
  db.prepare(
    `UPDATE notification_deliveries SET state='superseded', leased_until=NULL,
      wake_state='terminal', wake_lease_token=NULL, wake_leased_until=NULL, wake_next_attempt_at=NULL
      WHERE device_id=? AND notification_id IN (SELECT id FROM notifications WHERE kind=?)
      AND (state='pending' OR (state='leased' AND leased_until<=?))`,
  ).run(deviceId, routed.kind, now);
}

/** Pairing requests reach only clients that negotiated cloud-relay pairing notifications. */
export function suppressUnsupportedPairingReminders(
  db: Db,
  deviceId: DeviceId,
  now: number,
  supportsPairingNotifications: boolean,
): void {
  suppressUnsupported(db, deviceId, now, PAIRING, supportsPairingNotifications);
}

/** Tailscale join requests reach only clients that can show and decide them. */
export function suppressUnsupportedTailscaleJoinReminders(
  db: Db,
  deviceId: DeviceId,
  now: number,
  supportsTailscaleJoinNotifications: boolean,
): void {
  suppressUnsupported(db, deviceId, now, TAILSCALE_JOIN, supportsTailscaleJoinNotifications);
}
