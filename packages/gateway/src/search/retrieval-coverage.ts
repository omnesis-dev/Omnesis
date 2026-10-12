// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolResult } from "@omnesis/core";
import type Database from "better-sqlite3";

export type RetrievalCoverage = NonNullable<
  Extract<ToolResult, { kind: "search.results" }>["coverage"]
>;

/** Bounded metadata reads, never a count or body scan of the corpus. */
export function readRetrievalCoverage(
  indexDb: Database.Database,
  gatewayDb?: Database.Database,
): RetrievalCoverage {
  const hasDocumentClock = gatewayDb
    ?.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_documents_updated_at'")
    .get();
  const corpusBoundary = hasDocumentClock
    ? (gatewayDb!
        .prepare<
          [],
          { boundary: string | null }
        >("SELECT MAX(updated_at) AS boundary FROM documents INDEXED BY idx_documents_updated_at")
        .get()?.boundary ?? null)
    : null;
  const hasWatermarks = indexDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='watermark'")
    .get();
  const publishedThrough = hasWatermarks
    ? (indexDb
        .prepare<[string], { value: string }>("SELECT value FROM watermark WHERE key=?")
        .get("published_scan_boundary")?.value ?? null)
    : null;
  const status =
    !corpusBoundary || !publishedThrough
      ? "unknown"
      : publishedThrough < corpusBoundary
        ? "catching_up"
        : "scanned";
  return {
    status,
    corpusBoundary,
    publishedThrough,
    notice:
      status === "scanned"
        ? "A published index scan reached the observed corpus timestamp. Ranked results can still omit evidence, including concurrent arrivals, excluded or unindexable documents; no result does not prove absence."
        : "Search coverage is incomplete or unproven while indexing catches up. Readable source documents can support positive facts. Do not infer that related evidence or existing outcomes do not exist, or that an outcome remains open or is resolved, from missing results. Preserve conditionality and unknown current status; later reconsideration does not justify unsupported assertions now.",
  };
}
