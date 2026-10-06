// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Called by the shared schema migration. These tables use the gateway's encrypted store. */
export function createKnowledgeTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('wiki','root','loop','doc_annotation','person_annotation','brief')),
      owner_id TEXT,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      revision INTEGER NOT NULL,
      meaning_revision INTEGER NOT NULL,
      meaning_hash TEXT NOT NULL,
      validity TEXT NOT NULL CHECK(validity IN ('current','stale')),
      metadata_json TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_single_root ON knowledge_nodes(kind) WHERE kind='root';
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_owner ON knowledge_nodes(kind,owner_id) WHERE owner_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS knowledge_claims (
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      text TEXT NOT NULL,
      parent_id TEXT,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      support_logic TEXT NOT NULL,
      verification TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      meaning_revision INTEGER NOT NULL,
      meaning_hash TEXT NOT NULL,
      verifier TEXT,
      witness_refs_json TEXT NOT NULL DEFAULT '[]',
      valid_from INTEGER,
      valid_until INTEGER,
      PRIMARY KEY(node_id,id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_dependencies (
      node_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('source','node')),
      relation TEXT NOT NULL,
      input_version_json TEXT NOT NULL,
      PRIMARY KEY(node_id,claim_id,ref),
      FOREIGN KEY(node_id,claim_id) REFERENCES knowledge_claims(node_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS knowledge_dependents ON knowledge_dependencies(target_kind,target_id);
    CREATE TABLE IF NOT EXISTS knowledge_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, previous_revision INTEGER NOT NULL,
      title TEXT NOT NULL, markdown TEXT NOT NULL, plain_text TEXT NOT NULL,
      fields_json TEXT NOT NULL, validity TEXT NOT NULL,
      claims_json TEXT NOT NULL, diff_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(node_id,revision)
    );
    CREATE TABLE IF NOT EXISTS knowledge_revision_dependencies (
      node_id TEXT NOT NULL, revision INTEGER NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      PRIMARY KEY(node_id,revision,target_kind,target_id),
      FOREIGN KEY(node_id,revision) REFERENCES knowledge_revisions(node_id,revision) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS knowledge_revision_dependents ON knowledge_revision_dependencies(target_kind,target_id);
    CREATE TABLE IF NOT EXISTS knowledge_owner_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
      operation TEXT NOT NULL, changed_at INTEGER NOT NULL, UNIQUE(kind,owner_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_owner_write_guard (kind TEXT NOT NULL, owner_id TEXT NOT NULL, PRIMARY KEY(kind,owner_id));
    CREATE TABLE IF NOT EXISTS knowledge_projection_cleanup (document_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_owner_withdraw_guard (owner_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS knowledge_owner_retire_guard (owner_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS knowledge_retired_loop_sources (loop_id TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(loop_id,document_id));
    CREATE INDEX IF NOT EXISTS knowledge_retired_source ON knowledge_retired_loop_sources(document_id,loop_id);
    CREATE TABLE IF NOT EXISTS knowledge_node_tombstones (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_cascade_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, revision TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(kind,target_kind,target_id,revision)
    );
    CREATE TABLE IF NOT EXISTS knowledge_cascade_frontier (
      job_id INTEGER NOT NULL REFERENCES knowledge_cascade_jobs(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, after_node_id TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,target_kind,target_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_cascade_work ON knowledge_cascade_frontier(job_id,done);
    CREATE TABLE IF NOT EXISTS knowledge_evidence (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      quote TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_evidence_document ON knowledge_evidence(document_id);
    CREATE TABLE IF NOT EXISTS knowledge_source_revisions (
      document_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  if (
    !(db.prepare("PRAGMA table_info(knowledge_claims)").all() as Array<{ name: string }>).some(
      (column) => column.name === "witness_refs_json",
    )
  ) {
    db.exec("ALTER TABLE knowledge_claims ADD COLUMN witness_refs_json TEXT NOT NULL DEFAULT '[]'");
    // An older experimental proof did not retain its accepted alternative.
    db.exec(
      "UPDATE knowledge_claims SET verification='unverified',verifier=NULL WHERE support_logic='any' AND verification='verified'",
    );
  }
}
