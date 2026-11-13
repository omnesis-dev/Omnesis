// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark for the source version stored on every document, on one large,
 * encrypted, invented source account.
 *
 *   npx tsx scripts/bench-source-version.mts [documents=1000000] [contentBytes=900] [runs=200]
 *
 * It builds a throwaway store under the system temp directory, keyed like a
 * production one, holding `documents` documents of a single source account,
 * and prints three measurements:
 *
 * - **the migration**: the documents are first put back into the physical form
 *   they have on an install that predates the column (no column, no running
 *   counts), then the migration step runs on them as it would on an upgrade;
 * - **the per-version count**: with the account's documents spread over
 *   versions 0, 1 and 2, the count is read `runs` times on a read-only handle
 *   opened the way the gateway opens its own, whole source and one stream,
 *   beside the design the running counts replace: an index over the documents
 *   on source, stream and version, with the time to build it and the same
 *   count read from it;
 * - **a re-read page**: 500 documents sent again unchanged at a higher
 *   version, through the page writer, beside the same page sent with no
 *   version, which is what a re-read cost before versions were stored.
 *
 * The store is deleted on exit. Never point this at a live config directory:
 * it creates and removes the files it measures.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  countDocumentsBySourceVersion,
  createDatabase,
  openReadOnlyDatabase,
  upsertDocuments,
  upsertWithCursor,
  upsertWithCursorYieldable,
} from "../packages/gateway/src/db.js";
import { addSourceVersion } from "../packages/gateway/src/data/migration-218-source-version.js";
import { ProviderId, SourceId, type DocumentInput } from "../packages/types/src/index.js";

const [documentsArg, contentArg, runsArg] = process.argv.slice(2);
const TOTAL = Number(documentsArg ?? 1_000_000);
const CONTENT_BYTES = Number(contentArg ?? 900);
const RUNS = Number(runsArg ?? 200);
const PAGE = 500;
/** The gateway's default read-handle page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;
const PROVIDER = ProviderId("bench-mail:reader");
const SOURCE = SourceId("bench-mail:reader");

const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );

/** Deterministic in `index`, so a later page can re-send a stored document unchanged. */
function documentAt(index: number): DocumentInput {
  const words: string[] = [];
  let length = 0;
  let state = (index + 1) * 2654435761;
  while (length < CONTENT_BYTES) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = WORDS[state % WORDS.length]!;
    words.push(word);
    length += word.length + 1;
  }
  const at = new Date(Date.parse("2020-01-01T00:00:00Z") + index * 60_000).toISOString();
  return {
    providerId: PROVIDER,
    sourceId: SOURCE,
    externalId: `message-${index}`,
    title: `${words[0]} ${words[1]} ${index}`,
    content: words.join(" "),
    contentHash: `hash-${index}`,
    sourceCreatedAt: at,
    sourceUpdatedAt: at,
    metadata: {
      documentType: "email",
      people: [{ name: "Maya Reeves", role: "sender", emails: ["maya.reeves@example.org"] }],
      extra: { threadId: `thread-${index % 50_000}` },
    },
  };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
}

function ms(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

const dir = mkdtempSync(join(tmpdir(), "omnesis-bench-source-version-"));
const dbPath = join(dir, "omnesis.db");
const rows: Array<[string, string]> = [];

try {
  const key = randomBytes(32);
  const db = createDatabase(dbPath, { encryptionKey: key });

  // ── build ────────────────────────────────────────────────────────────────
  const buildStart = performance.now();
  const BATCH = 5_000;
  for (let from = 0; from < TOTAL; from += BATCH) {
    const batch: DocumentInput[] = [];
    for (let i = from; i < Math.min(from + BATCH, TOTAL); i++) batch.push(documentAt(i));
    upsertDocuments(db, batch);
  }
  // Rows as an install that predates the column holds them: the column is not
  // in the stored record at all, which is what the migration will meet.
  for (const trigger of ["insert", "delete", "move"])
    db.exec(`DROP TRIGGER source_version_counts_${trigger}`);
  db.exec("DROP TABLE source_version_counts");
  db.exec("ALTER TABLE documents DROP COLUMN source_version");
  db.exec("ALTER TABLE sync_state DROP COLUMN source_version");
  db.exec("ALTER TABLE source_inventories DROP COLUMN min_source_version");
  db.exec("DROP TABLE document_filter_index_queue");
  db.pragma("wal_checkpoint(TRUNCATE)");
  const buildMs = performance.now() - buildStart;

  // ── the migration ────────────────────────────────────────────────────────
  const migrationStart = performance.now();
  db.transaction(() => addSourceVersion(db))();
  const migrationMs = performance.now() - migrationStart;
  rows.push(["migration: add the columns and fill the running counts", ms(migrationMs)]);

  // ── mixed versions: a quarter at 0, a quarter at 1, half at 2 ────────────
  db.exec(`
    UPDATE documents SET source_version = CASE
      WHEN rowid % 4 = 0 THEN 0 WHEN rowid % 4 = 1 THEN 1 ELSE 2 END
     WHERE source_id = '${SOURCE}'
  `);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");

  // ── the per-version count ────────────────────────────────────────────────
  const reader = openReadOnlyDatabase(dbPath, {
    encryptionKey: key,
    cacheSizeBytes: READ_CACHE_BYTES,
  });
  const coldStart = performance.now();
  const counts = countDocumentsBySourceVersion(reader, SOURCE);
  const coldMs = performance.now() - coldStart;
  const time = (run: () => unknown): number[] => {
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b);
  };
  const whole = time(() => countDocumentsBySourceVersion(reader, SOURCE));
  const stream = time(() => countDocumentsBySourceVersion(reader, SOURCE, ""));
  reader.close();
  rows.push(["count per version, first read on a new handle", ms(coldMs)]);
  rows.push([
    `count per version, whole source (${RUNS} reads)`,
    `p50 ${ms(percentile(whole, 50))}, p95 ${ms(percentile(whole, 95))}`,
  ]);
  rows.push([
    `count per version, one stream (${RUNS} reads)`,
    `p50 ${ms(percentile(stream, 50))}, p95 ${ms(percentile(stream, 95))}`,
  ]);

  // ── the alternative: count from an index over the documents ──────────────
  // What the running counts replace. The index is built, read and dropped
  // here so the two designs are measured on the same store.
  const indexStart = performance.now();
  db.exec(
    "CREATE INDEX bench_documents_source_version ON documents(source_id, stream_id, source_version)",
  );
  const indexMs = performance.now() - indexStart;
  db.pragma("wal_checkpoint(TRUNCATE)");
  const indexReader = openReadOnlyDatabase(dbPath, {
    encryptionKey: key,
    cacheSizeBytes: READ_CACHE_BYTES,
  });
  const indexed = (where: string) =>
    indexReader.prepare<string[], unknown>(
      `SELECT source_version, COUNT(*) FROM documents INDEXED BY bench_documents_source_version
        WHERE ${where} GROUP BY source_version`,
    );
  const wholeIndexed = indexed("source_id = ?");
  const streamIndexed = indexed("source_id = ? AND stream_id = ?");
  wholeIndexed.all(SOURCE);
  const scanRuns = Math.max(10, Math.floor(RUNS / 4));
  const timeScan = (run: () => unknown): number[] => {
    const samples: number[] = [];
    for (let i = 0; i < scanRuns; i++) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    return samples.sort((x, y) => x - y);
  };
  const wholeScan = timeScan(() => wholeIndexed.all(SOURCE));
  const streamScan = timeScan(() => streamIndexed.all(SOURCE, ""));
  indexReader.close();
  db.exec("DROP INDEX bench_documents_source_version");
  rows.push(["alternative, an index instead: building it", ms(indexMs)]);
  rows.push([
    `alternative, count from that index, whole source (${scanRuns} reads)`,
    `p50 ${ms(percentile(wholeScan, 50))}, p95 ${ms(percentile(wholeScan, 95))}`,
  ]);
  rows.push([
    `alternative, count from that index, one stream (${scanRuns} reads)`,
    `p50 ${ms(percentile(streamScan, 50))}, p95 ${ms(percentile(streamScan, 95))}`,
  ]);

  // ── a re-read page ───────────────────────────────────────────────────────
  // Each page takes documents nothing has re-read yet, from the low end of
  // the account, so every measurement meets rows it has to visit on disk.
  let nextPage = 0;
  const page = (): DocumentInput[] => {
    const start = nextPage;
    nextPage += PAGE;
    return Array.from({ length: PAGE }, (_, i) => documentAt(start + i));
  };
  const commit = (sourceVersion: number | undefined, documents: DocumentInput[]): number => {
    const start = performance.now();
    upsertWithCursor(db, {
      providerId: PROVIDER,
      sourceId: SOURCE,
      documents,
      sourceVersion,
      hasMore: true,
      cursor: { offset: nextPage },
    });
    return performance.now() - start;
  };
  const unversioned = [
    commit(undefined, page()),
    commit(undefined, page()),
    commit(undefined, page()),
  ];
  const stamped = [commit(3, page()), commit(3, page()), commit(3, page())];
  const chunkedStart = performance.now();
  let pending = upsertWithCursorYieldable(
    db,
    {
      providerId: PROVIDER,
      sourceId: SOURCE,
      documents: page(),
      sourceVersion: 3,
      hasMore: true,
      cursor: { offset: nextPage },
    },
    { token: { requested: () => false } },
  );
  while (pending.kind === "yield") {
    pending = upsertWithCursorYieldable(db, pending.resume, {
      token: { requested: () => false },
    });
  }
  const chunkedMs = performance.now() - chunkedStart;
  const median = (samples: number[]): number => samples.sort((a, b) => a - b)[1]!;
  rows.push([`${PAGE} unchanged documents, no version (one transaction)`, ms(median(unversioned))]);
  rows.push([`${PAGE} unchanged documents, version raised (one transaction)`, ms(median(stamped))]);
  rows.push([`${PAGE} unchanged documents, version raised (writer's chunks)`, ms(chunkedMs)]);

  const queued = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_filter_index_queue")
    .get()!.n;
  const size = statSync(dbPath).size;
  db.close();

  process.stdout.write(
    `\n${TOTAL.toLocaleString("en-US")} documents in one source account, ` +
      `${(size / 1024 ** 3).toFixed(2)} GiB encrypted store, built in ${(buildMs / 1000).toFixed(0)} s\n` +
      `versions: ${counts.map((c) => `${c.sourceVersion}: ${c.count.toLocaleString("en-US")}`).join(", ")}; ` +
      `${queued.toLocaleString("en-US")} documents queued by the raised-version pages\n\n`,
  );
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
