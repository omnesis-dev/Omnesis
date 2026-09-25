// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commitMobilePermissionReminder } from "../data/repositories/MobilePermissionHealthRepository.js";
import { commitReauthReminder } from "../data/repositories/ReauthRemindersRepository.js";
import {
  enqueueNotification,
  validateEnqueueNotificationInput,
  type EnqueueNotificationInput,
} from "./queue.js";
import type { DeviceId } from "@omnesis/types";
import type { Db } from "../data/types.js";

export interface CommittedReminderNotificationResult {
  deviceIds: DeviceId[];
}

/** Retain rendered content and consume its re-auth authority in one transaction. */
export function commitReauthReminderNotification(
  db: Db,
  reservationToken: string,
  now: number,
  notification: EnqueueNotificationInput,
): CommittedReminderNotificationResult | null {
  return db
    .transaction(() => {
      const authority = db
        .prepare<
          [string],
          { present: number }
        >("SELECT 1 AS present FROM reauth_reminders WHERE reservation_token = ?")
        .get(reservationToken);
      if (!authority) return null;
      validateEnqueueNotificationInput(notification);
      const retained =
        notification.deviceIds.length > 0 ? enqueueNotification(db, notification) : null;
      if (notification.deviceIds.length > 0 && !retained) return null;
      if (!commitReauthReminder(db, reservationToken, now))
        throw new Error("re-auth reminder authority changed during atomic retention");
      return { deviceIds: retained?.deviceIds ?? [] };
    })
    .immediate();
}

/** Retain rendered content and consume its exact source episode authority atomically. */
export function commitMobilePermissionReminderNotification(
  db: Db,
  reservationToken: string,
  episodeId: string,
  now: number,
  notification: EnqueueNotificationInput,
): CommittedReminderNotificationResult | null {
  return db
    .transaction(() => {
      const authority = db
        .prepare<
          [string, string],
          { present: number }
        >("SELECT 1 AS present FROM mobile_permission_health WHERE reservation_token = ? AND episode_id = ?")
        .get(reservationToken, episodeId);
      if (!authority) return null;
      validateEnqueueNotificationInput(notification);
      const retained =
        notification.deviceIds.length > 0 ? enqueueNotification(db, notification) : null;
      if (notification.deviceIds.length > 0 && !retained) return null;
      if (!commitMobilePermissionReminder(db, reservationToken, episodeId, now))
        throw new Error("mobile permission reminder authority changed during atomic retention");
      return { deviceIds: retained?.deviceIds ?? [] };
    })
    .immediate();
}
