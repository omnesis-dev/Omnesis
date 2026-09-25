// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Keep device revocation proportional to that device's bound credentials. */
export function indexPrincipalCredentialsByExecutionDevice(db: Db): void {
  const tableExists = db
    .prepare<
      [string],
      { present: number }
    >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("principal_credentials");
  if (!tableExists) return;

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_principal_credentials_execution_device
      ON principal_credentials(execution_device_id)
      WHERE execution_device_id IS NOT NULL
  `);
}
