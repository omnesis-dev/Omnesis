// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The population the indexer is expected to index, read from `omnesis.db`:
 * the retention cutoff's skip expressed as queries, the cached counts that
 * must agree with them, the coverage the worker's boot checks read, and the
 * plans that keep them off a full scan.
 *
 * Fixture data is invented per the repo's privacy rule.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, upsertDocuments } from "../db.js";
import { listDocumentIds } from "../data/repositories/DocumentRepository.js";
import { createIndexDatabase, getIndexedDocumentCount, upsertChunksAndMarkIndexed } from "./db.js";
import {
  coverageBelow,
  cutoffFromMaxAge,
  EXCLUDED_COUNT_TTL_MS,
  indexableCountsBySource,
  indexCoverage,
  isBeforeCutoff,
  listDocumentSourceIds,
  listIndexableDocumentIds,
  listPreCutoffDocumentIdsForSource,
} from "./indexable-documents.js";
import type { DocumentInput } from "@omnesis/types";

const NOTES = "notes:maya@example.org";
const DRIVE = "drive:jamie@example.org";
const CUTOFF = "2024-06-01T00:00:00.000Z";
/** `CUTOFF` is exactly this `maxAge` before `NOW`. */
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const MAX_AGE = "730d";

let directory: string;
let writer: Database.Database;
let reader: Database.Database;
let statements: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-indexable-"));
  const path = join(directory, "gateway.db");
  writer = createDatabase(path);
  statements = [];
  reader = new Database(path, { readonly: true });
  const prepare = reader.prepare.bind(reader);
  reader.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof reader.prepare;
  upsertDocuments(writer, [
    doc(NOTES, "recent-a", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-b", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-c", "2026-02-01T00:00:00.000Z"),
    doc(NOTES, "recent-d", "2025-09-15T00:00:00.000Z"),
    doc(NOTES, "at-cutoff", CUTOFF),
    doc(NOTES, "old-1", "2021-03-01T00:00:00.000Z"),
    doc(NOTES, "old-3", "2021-03-01T00:00:00.000Z"),
    doc(NOTES, "old-4", "2021-03-01T00:00:00.000Z"),
    doc(NOTES, "old-2", "2019-11-20T00:00:00.000Z"),
    doc(NOTES, "old-contact", "2018-05-05T00:00:00.000Z", "contact"),
    doc(DRIVE, "drive-old", "2017-01-01T00:00:00.000Z"),
    doc(DRIVE, "drive-new", "2026-01-01T00:00:00.000Z"),
  ] as never);
});

afterEach(() => {
  reader.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

function doc(
  sourceId: string,
  externalId: string,
  createdAt: string,
  documentType = "note",
): DocumentInput {
  return {
    providerId: sourceId.split(":")[0] as DocumentInput["providerId"],
    sourceId: sourceId as DocumentInput["sourceId"],
    externalId,
    title: `Invented ${documentType} ${externalId}`,
    content: `Invented ${documentType} ${externalId} about a Q4 budget review.`,
    contentHash: `hash-${externalId}`,
    metadata: { documentType },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: createdAt,
  };
}

function externalIds(ids: readonly string[]): string[] {
  const lookup = writer.prepare<[string], string>("SELECT external_id FROM documents WHERE id = ?");
  return ids.map((id) => lookup.pluck().get(id)!).sort();
}

function plan(sql: string): string {
  const params = Array.from(sql.matchAll(/\?/g), () => "2024-01-01T00:00:00.000Z");
  return writer
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
}

const notesOnly = (sourceId: string) => (sourceId === NOTES ? CUTOFF : null);
const notesMaxAge = (sourceId: string) => (sourceId === NOTES ? MAX_AGE : null);

/** `source_stats.doc_count` per source, as `/status` and `/index/stats` read it. */
function fullCounts(): Record<string, number> {
  const rows = writer
    .prepare<[], { source_id: string; doc_count: number }>(
      "SELECT source_id, doc_count FROM source_stats",
    )
    .all();
  return Object.fromEntries(rows.map((row) => [row.source_id, row.doc_count]));
}

describe("the indexable population", () => {
  test("a cutoff leaves older documents out and keeps in-window ones and exempt contacts", () => {
    expect(externalIds(listIndexableDocumentIds(reader, notesOnly))).toEqual([
      "at-cutoff",
      "drive-new",
      "drive-old",
      "old-contact",
      "recent-a",
      "recent-b",
      "recent-c",
      "recent-d",
    ]);
  });

  test("with no cutoff anywhere it is the full id list, unchanged", () => {
    expect(listIndexableDocumentIds(reader, () => null)).toEqual(listDocumentIds(reader));
  });

  test("widening the cutoff brings older documents back without anything to undo", () => {
    const widened = externalIds(listIndexableDocumentIds(reader, () => "2020-01-01T00:00:00.000Z"));
    expect(widened).toEqual(expect.arrayContaining(["old-1", "old-3", "old-4", "old-contact"]));
    expect(widened).not.toContain("old-2");
    expect(widened).not.toContain("drive-old");
  });

  test("the pre-cutoff range pages by keyset, a run of equal dates included", () => {
    const whole = listPreCutoffDocumentIdsForSource(reader, NOTES, CUTOFF);
    expect(externalIds(whole)).toEqual(["old-1", "old-2", "old-3", "old-4", "old-contact"]);
    for (const pageRows of [1, 2, 3]) {
      const paged = listPreCutoffDocumentIdsForSource(reader, NOTES, CUTOFF, pageRows);
      expect(paged).toEqual(whole);
    }
    expect(listIndexableDocumentIds(reader, notesOnly, 1).sort()).toEqual(
      listIndexableDocumentIds(reader, notesOnly).sort(),
    );
  });

  test("the cached counts agree with the list, per source", () => {
    expect(listDocumentSourceIds(reader).sort()).toEqual([DRIVE, NOTES].sort());
    const counts = indexableCountsBySource(reader, fullCounts(), notesMaxAge, NOW);
    const ids = listIndexableDocumentIds(reader, notesOnly);
    const bySource = (sourceId: string) =>
      externalIds(ids).filter((id) =>
        sourceId === DRIVE ? id.startsWith("drive") : !id.startsWith("drive"),
      ).length;
    expect(counts).toEqual({ [NOTES]: bySource(NOTES), [DRIVE]: bySource(DRIVE) });
    expect(counts).toEqual({ [NOTES]: 6, [DRIVE]: 2 });
  });

  test("the excluded counts are reused within their TTL and recomputed after it or on a new setting", () => {
    /** The list's count for NOTES at `now`, the figure the cached count must match once fresh. */
    const listed = (now: number) =>
      listIndexableDocumentIds(reader, (sourceId) =>
        sourceId === NOTES ? cutoffFromMaxAge(MAX_AGE, now) : null,
      ).filter((id) => !externalIds([id])[0]!.startsWith("drive")).length;

    expect(indexableCountsBySource(reader, fullCounts(), notesMaxAge, NOW)[NOTES]).toBe(
      listed(NOW),
    );
    upsertDocuments(writer, [doc(NOTES, "old-late", "2020-07-07T00:00:00.000Z")] as never);

    // Within the TTL the excluded figure is reused while the full count moves,
    // so a newly arrived old document reads as indexable for at most one TTL.
    expect(indexableCountsBySource(reader, fullCounts(), notesMaxAge, NOW + 1_000)[NOTES]).toBe(
      listed(NOW) + 1,
    );
    const later = NOW + EXCLUDED_COUNT_TTL_MS;
    expect(indexableCountsBySource(reader, fullCounts(), notesMaxAge, later)[NOTES]).toBe(
      listed(later),
    );

    // A changed setting does not wait for the TTL.
    expect(indexableCountsBySource(reader, fullCounts(), () => "unlimited", later + 1)).toEqual(
      fullCounts(),
    );
    expect(indexableCountsBySource(reader, fullCounts(), notesMaxAge, later + 2)[NOTES]).toBe(
      listed(later + 2),
    );
  });

  test("a maxAge too long to apply means no cutoff rather than an error", () => {
    expect(cutoffFromMaxAge("150y", NOW)).toBeNull();
    expect(cutoffFromMaxAge(null, NOW)).toBeNull();
    expect(cutoffFromMaxAge("unlimited", NOW)).toBeNull();
    expect(cutoffFromMaxAge(MAX_AGE, NOW)).toBe(CUTOFF);
    expect(indexableCountsBySource(reader, fullCounts(), () => "150y", NOW)).toEqual(fullCounts());
  });

  test("the in-memory skip and the queries draw the same line", () => {
    const rows = writer
      .prepare<[], { id: string; created: string; type: string }>(
        "SELECT id, source_created_at AS created, json_extract(metadata, '$.documentType') AS type FROM documents",
      )
      .all();
    const kept = rows
      .filter((row) => !isBeforeCutoff(CUTOFF, row.created, row.type))
      .map((row) => row.id);
    expect([...listIndexableDocumentIds(reader, () => CUTOFF)].sort()).toEqual(kept.sort());
  });
});

describe("index coverage, as the worker's boot checks read it", () => {
  test("pre-cutoff documents indexed earlier cannot hide a gap inside the window", () => {
    const indexDb = createIndexDatabase(join(directory, "index.db"));
    try {
      const idOf = (externalId: string) =>
        writer
          .prepare<[string], string>("SELECT id FROM documents WHERE external_id = ?")
          .pluck()
          .get(externalId)!;
      const indexed = ["old-1", "old-2", "old-3", "old-4", "drive-old", "recent-a", "recent-b"];
      for (const externalId of indexed)
        upsertChunksAndMarkIndexed(indexDb, idOf(externalId), "h", []);
      const allCutoff = () => CUTOFF;

      const coverage = indexCoverage(reader, indexDb, allCutoff);
      expect(coverage).toEqual({ indexable: 7, missing: 5 });
      expect(coverageBelow(coverage, 0.9)).toBe(true);
      expect(coverageBelow(coverage, 0.99)).toBe(true);
      // Indexed rows over the indexable count would read as fully covered.
      expect(getIndexedDocumentCount(indexDb) / coverage.indexable).toBe(1);

      for (const externalId of ["recent-c", "recent-d", "at-cutoff", "old-contact", "drive-new"]) {
        upsertChunksAndMarkIndexed(indexDb, idOf(externalId), "h", []);
      }
      expect(indexCoverage(reader, indexDb, allCutoff)).toEqual({ indexable: 7, missing: 0 });
      expect(coverageBelow(indexCoverage(reader, indexDb, allCutoff), 0.99)).toBe(false);

      // With the cutoff lifted, the pre-cutoff documents indexed earlier count
      // again, and the whole corpus is covered.
      expect(indexCoverage(reader, indexDb, () => null)).toEqual({ indexable: 12, missing: 0 });
    } finally {
      indexDb.close();
    }
  });

  test("an empty corpus is not below any coverage", () => {
    expect(coverageBelow({ indexable: 0, missing: 0 }, 0.9)).toBe(false);
  });
});

describe("query plans", () => {
  test("every statement reads through an index, never a scan of documents", () => {
    listIndexableDocumentIds(reader, notesOnly, 2);
    indexableCountsBySource(reader, fullCounts(), notesMaxAge, NOW);
    // The module's own statements; `listDocumentIds`' primary-key walk is the
    // unchanged full list it subtracts from.
    const distinct = [...new Set(statements)].filter((sql) =>
      /INDEXED BY|WITH RECURSIVE/.test(sql),
    );
    expect(distinct.length).toBeGreaterThanOrEqual(5);
    for (const sql of distinct) {
      const detail = plan(sql);
      expect(detail, sql).not.toMatch(/SCAN documents/);
      expect(detail, sql).toMatch(
        /SEARCH documents USING (COVERING )?INDEX idx_documents_(source_id|source_created_revision|contact_type)\b/,
      );
    }
  });

  test("the pre-cutoff page follows the index order with no sort, and its count is covering", () => {
    listPreCutoffDocumentIdsForSource(reader, NOTES, CUTOFF, 1);
    indexableCountsBySource(reader, fullCounts(), notesMaxAge, NOW);
    const keyset = plan(statements.find((sql) => sql.includes("id <= ?"))!);
    expect(keyset).toContain(
      "SEARCH documents USING COVERING INDEX idx_documents_source_created_revision (source_id=? AND source_created_at>? AND source_created_at<?)",
    );
    expect(keyset).not.toContain("TEMP B-TREE");
    expect(plan(statements.find((sql) => sql.includes("COUNT(*)"))!)).toContain(
      "SEARCH documents USING COVERING INDEX idx_documents_source_created_revision (source_id=? AND source_created_at<?)",
    );
  });
});
