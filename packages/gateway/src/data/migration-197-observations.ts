// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 197: briefs become observations.
 *
 * Phase one runs with foreign keys on, so knowledge claims and revisions
 * cascade with their nodes: it purges every brief synthesis node through the
 * knowledge cascade (tombstones and mirror cleanup included), removes brief
 * bookkeeping, unsettled feedback runs about briefs, and drops the brief
 * tables. Phase two rebuilds `knowledge_nodes` so its kind constraint names
 * observations; that rebuild needs foreign keys off and legacy ALTER
 * semantics so child references keep pointing at the recreated table. Each
 * phase is idempotent, so a crash between them re-runs safely.
 */

import { createLogger } from "@omnesis/core";
import { purgeKnowledgeNode } from "../brain/knowledge/storage-invalidation.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway:migrations").child("197");

function tableExists(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

function inTransaction(db: Db, body: () => void): void {
  db.exec("BEGIN");
  try {
    body();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      log.warn(
        `rollback skipped (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`,
      );
    }
    throw err;
  }
}

function retireBriefData(db: Db, now: number): void {
  if (tableExists(db, "knowledge_nodes")) {
    const briefNodes = db
      .prepare<[], { id: string }>("SELECT id FROM knowledge_nodes WHERE kind='brief'")
      .all()
      .map((row) => row.id);
    for (const id of briefNodes) purgeKnowledgeNode(db, id, now);
    // A purge enqueues an owner purge for kind 'brief', which no longer has a table.
    db.prepare("DELETE FROM knowledge_owner_changes WHERE kind='brief'").run();
    db.prepare("DELETE FROM knowledge_owner_write_guard WHERE kind='brief'").run();
  }
  if (tableExists(db, "knowledge_reconciliation_revisions"))
    db.prepare("DELETE FROM knowledge_reconciliation_revisions WHERE collection='brief'").run();
  if (tableExists(db, "cognition_consumption_edges"))
    db.prepare("DELETE FROM cognition_consumption_edges WHERE dependent_kind='brief'").run();
  if (tableExists(db, "cognition_runs"))
    db.prepare(
      `DELETE FROM cognition_runs
        WHERE kind='feedback' AND status='pending'
          AND json_valid(payload_json)
          AND (json_extract(payload_json,'$.briefId') IS NOT NULL
            OR json_extract(payload_json,'$.recheckDependentKind') = 'brief')`,
    ).run();
  // Queued brief notifications name a kind clients no longer route; their
  // deliveries cascade with them.
  if (tableExists(db, "notifications"))
    db.prepare("DELETE FROM notifications WHERE kind='brief'").run();
  if (tableExists(db, "cognition_sweep_tally")) {
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_sweep_tally')")
      .all()
      .map((c) => c.name);
    if (columns.includes("briefs_created") && !columns.includes("observations_noted"))
      db.exec(
        "ALTER TABLE cognition_sweep_tally RENAME COLUMN briefs_created TO observations_noted",
      );
    if (columns.includes("briefs_held"))
      db.exec("ALTER TABLE cognition_sweep_tally DROP COLUMN briefs_held");
  }
  for (const trigger of ["insert", "update", "delete"])
    db.exec(`DROP TRIGGER IF EXISTS knowledge_owner_brief_${trigger}`);
  for (const table of ["brief_claims", "brief_related_loops", "brief_citations", "briefs"])
    db.exec(`DROP TABLE IF EXISTS ${table}`);
}

function rebuildKnowledgeNodes(db: Db): void {
  const current = db
    .prepare<
      [],
      { sql: string }
    >("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'")
    .get();
  if (!current || !current.sql.includes("'brief'")) return;
  const dependents = db
    .prepare<[], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE tbl_name='knowledge_nodes' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all()
    .map((row) => row.sql!);
  db.exec("ALTER TABLE knowledge_nodes RENAME TO knowledge_nodes_v196");
  db.exec(current.sql.replace("'brief'", "'observation'"));
  db.exec("INSERT INTO knowledge_nodes SELECT * FROM knowledge_nodes_v196");
  db.exec("DROP TABLE knowledge_nodes_v196");
  for (const sql of dependents) db.exec(sql);
  for (const table of ["knowledge_nodes", "knowledge_claims", "knowledge_revisions"]) {
    if (!tableExists(db, table)) continue;
    const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
    if (violations.length > 0)
      throw new Error(
        `foreign_key_check(${table}) found ${violations.length} violation(s) after the rebuild`,
      );
  }
}

export function retireBriefsForObservations(db: Db): void {
  const now = Date.now();
  inTransaction(db, () => retireBriefData(db, now));
  const fkWasOn =
    (db.prepare<[], { foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys ?? 0) ===
    1;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  try {
    inTransaction(db, () => rebuildKnowledgeNodes(db));
  } finally {
    db.exec("PRAGMA legacy_alter_table = OFF");
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
  }
}
