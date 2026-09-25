// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 157)!;

function database(): Db {
  const db = new SqliteDatabase(":memory:") as unknown as Db;
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL,
      source_url TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_documents_source_url ON documents(source_url);
    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY,
      source_doc_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      normalized_target TEXT NOT NULL,
      target_doc_id TEXT,
      resolved_at TEXT
    );
    CREATE INDEX idx_document_links_target_type
      ON document_links(target_doc_id, link_type);
    CREATE TABLE refresh_meta (
      job TEXT PRIMARY KEY,
      dirty_version INTEGER NOT NULL DEFAULT 0,
      needs_refresh INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO refresh_meta (job) VALUES ('link_graph');
  `);
  return db;
}

describe("migration 157", () => {
  test("removes internal identity URIs and leaves real source links untouched", () => {
    const db = database();
    try {
      const insert = db.prepare(
        "INSERT INTO documents (id, metadata, source_url, updated_at) VALUES (?, ?, ?, ?)",
      );
      insert.run(
        "internal-source",
        JSON.stringify({
          sourceUrl: "omnesis://fictional-agent/cli/session/day",
          documentType: "conversation",
        }),
        "omnesis://fictional-agent/cli/session/day",
        "2026-01-01T00:00:00.000Z",
      );
      insert.run(
        "internal-source-with-valid-app",
        JSON.stringify({
          sourceUrl: "omnesis://fictional-agent/cli/session/day",
          appUrl: "fictional-app://items/1",
          documentType: "conversation",
        }),
        "omnesis://fictional-agent/cli/session/day",
        "2026-01-01T00:00:00.000Z",
      );
      insert.run(
        "external",
        JSON.stringify({
          sourceUrl: "https://source.example.com/items/1",
          appUrl: "fictional-app://items/1",
          documentType: "page",
        }),
        "https://source.example.com/items/1",
        "2026-01-01T00:00:00.000Z",
      );
      insert.run(
        "malformed",
        "not-json",
        "omnesis://fictional-agent/malformed",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO document_links
           (source_doc_id, link_type, normalized_target, target_doc_id, resolved_at)
         VALUES (?, 'url', ?, ?, ?)`,
      ).run(
        "external",
        "omnesis://fictional-agent/cli/session/day",
        "internal-source",
        "2026-01-01T00:00:00.000Z",
      );

      expect(
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT id FROM documents WHERE source_url GLOB 'omnesis://*'",
          )
          .all()
          .some(
            (row) =>
              typeof (row as { detail?: unknown }).detail === "string" &&
              (row as { detail: string }).detail.includes("idx_documents_source_url"),
          ),
      ).toBe(true);

      migration.up(db);

      const rows = db
        .prepare<
          [],
          { id: string; metadata: string; source_url: string | null; updated_at: string }
        >("SELECT id, metadata, source_url, updated_at FROM documents ORDER BY id")
        .all();
      expect(
        rows.map((row) => ({
          ...row,
          metadata: row.id === "malformed" ? row.metadata : JSON.parse(row.metadata),
        })),
      ).toEqual([
        {
          id: "external",
          metadata: {
            sourceUrl: "https://source.example.com/items/1",
            appUrl: "fictional-app://items/1",
            documentType: "page",
          },
          source_url: "https://source.example.com/items/1",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "internal-source",
          metadata: { documentType: "conversation" },
          source_url: null,
          updated_at: expect.not.stringMatching(/^2026-01-01/),
        },
        {
          id: "internal-source-with-valid-app",
          metadata: { appUrl: "fictional-app://items/1", documentType: "conversation" },
          source_url: null,
          updated_at: expect.not.stringMatching(/^2026-01-01/),
        },
        {
          id: "malformed",
          metadata: "not-json",
          source_url: null,
          updated_at: expect.not.stringMatching(/^2026-01-01/),
        },
      ]);

      expect(db.prepare("SELECT target_doc_id, resolved_at FROM document_links").get()).toEqual({
        target_doc_id: null,
        resolved_at: null,
      });
      expect(db.prepare("SELECT dirty_version, needs_refresh FROM refresh_meta").get()).toEqual({
        dirty_version: 1,
        needs_refresh: 1,
      });

      const afterFirstRun = JSON.stringify({
        documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
        links: db.prepare("SELECT * FROM document_links ORDER BY id").all(),
        refresh: db.prepare("SELECT * FROM refresh_meta ORDER BY job").all(),
      });
      migration.up(db);
      expect(
        JSON.stringify({
          documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
          links: db.prepare("SELECT * FROM document_links ORDER BY id").all(),
          refresh: db.prepare("SELECT * FROM refresh_meta ORDER BY job").all(),
        }),
      ).toBe(afterFirstRun);
    } finally {
      db.close();
    }
  });
});
