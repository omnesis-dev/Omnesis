// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readKnowledgeSourceRevision } from "./source-revision.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import type Database from "better-sqlite3";

const MAX_RECEIPT_DOCUMENTS = 16;
const MAX_ANNOTATION_DOCUMENTS = 128;
export interface TemporalDocumentReceipt {
  version: 1;
  reset: number;
  documents: Array<{ id: string; epoch: number; sourceId: string; sourceRevision: string }>;
}

/** Monotone document partitions. Unbounded legacy fanout conservatively resets every receipt. */
export function installTemporalDocumentEpochs(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_temporal_document_epochs (
    document_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS knowledge_temporal_epoch_reset (
    id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL DEFAULT 0
  ); INSERT OR IGNORE INTO knowledge_temporal_epoch_reset(id) VALUES(1)`);
  const exists = (table: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists("temporal_annotation_documents") || !exists("documents")) return;
  const direct = (id: string) => `INSERT INTO knowledge_temporal_document_epochs(document_id,epoch)
    SELECT id,1 FROM documents WHERE id=${id}
    ON CONFLICT(document_id) DO UPDATE SET epoch=epoch+1;`;
  const linked = (id: string) => {
    // Bound before filtering readable documents; stale links cannot turn a huge
    // legacy annotation into an unbounded writer scan.
    const rows = `SELECT document_id FROM temporal_annotation_documents WHERE annotation_id=${id} LIMIT ${MAX_ANNOTATION_DOCUMENTS + 1}`;
    const count = `(SELECT COUNT(*) FROM (${rows}))`;
    return `UPDATE knowledge_temporal_epoch_reset SET generation=generation+1 WHERE ${count}>${MAX_ANNOTATION_DOCUMENTS};
      INSERT INTO knowledge_temporal_document_epochs(document_id,epoch)
      SELECT d.document_id,1 FROM (${rows}) d JOIN documents doc ON doc.id=d.document_id
      WHERE ${count}<=${MAX_ANNOTATION_DOCUMENTS}
      ON CONFLICT(document_id) DO UPDATE SET epoch=epoch+1;`;
  };
  for (const table of [
    "temporal_annotations",
    "temporal_annotation_documents",
    "temporal_annotation_loops",
    "temporal_annotation_people",
    "temporal_annotation_projections",
    "temporal_annotation_evidence",
  ]) {
    if (!exists(table)) continue;
    for (const [timing, operation, row] of [
      ["AFTER", "INSERT", "NEW"],
      ["BEFORE", "DELETE", "OLD"],
      ["BEFORE", "UPDATE", "OLD"],
      ["AFTER", "UPDATE", "NEW"],
    ] as const) {
      const id = table === "temporal_annotations" ? `${row}.id` : `${row}.annotation_id`;
      const extra =
        table === "temporal_annotation_documents"
          ? `${row}.document_id`
          : table === "temporal_annotation_evidence"
            ? `${row}.document_id`
            : undefined;
      db.exec(`CREATE TRIGGER IF NOT EXISTS temporal_epoch_${table}_${timing.toLowerCase()}_${operation.toLowerCase()}
        ${timing} ${operation} ON ${table} BEGIN ${linked(id)} ${extra ? direct(extra) : ""} END`);
    }
  }
  // Source-filtered annotation queries inspect every linked document, not just
  // their documentIds filter. Keep those reads on the global fence, and include
  // source membership changes which do not themselves mutate an annotation.
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='temporal_annotation_documents'",
      )
      .get() &&
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .some((column) => column.name === "source_id")
  ) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_temporal_source_${operation.toLowerCase()}
        ${operation === "DELETE" ? "BEFORE" : "AFTER"} ${operation} ON documents
        WHEN ${operation === "UPDATE" ? "(OLD.source_id IS NOT NEW.source_id OR OLD.id IS NOT NEW.id) AND " : ""}
          EXISTS(SELECT 1 FROM temporal_annotation_documents WHERE document_id IN (${operation === "UPDATE" ? "OLD.id,NEW.id" : `${row}.id`}))
        BEGIN UPDATE knowledge_reconciliation_revisions SET revision=revision+1 WHERE collection='temporal'; END`);
    }
  }
  // Erase private keys without letting deleted/recreated identities reset an
  // outstanding negative-read receipt to zero. Later cascade triggers only
  // touch document IDs that still exist, so cannot recreate erased keys.
  db.exec(`CREATE TRIGGER IF NOT EXISTS temporal_epoch_document_delete BEFORE DELETE ON documents BEGIN
    UPDATE knowledge_temporal_epoch_reset SET generation=generation+1;
  END; CREATE TRIGGER IF NOT EXISTS temporal_epoch_document_identity AFTER UPDATE OF source_id,id ON documents
    WHEN OLD.source_id IS NOT NEW.source_id OR OLD.id IS NOT NEW.id BEGIN
    UPDATE knowledge_temporal_epoch_reset SET generation=generation+1;
    DELETE FROM knowledge_temporal_document_epochs WHERE document_id=OLD.id AND OLD.id IS NOT NEW.id;
  END; CREATE TRIGGER IF NOT EXISTS temporal_epoch_document_erased AFTER DELETE ON documents BEGIN
    DELETE FROM knowledge_temporal_document_epochs WHERE document_id=OLD.id;
  END`);
}

/** Capture before the query; compare again afterwards and atomically at commit. */
export function captureTemporalDocumentReceipt(
  db: Database.Database,
  documentIds: unknown,
): TemporalDocumentReceipt | null {
  if (
    !Array.isArray(documentIds) ||
    documentIds.length === 0 ||
    documentIds.length > MAX_RECEIPT_DOCUMENTS ||
    documentIds.some((id) => typeof id !== "string" || !id)
  )
    return null;
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_temporal_epoch_reset'",
      )
      .get()
  )
    return null;
  const ids = [...new Set(documentIds as string[])].sort();
  return db.transaction(() => {
    const reset = db
      .prepare<[], { generation: number }>(
        "SELECT generation FROM knowledge_temporal_epoch_reset WHERE id=1",
      )
      .get();
    if (!reset) return null;
    const lookup = db.prepare<[string], { source_id: string; epoch: number }>(
      `SELECT d.source_id,COALESCE(e.epoch,0) epoch FROM documents d LEFT JOIN knowledge_temporal_document_epochs e ON e.document_id=d.id WHERE d.id=?`,
    );
    const documents: TemporalDocumentReceipt["documents"] = [];
    for (const id of ids) {
      const row = lookup.get(id);
      const sourceRevision = readKnowledgeSourceRevision(db, id);
      if (!row || sourceRevision === null || !isKnowledgeEvidenceReadable(db, id)) return null;
      documents.push({ id, epoch: row.epoch, sourceId: row.source_id, sourceRevision });
    }
    return { version: 1 as const, reset: reset.generation, documents };
  })();
}

export function temporalDocumentReceiptCurrent(
  db: Database.Database,
  receipt: TemporalDocumentReceipt,
): boolean {
  if (receipt.version !== 1) return false;
  const current = captureTemporalDocumentReceipt(
    db,
    receipt.documents.map((doc) => doc.id),
  );
  return current !== null && JSON.stringify(current) === JSON.stringify(receipt);
}
