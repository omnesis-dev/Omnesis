// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Trusted SQL aliases only; global content hashes remain body/quote identities. */
export function knowledgeSourceRevisionSql(alias = "d"): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error("Invalid document SQL alias");
  const generation = `COALESCE((SELECT generation FROM knowledge_source_revisions WHERE document_id=${alias}.id),0)`;
  return `(${alias}.content_hash || CASE WHEN ${generation}>0 THEN ':knowledge:' || ${generation} ELSE '' END)`;
}

export function readKnowledgeSourceRevision(db: Database.Database, id: string): string | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_source_revisions'",
      )
      .get()
  )
    return (
      db
        .prepare<
          [string],
          { content_hash: string }
        >("SELECT content_hash FROM documents WHERE id=?")
        .get(id)?.content_hash ?? null
    );
  return (
    db
      .prepare<
        [string],
        { revision: string }
      >(`SELECT ${knowledgeSourceRevisionSql()} AS revision FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=? AND COALESCE(r.deleted,0)=0`)
      .get(id)?.revision ?? null
  );
}

/** Stable metadata framing; title/date fields may be absent in isolated stores. */
export function knowledgeSourceContextSql(db: Database.Database, alias: string): string {
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .map((row) => row.name),
  );
  const base = ["title", "source_created_at", "source_updated_at"].map((name) =>
    columns.has(name) ? `${alias}.${name}` : "NULL",
  );
  const legacy = `json_array(${base.join(",")})`;
  if (!columns.has("metadata")) return legacy;
  const marker = `json_extract(${alias}.metadata,'$.evidenceAuthority')`;
  const qualified = `json_array(${base
    .concat(
      ["provider_id", "source_id"].map((name) => (columns.has(name) ? `${alias}.${name}` : "NULL")),
      marker,
    )
    .join(",")})`;
  return `CASE WHEN ${marker} IS NULL THEN ${legacy} ELSE ${qualified} END`;
}

/** Old proofs cannot silently acquire authority over previously unversioned metadata. */
export function migrateKnowledgeSourceRevisions(db: Database.Database): void {
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(knowledge_source_revisions)")
      .all()
      .map((row) => row.name),
  );
  if (columns.has("generation")) return;
  db.transaction(() => {
    db.exec(
      "ALTER TABLE knowledge_source_revisions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0; ALTER TABLE knowledge_source_revisions ADD COLUMN source_context TEXT",
    );
    const documents = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
      .get();
    if (!documents) return;
    const context = knowledgeSourceContextSql(db, "d");
    // Work tables exist on upgraded gateways, but are installed after this schema
    // on fresh stores. Coverage/candidates also retain decisions about evidence.
    const optionalTracked = [
      ["knowledge_candidate_sources", "document_id"],
      ["knowledge_discovery_coverage", "subject_id"],
    ]
      .filter(([table]) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      )
      .map(
        ([table, column]) =>
          `OR EXISTS(SELECT 1 FROM ${table} tracked WHERE tracked.${column}=d.id)`,
      )
      .join(" ");
    // Sources cited before intake existed may have no sidecar row yet.
    db.exec(`INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at)
      SELECT d.id,d.content_hash,0,0 FROM documents d WHERE
        EXISTS(SELECT 1 FROM knowledge_dependencies dep WHERE dep.target_kind='source' AND dep.target_id=d.id)
        OR EXISTS(SELECT 1 FROM knowledge_revision_dependencies dep WHERE dep.target_kind='source' AND dep.target_id=d.id)
        OR EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.document_id=d.id)
        ${optionalTracked}
      ON CONFLICT(document_id) DO NOTHING`);
    db.exec(
      `UPDATE knowledge_source_revisions SET generation=1,source_context=(SELECT ${context} FROM documents d WHERE d.id=document_id) WHERE deleted=0`,
    );
    const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
    const revision = knowledgeSourceRevisionSql();
    db.exec(`INSERT INTO knowledge_changes(kind,entity_id,revision,at) SELECT 'source_evidence_changed',d.id,${revision},${now} FROM documents d JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE r.deleted=0;
      INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) SELECT 'invalidate','source',d.id,${revision},${now} FROM documents d JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE r.deleted=0 ON CONFLICT(kind,target_kind,target_id,revision) DO NOTHING;
      INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id) SELECT id,'source',target_id FROM knowledge_cascade_jobs WHERE kind='invalidate' ON CONFLICT(job_id,target_kind,target_id) DO NOTHING;`);
  })();
}
