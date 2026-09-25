// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { listSourceWatermarks } from "../../db.js";
import type { StoredSourceWatermark } from "../../db.js";
import type Database from "better-sqlite3";

/** Read-only source-level coverage view. Raw upstream cuts never leave storage. */
export interface SourceWatermarkView {
  sourceId: string;
  streamId: "default";
  guarantee: StoredSourceWatermark["guarantee"];
  semanticTimeThrough: string | null;
  observedAt: string;
  upstreamCutDigest: string | null;
  detail: string | null;
  generation: number;
  committedAt: string;
}

function toView(row: StoredSourceWatermark): SourceWatermarkView {
  return {
    sourceId: row.source_id,
    streamId: row.stream_id,
    guarantee: row.guarantee,
    semanticTimeThrough: row.semantic_time_through,
    observedAt: row.observed_at,
    upstreamCutDigest: row.upstream_cut_digest,
    detail: row.detail,
    generation: row.generation,
    committedAt: row.committed_at,
  };
}

export class WatermarkService {
  constructor(private readonly db: Database.Database) {}

  list(sourceId?: string): SourceWatermarkView[] {
    return listSourceWatermarks(this.db, sourceId).map(toView);
  }
}
