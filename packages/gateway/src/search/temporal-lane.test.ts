// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexDatabase, EMBEDDING_DIM, upsertChunks } from "../indexer/db.js";
import {
  EXACT_WINDOW_MAX_CHUNKS,
  temporalLaneCandidates,
  WINDOW_NEIGHBOURS,
  type TemporalLaneRequest,
} from "./temporal-lane.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";
import type { VectorReadSource } from "../indexer/usearch-index.js";

/** A unit vector along one axis, so similarity picks out the chunks on that axis. */
function axis(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[i] = 1;
  return v;
}

interface Doc {
  id: string;
  content: string;
  createdAt: string;
  sourceId?: string;
  embedding?: Float32Array;
  chunks?: string[];
}

function insert(db: Database.Database, docs: Doc[]): void {
  upsertChunks(
    db,
    docs.flatMap((d) =>
      (d.chunks ?? [d.content]).map((content, chunkIndex) => ({
        id: `${d.id}-${chunkIndex}`,
        documentId: d.id,
        chunkIndex,
        content,
        embedding: d.embedding ?? axis(0),
        sourceId: d.sourceId ?? "gmail:maya@example.com",
        documentType: "email",
        title: content.slice(0, 30),
        sourceCreatedAt: d.createdAt,
      })),
    ),
  );
}

/**
 * An HNSW stand-in ranking every stored chunk by exact distance — the whole
 * corpus, not only the window, as the real index does.
 */
function exactIndex(db: Database.Database, asked: number[] = []): VectorReadSource {
  return {
    maybeRefresh() {},
    size: () => 0,
    search(query, k) {
      asked.push(k);
      const rows = db
        .prepare<[], { rowid: number; embedding: Buffer }>("SELECT rowid, embedding FROM chunks")
        .all();
      return rows
        .map((r) => {
          const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, EMBEDDING_DIM);
          let dot = 0;
          for (let i = 0; i < v.length; i++) dot += v[i]! * query[i]!;
          return { key: BigInt(r.rowid), distance: 1 - dot };
        })
        .sort((a, b) => a.distance - b.distance || Number(a.key - b.key))
        .slice(0, k);
    },
  };
}

const WEEK: TemporalLaneRequest["windows"] = [
  { start: "2026-09-28T00:00:00.000Z", endExclusive: "2026-10-05T00:00:00.000Z" },
];

function lane(overrides: Partial<TemporalLaneRequest> = {}): TemporalLaneRequest {
  return { windows: WEEK, eventDocumentIds: [], text: "", vector: null, weight: 1, ...overrides };
}

function run(
  db: Database.Database,
  request: TemporalLaneRequest,
  extra: {
    filters?: Parameters<typeof temporalLaneCandidates>[3];
    allowed?: string[];
    usearch?: VectorReadSource;
    limit?: number;
  } = {},
) {
  return temporalLaneCandidates(
    db,
    extra.usearch,
    request,
    extra.filters ?? {},
    extra.allowed,
    extra.limit ?? 10,
    { commonTokenThreshold: 0 },
  );
}

function rowidOf(db: Database.Database, documentId: string): number {
  return db
    .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
    .get(documentId)!.rowid;
}

/** Fills the week past the size ranked exactly, with chunks on an unrelated axis. */
function widen(db: Database.Database): void {
  const bulk: Doc[] = [];
  for (let i = 0; i <= EXACT_WINDOW_MAX_CHUNKS; i++) {
    bulk.push({
      id: `bulk-${i}`,
      content: `bulk note ${i}`,
      createdAt: "2026-10-03T00:00:00Z",
      embedding: axis(9),
    });
  }
  insert(db, bulk);
}

describe("temporalLaneCandidates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createIndexDatabase(`/tmp/omnesis-temporal-lane-${randomUUID()}.db`);
    insert(db, [
      // Inside the week by document time.
      {
        id: "in-receipt",
        content: "Stellarsound receipt for headphones",
        createdAt: "2026-09-30T10:00:00Z",
        embedding: axis(1),
      },
      {
        id: "in-lunch",
        content: "lunch plans at Brightmoor",
        createdAt: "2026-10-02T12:00:00Z",
        embedding: axis(2),
      },
      // Outside the week; matches the words but not the time.
      {
        id: "out-receipt",
        content: "Stellarsound receipt for speakers",
        createdAt: "2026-06-01T10:00:00Z",
        embedding: axis(1),
      },
      // Outside by document time, but about the week (event time).
      {
        id: "event-booking",
        content: "booking confirmed for the studio session",
        createdAt: "2026-08-15T09:00:00Z",
        embedding: axis(3),
      },
    ]);
  });
  afterEach(() => closeTempDb(db));

  it("ranks only documents inside the window by the query's words", () => {
    const { candidates, report } = run(db, lane({ text: "Stellarsound receipt" }));
    expect(candidates.map((c) => c.documentId)).toEqual(["in-receipt"]);
    expect(candidates[0]!.rank).toBe(1);
    expect(report.bm25Candidates).toBe(1);
    expect(report.timeOrdered).toBe(false);
  });

  it("admits event-time documents created outside the window", () => {
    const { candidates, report } = run(
      db,
      lane({ text: "studio booking", eventDocumentIds: ["event-booking"] }),
    );
    expect(candidates.map((c) => c.documentId)).toEqual(["event-booking"]);
    expect(report.eventDocuments).toBe(1);
  });

  it("ranks a small window by meaning exactly, without the HNSW index", () => {
    const asked: number[] = [];
    const { candidates, report } = run(
      db,
      lane({ text: "where are we eating", vector: axis(2), eventDocumentIds: ["event-booking"] }),
      { usearch: exactIndex(db, asked) },
    );
    expect(asked).toEqual([]);
    // No word matches; meaning puts the lunch first, and only window documents rank.
    expect(candidates[0]!.documentId).toBe("in-lunch");
    expect(candidates.map((c) => c.documentId).sort()).toEqual([
      "event-booking",
      "in-lunch",
      "in-receipt",
    ]);
    expect(report.vectorCandidates).toBe(3);
  });

  it("ranks a wide window through the query's neighbourhood, kept to the window", () => {
    widen(db);
    const asked: number[] = [];
    const { candidates } = run(db, lane({ text: "zzz", vector: axis(2) }), {
      usearch: exactIndex(db, asked),
    });
    expect(asked).toEqual([WINDOW_NEIGHBOURS]);
    expect(candidates[0]!.documentId).toBe("in-lunch");
    expect(candidates.map((c) => c.documentId)).not.toContain("out-receipt");
  });

  it("lists the window by time when its words match nothing and no vector lands in it", () => {
    widen(db);
    // The only neighbour lies outside the window.
    const outside: VectorReadSource = {
      maybeRefresh() {},
      size: () => 0,
      search: () => [{ key: BigInt(rowidOf(db, "out-receipt")), distance: 0.1 }],
    };
    const { report, candidates } = run(db, lane({ text: "— ?", vector: axis(1) }), {
      usearch: outside,
    });
    expect(report.timeOrdered).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("fuses the BM25 and vector lists, each document once at its best chunk", () => {
    insert(db, [
      {
        id: "in-long",
        content: "",
        chunks: Array.from({ length: 12 }, (_, i) => `Stellarsound part ${i}`),
        createdAt: "2026-10-01T08:00:00Z",
        embedding: axis(1),
      },
    ]);
    const { candidates } = run(db, lane({ text: "Stellarsound receipt", vector: axis(1) }), {
      usearch: exactIndex(db),
    });
    const ids = candidates.map((c) => c.documentId);
    expect(new Set(ids).size).toBe(ids.length);
    // The receipt matches both words; the long document's twelve chunks one word each.
    expect(ids[0]).toBe("in-receipt");
    expect(candidates.map((c) => c.rank)).toEqual(candidates.map((_, i) => i + 1));
  });

  it("ranks by words alone when the HNSW index cannot answer", () => {
    widen(db);
    const failing: VectorReadSource = {
      maybeRefresh() {},
      size: () => 0,
      search() {
        throw new Error("dimension mismatch");
      },
    };
    const { candidates, report } = run(
      db,
      lane({ text: "Stellarsound receipt", vector: axis(1) }),
      { usearch: failing },
    );
    expect(report.vectorCandidates).toBe(0);
    expect(candidates.map((c) => c.documentId)).toEqual(["in-receipt"]);
  });

  it("lists a window with no words by time: event documents first, then newest", () => {
    const { candidates, report } = run(db, lane({ eventDocumentIds: ["event-booking"] }));
    expect(report.timeOrdered).toBe(true);
    expect(candidates.map((c) => c.documentId)).toEqual([
      "event-booking",
      "in-lunch",
      "in-receipt",
    ]);
  });

  it("lists the window by time when no word survives and no vector ranks it", () => {
    const { candidates, report } = run(db, lane({ text: "— ?" }));
    expect(report.timeOrdered).toBe(true);
    expect(candidates.map((c) => c.documentId)).toEqual(["in-lunch", "in-receipt"]);
  });

  it("applies the search filters and the document-id restriction", () => {
    insert(db, [
      {
        id: "in-chat",
        content: "Stellarsound receipt forwarded in chat",
        createdAt: "2026-10-01T09:00:00Z",
        sourceId: "whatsapp:local",
      },
    ]);
    const bySource = run(db, lane({ text: "Stellarsound receipt" }), {
      filters: { sourceIds: ["whatsapp:local"] },
    });
    expect(bySource.candidates.map((c) => c.documentId)).toEqual(["in-chat"]);

    const byIds = run(db, lane({ text: "Stellarsound receipt" }), { allowed: ["in-receipt"] });
    expect(byIds.candidates.map((c) => c.documentId)).toEqual(["in-receipt"]);

    expect(run(db, lane({ text: "Stellarsound receipt" }), { allowed: [] }).candidates).toEqual([]);
  });

  it("widens its ranked head when the filters reject most of it", () => {
    // Forty in-window chat chunks outrank the one permitted email on words.
    const chats: Doc[] = [];
    for (let i = 0; i < 40; i++) {
      chats.push({
        id: `chat-${i}`,
        content: "Stellarsound receipt Stellarsound receipt",
        createdAt: "2026-10-01T09:00:00Z",
        sourceId: "whatsapp:local",
      });
    }
    insert(db, chats);
    const { candidates } = run(db, lane({ text: "Stellarsound receipt" }), {
      filters: { sourceIds: ["gmail:maya@example.com"] },
      limit: 1,
    });
    expect(candidates.map((c) => c.documentId)).toEqual(["in-receipt"]);
  });

  it("ranks the words of a phrase the time phrase was cut out of", () => {
    // "Stellarsound receipt 30 Sep 2026" with the date stripped.
    for (const text of ['"Stellarsound receipt', '"Stellarsound" "receipt', '"receipt" "', '"']) {
      expect(() => run(db, lane({ text }))).not.toThrow();
    }
    expect(run(db, lane({ text: '"Stellarsound receipt' })).candidates[0]?.documentId).toBe(
      "in-receipt",
    );
  });

  it("returns nothing for an empty window", () => {
    const { candidates } = run(
      db,
      lane({
        text: "receipt",
        windows: [{ start: "2020-01-01T00:00:00.000Z", endExclusive: "2020-01-02T00:00:00.000Z" }],
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("keeps the window's rowids out of the FTS5 index constraint", () => {
    // Handing the window's rowids to FTS5 as a constraint reruns the MATCH
    // once per rowid; the lane's statement must scan the MATCH once.
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    run(db, lane({ text: "receipt", eventDocumentIds: ["event-booking"] }));
    spy.mockRestore();
    const bm25 = statements.find((sql) => sql.includes("chunks_fts MATCH"))!;
    const params = ["receipt", WEEK[0]!.start, WEEK[0]!.endExclusive, '["event-booking"]', 10];
    const plan = db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${bm25}`)
      .all(...params)
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).not.toMatch(/INDEX 0:=/);
  });
});
