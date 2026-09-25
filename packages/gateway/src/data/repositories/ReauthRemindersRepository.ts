// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-(connection, device) re-auth reminder state.
 *
 * When a provider connection's credentials lapse, every source under it
 * (Gmail + Calendar + Contacts + Drive for one Google account) flips to
 * `needs-auth` and the collector re-emits that on every sync tick. The
 * built-in `NeedsAuthNotifier` must not turn that into a push storm: the
 * operator re-auths once per *connection*, so the reminder is owed once per
 * connection, then on an exponential backoff (1d, 2d, 4d, 1w…) until the
 * connection is healthy again.
 *
 * Credentials are held per device: each member of a multi-device source
 * authenticates its own grant, so "needs sign-in" is a fact about the pair
 * (connection, device) and the table holds one row per re-auth principal
 * per reporting device. The principal is the provider connection id
 * `<providerType>:<accountId>` (e.g. `google:user@example.com`), falling
 * back to the bare `sourceId` when the collector didn't report a providerId.
 * `notify_count` records how many reminders have been sent (drives the
 * backoff ladder); `last_notified_at` is when the most recent one fired.
 * The row is deleted when that device successfully re-auths the connection,
 * so a future expiry starts the ladder fresh — and a sibling device's
 * recovery never touches it.
 *
 * A device-less row (`device_id = ''`) carries a principal-wide episode:
 * the next device that lapses adopts it, so the backoff in progress carries
 * over rather than re-firing at once. Until then it is inert — no device's
 * recovery clears it, and it gates nothing.
 *
 * Persisting here (not in-memory) means the de-dup + backoff survive a
 * gateway restart: a restart no longer re-fires a reminder for a connection
 * that's still in its backoff window.
 *
 * Sole-writer constraint: the read-decide-write is done atomically
 * inside one writer-worker handler (`db.reserveReauthReminder`); resets
 * route through `db.recoverReauthReminder`. No reads happen off the writer
 * handle, so there is no read-modify-write race across the de-dup decision.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
type Db = Database.Database;

export interface ReauthReminderRow {
  /** Re-auth principal: provider connection id, or sourceId fallback. */
  principal: string;
  /** The member device whose grant lapsed. */
  device_id: string;
  /** Epoch ms of the first reminder in the current needs-auth episode. */
  first_needed_at: number;
  /** Epoch ms of the most recent reminder sent for this principal on this device. */
  last_notified_at: number;
  /** Count of reminders sent so far in the current episode (>= 1 once a row exists). */
  notify_count: number;
}

/** The device-less row: a principal-wide episode awaiting adoption. */
const LEGACY_DEVICE_ID = "";

/** The table's column definitions; shared by the setup DDL and the rebuild. */
const REAUTH_REMINDER_COLUMNS = `
      principal TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      first_needed_at INTEGER NOT NULL,
      last_notified_at INTEGER NOT NULL,
      notify_count INTEGER NOT NULL,
      reservation_token TEXT,
      reserved_until INTEGER,
      PRIMARY KEY (principal, device_id)`;

export function createReauthRemindersTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reauth_reminders (${REAUTH_REMINDER_COLUMNS})`);
}

function reminderColumns(db: Db): Set<string> {
  return new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('reauth_reminders')")
      .all()
      .map((row) => row.name),
  );
}

/** Add reservation columns to an existing reminder table during migration. */
export function addReauthReminderReservationColumns(db: Db): void {
  const columns = reminderColumns(db);
  if (!columns.has("reservation_token"))
    db.exec("ALTER TABLE reauth_reminders ADD COLUMN reservation_token TEXT");
  if (!columns.has("reserved_until"))
    db.exec("ALTER TABLE reauth_reminders ADD COLUMN reserved_until INTEGER");
}

/**
 * Re-key a reminder table from `principal` to `(principal, device_id)`
 * during migration. Nothing references the table, so it is rebuilt in
 * place; every existing row becomes a device-less row for the next device
 * that lapses to adopt. A no-op when the table is absent or already keyed
 * by device.
 */
export function rekeyReauthRemindersByDevice(db: Db): void {
  const columns = reminderColumns(db);
  if (columns.size === 0 || columns.has("device_id")) return;
  db.exec(`
    CREATE TABLE reauth_reminders_next (${REAUTH_REMINDER_COLUMNS});
    INSERT INTO reauth_reminders_next
      (principal, device_id, first_needed_at, last_notified_at, notify_count, reservation_token, reserved_until)
      SELECT principal, '', first_needed_at, last_notified_at, notify_count, reservation_token, reserved_until
      FROM reauth_reminders;
    DROP TABLE reauth_reminders;
    ALTER TABLE reauth_reminders_next RENAME TO reauth_reminders;
  `);
}

export function reserveReauthReminder(
  db: Db,
  principal: string,
  deviceId: string,
  now: number,
  reservationTtlMs: number,
  isDue: (existing: ReauthReminderRow | null) => boolean,
): string | null {
  return db
    .transaction(() => {
      adoptLegacyReminder(db, principal, deviceId);
      const existing = getReauthReminder(db, principal, deviceId);
      const raw = db
        .prepare<
          [string, string],
          { reservation_token: string | null; reserved_until: number | null }
        >("SELECT reservation_token, reserved_until FROM reauth_reminders WHERE principal = ? AND device_id = ?")
        .get(principal, deviceId);
      if (raw?.reservation_token && raw.reserved_until != null && raw.reserved_until > now)
        return null;
      if (!isDue(existing)) return null;
      const token = randomUUID();
      if (!existing) {
        db.prepare(
          `INSERT INTO reauth_reminders
           (principal, device_id, first_needed_at, last_notified_at, notify_count, reservation_token, reserved_until)
         VALUES (?, ?, ?, 0, 0, ?, ?)`,
        ).run(principal, deviceId, now, token, now + reservationTtlMs);
      } else {
        db.prepare(
          "UPDATE reauth_reminders SET reservation_token = ?, reserved_until = ? WHERE principal = ? AND device_id = ?",
        ).run(token, now + reservationTtlMs, principal, deviceId);
      }
      return token;
    })
    .immediate();
}

/**
 * Hand a principal's device-less row to the device that needs it, unless
 * that device already has its own. The device's backoff then continues
 * where the principal-wide episode left off.
 */
function adoptLegacyReminder(db: Db, principal: string, deviceId: string): void {
  if (deviceId === LEGACY_DEVICE_ID) return;
  db.prepare(
    `UPDATE reauth_reminders SET device_id = ?
     WHERE principal = ? AND device_id = ?
       AND NOT EXISTS (SELECT 1 FROM reauth_reminders WHERE principal = ? AND device_id = ?)`,
  ).run(deviceId, principal, LEGACY_DEVICE_ID, principal, deviceId);
}

export function commitReauthReminder(db: Db, token: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE reauth_reminders SET last_notified_at = ?, notify_count = notify_count + 1,
       reservation_token = NULL, reserved_until = NULL WHERE reservation_token = ?`,
    )
    .run(now, token);
  return result.changes === 1;
}

export function releaseReauthReminder(db: Db, token: string): boolean {
  const result = db
    .prepare(
      "UPDATE reauth_reminders SET reservation_token = NULL, reserved_until = NULL WHERE reservation_token = ?",
    )
    .run(token);
  return result.changes === 1;
}

export function getReauthReminder(
  db: Db,
  principal: string,
  deviceId: string,
): ReauthReminderRow | null {
  return (
    db
      .prepare<
        [string, string],
        ReauthReminderRow
      >("SELECT * FROM reauth_reminders WHERE principal = ? AND device_id = ?")
      .get(principal, deviceId) ?? null
  );
}

/**
 * Drop one device's reminder state for a principal. Called when that device
 * re-auths the connection. Only its own row goes: a sibling's episode and a
 * device-less row still awaiting adoption are untouched. No-op if absent.
 */
export function clearReauthReminder(db: Db, principal: string, deviceId: string): void {
  db.prepare("DELETE FROM reauth_reminders WHERE principal = ? AND device_id = ?").run(
    principal,
    deviceId,
  );
}
