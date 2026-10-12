// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { BrainBench } from "./bench.js";

export interface InitialInventoryReport {
  documentCount: number;
  sourceChangeCount: number;
  sourceChangeHighWater: number;
}

/**
 * Fixture initialization, not maintenance: model an existing corpus predating
 * inventory-aware Brain ingestion. Call only while the isolated gateway is stopped, after real
 * source ingestion with experimental cognition disabled. No started work may be
 * discarded, and no discovery/verification result is fabricated. Coverage stays
 * empty so an explicitly enabled historical bootstrap can discover this corpus.
 */
export function checkpointInitialInventory(db: Database.Database): InitialInventoryReport {
  return db.transaction(() => {
    for (const table of [
      "knowledge_work",
      "knowledge_batches",
      "knowledge_nodes",
      "knowledge_discovery_coverage",
      "knowledge_candidates",
      "cognition_runs",
    ]) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw new Error(`Initial inventory requires an untouched brain: ${table} is populated`);
    }
    if (db.prepare("SELECT 1 FROM knowledge_changes WHERE kind!='source_changed' LIMIT 1").get())
      throw new Error("Initial inventory contains changes other than source arrivals");
    const report: InitialInventoryReport = {
      documentCount: db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM documents")
        .get()!.count,
      sourceChangeCount: db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM knowledge_changes")
        .get()!.count,
      sourceChangeHighWater: db
        .prepare<[], { seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM knowledge_changes")
        .get()!.seq,
    };
    // This fixture predates inventory-aware ingestion, so it has no initial-import
    // provenance. Clear only that metadata, without inventing discovery completion.
    // New-version imports made with Brain disabled intentionally retain provenance.
    db.prepare("DELETE FROM source_inventory_documents").run();
    db.prepare("DELETE FROM source_inventories").run();
    // The report makes this explicit fixture boundary durable and inspectable.
    // Evidence, source revisions, pending privacy cascades and indexing survive.
    db.prepare(
      "INSERT INTO knowledge_checkpoints(id,value_json,revision,updated_at) VALUES('fixture:initial-inventory',?,1,0)",
    ).run(JSON.stringify(report));
    const removed = db
      .prepare("DELETE FROM knowledge_changes WHERE kind='source_changed' AND seq<=?")
      .run(report.sourceChangeHighWater);
    if (removed.changes !== report.sourceChangeCount)
      throw new Error("Initial inventory journal changed while checkpointing");
    return report;
  })();
}

/** Persisted corpus predates live journal intake. Only this fixture's arrival
 * journal is removed, atomically with insertion; actual historical discovery
 * still has to admit, fetch and cover the document through production tools.
 */
export function seedHistory(
  bench: Pick<BrainBench, "withWriteHandle">,
  doc: { id: string; title: string; content: string; at: number; sourceId: string },
): string {
  const stamp = new Date(doc.at).toISOString();
  const hash = createHash("sha256").update(doc.content).digest("hex");
  bench.withWriteHandle((db) => {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO documents
        (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
         source_created_at,source_updated_at,ingested_at,updated_at,
         links_extracted_at,people_resolved_at,dates_extracted_at)
        VALUES (?,'synthetic',?,?,?,?,?,'{"documentType":"document"}',?,?,?,?,?,?,?)`,
      ).run(
        doc.id,
        doc.sourceId,
        doc.id,
        doc.title,
        doc.content,
        hash,
        stamp,
        stamp,
        stamp,
        stamp,
        stamp,
        stamp,
        stamp,
      );
      db.prepare("DELETE FROM knowledge_changes WHERE kind='source_changed' AND entity_id=?").run(
        doc.id,
      );
    })();
  });
  return doc.id;
}

export function historicalAdmissions(bench: BrainBench): Array<{
  subject_id: string;
  input_revision: string;
  status: string;
  created_at: number;
}> {
  return bench.sql
    .prepare<
      [],
      {
        subject_id: string;
        input_revision: string;
        status: string;
        created_at: number;
      }
    >(
      `SELECT subject_id,input_revision,status,created_at FROM knowledge_work
       WHERE reason IN ('discovery','upgrade') ORDER BY created_at,rowid`,
    )
    .all();
}
