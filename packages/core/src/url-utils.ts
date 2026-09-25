// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "./utils.js";

// The generic normalizer lives in a dependency-free module so the browser
// extension can bundle it (no `node:crypto`). Re-exported here so existing
// `@omnesis/core` importers keep working unchanged.
export {
  normalizeUrl,
  buildCanonicalizerRegistry,
  hostIsOwned,
  TRACKING_PARAMS,
  CREDENTIAL_PARAMS,
  type UrlCanonicalizerSpec,
} from "./url-normalize.js";

/**
 * Extract URLs from markdown content.
 * Finds markdown links [text](url) and bare URLs with any valid URI scheme.
 * Deduplicates results.
 */
export function extractUrls(content: string): string[] {
  const urls = new Set<string>();

  // Match markdown links: [text](url) — any scheme
  const markdownLinkRegex = /\[[^\]]*\]\(([a-z][a-z0-9+.-]*:\/\/[^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    urls.add(match[1]);
  }

  // Match bare URLs (not already inside markdown link parentheses)
  const contentWithoutMarkdownLinks = content.replace(
    /\[[^\]]*\]\([a-z][a-z0-9+.-]*:\/\/[^)]+\)/gi,
    "",
  );
  const bareUrlRegex = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/gi;
  while ((match = bareUrlRegex.exec(contentWithoutMarkdownLinks)) !== null) {
    urls.add(match[0]);
  }

  return [...urls];
}

/**
 * Generate a stable external ID from a normalized URL.
 * Returns SHA-256 hex hash.
 */
export function urlToExternalId(normalizedUrl: string): string {
  return computeContentHash(normalizedUrl);
}

/**
 * Extract the lowercased hostname for a URL, stripping a leading `www.` so
 * `https://www.example.com/x` and `https://example.com/x` collide on the
 * same domain key. Returns "" for unparseable URLs.
 *
 * Different from `new URL(url).hostname` in two ways: it never throws on
 * bad input, and it folds `www.` so cross-source aggregations (browser
 * history, bookmarks, search-term sources) deduplicate cleanly.
 */
export function canonicalDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}
