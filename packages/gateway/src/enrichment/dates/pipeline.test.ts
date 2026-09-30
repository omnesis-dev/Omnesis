// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end pipeline test tying the real fetch → extract → persist → read
 * functions together — exactly the chain the io / cpu / writer handlers wrap,
 * without spawning workers. Proves anchored extraction lands correctly in the
 * store and is served back by the reader.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { extractDatesForDocs } from "./extractor.js";
import {
  applyExtractedDates,
  countPendingDateExtraction,
  fetchDateExtractionBatch,
  getExtractedDatesForDocument,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput } from "@omnesis/types";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(o: Partial<DocumentInput> & { externalId: string }): DocumentInput {
  return {
    providerId: "test" as DocumentInput["providerId"],
    sourceId: "test:acct" as DocumentInput["sourceId"],
    title: "msg",
    content: "",
    contentHash: `hash-${o.externalId}`,
    metadata: {},
    sourceCreatedAt: "2022-01-21T10:00:00.000Z",
    sourceUpdatedAt: "2022-01-21T10:00:00.000Z",
    ...o,
  };
}

/** Run one full drip tick against the DB, the way the scheduler task does. */
function runTick(db: Db, batchSize: number, maxChars: number): { applied: number } {
  const rows = fetchDateExtractionBatch(db, batchSize, maxChars);
  if (rows.length === 0) return { applied: 0 };
  const results = extractDatesForDocs(rows, { maxCharsPerDoc: maxChars });
  return applyExtractedDates(db, results);
}

describe("date-enrichment pipeline (fetch → extract → persist → read)", () => {
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

  it("extracts anchored dates and serves them back through the reader", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "email-1",
        content: "we should meet up again tomorrow",
        sourceCreatedAt: "2022-01-21T10:00:00.000Z",
      }),
    ]);
    const id = (
      db.prepare("SELECT id FROM documents WHERE external_id = ?").get("email-1") as { id: string }
    ).id;

    runTick(db, 50, 20_000);

    const dates = getExtractedDatesForDocument(db, id);
    expect(dates).toHaveLength(1);
    expect(dates[0].resolvedStart).toBe("2022-01-22"); // tomorrow-of-emission, not today
  });

  it("drains a backlog of old documents across ticks and then goes idle", () => {
    const docs = Array.from({ length: 40 }, (_, i) =>
      makeDoc({
        externalId: `d-${i}`,
        content: i % 2 === 0 ? "let's talk next monday" : "just a plain message with no dates",
        sourceCreatedAt: "2022-01-21T10:00:00.000Z",
      }),
    );
    upsertDocuments(db, docs);
    expect(countPendingDateExtraction(db)).toBe(40);

    // Batch of 15 → three ticks drain all 40, then a fourth finds nothing.
    let ticks = 0;
    let applied = 0;
    while (countPendingDateExtraction(db) > 0 && ticks < 10) {
      applied += runTick(db, 15, 20_000).applied;
      ticks++;
    }
    expect(applied).toBe(40);
    expect(countPendingDateExtraction(db)).toBe(0);
    expect(runTick(db, 15, 20_000).applied).toBe(0); // idle — nothing left

    // Half the docs carried "next monday" (2022-01-24); the other half none.
    const withDates = docs.filter((_, i) => i % 2 === 0);
    for (const d of withDates.slice(0, 3)) {
      const id = (
        db.prepare("SELECT id FROM documents WHERE external_id = ?").get(d.externalId) as {
          id: string;
        }
      ).id;
      const dates = getExtractedDatesForDocument(db, id);
      expect(dates[0]?.resolvedStart).toBe("2022-01-24");
    }
  });

  it("routes a French document to the French culture end-to-end (title fetched for detection)", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "fr-1",
        title: "Confirmation de réservation",
        content:
          "Bonjour, votre séjour est confirmé pour le 30 septembre 2027. Merci de votre confiance.",
        sourceCreatedAt: "2024-06-15T10:00:00.000Z",
      }),
    ]);
    const id = (
      db.prepare("SELECT id FROM documents WHERE external_id = ?").get("fr-1") as { id: string }
    ).id;

    runTick(db, 50, 20_000);

    const dates = getExtractedDatesForDocument(db, id);
    expect(dates.map((d) => d.resolvedStart)).toContain("2027-09-30");
  });

  it("stores each mention's days and its document's thread through fetch → extract → persist", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "reply-1",
        title: "Re: invented plans",
        content: "Confirmed for 30 September 2024. Also sometime in Q4.",
        metadata: { extra: { threadId: "thread-1" } },
        sourceCreatedAt: "2024-06-15T10:00:00.000Z",
      }),
    ]);

    expect(runTick(db, 50, 20_000).applied).toBe(1);

    const rows = db
      .prepare(
        "SELECT matched_text, mention_start_day, mention_end_day, thread_key FROM document_extracted_dates ORDER BY id",
      )
      .all() as Array<Record<string, string | null>>;
    expect(rows.find((row) => row.matched_text === "30 September 2024")).toMatchObject({
      mention_start_day: "2024-09-30",
      mention_end_day: "2024-10-01",
    });
    expect(
      rows.find((row) => /q4/i.test(String(row.matched_text)))?.mention_start_day ?? null,
    ).toBeNull();
    expect(new Set(rows.map((row) => row.thread_key))).toEqual(
      new Set(["test:acct\u0000thread-1"]),
    );
  });
});
