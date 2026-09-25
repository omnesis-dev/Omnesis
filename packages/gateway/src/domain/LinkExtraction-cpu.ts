// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-compute portion of link extraction. NO database imports —
 * runs on CPU pool workers. Receives pre-fetched document rows and
 * runs the regex-heavy `extractLinks` on each.
 */

import { extractLinks, type UrlCanonicalizerSpec } from "@omnesis/core";
import { getCachedSafeUrlCanonicalizerRegistry } from "../known-url-pattern-safety.js";
import { documentsMetadataCodec } from "../data/json-columns.js";
import { linkExtractionInputDigest } from "./LinkExtractionInput.js";
import type { ExtractedLinkBatchEntry } from "./LinkExtraction.js";

export interface LinkExtractionDocRow {
  id: string;
  source_id: string;
  external_id: string;
  content: string;
  content_hash: string;
  metadata: string;
  extracted_content_hash: string | null;
}

export function extractLinksFromDocs(
  docs: LinkExtractionDocRow[],
  canonicalizers?: readonly UrlCanonicalizerSpec[],
): ExtractedLinkBatchEntry[] {
  const registry = getCachedSafeUrlCanonicalizerRegistry(canonicalizers ?? []);

  const out: ExtractedLinkBatchEntry[] = [];
  for (const row of docs) {
    const meta = documentsMetadataCodec.parseWithFallback(row.metadata, { rowId: row.id }) as {
      extra?: Record<string, unknown>;
    };
    const links = extractLinks(row.content, meta, row.external_id, registry);
    out.push({
      docId: row.id,
      contentHash: row.content_hash,
      inputDigest: linkExtractionInputDigest(row),
      sourceId: row.source_id,
      links,
    });
  }
  return out;
}
