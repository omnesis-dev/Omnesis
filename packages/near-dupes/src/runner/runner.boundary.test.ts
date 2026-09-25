// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CorpusReader } from "../corpus/reader.js";
import { DupeStore } from "../store/repository.js";
import { DEFAULT_CONFIG } from "../algo/index.js";
import { jaccard } from "../algo/jaccard.js";
import { shingles, normalizeText } from "../algo/shingle.js";
import { NearDupeRunner } from "./runner.js";

/**
 * Boundary test for the record gate in runner.ts:
 *
 *   if (exact < this.opts.recordThreshold) return false;
 *
 * The `<` keeps pairs whose verified Jaccard EQUALS the threshold; a
 * mutation to `<=` would drop the exactly-equal pair. The interior
 * fixtures in runner.test.ts calibrate around `j ± 0.05`, so neither
 * sits on the boundary. This pins `recordThreshold === exact` exactly,
 * where `<` records (kept) and `<=` would not (dropped).
 */

/** Exact uniform-mode Jaccard the runner's verify() computes for a pair. */
function exactJaccard(contentA: string, contentB: string): number {
  const k = DEFAULT_CONFIG.shingleSize;
  const sa = shingles(normalizeText(contentA, { stripQuotes: DEFAULT_CONFIG.stripQuotes }), k);
  const sb = shingles(normalizeText(contentB, { stripQuotes: DEFAULT_CONFIG.stripQuotes }), k);
  return jaccard(sa, sb);
}

function seedCorpus(
  path: string,
  docs: Array<{ id: string; type: string; content: string }>,
): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extracted_content_hash TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_created_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_url TEXT,
      people_resolved_at TEXT,
      links_extracted_at TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
      content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of docs) {
    insert.run(
      d.id,
      "p",
      "s",
      d.id,
      "t",
      d.content,
      "ch-" + d.id,
      JSON.stringify({ documentType: d.type }),
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
  }
  db.close();
}

describe("NearDupeRunner record gate boundary (exact < recordThreshold)", () => {
  let corpusPath: string;
  let dupesPath: string;

  beforeEach(() => {
    corpusPath = `/tmp/omnesis-runner-boundary-corpus-${randomUUID()}.db`;
    dupesPath = `/tmp/omnesis-runner-boundary-dupes-${randomUUID()}.db`;
  });

  afterEach(() => {
    for (const p of [corpusPath, dupesPath]) {
      for (const s of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(p + s);
        } catch {
          // ignore
        }
      }
    }
  });

  it("records a pair whose verified Jaccard EQUALS recordThreshold (kept on `<`, dropped on `<=`)", () => {
    // Long shared body guarantees LSH collision (→ candidate); distinct short
    // tails keep the exact Jaccard strictly < 1, so it is a non-degenerate
    // boundary value.
    const body = Array.from({ length: 140 }, (_, i) => `shared-body-token-${i}`).join(" ");
    const tailA = " " + Array.from({ length: 5 }, (_, i) => `alpha-tail-${i}`).join(" ");
    const tailB = " " + Array.from({ length: 5 }, (_, i) => `bravo-tail-${i}`).join(" ");
    const contentA = body + tailA;
    const contentB = body + tailB;

    // The runner's verify() (uniform mode) computes EXACTLY this Jaccard, an
    // integer ratio inter/union, so re-deriving it here is bit-identical to
    // the value the gate compares against.
    const j = exactJaccard(contentA, contentB);
    expect(j).toBeGreaterThan(0.9);
    expect(j).toBeLessThan(1);

    seedCorpus(corpusPath, [
      { id: "doc-a", type: "note", content: contentA },
      { id: "doc-b", type: "note", content: contentB },
    ]);

    // recordThreshold set EXACTLY to the verified Jaccard: the pair sits on
    // the boundary. `exact < recordThreshold` is `j < j` → false → recorded.
    // The mutant `exact <= recordThreshold` is `j <= j` → true → dropped.
    const store = new DupeStore(dupesPath);
    const corpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const result = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store,
      corpus,
      runId: "boundary-equal",
      recordThreshold: j,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    corpus.close();

    // The pair really is a candidate (so the gate decision is real).
    expect(result.candidatesSeen).toBeGreaterThan(0);
    // On correct `<`, the exactly-on-threshold pair is recorded.
    expect(result.pairsRecorded).toBe(1);
    expect(store.countPairs(DEFAULT_CONFIG.algoVersion)).toBe(1);

    const pair = store.db
      .prepare(`SELECT jaccard FROM pairs WHERE algo_version = ?`)
      .get(DEFAULT_CONFIG.algoVersion) as { jaccard: number };
    expect(pair.jaccard).toBe(j);
    store.close();
  });

  it("drops a pair whose verified Jaccard is just below recordThreshold (control)", () => {
    // Same fixture, but recordThreshold nudged just above the verified
    // Jaccard. Now `exact < recordThreshold` is true → dropped under BOTH
    // the correct code and the mutant. This anchors that the equal-case
    // result above is the gate genuinely keeping the boundary pair, not a
    // pair that would be recorded regardless of threshold.
    const body = Array.from({ length: 140 }, (_, i) => `shared-body-token-${i}`).join(" ");
    const tailA = " " + Array.from({ length: 5 }, (_, i) => `alpha-tail-${i}`).join(" ");
    const tailB = " " + Array.from({ length: 5 }, (_, i) => `bravo-tail-${i}`).join(" ");
    const contentA = body + tailA;
    const contentB = body + tailB;
    const j = exactJaccard(contentA, contentB);

    seedCorpus(corpusPath, [
      { id: "doc-a", type: "note", content: contentA },
      { id: "doc-b", type: "note", content: contentB },
    ]);

    const store = new DupeStore(dupesPath);
    const corpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const result = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store,
      corpus,
      runId: "boundary-above",
      // A value strictly greater than the verified Jaccard (and < 1), so the
      // gate must drop the pair under both the correct code and the mutant.
      recordThreshold: j + 1e-9,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    corpus.close();

    expect(result.candidatesSeen).toBeGreaterThan(0);
    expect(result.pairsRecorded).toBe(0);
    expect(store.countPairs(DEFAULT_CONFIG.algoVersion)).toBe(0);
    store.close();
  });
});
