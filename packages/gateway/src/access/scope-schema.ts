// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createScopeNativeWitnessSchema,
  createScopeNativeWitnessTriggers,
} from "./scope-native-witnesses.js";
import { createScopeFactRebuildSchema } from "./scope-fact-rebuilds.js";
import { createScopeHierarchySchema } from "./scope-hierarchy-schema.js";
import { createScopeRefreshRequirementsSchema } from "./scope-refresh-requirements.js";
import { createConversationScopeSchema } from "./scope-membership-schema.js";
import { createScopeGenerationSchema, createScopeGenerationTriggers } from "./scope-generations.js";
import type { Db } from "../data/types.js";

/** Shared by corpus and derived search storage so the evaluator is identical. */
export function createScopeFactsSchema(db: Db): void {
  createScopeGenerationSchema(db);
  createScopeNativeWitnessSchema(db);
  createScopeFactRebuildSchema(db);
  createScopeHierarchySchema(db);
  createScopeRefreshRequirementsSchema(db);
  createConversationScopeSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_fact_backfill (
      source_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      cursor_rowid INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_scope_fact_backfill_type ON scope_fact_backfill(source_type);
    CREATE TABLE IF NOT EXISTS source_scope_refreshes (
      source_id TEXT NOT NULL, kind TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      PRIMARY KEY(source_id,kind)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_scope_kind_readiness (
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
      PRIMARY KEY (source_id, kind)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS scope_backfill_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_source_id TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO scope_backfill_cursor (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS scope_subject_retries (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cursor_rowid INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO scope_subject_retries (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS document_scope_subjects (
      document_id TEXT PRIMARY KEY,
      subject_document_id TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      stream_id TEXT NOT NULL DEFAULT '',
      parent_external_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_scope_subject_target ON document_scope_subjects(subject_document_id);
    CREATE INDEX IF NOT EXISTS idx_scope_subject_pending ON document_scope_subjects(subject_document_id, provider_id, source_id, stream_id, parent_external_id);
    CREATE TABLE IF NOT EXISTS scope_entities (
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      label TEXT NOT NULL,
      parent_id TEXT,
      PRIMARY KEY (source_id, kind, entity_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS document_scope_facts (
      document_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (document_id, kind, entity_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_document_scope_facts_entity
      ON document_scope_facts(kind, entity_id, document_id);
    CREATE TABLE IF NOT EXISTS document_scope_completeness (
      document_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      PRIMARY KEY (document_id, kind)
    ) WITHOUT ROWID;
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_scope_entities_parent ON scope_entities(source_id,kind,parent_id,entity_id)",
  );
}

/** A trigger every install of the fact triggers creates on the corpus. */
const SCOPE_FACT_TRIGGER_SENTINEL = "document_scope_cleanup";

/** Whether the fact triggers are installed on this corpus. */
export function scopeFactTriggersInstalled(db: Db): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
    .get(SCOPE_FACT_TRIGGER_SENTINEL);
}

/**
 * Remove every trigger {@link createScopeFactsDocumentTriggers} creates: the
 * ones on `documents` and `sources`, which would otherwise run on every
 * ordinary write, and the ones on the fact tables themselves, so those tables
 * can be emptied without visiting each row.
 */
export function dropScopeFactTriggers(db: Db): void {
  const triggers = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND (
         name IN ('document_scope_cleanup','source_scope_cleanup','scope_native_conversation_cleanup',
                  'native_reprojection_added','native_reprojection_removed')
         OR name GLOB 'native_document_*'
         OR name GLOB 'native_witness_*'
         OR name GLOB 'scope_generation_*')`,
    )
    .all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
}

/**
 * The triggers that keep stored facts in step with documents and sources, and
 * record each change for the index. They exist only while source filters are
 * in use; see `scope-activation.ts`. Corpus-only cleanup: derived stores need
 * not own a documents table.
 */
export function createScopeFactsDocumentTriggers(db: Db): void {
  createScopeNativeWitnessTriggers(db);
  createScopeGenerationTriggers(db);
  const tableExists = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (tableExists("scope_conversations"))
    db.exec(`CREATE TRIGGER IF NOT EXISTS scope_native_conversation_cleanup
    AFTER DELETE ON scope_conversations BEGIN
      DELETE FROM scope_native_refresh_witnesses WHERE document_id=OLD.subject_document_id;
      DELETE FROM scope_native_desired_witnesses WHERE document_id=OLD.subject_document_id;
    END`);
  if (tableExists("documents"))
    db.exec(`DROP TRIGGER IF EXISTS document_scope_cleanup;
    CREATE TRIGGER document_scope_cleanup AFTER DELETE ON documents BEGIN
    DELETE FROM scope_native_refresh_witnesses WHERE document_id=OLD.id;
    DELETE FROM scope_native_desired_witnesses WHERE document_id=OLD.id;
    DELETE FROM scope_native_reprojection WHERE document_id=OLD.id;
    DELETE FROM scope_document_hierarchy WHERE document_id=OLD.id;
    DELETE FROM scope_hierarchy_dependencies WHERE document_id=OLD.id;
    DELETE FROM scope_fact_rebuilds WHERE document_id = OLD.id;
    DELETE FROM document_scope_facts WHERE document_id = OLD.id;
    DELETE FROM document_scope_completeness WHERE document_id = OLD.id;
    DELETE FROM document_scope_subjects WHERE document_id = OLD.id;
    DELETE FROM document_scope_conversations WHERE document_id = OLD.id;
    UPDATE document_scope_subjects SET subject_document_id = '' WHERE subject_document_id = OLD.id;
  END`);
  if (tableExists("sources"))
    db.exec(`DROP TRIGGER IF EXISTS source_scope_cleanup;
    CREATE TRIGGER source_scope_cleanup AFTER DELETE ON sources BEGIN
    DELETE FROM scope_native_refresh_witnesses WHERE document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM scope_native_desired_witnesses WHERE document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM scope_native_reprojection WHERE source_id=OLD.id;
    DELETE FROM scope_native_kinds WHERE source_id=OLD.id;
    DELETE FROM source_scope_refresh_requirements WHERE source_id=OLD.id;
    DELETE FROM source_scope_host_support WHERE source_id=OLD.id;
    DELETE FROM scope_document_hierarchy WHERE source_id=OLD.id;
    DELETE FROM scope_hierarchy_dependencies WHERE source_id=OLD.id;
    DELETE FROM scope_hierarchy_dirty WHERE source_id=OLD.id;
    DELETE FROM scope_hierarchy_nodes WHERE source_id=OLD.id;
    DELETE FROM scope_hierarchy_catalogues WHERE source_id=OLD.id;
    DELETE FROM scope_fact_rebuilds WHERE source_id=OLD.id;
    DELETE FROM scope_conversation_identifier_counts WHERE subject_document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM scope_conversation_rebuilds WHERE subject_document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM scope_conversation_members WHERE subject_document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM document_scope_facts WHERE document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM document_scope_completeness WHERE document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM document_scope_conversations WHERE subject_document_id IN (SELECT subject_document_id FROM scope_conversations WHERE source_id=OLD.id);
    DELETE FROM scope_conversations WHERE source_id=OLD.id;
    DELETE FROM scope_fact_backfill WHERE source_id = OLD.id;
    DELETE FROM source_scope_kind_readiness WHERE source_id = OLD.id;
    DELETE FROM source_scope_refreshes WHERE source_id = OLD.id;
    DELETE FROM scope_entities WHERE source_id = OLD.id;
    DELETE FROM document_scope_subjects WHERE source_id = OLD.id;
  END`);
}
