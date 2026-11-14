// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Device keys whose device the owner revoked or forgot. A sign-in with one of
 * them waits for a person, whatever the enrollment policy, until the owner
 * approves it again.
 */
export const REVOKED_DEVICE_KEYS_TABLE = `CREATE TABLE IF NOT EXISTS revoked_device_keys (
  public_key TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL
)`;

/**
 * Revocation sticks, and each device remembers the sign-in it joined with.
 *
 * `enrollment_sign_in_id` is the id of that trusted sign-in, so removing the
 * sign-in can find the devices that joined with it. It is NULL on existing
 * rows: they joined before it was recorded. Every device already revoked has
 * its key remembered, so the rule covers devices revoked before this upgrade.
 */
export function addStickyDeviceRevocation(db: Db): void {
  for (const table of ["devices", "device_pairings"]) {
    const columns = (db.pragma(`table_info(${table})`) as { name: string }[]).map(
      (column) => column.name,
    );
    if (!columns.includes("enrollment_sign_in_id"))
      db.exec(`ALTER TABLE ${table} ADD COLUMN enrollment_sign_in_id TEXT`);
  }
  db.exec(REVOKED_DEVICE_KEYS_TABLE);
  db.exec(`INSERT OR IGNORE INTO revoked_device_keys (public_key, revoked_at)
    SELECT enrollment_public_key, MIN(revoked_at) FROM devices
     WHERE revoked_at IS NOT NULL AND enrollment_public_key IS NOT NULL
     GROUP BY enrollment_public_key`);
}
