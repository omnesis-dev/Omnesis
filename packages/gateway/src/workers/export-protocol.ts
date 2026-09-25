// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Message contract between `ExportService` and `export-worker.ts`.
 *
 * The worker is one-shot: it receives its full job via `workerData` (no
 * request/response loop), keyset-paginates the documents table in bounded
 * batches, streams each batch to the output file, posts periodic `progress`
 * updates, and finishes with a single `done` or `error`. Holding the
 * cursor walk off the gateway main thread keeps the HTTP path responsive
 * while a multi-100k-doc corpus is serialized to disk.
 */

/** Output format for the documents file. */
export type ExportFormat = "json" | "csv";

export interface ExportWorkerInput {
  /** Absolute path of the live `omnesis.db` file (opened read-only). */
  gatewayDbPath: string;
  /** Hex-encoded gateway DB storage key, when live storage encryption is enabled. */
  gatewayDbKeyHex?: string;
  /** Absolute path the documents file is written to (must not exist yet). */
  destPath: string;
  format: ExportFormat;
  /** When set, only documents for this source id are exported. */
  sourceId?: string;
  /** Keyset page size — rows fetched (and flushed) per batch. */
  batchSize: number;
}

export type ExportWorkerMessage =
  | { type: "progress"; documents: number }
  | { type: "done"; documents: number; bytes: number; perSource: Record<string, number> }
  | { type: "error"; error: string };
