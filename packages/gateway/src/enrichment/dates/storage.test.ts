// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments, deleteDocuments } from "../../data/repositories/DocumentRepository.js";
import {
  applyExtractedDates,
  countExtractedDocuments,
  countPendingDateExtraction,
  fetchDateExtractionBatch,
  getExtractedDatesForDocument,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput, ExtractedDate } from "@omnesis/types";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: "test" as DocumentInput["providerId"],
    sourceId: "test:acct" as DocumentInput["sourceId"],
    externalId: "ext-1",
    title: "Renewal notice",
    content: "Your subscription renews next week.",
    contentHash: "hash-1",
    metadata: {},
    sourceCreatedAt: "2022-01-21T10:00:00.000Z",
    sourceUpdatedAt: "2022-01-21T10:00:00.000Z",
    ...overrides,
  };
}

function docId(db: Db, externalId: string): string {
  return (
    db.prepare("SELECT id FROM documents WHERE external_id = ?").get(externalId) as { id: string }
  ).id;
}

const SAMPLE_DATES: ExtractedDate[] = [
  {
    kind: "date",
    resolvedStart: "2022-01-28",
    resolvedEnd: null,
    relative: true,
    text: "next week",
    timex: "2022-W04",
    charStart: 21,
    charEnd: 30,
  },
  {
    kind: "range",
    resolvedStart: null,
    resolvedEnd: "2024-08-04",
    mod: "before",
    relative: false,
    text: "before 8/04/2024",
    timex: "2024-08-04",
    charStart: 40,
    charEnd: 56,
  },
];

describe("date-enrichment storage", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("marks a freshly ingested document as pending extraction", () => {
    upsertDocuments(db, [makeDoc()]);
    expect(countPendingDateExtraction(db)).toBe(1);
    expect(countExtractedDocuments(db)).toBe(0);
    const batch = fetchDateExtractionBatch(db, 10, 20_000);
    expect(batch).toHaveLength(1);
    expect(batch[0].content).toContain("subscription renews");
    // The anchor prefers the last edit; this doc's created and updated
    // timestamps coincide.
    expect(batch[0].anchorAt).toBe("2022-01-21T10:00:00.000Z");
    expect(batch[0].contentLength).toBe(batch[0].content.length);
  });

  it("anchors on the last edit when it differs from creation", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "ext-edited",
        sourceCreatedAt: "2022-01-21T10:00:00.000Z",
        sourceUpdatedAt: "2022-06-30T08:00:00.000Z",
      }),
    ]);
    const batch = fetchDateExtractionBatch(db, 10, 20_000);
    const edited = batch.find((b) => b.content.length > 0 && b.anchorAt.startsWith("2022-06-30"));
    expect(edited, "the edited doc anchors on its update timestamp").toBeDefined();
  });

  it("stamps dates_truncated when the scan covered only a prefix", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");
    applyExtractedDates(db, [{ id, dates: [], truncated: true }]);
    const flag = db.prepare("SELECT dates_truncated AS t FROM documents WHERE id = ?").get(id) as {
      t: number | null;
    };
    expect(flag.t).toBe(1);
    // A full re-scan clears the marker.
    db.prepare("UPDATE documents SET dates_extracted_at = NULL WHERE id = ?").run(id);
    applyExtractedDates(db, [{ id, dates: [], truncated: false }]);
    const cleared = db
      .prepare("SELECT dates_truncated AS t FROM documents WHERE id = ?")
      .get(id) as { t: number | null };
    expect(cleared.t).toBeNull();
  });

  it("persists dates, stamps the flag, and round-trips through the reader", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");

    const res = applyExtractedDates(db, [{ id, dates: SAMPLE_DATES, truncated: false }]);
    expect(res.applied).toBe(1);
    expect(res.datesWritten).toBe(2);

    // Flag stamped → no longer pending, no longer fetched.
    expect(countPendingDateExtraction(db)).toBe(0);
    expect(countExtractedDocuments(db)).toBe(1);
    expect(fetchDateExtractionBatch(db, 10, 20_000)).toHaveLength(0);

    const read = getExtractedDatesForDocument(db, id);
    expect(read).toHaveLength(2);
    // Resolved dates sort before nulls; among resolved, the "date" row first.
    const dateRow = read.find((d) => d.kind === "date")!;
    expect(dateRow.resolvedStart).toBe("2022-01-28");
    expect(dateRow.relative).toBe(true);
    const rangeRow = read.find((d) => d.kind === "range")!;
    expect(rangeRow.mod).toBe("before");
    expect(rangeRow.resolvedEnd).toBe("2024-08-04");
    expect(rangeRow.resolvedStart).toBeNull();
    expect(rangeRow.relative).toBe(false);
  });

  it("re-extraction replaces prior rows rather than duplicating", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");
    applyExtractedDates(db, [{ id, dates: SAMPLE_DATES, truncated: false }]);
    applyExtractedDates(db, [{ id, dates: [SAMPLE_DATES[0]], truncated: false }]);
    expect(getExtractedDatesForDocument(db, id)).toHaveLength(1);
  });

  it("nulls the flag when the document content changes (re-extraction needed)", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");
    applyExtractedDates(db, [{ id, dates: SAMPLE_DATES, truncated: false }]);
    expect(countPendingDateExtraction(db)).toBe(0);

    // Same document key, new content + hash → dates_extracted_at reset to NULL.
    upsertDocuments(db, [makeDoc({ content: "Now it renews tomorrow.", contentHash: "hash-2" })]);
    expect(countPendingDateExtraction(db)).toBe(1);
    expect(fetchDateExtractionBatch(db, 10, 20_000)[0].id).toBe(id);
  });

  it("does NOT null the flag on a metadata-only change", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");
    applyExtractedDates(db, [{ id, dates: SAMPLE_DATES, truncated: false }]);

    // Same content/hash, changed metadata → extraction stays valid.
    upsertDocuments(db, [makeDoc({ metadata: { tags: ["new"] } })]);
    expect(countPendingDateExtraction(db)).toBe(0);
  });

  it("cascade-deletes date rows when the document is deleted", () => {
    upsertDocuments(db, [makeDoc()]);
    const id = docId(db, "ext-1");
    applyExtractedDates(db, [{ id, dates: SAMPLE_DATES, truncated: false }]);
    expect(getExtractedDatesForDocument(db, id)).toHaveLength(2);

    deleteDocuments(db, "test", "test:acct", ["ext-1"]);
    expect(getExtractedDatesForDocument(db, id)).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM document_extracted_dates").get() as { c: number }).c,
    ).toBe(0);
  });

  it("skips a document deleted between fetch and apply (no FK violation)", () => {
    const goneId = randomUUID();
    expect(() =>
      applyExtractedDates(db, [{ id: goneId, dates: SAMPLE_DATES, truncated: false }]),
    ).not.toThrow();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM document_extracted_dates").get() as { c: number }).c,
    ).toBe(0);
  });
});
