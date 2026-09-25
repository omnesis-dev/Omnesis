// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Row → projection mapper for the canonical `ListedDocument` shape.
 *
 * The gateway's `/documents/list` route, the
 * indexer's `DirectDocumentSource`, and any future `ListedDocument`
 * consumer all funnel through this single hop. Pre-fix the same
 * "parse metadata + pluck subset + copy top-level fields" block was
 * inlined in two places — adding a metadata field required two edits
 * with no compile-time link, which is exactly how `relevanceScore`
 * ended up indexer-only and never surfaced through the HTTP wire.
 *
 * `data/document-projection.ts` is already taken by the event-bus
 * projection (different concern: tracks what changed for trigger
 * evaluation). This module owns the wire/indexer projection only.
 */

import { parseDocumentMetadata, parseDocumentMetadataFast } from "./json-columns.js";
import type { ListedDocumentRow } from "./types.js";
import type { ListedDocument } from "@omnesis/source-sdk";
import type { PersonMention } from "@omnesis/types";

/**
 * Convert a raw `documents`-table row (with `metadata` still as a
 * JSON string) into the canonical `ListedDocument` projection from
 * `@omnesis/core`. Used by both the HTTP `/documents/list` DTO mapper
 * and the in-process indexer's `DirectDocumentSource`.
 *
 * When `opts.skipValidation` is true, uses raw `JSON.parse` instead
 * of the Zod codec path. The indexer is a trusted internal consumer
 * reading data it just wrote — schema validation is unnecessary and
 * the Zod overhead (`z.record(z.unknown()).safeParse`) allocates
 * internal result objects on every call.
 */
export function toListedDocument(
  doc: ListedDocumentRow,
  opts?: { skipValidation?: boolean },
): ListedDocument {
  const meta = opts?.skipValidation
    ? parseDocumentMetadataFast(doc.metadata, doc.id)
    : parseDocumentMetadata(doc.metadata, doc.id);
  return {
    id: doc.id,
    sourceId: doc.sourceId,
    title: doc.title,
    content: doc.content,
    contentHash: doc.contentHash,
    metadata: {
      documentType: meta.documentType,
      sourceUrl: meta.sourceUrl,
      sourceCreatedAt: doc.sourceCreatedAt,
      people: meta.people as PersonMention[] | undefined,
      tags: meta.tags as string[] | undefined,
      relevanceScore: meta.relevanceScore,
    },
    updatedAt: doc.updatedAt,
  };
}
