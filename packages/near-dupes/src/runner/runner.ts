// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { compileConfig, type NearDupeConfig } from "../algo/index.js";
import { UniformSketcher, IdfSketcher, type Sketcher } from "../algo/sketcher.js";
import { signatureSimilarity } from "../algo/jaccard.js";
import { weightedSignatureSimilarity } from "../algo/weighted-minhash.js";
import { DfTable } from "../algo/idf.js";
import { normalizeText, shingles } from "../algo/shingle.js";
import { DupeStore, type BucketRow } from "../store/repository.js";
import type { CorpusReader, CorpusDoc } from "../corpus/reader.js";

export interface RunnerOptions {
  config: NearDupeConfig;
  store: DupeStore;
  corpus: CorpusReader;
  runId: string;
  recordThreshold: number;
  maxCandidatesPerDoc: number;
  skipExisting: boolean;
  onProgress?: (p: RunnerProgress) => void;
}

export interface RunnerProgress {
  phase: "idf" | "sketch";
  processed: number;
  skipped: number;
  candidatesSeen: number;
  pairsRecorded: number;
  lastId: string;
}

export interface RunnerResult {
  docsProcessed: number;
  docsSkipped: number;
  candidatesSeen: number;
  pairsRecorded: number;
  idfDocsScanned: number;
  uniqueShingles: number;
  elapsedMs: number;
}

export class NearDupeRunner {
  private readonly compiled: ReturnType<typeof compileConfig>;
  private readonly sketcher: Sketcher;
  private readonly dfTable: DfTable | null;

  constructor(private readonly opts: RunnerOptions) {
    this.compiled = compileConfig(opts.config);
    if (opts.config.weighting === "idf") {
      this.dfTable = new DfTable();
      this.sketcher = new IdfSketcher(
        this.compiled.weightedMinhashParams,
        this.compiled.lshParams,
        this.dfTable,
        { maxWeight: opts.config.maxIdfWeight },
      );
    } else {
      this.dfTable = null;
      this.sketcher = new UniformSketcher(this.compiled.minhashParams, this.compiled.lshParams);
    }
  }

  /**
   * Process the entire corpus. For IDF weighting, two passes:
   * (1) build the document-frequency table; (2) sign + verify. For
   * uniform weighting, just the second pass. Each pair is verified
   * once, from the second-arriving document's perspective.
   */
  run(): RunnerResult {
    const { store, corpus, config, runId, onProgress } = this.opts;
    const start = Date.now();

    const idfDocsScanned = this.dfTable ? this.buildDfTable() : 0;

    let processed = 0;
    let skipped = 0;
    let candidatesSeen = 0;
    let pairsRecorded = 0;
    let lastId = "";

    store.beginRun({
      runId,
      algoVersion: config.algoVersion,
      configJson: JSON.stringify({
        ...config,
        idfDocsScanned,
        uniqueShingles: this.dfTable?.size() ?? 0,
      }),
      startedAt: Math.floor(start / 1000),
    });

    for (const doc of corpus.stream()) {
      lastId = doc.id;
      const existing = this.opts.skipExisting ? store.getMinhash(doc.id, config.algoVersion) : null;
      if (existing && existing.contentHash === doc.contentHash) {
        skipped++;
        continue;
      }
      // The document's content changed since it was last sketched. Drop its
      // stale band buckets before rebuilding so it no longer surfaces as a
      // candidate under its old signature; the minhash row and any pairs are
      // refreshed below via INSERT OR REPLACE.
      if (existing) {
        store.deleteBuckets(doc.id, config.algoVersion);
      }

      const docShingles = shingles(
        normalizeText(doc.content, { stripQuotes: config.stripQuotes }),
        config.shingleSize,
      );
      if (docShingles.size === 0) {
        skipped++;
        continue;
      }

      const sig = this.sketcher.sign(docShingles);
      const buckets = this.sketcher.bands(sig);

      const candidateIds = this.findAndCapCandidates(doc.id, buckets);
      candidatesSeen += candidateIds.length;

      for (const candId of candidateIds) {
        const recorded = this.verifyAndRecord(doc, docShingles, sig, candId, runId);
        if (recorded) pairsRecorded++;
      }

      store.upsertMinhash({
        documentId: doc.id,
        algoVersion: config.algoVersion,
        signature: sig,
        shingleCount: docShingles.size,
        contentHash: doc.contentHash,
        docType: doc.docType,
        pluginId: doc.sourceId,
        sourceCreatedAt: doc.sourceCreatedAt,
        computedAt: Math.floor(Date.now() / 1000),
      });

      const bucketRows: BucketRow[] = [];
      for (let band = 0; band < buckets.length; band++) {
        bucketRows.push({
          algoVersion: config.algoVersion,
          bandIdx: band,
          bucketHash: buckets[band],
          documentId: doc.id,
        });
      }
      store.insertBuckets(bucketRows);

      processed++;
      if (onProgress && processed % 200 === 0) {
        onProgress({
          phase: "sketch",
          processed,
          skipped,
          candidatesSeen,
          pairsRecorded,
          lastId,
        });
      }
    }

    const elapsed = Date.now() - start;
    store.finishRun(runId, processed, pairsRecorded);
    if (onProgress) {
      onProgress({
        phase: "sketch",
        processed,
        skipped,
        candidatesSeen,
        pairsRecorded,
        lastId,
      });
    }

    return {
      docsProcessed: processed,
      docsSkipped: skipped,
      candidatesSeen,
      pairsRecorded,
      idfDocsScanned,
      uniqueShingles: this.dfTable?.size() ?? 0,
      elapsedMs: elapsed,
    };
  }

  private buildDfTable(): number {
    if (!this.dfTable) return 0;
    let scanned = 0;
    for (const doc of this.opts.corpus.stream()) {
      const sh = shingles(
        normalizeText(doc.content, { stripQuotes: this.opts.config.stripQuotes }),
        this.opts.config.shingleSize,
      );
      if (sh.size === 0) continue;
      this.dfTable.observe(sh);
      scanned++;
      if (this.opts.onProgress && scanned % 1000 === 0) {
        this.opts.onProgress({
          phase: "idf",
          processed: scanned,
          skipped: 0,
          candidatesSeen: 0,
          pairsRecorded: 0,
          lastId: doc.id,
        });
      }
    }
    return scanned;
  }

  private findAndCapCandidates(docId: string, buckets: Uint32Array): string[] {
    const ids = this.opts.store.findCandidates(this.opts.config.algoVersion, buckets, docId);
    if (ids.length <= this.opts.maxCandidatesPerDoc) return ids;
    return ids.slice(0, this.opts.maxCandidatesPerDoc);
  }

  private verifyAndRecord(
    doc: CorpusDoc,
    docShingles: ReadonlySet<string>,
    docSig: Uint32Array,
    candId: string,
    runId: string,
  ): boolean {
    const candDoc = this.opts.corpus.getContent(candId);
    if (!candDoc) return false;
    const candShingles = shingles(
      normalizeText(candDoc.content, { stripQuotes: this.opts.config.stripQuotes }),
      this.opts.config.shingleSize,
    );
    if (candShingles.size === 0) return false;

    const exact = this.sketcher.verify(docShingles, candShingles);
    if (exact < this.opts.recordThreshold) return false;

    const candMinhashRow = this.opts.store.getMinhash(candId, this.opts.config.algoVersion);
    if (!candMinhashRow) return false;
    const estimate =
      this.opts.config.weighting === "idf"
        ? weightedSignatureSimilarity(docSig, candMinhashRow.signature)
        : signatureSimilarity(docSig, candMinhashRow.signature);

    const excl = this.sketcher.exclusivity?.(docShingles, candShingles);

    const [docA, docB] = DupeStore.canonicalPairOrder(doc.id, candId);
    this.opts.store.upsertPair({
      docA,
      docB,
      algoVersion: this.opts.config.algoVersion,
      jaccard: exact,
      sigSimilarity: estimate,
      runId,
      intersectionSize: excl?.intersectionSize ?? null,
      pairUniqueDf2: excl?.pairUniqueDf2 ?? null,
      pairUniqueDf5: excl?.pairUniqueDf5 ?? null,
    });
    return true;
  }
}
