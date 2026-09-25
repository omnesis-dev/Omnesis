// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { packSignature, unpackSignature } from "../algo/minhash.js";
import { SCHEMA } from "./schema.js";

export interface MinhashRow {
  documentId: string;
  algoVersion: string;
  signature: Uint32Array;
  shingleCount: number;
  contentHash: string | null;
  docType: string;
  pluginId: string;
  sourceCreatedAt: number | null;
  computedAt: number;
}

export interface BucketRow {
  algoVersion: string;
  bandIdx: number;
  bucketHash: number;
  documentId: string;
}

export interface PairRow {
  docA: string;
  docB: string;
  algoVersion: string;
  jaccard: number;
  sigSimilarity: number;
  runId: string;
  intersectionSize?: number | null;
  pairUniqueDf2?: number | null;
  pairUniqueDf5?: number | null;
}

export interface RunRow {
  runId: string;
  algoVersion: string;
  configJson: string;
  startedAt: number;
  finishedAt: number | null;
  docsProcessed: number;
  pairsRecorded: number;
  notes: string | null;
}

export class DupeStore {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Idempotent additive migrations. Older study DBs predate the
   * exclusivity columns; add them when missing so the same code runs
   * against both fresh and existing dupes.db files.
   */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pairs)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    const intCols = [
      "intersection_size",
      "pair_unique_df2",
      "pair_unique_df5",
      "is_exact_dupe",
      "is_same_thread",
      "annotated_at",
    ];
    for (const col of intCols) {
      if (!have.has(col)) {
        this.db.exec(`ALTER TABLE pairs ADD COLUMN ${col} INTEGER`);
      }
    }
    for (const col of ["gate_status", "gate_family"]) {
      if (!have.has(col)) {
        this.db.exec(`ALTER TABLE pairs ADD COLUMN ${col} TEXT`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  beginRun(run: Omit<RunRow, "finishedAt" | "docsProcessed" | "pairsRecorded" | "notes">): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, algo_version, config_json, started_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(run.runId, run.algoVersion, run.configJson, run.startedAt);
  }

  finishRun(runId: string, docsProcessed: number, pairsRecorded: number, notes?: string): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, docs_processed = ?, pairs_recorded = ?, notes = ?
         WHERE run_id = ?`,
      )
      .run(Math.floor(Date.now() / 1000), docsProcessed, pairsRecorded, notes ?? null, runId);
  }

  listRuns(): RunRow[] {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC`).all() as Array<{
      run_id: string;
      algo_version: string;
      config_json: string;
      started_at: number;
      finished_at: number | null;
      docs_processed: number;
      pairs_recorded: number;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      runId: r.run_id,
      algoVersion: r.algo_version,
      configJson: r.config_json,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      docsProcessed: r.docs_processed,
      pairsRecorded: r.pairs_recorded,
      notes: r.notes,
    }));
  }

  upsertMinhash(row: MinhashRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO document_minhash
         (document_id, algo_version, signature, shingle_count, content_hash,
          doc_type, plugin_id, source_created_at, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.documentId,
        row.algoVersion,
        packSignature(row.signature),
        row.shingleCount,
        row.contentHash,
        row.docType,
        row.pluginId,
        row.sourceCreatedAt,
        row.computedAt,
      );
  }

  getMinhash(documentId: string, algoVersion: string): MinhashRow | null {
    const r = this.db
      .prepare(
        `SELECT document_id, algo_version, signature, shingle_count, content_hash,
                doc_type, plugin_id, source_created_at, computed_at
         FROM document_minhash WHERE document_id = ? AND algo_version = ?`,
      )
      .get(documentId, algoVersion) as
      | {
          document_id: string;
          algo_version: string;
          signature: Buffer;
          shingle_count: number;
          content_hash: string | null;
          doc_type: string;
          plugin_id: string;
          source_created_at: number | null;
          computed_at: number;
        }
      | undefined;
    if (!r) return null;
    const numHashes = r.signature.length / 4;
    return {
      documentId: r.document_id,
      algoVersion: r.algo_version,
      signature: unpackSignature(r.signature, numHashes),
      shingleCount: r.shingle_count,
      contentHash: r.content_hash,
      docType: r.doc_type,
      pluginId: r.plugin_id,
      sourceCreatedAt: r.source_created_at,
      computedAt: r.computed_at,
    };
  }

  insertBuckets(rows: BucketRow[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO lsh_buckets (algo_version, band_idx, bucket_hash, document_id)
       VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rs: BucketRow[]) => {
      for (const r of rs) stmt.run(r.algoVersion, r.bandIdx, r.bucketHash, r.documentId);
    });
    tx(rows);
  }

  /**
   * Drop every LSH bucket row for a document under one algo version.
   * Called before re-sketching a document whose content changed so the
   * rebuilt buckets reflect its new signature rather than accumulating
   * stale band entries from the prior content.
   */
  deleteBuckets(documentId: string, algoVersion: string): void {
    this.db
      .prepare(`DELETE FROM lsh_buckets WHERE document_id = ? AND algo_version = ?`)
      .run(documentId, algoVersion);
  }

  /**
   * Look up candidate document IDs for a signature's band buckets.
   * Excludes the caller's own ID. Returns a deduplicated array.
   */
  findCandidates(algoVersion: string, buckets: Uint32Array, excludeDocId: string): string[] {
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (let band = 0; band < buckets.length; band++) {
      placeholders.push("(?, ?)");
      params.push(band, buckets[band]);
    }
    const sql = `
      SELECT DISTINCT document_id FROM lsh_buckets
      WHERE algo_version = ?
        AND (band_idx, bucket_hash) IN (VALUES ${placeholders.join(",")})
        AND document_id != ?
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(algoVersion, ...params, excludeDocId) as Array<{ document_id: string }>;
    return rows.map((r) => r.document_id);
  }

  upsertPair(pair: PairRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pairs
         (doc_a, doc_b, algo_version, jaccard, sig_similarity, run_id,
          intersection_size, pair_unique_df2, pair_unique_df5)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pair.docA,
        pair.docB,
        pair.algoVersion,
        pair.jaccard,
        pair.sigSimilarity,
        pair.runId,
        pair.intersectionSize ?? null,
        pair.pairUniqueDf2 ?? null,
        pair.pairUniqueDf5 ?? null,
      );
  }

  /**
   * Canonical ordering: lex-min becomes doc_a. Stable across both
   * directions of a near-dupe relationship, so a pair is stored once.
   */
  static canonicalPairOrder(idX: string, idY: string): [string, string] {
    return idX < idY ? [idX, idY] : [idY, idX];
  }

  countMinhashes(algoVersion: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM document_minhash WHERE algo_version = ?`)
      .get(algoVersion) as { n: number };
    return r.n;
  }

  countPairs(algoVersion: string, jaccardMin = 0): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM pairs WHERE algo_version = ? AND jaccard >= ?`)
      .get(algoVersion, jaccardMin) as { n: number };
    return r.n;
  }
}

export function defaultDupeDbPath(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME not set");
  return `${home}/.config/omnesis/omnesis-dupes/dupes.db`;
}
