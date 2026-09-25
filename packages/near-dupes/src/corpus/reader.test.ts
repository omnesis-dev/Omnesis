// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CorpusReader } from "./reader.js";

function seed(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extracted_content_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_created_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_url TEXT,
      people_resolved_at TEXT,
      links_extracted_at TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
      content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const longBody = "lorem ipsum dolor sit amet ".repeat(20);
  const rows: Array<[string, string, string]> = [
    ["doc-email-1", '{"documentType":"email"}', longBody],
    ["doc-note-1", '{"documentType":"note"}', longBody],
    ["doc-event-1", '{"documentType":"event"}', longBody],
    ["doc-short", '{"documentType":"email"}', "tiny"],
    ["doc-no-meta", "{}", longBody],
    ["doc-attach", '{"documentType":"attachment"}', longBody],
  ];
  for (const [id, meta, content] of rows) {
    insert.run(
      id,
      "p",
      "s",
      id,
      "t",
      content,
      "ch-" + id,
      meta,
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
  }
  db.close();
}

describe("CorpusReader", () => {
  let path: string;

  beforeEach(() => {
    path = `/tmp/omnesis-corpus-test-${randomUUID()}.db`;
    seed(path);
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // ignore
      }
    }
  });

  it("streams in-scope types only and skips short content", () => {
    const reader = new CorpusReader(path);
    const ids = [...reader.stream()].map((d) => d.id).sort();
    reader.close();
    // Default include: email, note, document, attachment, webpage, file.
    // event is excluded; doc-no-meta falls through to "document" and is in.
    expect(ids).toEqual(["doc-attach", "doc-email-1", "doc-no-meta", "doc-note-1"]);
  });

  it("honors a custom include set", () => {
    const reader = new CorpusReader(path, { includeTypes: new Set(["event"]) });
    const ids = [...reader.stream()].map((d) => d.id);
    reader.close();
    expect(ids).toEqual(["doc-event-1"]);
  });

  it("getContent fetches by id", () => {
    const reader = new CorpusReader(path);
    const c = reader.getContent("doc-note-1");
    reader.close();
    expect(c?.docType).toBe("note");
    expect(c?.content.length).toBeGreaterThan(80);
  });
});
