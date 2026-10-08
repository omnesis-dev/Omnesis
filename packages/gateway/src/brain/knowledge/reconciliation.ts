// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeOwnerKind } from "./owner-adapters.js";
import type Database from "better-sqlite3";

export type KnowledgeCollection = KnowledgeOwnerKind | "wiki" | "wiki_scope" | "temporal";
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
    "wiki_scope",
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
  for (const table of ["knowledge_nodes", "knowledge_candidates"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      continue;
    for (const operation of ["INSERT", "DELETE", "UPDATE"]) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      const filter =
        table === "knowledge_nodes"
          ? operation === "UPDATE"
            ? "(OLD.kind='wiki' OR NEW.kind='wiki') AND (OLD.kind IS NOT NEW.kind OR OLD.title IS NOT NEW.title)"
            : `${row}.kind='wiki'`
          : operation === "UPDATE"
            ? "OLD.identity_key IS NOT NEW.identity_key OR OLD.title IS NOT NEW.title OR OLD.scope IS NOT NEW.scope OR OLD.status IS NOT NEW.status OR OLD.node_id IS NOT NEW.node_id"
            : "1";
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS knowledge_scope_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} WHEN ${filter} BEGIN UPDATE knowledge_reconciliation_revisions SET revision=revision+1 WHERE collection='wiki_scope'; END`,
      );
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

const COLLECTION_REPAIR: Record<KnowledgeCollection, string> = {
  wiki_scope:
    'Repeat knowledge_list({kind:"wiki"}) without afterId and knowledge_candidates({}) without status or afterId before publishing a distinct scope.',
  wiki: 'For proposal/publication, call knowledge_list({kind:"wiki"}) without afterId and knowledge_candidates({}) without status or afterId; page candidates until the intended candidate is returned. For an existing wiki revision, call knowledge_fetch({id:targetId,editing:true}). For a candidate decision, read that candidate through knowledge_candidates again.',
  loop: "Repeat open_loop_search for the intended subject; read the target through open_loop_fetch before revising it.",
  brief:
    "Repeat brief_list for the relevant records; read the target through brief_fetch before revising it.",
  doc_annotation:
    "Repeat annotation_search({docId:targetDocumentId}) for the exact document being annotated and review the returned annotations.",
  person_annotation:
    "Repeat annotation_search({personId:targetPersonId}) for the exact person being annotated and review the returned annotations.",
  temporal:
    "Repeat temporal_query for the relevant time window and subject; when revising or deleting, ensure the target annotation is returned.",
};

export function knowledgeReconciliationConflict(
  collection: KnowledgeCollection,
  repair = COLLECTION_REPAIR[collection],
): KnowledgeStorageError {
  return new KnowledgeStorageError(
    "revision_conflict",
    `The reconciled collection changed or its read receipt is missing: ${collection}. ${repair} Review the refreshed results before retrying. Evidence-reference reads (knowledge_reference or fetch_many) do not refresh this collection receipt. Retain already-read source inputVersions that are still current; this conflict alone does not require rereading their evidence.`,
  );
}

export function assertKnowledgeReconciliation(
  db: Database.Database,
  receipt: KnowledgeReconciliationReceipt,
  repair?: string,
): void {
  if (readKnowledgeCollectionRevision(db, receipt.collection) !== receipt.revision)
    throw knowledgeReconciliationConflict(receipt.collection, repair);
}
