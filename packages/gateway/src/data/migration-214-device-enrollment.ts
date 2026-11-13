// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

export const DEVICE_ENROLLMENT_PUBLIC_KEY_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_enrollment_public_key ON devices(kind, enrollment_public_key) WHERE enrollment_public_key IS NOT NULL";

/**
 * How a device joined by signing in. Every column is NULL on existing rows,
 * which is what keeps them under the rules they paired by. A non-NULL
 * `device_pairings.enrollment_method` is what turns off adoption by install id,
 * previous id and name for that pairing.
 */
export function addDeviceEnrollment(db: Db): void {
  const addMissing = (table: string, columns: readonly string[]): void => {
    const existing = new Set(
      (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name),
    );
    for (const column of columns) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  };
  addMissing("devices", ["enrollment_public_key", "enrollment_method", "enrollment_sign_in"]);
  if (
    !(db.pragma("table_info(devices)") as { name: string }[]).some((c) => c.name === "enrolled_at")
  ) {
    db.exec("ALTER TABLE devices ADD COLUMN enrolled_at INTEGER");
  }
  addMissing("device_pairings", [
    "enrollment_public_key",
    "enrollment_method",
    "enrollment_sign_in",
  ]);
  addMissing("tokens", ["rotated_from"]);
  db.exec(DEVICE_ENROLLMENT_PUBLIC_KEY_INDEX);
}
