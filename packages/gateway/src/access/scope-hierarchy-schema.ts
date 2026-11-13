// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

export function createScopeHierarchySchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_hierarchy_nodes (
    source_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,label TEXT NOT NULL,
    parents_json TEXT NOT NULL,complete INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
    snapshot_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(source_id,kind,entity_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_scope_hierarchy_snapshot ON scope_hierarchy_nodes(source_id,kind,snapshot_id,entity_id);
  CREATE TABLE IF NOT EXISTS scope_document_hierarchy (
    document_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,
    parents_json TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(document_id,kind)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_hierarchy_dependencies (
    document_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,
    PRIMARY KEY(document_id,kind,entity_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_scope_hierarchy_dependents ON scope_hierarchy_dependencies(source_id,kind,entity_id,document_id);
  CREATE TABLE IF NOT EXISTS scope_hierarchy_dirty (
    source_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision TEXT NOT NULL,
    cursor_document_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(source_id,kind,entity_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_hierarchy_catalogues (
    source_id TEXT NOT NULL,kind TEXT NOT NULL,snapshot_id TEXT NOT NULL,phase TEXT NOT NULL,
    cursor_entity_id TEXT NOT NULL DEFAULT '',release_refresh INTEGER NOT NULL DEFAULT 0,
    publish_ready INTEGER NOT NULL DEFAULT 0,refresh_epoch TEXT,PRIMARY KEY(source_id,kind)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_hierarchy_work_cursor(id INTEGER PRIMARY KEY CHECK(id=1),source_id TEXT NOT NULL,entity_id TEXT NOT NULL,catalogue_source_id TEXT NOT NULL DEFAULT '');
  CREATE INDEX IF NOT EXISTS idx_scope_hierarchy_catalogue_phase ON scope_hierarchy_catalogues(phase,source_id);
  INSERT OR IGNORE INTO scope_hierarchy_work_cursor VALUES(1,'','','');`);
}
