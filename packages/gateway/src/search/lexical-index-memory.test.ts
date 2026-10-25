// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { buildLexicalIndexData, lexicalIndexBytes } from "./lexical-index-data.js";
import {
  formatSize,
  planLexicalIndexBuild,
  readHostMemory,
  readLexicalCorpusStats,
} from "./lexical-index-memory.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const MiB = 1024 * 1024;
const GB = 1e9;
/** The build thread's fixed working memory, as the estimate counts it. */
const BUILD_FIXED = 128 * MiB;

describe("readLexicalCorpusStats", () => {
  let db: Db;
  beforeEach(() => {
    db = createIndexDatabase(`/tmp/omnesis-lexical-memory-${randomUUID()}.db`);
  });
  afterEach(() => closeTempDb(db));

  function chunk(i: number, content: string, title = ""): ChunkUpsertInput {
    return {
      id: `c${i}`,
      documentId: `d${i}`,
      chunkIndex: 0,
      content,
      title,
      embedding: new Float32Array(EMBEDDING_DIM).fill(0),
      sourceId: "notes",
      documentType: "note",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
    };
  }

  test("reads zero chunks from an empty index", () => {
    expect(readLexicalCorpusStats(db)).toEqual({ chunks: 0, tokens: 0, maxRowid: 0 });
  });

  test("matches the chunk and token counts a build reads", () => {
    const words = ["quarterly", "budget", "review", "marathon", "training", "studio", "notes"];
    const rows = Array.from({ length: 300 }, (_, i) =>
      chunk(
        i,
        Array.from({ length: 3 + (i % 200) }, (_, k) => words[(i * k) % words.length]).join(" "),
        i % 3 === 0 ? "weekly notes" : "",
      ),
    );
    upsertChunks(db, rows);
    const stats = readLexicalCorpusStats(db);
    const data = buildLexicalIndexData(db);
    expect(stats.chunks).toBe(data.docCount);
    expect(stats.tokens).toBe(Math.round(data.avgLength * data.docCount));
    expect(stats.maxRowid).toBe(data.rowids[data.rowids.length - 1]);
  });

  test("the first-build estimate covers the arrays of a real build of rare words", () => {
    // Rare words: nearly one posting per token and a large dictionary, the
    // worst case for the per-token estimate.
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const word = () => `w${Math.floor(rnd() * 50_000).toString(36)}`;
    upsertChunks(
      db,
      Array.from({ length: 400 }, (_, i) =>
        chunk(i, Array.from({ length: 5 + Math.floor(rnd() * 300) }, word).join(" "), word()),
      ),
    );
    const data = buildLexicalIndexData(db, { shared: true });
    const plan = planLexicalIndexBuild({
      corpus: readLexicalCorpusStats(db),
      memory: { availableBytes: 64 * GB, totalBytes: 64 * GB },
      rankers: 0,
    });
    expect(plan.indexBytes).toBeGreaterThanOrEqual(lexicalIndexBytes(data));
  });
});

describe("planLexicalIndexBuild", () => {
  const corpus = { chunks: 1_000_000, tokens: 150_000_000, maxRowid: 1_200_000 };
  const plenty = { availableBytes: 64 * GB, totalBytes: 128 * GB };

  test("estimates a first build from the layout: 12 B per chunk, 10 B per token, 21 B per chunk per ranker", () => {
    const plan = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 4 });
    const index = 12 * 1_000_000 + 10 * 150_000_000 + 4 * 21 * 1_000_000;
    expect(plan.indexBytes).toBe(index);
    expect(plan.peakBytes).toBe(index + 8 * 1_000_000 + 4 * 1_200_001 + BUILD_FIXED);
    expect(plan.fits).toBe(true);
  });

  test("a sparse rowid space adds no lookup table", () => {
    const sparse = { ...corpus, maxRowid: 40_000_000 };
    const dense = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 1 });
    const plan = planLexicalIndexBuild({ corpus: sparse, memory: plenty, rankers: 1 });
    expect(dense.peakBytes - plan.peakBytes).toBe(4 * 1_200_001);
  });

  test("skips a build whose peak exceeds half of the available memory", () => {
    const peak = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 4 }).peakBytes;
    const fits = planLexicalIndexBuild({
      corpus,
      memory: { availableBytes: 2 * peak, totalBytes: 128 * GB },
      rankers: 4,
    });
    expect(fits.fits).toBe(true);
    const tight = planLexicalIndexBuild({
      corpus,
      memory: { availableBytes: 2 * peak - 2, totalBytes: 128 * GB },
      rankers: 4,
    });
    expect(tight).toMatchObject({ fits: false, limitedBy: "available" });
  });

  test("skips an index larger than a quarter of the host's memory, however much is free", () => {
    const index = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 4 }).indexBytes;
    expect(
      planLexicalIndexBuild({
        corpus,
        memory: { availableBytes: 64 * GB, totalBytes: 4 * index },
        rankers: 4,
      }).fits,
    ).toBe(true);
    expect(
      planLexicalIndexBuild({
        corpus,
        memory: { availableBytes: 64 * GB, totalBytes: 4 * index - 4 },
        rankers: 4,
      }),
    ).toMatchObject({ fits: false, limitedBy: "total" });
  });

  test("a corpus of 800,000 chunks builds on a 16 GB host and is skipped on small ones", () => {
    const large = { chunks: 800_000, tokens: 120_000_000, maxRowid: 900_000 };
    const on = (availableGb: number, totalGb: number) =>
      planLexicalIndexBuild({
        corpus: large,
        memory: { availableBytes: availableGb * GB, totalBytes: totalGb * GB },
        rankers: 4,
      });
    expect(on(10, 16).fits).toBe(true);
    expect(on(1.5, 4)).toMatchObject({ fits: false, limitedBy: "available" });
    expect(on(1.6, 2)).toMatchObject({ fits: false, limitedBy: "available" });
    expect(on(3, 3.5)).toMatchObject({ fits: false, limitedBy: "total" });
  });

  test("a rebuild scales the measured index by the token count and counts both copies", () => {
    const current = { arrayBytes: 600 * MiB, docCount: 1_000_000, tokens: 100_000_000 };
    const plan = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 2 });
    const rebuild = planLexicalIndexBuild({ corpus, memory: plenty, rankers: 2, current });
    const newArrays = 600 * MiB * 1.5;
    const scratch = 2 * 21 * 1_000_000;
    expect(rebuild.indexBytes).toBe(newArrays + scratch);
    const currentBytes = 600 * MiB + scratch;
    expect(rebuild.peakBytes).toBe(
      currentBytes + newArrays + scratch + (plan.peakBytes - plan.indexBytes),
    );
    // What the current index holds counts toward the budget as well as the peak.
    expect(rebuild.peakBudgetBytes).toBe(0.5 * (64 * GB + currentBytes));
  });

  test("a rebuild is held to the same share: available memory excludes the current copy", () => {
    const current = { arrayBytes: 1.5 * GB, docCount: 1_000_000, tokens: 150_000_000 };
    // A first build of this corpus with this much free would fit; with a
    // 1.5 GB index already resident and the same free memory, the rebuild's
    // peak holds two copies.
    const memory = { availableBytes: 4 * GB, totalBytes: 16 * GB };
    expect(planLexicalIndexBuild({ corpus, memory, rankers: 1 }).fits).toBe(true);
    expect(planLexicalIndexBuild({ corpus, memory, rankers: 1, current }).fits).toBe(false);
  });
});

describe("readHostMemory", () => {
  test("reports positive figures with available memory within the total", () => {
    const m = readHostMemory();
    expect(m.availableBytes).toBeGreaterThan(0);
    expect(m.totalBytes).toBeGreaterThan(0);
    expect(m.availableBytes).toBeLessThanOrEqual(m.totalBytes * 1.01);
  });
});

describe("formatSize", () => {
  test("gigabytes with one decimal, whole megabytes below a gigabyte, never zero", () => {
    expect(formatSize(1_449_000_000)).toBe("1.4 GB");
    expect(formatSize(678_400_000)).toBe("678 MB");
    expect(formatSize(6152)).toBe("1 MB");
  });
});
