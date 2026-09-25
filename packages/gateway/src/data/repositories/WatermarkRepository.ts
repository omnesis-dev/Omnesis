// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { retryOnBusy } from "../retry.js";
import type { SourceWatermark } from "@omnesis/source-sdk";
import type { Db } from "../types.js";

export interface StoredSourceWatermark {
  source_id: string;
  stream_id: "default";
  guarantee: SourceWatermark["guarantee"];
  semantic_time_through: string | null;
  observed_at: string;
  upstream_cut_digest: string | null;
  detail: string | null;
  generation: number;
  committed_at: string;
}

function digest(cut: string | undefined): string | null {
  return cut === undefined ? null : createHash("sha256").update(cut).digest("hex");
}

/** Persist the source's single V1 coverage record in the enclosing sync transaction. */
export function upsertSourceWatermark(db: Db, sourceId: string, watermark: SourceWatermark): void {
  const committedAt = new Date().toISOString();
  const observedAt = watermark.observedAt ?? committedAt;
  retryOnBusy(
    () =>
      db
        .prepare(
          `INSERT INTO source_watermarks
             (source_id, stream_id, guarantee, semantic_time_through, observed_at, upstream_cut_digest, detail, generation, committed_at)
           VALUES (?, 'default', ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(source_id, stream_id) DO UPDATE SET
             guarantee = excluded.guarantee,
             semantic_time_through = excluded.semantic_time_through,
             observed_at = excluded.observed_at,
             upstream_cut_digest = excluded.upstream_cut_digest,
             detail = excluded.detail,
             generation = source_watermarks.generation + 1,
             committed_at = excluded.committed_at`,
        )
        .run(
          sourceId,
          watermark.guarantee,
          watermark.semanticTimeThrough ?? null,
          observedAt,
          digest(watermark.upstreamCut),
          watermark.detail ?? null,
          committedAt,
        ),
    { op: "upsertSourceWatermark" },
  );
}

export function listSourceWatermarks(db: Db, sourceId?: string): StoredSourceWatermark[] {
  if (sourceId !== undefined) {
    return db
      .prepare<
        [string],
        StoredSourceWatermark
      >("SELECT * FROM source_watermarks WHERE source_id = ? ORDER BY source_id")
      .all(sourceId);
  }
  return db
    .prepare<[], StoredSourceWatermark>("SELECT * FROM source_watermarks ORDER BY source_id")
    .all();
}

export function getSourceWatermark(db: Db, sourceId: string): StoredSourceWatermark | null {
  return (
    db
      .prepare<
        [string],
        StoredSourceWatermark
      >("SELECT * FROM source_watermarks WHERE source_id = ? AND stream_id = 'default'")
      .get(sourceId) ?? null
  );
}

export function deleteSourceWatermark(db: Db, sourceId: string): void {
  db.prepare("DELETE FROM source_watermarks WHERE source_id = ?").run(sourceId);
}
