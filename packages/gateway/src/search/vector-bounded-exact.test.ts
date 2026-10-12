// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createIndexDatabase,
  setActiveIndexVersion,
  upsertChunks,
  enqueueDocumentIndexPurge,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { UsearchReadHandle, UsearchWriteHandle } from "../indexer/usearch-index.js";
import { HIDDEN_SEARCH_SOURCES } from "./hidden-sources.js";
import { boundedExactVectorCandidates } from "./vector-bounded-exact.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-exact-vector-"));
  db = createIndexDatabase(join(dir, "index.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const query = new Float32Array([1, 0, 0, 0]);
function chunk(id: string, overrides: Partial<ChunkUpsertInput> = {}): ChunkUpsertInput {
  return {
    id,
    documentId: id,
    chunkIndex: 0,
    content: "Invented laboratory note.",
    sourceId: "fixture:read",
    title: id,
    sourceCreatedAt: "2026-03-10T14:00:00Z",
    documentType: "note",
    embedding: query,
    ...overrides,
  };
}
const search = (
  filters: Parameters<typeof boundedExactVectorCandidates>[2] = {},
  bound = 500,
  ids?: string[],
) => boundedExactVectorCandidates(db, query, filters, 50, bound, ids);

it("ranks the complete bounded set with stable ties and an inclusive date filter", () => {
  upsertChunks(db, [
    chunk("first"),
    chunk("second"),
    chunk("third", { embedding: new Float32Array([0, 1, 0, 0]) }),
  ]);
  const results = search({ dateTo: "2026-03-10" })!;
  expect(results.map((row) => [row.documentId, row.rank])).toEqual([
    ["first", 1],
    ["second", 2],
    ["third", 3],
  ]);
  expect(results[0]!.score).toBeCloseTo(1, 12);
  expect(results[1]!.score).toBeCloseTo(1, 12);
  expect(results[2]!.score).toBeCloseTo(0, 12);
  expect(search({ dateTo: "2026-03-09" })).toEqual([]);
});

it("preserves source/type/document/tag-AND and source-deletion visibility", () => {
  upsertChunks(db, [
    chunk("both", { tags: ["Blue", "LAB"] }),
    chunk("one", { tags: ["blue"] }),
    chunk("other", { sourceId: "fixture:other", tags: ["blue", "lab"] }),
    chunk("wrong-kind", { documentType: "message", tags: ["blue", "lab"] }),
    chunk("deleted", { tags: ["blue", "lab"] }),
  ]);
  enqueueDocumentIndexPurge(db, "deleted", true);
  expect(
    search({ sourceIds: ["fixture:read"], documentTypes: ["note"], tags: ["blue", "lab"] })?.map(
      (row) => row.documentId,
    ),
  ).toEqual(["both"]);
  expect(search({}, 500, ["one"])?.map((row) => row.documentId)).toEqual(["one"]);
  expect(search({}, 500, [])).toEqual([]);
});

it("uses a small indexed source inside a larger corpus without collecting the larger vectors", () => {
  upsertChunks(db, [
    chunk("wanted"),
    ...Array.from({ length: 510 }, (_, i) => chunk(`other-${i}`, { sourceId: "fixture:other" })),
  ]);
  expect(search()).toBeNull();
  expect(search({ sourceIds: ["fixture:read"] })?.map((row) => row.documentId)).toEqual(["wanted"]);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT rowid,length(embedding) FROM chunks WHERE source_id IN (?) LIMIT ?",
    )
    .all("fixture:read", 501) as Array<{ detail: string }>;
  expect(plan.some((row) => row.detail.includes("idx_chunks_source"))).toBe(true);
});

it("falls back before vector materialization when row, dimension or byte bounds are exceeded", () => {
  upsertChunks(db, [chunk("a"), chunk("b")]);
  expect(search({}, 1)).toBeNull();
  db.prepare("UPDATE chunks SET embedding=zeroblob(2000000) WHERE document_id='a'").run();
  expect(search()).toBeNull();
  expect(boundedExactVectorCandidates(db, new Float32Array(500_000), {}, 50, 500)).toBeNull();
  expect(boundedExactVectorCandidates(db, new Float32Array([NaN]), {}, 50, 500)).toBeNull();
});

it("does not scan a large scope merely because a later sparse tag filter matches few rows", () => {
  upsertChunks(
    db,
    Array.from({ length: 20 }, (_, i) => chunk(`row-${i}`, { tags: i === 19 ? ["rare"] : [] })),
  );
  expect(search({ sourceIds: ["fixture:read"], tags: ["rare"] }, 10)).toBeNull();
});

it("keeps exact filtered rankings stable through unrelated native graph remove/add churn", () => {
  const path = join(dir, "index.usearch");
  const writer = new UsearchWriteHandle(path, query.length);
  const rows = Array.from({ length: 227 }, (_, i) =>
    chunk(`doc-${i}`, {
      sourceId: i < 202 ? "fixture:read" : "fixture:write",
      embedding: new Float32Array([1, Math.sin(i * 0.7), Math.cos(i * 0.3), i % 7]),
    }),
  );
  let rng = 2;
  for (let i = rows.length - 1; i > 0; i--) {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    const j = rng % (i + 1);
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  upsertChunks(db, rows, { usearch: writer });
  writer.save();
  const reader = UsearchReadHandle.open(path, query.length);
  try {
    const baseline = search({ sourceIds: ["fixture:read"] });
    expect(baseline).toHaveLength(50);
    for (let round = 1; round <= 10; round++) {
      upsertChunks(
        db,
        rows
          .filter((row) => row.sourceId === "fixture:write")
          .map((row, i) => ({ ...row, embedding: new Float32Array([round, i, 1, round % 3]) })),
        { usearch: writer },
      );
      writer.save();
      reader.maybeRefresh();
      expect(reader.size()).toBe(227);
      expect(search({ sourceIds: ["fixture:read"] })).toEqual(baseline);
    }
  } finally {
    reader.close();
    writer.close();
  }
});

it("keeps internal sources hidden unless explicitly requested", () => {
  const hidden = HIDDEN_SEARCH_SOURCES[0]!;
  upsertChunks(db, [
    chunk("visible"),
    chunk("internal", { sourceId: hidden.sourceId, documentType: hidden.documentTypes[0]! }),
  ]);
  expect(search()?.map((row) => row.documentId)).toEqual(["visible"]);
  expect(search({ sourceIds: [hidden.sourceId] })?.map((row) => row.documentId)).toEqual([
    "internal",
  ]);
});

it("rechecks the embedding model in the same snapshot as exact vector bytes", () => {
  upsertChunks(db, [chunk("unchanged-id")]);
  db.prepare(
    "INSERT INTO index_versions(version,embed_model,embed_dim,state,created_at) VALUES(1,'new-model',4,'active','2026-01-01')",
  ).run();
  setActiveIndexVersion(db, 1);
  expect(() =>
    boundedExactVectorCandidates(db, query, {}, 50, 500, undefined, "old-model"),
  ).toThrow("different embedding generation");
  expect(
    boundedExactVectorCandidates(db, query, {}, 50, 500, undefined, "new-model")?.map(
      (row) => row.documentId,
    ),
  ).toEqual(["unchanged-id"]);
  expect(() =>
    boundedExactVectorCandidates(db, new Float32Array(8), {}, 50, 500, undefined, "new-model"),
  ).toThrow("different embedding generation");
});
