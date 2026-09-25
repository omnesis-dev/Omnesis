// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, webPageEdgeTarget, type EdgeDeclaration } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { FlatBookmark } from "./types.js";

/**
 * Chrome timestamps are microseconds since 1601-01-01 UTC (Windows FILETIME).
 * Offset from 1601 to 1970 in microseconds.
 */
const CHROME_EPOCH_OFFSET = 11644473600000000n;

/**
 * Convert a Chrome timestamp string to a JavaScript Date.
 */
export function chromeTimestampToDate(timestamp: string): Date {
  const microseconds = BigInt(timestamp);
  const unixMicroseconds = microseconds - CHROME_EPOCH_OFFSET;
  return new Date(Number(unixMicroseconds / 1000n));
}

/**
 * Normalize a flattened bookmark into an Omnesis DocumentInput.
 *
 * `fileMtime`, when provided, becomes the `sourceUpdatedAt` floor — Chrome's
 * Bookmarks JSON has no per-bookmark "last modified" field, so a rename or
 * folder-move would otherwise leave `sourceUpdatedAt` pinned to the
 * original creation date. The file mtime ticks on any rewrite, which is
 * coarse but at least *recent* when *something* changes; downstream
 * recency-boost queries surface renamed bookmarks.
 *
 * `extraFolderPaths` carries every other folder path the same URL was
 * filed under. Each path becomes a tag so the silent
 * dedup-by-URL no longer loses folder context — see the call site in
 * `index.ts` for the grouping logic.
 */
export function normalizeBookmark(
  bookmark: FlatBookmark,
  providerId: ProviderId,
  sourceId: SourceId,
  fileMtime?: Date,
  extraFolderPaths: string[] = [],
): DocumentInput {
  const title = bookmark.title || "Untitled";
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`URL: ${bookmark.url}`);

  // De-duplicate while preserving first-seen order so the markdown
  // doc lists folders consistently across syncs.
  const allFolderPaths: string[] = [];
  const seen = new Set<string>();
  for (const fp of [bookmark.folderPath, ...extraFolderPaths]) {
    if (fp && !seen.has(fp)) {
      seen.add(fp);
      allFolderPaths.push(fp);
    }
  }

  if (allFolderPaths.length === 1) {
    lines.push(`Folder: ${allFolderPaths[0]}`);
  } else if (allFolderPaths.length > 1) {
    lines.push(`Folders: ${allFolderPaths.join("; ")}`);
  }

  lines.push(`Added: ${bookmark.dateAdded.toISOString().split("T")[0]}`);

  const content = lines.join("\n");
  const domain = getDomain(bookmark.url);

  // Use the leaf folder of every filing as a tag — same shape the
  // single-folder code used, but now for every folder this URL is in.
  const tags =
    allFolderPaths.length > 0
      ? Array.from(new Set(allFolderPaths.map((p) => p.split(" / ").pop()!)))
      : undefined;

  return {
    providerId,
    sourceId: sourceId,
    externalId: bookmark.url,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      sourceUrl: bookmark.url,
      documentType: "bookmark",
      tags,
      extra: {
        folderPath: allFolderPaths[0] || undefined,
        folderPaths: allFolderPaths.length > 1 ? allFolderPaths : undefined,
        domain,
        dateAdded: bookmark.dateAdded.toISOString(),
        dateLastUsed: bookmark.dateLastUsed?.toISOString() ?? undefined,
      },
    },
    sourceCreatedAt: bookmark.dateAdded.toISOString(),
    // Use the most-recent timestamp we have. Bare `dateAdded` is incorrect
    // post-rename / post-move; the file mtime is a coarse but honest "last
    // time anything in this bookmarks set changed" signal.
    sourceUpdatedAt: (fileMtime && fileMtime.getTime() > bookmark.dateAdded.getTime()
      ? fileMtime
      : bookmark.dateAdded
    ).toISOString(),
  };
}

/**
 * The `bookmark → webpage` declared edge for one bookmark. A bookmark
 * stays its own first-class `bookmark` document; this edge joins it to the
 * canonical `webpage` entity (source `web`) the URL resolves to, so the graph
 * links "this is bookmarked" to the page itself. The edge resolves immediately
 * if the page is already captured, else defers in `pending_edges` until the
 * extension captures it.
 *
 * `from` is internal — the bookmark document this source emits, keyed on its
 * `externalId` (the raw URL). `to` is the cross-source `web` entity, keyed on
 * the canonical `SHA256(normalizeUrl(url))`. The bookmark provider can't bundle
 * the per-host canonicalizer registry, so the generic normalization is used; the
 * hosts the registry rewrites (Gmail/Drive) are `ownedWebDomains` the web
 * dataset never captures, so the omission cannot split a real web page.
 */
export function bookmarkWebpageEdge(bookmark: FlatBookmark): EdgeDeclaration {
  return {
    from: { kind: "internal", sourceDocumentId: bookmark.url },
    to: webPageEdgeTarget(bookmark.url),
    type: "bookmarks",
  };
}

function getDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
