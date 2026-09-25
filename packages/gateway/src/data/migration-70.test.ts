// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  createBrief,
  createDocAnnotation,
  createOpenLoop,
  createPersonAnnotation,
} from "../brain/index.js";
import { insertTemporalAnnotation } from "../enrichment/temporal-annotations/storage.js";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function tableExists(name: string): boolean {
  return (
    db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function seedDocument(
  id: string,
  sourceId: string,
  metadata: Record<string, unknown>,
  updatedAt: string,
  providerId = "web",
  externalId = `external-${id}`,
): void {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    providerId,
    sourceId,
    externalId,
    `Page ${id}`,
    `Body ${id}`,
    `hash-${id}`,
    JSON.stringify(metadata),
    updatedAt,
    updatedAt,
    updatedAt,
    updatedAt,
  );
}

describe("migration 70", () => {
  test("fresh schema contains only the canonical URL-maintenance state store", () => {
    expect(tableExists("canonicalization_state")).toBe(true);
    expect(tableExists("crawl_queue")).toBe(false);
    expect(tableExists("crawl_domain_stats")).toBe(false);
    expect(tableExists("crawl_state")).toBe(false);
    expect(
      db
        .prepare<
          [],
          { dirty_version: number }
        >("SELECT dirty_version FROM refresh_meta WHERE job = 'link_graph'")
        .get()?.dirty_version,
    ).toBe(0);
  });

  test("removes retired fetched pages and state while preserving extension pages", () => {
    db.exec(`
      CREATE TABLE crawl_queue (id INTEGER PRIMARY KEY);
      CREATE TABLE crawl_domain_stats (domain TEXT PRIMARY KEY);
      CREATE TABLE crawl_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO crawl_state (key, value, updated_at) VALUES (?, ?, ?), (?, ?, ?)").run(
      "recanonicalize_source_url_fingerprint",
      "fingerprint-v1",
      "2026-01-01T00:00:00Z",
      "discovery_watermarks",
      "{}",
      "2026-01-01T00:00:00Z",
    );

    seedDocument(
      "extension-page",
      "web",
      { documentType: "webpage", captureMethod: "extension-dom" },
      "2026-03-01T00:00:00Z",
    );
    seedDocument(
      "fetched-page",
      "web",
      { documentType: "webpage", captureMethod: "server-crawl" },
      "2026-02-01T00:00:00Z",
    );
    seedDocument("legacy-page", "url-crawler", { documentType: "webpage" }, "2026-01-01T00:00:00Z");
    seedDocument(
      "unrelated",
      "notes:local",
      { documentType: "note", captureMethod: "legacy-value" },
      "2026-04-01T00:00:00Z",
    );

    db.prepare(
      `INSERT INTO document_links
         (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, created_at)
       VALUES ('extension-page', 'crawl-seed', 'seed', 'seed', 'fetched-page', ?)`,
    ).run("2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO pending_edges
       (source_doc_id, link_type, target_source_id, target_external_id, provenance_origin, declared_at)
       VALUES ('extension-page', 'crawl-seed', 'web', 'pending', 'legacy', ?),
              ('extension-page', 'reply', 'url-crawler', 'legacy-target', 'legacy', ?),
              ('extension-page', 'url', 'web', 'legacy-web-hash', 'legacy', ?)`,
    ).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO near_dup_inbox (doc_id, enqueued_reason, enqueued_at) VALUES ('fetched-page', 'insert', 1)",
    ).run();

    db.prepare(
      `INSERT INTO devices (id, name, kind, paired_at)
       VALUES ('device-1', 'Retired worker', 'collector', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO sources
         (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES ('url-crawler', 'url-crawler', 'local', 'device-1', '{}', 1, 1, 1)`,
    ).run();
    db.prepare("INSERT INTO sync_state (source_id, cursor) VALUES ('url-crawler', '{}')").run();
    db.prepare(
      `INSERT INTO source_stats
         (source_id, latest_doc_id, latest_title, latest_source_created_at,
          latest_source_updated_at, latest_ingested_at, latest_updated_at)
       VALUES ('url-crawler', 'legacy-page', 'Legacy', ?, ?, ?, ?),
              ('web', 'fetched-page', 'Fetched', ?, ?, ?, ?),
              ('notes:local', 'unrelated', 'Note', ?, ?, ?, ?)`,
    ).run(
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
    );

    createOpenLoop(
      db,
      {
        id: "derived-loop",
        createdByRun: "run-derived",
        title: "Review the private page",
        description: "Derived from mixed evidence.",
        confidence: 0.8,
        importance: 0.6,
        docs: ["extension-page", "fetched-page"],
      },
      1,
    );
    createOpenLoop(
      db,
      {
        id: "extension-loop",
        createdByRun: "run-extension",
        title: "Review the saved page",
        description: "Derived only from retained evidence.",
        confidence: 0.8,
        importance: 0.6,
        docs: ["extension-page"],
      },
      1,
    );
    seedDocument(
      "derived-loop-mirror",
      "open-loops",
      { documentType: "open-loop" },
      "2026-04-01T00:00:00Z",
      "system",
      "derived-loop",
    );
    seedDocument(
      "extension-loop-mirror",
      "open-loops",
      { documentType: "open-loop" },
      "2026-04-01T00:00:00Z",
      "system",
      "extension-loop",
    );
    createBrief(
      db,
      {
        id: "derived-brief",
        createdByRun: "run-derived",
        kind: "loop",
        title: "Private page follow-up",
        citations: ["extension-page", "fetched-page"],
        relatedLoopIds: ["derived-loop"],
        confidence: 0.8,
        urgency: 0.5,
        claims: [
          {
            id: "derived-claim",
            claimText: "The private page needs review.",
            evidenceDocId: "fetched-page",
            evidenceQuote: "Body fetched-page",
            claimBasis: "quoted",
            confidence: 0.8,
            verificationState: "verified",
          },
        ],
      },
      1,
    );
    createBrief(
      db,
      {
        id: "extension-brief",
        createdByRun: "run-extension",
        kind: "loop",
        title: "Saved page follow-up",
        citations: ["extension-page"],
        relatedLoopIds: ["extension-loop"],
        confidence: 0.8,
        urgency: 0.5,
        claims: [
          {
            id: "extension-claim",
            claimText: "The saved page needs review.",
            evidenceDocId: "extension-page",
            evidenceQuote: "Body extension-page",
            claimBasis: "quoted",
            confidence: 0.8,
            verificationState: "verified",
          },
        ],
      },
      1,
    );
    createDocAnnotation(
      db,
      {
        id: "derived-doc-annotation",
        docId: "extension-page",
        claimType: "status",
        claimText: "Mixed-source status",
        evidenceDocId: "fetched-page",
        evidenceQuote: "Body fetched-page",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-derived",
      },
      1,
    );
    createDocAnnotation(
      db,
      {
        id: "extension-doc-annotation",
        docId: "extension-page",
        claimType: "retained-status",
        claimText: "Extension-only status",
        evidenceDocId: "extension-page",
        evidenceQuote: "Body extension-page",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-extension",
      },
      1,
    );
    createPersonAnnotation(
      db,
      {
        id: "derived-person-annotation",
        personId: "fictional-person",
        claimType: "status",
        claimText: "Mixed-source person status",
        evidenceDocId: "fetched-page",
        evidenceQuote: "Body fetched-page",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-derived",
      },
      1,
    );
    createPersonAnnotation(
      db,
      {
        id: "extension-person-annotation",
        personId: "fictional-person",
        claimType: "retained-status",
        claimText: "Extension-only person status",
        evidenceDocId: "extension-page",
        evidenceQuote: "Body extension-page",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run-extension",
      },
      1,
    );
    insertTemporalAnnotation(
      db,
      {
        id: "derived-temporal-annotation",
        intervalStartMs: 1,
        intervalEndMs: 2,
        precision: "instant",
        canonical: null,
        sentence: "Mixed-source timing",
        documentIds: ["extension-page", "fetched-page"],
        createdByRun: "run-derived",
      },
      1,
    );
    insertTemporalAnnotation(
      db,
      {
        id: "extension-temporal-annotation",
        intervalStartMs: 1,
        intervalEndMs: 2,
        precision: "instant",
        canonical: null,
        sentence: "Extension-only timing",
        documentIds: ["extension-page"],
        createdByRun: "run-extension",
      },
      1,
    );
    db.prepare(
      `INSERT INTO cognition_consumption_edges
         (prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id, created_at)
       VALUES ('doc', 'derived-doc-annotation', 'loop', 'derived-loop', 'run-derived', 1),
              ('doc', 'extension-doc-annotation', 'loop', 'extension-loop', 'run-extension', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO cognition_runs
       (id, kind, payload_json, status, attempts, next_attempt_at, enqueued_at)
       VALUES ('derived-run', 'data', '{"docId":"fetched-page"}', 'pending', 0, 1, 1),
              ('derived-running-run', 'bootstrap', '{"docId":"fetched-page"}', 'running', 1, 1, 1),
              ('extension-run', 'data', '{"docId":"extension-page"}', 'pending', 0, 1, 1)`,
    ).run();

    const migration70 = MIGRATIONS.find((migration) => migration.version === 70);
    if (!migration70) throw new Error("migration 70 not found");
    migration70.up(db);
    expect(
      db
        .prepare<[], { prior_annotation_id: string }>(
          "SELECT prior_annotation_id FROM cognition_consumption_edges",
        )
        .all()
        .map((row) => row.prior_annotation_id),
    ).toEqual(["extension-doc-annotation"]);

    db.pragma("user_version = 70");
    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["extension-loop-mirror", "extension-page", "unrelated"]);
    for (const row of db
      .prepare<[], { metadata: string }>("SELECT metadata FROM documents")
      .all()) {
      expect(JSON.parse(row.metadata)).not.toHaveProperty("captureMethod");
    }
    expect(
      db
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM canonicalization_state WHERE key = 'recanonicalize_source_url_fingerprint'")
        .get()?.value,
    ).toBe("fingerprint-v1");
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM sources").get()!.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM sync_state").get()!.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM document_links").get()!
        .count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM pending_edges").get()!.count,
    ).toBe(0);
    expect(
      db
        .prepare<
          [],
          { latest_doc_id: string | null }
        >("SELECT latest_doc_id FROM source_stats WHERE source_id = 'web'")
        .get()?.latest_doc_id,
    ).toBe("extension-page");
    for (const [table, expectedIds] of [
      ["open_loops", ["extension-loop"]],
      ["briefs", ["extension-brief"]],
      ["doc_annotations", ["extension-doc-annotation"]],
      ["person_annotations", ["extension-person-annotation"]],
      ["temporal_annotations", ["extension-temporal-annotation"]],
      ["brief_claims", ["extension-claim"]],
      ["cognition_runs", ["extension-run"]],
    ] as const) {
      expect(
        db
          .prepare<[], { id: string }>(`SELECT id FROM ${table} ORDER BY id`)
          .all()
          .map((row) => row.id),
      ).toEqual(expectedIds);
    }
    expect(
      db
        .prepare<[], { external_id: string }>(
          "SELECT external_id FROM documents WHERE source_id = 'open-loops' ORDER BY external_id",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["extension-loop"]);
    expect(
      db
        .prepare<[], { prior_annotation_id: string }>(
          "SELECT prior_annotation_id FROM cognition_consumption_edges",
        )
        .all()
        .map((row) => row.prior_annotation_id),
    ).toEqual([]);
    expect(
      db
        .prepare<
          [],
          { needs_refresh: number; doc_count: number }
        >("SELECT needs_refresh, doc_count FROM source_stats WHERE source_id = 'notes:local'")
        .get(),
    ).toEqual({ needs_refresh: 1, doc_count: 1 });
    expect(tableExists("crawl_queue")).toBe(false);
    expect(tableExists("crawl_domain_stats")).toBe(false);
    expect(tableExists("crawl_state")).toBe(false);
  });

  test("dirties statistics when only old extension metadata needed cleanup", () => {
    seedDocument(
      "extension-only",
      "web",
      { documentType: "webpage", captureMethod: "extension-dom" },
      "2026-03-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO source_stats
         (source_id, doc_count, data_size_bytes, dirty_version, needs_refresh)
       VALUES ('web', 1, 999, 0, 0)`,
    ).run();

    db.pragma("user_version = 69");
    runMigrations(db);

    expect(
      JSON.parse(
        db
          .prepare<[], { metadata: string }>("SELECT metadata FROM documents WHERE id = ?")
          .get("extension-only")!.metadata,
      ),
    ).toEqual({ documentType: "webpage" });
    expect(
      db
        .prepare<
          [],
          { doc_count: number; dirty_version: number; needs_refresh: number }
        >("SELECT doc_count, dirty_version, needs_refresh FROM source_stats WHERE source_id = 'web'")
        .get(),
    ).toEqual({ doc_count: 1, dirty_version: 1, needs_refresh: 1 });
  });
});
