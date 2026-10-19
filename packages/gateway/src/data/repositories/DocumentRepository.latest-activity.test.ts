// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The per-source stats a page write maintains on the writer: `doc_count` and
 * the materialized `latest_*` columns. Their cost must follow the page, not
 * the source — a mailbox of any size pays the same for one new message — so
 * the latest-activity lookup's plan is pinned here, and a page of unchanged
 * documents must not touch the row at all.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../../db.js";
import {
  deleteDocuments,
  deleteDocumentsByIds,
  LATEST_ACTIVITY_SQL,
  refreshLatestActivity,
  upsertDocuments,
} from "./DocumentRepository.js";
import type { Db } from "../types.js";
import type { DocumentInput } from "@omnesis/types";

const SOURCE = "gmail:maya@example.com";
const OTHER = "gmail:jamie@example.com";

let db: Db;
let path: string;

beforeEach(() => {
  path = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createDatabase(path);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
});

function doc(externalId: string, overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: "google" as DocumentInput["providerId"],
    sourceId: SOURCE as DocumentInput["sourceId"],
    externalId,
    title: `Message ${externalId}`,
    content: `Body of ${externalId}`,
    contentHash: `ch-${externalId}`,
    metadata: { documentType: "email" },
    sourceCreatedAt: "2026-01-01T10:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function stats(sourceId = SOURCE) {
  return db
    .prepare<
      [string],
      {
        doc_count: number;
        needs_refresh: number;
        dirty_version: number;
        latest_doc_id: string | null;
        latest_title: string | null;
        latest_updated_at: string | null;
      }
    >(
      `SELECT doc_count, needs_refresh, dirty_version, latest_doc_id, latest_title, latest_updated_at
         FROM source_stats WHERE source_id = ?`,
    )
    .get(sourceId);
}

function idOf(externalId: string): string {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

/** The ordering the lookup must reproduce, written the obvious way. */
function freshestByFullSort(sourceId: string): unknown {
  return db
    .prepare(
      `SELECT id, title, source_created_at, source_updated_at, ingested_at, updated_at
         FROM documents NOT INDEXED
        WHERE source_id = ?
        ORDER BY updated_at DESC, source_updated_at DESC, id DESC
        LIMIT 1`,
    )
    .get(sourceId);
}

describe("latest-activity lookup", () => {
  test("seeks the (source_id, updated_at) index and never sorts the whole source", () => {
    const plan = db
      .prepare<[string, string], { detail: string }>(`EXPLAIN QUERY PLAN ${LATEST_ACTIVITY_SQL}`)
      .all(SOURCE, SOURCE)
      .map((row) => row.detail);
    // Outer row lookup: both equality terms served by the index, so the
    // remaining sort only orders rows tied on the newest updated_at.
    expect(plan).toContain(
      "SEARCH documents USING INDEX idx_documents_source_id_updated_at (source_id=? AND updated_at=?)",
    );
    // The MAX is a covering seek on the same index.
    expect(plan).toContain(
      "SEARCH documents USING COVERING INDEX idx_documents_source_id_updated_at (source_id=?)",
    );
    expect(plan.some((detail) => /SCAN documents/.test(detail))).toBe(false);
  });

  test("returns the same row as a full sort, including ties on updated_at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
    upsertDocuments(db, [doc("old-1"), doc("old-2")]);
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    // Three rows share the newest updated_at: the tie-break is
    // source_updated_at DESC, then id DESC.
    upsertDocuments(db, [
      doc("tie-a", { sourceUpdatedAt: "2026-02-01T00:00:00.000Z" }),
      doc("tie-b", { sourceUpdatedAt: "2026-02-03T00:00:00.000Z" }),
      doc("tie-c", { sourceUpdatedAt: "2026-02-03T00:00:00.000Z" }),
    ]);
    upsertDocuments(db, [doc("elsewhere", { sourceId: OTHER as DocumentInput["sourceId"] })]);

    const expected = freshestByFullSort(SOURCE) as { id: string };
    expect(db.prepare(LATEST_ACTIVITY_SQL).get(SOURCE, SOURCE)).toEqual(expected);
    expect([idOf("tie-b"), idOf("tie-c")]).toContain(expected.id);
    expect(stats()?.latest_doc_id).toBe(expected.id);
    expect(db.prepare(LATEST_ACTIVITY_SQL).get(OTHER, OTHER)).toEqual(freshestByFullSort(OTHER));
  });

  test("clears the columns when the source has no documents left", () => {
    upsertDocuments(db, [doc("only")]);
    db.prepare("DELETE FROM documents WHERE source_id = ?").run(SOURCE);
    refreshLatestActivity(db, SOURCE);
    expect(stats()).toMatchObject({ latest_doc_id: null, latest_title: null });
  });
});

describe("per-source stats maintenance on a page write", () => {
  test("a page of unchanged documents leaves source_stats untouched", () => {
    upsertDocuments(db, [doc("a"), doc("b")]);
    db.prepare("UPDATE source_stats SET needs_refresh = 0 WHERE source_id = ?").run(SOURCE);
    const before = stats();

    upsertDocuments(db, [doc("a"), doc("b")]);

    expect(stats()).toEqual(before);
  });

  test("a new document recounts and moves latest activity to it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
    upsertDocuments(db, [doc("a"), doc("b")]);
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    // Re-sent unchanged documents ride along with the new one.
    upsertDocuments(db, [doc("a"), doc("b"), doc("c")]);

    expect(stats()).toMatchObject({
      doc_count: 3,
      needs_refresh: 1,
      latest_doc_id: idOf("c"),
      latest_updated_at: "2026-03-01T10:00:00.000Z",
    });
  });

  test("an edited document moves latest activity without changing the count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
    upsertDocuments(db, [doc("a"), doc("b")]);
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    upsertDocuments(db, [doc("a", { contentHash: "ch-a-2", content: "Edited" })]);

    expect(stats()).toMatchObject({ doc_count: 2, latest_doc_id: idOf("a") });
  });

  test("deleting by external id drops the count by what was removed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T09:00:00.000Z"));
    upsertDocuments(db, [doc("a"), doc("b")]);
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    upsertDocuments(db, [doc("c")]);
    const version = stats()!.dirty_version;

    deleteDocuments(db, "google", SOURCE, ["c", "missing"]);

    const after = stats()!;
    expect(after).toMatchObject({ doc_count: 2, needs_refresh: 1 });
    expect(after.dirty_version).toBeGreaterThan(version);
    expect(after.latest_doc_id).toBe((freshestByFullSort(SOURCE) as { id: string }).id);
  });

  test("a delete that matches nothing leaves source_stats untouched", () => {
    upsertDocuments(db, [doc("a")]);
    const before = stats();
    deleteDocuments(db, "google", SOURCE, ["missing"]);
    expect(stats()).toEqual(before);
  });

  test("deleting by id adjusts each source by its own removals", () => {
    upsertDocuments(db, [doc("a"), doc("b"), doc("c")]);
    upsertDocuments(db, [
      doc("x", { sourceId: OTHER as DocumentInput["sourceId"] }),
      doc("y", { sourceId: OTHER as DocumentInput["sourceId"] }),
    ]);

    deleteDocumentsByIds(db, [idOf("a"), idOf("b"), idOf("x")]);

    expect(stats()).toMatchObject({ doc_count: 1, latest_doc_id: idOf("c") });
    expect(stats(OTHER)).toMatchObject({ doc_count: 1, latest_doc_id: idOf("y") });
  });
});
