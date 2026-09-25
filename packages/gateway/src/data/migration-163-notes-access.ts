// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Permit independently consented note capture without granting corpus access. */
export function addNotesAccessCapability(db: Db): void {
  const table = db
    .prepare<
      [],
      { sql: string }
    >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'access_grant_capabilities'")
    .get();
  if (!table || table.sql.includes("'notes'")) return;
  db.exec(`
    CREATE TABLE access_grant_capabilities_v163 (
      grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
      capability TEXT NOT NULL CHECK(capability IN ('direct', 'answer', 'notes')),
      source_mode TEXT NOT NULL CHECK(source_mode IN ('all', 'allowlist', 'denylist')),
      source_ids TEXT NOT NULL,
      release_mode TEXT CHECK(release_mode IN ('reviewed', 'unreviewed')),
      policy_family_id TEXT REFERENCES privacy_policy_families(id),
      PRIMARY KEY(grant_id, capability),
      CHECK(json_valid(source_ids) AND json_type(source_ids) = 'array'),
      CHECK((source_mode = 'all' AND source_ids = '[]') OR source_mode <> 'all'),
      CHECK(
        (capability = 'direct' AND release_mode IS NULL AND policy_family_id IS NULL) OR
        (capability = 'notes' AND source_mode = 'all' AND source_ids = '[]' AND release_mode IS NULL AND policy_family_id IS NULL) OR
        (capability = 'answer' AND release_mode = 'reviewed' AND policy_family_id IS NOT NULL) OR
        (capability = 'answer' AND release_mode = 'unreviewed' AND policy_family_id IS NULL)
      )
    );
    INSERT INTO access_grant_capabilities_v163 SELECT * FROM access_grant_capabilities;
    DROP TABLE access_grant_capabilities;
    ALTER TABLE access_grant_capabilities_v163 RENAME TO access_grant_capabilities;
    CREATE INDEX idx_access_grant_capabilities_policy
      ON access_grant_capabilities(policy_family_id, capability, release_mode, grant_id);
  `);
}
