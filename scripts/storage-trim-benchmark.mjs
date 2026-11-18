// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Focused scale probe: node --import tsx scripts/storage-trim-benchmark.mjs. */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  readStorageTrimPage,
  STORAGE_TRIM_PAGE_SQL,
} from "../packages/gateway/src/storage/trim-job-store.ts";

const directory = mkdtempSync(join(tmpdir(), "omnesis-storage-scale-"));
const db = new Database(join(directory, "fixture.db"));
try {
  db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,provider_id TEXT,source_id TEXT,stream_id TEXT,
    external_id TEXT,content_hash TEXT,updated_at TEXT,source_updated_at TEXT,source_created_at TEXT,
    title TEXT,metadata TEXT,content TEXT);
    CREATE INDEX idx_documents_source_created_revision ON documents(source_id,source_created_at,id,content_hash);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000000)
    INSERT INTO documents SELECT printf('fixture-%07d',i),'fixture-provider','fixture-source:archive','',printf('fixture-%07d',i),
      'hash','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z',
      'Invented reference','{"documentType":"contact"}','Invented fixture text.' FROM n;`);
  const parameters = [
    "fixture-source:archive",
    "2020-01-01T00:00:00.000Z",
    "fixture-0999900",
    "2020-01-01T00:00:00.000Z",
    "fixture-1000000",
    101,
  ];
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${STORAGE_TRIM_PAGE_SQL}`)
    .all(...parameters)
    .map((row) => row.detail);
  if (
    !plan.some((line) =>
      line.includes("SEARCH documents USING COVERING INDEX idx_documents_source_created_revision"),
    ) ||
    plan.some((line) => /SCAN|TEMP B-TREE/.test(line))
  )
    throw new Error("The trim page lost its indexed range seek");
  const job = {
    sourceId: "fixture-source:archive",
    cursorDate: "",
    cursorId: "",
    upperDate: "2020-01-01T00:00:00.000Z",
    upperId: "fixture-1000000",
  };
  let examined = 0,
    pages = 0,
    maximumPage = 0,
    peakHeap = process.memoryUsage().heapUsed;
  const durations = [];
  const started = performance.now();
  for (;;) {
    const pageStart = performance.now();
    const page = readStorageTrimPage(db, job);
    if (page.rows.some((row) => Object.keys(row).sort().join(",") !== "id,source_created_at"))
      throw new Error("The read-worker page includes non-index cursor payload");
    durations.push(performance.now() - pageStart);
    maximumPage = Math.max(maximumPage, page.rows.length);
    examined += page.rows.length;
    pages++;
    if (!page.hasMore) break;
    const last = page.rows.at(-1);
    job.cursorDate = last.source_created_at;
    job.cursorId = last.id;
    if (pages % 100 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  durations.sort((a, b) => a - b);
  if (examined !== 1000000 || maximumPage > 100 || pages !== 10000)
    throw new Error("The bounded scan skipped or repeated fixture rows");
  process.stdout.write(
    JSON.stringify(
      {
        documents: examined,
        pages,
        maximumPage,
        protectedDocuments: examined,
        elapsedMs: Math.round(performance.now() - started),
        medianPageMs: durations[Math.floor(durations.length / 2)],
        p99PageMs: durations[Math.floor(durations.length * 0.99)],
        peakHeapMiB: Math.round(peakHeap / 1024 / 1024),
        plan,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
