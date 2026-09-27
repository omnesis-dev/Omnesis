// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * An interactive credential carries the audience and scope its approval
 * granted for as long as the credential lives.
 *
 * Headless re-issue mints a fresh token pair for an existing credential, and
 * must copy the approved audience and scope rather than accept them from the
 * caller. The authorization request that recorded them is reaped by the
 * access cleanup once its code window closes, and every token row is reaped
 * once it expires, so neither can be where a months-old credential keeps them.
 *
 * Existing credentials are filled from the best surviving evidence: their
 * authorization request when it is still stored, otherwise the newest refresh
 * token and then the newest access token, each of which was minted with a
 * copy of the approved values. A credential with none of those left stays
 * empty, and re-issue declines it as it declines any credential it cannot
 * prove an approval for. Idempotent: only empty rows are filled, and a
 * database without the access tables has nothing to change.
 */
export function addCredentialApprovedAudience(db: Db): void {
  const columns = new Set(
    db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all("principal_credentials")
      .map((row) => row.name),
  );
  if (columns.size === 0) return;
  if (!columns.has("approved_audience")) {
    db.exec("ALTER TABLE principal_credentials ADD COLUMN approved_audience TEXT");
  }
  if (!columns.has("approved_scope")) {
    db.exec("ALTER TABLE principal_credentials ADD COLUMN approved_scope TEXT");
  }

  const tables = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  // Most authoritative first; each pass fills only what the passes before it
  // left empty.
  const evidence: Array<{ table: string; audience: string; order: string }> = [
    { table: "oauth_authorization_requests", audience: "resource", order: "" },
    {
      table: "oauth_refresh_tokens",
      audience: "audience",
      order: "ORDER BY created_at DESC, id DESC",
    },
    {
      table: "oauth_access_tokens",
      audience: "audience",
      order: "ORDER BY created_at DESC, id DESC",
    },
  ];
  for (const { table, audience, order } of evidence) {
    if (!tables.has(table)) continue;
    const newest = `FROM ${table} e WHERE e.credential_id = principal_credentials.id ${order} LIMIT 1`;
    db.exec(`
      UPDATE principal_credentials
         SET approved_audience = (SELECT e.${audience} ${newest}),
             approved_scope = (SELECT e.scope ${newest})
       WHERE kind = 'interactive' AND approved_audience IS NULL
         AND EXISTS (SELECT 1 ${newest})
    `);
  }
}
