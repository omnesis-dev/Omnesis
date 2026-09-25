// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CorpusReader } from "../corpus/reader.js";
import { DupeStore } from "../store/repository.js";
import { DEFAULT_CONFIG, IDF_CONFIG } from "../algo/index.js";
import { jaccard } from "../algo/jaccard.js";
import { shingles, normalizeText } from "../algo/shingle.js";
import { NearDupeRunner } from "./runner.js";

/** Exact uniform-mode Jaccard the runner's verify() will compute for a pair. */
function exactJaccard(contentA: string, contentB: string): number {
  const k = DEFAULT_CONFIG.shingleSize;
  const sa = shingles(normalizeText(contentA, { stripQuotes: DEFAULT_CONFIG.stripQuotes }), k);
  const sb = shingles(normalizeText(contentB, { stripQuotes: DEFAULT_CONFIG.stripQuotes }), k);
  return jaccard(sa, sb);
}

function seedCorpus(
  path: string,
  docs: Array<{ id: string; type: string; content: string; contentHash?: string }>,
): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
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
    INSERT OR REPLACE INTO documents (id, provider_id, source_id, external_id, title, content,
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
      d.contentHash ?? "ch-" + d.id,
      JSON.stringify({ documentType: d.type }),
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
      "2025-01-01T00:00:00Z",
    );
  }
  db.close();
}

describe("NearDupeRunner", () => {
  let corpusPath: string;
  let dupesPath: string;

  beforeEach(() => {
    corpusPath = `/tmp/omnesis-runner-corpus-${randomUUID()}.db`;
    dupesPath = `/tmp/omnesis-runner-dupes-${randomUUID()}.db`;
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

  it("detects a near-duplicate pair and skips an unrelated doc", () => {
    const base =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod " +
      "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
      "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea " +
      "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate " +
      "velit esse cillum dolore eu fugiat nulla pariatur.";
    const tweaked =
      base.replace("consectetur adipiscing elit", "consectetur foo bar baz") +
      " Excepteur sint occaecat cupidatat non proident.";
    const unrelated =
      "The quick brown fox jumps over the lazy dog repeatedly. Pack my box with " +
      "five dozen liquor jugs. How vexingly quick daft zebras jump! The five " +
      "boxing wizards jump quickly. Sphinx of black quartz, judge my vow now.";
    seedCorpus(corpusPath, [
      { id: "doc-a", type: "note", content: base },
      { id: "doc-b", type: "note", content: tweaked },
      { id: "doc-c", type: "note", content: unrelated },
    ]);

    const store = new DupeStore(dupesPath);
    const corpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const runner = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store,
      corpus,
      runId: "run-1",
      recordThreshold: 0.5,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    });
    const result = runner.run();
    corpus.close();

    expect(result.docsProcessed).toBe(3);
    expect(result.pairsRecorded).toBe(1);

    const pair = store.db
      .prepare(`SELECT doc_a, doc_b, jaccard FROM pairs WHERE algo_version = ?`)
      .get(DEFAULT_CONFIG.algoVersion) as { doc_a: string; doc_b: string; jaccard: number };
    expect(pair.doc_a).toBe("doc-a");
    expect(pair.doc_b).toBe("doc-b");
    expect(pair.jaccard).toBeGreaterThan(0.6);

    store.close();
  });

  it("IDF mode rejects Hyrox-style boilerplate-driven pairs that vanilla accepts", () => {
    // Long shared legal boilerplate, then per-doc unique event metadata.
    const legal = Array.from({ length: 80 }, (_, i) => `term-${i}-of-service`).join(" ");
    const eventA = "event aurora festival 2026 dates march 15th to march 17th venue london stadium";
    const eventB = "event zenith expo 2026 dates october 12th to october 14th venue paris parc";
    // Add unrelated docs so the boilerplate becomes "common" in the corpus.
    const filler = Array.from({ length: 30 }, (_, i) => ({
      id: `filler-${i}`,
      type: "note",
      content: legal + ` filler-token-${i} repeated repeated repeated repeated repeated`,
    }));
    seedCorpus(corpusPath, [
      { id: "ticket-a", type: "note", content: legal + " " + eventA },
      { id: "ticket-b", type: "note", content: legal + " " + eventB },
      ...filler,
    ]);

    const storeUniform = new DupeStore(dupesPath);
    new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store: storeUniform,
      corpus: new CorpusReader(corpusPath, { minContentLength: 50 }),
      runId: "uniform-1",
      recordThreshold: 0.0,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    const uniformPair = storeUniform.db
      .prepare(
        `SELECT jaccard FROM pairs WHERE algo_version = ? AND
         ((doc_a = 'ticket-a' AND doc_b = 'ticket-b') OR
          (doc_a = 'ticket-b' AND doc_b = 'ticket-a'))`,
      )
      .get(DEFAULT_CONFIG.algoVersion) as { jaccard: number } | undefined;
    storeUniform.close();

    const storeIdf = new DupeStore(dupesPath);
    new NearDupeRunner({
      config: IDF_CONFIG,
      store: storeIdf,
      corpus: new CorpusReader(corpusPath, { minContentLength: 50 }),
      runId: "idf-1",
      recordThreshold: 0.0,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    const idfPair = storeIdf.db
      .prepare(
        `SELECT jaccard FROM pairs WHERE algo_version = ? AND
         ((doc_a = 'ticket-a' AND doc_b = 'ticket-b') OR
          (doc_a = 'ticket-b' AND doc_b = 'ticket-a'))`,
      )
      .get(IDF_CONFIG.algoVersion) as { jaccard: number } | undefined;
    storeIdf.close();

    expect(uniformPair).toBeDefined();
    expect(uniformPair!.jaccard).toBeGreaterThan(0.7);
    // IDF: boilerplate weighted near-0, unique event tokens differ → similarity collapses.
    expect(idfPair?.jaccard ?? 0).toBeLessThan(0.3);
  });

  it("does not record a pair whose verified Jaccard is below recordThreshold", () => {
    // Two docs that share a long body (so their Jaccard ≈ 0.95 reliably makes
    // them collide in an LSH band → become candidates) but each carries a
    // distinct short unique tail, so their exact Jaccard is strictly < 1.
    const body = Array.from({ length: 140 }, (_, i) => `shared-body-token-${i}`).join(" ");
    const tailA = " " + Array.from({ length: 5 }, (_, i) => `alpha-tail-${i}`).join(" ");
    const tailB = " " + Array.from({ length: 5 }, (_, i) => `bravo-tail-${i}`).join(" ");
    const contentA = body + tailA;
    const contentB = body + tailB;

    // The runner's verify() (uniform mode) computes exactly this Jaccard.
    const j = exactJaccard(contentA, contentB);
    expect(j).toBeGreaterThan(0.9);
    expect(j).toBeLessThan(1);

    seedCorpus(corpusPath, [
      { id: "doc-a", type: "note", content: contentA },
      { id: "doc-b", type: "note", content: contentB },
    ]);

    // First: a threshold below the true Jaccard records the pair — this both
    // calibrates the cutoff and proves the pair IS an LSH candidate (so the
    // below-threshold run's 0 is a real gate decision, not "never seen").
    const recordingStore = new DupeStore(dupesPath);
    const recordingCorpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const recorded = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store: recordingStore,
      corpus: recordingCorpus,
      runId: "below-record",
      recordThreshold: j - 0.05,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    recordingCorpus.close();
    recordingStore.close();
    expect(recorded.candidatesSeen).toBeGreaterThan(0);
    expect(recorded.pairsRecorded).toBe(1);

    // Wipe the side DB and re-run with a threshold strictly above the true
    // Jaccard: the pair is still a candidate but must be gated out.
    for (const s of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dupesPath + s);
      } catch {
        // ignore
      }
    }
    const gatedStore = new DupeStore(dupesPath);
    const gatedCorpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const gated = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store: gatedStore,
      corpus: gatedCorpus,
      runId: "above-record",
      recordThreshold: j + 0.05,
      maxCandidatesPerDoc: 100,
      skipExisting: false,
    }).run();
    gatedCorpus.close();

    expect(gated.candidatesSeen).toBeGreaterThan(0);
    expect(gated.pairsRecorded).toBe(0);
    expect(gatedStore.countPairs(DEFAULT_CONFIG.algoVersion)).toBe(0);
    gatedStore.close();
  });

  it("caps candidates per document at maxCandidatesPerDoc", () => {
    // Six docs with byte-identical content → identical minhash signatures →
    // identical LSH bands. Every doc therefore collides with every prior doc in
    // ALL bands (deterministic, no probabilistic LSH gap), so without a cap doc
    // i would see all i-1 predecessors as candidates (sum = 0+1+2+3+4+5 = 15).
    const body = Array.from({ length: 80 }, (_, i) => `corpus-body-token-${i}`).join(" ");
    const docs = Array.from({ length: 6 }, (_, i) => ({
      // Zero-padded ids keep streaming order deterministic (lexicographic).
      id: `doc-${String(i).padStart(2, "0")}`,
      type: "note",
      content: body,
    }));
    seedCorpus(corpusPath, docs);

    const cap = 2;
    const store = new DupeStore(dupesPath);
    const corpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const result = new NearDupeRunner({
      config: DEFAULT_CONFIG,
      store,
      corpus,
      runId: "cap-run",
      recordThreshold: 0.0,
      maxCandidatesPerDoc: cap,
      skipExisting: false,
    }).run();
    corpus.close();
    store.close();

    expect(result.docsProcessed).toBe(6);
    // Per-doc candidate counts, each capped at `cap`:
    //   doc0:0, doc1:min(1,2)=1, doc2..doc5: min(>=2,2)=2 each → 0+1+2+2+2+2 = 9.
    // Uncapped this would be 15; the cap is what brings it to 9.
    const expectedCapped = [0, 1, 2, 2, 2, 2].reduce((a, b) => a + b, 0);
    expect(result.candidatesSeen).toBe(expectedCapped);
    expect(result.candidatesSeen).toBeLessThan(15);
  });

  it("skipExisting avoids re-shingling on a re-run", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
    seedCorpus(corpusPath, [
      { id: "x", type: "note", content: text.repeat(5) },
      { id: "y", type: "note", content: text.repeat(5) + " extra " },
    ]);

    const store = new DupeStore(dupesPath);
    const corpus = new CorpusReader(corpusPath, { minContentLength: 50 });
    const opts = {
      config: DEFAULT_CONFIG,
      store,
      corpus,
      recordThreshold: 0.4,
      maxCandidatesPerDoc: 100,
      skipExisting: true,
    };
    new NearDupeRunner({ ...opts, runId: "run-1" }).run();
    const second = new NearDupeRunner({ ...opts, runId: "run-2" }).run();

    expect(second.docsProcessed).toBe(0);
    expect(second.docsSkipped).toBe(2);
    corpus.close();
    store.close();
  });

  it("re-sketches a document whose content changed between skipExisting re-runs", () => {
    // First-run content for doc-x. Long enough to produce a stable signature.
    const c1 =
      "The quarterly logistics report covers warehouse throughput, carrier " +
      "performance, and inventory turns across the northern distribution hubs " +
      "during the winter operating window with seasonal demand commentary.";
    // Materially different replacement content for the SAME id on the re-run,
    // near-identical to a freshly added neighbour doc-y.
    const c2Base =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod " +
      "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
      "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea " +
      "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate " +
      "velit esse cillum dolore eu fugiat nulla pariatur.";
    const c2Neighbour =
      c2Base.replace("consectetur adipiscing elit", "consectetur foo bar baz") +
      " Excepteur sint occaecat cupidatat non proident.";

    // Run 1: only doc-x exists, with content c1 and a distinct content hash.
    seedCorpus(corpusPath, [{ id: "doc-x", type: "note", content: c1, contentHash: "hash-c1" }]);
    const store = new DupeStore(dupesPath);
    const opts = {
      config: DEFAULT_CONFIG,
      store,
      recordThreshold: 0.4,
      maxCandidatesPerDoc: 100,
      skipExisting: true,
    };
    const corpus1 = new CorpusReader(corpusPath, { minContentLength: 50 });
    new NearDupeRunner({ ...opts, corpus: corpus1, runId: "run-1" }).run();
    corpus1.close();

    // doc-x's stored signature reflects c1.
    const afterRun1 = store.getMinhash("doc-x", DEFAULT_CONFIG.algoVersion);
    expect(afterRun1?.contentHash).toBe("hash-c1");

    // Run 2: doc-x is re-ingested with new content c2 (new hash); a near-identical
    // neighbour doc-y is added.
    seedCorpus(corpusPath, [
      { id: "doc-x", type: "note", content: c2Base, contentHash: "hash-c2" },
      { id: "doc-y", type: "note", content: c2Neighbour, contentHash: "hash-y" },
    ]);
    const corpus2 = new CorpusReader(corpusPath, { minContentLength: 50 });
    new NearDupeRunner({ ...opts, corpus: corpus2, runId: "run-2" }).run();
    corpus2.close();

    // doc-x must be re-sketched: its stored content hash now reflects c2.
    const afterRun2 = store.getMinhash("doc-x", DEFAULT_CONFIG.algoVersion);
    expect(afterRun2?.contentHash).toBe("hash-c2");

    // The near-dup relationship between doc-x's new content and doc-y must be found.
    const [docA, docB] = DupeStore.canonicalPairOrder("doc-x", "doc-y");
    const pair = store.db
      .prepare(`SELECT jaccard FROM pairs WHERE algo_version = ? AND doc_a = ? AND doc_b = ?`)
      .get(DEFAULT_CONFIG.algoVersion, docA, docB) as { jaccard: number } | undefined;
    expect(pair).toBeDefined();
    expect(pair!.jaccard).toBeGreaterThan(0.6);

    store.close();
  });
});
