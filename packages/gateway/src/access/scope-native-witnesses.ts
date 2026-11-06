// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentScopeFacts, ScopeRef } from "@omnesis/types";
import type { Db } from "../data/types.js";

export function createScopeNativeWitnessSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_native_refresh_witnesses (
    document_id TEXT NOT NULL,kind TEXT NOT NULL,epoch TEXT NOT NULL,
    PRIMARY KEY(document_id,kind)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_native_desired_witnesses (
    document_id TEXT NOT NULL,kind TEXT NOT NULL,epoch TEXT NOT NULL,
    PRIMARY KEY(document_id,kind)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_native_publication_context(document_id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_native_reprojection(document_id TEXT PRIMARY KEY,source_id TEXT NOT NULL) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_scope_native_reprojection_source ON scope_native_reprojection(source_id,document_id);
  CREATE TABLE IF NOT EXISTS scope_native_reprojection_sources(source_id TEXT PRIMARY KEY,pending INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_native_reprojection_cursor(id INTEGER PRIMARY KEY CHECK(id=1),document_id TEXT NOT NULL);
  INSERT OR IGNORE INTO scope_native_reprojection_cursor VALUES(1,'');`);
}

/** The context never commits: exceptions and process death roll back its transaction. */
export function withNativeScopePublication<T>(db: Db, documentId: string, work: () => T): T {
  return db.transaction(() => {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO scope_native_publication_context VALUES(?)")
      .run(documentId).changes;
    try {
      return work();
    } finally {
      if (inserted)
        db.prepare("DELETE FROM scope_native_publication_context WHERE document_id=?").run(
          documentId,
        );
    }
  })();
}

export function clearNativeScopeWitnesses(
  db: Db,
  documentId: string,
  kind?: ScopeRef["kind"],
): void {
  for (const table of ["scope_native_refresh_witnesses", "scope_native_desired_witnesses"])
    db.prepare(`DELETE FROM ${table} WHERE document_id=?${kind ? " AND kind=?" : ""}`).run(
      documentId,
      ...(kind ? [kind] : []),
    );
}

/** Only new-code final completion may publish a producer's explicit refresh echo. */
export function publishNativeScopeWitnesses(db: Db, documentId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO scope_native_refresh_witnesses(document_id,kind,epoch)
    SELECT w.document_id,w.kind,w.epoch FROM scope_native_desired_witnesses w
    JOIN document_scope_completeness c ON c.document_id=w.document_id AND c.kind=w.kind AND c.complete=1
    WHERE w.document_id=? AND NOT EXISTS(SELECT 1 FROM scope_fact_rebuilds r WHERE r.document_id=w.document_id)
      AND NOT EXISTS(SELECT 1 FROM scope_conversation_rebuilds r WHERE r.subject_document_id=w.document_id)`,
  ).run(documentId);
}

/** Desired proofs survive only protected new-code staging, never an unrelated writer. */
export function replaceNativeScopeWitnesses(
  db: Db,
  documentId: string,
  projection: DocumentScopeFacts,
): void {
  clearNativeScopeWitnesses(db, documentId);
  for (const kind of projection.complete) {
    const epoch = projection.refreshEpochs?.[kind];
    if (epoch)
      db.prepare("INSERT INTO scope_native_desired_witnesses VALUES(?,?,?)").run(
        documentId,
        kind,
        epoch,
      );
  }
  publishNativeScopeWitnesses(db, documentId);
}
export function replaceNativeScopeKindWitness(
  db: Db,
  documentId: string,
  kind: ScopeRef["kind"],
  epoch?: string,
): void {
  clearNativeScopeWitnesses(db, documentId, kind);
  if (epoch)
    db.prepare("INSERT INTO scope_native_desired_witnesses VALUES(?,?,?)").run(
      documentId,
      kind,
      epoch,
    );
  publishNativeScopeWitnesses(db, documentId);
}

/** These persistent triggers also run when an older gateway opens this database. */
export function createScopeNativeWitnessTriggers(db: Db): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get())
    return;
  const revoke = (subject: string, kind?: string) => `
    DELETE FROM scope_native_refresh_witnesses WHERE document_id=${subject}${kind ? ` AND kind=${kind}` : ""};
    DELETE FROM scope_native_desired_witnesses WHERE document_id=${subject}${kind ? ` AND kind=${kind}` : ""}
      AND NOT EXISTS(SELECT 1 FROM scope_native_publication_context WHERE document_id=${subject});`;
  for (const [table, owner, kind] of [
    ["document_scope_facts", "document_id", "kind"],
    ["document_scope_completeness", "document_id", "kind"],
    ["scope_conversation_members", "subject_document_id", null],
    ["scope_conversation_identifier_counts", "subject_document_id", null],
    ["scope_conversations", "subject_document_id", null],
  ] as const) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const refs = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"];
      db.exec(`CREATE TRIGGER IF NOT EXISTS native_witness_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
        ${refs.map((ref) => revoke(`${ref}.${owner}`, kind ? `${ref}.${kind}` : "'participant'")).join("\n")}
      END`);
    }
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS native_reprojection_added AFTER INSERT ON scope_native_reprojection BEGIN
    INSERT INTO scope_native_reprojection_sources VALUES(NEW.source_id,1) ON CONFLICT(source_id) DO UPDATE SET pending=pending+1;
  END;
  CREATE TRIGGER IF NOT EXISTS native_reprojection_removed AFTER DELETE ON scope_native_reprojection BEGIN
    UPDATE scope_native_reprojection_sources SET pending=pending-1 WHERE source_id=OLD.source_id;
    DELETE FROM scope_native_reprojection_sources WHERE source_id=OLD.source_id AND pending<=0;
  END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS native_document_delete AFTER DELETE ON documents BEGIN
    DELETE FROM scope_native_refresh_witnesses WHERE document_id=OLD.id;
    DELETE FROM scope_native_desired_witnesses WHERE document_id=OLD.id;
    DELETE FROM scope_native_reprojection WHERE document_id=OLD.id;
  END;`);
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name),
  );
  const changing = [
    "metadata",
    "content_hash",
    "source_id",
    "provider_id",
    "stream_id",
    "external_id",
  ].filter((column) => columns.has(column));
  const changed = changing.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
  const queue = `DELETE FROM scope_native_reprojection WHERE document_id=NEW.id;
    INSERT INTO scope_native_reprojection SELECT NEW.id,NEW.source_id
      WHERE NOT EXISTS(SELECT 1 FROM scope_fact_backfill b WHERE b.source_id=NEW.source_id AND b.ready=0 AND NEW.rowid>b.cursor_rowid);`;
  if (columns.has("metadata"))
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS native_document_insert AFTER INSERT ON documents BEGIN ${queue} END;`,
    );
  if (changed)
    db.exec(`CREATE TRIGGER IF NOT EXISTS native_document_update AFTER UPDATE OF ${changing.join(",")} ON documents WHEN ${changed} BEGIN
    ${revoke("OLD.id")}
    DELETE FROM scope_native_desired_witnesses WHERE document_id=OLD.id;
    DELETE FROM document_scope_completeness WHERE document_id=OLD.id;
    DELETE FROM document_scope_completeness WHERE kind='participant' AND document_id IN(SELECT subject_document_id FROM document_scope_conversations WHERE document_id=OLD.id);
    DELETE FROM scope_native_refresh_witnesses WHERE document_id IN(SELECT subject_document_id FROM document_scope_conversations WHERE document_id=OLD.id);
    DELETE FROM scope_native_desired_witnesses WHERE document_id IN(SELECT subject_document_id FROM document_scope_conversations WHERE document_id=OLD.id);
    UPDATE document_scope_subjects SET subject_document_id='' WHERE document_id=OLD.id;
    DELETE FROM scope_fact_rebuilds WHERE document_id=OLD.id;
    ${queue}
  END`);
}
