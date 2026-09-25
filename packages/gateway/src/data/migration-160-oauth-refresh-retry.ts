// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Retain an encrypted token response briefly so refresh rotation is retry-safe. */
export function addOAuthRefreshRetryColumns(db: Db): void {
  const columns = new Set(
    db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all("oauth_refresh_tokens")
      .map((row) => row.name),
  );
  if (columns.size === 0) return;
  if (!columns.has("replacement_ciphertext")) {
    db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN replacement_ciphertext TEXT");
  }
  if (!columns.has("retry_until")) {
    db.exec("ALTER TABLE oauth_refresh_tokens ADD COLUMN retry_until INTEGER");
  }
  db.exec(`
    UPDATE principal_credentials
       SET revoked_at = COALESCE(
         revoked_at,
         (SELECT revoked_at FROM devices WHERE id = principal_credentials.execution_device_id)
       )
     WHERE execution_device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)
  `);
}
