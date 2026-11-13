// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

export const SCOPE_REPLAY_ACK_BATCH_SIZE = 1000;

export interface ScopeSourceGeneration {
  sourceId: string;
  epoch: string;
  generation: number;
}

/** A fresh epoch at every gateway boot fences index files surviving a corpus restore. */
export function initializeScopeGenerationEpoch(db: Db): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE scope_generation_clock SET epoch = lower(hex(randomblob(16))), generation = generation + 1 WHERE id = 1",
    ).run();
    db.prepare(
      `INSERT INTO scope_source_generations(source_id, generation)
      SELECT source_id, (SELECT generation FROM scope_generation_clock WHERE id = 1) FROM scope_fact_backfill WHERE 1
      ON CONFLICT(source_id) DO UPDATE SET generation = excluded.generation`,
    ).run();
    db.prepare(
      "UPDATE scope_source_generations SET generation = (SELECT generation FROM scope_generation_clock WHERE id = 1)",
    ).run();
  })();
}

export function createScopeGenerationSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_generation_clock (
    id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  );
  INSERT OR IGNORE INTO scope_generation_clock VALUES (1, lower(hex(randomblob(16))), 0);
  CREATE TABLE IF NOT EXISTS scope_source_generations (
    source_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991)
  );
  CREATE TABLE IF NOT EXISTS scope_replay_dirty (
    source_id TEXT NOT NULL, kind TEXT NOT NULL, subject_document_id TEXT NOT NULL,
    generation INTEGER NOT NULL, PRIMARY KEY(source_id,kind,subject_document_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_scope_replay_dirty_generation ON scope_replay_dirty(source_id,generation);`);
}

function markSql(sourceExpression: string, subjectExpression = "''", kind = "state"): string {
  return `UPDATE scope_generation_clock SET generation = generation + 1 WHERE id = 1;
    INSERT INTO scope_source_generations(source_id,generation)
      SELECT ${sourceExpression}, generation FROM scope_generation_clock WHERE id = 1 AND ${sourceExpression} IS NOT NULL
      ON CONFLICT(source_id) DO UPDATE SET generation=excluded.generation;
    INSERT INTO scope_replay_dirty(source_id,kind,subject_document_id,generation)
      SELECT ${sourceExpression}, '${kind}', ${subjectExpression}, generation FROM scope_generation_clock WHERE id=1 AND ${sourceExpression} IS NOT NULL
      ON CONFLICT(source_id,kind,subject_document_id) DO UPDATE SET generation=excluded.generation;`;
}

/**
 * Request a full topology replay. The caller first revokes affected completeness
 * or activates a refresh in the same transaction; a generation alone is not an
 * ongoing invalidation. Ordinary fact writes already queue only their subject.
 */
export function markScopeSourceChanged(db: Db, sourceId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE scope_generation_clock SET generation = generation + 1 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO scope_source_generations(source_id,generation)
      SELECT ?, generation FROM scope_generation_clock WHERE id=1
      ON CONFLICT(source_id) DO UPDATE SET generation=excluded.generation`,
    ).run(sourceId);
    db.prepare(
      `INSERT INTO scope_replay_dirty(source_id,kind,subject_document_id,generation)
      SELECT ?, 'rebuild', '', generation FROM scope_generation_clock WHERE id=1
      ON CONFLICT(source_id,kind,subject_document_id) DO UPDATE SET generation=excluded.generation`,
    ).run(sourceId);
  })();
}

/** A newer mutation or a different boot epoch is never acknowledged by an old replay. */
export function acknowledgeScopeReplay(db: Db, completed: ScopeSourceGeneration): number {
  return db
    .prepare(
      `DELETE FROM scope_replay_dirty WHERE (source_id,kind,subject_document_id) IN (
      SELECT source_id,kind,subject_document_id FROM scope_replay_dirty WHERE source_id=? AND generation<=? LIMIT ${SCOPE_REPLAY_ACK_BATCH_SIZE})
    AND EXISTS(SELECT 1 FROM scope_generation_clock WHERE id=1 AND epoch=?)`,
    )
    .run(completed.sourceId, completed.generation, completed.epoch).changes;
}

/** Missing source state is never a matching mirror generation. Bounded by policy count. */
export function readScopeSourceGenerations(
  db: Db,
  sourceIds: readonly string[],
): ScopeSourceGeneration[] {
  return db.transaction(() => {
    const clock = db
      .prepare<[], { epoch: string }>("SELECT epoch FROM scope_generation_clock WHERE id = 1")
      .get();
    if (!clock)
      return [...new Set(sourceIds)].map((sourceId) => ({ sourceId, epoch: "", generation: -1 }));
    const read = db.prepare<[string], { generation: number }>(
      "SELECT generation FROM scope_source_generations WHERE source_id = ?",
    );
    return [...new Set(sourceIds)].map((sourceId) => ({
      sourceId,
      epoch: clock.epoch,
      generation: read.get(sourceId)?.generation ?? -1,
    }));
  })();
}

/** Triggers make facts, readiness and replay invalidation one atomic corpus write. */
export function createScopeGenerationTriggers(db: Db): void {
  const exists = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const virtual = exists("scope_conversations");
  const resolve = (id: string) =>
    `(SELECT source_id FROM documents WHERE id=${id}${virtual ? ` UNION ALL SELECT source_id FROM scope_conversations WHERE subject_document_id=${id}` : ""} LIMIT 1)`;
  const tables: Array<[string, string]> = [
    ["documents", "source_id"],
    ["sources", "id"],
    ["scope_fact_backfill", "source_id"],
    ["source_scope_kind_readiness", "source_id"],
    ["source_scope_refreshes", "source_id"],
    ["scope_hierarchy_dirty", "source_id"],
    ["source_scope_refresh_requirements", "source_id"],
    ["scope_native_reprojection_sources", "source_id"],
    ["document_scope_facts", "document_id"],
    ["document_scope_completeness", "document_id"],
    ["document_scope_subjects", "document_id"],
    ["document_scope_conversations", "document_id"],
    ["scope_hierarchy_dependencies", "document_id"],
    ["scope_native_refresh_witnesses", "document_id"],
    ["scope_conversations", "source_id"],
    ["scope_conversation_members", "subject_document_id"],
    ["scope_entities", "source_id"],
  ];
  if (!exists("documents")) {
    for (const [table] of tables) {
      for (const event of ["insert", "update", "delete", "move"])
        db.exec(`DROP TRIGGER IF EXISTS scope_generation_${table}_${event}`);
    }
    return;
  }
  for (const [table, key] of tables) {
    if (
      !exists(table) ||
      (!exists("documents") && (key === "document_id" || key === "subject_document_id"))
    )
      continue;
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      const source =
        key === "document_id" || key === "subject_document_id"
          ? resolve(`${row}.${key}`)
          : `${row}.${key}`;
      const subject =
        table === "scope_hierarchy_dirty"
          ? `json_array(${row}.kind,${row}.entity_id)`
          : table === "documents"
            ? `${row}.id`
            : table === "scope_conversations" || key === "subject_document_id"
              ? `${row}.subject_document_id`
              : key === "document_id"
                ? `${row}.document_id`
                : "''";
      const kind =
        table === "scope_hierarchy_dirty"
          ? "hierarchy"
          : table === "sources"
            ? "rebuild"
            : subject === "''"
              ? "state"
              : "subject";
      db.exec(`DROP TRIGGER IF EXISTS scope_generation_${table}_${event.toLowerCase()}`);
      const registered =
        table === "scope_fact_backfill"
          ? "1"
          : `(EXISTS(SELECT 1 FROM scope_fact_backfill sg WHERE sg.source_id=${source}) OR EXISTS(SELECT 1 FROM scope_source_generations sg WHERE sg.source_id=${source}))`;
      db.exec(`CREATE TRIGGER scope_generation_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} WHEN ${registered} BEGIN ${markSql(source, subject, kind)} END`);
      if (event === "UPDATE" && key === "source_id") {
        db.exec(`DROP TRIGGER IF EXISTS scope_generation_${table}_move`);
        db.exec(`CREATE TRIGGER scope_generation_${table}_move
          AFTER UPDATE OF source_id ON ${table} WHEN OLD.source_id IS NOT NEW.source_id AND EXISTS(SELECT 1 FROM scope_source_generations WHERE source_id=OLD.source_id)
          BEGIN ${markSql("OLD.source_id", table === "scope_hierarchy_dirty" ? "json_array(OLD.kind,OLD.entity_id)" : table === "documents" ? "OLD.id" : table === "scope_conversations" ? "OLD.subject_document_id" : "''", table === "scope_hierarchy_dirty" ? "hierarchy" : table === "documents" || table === "scope_conversations" ? "subject" : "state")} END`);
      }
    }
  }
}

/** Source mutations never alter stable task ownership; capture/check this separate run fence. */
export function changedScopeSources(
  expected: readonly ScopeSourceGeneration[],
  current: readonly ScopeSourceGeneration[],
): string[] {
  return expected
    .filter((before) => {
      const after = current.find((entry) => entry.sourceId === before.sourceId);
      return (
        before.generation < 0 ||
        !after ||
        after.epoch !== before.epoch ||
        after.generation !== before.generation
      );
    })
    .map((entry) => entry.sourceId);
}
