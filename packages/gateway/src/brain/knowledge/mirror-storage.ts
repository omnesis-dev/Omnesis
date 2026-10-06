// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import type Database from "better-sqlite3";

/** Persist original document IDs before either corpus or index deletion can commit. */
export function queueKnowledgeProjectionCleanup(
  db: Database.Database,
  nodeIds: readonly string[],
  now: number,
): void {
  if (nodeIds.length > 100)
    throw new Error("Projection cleanup accepts at most 100 nodes per writer slice");
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
  if (
    !columns.some((column) => column.name === "source_id") ||
    !columns.some((column) => column.name === "external_id")
  )
    return;
  const insert =
    db.prepare(`INSERT OR IGNORE INTO knowledge_projection_cleanup(document_id,node_id,created_at)
    SELECT id,external_id,? FROM documents WHERE external_id=? AND source_id IN (?,?)`);
  for (const id of nodeIds) insert.run(now, id, KNOWLEDGE_SOURCE_ID, OPEN_LOOP_SOURCE_ID);
}
export function ackKnowledgeProjectionCleanup(
  db: Database.Database,
  documentIds: readonly string[],
): void {
  if (documentIds.length > 100)
    throw new Error("Projection cleanup acknowledges at most 100 documents per slice");
  const remove = db.prepare("DELETE FROM knowledge_projection_cleanup WHERE document_id=?");
  for (const id of documentIds) remove.run(id);
}
export function listKnowledgeProjectionCleanup(
  db: Database.Database,
  limit = 100,
): Array<{ documentId: string; nodeId: string }> {
  return db
    .prepare<
      [number],
      { documentId: string; nodeId: string }
    >("SELECT document_id AS documentId,node_id AS nodeId FROM knowledge_projection_cleanup ORDER BY created_at,document_id LIMIT ?")
    .all(Math.max(1, Math.min(100, limit)));
}
