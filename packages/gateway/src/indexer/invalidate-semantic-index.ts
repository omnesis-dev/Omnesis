// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { closeSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  setLexicalWrites,
  setUsearchBackfillCursor,
  setUsearchSavedChangeSeq,
  wipeAndRecreateVectorIndex,
} from "./db.js";
import type Database from "better-sqlite3";

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
  for (const path of [graphPath, `${graphPath}.enc`]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Make unlink durable before clearing the SQLite recovery marker.
  const directory = openSync(dirname(graphPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  setUsearchSavedChangeSeq(db, null);
  setUsearchBackfillCursor(db, null);
  setLexicalWrites(db, false);
}
