// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { browserUrlIdentity, type UrlCanonicalizerSpec } from "@omnesis/core/url-normalize";
import type { SearchResultItem } from "../types.js";
import type { FindSearchResult } from "./types.js";

/** Direct Find and typed previews share the same ranked source evidence mapping. */
export function directFindResults(hits: readonly SearchResultItem[]): FindSearchResult[] {
  return hits.map((hit) => ({
    id: hit.documentId,
    documentId: hit.documentId,
    title: hit.title,
    sourceUrl: hit.sourceUrl,
    sourceId: hit.sourceId,
    chunkText: hit.chunkText,
    sourceCreatedAt: hit.sourceCreatedAt,
  }));
}

/** Keep only safe browser destinations, retaining the first ranked source for each identity. */
export function browserFindSuggestions(
  results: readonly FindSearchResult[],
  limit: number,
  canonicalizers: readonly UrlCanonicalizerSpec[],
): FindSearchResult[] {
  const destinations = new Set<string>();
  const suggestions: FindSearchResult[] = [];
  for (const result of results) {
    if (!result.sourceUrl || result.sourceUrl.length > 8192) continue;
    let url: URL;
    try {
      url = new URL(result.sourceUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    // Match the browser capture's path equivalence without discarding query or SPA routing state.
    const identityUrl = new URL(url.href);
    if (identityUrl.pathname.length > 1)
      identityUrl.pathname = identityUrl.pathname.replace(/\/+$/, "");
    const identity = browserUrlIdentity(
      identityUrl.href,
      canonicalizers.find((spec) => spec.hosts.includes(url.hostname)),
    );
    if (destinations.has(identity)) continue;
    destinations.add(identity);
    suggestions.push({
      ...result,
      sourceUrl: url.href,
      title: result.title.slice(0, 512),
      chunkText: result.chunkText.slice(0, 1200),
    });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
