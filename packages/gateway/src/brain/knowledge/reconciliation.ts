// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeOwnerKind } from "./owner-adapters.js";
import type Database from "better-sqlite3";

export type KnowledgeCollection = KnowledgeOwnerKind | "wiki" | "temporal";
export interface KnowledgeReconciliationReceipt {
  collection: KnowledgeCollection;
  revision: number;
}

/** Monotone even across deletion/recreation, including writes outside maintenance. */
export function installKnowledgeReconciliationTriggers(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_reconciliation_revisions (
    collection TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
  )`);
  const tables: Array<[KnowledgeCollection, string]> = [
    ["loop", "open_loops"],
    ["loop", "open_loop_docs"],
    ["loop", "open_loop_people"],
    ["loop", "open_loop_ledger"],
    ["loop", "retired_loops"],
    ["loop", "knowledge_retired_loop_sources"],
    ["brief", "briefs"],
    ["brief", "brief_citations"],
    ["brief", "brief_related_loops"],
    ["brief", "brief_claims"],
    ["doc_annotation", "doc_annotations"],
    ["doc_annotation", "doc_annotation_evidence"],
    ["person_annotation", "person_annotations"],
    ["person_annotation", "person_annotation_evidence"],
    ["wiki", "knowledge_nodes"],
    ["wiki", "knowledge_candidates"],
    ["temporal", "temporal_annotations"],
    ["temporal", "temporal_annotation_documents"],
    ["temporal", "temporal_annotation_loops"],
    ["temporal", "temporal_annotation_people"],
    ["temporal", "temporal_annotation_projections"],
    ["temporal", "temporal_annotation_evidence"],
  ];
  for (const collection of [
    "loop",
    "brief",
    "doc_annotation",
    "person_annotation",
    "wiki",
    "temporal",
  ])
    db.prepare(
      "INSERT OR IGNORE INTO knowledge_reconciliation_revisions(collection) VALUES(?)",
    ).run(collection);
  for (const [collection, table] of tables) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const filter =
        table === "knowledge_nodes"
          ? `WHEN ${(operation === "UPDATE"
              ? ["OLD", "NEW"]
              : [operation === "DELETE" ? "OLD" : "NEW"]
            )
              .map((row) => `${row}.kind IN ('wiki','root')`)
              .join(" OR ")}`
          : "";
      db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_reconcile_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} ${filter} BEGIN
          UPDATE knowledge_reconciliation_revisions SET revision=revision+1 WHERE collection='${collection}';
        END`);
    }
  }
}

export function readKnowledgeCollectionRevision(
  db: Database.Database,
  collection: KnowledgeCollection,
): number {
  const row = db
    .prepare<
      [string],
      { revision: number }
    >("SELECT revision FROM knowledge_reconciliation_revisions WHERE collection=?")
    .get(collection);
  if (!row)
    throw new KnowledgeStorageError("revision_conflict", "Reconciliation revision is unavailable");
  return row.revision;
}

export function assertKnowledgeReconciliation(
  db: Database.Database,
  receipt: KnowledgeReconciliationReceipt,
): void {
  if (readKnowledgeCollectionRevision(db, receipt.collection) !== receipt.revision)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "The reconciled collection changed. Search or list it again before creating or revising an owner.",
    );
}
