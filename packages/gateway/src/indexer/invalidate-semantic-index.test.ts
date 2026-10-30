// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createIndexDatabase,
  getIndexEmbedModel,
  getUsearchBackfillCursor,
  getUsearchSavedChangeSeq,
  hasLexicalWrites,
  setUsearchBackfillCursor,
  setUsearchSavedChangeSeq,
  upsertChunks,
} from "./db.js";
import { invalidateSemanticIndex } from "./invalidate-semantic-index.js";
import type Database from "better-sqlite3";

let dir: string;
let graph: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "invalidate-semantic-"));
  graph = join(dir, "index.usearch");
  db = createIndexDatabase(join(dir, "index.db"));
  upsertChunks(db, [
    {
      id: "chunk-prism",
      documentId: "document-prism",
      chunkIndex: 0,
      content: "fictional paperlantern calibration",
      embedding: new Float32Array(8),
      sourceId: "synthetic:prism@example.com",
      title: "Prism",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
    },
  ]);
  setUsearchSavedChangeSeq(db, 1);
  setUsearchBackfillCursor(db, 7);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("discards obsolete graph generations and checkpoints while retaining keyword text", () => {
  writeFileSync(graph, "obsolete graph");
  writeFileSync(`${graph}.enc`, "obsolete ciphertext");
  invalidateSemanticIndex(db, graph, 16, "replacement-model");
  expect(existsSync(graph)).toBe(false);
  expect(existsSync(`${graph}.enc`)).toBe(false);
  expect(hasLexicalWrites(db)).toBe(false);
  expect(getUsearchBackfillCursor(db)).toBeNull();
  expect(getUsearchSavedChangeSeq(db)).toBeNull();
  expect(getIndexEmbedModel(db)).toEqual({ name: "replacement-model", dim: 16 });
  expect(db.prepare("SELECT embedding FROM chunks").get()).toEqual({ embedding: null });
  expect(
    db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'paperlantern'").get(),
  ).toEqual({ n: 1 });
});

test.each(["plaintext", "encrypted"])(
  "retains recovery intent after %s removal fails, then repairs on retry",
  (failure) => {
    if (failure === "plaintext") {
      mkdirSync(graph);
      writeFileSync(`${graph}.enc`, "retained ciphertext");
    } else {
      writeFileSync(graph, "obsolete graph");
      mkdirSync(`${graph}.enc`);
    }
    expect(() => invalidateSemanticIndex(db, graph, 16, "replacement-model")).toThrow();
    expect(hasLexicalWrites(db)).toBe(true);
    expect(db.prepare("SELECT embedding FROM chunks").get()).toEqual({ embedding: null });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'paperlantern'")
        .get(),
    ).toEqual({ n: 1 });
    if (failure === "plaintext")
      expect(readFileSync(`${graph}.enc`, "utf8")).toBe("retained ciphertext");
    rmSync(failure === "plaintext" ? graph : `${graph}.enc`, { recursive: true });
    invalidateSemanticIndex(db, graph, 16, "replacement-model");
    expect(hasLexicalWrites(db)).toBe(false);
    expect(existsSync(graph)).toBe(false);
    expect(existsSync(`${graph}.enc`)).toBe(false);
  },
);
