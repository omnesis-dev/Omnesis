// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The lexical index is built on a thread of its own and comes back on shared
 * memory, ranking exactly as an index built in-process does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkerEntry } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { EMBEDDING_DIM, createIndexDatabase, openIndexDb, upsertChunks } from "../indexer/db.js";
import { LexicalIndex } from "../search/lexical-index.js";
import { startLexicalIndexBuild } from "./lexical-index-build.js";

const BUILD_WORKER = resolveWorkerEntry(
  "./lexical-index-build-worker.ts",
  import.meta.url,
  "./register-tsx.mjs",
);

function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(
    db,
    Array.from({ length: 200 }, (_, i) => ({
      id: `chunk-${i}`,
      documentId: `doc-${i}`,
      chunkIndex: 0,
      content: `Quarterly budget review ${i % 7}: venue deposit, catering quote ${i % 3 ? "and the marathon entry form" : ""}`,
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: "synthetic:test@example.com",
      documentType: "note",
      title: `Note ${i}`,
      sourceCreatedAt: "2026-02-11T09:00:00Z",
    })),
  );
  db.close();
}

describe("lexical index build", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-lexbuild-"));
    dbPath = join(dir, "index.db");
    seedIndexDb(dbPath);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("builds off-thread onto shared memory, ranking like an in-process build", async () => {
    const build = startLexicalIndexBuild({
      indexDbPath: dbPath,
      cacheSizeBytes: 8 * 1024 * 1024,
      backgroundWorkerNice: 0,
      workerUrl: BUILD_WORKER.url,
      workerExecArgv: BUILD_WORKER.execArgv,
    });
    const { data } = await build.done;
    expect(data.postingDoc.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(data.docCount).toBe(200);

    const db = openIndexDb(dbPath, { readonly: true, mmapBytes: 0 });
    try {
      const local = LexicalIndex.build(db);
      for (const q of ["budget", "marathon entry", "catering deposit review"]) {
        expect(new LexicalIndex(data).rank(db, q, 20)).toEqual(local.rank(db, q, 20));
      }
    } finally {
      db.close();
    }
  });

  test("a missing database fails the build instead of hanging", async () => {
    const build = startLexicalIndexBuild({
      indexDbPath: join(dir, "missing.db"),
      cacheSizeBytes: 8 * 1024 * 1024,
      backgroundWorkerNice: 0,
      workerUrl: BUILD_WORKER.url,
      workerExecArgv: BUILD_WORKER.execArgv,
    });
    await expect(build.done).rejects.toThrow(
      /unable to open|no such file|SQLITE_CANTOPEN|does not exist/i,
    );
  });
});
