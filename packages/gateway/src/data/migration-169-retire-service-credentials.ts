// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * The access schema admits a `service` principal and credential kind that no
 * flow can mint, refresh or authenticate any more: every access token is
 * obtained through an interactive OAuth authorization the operator approves.
 * A row of that kind left in place would be an identity that looks live in
 * the overview and can never be used, so each one is revoked — the credential,
 * the grants under its principal, and the principal itself — leaving the
 * audit trail intact. Rows already revoked keep their original timestamp.
 *
 * Unlike a revocation issued through the access store, this appends no
 * `access_audit_events` row: a migration runs on the bare schema without the
 * live access code that composes those events, and the revocation timestamp
 * stamped on each row is the record of what happened.
 *
 * A database that has not yet reached the access tables has nothing to retire.
 */
export function retireServiceCredentials(db: Db, now = Date.now()): void {
  const tableExists = db
    .prepare<
      [string],
      { present: number }
    >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("access_principals");
  if (!tableExists) return;

  db.prepare(
    `UPDATE principal_credentials SET revoked_at = ?
      WHERE kind = 'service' AND revoked_at IS NULL`,
  ).run(now);
  db.prepare(
    `UPDATE access_grants SET revoked_at = ?, updated_at = ?
      WHERE revoked_at IS NULL
        AND principal_id IN (SELECT id FROM access_principals WHERE kind = 'service')`,
  ).run(now, now);
  db.prepare(
    `UPDATE access_principals SET revoked_at = ?, updated_at = ?
      WHERE kind = 'service' AND revoked_at IS NULL`,
  ).run(now, now);
}
