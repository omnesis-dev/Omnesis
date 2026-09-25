// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import { webPageEdgeTarget, type EdgeDeclaration } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

interface BookmarkEntry {
  externalId: string;
  title: string;
  url: string;
  folder: string;
  addedAt: string;
}

let cached: BookmarkEntry[] | null = null;

export function loadBookmarks(): BookmarkEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<BookmarkEntry[]>(
    loadActiveUniverse(),
    "chrome-bookmarks",
    "bookmarks.json",
  );
  return cached;
}

export function mapBookmark(
  e: BookmarkEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content: `${e.title}\n\n${e.url}\n\nFolder: ${e.folder}`,
    contentHash: sha256Hex(`${e.externalId}:${e.url}:${e.title}`),
    metadata: {
      documentType: "bookmark",
      sourceUrl: e.url,
      people: [personMention("self", "owner")],
      extra: {
        folder: e.folder,
      },
    },
    sourceCreatedAt: e.addedAt,
    sourceUpdatedAt: e.addedAt,
  };
}

/**
 * The `bookmarks → webpage` declared edge for one synth bookmark,
 * mirroring the real provider's `bookmarkWebpageEdge`. `from` is this synth
 * document's own external id; `to` is the canonical `web` entity for the URL,
 * so the edge parks in `pending_edges` until the extension captures the page.
 */
export function mapBookmarkEdge(e: BookmarkEntry): EdgeDeclaration {
  return {
    from: { kind: "internal", sourceDocumentId: e.externalId },
    to: webPageEdgeTarget(e.url),
    type: "bookmarks",
  };
}
