// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncDirSync } from "@omnesis/core";
import {
  setLexicalWrites,
  setUsearchBackfillCursor,
  setUsearchSavedChangeSeq,
  setUsearchSavedSeq,
  wipeAndRecreateVectorIndex,
} from "./db.js";
import type Database from "better-sqlite3";

/**
 * Drop the saved graph and its encrypted copy, keeping every embedding: the
 * next graph handle starts empty and rebuilds from `chunks.embedding`. For a
 * graph saved under another vector encoding, which usearch would otherwise
 * open as it is.
 */
export function invalidateVectorGraph(db: Database.Database, graphPath: string): void {
  unlinkGraphFiles(graphPath);
  setUsearchSavedSeq(db, 0);
  setUsearchSavedChangeSeq(db, null);
  setUsearchBackfillCursor(db, null);
}

function unlinkGraphFiles(graphPath: string): void {
  for (const path of [graphPath, `${graphPath}.enc`]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Make unlink durable before clearing the SQLite recovery marker.
  fsyncDirSync(dirname(graphPath), { strict: true });
}

/** Call only after replacement-model warmup, before opening any graph handle. */
export function invalidateSemanticIndex(
  db: Database.Database,
  graphPath: string,
  embeddingDim: number,
  modelName: string,
): void {
  // Persist recovery intent before SQL changes. A crash or failed unlink must
  // never allow the next boot to trust an obsolete plaintext/encrypted graph.
  setLexicalWrites(db, true);
  wipeAndRecreateVectorIndex(db, embeddingDim, modelName);
  unlinkGraphFiles(graphPath);
  setUsearchSavedChangeSeq(db, null);
  setUsearchBackfillCursor(db, null);
  setLexicalWrites(db, false);
}
