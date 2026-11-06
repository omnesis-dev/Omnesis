// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

const insert = `INSERT OR IGNORE INTO access_scope_policy_sources(owner_kind,owner_id,capability,source_id)
 SELECT NEW.owner_kind,NEW.owner_id,NEW.capability,json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.sourceId')
 FROM json_each(CASE WHEN json_valid(NEW.policies) THEN NEW.policies ELSE '[]' END) p
 WHERE json_type(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.sourceId')='text'`;

/** Each capability has bounded policy input; old writers share these persistent triggers. */
export function createScopePolicySourceIndex(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS access_scope_policy_sources(
  owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,capability TEXT NOT NULL,source_id TEXT NOT NULL,
  PRIMARY KEY(source_id,owner_kind,owner_id,capability)
 ) WITHOUT ROWID;
 CREATE INDEX IF NOT EXISTS idx_scope_policy_sources_owner ON access_scope_policy_sources(owner_kind,owner_id,capability);
 CREATE TRIGGER IF NOT EXISTS scope_policy_source_insert AFTER INSERT ON access_scope_capabilities BEGIN ${insert}; END;
 CREATE TRIGGER IF NOT EXISTS scope_policy_source_update AFTER UPDATE ON access_scope_capabilities BEGIN
  DELETE FROM access_scope_policy_sources WHERE owner_kind=OLD.owner_kind AND owner_id=OLD.owner_id AND capability=OLD.capability;
  ${insert};
 END;
 CREATE TRIGGER IF NOT EXISTS scope_policy_source_delete AFTER DELETE ON access_scope_capabilities BEGIN
  DELETE FROM access_scope_policy_sources WHERE owner_kind=OLD.owner_kind AND owner_id=OLD.owner_id AND capability=OLD.capability;
 END;`);
}

/** Configuration-only upgrade; no document, fact or Answer history traversal. */
export function backfillScopePolicySourceIndex(db: Db): void {
  createScopePolicySourceIndex(db);
  let cursor = 0;
  for (;;) {
    const rows = db
      .prepare<[number], { rowid: number }>(
        "SELECT rowid FROM access_scope_capabilities WHERE rowid>? ORDER BY rowid LIMIT 100",
      )
      .all(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      db.prepare(
        `INSERT OR IGNORE INTO access_scope_policy_sources(owner_kind,owner_id,capability,source_id)
    SELECT c.owner_kind,c.owner_id,c.capability,json_extract(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.sourceId')
    FROM access_scope_capabilities c,json_each(CASE WHEN json_valid(c.policies) THEN c.policies ELSE '[]' END) p
    WHERE c.rowid=? AND json_type(CASE WHEN p.type='object' THEN p.value ELSE '{}' END,'$.sourceId')='text'`,
      ).run(row.rowid);
      cursor = row.rowid;
    }
  }
}

/** Saved-source discovery is indexed and never parses policy JSON on the main reader. */
export function hasSavedScopePolicySource(db: Db, sourceId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM access_scope_policy_sources s
 WHERE s.source_id=? AND s.owner_kind='level'
 AND EXISTS(SELECT 1 FROM access_levels l WHERE l.id=s.owner_id AND l.revoked_at IS NULL) LIMIT 1`,
    )
    .get(sourceId);
}
