// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { installKnowledgeReconciliationTriggers } from "./reconciliation.js";
import type Database from "better-sqlite3";

/** Canonical table changes remain visible even when the model/scheduler is disabled. */
export function installKnowledgeOwnerTriggers(db: Database.Database): void {
  installKnowledgeReconciliationTriggers(db);
  const owners = [
    {
      table: "open_loops",
      kind: "loop",
      fields: [
        "title",
        "description",
        "state",
        "deadline_json",
        "actors_json",
        "involved_json",
        "blocked_by_json",
        "importance",
        "confidence",
        "last_update",
      ],
    },
    {
      table: "briefs",
      kind: "brief",
      fields: [
        "title",
        "description",
        "body",
        "state",
        "relevant_until",
        "next_show",
        "event_at",
        "user_feedback",
        "updated_at",
      ],
    },
    {
      table: "doc_annotations",
      kind: "doc_annotation",
      fields: [
        "claim_text",
        "claim_type",
        "invalidated_at",
        "superseded_by",
        "evidence_doc_id",
        "evidence_quote",
        "confidence",
        "verification_state",
        "updated_at",
      ],
    },
    {
      table: "person_annotations",
      kind: "person_annotation",
      fields: [
        "claim_text",
        "claim_type",
        "invalidated_at",
        "superseded_by",
        "evidence_doc_id",
        "evidence_quote",
        "confidence",
        "verification_state",
        "updated_at",
      ],
    },
  ];
  for (const owner of owners) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(owner.table))
      continue;
    const guard = `NOT EXISTS(SELECT 1 FROM knowledge_owner_write_guard WHERE kind='${owner.kind}' AND owner_id=NEW.id)`;
    const queue = `INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('${owner.kind}',NEW.id,'update',CAST(unixepoch('subsec')*1000 AS INTEGER))
      ON CONFLICT(kind,owner_id) DO UPDATE SET operation='update',changed_at=excluded.changed_at;`;
    if (owner.kind === "loop")
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_owner_loop_retire AFTER DELETE ON open_loops
      WHEN EXISTS(SELECT 1 FROM knowledge_owner_retire_guard WHERE owner_id=OLD.id) BEGIN
        INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('loop',OLD.id,'update',CAST(unixepoch('subsec')*1000 AS INTEGER))
        ON CONFLICT(kind,owner_id) DO UPDATE SET operation='update',changed_at=excluded.changed_at;
      END`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_owner_${owner.kind}_insert AFTER INSERT ON ${owner.table} WHEN ${guard} BEGIN ${queue} END;
      CREATE TRIGGER IF NOT EXISTS knowledge_owner_${owner.kind}_update AFTER UPDATE ON ${owner.table}
        WHEN ${guard} AND (${owner.fields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}) BEGIN ${queue} END;
      CREATE TRIGGER IF NOT EXISTS knowledge_owner_${owner.kind}_delete AFTER DELETE ON ${owner.table}
        WHEN NOT EXISTS(SELECT 1 FROM knowledge_owner_retire_guard WHERE owner_id=OLD.id)
          AND NOT EXISTS(SELECT 1 FROM knowledge_owner_withdraw_guard WHERE owner_id=OLD.id) BEGIN
        INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('${owner.kind}',OLD.id,'delete',CAST(unixepoch('subsec')*1000 AS INTEGER))
          ON CONFLICT(kind,owner_id) DO UPDATE SET operation='delete',changed_at=excluded.changed_at;
        INSERT OR IGNORE INTO knowledge_node_tombstones(id,deleted_at) VALUES(OLD.id,CAST(unixepoch('subsec')*1000 AS INTEGER));
        INSERT OR IGNORE INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at)
          VALUES('purge','node',OLD.id,'deleted',CAST(unixepoch('subsec')*1000 AS INTEGER));
        INSERT OR IGNORE INTO knowledge_cascade_frontier(job_id,target_kind,target_id)
          SELECT id,'node',OLD.id FROM knowledge_cascade_jobs WHERE kind='purge' AND target_kind='node' AND target_id=OLD.id AND revision='deleted';
      END;
    `);
  }
}
