// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { COGNITION_AUTHORED_SOURCES } from "../cognition-authored.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import type Database from "better-sqlite3";

/**
 * Constant-size durable intake in the same transaction as every source write.
 * No graph walk or model call occurs on ingestion. Mirrors are derived outputs.
 * TODO: the generic ingest contract needs transaction-bound initial-inventory
 * provenance before bulk new-source history can enter consented chronological
 * backfill. An old occurrence date is not sufficient: it can be late evidence.
 * Installation is separate from table creation so isolated storage tests may use
 * a minimal documents table without the production provider metadata.
 */
export function createKnowledgeSourceTriggers(db: Database.Database): void {
  const excluded = COGNITION_AUTHORED_SOURCES.map(
    (source) => "'" + source.sourceId.replaceAll("'", "''") + "'",
  ).join(",");
  const types = COGNITION_AUTHORED_SOURCES.flatMap((source) => source.exclusiveDocumentTypes)
    .map((type) => "'" + type.replaceAll("'", "''") + "'")
    .join(",");
  const hasMetadata = db
    .prepare<[], { name: string }>("PRAGMA table_info(documents)")
    .all()
    .some((column) => column.name === "metadata");
  const sourceFilter = (row: "NEW" | "OLD"): string =>
    `${row}.source_id NOT IN (${excluded})` +
    (hasMetadata && types
      ? ` AND COALESCE(json_extract(${row}.metadata,'$.documentType'),'') NOT IN (${types})`
      : "");
  // Reactive exclusion does not erase explicit provenance. An authored transcript
  // may be cited deliberately; its updates/deletion must maintain those claims.
  const trackedEvidence = (
    row: "NEW" | "OLD",
  ): string => `(EXISTS(SELECT 1 FROM knowledge_source_revisions WHERE document_id=${row}.id)
    OR EXISTS(SELECT 1 FROM knowledge_dependencies WHERE target_kind='source' AND target_id=${row}.id)
    OR EXISTS(SELECT 1 FROM knowledge_revision_dependencies WHERE target_kind='source' AND target_id=${row}.id)
    OR EXISTS(SELECT 1 FROM knowledge_evidence WHERE document_id=${row}.id)
    OR EXISTS(SELECT 1 FROM knowledge_candidate_sources WHERE document_id=${row}.id)
    OR EXISTS(SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id=${row}.id))`;
  const lifecycleFilter = (row: "NEW" | "OLD"): string =>
    `(${sourceFilter(row)} OR ${trackedEvidence(row)})`;
  // Deletion also covers candidate-only provenance. Generated mirrors are not
  // source evidence; earlier tracked provenance still overrides a relabeling.
  const deletionFilter =
    `OLD.source_id NOT IN ('${KNOWLEDGE_SOURCE_ID}','${OPEN_LOOP_SOURCE_ID}')` +
    (hasMetadata
      ? ` AND COALESCE(json_extract(OLD.metadata,'$.documentType'),'') NOT IN ('${KNOWLEDGE_DOCUMENT_TYPE}','${OPEN_LOOP_DOCUMENT_TYPE}')`
      : "");
  const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
  // Explicit UPSERT clauses survive a document UPSERT's DO UPDATE conflict
  // policy. INSERT OR IGNORE inside these triggers can instead abort an ingest
  // when a repeated source version or projection already has queued work.
  // A projection write that was already in flight may land after its owner purge.
  // Persist its document ID before the caller can crash without rechecking ownership.
  if (
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .some((column) => column.name === "external_id")
  )
    for (const event of ["INSERT", "UPDATE"] as const)
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_orphan_mirror_${event.toLowerCase()} AFTER ${event} ON documents
    WHEN NEW.source_id IN ('${KNOWLEDGE_SOURCE_ID}','${OPEN_LOOP_SOURCE_ID}')
      AND EXISTS(SELECT 1 FROM knowledge_node_tombstones WHERE id=NEW.external_id)
    BEGIN
      INSERT INTO knowledge_projection_cleanup(document_id,node_id,created_at) VALUES(NEW.id,NEW.external_id,${now}) ON CONFLICT(document_id) DO NOTHING;
    END`);

  for (const [event, condition] of [
    ["INSERT", "1"],
    ["UPDATE OF content_hash", "OLD.content_hash != NEW.content_hash"],
  ] as const) {
    const suffix = event === "INSERT" ? "insert" : "update";
    db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_source_${suffix} AFTER ${event} ON documents
      WHEN ${condition} AND ${lifecycleFilter("NEW")}
      BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM knowledge_cascade_jobs
          WHERE kind='purge' AND target_kind='source' AND target_id=NEW.id)
          THEN RAISE(ABORT,'Knowledge source purge is still pending') END;
        INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at)
          VALUES(NEW.id,NEW.content_hash,0,${now})
          ON CONFLICT(document_id) DO UPDATE SET content_hash=excluded.content_hash,deleted=0,updated_at=excluded.updated_at;
        DELETE FROM knowledge_evidence WHERE document_id=NEW.id AND content_hash!=NEW.content_hash;
        INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES(CASE WHEN ${sourceFilter("NEW")} THEN 'source_changed' ELSE 'source_evidence_changed' END,NEW.id,NEW.content_hash,${now});
        INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at)
          VALUES('invalidate','source',NEW.id,NEW.content_hash,${now})
          ON CONFLICT(kind,target_kind,target_id,revision) DO NOTHING;
        INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id)
          SELECT id,'source',NEW.id FROM knowledge_cascade_jobs
          WHERE kind='invalidate' AND target_kind='source' AND target_id=NEW.id AND revision=NEW.content_hash
          ON CONFLICT(job_id,target_kind,target_id) DO NOTHING;
      END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_source_delete AFTER DELETE ON documents
    WHEN (${deletionFilter}) OR ${trackedEvidence("OLD")}
    BEGIN
      INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at)
        VALUES(OLD.id,'',1,${now}) ON CONFLICT(document_id)
        DO UPDATE SET content_hash='',deleted=1,updated_at=excluded.updated_at;
      DELETE FROM knowledge_evidence WHERE document_id=OLD.id;
      DELETE FROM knowledge_changes WHERE entity_id=OLD.id;
      INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES('source_deleted',OLD.id,'deleted',${now});
      INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at)
        VALUES('purge','source',OLD.id,'deleted',${now})
        ON CONFLICT(kind,target_kind,target_id,revision) DO NOTHING;
      INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id)
        SELECT id,'source',OLD.id FROM knowledge_cascade_jobs
        WHERE kind='purge' AND target_kind='source' AND target_id=OLD.id AND revision='deleted'
        ON CONFLICT(job_id,target_kind,target_id) DO NOTHING;
      DELETE FROM knowledge_discovery_coverage WHERE subject_id=OLD.id;
      DELETE FROM knowledge_work WHERE subject_kind='source' AND subject_id=OLD.id;
    END`);
}
