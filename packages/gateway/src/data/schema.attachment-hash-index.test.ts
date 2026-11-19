// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSchemaSetup } from "./schema.js";

const INDEX = "idx_documents_attachment_content_hash";
// The query cross-source deduplication runs (`domain/LinkGraphService.ts`).
const DEDUP_QUERY = `SELECT id FROM documents
  WHERE extracted_content_hash = ?
    AND id != ?
    AND json_extract(metadata, '$.documentType') IN ('attachment', 'file')
  LIMIT ?`;

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => db.close());

function indexSql(): string | undefined {
  return db
    .prepare<[string], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    )
    .get(INDEX)
    ?.sql.replace(/\s+/g, " ");
}

/** Every statement schema setup hands to `exec` that names the index. */
function indexStatementsDuringSetup(): string[] {
  const statements: string[] = [];
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql.includes(INDEX)) statements.push(sql);
    return exec(sql);
  };
  try {
    runSchemaSetup(db);
  } finally {
    db.exec = exec;
  }
  return statements;
}

function insertDocument(id: string, type: string, extractedHash: string | null): void {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,extracted_content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES(?,'fictional','fictional-source',?,'Invented title','Invented body',?,?,?,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(id, id, `wrapped-${id}`, extractedHash, JSON.stringify({ documentType: type }));
}

function expectServesDeduplication(): void {
  insertDocument("drive-copy", "file", "same-bytes");
  insertDocument("mail-copy", "attachment", "same-bytes");
  insertDocument("plain-mail", "email", "same-bytes");
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${DEDUP_QUERY}`)
    .all("same-bytes", "drive-copy", 5) as Array<{ detail: string }>;
  expect(plan.map((row) => row.detail).join("\n")).toContain(INDEX);
  expect(db.prepare(DEDUP_QUERY).all("same-bytes", "drive-copy", 5)).toEqual([{ id: "mail-copy" }]);
}

describe("attachment content-hash index", () => {
  it("is created on a fresh store with the extracted-content predicate", () => {
    runSchemaSetup(db);
    expect(indexSql()).toBe(
      `CREATE INDEX ${INDEX} ON documents(extracted_content_hash) WHERE json_extract(metadata, '$.documentType') IN ('attachment', 'file') AND extracted_content_hash IS NOT NULL`,
    );
    expectServesDeduplication();
  });

  it("is kept, not dropped and rebuilt, when a later setup finds it already correct", () => {
    runSchemaSetup(db);
    insertDocument("existing", "attachment", "existing-bytes");
    expect(indexStatementsDuringSetup()).toEqual([]);
    expect(indexStatementsDuringSetup()).toEqual([]);
    expectServesDeduplication();
  });

  it("replaces a store's historical index on content_hash once, then keeps it", () => {
    runSchemaSetup(db);
    insertDocument("historical", "attachment", "historical-bytes");
    db.exec(`DROP INDEX ${INDEX}`);
    db.exec(
      `CREATE INDEX ${INDEX} ON documents(content_hash) WHERE json_extract(metadata, '$.documentType') IN ('attachment', 'file')`,
    );

    const upgrade = indexStatementsDuringSetup();
    expect(upgrade.some((sql) => sql.startsWith(`DROP INDEX IF EXISTS ${INDEX}`))).toBe(true);
    expect(indexSql()).toContain("ON documents(extracted_content_hash)");
    expect(indexStatementsDuringSetup()).toEqual([]);
    expectServesDeduplication();
  });

  it("is rebuilt on an existing store that lost it", () => {
    runSchemaSetup(db);
    db.exec(`DROP INDEX ${INDEX}`);
    runSchemaSetup(db);
    expect(indexSql()).toContain("ON documents(extracted_content_hash)");
    expect(indexStatementsDuringSetup()).toEqual([]);
    expectServesDeduplication();
  });
});
