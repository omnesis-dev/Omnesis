// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  readLinkStatsFromCounters,
  reconcileLinkStatsCounters,
  getLinkStats,
} from "./LinkStatsRepository.js";

let dbPath: string;
let db: Db;

beforeEach(() => {
  dbPath = `/tmp/omnesis-link-stats-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  // Seed a minimal documents row so FK constraints on document_links are satisfied.
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    "doc-1",
    "test",
    "test-source",
    "ext-1",
    "Doc 1",
    "",
    "hash1",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    "doc-2",
    "test",
    "test-source",
    "ext-2",
    "Doc 2",
    "",
    "hash2",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

/** Insert a link row into document_links. Returns the rowid. */
function insertLink(opts: {
  sourceDocId?: string;
  linkType: string;
  normalizedTarget: string;
  targetDocId?: string | null;
}): number {
  const { sourceDocId = "doc-1", linkType, normalizedTarget, targetDocId = null } = opts;
  const info = db
    .prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
       target_doc_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceDocId,
      linkType,
      normalizedTarget,
      normalizedTarget,
      targetDocId,
      "2026-01-01T00:00:00Z",
    );
  return Number(info.lastInsertRowid);
}

describe("counters accurate after INSERTs", () => {
  test("unresolved links increment total but not resolved", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(2);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(2);
    expect(stats.byType.url).toEqual({ total: 2, resolved: 0 });
  });

  test("resolved links increment both total and resolved", () => {
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(1);
    expect(stats.resolvedLinks).toBe(1);
    expect(stats.unresolvedLinks).toBe(0);
    expect(stats.byType.url).toEqual({ total: 1, resolved: 1 });
  });

  test("mix of resolved and unresolved inserts", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/2",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/3" });

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(3);
    expect(stats.resolvedLinks).toBe(1);
    expect(stats.unresolvedLinks).toBe(2);
  });
});

describe("counters accurate after resolve", () => {
  test("resolving an unresolved link increments resolved count", () => {
    const id = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });

    let stats = readLinkStatsFromCounters(db);
    expect(stats.resolvedLinks).toBe(0);

    // Resolve the link by setting target_doc_id.
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id);

    stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(1);
    expect(stats.resolvedLinks).toBe(1);
    expect(stats.unresolvedLinks).toBe(0);
  });

  test("resolving multiple links updates counts correctly", () => {
    const id1 = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    const id2 = insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/3" });

    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id1);
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id2);

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(3);
    expect(stats.resolvedLinks).toBe(2);
    expect(stats.unresolvedLinks).toBe(1);
  });
});

describe("counters accurate after DELETE", () => {
  test("deleting an unresolved link decrements total", () => {
    const id = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    db.prepare("DELETE FROM document_links WHERE id = ?").run(id);

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(1);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(1);
  });

  test("deleting a resolved link decrements both total and resolved", () => {
    const id = insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    db.prepare("DELETE FROM document_links WHERE id = ?").run(id);

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(1);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(1);
  });

  test("deleting all links zeros out the counters", () => {
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    db.prepare("DELETE FROM document_links").run();

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(0);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(0);
    expect(stats.byType.url).toEqual({ total: 0, resolved: 0 });
  });
});

describe("unresolve decrements resolved", () => {
  test("setting target_doc_id back to NULL decrements resolved", () => {
    const id = insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });

    let stats = readLinkStatsFromCounters(db);
    expect(stats.resolvedLinks).toBe(1);

    // Unresolve by clearing target_doc_id.
    db.prepare("UPDATE document_links SET target_doc_id = NULL WHERE id = ?").run(id);

    stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(1);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(1);
  });

  test("resolve then unresolve round-trips correctly", () => {
    const id = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });

    // Start unresolved.
    expect(readLinkStatsFromCounters(db).resolvedLinks).toBe(0);

    // Resolve.
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id);
    expect(readLinkStatsFromCounters(db).resolvedLinks).toBe(1);

    // Unresolve.
    db.prepare("UPDATE document_links SET target_doc_id = NULL WHERE id = ?").run(id);
    expect(readLinkStatsFromCounters(db).resolvedLinks).toBe(0);

    // Re-resolve.
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id);
    expect(readLinkStatsFromCounters(db).resolvedLinks).toBe(1);
  });
});

describe("multiple link types tracked separately", () => {
  test("url, citation, and mention types each get their own counter row", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/2",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "citation", normalizedTarget: "cite-1", targetDocId: "doc-2" });
    insertLink({ linkType: "mention", normalizedTarget: "mention-1" });
    insertLink({ linkType: "mention", normalizedTarget: "mention-2" });

    const stats = readLinkStatsFromCounters(db);
    expect(stats.totalLinks).toBe(5);
    expect(stats.resolvedLinks).toBe(2);
    expect(stats.unresolvedLinks).toBe(3);

    expect(stats.byType.url).toEqual({ total: 2, resolved: 1 });
    expect(stats.byType.citation).toEqual({ total: 1, resolved: 1 });
    expect(stats.byType.mention).toEqual({ total: 2, resolved: 0 });
  });

  test("deleting a link of one type does not affect another type", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    const citId = insertLink({
      linkType: "citation",
      normalizedTarget: "cite-1",
      targetDocId: "doc-2",
    });

    db.prepare("DELETE FROM document_links WHERE id = ?").run(citId);

    const stats = readLinkStatsFromCounters(db);
    expect(stats.byType.url).toEqual({ total: 1, resolved: 0 });
    expect(stats.byType.citation).toEqual({ total: 0, resolved: 0 });
    expect(stats.totalLinks).toBe(1);
  });

  test("resolving a link updates only its type's resolved count", () => {
    const urlId = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({ linkType: "mention", normalizedTarget: "mention-1" });

    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", urlId);

    const stats = readLinkStatsFromCounters(db);
    expect(stats.byType.url).toEqual({ total: 1, resolved: 1 });
    expect(stats.byType.mention).toEqual({ total: 1, resolved: 0 });
  });
});

describe("reconcileLinkStatsCounters corrects drift", () => {
  test("corrects a manually corrupted total counter", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/2",
      targetDocId: "doc-2",
    });

    // Manually corrupt the counter.
    db.prepare("UPDATE link_stats_counters SET total = 999 WHERE link_type = 'url'").run();

    const corrupted = readLinkStatsFromCounters(db);
    expect(corrupted.totalLinks).toBe(999);

    const result = reconcileLinkStatsCounters(db);
    expect(result.corrected).toBe(1);

    const fixed = readLinkStatsFromCounters(db);
    expect(fixed.totalLinks).toBe(2);
    expect(fixed.resolvedLinks).toBe(1);
    expect(fixed.byType.url).toEqual({ total: 2, resolved: 1 });
  });

  test("corrects a manually corrupted resolved counter", () => {
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });

    db.prepare("UPDATE link_stats_counters SET resolved = 50 WHERE link_type = 'url'").run();

    const result = reconcileLinkStatsCounters(db);
    expect(result.corrected).toBe(1);

    const fixed = readLinkStatsFromCounters(db);
    expect(fixed.resolvedLinks).toBe(1);
  });

  test("reports zero corrections when counters are already accurate", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });

    const result = reconcileLinkStatsCounters(db);
    expect(result.corrected).toBe(0);
  });

  test("corrects multiple link types independently", () => {
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    insertLink({ linkType: "citation", normalizedTarget: "cite-1" });

    // Corrupt both.
    db.prepare("UPDATE link_stats_counters SET total = 10 WHERE link_type = 'url'").run();
    db.prepare("UPDATE link_stats_counters SET total = 20 WHERE link_type = 'citation'").run();

    const result = reconcileLinkStatsCounters(db);
    expect(result.corrected).toBe(2);

    const fixed = readLinkStatsFromCounters(db);
    expect(fixed.byType.url).toEqual({ total: 1, resolved: 0 });
    expect(fixed.byType.citation).toEqual({ total: 1, resolved: 0 });
  });

  test("also updates the materialized link_stats row", () => {
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    reconcileLinkStatsCounters(db);

    const row = db
      .prepare<
        [],
        { total_links: number; resolved_links: number; last_computed_at: number | null }
      >("SELECT total_links, resolved_links, last_computed_at FROM link_stats WHERE id = 1")
      .get()!;
    expect(row.total_links).toBe(2);
    expect(row.resolved_links).toBe(1);
    expect(row.last_computed_at).not.toBeNull();
  });
});

describe("getLinkStats reads from counters", () => {
  test("returns accurate stats after inserts", () => {
    insertLink({
      linkType: "url",
      normalizedTarget: "https://example.com/1",
      targetDocId: "doc-2",
    });
    insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });
    insertLink({ linkType: "mention", normalizedTarget: "mention-1" });

    const stats = getLinkStats(db);
    expect(stats.totalLinks).toBe(3);
    expect(stats.resolvedLinks).toBe(1);
    expect(stats.unresolvedLinks).toBe(2);
    expect(stats.byType.url).toEqual({ total: 2, resolved: 1 });
    expect(stats.byType.mention).toEqual({ total: 1, resolved: 0 });
  });

  test("returns zeros when no links exist", () => {
    const stats = getLinkStats(db);
    // No links inserted — counters table is empty, falls back to
    // materialized link_stats which has never been computed.
    expect(stats.totalLinks).toBe(0);
    expect(stats.resolvedLinks).toBe(0);
    expect(stats.unresolvedLinks).toBe(0);
    expect(stats.byType).toEqual({});
  });

  test("reflects a full lifecycle: insert, resolve, delete", () => {
    const id1 = insertLink({ linkType: "url", normalizedTarget: "https://example.com/1" });
    const id2 = insertLink({ linkType: "url", normalizedTarget: "https://example.com/2" });

    expect(getLinkStats(db).totalLinks).toBe(2);
    expect(getLinkStats(db).resolvedLinks).toBe(0);

    // Resolve one.
    db.prepare("UPDATE document_links SET target_doc_id = ? WHERE id = ?").run("doc-2", id1);
    expect(getLinkStats(db).resolvedLinks).toBe(1);

    // Delete the other.
    db.prepare("DELETE FROM document_links WHERE id = ?").run(id2);
    const final = getLinkStats(db);
    expect(final.totalLinks).toBe(1);
    expect(final.resolvedLinks).toBe(1);
    expect(final.unresolvedLinks).toBe(0);
  });
});
