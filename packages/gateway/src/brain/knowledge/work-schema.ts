// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Work records retain identities and revisions, never copies of source or generated prose. */
export function createKnowledgeWorkTables(db: Database.Database): void {
  const admissionsExist = !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_historical_admissions'",
    )
    .get();
  const operationalExists = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_operational_arcs'")
    .get();
  db.exec(`
    CREATE INDEX IF NOT EXISTS knowledge_nodes_kind_id ON knowledge_nodes(kind,id);
    CREATE TABLE IF NOT EXISTS knowledge_operational_arcs (
      input_id TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      PRIMARY KEY(input_id,node_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_operational_node ON knowledge_operational_arcs(node_id);
    CREATE TRIGGER IF NOT EXISTS knowledge_operational_insert AFTER INSERT ON knowledge_nodes
    WHEN NEW.kind='loop' BEGIN
      INSERT OR IGNORE INTO knowledge_operational_arcs(input_id,node_id)
      SELECT value,NEW.id FROM json_each(NEW.fields_json,'$.blockedBy') WHERE type='text';
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_operational_update AFTER UPDATE OF fields_json,kind ON knowledge_nodes BEGIN
      DELETE FROM knowledge_operational_arcs WHERE node_id=NEW.id;
      INSERT OR IGNORE INTO knowledge_operational_arcs(input_id,node_id)
      SELECT value,NEW.id FROM json_each(NEW.fields_json,'$.blockedBy') WHERE NEW.kind='loop' AND type='text';
    END;
    CREATE TABLE IF NOT EXISTS knowledge_work (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('source','node')),
      reason TEXT NOT NULL CHECK(reason IN ('change','discovery','review','root','upgrade')),
      input_revision TEXT NOT NULL,
      input_changed_at INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      tier TEXT NOT NULL CHECK(tier IN ('immediate','soon','routine')),
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','batched','completed','deferred')),
      batch_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_work_pending
      ON knowledge_work(subject_kind,subject_id,reason) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS knowledge_work_subject ON knowledge_work(subject_kind,subject_id,input_revision);
    CREATE INDEX IF NOT EXISTS knowledge_work_historical ON knowledge_work(status,due_at,created_at,id) WHERE reason IN ('discovery','upgrade');
    CREATE INDEX IF NOT EXISTS knowledge_work_due ON knowledge_work(status,due_at,id);
    CREATE TABLE IF NOT EXISTS knowledge_historical_admissions (
      day TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count>=0)
    );
    CREATE TABLE IF NOT EXISTS knowledge_batches (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      creation_fingerprint TEXT NOT NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','deferred','abandoned')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS knowledge_batch_regions (
      batch_id TEXT NOT NULL REFERENCES knowledge_batches(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      PRIMARY KEY(batch_id,node_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_region_owners ON knowledge_batch_regions(node_id,batch_id);
    CREATE TABLE IF NOT EXISTS knowledge_frontier (
      batch_id TEXT NOT NULL REFERENCES knowledge_batches(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      input_versions_json TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','offered','skipped','unchanged','changed','deferred')),
      result_revision INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(batch_id,node_id,input_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS knowledge_frontier_pending ON knowledge_frontier(batch_id,status,depth);
    CREATE TABLE IF NOT EXISTS knowledge_discovery_targets (
      source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      source_revision TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(source_id,source_revision,node_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_discovery_target_nodes ON knowledge_discovery_targets(node_id,source_id);
    CREATE TABLE IF NOT EXISTS knowledge_discovery_coverage (
      subject_id TEXT NOT NULL,
      input_revision TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('interpretation','organization','conversion')),
      policy_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('considered','gated','deferred','failed')),
      reviewed_at INTEGER NOT NULL,
      reconsider_at INTEGER,
      PRIMARY KEY(subject_id,input_revision,phase,policy_version)
    );
    CREATE TABLE IF NOT EXISTS knowledge_candidates (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      scope TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('proposed','deferred','published','merged','dismissed')),
      node_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reconsider_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS knowledge_candidate_sources (
      document_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL REFERENCES knowledge_candidates(id) ON DELETE CASCADE,
      PRIMARY KEY(document_id,candidate_id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_candidate_source_owner ON knowledge_candidate_sources(candidate_id);
    CREATE TRIGGER IF NOT EXISTS knowledge_candidate_sources_insert AFTER INSERT ON knowledge_candidates BEGIN
      INSERT INTO knowledge_candidate_sources(document_id,candidate_id)
        SELECT value,NEW.id FROM json_each(NEW.evidence_ids_json) WHERE type='text'
        ON CONFLICT(document_id,candidate_id) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_candidate_sources_update AFTER UPDATE OF evidence_ids_json ON knowledge_candidates BEGIN
      DELETE FROM knowledge_candidate_sources WHERE candidate_id=NEW.id;
      INSERT INTO knowledge_candidate_sources(document_id,candidate_id)
        SELECT value,NEW.id FROM json_each(NEW.evidence_ids_json) WHERE type='text'
        ON CONFLICT(document_id,candidate_id) DO NOTHING;
    END;
    CREATE TABLE IF NOT EXISTS knowledge_links (
      from_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('related_to','belongs_to_project','part_of','supersedes','duplicate_of')),
      PRIMARY KEY(from_id,to_id,kind)
    );
    CREATE TABLE IF NOT EXISTS knowledge_checkpoints (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (!operationalExists)
    db.exec(`
    INSERT OR IGNORE INTO knowledge_operational_arcs(input_id,node_id)
      SELECT j.value,n.id FROM knowledge_nodes n,json_each(n.fields_json,'$.blockedBy') j
      WHERE n.kind='loop' AND j.type='text';
  `);
  if (!admissionsExist)
    db.exec(`INSERT INTO knowledge_historical_admissions(day,count)
    SELECT date(created_at/1000,'unixepoch','localtime'),COUNT(*) FROM knowledge_work
    WHERE subject_kind='source' AND reason IN ('discovery','upgrade')
    GROUP BY date(created_at/1000,'unixepoch','localtime')`);
}
