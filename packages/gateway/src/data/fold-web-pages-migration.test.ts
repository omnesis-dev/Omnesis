// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { normalizeUrl, urlToExternalId } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { foldWebPagesIntoWebSource } from "./fold-web-pages-migration.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

const EARLIER = "2026-01-01T00:00:00Z";
const LATER = "2026-02-01T00:00:00Z";

function seedBrowserDoc(id: string, url: string, updatedAt = EARLIER): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
     VALUES (?, 'browser', 'browser', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    url,
    `Page ${id}`,
    `Body ${id}`,
    `hash-${id}`,
    JSON.stringify({ documentType: "web-page", sourceUrl: url }),
    EARLIER,
    updatedAt,
    updatedAt,
    updatedAt,
    url,
  );
}

describe("foldWebPagesIntoWebSource", () => {
  test("moves legacy extension pages to the canonical web identity", () => {
    const url = "https://example.com/articles/intro?utm_source=example";
    seedBrowserDoc("page-1", url);

    expect(foldWebPagesIntoWebSource(db)).toMatchObject({
      scanned: 1,
      folded: 1,
      deduped: 0,
    });

    const row = db
      .prepare<
        [],
        { provider_id: string; source_id: string; external_id: string; metadata: string }
      >("SELECT provider_id, source_id, external_id, metadata FROM documents WHERE id = 'page-1'")
      .get()!;
    expect(row.provider_id).toBe("web");
    expect(row.source_id).toBe("web");
    expect(row.external_id).toBe(urlToExternalId(normalizeUrl(url)));
    expect(JSON.parse(row.metadata)).toMatchObject({ documentType: "webpage", sourceUrl: url });
  });

  test("keeps the freshest row when two legacy URLs normalize to one page", () => {
    const canonical = "https://example.org/guide";
    seedBrowserDoc("old", `${canonical}?utm_campaign=old`, EARLIER);
    seedBrowserDoc("new", canonical, LATER);

    expect(foldWebPagesIntoWebSource(db)).toMatchObject({
      scanned: 2,
      folded: 1,
      deduped: 1,
    });
    const rows = db
      .prepare<
        [],
        { id: string; content: string }
      >("SELECT id, content FROM documents WHERE source_id = 'web'")
      .all();
    expect(rows).toEqual([{ id: "new", content: "Body new" }]);
  });

  test("is idempotent", () => {
    seedBrowserDoc("page-1", "https://example.net/page");
    foldWebPagesIntoWebSource(db);
    expect(foldWebPagesIntoWebSource(db)).toEqual({
      scanned: 0,
      folded: 0,
      deduped: 0,
      linksRemapped: 0,
      pendingRemapped: 0,
    });
  });
});
