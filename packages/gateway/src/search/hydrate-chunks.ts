// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { SearchResultItem } from "./types.js";

type Db = Database.Database;

/**
 * Batch-fetch chunk content for results that have empty chunkText.
 * BM25 omits `c.content` from its scoring query (the 2 GB chunks table
 * is too expensive to JOIN under IO contention), so fused results carry an
 * empty `chunkText` until this fills it in by `chunkRowid`.
 *
 * Idempotent: already-hydrated results (and results without a `chunkRowid`)
 * are skipped, so a caller may hydrate a subset mid-pipeline and let a later
 * pass fill in the remainder.
 */
export function hydrateChunkText(db: Db, results: SearchResultItem[]): void {
  const needsHydration = results.filter((r) => !r.chunkText && r.chunkRowid);
  if (needsHydration.length === 0) return;
  const rowids = needsHydration.map((r) => r.chunkRowid!);
  const placeholders = rowids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT rowid, content FROM chunks WHERE rowid IN (${placeholders})`)
    .all(...rowids) as Array<{ rowid: number; content: string }>;
  const byRowid = new Map(rows.map((r) => [r.rowid, r.content]));
  for (const result of needsHydration) {
    const content = byRowid.get(result.chunkRowid!);
    if (content) result.chunkText = content;
  }
}
